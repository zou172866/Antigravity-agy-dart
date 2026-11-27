import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DEFAULT_CUTOFF_BYTES,
  DEFAULT_FILE_READ_MAX_AGE_MS,
  MAX_SNAPSHOTS_PER_SESSION,
  MAX_SNAPSHOT_BYTES
} from "./schema.js";

/** Only immediate paged slices within 10 minutes of an un-paged block count toward ghost recalls */
export const GHOST_RECALL_WINDOW_MS = 10 * 60 * 1000;

export class ReadMethods {
  /** Normalize absolute file paths consistently across OSes for dedup/invalidation */
  _normalizeTrackPath(filePath) {
    if (!filePath) return "";
    const resolved = path.resolve(String(filePath)).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /** Return monotonic per-conversation read/tool sequence counter (used for diff-read turn-gap freshness) */
  getConversationTurnSeq(sessionId) {
    this.open();
    const sid = sessionId || "default";
    const raw = this.getTimedMeta(`conv_turn_seq:${sid}`, "0");
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /** Atomically increment and return monotonic per-conversation sequence counter (multi-process safe) */
  bumpConversationTurnSeq(sessionId) {
    this.open();
    const sid = sessionId || "default";
    const key = `conv_turn_seq:${sid}`;
    return this._withBusyRetry(() => {
      let inTx = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        inTx = true;
        const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
        let cur = 0;
        if (row && typeof row.value === "string") {
          let rawVal = row.value;
          if (rawVal.startsWith("{")) {
            try {
              const parsed = JSON.parse(rawVal);
              if (parsed && typeof parsed === "object" && "v" in parsed) rawVal = parsed.v;
            } catch {}
          }
          const n = Number(rawVal);
          if (Number.isFinite(n) && n >= 0) cur = Math.floor(n);
        }
        const next = cur + 1;
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          )
          .run(key, JSON.stringify({ v: String(next), ts: Date.now() }));
        this.db.exec("COMMIT");
        inTx = false;
        return next;
      } catch (err) {
        if (inTx) {
          try {
            this.db.exec("ROLLBACK");
          } catch {}
        }
        throw err;
      }
    }, 12);
  }

  /**
   * Look up whether an unchanged file range was already read in this session.
   * Returns the covering row ({ start_line, end_line, byte_est, read_ts, bypass_armed }) or null.
   */
  findDuplicateRead({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    mtimeMs,
    fileSize,
    ctimeMs = null,
    ino = null,
    maxAgeMs = DEFAULT_FILE_READ_MAX_AGE_MS,
    currentStepIdx = null,
    maxStepGap = 0,
    currentTurnSeq = null,
    maxTurnGap = 0
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;

    const reqStart = Number.isFinite(startLine) && startLine > 0 ? startLine : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? endLine : -1; // -1 == EOF
    const hasCutoff = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
    const minTs = hasCutoff ? Date.now() - maxAgeMs : 0;
    const hasCtime = ctimeMs !== null && ctimeMs !== undefined && Number.isFinite(Number(ctimeMs));
    const normCtime = hasCtime ? Number(ctimeMs) : null;
    const normIno = ino !== null && ino !== undefined && String(ino) !== "" ? String(ino) : null;
    const hasCurrStep =
      currentStepIdx !== null &&
      currentStepIdx !== undefined &&
      currentStepIdx !== "" &&
      typeof currentStepIdx !== "boolean" &&
      Number.isFinite(Number(currentStepIdx)) &&
      Number(currentStepIdx) >= 0;
    const normCurrStep = hasCurrStep ? Math.floor(Number(currentStepIdx)) : null;
    const normMaxGap =
      Number.isFinite(Number(maxStepGap)) && Number(maxStepGap) > 0 ? Math.floor(Number(maxStepGap)) : 0;

    const hasCurrTurn =
      currentTurnSeq !== null &&
      currentTurnSeq !== undefined &&
      currentTurnSeq !== "" &&
      typeof currentTurnSeq !== "boolean" &&
      Number.isFinite(Number(currentTurnSeq)) &&
      Number(currentTurnSeq) >= 0;
    const normCurrTurn = hasCurrTurn ? Math.floor(Number(currentTurnSeq)) : null;
    const normMaxTurnGap =
      Number.isFinite(Number(maxTurnGap)) && Number(maxTurnGap) > 0 ? Math.floor(Number(maxTurnGap)) : 0;

    const rows = this.db
      .prepare(`
        SELECT start_line, end_line, mtime_ms, file_size, ctime_ms, ino, byte_est, read_ts, bypass_armed, read_step, read_turn_seq
        FROM file_reads
        WHERE session_id = ? AND file_path = ?
      `)
      .all(sid, norm);

    let fallbackMatch = null;
    for (const row of rows) {
      if (Math.abs(Number(row.mtime_ms) - Number(mtimeMs)) > 1 || Number(row.file_size) !== Number(fileSize)) {
        continue;
      }
      if (hasCtime) {
        if (row.ctime_ms === null || row.ctime_ms === undefined || Math.abs(Number(row.ctime_ms) - normCtime) > 0.01) {
          continue;
        }
      }
      if (normIno !== null) {
        if (row.ino === null || row.ino === undefined || String(row.ino) !== normIno) {
          continue;
        }
      }
      if (hasCutoff && Number(row.read_ts) < minTs) continue;
      if (
        hasCurrStep &&
        row.read_step !== null &&
        row.read_step !== undefined &&
        Number.isFinite(Number(row.read_step))
      ) {
        const readStep = Number(row.read_step);
        if (normCurrStep < readStep) {
          // Step rolled back / trajectory rewound -> allow fresh read immediately
          continue;
        }
        if (normMaxGap > 0 && Number(row.bypass_armed) !== 1 && normCurrStep - readStep > normMaxGap) {
          continue;
        }
      }
      if (
        hasCurrTurn &&
        row.read_turn_seq !== null &&
        row.read_turn_seq !== undefined &&
        Number.isFinite(Number(row.read_turn_seq))
      ) {
        const readTurn = Number(row.read_turn_seq);
        if (normCurrTurn < readTurn) {
          // Turn sequence rolled back -> allow fresh read immediately
          continue;
        }
        if (normMaxTurnGap > 0 && Number(row.bypass_armed) !== 1 && normCurrTurn - readTurn > normMaxTurnGap) {
          continue;
        }
      }
      const coversStart = Number(row.start_line) <= reqStart;
      const coversEnd = Number(row.end_line) === -1 || (reqEnd !== -1 && Number(row.end_line) >= reqEnd);
      if (coversStart && coversEnd) {
        // Prioritize any armed covering row so a 2-strike retry ALWAYS succeeds even when multiple covering rows exist
        if (Number(row.bypass_armed) === 1) {
          return row;
        }
        if (!fallbackMatch || (Number(row.start_line) === reqStart && Number(row.end_line) === reqEnd)) {
          fallbackMatch = row;
        }
      }
    }
    return fallbackMatch;
  }

  /** Arm the 2-strike bypass flag on a matched file_reads entry so an immediate retry succeeds */
  armReadBypass({ sessionId, filePath, startLine = 1, endLine = null }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return;
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    this._withBusyRetry(() => {
      this.db
        .prepare(`
          UPDATE file_reads SET bypass_armed = 1
          WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line = ?
        `)
        .run(sid, norm, reqStart, reqEnd);
    });
  }

  /** Record an allowed file read in the session read tracker */
  recordFileRead({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    mtimeMs,
    fileSize,
    ctimeMs = null,
    ino = null,
    byteEst = 0,
    stepIdx = null,
    turnSeq = null
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return;
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? startLine : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? endLine : -1;
    const hasCtime = ctimeMs !== null && ctimeMs !== undefined && Number.isFinite(Number(ctimeMs));
    const normCtime = hasCtime ? Number(ctimeMs) : null;
    const normIno = ino !== null && ino !== undefined && String(ino) !== "" ? String(ino) : null;
    const normStep =
      stepIdx !== null && stepIdx !== undefined && stepIdx !== "" && typeof stepIdx !== "boolean" && Number.isFinite(Number(stepIdx)) && Number(stepIdx) >= 0
        ? Math.floor(Number(stepIdx))
        : null;
    const normTurnSeq =
      turnSeq !== null && turnSeq !== undefined && turnSeq !== "" && typeof turnSeq !== "boolean" && Number.isFinite(Number(turnSeq)) && Number(turnSeq) >= 0
        ? Math.floor(Number(turnSeq))
        : null;
    const now = Date.now();

    this._withWriteTx(() => {
      // Evict stale versions of this file in this session
      if (hasCtime && normIno !== null) {
        this.db
          .prepare(`
            DELETE FROM file_reads
            WHERE session_id = ? AND file_path = ? AND (
              ABS(mtime_ms - ?) > 1 OR file_size != ?
              OR ctime_ms IS NULL OR ABS(ctime_ms - ?) > 0.01
              OR ino IS NULL OR ino != ?
            )
          `)
          .run(sid, norm, mtimeMs, fileSize, normCtime, normIno);
      } else if (hasCtime) {
        this.db
          .prepare(`
            DELETE FROM file_reads
            WHERE session_id = ? AND file_path = ? AND (
              ABS(mtime_ms - ?) > 1 OR file_size != ?
              OR ctime_ms IS NULL OR ABS(ctime_ms - ?) > 0.01
            )
          `)
          .run(sid, norm, mtimeMs, fileSize, normCtime);
      } else if (normIno !== null) {
        this.db
          .prepare(`
            DELETE FROM file_reads
            WHERE session_id = ? AND file_path = ? AND (
              ABS(mtime_ms - ?) > 1 OR file_size != ?
              OR ino IS NULL OR ino != ?
            )
          `)
          .run(sid, norm, mtimeMs, fileSize, normIno);
      } else {
        this.db
          .prepare(`
            DELETE FROM file_reads
            WHERE session_id = ? AND file_path = ? AND (ABS(mtime_ms - ?) > 1 OR file_size != ?)
          `)
          .run(sid, norm, mtimeMs, fileSize);
      }

      // Consume any armed 2-strike bypass across all covering rows for this file so superset rows don't stay bypassed forever
      this.db
        .prepare(`
          UPDATE file_reads SET bypass_armed = 0
          WHERE session_id = ? AND file_path = ? AND bypass_armed != 0
        `)
        .run(sid, norm);

      this.db
        .prepare(`
          INSERT INTO file_reads (session_id, file_path, start_line, end_line, mtime_ms, file_size, ctime_ms, ino, byte_est, read_ts, bypass_armed, read_step, read_turn_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(session_id, file_path, start_line, end_line) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            ctime_ms = excluded.ctime_ms,
            ino = excluded.ino,
            byte_est = excluded.byte_est,
            read_ts = excluded.read_ts,
            bypass_armed = 0,
            read_step = excluded.read_step,
            read_turn_seq = excluded.read_turn_seq
        `)
        .run(sid, norm, reqStart, reqEnd, mtimeMs, fileSize, normCtime, normIno, byteEst, now, normStep, normTurnSeq);
    });
  }

  /**
   * Invalidate a pending/unconfirmed read record (and matching snapshot baseline) after a host
   * reports that an allowed read call was cancelled or failed before entering context.
   */
  invalidatePendingFileRead({ sessionId, filePath, startLine = null, endLine = null } = {}) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    const hasStart = startLine !== null && startLine !== undefined && Number.isFinite(Number(startLine)) && Number(startLine) > 0;
    const hasEnd = endLine !== null && endLine !== undefined && Number.isFinite(Number(endLine)) && Number(endLine) > 0;
    return this._withWriteTx(() => {
      let changes = 0;
      if (hasStart) {
        const reqStart = Math.floor(Number(startLine));
        const reqEnd = hasEnd ? Math.floor(Number(endLine)) : -1;
        const r1 = this.db
          .prepare("DELETE FROM file_reads WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line = ?")
          .run(sid, norm, reqStart, reqEnd);
        changes += r1.changes || 0;
        this.db
          .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line = ?")
          .run(sid, norm, reqStart, reqEnd);
        // Also clear clamped/normalized ranges (e.g. >800-line requests clamped by computeEffectiveReadBounds)
        if (changes === 0) {
          if (hasEnd) {
            const r2 = this.db
              .prepare("DELETE FROM file_reads WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line > 0 AND end_line <= ?")
              .run(sid, norm, reqStart, reqEnd);
            changes += r2.changes || 0;
            this.db
              .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line > 0 AND end_line <= ?")
              .run(sid, norm, reqStart, reqEnd);
          } else {
            const r2 = this.db
              .prepare("DELETE FROM file_reads WHERE session_id = ? AND file_path = ? AND start_line = ?")
              .run(sid, norm, reqStart);
            changes += r2.changes || 0;
            this.db
              .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ? AND start_line = ?")
              .run(sid, norm, reqStart);
          }
        }
        return changes;
      }
      const rAll = this.db
        .prepare("DELETE FROM file_reads WHERE session_id = ? AND file_path = ?")
        .run(sid, norm);
      this.db
        .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ?")
        .run(sid, norm);
      return rAll.changes || 0;
    });
  }

  /** Invalidate cached unchanged file_reads for a canonical path across ALL sessions (preserving per-session file_snapshots) */
  invalidateFileReadsByPath(filePath) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    return this._withWriteTx(() => {
      const res = this.db.prepare("DELETE FROM file_reads WHERE file_path = ?").run(norm);
      return res.changes || 0;
    });
  }

  /**
   * Invalidate tracked file reads for one file (after edit, keeping file_snapshots as diff baseline)
   * or an entire session (after compaction / ctx_resume, clearing BOTH file_reads and file_snapshots).
   */
  invalidateFileReads(sessionId, filePath = null) {
    this.open();
    const sid = sessionId || "default";
    return this._withWriteTx(() => {
      if (filePath) {
        const norm = this._normalizeTrackPath(filePath);
        if (!norm) return 0;
        const res = this.db
          .prepare("DELETE FROM file_reads WHERE session_id = ? AND file_path = ?")
          .run(sid, norm);
        this.db
          .prepare("UPDATE ghost_interceptions SET recall_closed = 1 WHERE session_id = ? AND file_path = ? AND recall_closed = 0")
          .run(sid, norm);
        return res.changes || 0;
      }
      const res = this.db.prepare("DELETE FROM file_reads WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
      return res.changes || 0;
    });
  }

  /**
   * Invalidate pre-compaction file_reads (read_step IS NULL OR read_step <= maxStep) and
   * corresponding file_snapshots while preserving any files already read AFTER the compaction boundary.
   * Falls back to a full session invalidation when maxStep is omitted or invalid.
   */
  invalidateFileReadsBefore(sessionId, { maxStep = null } = {}) {
    this.open();
    const sid = sessionId || "default";
    const hasMaxStep =
      maxStep !== null &&
      maxStep !== undefined &&
      maxStep !== "" &&
      typeof maxStep !== "boolean" &&
      Number.isFinite(Number(maxStep)) &&
      Number(maxStep) >= 0;
    if (!hasMaxStep) {
      return this.invalidateFileReads(sid, null);
    }
    const cutoffStep = Math.floor(Number(maxStep));
    return this._withWriteTx(() => {
      const res = this.db
        .prepare("DELETE FROM file_reads WHERE session_id = ? AND (read_step IS NULL OR read_step <= ?)")
        .run(sid, cutoffStep);
      this.db
        .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND (read_step IS NULL OR read_step <= ?)")
        .run(sid, cutoffStep);
      return res.changes || 0;
    });
  }

  /**
   * Save a gzip-compressed baseline snapshot of a text range (<= 256 KB) for compact
   * unified-diff re-reads when the file is later modified in the same session.
   * Enforces per-session LRU cap so SQLite stays lean.
   */
  saveFileSnapshot({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    sha256 = null,
    mtimeMs = 0,
    fileSize = 0,
    ino = null,
    content,
    bypassArmed = 0,
    fullReadTs = null,
    fullReadSeq = null,
    readStep = null,
    maxSnapshotsPerSession = MAX_SNAPSHOTS_PER_SESSION
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm || typeof content !== "string") {
      return { saved: false, reason: "invalid" };
    }
    const rawBytes = Buffer.byteLength(content, "utf8");
    if (rawBytes > MAX_SNAPSHOT_BYTES) {
      return { saved: false, reason: "too_large", rawBytes };
    }
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    const normIno = ino !== null && ino !== undefined && String(ino) !== "" ? String(ino) : null;
    const digest = sha256 || createHash("sha256").update(content, "utf8").digest("hex");
    const contentGz = gzipSync(Buffer.from(content, "utf8"), { level: 1 });
    const now = Date.now();
    const armed = bypassArmed ? 1 : 0;
    const effFullReadTs = Number.isFinite(fullReadTs) && fullReadTs > 0 ? Math.floor(fullReadTs) : now;
    const effFullReadSeq =
      Number.isFinite(fullReadSeq) && fullReadSeq >= 0
        ? Math.floor(fullReadSeq)
        : this.getConversationTurnSeq(sid);
    const normReadStep =
      readStep !== null &&
      readStep !== undefined &&
      readStep !== "" &&
      typeof readStep !== "boolean" &&
      Number.isFinite(Number(readStep)) &&
      Number(readStep) >= 0
        ? Math.floor(Number(readStep))
        : null;
    const cap = Number.isFinite(maxSnapshotsPerSession) && maxSnapshotsPerSession > 0
      ? Math.floor(maxSnapshotsPerSession)
      : MAX_SNAPSHOTS_PER_SESSION;

    this._withWriteTx(() => {
      // Evict strictly covered older subset snapshots (same inode when known) so a newer superset read is never shadowed
      this.db
        .prepare(`
          DELETE FROM file_snapshots
          WHERE session_id = ? AND file_path = ?
            AND (? IS NULL OR ino IS NULL OR ino = ?)
            AND start_line >= ?
            AND (? = -1 OR (end_line != -1 AND end_line <= ?))
            AND NOT (start_line = ? AND end_line = ?)
        `)
        .run(sid, norm, normIno, normIno, reqStart, reqEnd, reqEnd, reqStart, reqEnd);

      this.db
        .prepare(`
          INSERT INTO file_snapshots (
            session_id, file_path, start_line, end_line, sha256, mtime_ms, file_size, ino, raw_bytes, content_gz, updated_ts, bypass_armed, full_read_ts, full_read_seq, read_step
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, file_path, start_line, end_line) DO UPDATE SET
            sha256 = excluded.sha256,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            ino = excluded.ino,
            raw_bytes = excluded.raw_bytes,
            content_gz = excluded.content_gz,
            updated_ts = excluded.updated_ts,
            bypass_armed = excluded.bypass_armed,
            full_read_ts = excluded.full_read_ts,
            full_read_seq = excluded.full_read_seq,
            read_step = excluded.read_step
        `)
        .run(sid, norm, reqStart, reqEnd, digest, mtimeMs, fileSize, normIno, rawBytes, contentGz, now, armed, effFullReadTs, effFullReadSeq, normReadStep);

      // Enforce bounded per-session LRU snapshot cap
      const countRow = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM file_snapshots WHERE session_id = ?")
        .get(sid);
      if (countRow && countRow.cnt > cap) {
        const excess = countRow.cnt - cap;
        this.db
          .prepare(`
            DELETE FROM file_snapshots
            WHERE rowid IN (
              SELECT rowid FROM file_snapshots
              WHERE session_id = ?
              ORDER BY updated_ts ASC, rowid ASC
              LIMIT ?
            )
          `)
          .run(sid, excess);
      }
    });

    return {
      saved: true,
      sha256: digest,
      rawBytes,
      compressedBytes: contentGz.length,
      startLine: reqStart,
      endLine: reqEnd
    };
  }

  /**
   * Look up the freshest exact or covering file snapshot for `[startLine..endLine]`.
   * Returns decompressed `{ start_line, end_line, sha256, mtime_ms, file_size, raw_bytes, updated_ts, bypass_armed, content, isExactRange }` or null.
   */
  findFileSnapshot({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    ino = null,
    maxAgeMs = DEFAULT_FILE_READ_MAX_AGE_MS
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;

    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    const normIno = ino !== null && ino !== undefined && String(ino) !== "" ? String(ino) : null;
    const hasCutoff = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
    const minTs = hasCutoff ? Date.now() - maxAgeMs : 0;

    const rows = this.db
      .prepare(`
        SELECT start_line, end_line, sha256, mtime_ms, file_size, ino, raw_bytes, content_gz, updated_ts, bypass_armed, full_read_ts, full_read_seq, read_step
        FROM file_snapshots
        WHERE session_id = ? AND file_path = ?
      `)
      .all(sid, norm);

    const candidates = [];
    for (const row of rows) {
      if (hasCutoff && Number(row.updated_ts) < minTs) continue;
      if (normIno !== null && (row.ino === null || row.ino === undefined || String(row.ino) !== normIno)) {
        continue;
      }
      const coversStart = Number(row.start_line) <= reqStart;
      const coversEnd = Number(row.end_line) === -1 || (reqEnd !== -1 && Number(row.end_line) >= reqEnd);
      if (coversStart && coversEnd) {
        candidates.push(row);
      }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const tsDiff = Number(b.updated_ts) - Number(a.updated_ts);
      if (tsDiff !== 0) return tsDiff;
      const aExact = Number(a.start_line) === reqStart && Number(a.end_line) === reqEnd ? 1 : 0;
      const bExact = Number(b.start_line) === reqStart && Number(b.end_line) === reqEnd ? 1 : 0;
      if (bExact !== aExact) return bExact - aExact;
      const armedDiff = Number(b.bypass_armed) - Number(a.bypass_armed);
      if (armedDiff !== 0) return armedDiff;
      const aSpan = Number(a.end_line) === -1 ? Number.MAX_SAFE_INTEGER : Number(a.end_line) - Number(a.start_line);
      const bSpan = Number(b.end_line) === -1 ? Number.MAX_SAFE_INTEGER : Number(b.end_line) - Number(b.start_line);
      return aSpan - bSpan;
    });

    for (const row of candidates) {
      try {
        const content = gunzipSync(row.content_gz, { maxOutputLength: MAX_SNAPSHOT_BYTES * 8 }).toString("utf8");
        return {
          start_line: Number(row.start_line),
          end_line: Number(row.end_line),
          sha256: row.sha256,
          mtime_ms: Number(row.mtime_ms),
          file_size: Number(row.file_size),
          raw_bytes: Number(row.raw_bytes),
          updated_ts: Number(row.updated_ts),
          bypass_armed: Number(row.bypass_armed),
          full_read_ts: Number(row.full_read_ts || row.updated_ts || 0),
          full_read_seq: Number(row.full_read_seq || 0),
          read_step:
            row.read_step !== null && row.read_step !== undefined && Number.isFinite(Number(row.read_step))
              ? Number(row.read_step)
              : null,
          content,
          isExactRange: Number(row.start_line) === reqStart && Number(row.end_line) === reqEnd
        };
      } catch {
        // Skip corrupt compressed snapshot fail-open
      }
    }
    return null;
  }

  /** Arm or clear the 2-strike full-file bypass flag on a stored file_snapshots row */
  armSnapshotBypass({ sessionId, filePath, startLine = 1, endLine = null, armed = 1 }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    const flag = armed ? 1 : 0;
    return this._withBusyRetry(() => {
      const res = this.db
        .prepare(`
          UPDATE file_snapshots SET bypass_armed = ?
          WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line = ?
        `)
        .run(flag, sid, norm, reqStart, reqEnd);
      return res.changes || 0;
    });
  }

  /** Clear stored file snapshots for one file or an entire session */
  clearFileSnapshots(sessionId, filePath = null) {
    this.open();
    const sid = sessionId || "default";
    return this._withBusyRetry(() => {
      if (filePath) {
        const norm = this._normalizeTrackPath(filePath);
        if (!norm) return 0;
        const res = this.db
          .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ?")
          .run(sid, norm);
        return res.changes || 0;
      }
      const res = this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
      return res.changes || 0;
    });
  }

  /** Check whether this session already has any non-expired file_reads row for filePath (used for pagination continuations) */
  hasPriorFileRead(sessionId, filePath, maxAgeMs = DEFAULT_FILE_READ_MAX_AGE_MS) {
    return this.getPriorReadSummary(sessionId, filePath, maxAgeMs).hasPrior;
  }

  /** Summarize non-expired file_reads rows for a file in this session (used for pagination continuations) */
  getPriorReadSummary(sessionId, filePath, maxAgeMs = DEFAULT_FILE_READ_MAX_AGE_MS) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) {
      return { hasPrior: false, hasFullOrLargeRead: false, maxEndLine: 0 };
    }
    const minTs = Date.now() - Math.max(0, Number(maxAgeMs) || DEFAULT_FILE_READ_MAX_AGE_MS);
    const rows = this.db
      .prepare(
        "SELECT start_line, end_line, byte_est FROM file_reads WHERE session_id = ? AND file_path = ? AND read_ts >= ?"
      )
      .all(sid, norm, minTs);
    if (!rows || rows.length === 0) {
      return { hasPrior: false, hasFullOrLargeRead: false, maxEndLine: 0 };
    }
    let hasEof = false;
    let hasFullOrLargeRead = false;
    let maxEndLine = 0;
    for (const r of rows) {
      const sLine = Number(r.start_line) || 1;
      const eLine = Number(r.end_line);
      const bEst = Number(r.byte_est) || 0;
      if (eLine === -1) {
        hasEof = true;
        hasFullOrLargeRead = true;
      } else if (eLine > 0) {
        if (eLine > maxEndLine) maxEndLine = eLine;
        if (bEst >= DEFAULT_CUTOFF_BYTES || eLine - sLine + 1 >= 400) {
          hasFullOrLargeRead = true;
        }
      }
    }
    return {
      hasPrior: true,
      hasFullOrLargeRead,
      maxEndLine: hasEof ? -1 : maxEndLine
    };
  }

  /** Record a large-file interception in the Ghost Registry to track subsequent paged recalls */
  recordGhostInterception({ sessionId, filePath, fileSize = 0, cutoffBytes = DEFAULT_CUTOFF_BYTES, nowMs }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return;
    const now = Number.isFinite(nowMs) ? Math.round(nowMs) : Date.now();
    this._withBusyRetry(() => {
      this.db
        .prepare(`
          INSERT INTO ghost_interceptions (session_id, file_path, file_size, cutoff_bytes, blocked_ts, recall_reads, recall_bytes, recall_closed)
          VALUES (?, ?, ?, ?, ?, 0, 0, 0)
          ON CONFLICT(session_id, file_path) DO UPDATE SET
            file_size = excluded.file_size,
            cutoff_bytes = excluded.cutoff_bytes,
            blocked_ts = excluded.blocked_ts,
            recall_reads = 0,
            recall_bytes = 0,
            recall_closed = 0
        `)
        .run(
          sid,
          norm,
          Math.max(0, Math.round(Number(fileSize) || 0)),
          Math.max(0, Math.round(Number(cutoffBytes) || 0)),
          now
        );
    });
  }

  /** Check if a file has an open Ghost Registry recall window for this session */
  hasGhostInterception(sessionId, filePath, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return false;
    const now = Number.isFinite(options?.nowMs) ? Math.round(options.nowMs) : Date.now();
    const row = this.db
      .prepare(
        "SELECT 1 FROM ghost_interceptions WHERE session_id = ? AND file_path = ? AND recall_closed = 0 AND (? - blocked_ts) <= ? LIMIT 1"
      )
      .get(sid, norm, now, GHOST_RECALL_WINDOW_MS);
    return Boolean(row);
  }

  /** Close the pending Ghost Registry recall window for an edited file while keeping total_blocked intact */
  clearGhostInterception(sessionId, filePath) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    const res = this._withBusyRetry(() =>
      this.db
        .prepare(
          "UPDATE ghost_interceptions SET recall_closed = 1 WHERE session_id = ? AND file_path = ? AND recall_closed = 0"
        )
        .run(sid, norm)
    );
    return res.changes || 0;
  }

  /** Record an immediate paged read (within 10m & pre-edit) against a previously intercepted file */
  recordGhostRecall({ sessionId, filePath, bytesRead = 0, nowMs }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    const addBytes = Math.max(0, Math.round(Number(bytesRead) || 0));
    const now = Number.isFinite(nowMs) ? Math.round(nowMs) : Date.now();
    const res = this._withBusyRetry(() =>
      this.db
        .prepare(`
          UPDATE ghost_interceptions
          SET recall_reads = recall_reads + 1,
              recall_bytes = recall_bytes + ?
          WHERE session_id = ?
            AND file_path = ?
            AND recall_closed = 0
            AND (? - blocked_ts) <= ?
        `)
        .run(addBytes, sid, norm, now, GHOST_RECALL_WINDOW_MS)
    );
    return res.changes || 0;
  }

  /** Compute Ghost Registry eviction efficiency and threshold tuning advice */
  getGhostStats(sessionId, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = Number.isFinite(options.sinceTs) ? options.sinceTs : null;

    let row;
    if (sid === "all" || sid === "lifetime") {
      row = this.db
        .prepare(`
          SELECT
            COUNT(*) AS total_blocked,
            COALESCE(SUM(CASE WHEN recall_reads >= 2 AND file_size > 0 AND recall_bytes >= file_size * 0.7 THEN 1 ELSE 0 END), 0) AS ghost_recalls
          FROM ghost_interceptions
        `)
        .get();
    } else if (sid === "app" && sinceTs !== null) {
      row = this.db
        .prepare(`
          SELECT
            COUNT(*) AS total_blocked,
            COALESCE(SUM(CASE WHEN recall_reads >= 2 AND file_size > 0 AND recall_bytes >= file_size * 0.7 THEN 1 ELSE 0 END), 0) AS ghost_recalls
          FROM ghost_interceptions
          WHERE blocked_ts >= ?
        `)
        .get(sinceTs);
    } else {
      const effectiveSid = typeof this.resolveRootSessionId === "function" ? this.resolveRootSessionId(sid) : sid;
      const familyIds = typeof this.getSessionFamilyIds === "function" ? this.getSessionFamilyIds(effectiveSid) : [effectiveSid];
      const inClause = familyIds.length > 1 ? `IN (${familyIds.map(() => "?").join(",")})` : "= ?";
      const params = familyIds.length > 1 ? familyIds : [effectiveSid];
      row = this.db
        .prepare(`
          SELECT
            COUNT(*) AS total_blocked,
            COALESCE(SUM(CASE WHEN recall_reads >= 2 AND file_size > 0 AND recall_bytes >= file_size * 0.7 THEN 1 ELSE 0 END), 0) AS ghost_recalls
          FROM ghost_interceptions
          WHERE session_id ${inClause}
        `)
        .get(...params);
    }

    const totalBlocked = Number(row?.total_blocked || 0);
    const ghostRecalls = Number(row?.ghost_recalls || 0);
    const evictionEfficiency = totalBlocked > 0 ? Number((1 - ghostRecalls / totalBlocked).toFixed(4)) : 1;
    const currentCutoff = this.getCutoff(sid === "all" || sid === "lifetime" ? null : sid);
    let recommendationCode = null;
    let recommendation = null;
    if (totalBlocked >= 3 && evictionEfficiency < 0.65 && currentCutoff > 0) {
      if (currentCutoff < 46080) {
        recommendationCode = "raise_to_host_45k";
        recommendation = "Cutoff may be too tight for this repo; consider switching to 45 KB (host-45k).";
      } else {
        recommendationCode = "use_outlines_or_exempt";
        recommendation =
          "Already at 45 KB host cap; multi-slice reads on >45 KB files are normal (use read_slices outlines or exemptPaths if needed).";
      }
    }

    return {
      totalBlocked,
      ghostRecalls,
      evictionEfficiency,
      currentCutoff,
      recommendationCode,
      recommendation
    };
  }
}
