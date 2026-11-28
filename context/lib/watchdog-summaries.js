/**
 * Read-only Antigravity `conversation_summaries.db`, `conversations_fts`, and
 * `annotations/<id>.pbtxt` lookup helpers with true O(1) LRU caching.
 *
 * Separated from `watchdog-lease-core.js` so per-tool hooks never load `node:module`
 * or `node:sqlite` unless summary metadata resolution is actually needed.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  decodeFileUriOrPath,
  extractInlinePayloadTitle,
  extractPayloadWorkspaceRoot,
  isSubagentLeasePayload,
  isSummaryMetadataSubagent,
  parseWorkspaceUriToPath,
  registerSummaryLookup,
  sanitizeConversationId,
  sanitizeWatchdogText
} from "./watchdog-lease-core.js";

let lazyDatabaseSync = null;
let localSqliteWarnGuardInstalled = false;

function getLazyDatabaseSync() {
  if (lazyDatabaseSync) return lazyDatabaseSync;
  if (!localSqliteWarnGuardInstalled) {
    localSqliteWarnGuardInstalled = true;
    try {
      const origEmit = process.emitWarning.bind(process);
      process.emitWarning = (warning, ...args) => {
        const msg = typeof warning === "string" ? warning : String(warning?.message || "");
        const type = typeof args[0] === "string" ? args[0] : args[0]?.type || warning?.name || "";
        if (/ExperimentalWarning/i.test(String(type)) && /sqlite/i.test(msg)) return;
        return origEmit(warning, ...args);
      };
    } catch {}
  }
  const req = createRequire(import.meta.url);
  lazyDatabaseSync = req("node:sqlite").DatabaseSync;
  return lazyDatabaseSync;
}

function resolveCandidateSummaryDbPaths({ transcriptPath = "", summaryDbPath = "", allowDefaultDb = true } = {}) {
  const out = [];
  const seen = new Set();
  const pushUnique = (p) => {
    if (typeof p !== "string" || !p.trim()) return;
    const resolved = path.resolve(p.trim());
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  };

  if (summaryDbPath) pushUnique(summaryDbPath);
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    pushUnique(process.env.AGY_DART_SUMMARY_DB_PATH);
  }

  if (typeof transcriptPath === "string" && transcriptPath.trim()) {
    let cur = path.dirname(path.resolve(transcriptPath.trim()));
    for (let depth = 0; depth < 7 && cur; depth += 1) {
      if (path.basename(cur).toLowerCase() === "brain") {
        const agRoot = path.dirname(cur);
        if (agRoot && agRoot !== cur) {
          pushUnique(path.join(agRoot, "conversation_summaries.db"));
        }
        break;
      }
      const next = path.dirname(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }

  if (allowDefaultDb) {
    const home = os.homedir();
    if (home) {
      pushUnique(path.join(home, ".gemini", "antigravity", "conversation_summaries.db"));
      pushUnique(path.join(home, ".gemini", "antigravity-ide", "conversation_summaries.db"));
      pushUnique(path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"));
    }
  }

  return out;
}

export function resolveCandidateTranscriptPath(
  conversationId,
  { transcriptPath = "", summaryDbPath = "", allowDefaultDb = true } = {}
) {
  const safeId = sanitizeConversationId(conversationId);
  if (typeof transcriptPath === "string" && transcriptPath.trim()) {
    const direct = transcriptPath.trim();
    try {
      if (fs.existsSync(direct)) return direct;
    } catch {}
  }
  if (!safeId) return "";

  const brainRoots = [];
  const seenRoots = new Set();
  const pushBrainRoot = (rootDir) => {
    if (typeof rootDir !== "string" || !rootDir.trim()) return;
    const resolved = path.resolve(rootDir.trim());
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seenRoots.has(key)) {
      seenRoots.add(key);
      brainRoots.push(resolved);
    }
  };

  if (typeof summaryDbPath === "string" && summaryDbPath.trim()) {
    pushBrainRoot(path.join(path.dirname(path.resolve(summaryDbPath.trim())), "brain"));
  }
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    pushBrainRoot(path.join(path.dirname(path.resolve(process.env.AGY_DART_SUMMARY_DB_PATH.trim())), "brain"));
  }
  if (allowDefaultDb !== false) {
    const home = os.homedir();
    if (home) {
      pushBrainRoot(path.join(home, ".gemini", "antigravity", "brain"));
      pushBrainRoot(path.join(home, ".gemini", "antigravity-ide", "brain"));
      pushBrainRoot(path.join(home, ".gemini", "antigravity-cli", "brain"));
    }
  }

  for (const root of brainRoots) {
    const relPaths = [
      path.join(safeId, ".system_generated", "logs", "transcript_full.jsonl"),
      path.join(safeId, ".system_generated", "logs", "transcript.jsonl"),
      path.join(safeId, ".system_generated", "transcript_full.jsonl"),
      path.join(safeId, ".system_generated", "transcript.jsonl")
    ];
    for (const relSub of relPaths) {
      const cand = path.resolve(root, relSub);
      const rel = path.relative(
        process.platform === "win32" ? root.toLowerCase() : root,
        process.platform === "win32" ? cand.toLowerCase() : cand
      );
      if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
        continue;
      }
      try {
        if (fs.existsSync(cand)) return cand;
      } catch {}
    }
  }
  return "";
}

export function readConversationParentId(db, conversationId, summaryParent) {
  const parent = sanitizeConversationId(summaryParent);
  if (parent && parent !== conversationId) return parent;
  try {
    const link = db.prepare(
      "SELECT parent_id FROM conversation_parents WHERE conversation_id = ? AND parent_id <> conversation_id LIMIT 1"
    ).get(conversationId);
    return sanitizeConversationId(link?.parent_id);
  } catch {
    return "";
  }
}

const MAX_ANNOTATION_FILE_BYTES = 65536;

/**
 * Parse the top-level `archived` boolean from an Antigravity `.pbtxt` annotation file.
 */
export function parseAnnotationArchivedStatus(rawText) {
  if (typeof rawText !== "string" || !rawText) return null;
  let topLevel = "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;
  for (let i = 0; i < rawText.length; i += 1) {
    const ch = rawText[i];
    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
        if (depth === 0) topLevel += " ";
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
        if (depth === 0) topLevel += " ";
      }
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "<") {
      depth += 1;
      if (depth === 1) topLevel += " ";
      continue;
    }
    if (ch === "}" || ch === ">") {
      if (depth > 0) depth -= 1;
      if (depth === 0) topLevel += " ";
      continue;
    }
    if (depth === 0) {
      topLevel += ch;
    }
  }
  const re = /(?:^|[\s;,])archived\s*:\s*(true|false|1|0)(?=$|[\s;,])/gi;
  let result = null;
  let m;
  while ((m = re.exec(topLevel)) !== null) {
    const val = m[1].toLowerCase();
    result = val === "true" || val === "1";
  }
  return result;
}

function readConversationAnnotationArchived(agRoot, conversationId) {
  const safeId = sanitizeConversationId(conversationId);
  if (!agRoot || !safeId) return null;
  const annDir = path.resolve(agRoot, "annotations");
  const annPath = path.resolve(annDir, `${safeId}.pbtxt`);
  const rel = path.relative(
    process.platform === "win32" ? annDir.toLowerCase() : annDir,
    process.platform === "win32" ? annPath.toLowerCase() : annPath
  );
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
    return null;
  }
  let fd = null;
  try {
    if (!fs.existsSync(annPath)) return null;
    fd = fs.openSync(annPath, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size <= 0) return null;
    const toRead = Math.min(MAX_ANNOTATION_FILE_BYTES, st.size);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    if (bytesRead <= 0) return null;
    return parseAnnotationArchivedStatus(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isSqliteMissingColumnError(err) {
  const msg = String(err?.message || err || "");
  return /no such column/i.test(msg);
}

function isSqliteBusyOrLockError(err) {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || err?.errstr || "");
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(`${code} ${msg}`);
}

function parseSummaryArchivedColumn(val) {
  if (val === null || val === undefined) return null;
  if (val === true) return true;
  if (val === false) return false;
  const rawStr = typeof val === "string" ? val.trim().toLowerCase() : "";
  if (rawStr === "true") return true;
  if (rawStr === "false") return false;
  const n = Number(val);
  if (Number.isFinite(n)) return n > 0;
  return null;
}

function readConversationFtsArchived(db, conversationId, errorState = null) {
  if (!db || !conversationId) return null;
  try {
    const archivedRow = db
      .prepare(
        "SELECT 1 AS archived FROM conversations_fts WHERE conversation_id = ? AND (archived = 1 OR archived = '1' OR lower(CAST(archived AS TEXT)) = 'true') LIMIT 1"
      )
      .get(conversationId);
    if (archivedRow) return true;
    const anyRow = db
      .prepare("SELECT archived FROM conversations_fts WHERE conversation_id = ? LIMIT 1")
      .get(conversationId);
    if (!anyRow || anyRow.archived === null || anyRow.archived === undefined) return null;
    return parseSummaryArchivedColumn(anyRow.archived);
  } catch (err) {
    if (errorState && isSqliteBusyOrLockError(err)) {
      errorState.hadError = true;
    }
    return null;
  }
}

const SUMMARY_LOOKUP_CACHE_MAX = 256;
const SUMMARY_LOOKUP_CACHE_TTL_MS = 10_000;
const _summaryLookupCache = new Map();

export function clearConversationSummaryCache() {
  _summaryLookupCache.clear();
}

export function getConversationSummaryCacheStats() {
  return {
    size: _summaryLookupCache.size,
    maxEntries: SUMMARY_LOOKUP_CACHE_MAX,
    ttlMs: SUMMARY_LOOKUP_CACHE_TTL_MS,
    policy: "lru",
    oldestKey: _summaryLookupCache.size > 0 ? _summaryLookupCache.keys().next().value : null
  };
}

function statSignatureSafe(filePath) {
  if (!filePath) return "-";
  try {
    const st = fs.statSync(filePath);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "-";
  }
}

function buildSummaryDiskStamp(dbCandidates, safeId) {
  const parts = [];
  for (const dbPath of dbCandidates) {
    const agRoot = path.dirname(dbPath);
    const annPath = path.resolve(agRoot, "annotations", `${safeId}.pbtxt`);
    parts.push(
      `${statSignatureSafe(dbPath)}/${statSignatureSafe(`${dbPath}-wal`)}/${statSignatureSafe(annPath)}`
    );
  }
  return parts.join("|");
}

function touchSummaryLookupCache(key, entry) {
  // True O(1) LRU promotion: re-insert key at the Map tail so hot entries survive eviction.
  _summaryLookupCache.delete(key);
  _summaryLookupCache.set(key, entry);
}

function rememberSummaryLookupCache(key, entry) {
  if (_summaryLookupCache.has(key)) {
    _summaryLookupCache.delete(key);
  }
  while (_summaryLookupCache.size >= SUMMARY_LOOKUP_CACHE_MAX) {
    const oldest = _summaryLookupCache.keys().next().value;
    if (oldest === undefined) break;
    _summaryLookupCache.delete(oldest);
  }
  _summaryLookupCache.set(key, entry);
}

/**
 * Read-only, fail-open lookup of Antigravity's official short conversation title,
 * archive/killed status, and fallback workspace root from `conversation_summaries.db`
 * and sibling `annotations/<id>.pbtxt` (zero user-prompt leakage).
 */
export function lookupConversationSummary(conversationId, options = {}) {
  const safeId = sanitizeConversationId(conversationId);
  const safeOpts = options && typeof options !== "string" ? options : {};
  const inlineTitle = extractInlinePayloadTitle(safeOpts.payload);
  const inlineCwd = extractPayloadWorkspaceRoot(safeOpts.payload) || decodeFileUriOrPath(safeOpts.cwd || "");
  const inlineParentRaw = sanitizeConversationId(
    safeOpts.payload?.parentConversationId ||
      safeOpts.payload?.parent_conversation_id ||
      safeOpts.payload?.common?.parentConversationId ||
      safeOpts.payload?.common?.parent_conversation_id ||
      safeOpts.payload?.metadata?.parentConversationId ||
      safeOpts.payload?.metadata?.parent_conversation_id ||
      ""
  );
  const inlineParent = inlineParentRaw && inlineParentRaw !== safeId ? inlineParentRaw : "";
  const inlineSubagent = Boolean(
    inlineParent || (safeOpts.payload && isSubagentLeasePayload(safeOpts.payload))
  );
  if (!safeId) {
    return {
      found: false,
      title: inlineTitle,
      cwd: inlineCwd,
      isSubagent: inlineSubagent,
      killed: false,
      archived: false,
      parentConversationId: inlineParent,
      nestingDepth: 0,
      agentName: ""
    };
  }
  if (inlineTitle && inlineCwd && !safeOpts.checkSubagent && !safeOpts.checkArchived) {
    return {
      found: false,
      title: inlineTitle,
      cwd: inlineCwd,
      isSubagent: inlineSubagent,
      killed: false,
      archived: false,
      parentConversationId: inlineParent,
      nestingDepth: 0,
      agentName: ""
    };
  }

  const dbCandidates = resolveCandidateSummaryDbPaths({
    transcriptPath: safeOpts.transcriptPath || "",
    summaryDbPath: safeOpts.summaryDbPath || "",
    allowDefaultDb: safeOpts.allowDefaultDb !== false
  });
  const allowUntitledCustomAgent = safeOpts.allowUntitledCustomAgent !== false;
  const useCache = safeOpts.bypassCache !== true;
  const cacheKey = useCache
    ? `${safeId}\0${allowUntitledCustomAgent ? "1" : "0"}\0${dbCandidates.join("\0")}`
    : "";
  const nowMs = Date.now();
  const diskStamp = useCache ? buildSummaryDiskStamp(dbCandidates, safeId) : "";
  if (useCache) {
    const cached = _summaryLookupCache.get(cacheKey);
    if (cached && nowMs < cached.expiresAt && cached.diskStamp === diskStamp) {
      touchSummaryLookupCache(cacheKey, cached);
      const r = cached.record;
      return {
        found: r.found,
        title: inlineTitle || r.title,
        cwd: inlineCwd || r.cwd,
        isSubagent: Boolean(inlineSubagent || r.isSubagent),
        killed: r.killed,
        archived: r.archived,
        parentConversationId: inlineParent || r.parentConversationId,
        nestingDepth: r.nestingDepth,
        agentName: r.agentName
      };
    }
  }

  const SUMMARY_SELECT_VARIANTS = [
    "SELECT title, workspace_uris, parent_conversation_id, nesting_depth, agent_name, killed, archived FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    "SELECT title, workspace_uris, parent_conversation_id, nesting_depth, agent_name, killed FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    "SELECT title, workspace_uris, parent_conversation_id, nesting_depth, agent_name FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    "SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ? LIMIT 1"
  ];
  const lookupDeadlineMs =
    Number.isFinite(Number(safeOpts.maxWaitMs)) && Number(safeOpts.maxWaitMs) >= 10
      ? Math.min(5000, Math.floor(Number(safeOpts.maxWaitMs)))
      : 250;
  const lookupStartedAt = Date.now();
  let hadDbError = false;
  let fallbackArchived = false;
  for (const dbPath of dbCandidates) {
    const agRoot = path.dirname(dbPath);
    const annArchived = readConversationAnnotationArchived(agRoot, safeId);
    if (annArchived === true) fallbackArchived = true;
    const remainingMs = lookupDeadlineMs - (Date.now() - lookupStartedAt);
    if (remainingMs <= 0) {
      hadDbError = true;
      break;
    }
    let db = null;
    try {
      if (!fs.existsSync(dbPath)) continue;
      const DatabaseSync = getLazyDatabaseSync();
      const timeoutBudget = Math.max(10, Math.min(remainingMs, 50));
      try {
        db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutBudget });
      } catch {
        db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          db.exec(`PRAGMA busy_timeout = ${timeoutBudget};`);
        } catch {}
      }
      let row = null;
      let lastQueryErr = null;
      for (let i = 0; i < SUMMARY_SELECT_VARIANTS.length; i += 1) {
        const remBeforeQuery = lookupDeadlineMs - (Date.now() - lookupStartedAt);
        if (i > 0 && remBeforeQuery <= 0) {
          hadDbError = true;
          lastQueryErr = new Error("SQLITE_BUSY: lookup deadline exceeded");
          break;
        }
        try {
          row = db.prepare(SUMMARY_SELECT_VARIANTS[i]).get(safeId);
          lastQueryErr = null;
          break;
        } catch (qErr) {
          lastQueryErr = qErr;
          if (!isSqliteMissingColumnError(qErr)) {
            break;
          }
        }
      }
      if (lastQueryErr) {
        throw lastQueryErr;
      }
      const dbParent = readConversationParentId(db, safeId, row?.parent_conversation_id);
      if (row || dbParent) {
        row ??= {};
        const dbTitle = typeof row.title === "string" ? sanitizeWatchdogText(row.title, 36) : "";
        const dbCwd = typeof row.workspace_uris === "string" ? parseWorkspaceUriToPath(row.workspace_uris) : "";
        const dbDepth = Number.isFinite(Number(row.nesting_depth))
          ? Math.max(0, Math.floor(Number(row.nesting_depth)))
          : 0;
        const dbAgent = typeof row.agent_name === "string" ? row.agent_name.trim().slice(0, 96) : "";
        const dbKilled = Boolean(row.killed === true || (Number.isFinite(Number(row.killed)) && Number(row.killed) > 0));
        const rowArchived = parseSummaryArchivedColumn(row.archived);
        const ftsErrState = { hadError: false };
        const dbArchived =
          annArchived !== null
            ? annArchived
            : rowArchived !== null
              ? rowArchived
              : readConversationFtsArchived(db, safeId, ftsErrState) === true;
        if (ftsErrState.hadError) hadDbError = true;
        const dbSubagent = isSummaryMetadataSubagent({
          conversationId: safeId,
          parentConversationId: dbParent,
          nestingDepth: dbDepth,
          agentName: dbAgent,
          title: dbTitle,
          allowUntitledCustomAgent
        });
        const record = {
          found: true,
          title: dbTitle,
          cwd: dbCwd,
          isSubagent: dbSubagent,
          killed: dbKilled,
          archived: dbArchived,
          parentConversationId: dbParent,
          nestingDepth: dbDepth,
          agentName: dbAgent
        };
        if (useCache && !hadDbError) {
          rememberSummaryLookupCache(cacheKey, {
            diskStamp,
            expiresAt: nowMs + SUMMARY_LOOKUP_CACHE_TTL_MS,
            record
          });
        }
        return {
          found: true,
          title: inlineTitle || dbTitle,
          cwd: inlineCwd || dbCwd,
          isSubagent: Boolean(inlineSubagent || dbSubagent),
          killed: dbKilled,
          archived: dbArchived,
          parentConversationId: inlineParent || dbParent,
          nestingDepth: dbDepth,
          agentName: dbAgent
        };
      }
      const ftsErrState = { hadError: false };
      if (annArchived === null && readConversationFtsArchived(db, safeId, ftsErrState) === true) {
        fallbackArchived = true;
      }
      if (ftsErrState.hadError) hadDbError = true;
    } catch {
      hadDbError = true;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  const missRecord = {
    found: false,
    title: "",
    cwd: "",
    isSubagent: false,
    killed: false,
    archived: fallbackArchived,
    parentConversationId: "",
    nestingDepth: 0,
    agentName: ""
  };
  if (useCache && !hadDbError) {
    rememberSummaryLookupCache(cacheKey, {
      diskStamp,
      expiresAt: nowMs + SUMMARY_LOOKUP_CACHE_TTL_MS,
      record: missRecord
    });
  }
  return {
    found: false,
    title: inlineTitle,
    cwd: inlineCwd,
    isSubagent: inlineSubagent,
    killed: false,
    archived: fallbackArchived,
    parentConversationId: inlineParent,
    nestingDepth: 0,
    agentName: ""
  };
}

export function lookupConversationTitle(conversationId, options = {}) {
  return lookupConversationSummary(conversationId, options).title;
}

const SUMMARY_RECENT_TIME_COLUMNS = [
  "last_modified_time",
  "updated_at",
  "modified_at",
  "last_updated_ms",
  "updated_ms",
  "last_step_time",
  "created_at"
];

function isSqliteLockError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const code = String(err?.code || err?.errcode || "").toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database is busy") ||
    msg.includes("sqlite_busy") ||
    msg.includes("sqlite_locked") ||
    code.includes("busy") ||
    code.includes("locked")
  );
}

/**
 * Bounded lookup of recently active conversation IDs from a sibling `conversation_summaries.db`
 * alongside a `brain/` directory, honoring a shared wall-clock deadline and reporting
 * lock/budget degradation and ordering precision (`indexed_time` | `small_table_time` | `rowid_heuristic`).
 */
export function queryRecentConversationIdsFromSummaryDb(brainRoot, maxCandidates = 32, options = {}) {
  if (!brainRoot || typeof brainRoot !== "string") {
    return { ids: [], status: "missing", precision: "none" };
  }
  const resolvedRoot = path.resolve(brainRoot);
  if (path.basename(resolvedRoot).toLowerCase() !== "brain") {
    return { ids: [], status: "missing", precision: "none" };
  }
  const agRoot = path.dirname(resolvedRoot);
  if (!agRoot || agRoot === resolvedRoot) {
    return { ids: [], status: "missing", precision: "none" };
  }
  const summaryDbPath = path.join(agRoot, "conversation_summaries.db");
  const limit = Number.isFinite(Number(maxCandidates)) && Number(maxCandidates) >= 1
    ? Math.min(200, Math.floor(Number(maxCandidates)))
    : 32;
  const deadlineMs = Number.isFinite(Number(options?.deadlineMs)) ? Number(options.deadlineMs) : null;
  const remainingMs = () => (deadlineMs === null ? 150 : deadlineMs - Date.now());
  if (deadlineMs !== null && remainingMs() <= 0) {
    return { ids: [], status: "budget_exhausted", precision: "none" };
  }

  let db = null;
  try {
    if (!fs.existsSync(summaryDbPath)) {
      return { ids: [], status: "missing", precision: "none" };
    }
    const remOpen = remainingMs();
    if (deadlineMs !== null && remOpen <= 0) {
      return { ids: [], status: "budget_exhausted", precision: "none" };
    }
    const perOpTimeoutMs = Math.max(1, Math.min(40, Math.floor(remOpen)));
    const DatabaseSync = getLazyDatabaseSync();
    try {
      db = new DatabaseSync(summaryDbPath, { readOnly: true, timeout: perOpTimeoutMs });
    } catch {
      db = new DatabaseSync(summaryDbPath, { readOnly: true });
    }

    const syncBusyTimeout = () => {
      if (deadlineMs === null) return true;
      const rem = remainingMs();
      if (rem <= 0) return false;
      const stepTimeout = Math.max(1, Math.min(35, Math.floor(rem)));
      try {
        db.exec(`PRAGMA busy_timeout = ${stepTimeout}`);
      } catch {}
      return true;
    };

    if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
    const cols = db.prepare("PRAGMA table_info(conversation_summaries)").all();
    const colNames = new Set((cols || []).map((c) => String(c?.name || "").toLowerCase()));
    if (!colNames.has("conversation_id")) {
      return { ids: [], status: "ok", precision: "none" };
    }

    const indexedLeadingCols = new Set();
    if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
    try {
      const idxList = db.prepare("PRAGMA index_list(conversation_summaries)").all();
      for (const idx of idxList || []) {
        if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
        const idxName = typeof idx?.name === "string" ? idx.name : "";
        if (!idxName) continue;
        try {
          const escapedIdx = idxName.replace(/"/g, '""');
          const idxCols = db.prepare(`PRAGMA index_info("${escapedIdx}")`).all();
          const first = (idxCols || []).find((c) => Number(c?.seqno) === 0);
          if (first && typeof first.name === "string") {
            indexedLeadingCols.add(first.name.toLowerCase());
          }
        } catch (idxErr) {
          if (isSqliteLockError(idxErr)) throw idxErr;
        }
      }
    } catch (listErr) {
      if (isSqliteLockError(listErr)) throw listErr;
    }

    const indexedTimeCol = SUMMARY_RECENT_TIME_COLUMNS.find(
      (c) => colNames.has(c) && indexedLeadingCols.has(c)
    );
    let orderCol = indexedTimeCol || "rowid";
    let precision = indexedTimeCol ? "indexed_time" : "rowid_heuristic";
    if (!indexedTimeCol) {
      const plainTimeCol = SUMMARY_RECENT_TIME_COLUMNS.find((c) => colNames.has(c));
      if (plainTimeCol) {
        if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
        const isLargeTable = Boolean(
          db.prepare("SELECT 1 AS hit FROM conversation_summaries LIMIT 1 OFFSET 256").get()
        );
        if (!isLargeTable) {
          orderCol = plainTimeCol;
          precision = "small_table_time";
        }
      }
    }

    if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
    let rows;
    try {
      rows = db
        .prepare(`SELECT conversation_id FROM conversation_summaries ORDER BY ${orderCol} DESC LIMIT ?`)
        .all(limit);
    } catch (selErr) {
      if (isSqliteLockError(selErr)) throw selErr;
      if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
      precision = "rowid_heuristic";
      rows = db
        .prepare("SELECT conversation_id FROM conversation_summaries LIMIT ?")
        .all(limit);
    }
    const out = [];
    for (const row of rows || []) {
      const cid = sanitizeConversationId(row?.conversation_id);
      if (cid) out.push(cid);
    }
    return { ids: out, status: "ok", precision };
  } catch (err) {
    if (isSqliteLockError(err)) {
      return { ids: [], status: "locked", precision: "none" };
    }
    return { ids: [], status: "error", precision: "none" };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

export function listRecentConversationIdsFromSummaryDb(brainRoot, maxCandidates = 32, options = {}) {
  return queryRecentConversationIdsFromSummaryDb(brainRoot, maxCandidates, options).ids;
}

registerSummaryLookup(lookupConversationSummary);
