/**
 * Bounded, symlink-safe Antigravity brain & transcript locator.
 *
 * Strictly zero direct `node:sqlite` / `./store` dependency (delegates optional
 * recent-ID lookup to `../watchdog-summaries.js` and falls back to bounded
 * streaming directory traversal sharing a single wall-clock deadline).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryRecentConversationIdsFromSummaryDb } from "../watchdog-summaries.js";

const RESERVED_BRAIN_CONV_IDS = new Set([
  "default",
  "all",
  "lifetime",
  "app",
  "__unbound__",
  "unknown",
  "none",
  "null",
  "undefined"
]);

function isUncPathLocal(p) {
  if (!p || typeof p !== "string") return false;
  return /^[\\/]{2}/.test(p.trim());
}

function resolveCanonicalPathLocal(p) {
  const real =
    typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(p) : fs.realpathSync(p);
  if (process.platform === "win32") {
    const driveMatch = real.match(/^\\\\\?\\([a-zA-Z]:\\.*)$/);
    if (driveMatch) return driveMatch[1];
  }
  return real;
}

function isStrictPathInside(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const nc = process.platform === "win32" ? childPath.toLowerCase() : childPath;
  const np = process.platform === "win32" ? parentPath.toLowerCase() : parentPath;
  const rel = path.relative(np, nc);
  return Boolean(
    rel &&
      rel !== "." &&
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith("../") &&
      !path.isAbsolute(rel)
  );
}

/**
 * Return allowed Antigravity brain root directories (extra roots first, then default user roots).
 */
export function getAntigravityBrainRoots(extraRoots = []) {
  const home = os.homedir();
  const rawList = [
    ...(Array.isArray(extraRoots) ? extraRoots : []),
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain")
  ];
  const seen = new Set();
  const out = [];
  for (const r of rawList) {
    if (typeof r !== "string") continue;
    const trimmed = r.trim();
    if (!trimmed || trimmed.includes("\0") || isUncPathLocal(trimmed) || !path.isAbsolute(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    if (isUncPathLocal(resolved)) continue;
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

const PREFERRED_TRANSCRIPT_REL_PATHS = Object.freeze([
  [".system_generated", "logs", "transcript.jsonl"],
  [".system_generated", "transcript.jsonl"],
  ["transcript.jsonl"],
  [".system_generated", "logs", "transcript_full.jsonl"],
  [".system_generated", "transcript_full.jsonl"],
  ["transcript_full.jsonl"]
]);
const CONVERSATION_ARTIFACT_REL_PATHS = Object.freeze([
  ["task.md"],
  ["implementation_plan.md"],
  ["walkthrough.md"]
]);

function inspectConversationDirOwnership(convDirInfo) {
  let hasOwnedFile = false;
  let hasSuspiciousEscape = false;
  const allCandidates = [...PREFERRED_TRANSCRIPT_REL_PATHS, ...CONVERSATION_ARTIFACT_REL_PATHS];

  for (const segs of allCandidates) {
    if (resolveConversationOwnedFile(convDirInfo, segs)) {
      hasOwnedFile = true;
      break;
    }
    const candPath = path.join(convDirInfo.dir, ...segs);
    try {
      fs.lstatSync(candPath);
      hasSuspiciousEscape = true;
    } catch {
      // Missing slot -> normal
    }
  }

  if (!hasOwnedFile && !hasSuspiciousEscape) {
    for (const dirSegs of [[".system_generated"], [".system_generated", "logs"]]) {
      const dirCand = path.join(convDirInfo.dir, ...dirSegs);
      try {
        const st = fs.lstatSync(dirCand);
        if (st.isSymbolicLink()) {
          hasSuspiciousEscape = true;
          break;
        }
        const realSub = resolveCanonicalPathLocal(dirCand);
        if (isUncPathLocal(realSub) || !isStrictPathInside(realSub, convDirInfo.dir)) {
          hasSuspiciousEscape = true;
          break;
        }
      } catch {
        // Missing subdir -> normal
      }
    }
  }

  return { hasOwnedFile, hasSuspiciousEscape };
}

/**
 * Resolve and canonically validate a single conversation's owned brain directory.
 */
export function resolveConversationBrainDir(conversationId, extraRoots = []) {
  if (typeof conversationId !== "string") return null;
  const safeId = conversationId.trim();
  if (!safeId || RESERVED_BRAIN_CONV_IDS.has(safeId.toLowerCase()) || !isSafeConversationId(safeId)) {
    return null;
  }
  const roots = getAntigravityBrainRoots(extraRoots);
  let firstEmptyValid = null;
  for (const resolvedRoot of roots) {
    let realRoot;
    try {
      const rootStat = fs.statSync(resolvedRoot);
      if (!rootStat.isDirectory()) continue;
      realRoot = resolveCanonicalPathLocal(resolvedRoot);
      if (isUncPathLocal(realRoot)) continue;
    } catch {
      continue;
    }
    const expectedDir = path.join(realRoot, safeId);
    try {
      const lstat = fs.lstatSync(expectedDir);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) continue;
      const realCand = resolveCanonicalPathLocal(expectedDir);
      if (isUncPathLocal(realCand)) continue;
      const cmpCand = process.platform === "win32" ? realCand.toLowerCase() : realCand;
      const cmpExpected = process.platform === "win32" ? expectedDir.toLowerCase() : expectedDir;
      if (cmpCand !== cmpExpected || !isStrictPathInside(realCand, realRoot)) continue;
      const info = {
        root: resolvedRoot,
        realRoot,
        dir: realCand,
        conversationId: safeId
      };
      const ownership = inspectConversationDirOwnership(info);
      if (ownership.hasOwnedFile || ownership.hasSuspiciousEscape) {
        return info;
      }
      if (!firstEmptyValid) {
        firstEmptyValid = info;
      }
    } catch {
      // Missing or inaccessible in this brain root -> try next root
    }
  }
  return firstEmptyValid;
}

/**
 * Independently verify that a candidate regular file inside a validated conversation brain dir
 * remains canonically owned by that exact conversation.
 */
export function resolveConversationOwnedFile(convDirInfo, relativeSegments = []) {
  if (!convDirInfo || typeof convDirInfo.dir !== "string" || !convDirInfo.dir) return null;
  if (!Array.isArray(relativeSegments) || relativeSegments.length === 0) return null;
  for (const seg of relativeSegments) {
    if (
      typeof seg !== "string" ||
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("\0") ||
      seg.includes("/") ||
      seg.includes("\\")
    ) {
      return null;
    }
  }
  const candPath = path.join(convDirInfo.dir, ...relativeSegments);
  if (isUncPathLocal(candPath) || !isStrictPathInside(candPath, convDirInfo.dir)) {
    return null;
  }
  try {
    fs.lstatSync(candPath);
    const realFile = resolveCanonicalPathLocal(candPath);
    if (isUncPathLocal(realFile)) return null;
    if (!isStrictPathInside(realFile, convDirInfo.dir)) return null;
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) return null;
    return { path: realFile, stat };
  } catch {
    return null;
  }
}

/**
 * Strictly locate the preferred transcript for a confirmed conversationId inside its own
 * verified brain directory: prefers `transcript.jsonl` and falls back to the SAME session's
 * `transcript_full.jsonl`. Never falls back across sessions.
 */
export function findPreferredTranscriptForConversation(
  conversationId,
  { extraRoots = [], convDirInfo = null } = {}
) {
  const dirInfo = convDirInfo || resolveConversationBrainDir(conversationId, extraRoots);
  if (!dirInfo) return null;
  for (const segs of PREFERRED_TRANSCRIPT_REL_PATHS) {
    const owned = resolveConversationOwnedFile(dirInfo, segs);
    if (owned) return owned.path;
  }
  return null;
}

/**
 * Strictly validate a conversationId before joining it onto local brain root paths.
 */
export function isSafeConversationId(conversationId) {
  if (typeof conversationId !== "string") return false;
  const trimmed = conversationId.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return false;
  return /^[A-Za-z0-9._-]+$/.test(trimmed);
}

const DEFAULT_BRAIN_SCAN_MAX_ENTRIES = 500;
const DEFAULT_BRAIN_SCAN_MAX_MS = 150;
const LATEST_TRANSCRIPT_SCAN_CACHE_MAX = 16;
const LATEST_TRANSCRIPT_SCAN_CACHE_TTL_MS = 10_000;
const _latestTranscriptScanCache = new Map();

export function clearTranscriptScanCache() {
  _latestTranscriptScanCache.clear();
}

function probeConversationTranscriptInRoot(resolvedRoot, safeId) {
  const candidates = [
    path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript_full.jsonl"),
    path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(resolvedRoot, safeId, ".system_generated", "transcript_full.jsonl"),
    path.join(resolvedRoot, safeId, ".system_generated", "transcript.jsonl")
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return { path: c, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return null;
}

function findNewestTranscriptViaSummaryDb(brainRoot, maxCandidates = 32, { deadlineMs = null } = {}) {
  if (!brainRoot || typeof brainRoot !== "string") {
    return { hit: null, status: "missing", precision: "none" };
  }
  const resolvedRoot = path.resolve(brainRoot);
  const query = queryRecentConversationIdsFromSummaryDb(resolvedRoot, maxCandidates, { deadlineMs });
  if (query.status !== "ok" || !Array.isArray(query.ids) || query.ids.length === 0) {
    return { hit: null, status: query.status, precision: query.precision };
  }
  let best = null;
  for (const cid of query.ids) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      return { hit: best, status: "budget_exhausted", precision: query.precision };
    }
    if (!isSafeConversationId(cid)) continue;
    const hit = probeConversationTranscriptInRoot(resolvedRoot, cid);
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) {
      best = hit;
    }
  }
  return { hit: best, status: "ok", precision: query.precision };
}

/**
 * Locate Antigravity transcript_full.jsonl / transcript.jsonl for a conversationId.
 */
export function findTranscriptForConversation(conversationId = null, optionsOrExtraRoots = {}) {
  const opts = Array.isArray(optionsOrExtraRoots)
    ? { extraRoots: optionsOrExtraRoots, exactOnly: false }
    : optionsOrExtraRoots || {};
  const extraRoots = Array.isArray(opts.extraRoots) ? opts.extraRoots : [];
  const exactOnly = Boolean(opts.exactOnly);
  const maxEntries =
    Number.isFinite(Number(opts.maxEntries)) && Number(opts.maxEntries) >= 1
      ? Math.floor(Number(opts.maxEntries))
      : DEFAULT_BRAIN_SCAN_MAX_ENTRIES;
  const maxScanMs =
    Number.isFinite(Number(opts.maxScanMs)) && Number(opts.maxScanMs) >= 1
      ? Math.floor(Number(opts.maxScanMs))
      : DEFAULT_BRAIN_SCAN_MAX_MS;
  const noCache = Boolean(opts.noCache);
  const includeDefaultRoots = opts.includeDefaultRoots !== false;

  const home = os.homedir();
  const roots = includeDefaultRoots
    ? [
        ...extraRoots,
        path.join(home, ".gemini", "antigravity", "brain"),
        path.join(home, ".gemini", "antigravity-ide", "brain"),
        path.join(home, ".gemini", "antigravity-cli", "brain")
      ]
    : [...extraRoots];

  const isSpecific =
    conversationId &&
    conversationId !== "default" &&
    conversationId !== "all" &&
    conversationId !== "lifetime" &&
    conversationId !== "app";

  if (isSpecific) {
    if (!isSafeConversationId(conversationId)) {
      return null;
    }
    const safeId = conversationId.trim();
    for (const root of roots) {
      if (!root || typeof root !== "string") continue;
      const resolvedRoot = path.resolve(root);
      let realRoot = null;
      const candidates = [
        path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript_full.jsonl"),
        path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript.jsonl"),
        path.join(resolvedRoot, safeId, ".system_generated", "transcript_full.jsonl"),
        path.join(resolvedRoot, safeId, ".system_generated", "transcript.jsonl"),
        path.join(resolvedRoot, safeId, "transcript_full.jsonl"),
        path.join(resolvedRoot, safeId, "transcript.jsonl")
      ];
      for (const c of candidates) {
        const resolvedCand = path.resolve(c);
        const rel = path.relative(
          process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot,
          process.platform === "win32" ? resolvedCand.toLowerCase() : resolvedCand
        );
        if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) continue;
        if (!fs.existsSync(resolvedCand)) continue;
        try {
          if (realRoot === null) realRoot = fs.realpathSync(resolvedRoot);
          const realCand = fs.realpathSync(resolvedCand);
          const realRel = path.relative(
            process.platform === "win32" ? realRoot.toLowerCase() : realRoot,
            process.platform === "win32" ? realCand.toLowerCase() : realCand
          );
          if (realRel && realRel !== ".." && !realRel.startsWith(`..${path.sep}`) && !realRel.startsWith("../") && !path.isAbsolute(realRel) && fs.statSync(realCand).isFile()) {
            return realCand;
          }
        } catch {
          // Reject unreadable or escaping symlink targets
        }
      }
    }
  }

  if (exactOnly) return null;

  const nowMs = Date.now();
  const rootStampParts = [];
  for (const root of roots) {
    if (!root || typeof root !== "string") continue;
    let rMtime = 0;
    try {
      rMtime = Math.round(fs.statSync(root).mtimeMs);
    } catch {}
    let dbSig = "-";
    let walSig = "-";
    try {
      const resolvedRoot = path.resolve(root);
      if (path.basename(resolvedRoot).toLowerCase() === "brain") {
        const dbPath = path.join(path.dirname(resolvedRoot), "conversation_summaries.db");
        try {
          const st = fs.statSync(dbPath);
          dbSig = `${Math.round(st.mtimeMs)}:${st.size}`;
        } catch {}
        try {
          const wst = fs.statSync(`${dbPath}-wal`);
          walSig = `${Math.round(wst.mtimeMs)}:${wst.size}`;
        } catch {}
      }
    } catch {}
    rootStampParts.push(`${root}:${rMtime}:${dbSig}:${walSig}`);
  }
  const cacheKey = `${maxEntries}:${maxScanMs}:${roots.join("\0")}`;
  const rootStamp = rootStampParts.join("|");
  if (!noCache) {
    const cached = _latestTranscriptScanCache.get(cacheKey);
    if (cached && nowMs < cached.expiresAt && cached.rootStamp === rootStamp) {
      if (!cached.path || fs.existsSync(cached.path)) {
        _latestTranscriptScanCache.delete(cacheKey);
        _latestTranscriptScanCache.set(cacheKey, cached);
        return cached.path;
      }
    }
  }

  const deadlineMs = Date.now() + maxScanMs;
  let bestPath = null;
  let bestMtime = 0;
  let degraded = false;
  let hadHeuristicOnly = false;
  const rootsNeedingDirScan = [];

  for (const root of roots) {
    if (Date.now() >= deadlineMs) {
      degraded = true;
      break;
    }
    const summaryRes = findNewestTranscriptViaSummaryDb(root, 32, { deadlineMs });
    if (summaryRes.status === "locked" || summaryRes.status === "budget_exhausted" || summaryRes.status === "error") {
      degraded = true;
    }
    if (summaryRes.hit && summaryRes.hit.mtimeMs > bestMtime) {
      bestMtime = summaryRes.hit.mtimeMs;
      bestPath = summaryRes.hit.path;
    }
    if (!summaryRes.hit) {
      rootsNeedingDirScan.push(root);
    } else if (summaryRes.precision === "rowid_heuristic") {
      hadHeuristicOnly = true;
      rootsNeedingDirScan.push(root);
    }
  }

  let budgetHit = false;
  if (rootsNeedingDirScan.length > 0) {
    let scannedEntries = 0;
    for (const root of rootsNeedingDirScan) {
      if (budgetHit || Date.now() >= deadlineMs) {
        budgetHit = true;
        break;
      }
      let dir = null;
      try {
        dir = fs.opendirSync(root);
      } catch {
        continue;
      }
      try {
        while (true) {
          if (scannedEntries >= maxEntries || Date.now() >= deadlineMs) {
            budgetHit = true;
            break;
          }
          const entry = dir.readSync();
          if (!entry) break;
          scannedEntries += 1;
          if (!entry.isDirectory()) continue;
          const hit = probeConversationTranscriptInRoot(root, entry.name);
          if (hit && hit.mtimeMs > bestMtime) {
            bestMtime = hit.mtimeMs;
            bestPath = hit.path;
          }
        }
      } finally {
        try {
          dir.closeSync();
        } catch {}
      }
    }
  }
  if (budgetHit) degraded = true;

  const canCacheResult = !noCache && !(bestPath === null && degraded) && !(hadHeuristicOnly && degraded);
  if (canCacheResult) {
    if (_latestTranscriptScanCache.has(cacheKey)) {
      _latestTranscriptScanCache.delete(cacheKey);
    } else if (_latestTranscriptScanCache.size >= LATEST_TRANSCRIPT_SCAN_CACHE_MAX) {
      const oldest = _latestTranscriptScanCache.keys().next().value;
      if (oldest !== undefined) _latestTranscriptScanCache.delete(oldest);
    }
    _latestTranscriptScanCache.set(cacheKey, {
      rootStamp,
      expiresAt: nowMs + LATEST_TRANSCRIPT_SCAN_CACHE_TTL_MS,
      path: bestPath
    });
  }
  return bestPath;
}
