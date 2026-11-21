import path from "node:path";
import {
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES
} from "./schema.js";

export class CheckpointMethods {
  /** Record modified file paths into the session's structured compaction checkpoint ledger */
  recordModifiedFiles(sessionId, filePaths = [], { worktree = "", tool = null } = {}) {
    this.open();
    const sid = sessionId || "default";
    const list = Array.isArray(filePaths) ? filePaths : [filePaths];
    const cleaned = list
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    if (cleaned.length === 0) return this.getSessionCheckpoint(sid);

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const normKey = (p) => {
      const posix = p.replace(/\\/g, "/");
      return process.platform === "win32" ? posix.toLowerCase() : posix;
    };

    const MAX_CHECKPOINT_FILES = 30;
    this._withBusyRetry(() => {
      let inTx = false;
      try {
        this.db.exec("BEGIN IMMEDIATE;");
        inTx = true;
        const row = this.db
          .prepare("SELECT worktree, modified_files_json, last_test_json, last_build_json FROM session_checkpoints WHERE session_id = ?")
          .get(sid);

        let existing = [];
        if (row?.modified_files_json) {
          try {
            const parsed = JSON.parse(row.modified_files_json);
            if (Array.isArray(parsed)) existing = parsed;
          } catch {}
        }

        const byKey = new Map();
        for (const item of existing) {
          if (!item) continue;
          const p = typeof item === "string" ? item : item.path;
          if (!p) continue;
          byKey.set(normKey(p), typeof item === "string" ? { path: p, edits: 1, lastTool: null, updatedAt: nowIso } : item);
        }

        for (const rawPath of cleaned) {
          const displayPath = worktree
            ? (() => {
                const rel = path.relative(worktree, rawPath);
                if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel)) {
                  return rel.replace(/\\/g, "/");
                }
                return rawPath.replace(/\\/g, "/");
              })()
            : rawPath.replace(/\\/g, "/");
          const k = normKey(displayPath);
          const prev = byKey.get(k);
          byKey.delete(k); // Move to most-recent end
          byKey.set(k, {
            path: displayPath,
            edits: (prev?.edits || 0) + 1,
            lastTool: tool || prev?.lastTool || null,
            updatedAt: nowIso
          });
        }

        const merged = Array.from(byKey.values()).slice(-MAX_CHECKPOINT_FILES);
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              modified_files_json = excluded.modified_files_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(
            sid,
            worktree || row?.worktree || "",
            JSON.stringify(merged),
            row?.last_test_json ?? null,
            row?.last_build_json ?? null,
            now,
            nowIso
          );

        this.db.exec("COMMIT;");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { this.db.exec("ROLLBACK;"); } catch {}
        }
        throw err;
      }
    });

    return this.getSessionCheckpoint(sid);
  }

  /** Record latest test or build verification status into the session checkpoint ledger */
  recordVerificationResult(
    sessionId,
    { kind = "test", command = "", ruleId = "", exitCode = 0, passed = null, summary = "", sourceId = null, worktree = "" } = {}
  ) {
    this.open();
    const sid = sessionId || "default";
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const isBuild = kind === "build";
    const parsedExitCode =
      exitCode !== null &&
      exitCode !== undefined &&
      typeof exitCode !== "boolean" &&
      String(exitCode).trim() !== "" &&
      Number.isFinite(Number(exitCode))
        ? Number(exitCode)
        : null;
    const ok = passed !== null && passed !== undefined ? Boolean(passed) : parsedExitCode === 0;
    const payload = JSON.stringify({
      command: String(command || "").trim().slice(0, 140),
      ruleId: String(ruleId || ""),
      ok,
      exitCode: parsedExitCode,
      summary: String(summary || "").trim().slice(0, 220),
      sourceId: sourceId || null,
      at: nowIso
    });

    this._withBusyRetry(() => {
      if (isBuild) {
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, '[]', NULL, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              last_build_json = excluded.last_build_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(sid, worktree || "", payload, now, nowIso);
      } else {
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, '[]', ?, NULL, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              last_test_json = excluded.last_test_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(sid, worktree || "", payload, now, nowIso);
      }
    });

    return this.getSessionCheckpoint(sid);
  }

  /** Retrieve compact structured session checkpoint for compaction recovery */
  getSessionCheckpoint(sessionId) {
    this.open();
    const sid = sessionId || "default";
    const row =
      sid === "all" || sid === "lifetime" || sid === "app"
        ? this.db
            .prepare("SELECT * FROM session_checkpoints ORDER BY updated_ts DESC LIMIT 1")
            .get()
        : this.db
            .prepare("SELECT * FROM session_checkpoints WHERE session_id = ?")
            .get(sid);

    if (!row) {
      return {
        modifiedFiles: [],
        modifiedFileCount: 0,
        lastTest: null,
        lastBuild: null,
        updatedAt: null
      };
    }

    let rawFiles = [];
    try {
      const parsed = JSON.parse(row.modified_files_json || "[]");
      if (Array.isArray(parsed)) rawFiles = parsed;
    } catch {}

    const modifiedFiles = rawFiles
      .map((item) => (typeof item === "string" ? item : item?.path))
      .filter(Boolean)
      .reverse()
      .slice(0, 20);

    let lastTest = null;
    if (row.last_test_json) {
      try { lastTest = JSON.parse(row.last_test_json); } catch {}
    }
    let lastBuild = null;
    if (row.last_build_json) {
      try { lastBuild = JSON.parse(row.last_build_json); } catch {}
    }

    return {
      modifiedFiles,
      modifiedFileCount: rawFiles.length,
      lastTest,
      lastBuild,
      updatedAt: row.updated_at || null
    };
  }

  /** Returns true if at least one non-default conversation checkpoint exists (shared MCP server hint) */
  hasNonDefaultCheckpoints() {
    this.open();
    try {
      const row = this.db
        .prepare("SELECT 1 AS hit FROM session_checkpoints WHERE session_id != 'default' LIMIT 1")
        .get();
      return Boolean(row && row.hit === 1);
    } catch {
      return false;
    }
  }

  /** Read git-HEAD-keyed workspace skeleton cache */
  getRepoCache(workspaceDir, headSha, kind, maxAgeMs = 7 * 24 * 3600 * 1000) {
    this.open();
    const normDir = this._normalizeTrackPath(workspaceDir);
    const row = this.db
      .prepare("SELECT payload, updated_ts FROM repo_cache WHERE workspace_dir = ? AND head_sha = ? AND kind = ?")
      .get(normDir, String(headSha || "nogit"), String(kind || "hotspots"));
    if (!row) return null;
    if (maxAgeMs > 0 && Date.now() - Number(row.updated_ts) > maxAgeMs) return null;
    return row.payload;
  }

  /** Write git-HEAD-keyed workspace skeleton cache and prune obsolete commits for same workspace */
  setRepoCache(workspaceDir, headSha, kind, payload) {
    this.open();
    const normDir = this._normalizeTrackPath(workspaceDir);
    const sha = String(headSha || "nogit");
    const k = String(kind || "hotspots");
    const now = Date.now();
    this._withWriteTx(() => {
      this.db
        .prepare("DELETE FROM repo_cache WHERE workspace_dir = ? AND kind = ? AND head_sha != ?")
        .run(normDir, k, sha);
      this.db
        .prepare(`
          INSERT INTO repo_cache (workspace_dir, head_sha, kind, payload, updated_ts)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(workspace_dir, head_sha, kind) DO UPDATE SET
            payload = excluded.payload,
            updated_ts = excluded.updated_ts
        `)
        .run(normDir, sha, k, String(payload ?? ""), now);
    });
  }

  /**
   * Look up persistent L2 outline symbols for a file by normalized path, mtimeMs (±1 ms tolerance), and exact fileSize.
   * Touches updated_ts for LRU recency on hit and returns `{ lineCount, symbols }` or `null`.
   */
  getOutlineCache(filePath, mtimeMs, fileSize) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;
    const mtime = Number(mtimeMs);
    const size = Number(fileSize);
    if (!Number.isFinite(mtime) || !Number.isFinite(size)) return null;

    const row = this.db
      .prepare("SELECT mtime_ms, file_size, line_count, symbols_json FROM outline_cache WHERE file_path = ?")
      .get(norm);
    if (!row) return null;
    if (Math.abs(Number(row.mtime_ms) - mtime) > 1 || Number(row.file_size) !== size) {
      return null;
    }

    let symbols;
    try {
      symbols = JSON.parse(row.symbols_json);
    } catch {
      return null;
    }
    if (!Array.isArray(symbols)) return null;

    try {
      this._withBusyRetry(() => {
        this.db
          .prepare("UPDATE outline_cache SET updated_ts = ? WHERE file_path = ?")
          .run(Date.now(), norm);
      });
    } catch {
      // Best-effort LRU touch
    }

    return {
      lineCount: Number(row.line_count),
      symbols
    };
  }

  /**
   * Persist extracted outline symbols in SQLite L2 cache (bounded to max 512 entries LRU, skipping >128 KB JSON).
   */
  setOutlineCache(filePath, mtimeMs, fileSize, lineCount, symbols, options = {}) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm || !Array.isArray(symbols)) return false;
    const mtime = Number(mtimeMs);
    const size = Number(fileSize);
    const lines = Math.max(0, Math.trunc(Number(lineCount) || 0));
    if (!Number.isFinite(mtime) || !Number.isFinite(size) || size < 0) return false;

    const symbolsJson = JSON.stringify(symbols);
    if (Buffer.byteLength(symbolsJson, "utf8") > MAX_OUTLINE_JSON_BYTES) {
      return false;
    }

    const now = Date.now();
    const cap =
      Number.isFinite(options?.maxEntries) && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : MAX_OUTLINE_CACHE_DB_ENTRIES;

    this._withWriteTx(() => {
      this.db
        .prepare(`
          INSERT INTO outline_cache (file_path, mtime_ms, file_size, line_count, symbols_json, updated_ts)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            line_count = excluded.line_count,
            symbols_json = excluded.symbols_json,
            updated_ts = excluded.updated_ts
        `)
        .run(norm, mtime, Math.trunc(size), lines, symbolsJson, now);

      const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM outline_cache").get();
      if (countRow && countRow.cnt > cap) {
        const excess = countRow.cnt - cap;
        this.db
          .prepare(`
            DELETE FROM outline_cache
            WHERE rowid IN (
              SELECT rowid FROM outline_cache
              ORDER BY updated_ts ASC, rowid ASC
              LIMIT ?
            )
          `)
          .run(excess);
      }
    });

    return true;
  }

  /** Delete one path, an array of paths, or all entries from persistent outline_cache */
  deleteOutlineCache(filePath = null) {
    this.open();
    return this._withBusyRetry(() => {
      if (filePath === null || filePath === undefined || filePath === "") {
        const res = this.db.prepare("DELETE FROM outline_cache").run();
        return res.changes || 0;
      }
      if (Array.isArray(filePath)) {
        const norms = Array.from(
          new Set(
            filePath
              .map((p) => (typeof p === "string" ? this._normalizeTrackPath(p) : ""))
              .filter(Boolean)
          )
        );
        if (norms.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < norms.length; i += 400) {
          const batch = norms.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          const res = this.db
            .prepare(`DELETE FROM outline_cache WHERE file_path IN (${placeholders})`)
            .run(...batch);
          total += res.changes || 0;
        }
        return total;
      }
      const norm = this._normalizeTrackPath(filePath);
      if (!norm) return 0;
      const res = this.db.prepare("DELETE FROM outline_cache WHERE file_path = ?").run(norm);
      return res.changes || 0;
    });
  }
}
