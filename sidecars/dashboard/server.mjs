import { suppressSqliteExperimentalWarning } from "../../hooks/compile-cache.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEffectiveConfig } from "../../context/lib/config.js";
import { ContextModeStore, FILE_CATEGORIES } from "../../context/lib/store.js";
suppressSqliteExperimentalWarning();
import { buildHandoffBrief, inferWorkspaceFromStore } from "../../context/lib/handoff.js";
import {
  analyzeTranscriptCache,
  computeCacheWarmth,
  CONTEXT_CRITICAL_TOKENS,
  CONTEXT_WARN_TOKENS,
  createEmptyContextComposition,
  createEmptySubagentBreakdown,
  DEFAULT_CACHE_TTL_SEC,
  findTranscriptForConversation,
  isSafeConversationId,
  MIN_CACHEABLE_CONTEXT_TOKENS,
  parseTranscriptLines,
  readTranscriptTail,
  resolveModelProfile
} from "../../context/lib/cache-analyzer.js";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const HTML_FILE = path.join(__dirname, "index.html");
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const SIDECAR_CSRF_TOKEN = crypto.randomBytes(24).toString("hex");

let _runtimeStore = null;
let _appStartTime = null;
let _runtimeInitialized = false;

function getAppStartTime() {
  if (_appStartTime !== null) return _appStartTime;
  let ts = null;
  if (process.platform === "win32") {
    try {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-Process -Name language_server, Antigravity | Measure-Object -Property StartTime -Minimum).Minimum.ToUniversalTime().ToString(\'yyyy-MM-ddTHH:mm:ss.fffZ\')"',
        { encoding: "utf8", timeout: 3000, windowsHide: true }
      );
      const parsed = new Date(out.trim()).getTime();
      if (!Number.isNaN(parsed) && parsed > 0) ts = parsed;
    } catch {}
  }
  _appStartTime = ts || (Date.now() - Math.round(process.uptime() * 1000));
  return _appStartTime;
}

function getRuntimeStore() {
  if (!_runtimeStore) {
    _runtimeStore = new ContextModeStore();
  }
  if (!_runtimeInitialized) {
    _runtimeInitialized = true;
    const startTs = getAppStartTime();
    // Clear session-level overrides on app session restart
    try {
      const recordedSessionTime = _runtimeStore.getMeta("app_session_start_time");
      if (!recordedSessionTime || recordedSessionTime !== String(startTs)) {
        _runtimeStore.clearSessionOverrides();
        _runtimeStore.setMeta("app_session_start_time", String(startTs));
      }
    } catch {}
  }
  return _runtimeStore;
}

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export function isAllowedHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  return LOCAL_HOST_RE.test(hostHeader.trim());
}

export function isAllowedOriginHeader(originHeader, hostHeader = null) {
  if (originHeader === undefined || originHeader === null || originHeader === "") return true;
  if (typeof originHeader !== "string") return false;
  const trimmed = originHeader.trim();
  if (!LOCAL_ORIGIN_RE.test(trimmed)) return false;
  try {
    const originUrl = new URL(trimmed);
    if (originUrl.protocol !== "http:") return false;
    if (typeof hostHeader === "string" && hostHeader.trim()) {
      const reqHostUrl = new URL(`http://${hostHeader.trim()}`);
      if (originUrl.hostname.toLowerCase() !== reqHostUrl.hostname.toLowerCase()) return false;
      const originPort = originUrl.port || "80";
      const hostPort = reqHostUrl.port || "80";
      if (originPort !== hostPort) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function isCrossSiteFetchHeader(secFetchSite, { allowSameSite = false } = {}) {
  if (secFetchSite === undefined || secFetchSite === null) return false;
  if (typeof secFetchSite !== "string") return true;
  const normalized = secFetchSite.trim().toLowerCase();
  if (!normalized || normalized === "same-origin" || normalized === "none") return false;
  if (allowSameSite && normalized === "same-site") return false;
  return true;
}

export function isJsonContentType(contentType) {
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType.trim());
}

export function timingSafeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function readBoundedJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve) => {
    const rawContentLen = req.headers?.["content-length"];
    if (rawContentLen !== undefined) {
      const declaredLen = Number(rawContentLen);
      if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        req.on("error", () => {});
        req.resume();
        resolve({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let overflowed = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (overflowed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        req.resume();
        finish({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (overflowed || settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: true, data: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, error: "Request body must be a JSON object" });
          return;
        }
        finish({ ok: true, data: parsed });
      } catch (err) {
        finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Invalid JSON body" });
      }
    });

    req.on("error", (err) => {
      finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Request stream error" });
    });

    req.on("aborted", () => {
      finish({ ok: false, status: 400, error: "Request stream aborted" });
    });

    req.on("close", () => {
      if (!settled && !req.complete) {
        finish({ ok: false, status: 400, error: "Request stream closed prematurely" });
      }
    });
  });
}

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    if (pkg.version) return pkg.version;
  } catch {}
  return "1.2.0";
}

function getRenderedHtml(csrfToken = SIDECAR_CSRF_TOKEN) {
  const raw = fs.readFileSync(HTML_FILE, "utf8");
  const ver = getPackageVersion();
  const withVer = raw.replace('id="dashboard-version">--</span>', `id="dashboard-version">v${ver}</span>`);
  const tokenMeta = `  <meta name="agy-dart-token" content="${csrfToken}">\n</head>`;
  return withVer.includes("</head>") ? withVer.replace("</head>", tokenMeta) : withVer;
}

const MAX_SEARCH_QUERIES = 20;
const MAX_SEARCH_QUERY_CHARS = 256;

function isUncPath(p) {
  return typeof p === "string" && /^[\\/]{2}/.test(p.trim());
}

function validateStringFields(data, fields) {
  if (!data || typeof data !== "object") return { ok: true };
  for (const field of fields) {
    const val = data[field];
    if (val !== undefined && val !== null && typeof val !== "string") {
      return { ok: false, error: `Field '${field}' must be a string` };
    }
  }
  return { ok: true };
}

function validateAndNormalizeSearchInput(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  if (data.queries !== undefined) {
    if (!Array.isArray(data.queries)) {
      return { ok: false, error: "Field 'queries' must be an array of strings" };
    }
    if (data.queries.length > MAX_SEARCH_QUERIES) {
      return { ok: false, error: `At most ${MAX_SEARCH_QUERIES} search queries are allowed per request` };
    }
    const queries = [];
    for (const q of data.queries) {
      if (typeof q !== "string") {
        return { ok: false, error: "Each item in 'queries' must be a string" };
      }
      queries.push(q.slice(0, MAX_SEARCH_QUERY_CHARS));
    }
    return { ok: true, queries };
  }
  if (data.query !== undefined && data.query !== null && typeof data.query !== "string") {
    return { ok: false, error: "Field 'query' must be a string" };
  }
  return { ok: true, queries: [typeof data.query === "string" ? data.query.slice(0, MAX_SEARCH_QUERY_CHARS) : ""] };
}

function resolveTargetSession(data, defaultConvId = "default") {
  const safeSessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const safeConvId = typeof data?.conversationId === "string" ? data.conversationId : "";
  const rawScope = typeof data?.scope === "string" && data.scope.trim() ? data.scope.trim() : "";
  const scope =
    rawScope === "all"
      ? "lifetime"
      : rawScope === "session"
        ? "app"
        : rawScope || (safeSessionId === "all" ? "lifetime" : safeSessionId === "app" ? "app" : "conversation");
  const convId =
    safeConvId ||
    (safeSessionId && safeSessionId !== "all" && safeSessionId !== "app" ? safeSessionId : defaultConvId || "default");
  let targetSid = convId;
  if (scope === "lifetime" || scope === "all") targetSid = "all";
  else if (scope === "app" || scope === "session") targetSid = "app";
  return { scope, convId, targetSid };
}

function getStatsPayload(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const { scope, convId, targetSid } = resolveTargetSession(data, defaultConvId);
  const isLifetimeScope = scope === "lifetime" || scope === "all";
  const isAppScope = scope === "app" || scope === "session";
  let stats;
  if (isLifetimeScope) {
    stats = store.getStats("all");
  } else if (isAppScope) {
    stats = store.getStats("app", { sinceTs: appStartTime });
  } else {
    stats = store.getStats(convId);
  }

  stats.scope = scope;
  stats.conversationId = convId;
  stats.appStartTime = appStartTime;
  stats.conversationCutoffBytes = store.getCutoff(convId);
  stats.appCutoffBytes = store.getCutoff("app");
  stats.globalCutoffBytes = store.getCutoff(null);
  stats.hasConversationCutoffOverride = store.hasCutoffOverride(convId);
  stats.hasAppCutoffOverride = store.hasCutoffOverride("app");
  stats.cutoffBytes = isLifetimeScope
    ? stats.globalCutoffBytes
    : (isAppScope ? stats.appCutoffBytes : stats.conversationCutoffBytes);

  stats.conversationExemptExtensions = store.getExemptExtensions(convId);
  stats.appExemptExtensions = store.getExemptExtensions("app");
  stats.globalExemptExtensions = store.getExemptExtensions(null);
  stats.exemptExtensions = isLifetimeScope
    ? stats.globalExemptExtensions
    : (isAppScope ? stats.appExemptExtensions : stats.conversationExemptExtensions);

  stats.fileCategories = Object.values(FILE_CATEGORIES);
  stats.conversationExemptCategories = store.getExemptCategories(convId);
  stats.appExemptCategories = store.getExemptCategories("app");
  stats.globalExemptCategories = store.getExemptCategories(null);
  stats.exemptCategories = isLifetimeScope
    ? stats.globalExemptCategories
    : (isAppScope ? stats.appExemptCategories : stats.conversationExemptCategories);

  stats.conversationCustomExtensions = store.getCustomExemptExtensions(convId);
  stats.appCustomExtensions = store.getCustomExemptExtensions("app");
  stats.globalCustomExtensions = store.getCustomExemptExtensions(null);
  stats.customExtensions = isLifetimeScope
    ? stats.globalCustomExtensions
    : (isAppScope ? stats.appCustomExtensions : stats.conversationCustomExtensions);

  // Sandbox preview cap is double cutoff, hard-capped at 8100 B to prevent Antigravity MCP output.txt spills
  const cfgMaxOutputBytes = getEffectiveConfig().maxOutputBytes || 8100;
  stats.sandboxCapBytes = Math.min(
    8100,
    stats.cutoffBytes > 0
      ? stats.cutoffBytes * 2
      : cfgMaxOutputBytes
  );
  stats.isPaused = store.isPaused(targetSid);
  stats.cliFilterEnabled = store.isCliFilterEnabled(targetSid);
  stats.readDedupEnabled = store.isReadDedupEnabled(targetSid);
  stats.ghost = store.getGhostStats(
    targetSid,
    scope === "app" || scope === "session" ? { sinceTs: appStartTime } : {}
  );
  stats.featureRoi = store.getFeatureRoi(
    targetSid,
    scope === "app" || scope === "session" ? { sinceTs: appStartTime } : {}
  );

  stats.version = getPackageVersion();

  return stats;
}

const LATEST_SCAN_TTL_MS = 10000;
let cachedLatestScan = { ts: 0, path: null };
const parsedDiagCache = new Map(); // key -> { mtimeMs, size, ttlSec, diag }

function parseSafeMaxAgeDays(raw, fallback = 14) {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseOptionalPositiveNumber(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function refreshWallClockTtl(diag, explicitTtlSec) {
  const nowMs = Date.now();
  if (!diag || !diag.lastPlannerAt) return diag ? { ...diag, serverNowMs: nowMs } : diag;
  const safeTtl =
    parseOptionalPositiveNumber(explicitTtlSec) ??
    parseOptionalPositiveNumber(diag.cacheTtlSec) ??
    DEFAULT_CACHE_TTL_SEC;
  const lastMs = Date.parse(diag.lastPlannerAt);
  if (!Number.isFinite(lastMs)) return { ...diag, serverNowMs: nowMs };
  const idleSeconds = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  const ttlRemainingSec = Math.max(0, safeTtl - idleSeconds);
  const currentContextTokens = diag.currentContextTokens || 0;
  let ttlStatus = "cold";
  if (currentContextTokens >= MIN_CACHEABLE_CONTEXT_TOKENS) {
    if (idleSeconds >= safeTtl) ttlStatus = "expired";
    else if (ttlRemainingSec <= 60) ttlStatus = "expiring";
    else ttlStatus = "warm";
  }
  const { cacheTemperature, compactAdvice } = computeCacheWarmth({
    currentContextTokens,
    idleSeconds,
    ttlSec: safeTtl,
    weightedHitRate: diag.weightedHitRate || 0,
    criticalTokens: diag.criticalTokens || CONTEXT_CRITICAL_TOKENS,
    coldCompactTokens: diag.coldCompactTokens || 60000,
    delayHotMinTokens: diag.delayHotMinTokens || 30000
  });
  return {
    ...diag,
    cacheTtlSec: safeTtl,
    idleSeconds,
    ttlRemainingSec,
    ttlStatus,
    cacheTemperature,
    compactAdvice,
    serverNowMs: nowMs
  };
}

function getCacheDiagPayload(data, defaultConvId = "default") {
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  const cfg = getEffectiveConfig();
  const rawTtl = data.ttl !== undefined && data.ttl !== "" ? data.ttl : cfg.cacheTtlSec;
  const explicitTtlSec = parseOptionalPositiveNumber(rawTtl);
  const envWindowTokens = parseOptionalPositiveNumber(cfg.windowTokens);
  const envWarnTokens = parseOptionalPositiveNumber(cfg.warnTokens);
  const envCritTokens = parseOptionalPositiveNumber(cfg.criticalTokens);
  const isSpecificConv = scope === "conversation" && convId && convId !== "default" && convId !== "all" && convId !== "app";
  let transcriptPath = null;
  if (isSpecificConv) {
    transcriptPath = isSafeConversationId(convId)
      ? findTranscriptForConversation(convId, { exactOnly: true })
      : null;
  } else {
    const now = Date.now();
    if (now - cachedLatestScan.ts < LATEST_SCAN_TTL_MS && cachedLatestScan.path && fs.existsSync(cachedLatestScan.path)) {
      transcriptPath = cachedLatestScan.path;
    } else {
      transcriptPath = findTranscriptForConversation(null);
      cachedLatestScan = { ts: now, path: transcriptPath };
    }
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const defProfile = resolveModelProfile(null);
    const effectiveWindow = envWindowTokens ?? defProfile.windowTokens;
    const windowSource = envWindowTokens !== undefined ? "explicit" : "profile";
    const ttlSource = explicitTtlSec !== undefined ? "explicit" : "profile";
    return {
      ok: true,
      transcriptFound: false,
      scope,
      conversationId: convId,
      serverNowMs: Date.now(),
      cacheTtlSec: explicitTtlSec ?? defProfile.ttlSec,
      ttlSource,
      maxWarmHitGapSec: null,
      ttlStatus: "cold",
      cacheTemperature: "cold",
      compactAdvice: "none",
      estimatedCostSavingsPct: 0,
      estimatedInputCostUsd: 0,
      estimatedSavedUsd: 0,
      estimatedWastedUsd: 0,
      cacheCreationTokensTotal: 0,
      thinkingTokensTotal: 0,
      cacheWriteMultiplier: defProfile.cacheWriteMultiplier,
      windowSource,
      watermark: "ok",
      warnTokens: envWarnTokens ?? Math.round(effectiveWindow * 0.65),
      criticalTokens: envCritTokens ?? Math.round(effectiveWindow * 0.80),
      contextUtilization: 0,
      modelProfile: {
        id: defProfile.id,
        windowTokens: effectiveWindow,
        windowSource,
        defaultTtlSec: defProfile.ttlSec,
        cacheDiscountRate: defProfile.cacheDiscountRate,
        inputPer1M: defProfile.inputPer1M,
        cacheWriteMultiplier: defProfile.cacheWriteMultiplier,
        cacheWrite1hMultiplier: defProfile.cacheWrite1hMultiplier
      },
      weightedHitRate: 0,
      avgTurnHitRate: 0,
      currentContextTokens: 0,
      peakContextTokens: 0,
      bustCount: 0,
      bustsByCause: {
        ttl_idle_expiry: 0,
        model_switch: 0,
        compaction_or_truncation: 0,
        system_injection: 0,
        multimodal_media: 0,
        prefix_drift: 0
      },
      wastedTokensTotal: 0,
      duplicateReadCount: 0,
      loopWatch: {
        status: "ok",
        windowSize: 0,
        repeatRate: 0,
        maxRepeatCount: 0,
        topRepeatedCall: null,
        editFailOscillations: 0,
        oscillatingFiles: [],
        reason: null
      },
      contextComposition: createEmptyContextComposition(),
      subagentBreakdown: createEmptySubagentBreakdown(),
      recentTurns: [],
      topContextDeltas: []
    };
  }
  try {
    const st = fs.statSync(transcriptPath);
    const cacheKey = `${transcriptPath}:${explicitTtlSec ?? "auto"}:${envWindowTokens ?? ""}:${envWarnTokens ?? ""}:${envCritTokens ?? ""}`;
    const cached = parsedDiagCache.get(cacheKey);
    let diag;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      diag = refreshWallClockTtl(cached.diag, explicitTtlSec);
    } else {
      const steps =
        st.size <= 2 * 1024 * 1024
          ? parseTranscriptLines(fs.readFileSync(transcriptPath, "utf8"))
          : readTranscriptTail(transcriptPath, 524288);
      const nowMs = Date.now();
      const diagOpts = { nowMs };
      if (explicitTtlSec !== undefined) diagOpts.ttlSec = explicitTtlSec;
      if (envWindowTokens !== undefined) diagOpts.windowTokens = envWindowTokens;
      if (envWarnTokens !== undefined) diagOpts.warnTokens = envWarnTokens;
      if (envCritTokens !== undefined) diagOpts.criticalTokens = envCritTokens;
      diag = analyzeTranscriptCache(steps, diagOpts);
      if (parsedDiagCache.size > 16) parsedDiagCache.clear();
      parsedDiagCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, ttlSec: explicitTtlSec, diag });
      diag = { ...diag, serverNowMs: nowMs };
    }
    return {
      ok: true,
      transcriptFound: true,
      scope,
      conversationId: convId,
      ...diag,
      contextComposition: diag.contextComposition ?? createEmptyContextComposition(),
      subagentBreakdown: diag.subagentBreakdown ?? createEmptySubagentBreakdown(),
      serverNowMs: diag.serverNowMs ?? Date.now()
    };
  } catch (err) {
    return {
      ok: false,
      transcriptFound: false,
      serverNowMs: Date.now(),
      contextComposition: createEmptyContextComposition(),
      subagentBreakdown: createEmptySubagentBreakdown(),
      error: err?.message || String(err)
    };
  }
}

function collectKnownWorktrees(store, sessionId = "default", sinceTs = null) {
  if (!store) return [];
  const roots = new Set();
  try {
    if (typeof store.open === "function") store.open();
    if (!store.db) return [];
    const sid = sessionId || "default";
    const isAll = sid === "all" || sid === "lifetime";
    const isApp = sid === "app" && sinceTs !== null && sinceTs !== undefined && Number.isFinite(Number(sinceTs));
    const sinceNum = isApp ? Number(sinceTs) : null;
    const sinceIso = isApp ? new Date(sinceNum).toISOString() : null;

    const queries = [
      () =>
        isAll
          ? store.db
              .prepare("SELECT DISTINCT worktree FROM session_checkpoints WHERE worktree != '' ORDER BY updated_ts DESC LIMIT 20")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT DISTINCT worktree FROM session_checkpoints WHERE worktree != '' AND updated_ts >= ? ORDER BY updated_ts DESC LIMIT 20")
                .all(sinceNum)
            : store.db
                .prepare("SELECT DISTINCT worktree FROM session_checkpoints WHERE session_id = ? AND worktree != '' LIMIT 10")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT DISTINCT worktree FROM sources WHERE worktree != '' ORDER BY created_ts DESC LIMIT 20")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT DISTINCT worktree FROM sources WHERE worktree != '' AND (created_ts >= ? OR created_at >= ?) ORDER BY created_ts DESC LIMIT 20")
                .all(sinceNum, sinceIso)
            : store.db
                .prepare("SELECT DISTINCT worktree FROM sources WHERE session_id = ? AND worktree != '' ORDER BY created_ts DESC LIMIT 20")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT DISTINCT worktree FROM events WHERE worktree != '' ORDER BY seq DESC LIMIT 20")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT DISTINCT worktree FROM events WHERE worktree != '' AND created_at >= ? ORDER BY seq DESC LIMIT 20")
                .all(sinceIso)
            : store.db
                .prepare("SELECT DISTINCT worktree FROM events WHERE session_id = ? AND worktree != '' ORDER BY seq DESC LIMIT 20")
                .all(sid)
    ];

    for (const run of queries) {
      try {
        for (const row of run() || []) {
          if (row?.worktree && typeof row.worktree === "string") {
            const raw = row.worktree.trim();
            if (!raw || raw.includes("\0") || isUncPath(raw) || !path.isAbsolute(raw)) {
              continue;
            }
            const resolved = path.resolve(raw);
            if (!isUncPath(resolved) && !isUnsafeBroadRoot(resolved)) {
              roots.add(resolved);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return Array.from(roots);
}

function isFilesystemRoot(dirPath) {
  const resolved = path.resolve(dirPath);
  const root = path.parse(resolved).root;
  if (!root) return false;
  return process.platform === "win32"
    ? resolved.toLowerCase() === root.toLowerCase()
    : resolved === root;
}

function isPathInsideRoot(candidatePath, rootPath) {
  const normCand = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  const normRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const rel = path.relative(normRoot, normCand);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

function resolveCanonicalPath(p) {
  const real = typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(p)
    : fs.realpathSync(p);
  if (process.platform === "win32") {
    const driveMatch = real.match(/^\\\\\?\\([a-zA-Z]:\\.*)$/);
    if (driveMatch) return driveMatch[1];
  }
  return real;
}

function isUnsafeBroadRoot(dirPath) {
  if (isUncPath(dirPath)) return true;
  if (isFilesystemRoot(dirPath)) return true;
  const resolved = path.resolve(dirPath);
  if (isUncPath(resolved)) return true;
  let realResolved = resolved;
  try {
    realResolved = resolveCanonicalPath(resolved);
    if (isUncPath(realResolved) || isFilesystemRoot(realResolved)) return true;
  } catch {}
  const home = path.resolve(os.homedir());
  let realHome = home;
  try {
    realHome = resolveCanonicalPath(home);
  } catch {}
  // Reject os.homedir() itself and any ancestor directory of os.homedir() (e.g. C:\Users, /Users, /home),
  // including Windows 8.3 short-name aliases (e.g. C:\Users\ADMINI~1)
  return (
    isPathInsideRoot(home, resolved) ||
    isPathInsideRoot(realHome, resolved) ||
    isPathInsideRoot(home, realResolved) ||
    isPathInsideRoot(realHome, realResolved)
  );
}

/**
 * Strictly whitelist explicit `cwd` parameters for `/api/handoff` against known workspace roots
 * recorded in SQLite. Blocks UNC paths (including Windows mixed-slash UNC `/\host\share`), relative paths,
 * filesystem roots, home/ancestor directories, arbitrary external directories, and symlink/junction escapes
 * before touching the filesystem or spawning `git`.
 */
export function resolveAllowedHandoffCwd(rawCwd, knownRoots = []) {
  if (typeof rawCwd !== "string") return "";
  const trimmed = rawCwd.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  if (isUncPath(trimmed)) return "";
  if (!path.isAbsolute(trimmed)) return "";
  const resolvedCandidate = path.resolve(trimmed);
  if (isUncPath(resolvedCandidate) || isUnsafeBroadRoot(resolvedCandidate)) return "";

  for (const rawRoot of knownRoots) {
    if (!rawRoot || typeof rawRoot !== "string") continue;
    const trimmedRoot = rawRoot.trim();
    if (!trimmedRoot || trimmedRoot.includes("\0") || isUncPath(trimmedRoot)) {
      continue;
    }
    if (!path.isAbsolute(trimmedRoot)) continue;
    const resolvedRoot = path.resolve(trimmedRoot);
    if (isUncPath(resolvedRoot) || isUnsafeBroadRoot(resolvedRoot)) continue;
    const mayBeWinShortAlias =
      process.platform === "win32" && (resolvedCandidate.includes("~") || resolvedRoot.includes("~"));
    if (!isPathInsideRoot(resolvedCandidate, resolvedRoot) && !mayBeWinShortAlias) continue;
    try {
      const canonicalRoot = resolveCanonicalPath(resolvedRoot);
      if (isUncPath(canonicalRoot) || isUnsafeBroadRoot(canonicalRoot)) continue;
      const canonicalCand = resolveCanonicalPath(resolvedCandidate);
      if (isUncPath(canonicalCand) || isUnsafeBroadRoot(canonicalCand)) continue;
      if (isPathInsideRoot(canonicalCand, canonicalRoot) && fs.statSync(canonicalCand).isDirectory()) {
        return fs.realpathSync(resolvedCandidate);
      }
    } catch {
      // Unresolvable or non-directory -> reject
    }
  }
  return "";
}

function getResumePayload(data = {}, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  if (scope === "lifetime" || scope === "all") return store.getResumeState("all", 10);
  if (scope === "app" || scope === "session") return store.getResumeState("app", 10, { sinceTs: appStartTime });
  return store.getResumeState(convId, 10);
}

function getSourceChunksPayload(data = {}) {
  const store = getRuntimeStore();
  if (typeof data.sourceId !== "string" || !data.sourceId.trim()) {
    return { ok: false, sourceId: null, chunks: [] };
  }
  const sourceId = data.sourceId;
  return { ok: true, sourceId, chunks: store.getSourceChunks(sourceId) };
}

function getHandoffPayload(data = {}, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const { scope, convId, targetSid } = resolveTargetSession(data, defaultConvId);
  const sinceTs = scope === "app" || scope === "session" ? appStartTime : null;
  const rawCwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
  const cwd = rawCwd
    ? resolveAllowedHandoffCwd(rawCwd, collectKnownWorktrees(store, targetSid, sinceTs))
    : inferWorkspaceFromStore(store, targetSid, sinceTs);
  const rawMaxBytes = parseOptionalPositiveNumber(data.maxBytes);
  const maxBytes = rawMaxBytes !== undefined
    ? Math.min(16384, Math.max(256, Math.floor(rawMaxBytes)))
    : 5800;
  let cacheDiag = null;
  try {
    const diag = getCacheDiagPayload(data, defaultConvId);
    if (diag && diag.ok && diag.transcriptFound) {
      cacheDiag = diag;
    }
  } catch {}
  const brief = buildHandoffBrief({
    store,
    sessionId: targetSid,
    cwd,
    cacheDiag,
    maxBytes,
    sinceTs
  });
  return {
    ok: true,
    scope,
    conversationId: convId,
    sessionId: targetSid,
    markdown: brief.markdown,
    summary: brief.summary,
    bytes: brief.bytes,
    truncated: brief.truncated
  };
}

export function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(String(p));
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/**
 * Only allow SidecarApp mode when ANTIGRAVITY_SIDECAR_UI_TOKEN is explicitly non-empty
 * (sidecar_sdk fails open on authentication when its token is empty/missing).
 */
export function shouldUseSidecarApp(env = process.env, hasSidecarApp = true) {
  return Boolean(
    hasSidecarApp &&
      typeof env?.ANTIGRAVITY_LS_ADDRESS === "string" && env.ANTIGRAVITY_LS_ADDRESS.trim() &&
      typeof env?.ANTIGRAVITY_CSRF_TOKEN === "string" && env.ANTIGRAVITY_CSRF_TOKEN.trim() &&
      typeof env?.ANTIGRAVITY_SIDECAR_WEB_PORT === "string" && env.ANTIGRAVITY_SIDECAR_WEB_PORT.trim() &&
      typeof env?.ANTIGRAVITY_SIDECAR_UI_TOKEN === "string" && env.ANTIGRAVITY_SIDECAR_UI_TOKEN.trim() &&
      env?.SIDECAR_FORCE_HTTP !== "1"
  );
}

/**
 * Resolve standalone HTTP port: prefer explicit PORT, then host-assigned
 * ANTIGRAVITY_SIDECAR_WEB_PORT (so fail-closed sidecar fallback doesn't collide on 8765),
 * and finally default to 8765.
 */
export function resolveStandalonePort(env = process.env) {
  for (const raw of [env?.PORT, env?.ANTIGRAVITY_SIDECAR_WEB_PORT]) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 65535) {
      return raw === 0 ? 0 : raw;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
          return parsed;
        }
      }
    }
  }
  return 8765;
}

const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));

function handleCutoffMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid, convId } = resolveTargetSession(data, defaultConvId);
  const cutoffBytes = data.cutoff === "none" || data.cutoff === 0 || data.cutoff === "0" ? 0 : parseInt(data.cutoff, 10);
  const saved = store.setCutoff(cutoffBytes, targetSid);
  return {
    ok: true,
    cutoffBytes: saved,
    scope,
    sessionId: targetSid,
    globalCutoffBytes: store.getCutoff(null),
    appCutoffBytes: store.getCutoff("app"),
    conversationCutoffBytes: store.getCutoff(convId)
  };
}

function handleExemptionsMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const action = data.action || "get";
  if (action === "toggleCategory" && data.category) {
    store.toggleExemptCategory(
      data.category,
      data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : null,
      targetSid
    );
  } else if (action === "setCategories" && Array.isArray(data.categories)) {
    store.setExemptCategories(data.categories, targetSid);
  } else if (action === "add" && data.ext) {
    store.addCustomExemptExtension(data.ext, targetSid);
  } else if (action === "remove" && data.ext) {
    store.removeCustomExemptExtension(data.ext, targetSid);
  } else if (action === "reset") {
    store.setExemptCategories(null, targetSid);
    store.setCustomExemptExtensions([], targetSid);
  } else if (action === "set" && Array.isArray(data.extensions)) {
    store.setExemptExtensions(data.extensions, targetSid);
  }
  return {
    ok: true,
    exemptCategories: store.getExemptCategories(targetSid),
    customExtensions: store.getCustomExemptExtensions(targetSid),
    exemptExtensions: store.getExemptExtensions(targetSid),
    scope,
    sessionId: targetSid
  };
}

function handleToggleActiveMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const current = store.isPaused(targetSid);
  const newPaused =
    data.paused !== undefined ? (data.paused === true || data.paused === "true" || data.paused === "1") : !current;
  const saved = store.setPaused(newPaused, targetSid);
  return { ok: true, isPaused: saved, scope, sessionId: targetSid };
}

function handlePurgeMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  if (scope === "lifetime" || scope === "all") {
    return store.purge({ scope: "all" });
  } else if (scope === "app" || scope === "session") {
    return store.purge({ scope: "app", sinceTs: appStartTime });
  }
  return store.purge({ scope: "conversation", sessionId: convId });
}

function handleMaintenanceMutation(data) {
  const store = getRuntimeStore();
  const action = data.action || "prune";
  const maxAgeDays = parseSafeMaxAgeDays(data.maxAgeDays, 14);
  const vacuum = action === "vacuum" || data.vacuum === true || data.vacuum === "true" || data.vacuum === "1";
  return store.pruneByTtl({ maxAgeDays, vacuum });
}

function handleFeatureToggleMutation(isCli, data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const cur = isCli ? store.isCliFilterEnabled(targetSid) : store.isReadDedupEnabled(targetSid);
  const next = data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
  const saved = isCli ? store.setCliFilterEnabled(next, targetSid) : store.setReadDedupEnabled(next, targetSid);
  return { ok: true, [isCli ? "cliFilterEnabled" : "readDedupEnabled"]: saved, scope, sessionId: targetSid };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

const READ_ENDPOINTS = new Set([
  "/api/stats",
  "/api/doctor",
  "/api/resume",
  "/api/source-chunks",
  "/api/cache-diag",
  "/api/handoff"
]);

const MUTATING_ENDPOINTS = new Set([
  "/api/cutoff",
  "/api/exemptions",
  "/api/toggle-active",
  "/api/paused",
  "/api/purge",
  "/api/maintenance",
  "/api/cli-filter",
  "/api/read-dedup"
]);

export function createStandaloneServer({
  csrfToken = crypto.randomBytes(24).toString("hex"),
  maxBodyBytes = MAX_REQUEST_BODY_BYTES
} = {}) {
  getRuntimeStore();
  return http.createServer(async (req, res) => {
    try {
      // 1. Anti-DNS-rebinding Host validation & anti-CSRF Origin/Sec-Fetch-Site validation
      if (!isAllowedHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: "Forbidden host header" });
        return;
      }

      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host}`);
      } catch {
        sendJson(res, 400, { error: "Invalid request URL" });
        return;
      }

      const isHtmlEntry = req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
      if (
        !isAllowedOriginHeader(req.headers.origin, req.headers.host) ||
        isCrossSiteFetchHeader(req.headers["sec-fetch-site"], { allowSameSite: isHtmlEntry })
      ) {
        sendJson(res, 403, { error: "Cross-origin request blocked" });
        return;
      }

      if (isHtmlEntry) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "Cache-Control": "no-store"
        });
        res.end(getRenderedHtml(csrfToken));
        return;
      }

      // 2. Enforce POST-only method semantics on /api/search and mutating endpoints first
      //    so cross-site <img> GET attacks explicitly return 405 Method Not Allowed (Allow: POST).
      if ((url.pathname === "/api/search" || MUTATING_ENDPOINTS.has(url.pathname)) && req.method !== "POST") {
        sendJson(
          res,
          405,
          {
            error:
              url.pathname === "/api/search"
                ? "Method Not Allowed: use POST with application/json"
                : "Method Not Allowed: mutating endpoints require POST"
          },
          { Allow: "POST" }
        );
        return;
      }

      // 3. Require per-server random X-Agy-Dart-Token on EVERY standalone /api/* endpoint (GET and POST)
      if (url.pathname.startsWith("/api/")) {
        if (!timingSafeTokenMatch(req.headers["x-agy-dart-token"], csrfToken)) {
          sendJson(res, 403, { error: "Invalid or missing X-Agy-Dart-Token" });
          return;
        }
      }

      // 4. Authenticated read-only API endpoints (POST JSON used by UI + authenticated GET with X-Agy-Dart-Token)
      if (READ_ENDPOINTS.has(url.pathname)) {
        if (req.method !== "GET" && req.method !== "POST") {
          sendJson(res, 405, { error: "Method Not Allowed: use POST with application/json" }, { Allow: "POST, GET" });
          return;
        }
        let data = Object.fromEntries(url.searchParams.entries());
        if (req.method === "POST") {
          if (!isJsonContentType(req.headers["content-type"])) {
            sendJson(res, 415, { error: "Content-Type must be application/json" });
            return;
          }
          const parsed = await readBoundedJsonBody(req, maxBodyBytes);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { error: parsed.error }, parsed.status === 413 ? { Connection: "close" } : {});
            return;
          }
          data = { ...data, ...parsed.data };
        }
        const fieldCheck = validateStringFields(data, ["scope", "conversationId", "sessionId", "sourceId", "cwd"]);
        if (!fieldCheck.ok) {
          sendJson(res, 400, { error: fieldCheck.error });
          return;
        }
        if (url.pathname === "/api/stats") {
          sendJson(res, 200, getStatsPayload(data));
          return;
        }
        if (url.pathname === "/api/doctor") {
          sendJson(res, 200, getRuntimeStore().doctor());
          return;
        }
        if (url.pathname === "/api/resume") {
          sendJson(res, 200, getResumePayload(data));
          return;
        }
        if (url.pathname === "/api/source-chunks") {
          sendJson(res, 200, getSourceChunksPayload(data));
          return;
        }
        if (url.pathname === "/api/cache-diag") {
          sendJson(res, 200, getCacheDiagPayload(data));
          return;
        }
        if (url.pathname === "/api/handoff") {
          sendJson(res, 200, getHandoffPayload(data));
          return;
        }
      }

      // 5. POST-only /api/search (authenticated read-only FTS5 query, bounded JSON body)
      if (url.pathname === "/api/search") {
        if (!isJsonContentType(req.headers["content-type"])) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const parsed = await readBoundedJsonBody(req, maxBodyBytes);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error }, parsed.status === 413 ? { Connection: "close" } : {});
          return;
        }
        const searchCheck = validateAndNormalizeSearchInput(parsed.data);
        if (!searchCheck.ok) {
          sendJson(res, 400, { error: searchCheck.error });
          return;
        }
        const searchFieldCheck = validateStringFields(parsed.data, ["sourceId", "conversationId", "sessionId", "scope"]);
        if (!searchFieldCheck.ok) {
          sendJson(res, 400, { error: searchFieldCheck.error });
          return;
        }
        sendJson(res, 200, getRuntimeStore().search({ queries: searchCheck.queries, limit: 5 }));
        return;
      }

      // 6. Mutating endpoints: strictly POST + application/json + per-server CSRF token + <= 64 KB body
      if (MUTATING_ENDPOINTS.has(url.pathname)) {
        if (!isJsonContentType(req.headers["content-type"])) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const parsed = await readBoundedJsonBody(req, maxBodyBytes);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error }, parsed.status === 413 ? { Connection: "close" } : {});
          return;
        }
        const data = parsed.data;
        const mutFieldCheck = validateStringFields(data, ["scope", "conversationId", "sessionId", "action", "category", "ext"]);
        if (!mutFieldCheck.ok) {
          sendJson(res, 400, { error: mutFieldCheck.error });
          return;
        }
        if (url.pathname === "/api/cutoff") {
          sendJson(res, 200, handleCutoffMutation(data));
        } else if (url.pathname === "/api/toggle-active" || url.pathname === "/api/paused") {
          sendJson(res, 200, handleToggleActiveMutation(data));
        } else if (url.pathname === "/api/exemptions") {
          sendJson(res, 200, handleExemptionsMutation(data));
        } else if (url.pathname === "/api/purge") {
          sendJson(res, 200, handlePurgeMutation(data));
        } else if (url.pathname === "/api/maintenance") {
          sendJson(res, 200, handleMaintenanceMutation(data));
        } else if (url.pathname === "/api/cli-filter" || url.pathname === "/api/read-dedup") {
          sendJson(res, 200, handleFeatureToggleMutation(url.pathname === "/api/cli-filter", data));
        }
        return;
      }

      res.writeHead(404, { "X-Content-Type-Options": "nosniff" });
      res.end("Not Found");
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}

if (isDirectRun) {
  let SidecarApp = null;
  let SidecarResponse = null;

  try {
    const userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
    const sdkModule = await import(pathToFileURL(userSdkPath).href);
    SidecarApp = sdkModule.SidecarApp;
    SidecarResponse = sdkModule.Response || null;
  } catch {
    try {
      const sdkModule = await import("sidecar_sdk");
      SidecarApp = sdkModule.SidecarApp;
      SidecarResponse = sdkModule.Response || null;
    } catch {
      // Standalone fallback
    }
  }

  const isSidecarEnv = shouldUseSidecarApp(process.env, Boolean(SidecarApp));

  if (
    !isSidecarEnv &&
    SidecarApp &&
    typeof process.env.ANTIGRAVITY_LS_ADDRESS === "string" && process.env.ANTIGRAVITY_LS_ADDRESS.trim() &&
    typeof process.env.ANTIGRAVITY_CSRF_TOKEN === "string" && process.env.ANTIGRAVITY_CSRF_TOKEN.trim() &&
    typeof process.env.ANTIGRAVITY_SIDECAR_WEB_PORT === "string" && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT.trim() &&
    process.env.SIDECAR_FORCE_HTTP !== "1" &&
    !(typeof process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN === "string" && process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN.trim())
  ) {
    console.error(
      "[agy-dart sidecar] ANTIGRAVITY_SIDECAR_UI_TOKEN is missing/empty; refusing fail-open SidecarApp mode and falling back to authenticated standalone HTTP server."
    );
  }

  if (isSidecarEnv) {
    getRuntimeStore();
    const app = new SidecarApp();

    const makeBadRequest = (error) =>
      SidecarResponse
        ? new SidecarResponse(JSON.stringify({ error }), { contentType: "application/json", status: 400 })
        : { ok: false, error };

    app.page("/", () => {
      const html = getRenderedHtml(SIDECAR_CSRF_TOKEN);
      if (SidecarResponse) {
        return new SidecarResponse(html, {
          contentType: "text/html; charset=utf-8",
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
      return html;
    });

    // ALL /api/* routes are POST-only in SidecarApp mode because sidecar_sdk only enforces
    // X-Sidecar-Token validation for non-GET requests (blocks unauthenticated GET / DNS-rebinding reads).
    app.api("/api/stats", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return getStatsPayload(data, app.config.conversationId);
    }, "POST");
    app.api("/api/doctor", () => getRuntimeStore().doctor(), "POST");
    app.api("/api/resume", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return getResumePayload(data, app.config.conversationId);
    }, "POST");
    app.api("/api/source-chunks", (data) => {
      const check = validateStringFields(data, ["sourceId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return getSourceChunksPayload(data);
    }, "POST");
    app.api("/api/cache-diag", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return getCacheDiagPayload(data, app.config.conversationId);
    }, "POST");
    app.api("/api/handoff", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId", "cwd"]);
      if (!check.ok) return makeBadRequest(check.error);
      return getHandoffPayload(data, app.config.conversationId);
    }, "POST");

    app.api("/api/search", (data) => {
      const searchCheck = validateAndNormalizeSearchInput(data);
      if (!searchCheck.ok) return makeBadRequest(searchCheck.error);
      const fieldCheck = validateStringFields(data, ["sourceId", "conversationId", "sessionId", "scope"]);
      if (!fieldCheck.ok) return makeBadRequest(fieldCheck.error);
      return getRuntimeStore().search({ queries: searchCheck.queries, limit: 5 });
    }, "POST");
    app.api("/api/cutoff", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handleCutoffMutation(data, app.config.conversationId);
    }, "POST");
    app.api("/api/exemptions", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId", "action", "category", "ext"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handleExemptionsMutation(data, app.config.conversationId);
    }, "POST");
    app.api("/api/toggle-active", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handleToggleActiveMutation(data, app.config.conversationId);
    }, "POST");
    app.api("/api/paused", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handleToggleActiveMutation(data, app.config.conversationId);
    }, "POST");
    app.api("/api/purge", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handlePurgeMutation(data, app.config.conversationId);
    }, "POST");
    app.api("/api/maintenance", (data) => handleMaintenanceMutation(data), "POST");
    app.api("/api/cli-filter", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handleFeatureToggleMutation(true, data, app.config.conversationId);
    }, "POST");
    app.api("/api/read-dedup", (data) => {
      const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
      if (!check.ok) return makeBadRequest(check.error);
      return handleFeatureToggleMutation(false, data, app.config.conversationId);
    }, "POST");

    await app.run();
    console.log(`[agy-dart sidecar] registered and running`);
  } else {
    const port = resolveStandalonePort(process.env);
    const server = createStandaloneServer();
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[agy-dart dashboard] standalone server listening at http://127.0.0.1:${boundPort}`);
    });
  }
}
