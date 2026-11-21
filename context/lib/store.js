import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ACTIVE_CATEGORIES,
  DEFAULT_EXEMPT_EXTENSIONS,
  DEFAULT_FILE_READ_MAX_AGE_MS,
  FILE_CATEGORIES,
  MAX_CHUNK_BYTES,
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES,
  MAX_SNAPSHOTS_PER_SESSION,
  MAX_SNAPSHOT_BYTES,
  RRF_K,
  SNIPPET_MAX_BYTES,
  STATE_BUDGET,
  SchemaMethods,
  getDefaultDbPath,
  sanitizeFtsQuery,
  sanitizeTrigramQuery,
  truncateUtf8Bytes
} from "./store/schema.js";
import { FtsMethods } from "./store/fts.js";
import { CheckpointMethods } from "./store/checkpoints.js";
import { ReadMethods } from "./store/reads.js";
import { SettingsMaintenanceMethods } from "./store/settings-maintenance.js";

export {
  DEFAULT_ACTIVE_CATEGORIES,
  DEFAULT_EXEMPT_EXTENSIONS,
  DEFAULT_FILE_READ_MAX_AGE_MS,
  FILE_CATEGORIES,
  MAX_CHUNK_BYTES,
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES,
  MAX_SNAPSHOTS_PER_SESSION,
  MAX_SNAPSHOT_BYTES,
  RRF_K,
  SNIPPET_MAX_BYTES,
  STATE_BUDGET,
  getDefaultDbPath,
  sanitizeFtsQuery,
  sanitizeTrigramQuery,
  truncateUtf8Bytes
};

function attachPrototypeMethods(TargetClass, ...MixinClasses) {
  for (const Mixin of MixinClasses) {
    for (const key of Object.getOwnPropertyNames(Mixin.prototype)) {
      if (key === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(Mixin.prototype, key);
      if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
  }
}

export class ContextModeStore {
  constructor(optionsOrDbPath) {
    const opts =
      optionsOrDbPath && typeof optionsOrDbPath === "object" ? optionsOrDbPath : {};
    if (typeof optionsOrDbPath === "string" && optionsOrDbPath.trim()) {
      this.dbPath = optionsOrDbPath.trim();
    } else if (typeof opts.dbPath === "string" && opts.dbPath.trim()) {
      this.dbPath = opts.dbPath.trim();
    } else {
      this.dbPath = getDefaultDbPath();
    }
    this.hookMode = Boolean(opts.hookMode);
    this.busyTimeoutMs =
      Number.isFinite(opts.busyTimeoutMs) && opts.busyTimeoutMs >= 0
        ? Math.floor(opts.busyTimeoutMs)
        : this.hookMode
          ? 200
          : 5000;
    this.maxBusyRetries =
      Number.isFinite(opts.maxBusyRetries) && opts.maxBusyRetries >= 1
        ? Math.floor(opts.maxBusyRetries)
        : this.hookMode
          ? 2
          : 5;
    this.maxRetryDeadlineMs =
      Number.isFinite(opts.maxRetryDeadlineMs) && opts.maxRetryDeadlineMs >= 0
        ? Math.floor(opts.maxRetryDeadlineMs)
        : this.hookMode
          ? 500
          : 0;
    this._hookBusyAborted = false;
    this.db = null;
    this.sourceCounter = 0;
  }

  /** Open or initialize SQLite database */
  open() {
    if (this.db) return this.db;
    if (this.hookMode && this._hookBusyAborted) {
      const err = new Error("SQLite busy budget already exhausted in hook mode");
      err.code = "ERR_SQLITE_ERROR";
      throw err;
    }
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.initSchema();
    } catch (err) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
      const msg = String(err?.message || err || "");
      if (
        this.hookMode &&
        err?.code === "ERR_SQLITE_ERROR" &&
        /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg)
      ) {
        this._hookBusyAborted = true;
      }
      throw err;
    }
    return this.db;
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close error
      }
      this.db = null;
    }
  }

  /** Retry helper for transient SQLITE_BUSY / database-locked contention across parallel hooks */
  _withBusyRetry(fn, maxAttempts = null) {
    if (this.hookMode && this._hookBusyAborted) {
      const err = new Error("SQLite busy budget already exhausted in hook mode");
      err.code = "ERR_SQLITE_ERROR";
      throw err;
    }
    const effectiveMax = this.hookMode
      ? Math.max(1, Math.min(maxAttempts ?? this.maxBusyRetries, this.maxBusyRetries))
      : Math.max(1, maxAttempts ?? this.maxBusyRetries);
    const deadline = this.maxRetryDeadlineMs > 0 ? Date.now() + this.maxRetryDeadlineMs : 0;
    let lastErr;
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < effectiveMax; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err || "");
        const isBusy = err?.code === "ERR_SQLITE_ERROR" && /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg);
        if (!isBusy) throw err;
        if (attempt === effectiveMax - 1 || (deadline > 0 && Date.now() >= deadline)) {
          if (this.hookMode) this._hookBusyAborted = true;
          throw err;
        }
        try {
          const jitter = Math.floor(Math.random() * 15);
          const waitMs = 15 * (attempt + 1) + jitter;
          const remaining = deadline > 0 ? Math.max(0, deadline - Date.now()) : waitMs;
          if (remaining > 0) {
            Atomics.wait(sleepBuf, 0, 0, Math.min(waitMs, remaining));
          }
        } catch {}
      }
    }
    throw lastErr;
  }

  /** Execute a multi-statement write inside a single IMMEDIATE transaction with busy retry */
  _withWriteTx(fn, maxAttempts = null) {
    return this._withBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const res = fn();
        this.db.exec("COMMIT");
        return res;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw err;
      }
    }, maxAttempts);
  }
}

attachPrototypeMethods(
  ContextModeStore,
  SchemaMethods,
  FtsMethods,
  CheckpointMethods,
  ReadMethods,
  SettingsMaintenanceMethods
);
