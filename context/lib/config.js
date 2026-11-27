/**
 * Unified configuration loader for agy-dart (~/.agy-dart/config.json) with
 * full environment-variable overrides (AGY_DART_* always takes precedence).
 *
 * Strictly zero-dependency and fail-open: missing or malformed config files
 * never break hooks or MCP servers and are surfaced cleanly via `doctor`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DEFAULTS = Object.freeze({
  dbPath: null,
  defaultCwd: null,
  compileCache: true,
  compileCacheDir: null,
  stablePrefixOnly: false,
  subagentIncludeGit: false,
  repoHubs: true,
  readHook: true,
  readGuardMode: "soft",
  readDedup: true,
  readDedupMaxSteps: 40,
  readDedupMaxTurns: 12,
  readDedupMinBytes: 4096,
  diffRead: false, // Opt-in until multi-turn/fork baseline freshness is battle-tested
  diffReadMaxTurns: 12,
  diffReadMaxAgeMs: 15 * 60 * 1000,
  maxReadBytes: null,
  inlineOutlineMaxBytes: 524288,
  noiseMaxReadBytes: 16384,
  reviewMaxReadBytes: 131072,
  shellDumpMaxBytes: 16384,
  exemptExtensions: Object.freeze([]),
  exemptPaths: Object.freeze([]),
  maxLineRange: null,
  maxOutputBytes: 8100,
  execTimeoutMs: 120000,
  execEnvAllowlist: Object.freeze([]),
  cliFilter: true,
  cliFilterAsyncBypassMs: 2000,
  outlineDb: true,
  searchCacheTtlMs: 15000,
  cacheWatch: true,
  // Opt-in only until Antigravity fixes upstream ScrubInternalFields map<string, string> panic (#1394 / #1845)
  cacheWatchInlineAlerts: false,
  cacheTtlSec: null,
  windowTokens: null,
  warnTokens: null,
  criticalTokens: null,
  secretRedaction: true,
  sensitiveFileGuard: "off",
  allowPrivateUrls: false,
  stallWatchdog: true,
  watchdogPollMs: 5000,
  watchdogSuspectRatio: 0.6,
  watchdogLlmLowSec: 120,
  watchdogLlmHighSec: 240,
  watchdogLlmMultimodalSec: 360,
  watchdogLlmReasoningSec: 600,
  watchdogLlmCompoundSec: 900,
  watchdogToolCmdSec: 300,
  watchdogToolFastSec: 90,
  watchdogSubagentSec: 1200,
  watchdogDesktopNotify: false,
  watchdogNotifyCooldownSec: 300,
  ttlDesktopNotify: false,
  ttlNotifyLeadSec: 60,
  ttlNotifyMinTokens: 60000,
  ttlKeepalive: false,
  ttlKeepaliveMaxCount: 1,
  ttlKeepaliveIntervalSec: 0,
  ttlKeepaliveLeadSec: 60,
  ttlKeepaliveMinRemainSec: 15,
  ttlKeepaliveMinContextPct: 15,
  ttlKeepaliveMinTokens: 0,
  watermarkDesktopNotify: null,
  toolLoading: "fast-eager",
  autoUpdateCheck: true,
  autoUpdateInstall: false,
  safetyAudit: true,
  safetyDesktopNotify: false,
  safetyLogPaths: Object.freeze([]),
  safetyStatePath: null,
  safetyWindowHours: 5,
  safetyPrecheckWarnCount: 3500,
  safetyPrecheckLimit: 4400,
  safetyHeavyBurstCount: 3,
  safetyHeavyBurstWindowMin: 5,
  safetyStickyCharThreshold: 150000,
  uiLang: "en"
});

let cachedFileState = {
  path: null,
  exists: false,
  mtimeMs: -1,
  size: -1,
  data: null,
  error: null
};

let activeScopedSnapshot = null;
let configStatCount = 0;

export function getConfigStatCount() {
  return configStatCount;
}

export function getConfigPath(env = process.env) {
  const custom = typeof env?.AGY_DART_CONFIG_PATH === "string" ? env.AGY_DART_CONFIG_PATH.trim() : "";
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".agy-dart", "config.json");
}

function parseEnvBool(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return undefined;
}

function parseDisableEnvFlag(raw) {
  const b = parseEnvBool(raw);
  return b === undefined ? undefined : !b;
}

function parsePositiveNumber(raw) {
  if (raw === undefined || raw === null || typeof raw === "boolean") return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parsePositiveInt(raw) {
  const n = parsePositiveNumber(raw);
  if (n === undefined) return undefined;
  const floored = Math.floor(n);
  return floored >= 1 ? floored : undefined;
}

function parseNonNegativeInt(raw) {
  if (raw === undefined || raw === null || typeof raw === "boolean") return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function clampInt(n, min, max) {
  if (n === undefined) return undefined;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseRatio(raw, min = 0.25, max = 0.95) {
  const n = parsePositiveNumber(raw);
  if (n === undefined) return undefined;
  return Math.min(max, Math.max(min, Number(n.toFixed(3))));
}

function parseGuardMode(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === "deny" || s === "block" || s === "strict") return "deny";
  if (s === "warn" || s === "1" || s === "true" || s === "remind") return "warn";
  if (s === "off" || s === "0" || s === "false" || s === "none") return "off";
  return undefined;
}

export function parseUiLang(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (s === "zh" || s === "cn" || s.startsWith("zh-") || s.startsWith("zh_")) return "zh";
  if (s === "en" || s.startsWith("en-") || s.startsWith("en_")) return "en";
  return undefined;
}

export function parseToolLoading(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (s === "fast-eager" || s === "fast_eager" || s === "fasteager" || s === "hybrid" || s === "default") {
    return "fast-eager";
  }
  if (s === "lazy" || s === "on-demand" || s === "ondemand") return "lazy";
  if (s === "eager" || s === "all-eager" || s === "alleager" || s === "all") return "eager";
  return undefined;
}

function parseReadGuardMode(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (s === "soft" || s === "2-strike" || s === "warn" || s === "balanced") return "soft";
  if (s === "strict" || s === "hard" || s === "deny" || s === "block") return "strict";
  if (s === "off" || s === "disabled" || s === "none" || s === "0" || s === "false") return "off";
  return undefined;
}

function parseExemptExtensions(raw) {
  if (raw === undefined || raw === null) return undefined;
  let items;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    items = trimmed.split(/[,;\s]+/);
  } else {
    return undefined;
  }
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const clean = item.trim().toLowerCase();
    if (!clean) continue;
    const formatted = clean.startsWith(".") ? clean : `.${clean}`;
    if (!/^\.[a-z0-9][a-z0-9._+-]{0,31}$/i.test(formatted)) continue;
    if (!seen.has(formatted)) {
      seen.add(formatted);
      out.push(formatted);
      if (out.length >= 128) break;
    }
  }
  return out;
}

function parseExemptPaths(raw) {
  if (raw === undefined || raw === null) return undefined;
  let items;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    items = trimmed.split(/[,;\r\n]+/);
  } else {
    return undefined;
  }
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string") continue;
    let clean = item.trim().replace(/\\/g, "/");
    if (!clean || clean.length > 256 || /[\x00-\x1f\x7f]/.test(clean)) continue;
    while (clean.startsWith("./")) clean = clean.slice(2);
    clean = clean.replace(/\/{2,}/g, "/");
    if (!clean) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
      if (out.length >= 64) break;
    }
  }
  return out;
}

function parseSafetyLogPaths(raw) {
  if (raw === undefined || raw === null) return undefined;
  let items;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    // On Windows use `;` or newline (preserve drive colons like D:\...); on POSIX also allow `:`
    const sepRe = process.platform === "win32" ? /[;\r\n]+/ : /[:;\r\n]+/;
    items = trimmed.split(sepRe);
  } else {
    return undefined;
  }
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean || clean.length > 512 || /[\x00-\x1f\x7f]/.test(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
      if (out.length >= 16) break;
    }
  }
  return out;
}

function parseEnvNameList(raw) {
  if (raw === undefined || raw === null) return undefined;
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    items = trimmed.split(/[\s,;]+/);
  } else {
    return undefined;
  }
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(clean)) continue;
    const key = process.platform === "win32" ? clean.toUpperCase() : clean;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
      if (out.length >= 64) break;
    }
  }
  return out;
}

export function loadConfigFile(configPath = getConfigPath()) {
  const resolved = path.resolve(configPath);
  let stat;
  try {
    configStatCount += 1;
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      cachedFileState = { path: resolved, exists: false, mtimeMs: -1, size: -1, data: {}, error: null };
      return { exists: false, data: {}, error: null, path: resolved };
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    cachedFileState = { path: resolved, exists: true, mtimeMs: -1, size: -1, data: {}, error: errMsg };
    return { exists: true, data: {}, error: errMsg, path: resolved };
  }
  try {
    if (
      cachedFileState.path === resolved &&
      cachedFileState.exists &&
      cachedFileState.mtimeMs === stat.mtimeMs &&
      cachedFileState.size === stat.size
    ) {
      return {
        exists: true,
        data: cachedFileState.data || {},
        error: cachedFileState.error,
        path: resolved
      };
    }
    const raw = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const errMsg = "config.json root must be a JSON object";
      cachedFileState = { path: resolved, exists: true, mtimeMs: stat.mtimeMs, size: stat.size, data: {}, error: errMsg };
      return { exists: true, data: {}, error: errMsg, path: resolved };
    }
    cachedFileState = { path: resolved, exists: true, mtimeMs: stat.mtimeMs, size: stat.size, data: parsed, error: null };
    return { exists: true, data: parsed, error: null, path: resolved };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    cachedFileState = { path: resolved, exists: true, mtimeMs: -1, size: -1, data: {}, error: errMsg };
    return { exists: true, data: {}, error: errMsg, path: resolved };
  }
}

export function resetConfigCache() {
  cachedFileState = { path: null, exists: false, mtimeMs: -1, size: -1, data: null, error: null };
  activeScopedSnapshot = null;
}

/**
 * Execute a synchronous callback with a single shared config snapshot so repeated
 * `getConfigSnapshot()` / `getEffectiveConfig()` lookups inside one tick or request
 * reuse the same snapshot without repeating `fs.statSync` on `config.json`.
 * Lazy by default: performs 0 stats if the callback never reads default config.
 */
export function withConfigSnapshot(optionsOrFn, maybeFn) {
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  const opts =
    typeof optionsOrFn === "function"
      ? {}
      : optionsOrFn && typeof optionsOrFn === "object"
        ? optionsOrFn
        : {};
  if (typeof fn !== "function") {
    throw new TypeError("withConfigSnapshot requires a callback function");
  }
  const isPrebuiltSnap = Boolean(
    opts &&
      typeof opts.configPath === "string" &&
      opts.values &&
      typeof opts.values === "object" &&
      opts.sources &&
      typeof opts.sources === "object"
  );
  const env = isPrebuiltSnap ? process.env : opts.env || process.env;
  if (!isPrebuiltSnap && !opts.fresh && !opts.configPath && activeScopedSnapshot && activeScopedSnapshot.env === env) {
    return fn(activeScopedSnapshot.snapshot);
  }
  const prev = activeScopedSnapshot;
  const scope = isPrebuiltSnap
    ? { env, configPath: opts.configPath, snapshot: opts, lazy: false }
    : opts.eager === true
      ? (() => {
          const snap = getConfigSnapshot({ ...opts, env, fresh: true });
          return { env, configPath: snap.configPath, snapshot: snap, lazy: false };
        })()
      : {
          env,
          configPath: opts.configPath ? path.resolve(opts.configPath) : null,
          snapshot: null,
          lazy: true
        };
  activeScopedSnapshot = scope;
  try {
    return fn(scope.snapshot);
  } finally {
    activeScopedSnapshot = prev;
  }
}

/**
 * Resolve all effective agy-dart settings with provenance tracking ("env" | "config" | "default").
 */
export function getConfigSnapshot(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath ? path.resolve(options.configPath) : getConfigPath(env);
  if (
    !options.fresh &&
    activeScopedSnapshot &&
    activeScopedSnapshot.env === env &&
    activeScopedSnapshot.snapshot &&
    activeScopedSnapshot.configPath === configPath
  ) {
    return activeScopedSnapshot.snapshot;
  }
  const loaded = loadConfigFile(configPath);
  const cfg = loaded.data || {};
  const values = {
    ...CONFIG_DEFAULTS,
    exemptExtensions: [],
    exemptPaths: [],
    execEnvAllowlist: [],
    safetyLogPaths: []
  };
  const sources = {};
  for (const k of Object.keys(CONFIG_DEFAULTS)) {
    sources[k] = "default";
  }

  const pick = (key, envVal, cfgVal) => {
    if (envVal !== undefined) {
      values[key] = envVal;
      sources[key] = "env";
    } else if (cfgVal !== undefined) {
      values[key] = cfgVal;
      sources[key] = "config";
    }
  };

  const envStr = (name) => {
    const v = env?.[name];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const cfgBool = (key) => (typeof cfg[key] === "boolean" ? cfg[key] : undefined);
  const cfgStr = (key) => (typeof cfg[key] === "string" && cfg[key].trim() ? cfg[key].trim() : undefined);

  // 1. Storage & compile cache
  pick("dbPath", envStr("AGY_DART_DB_PATH") ?? envStr("CONTEXT_MODE_DB_PATH"), cfgStr("dbPath"));
  pick("defaultCwd", envStr("AGY_DART_WORKSPACE") ?? envStr("AGY_DART_DEFAULT_CWD"), cfgStr("defaultCwd"));
  pick(
    "compileCache",
    parseDisableEnvFlag(env?.AGY_DART_DISABLE_COMPILE_CACHE),
    cfgBool("compileCache")
  );
  pick("compileCacheDir", envStr("AGY_DART_COMPILE_CACHE_DIR"), cfgStr("compileCacheDir"));

  // 2. Prefix stability & repo hubs
  pick("stablePrefixOnly", parseEnvBool(env?.AGY_DART_STABLE_PREFIX_ONLY), cfgBool("stablePrefixOnly"));
  pick("subagentIncludeGit", parseEnvBool(env?.AGY_DART_SUBAGENT_INCLUDE_GIT), cfgBool("subagentIncludeGit"));
  pick("repoHubs", parseDisableEnvFlag(env?.AGY_DART_DISABLE_REPO_HUBS), cfgBool("repoHubs"));

  // 3. Read guards & three-state diff-read (default OFF)
  pick("readHook", parseDisableEnvFlag(env?.AGY_DART_DISABLE_READ_HOOK), cfgBool("readHook"));
  pick("readGuardMode", parseReadGuardMode(env?.AGY_DART_READ_GUARD_MODE), parseReadGuardMode(cfg.readGuardMode));
  pick("readDedup", parseDisableEnvFlag(env?.AGY_DART_DISABLE_READ_DEDUP), cfgBool("readDedup"));
  pick(
    "readDedupMaxSteps",
    clampInt(parseNonNegativeInt(env?.AGY_DART_READ_DEDUP_MAX_STEPS), 0, 10000),
    clampInt(parseNonNegativeInt(cfg.readDedupMaxSteps), 0, 10000)
  );
  pick(
    "readDedupMaxTurns",
    clampInt(parseNonNegativeInt(env?.AGY_DART_READ_DEDUP_MAX_TURNS), 0, 10000),
    clampInt(parseNonNegativeInt(cfg.readDedupMaxTurns), 0, 10000)
  );
  pick(
    "readDedupMinBytes",
    clampInt(parseNonNegativeInt(env?.AGY_DART_READ_DEDUP_MIN_BYTES), 0, 10 * 1024 * 1024),
    clampInt(parseNonNegativeInt(cfg.readDedupMinBytes), 0, 10 * 1024 * 1024)
  );
  let diffEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_DIFF_READ) === true) {
    diffEnv = false;
  } else {
    diffEnv = parseEnvBool(env?.AGY_DART_ENABLE_DIFF_READ);
  }
  pick("diffRead", diffEnv, cfgBool("diffRead"));
  pick(
    "diffReadMaxTurns",
    parsePositiveInt(env?.AGY_DART_DIFF_READ_MAX_TURNS),
    parsePositiveInt(cfg.diffReadMaxTurns)
  );
  pick(
    "diffReadMaxAgeMs",
    parsePositiveNumber(env?.AGY_DART_DIFF_READ_MAX_AGE_MS),
    parsePositiveNumber(cfg.diffReadMaxAgeMs)
  );
  pick(
    "maxReadBytes",
    parseNonNegativeInt(env?.AGY_DART_MAX_READ_BYTES) ?? parseNonNegativeInt(env?.CONTEXT_MODE_MAX_READ_BYTES),
    parseNonNegativeInt(cfg.maxReadBytes)
  );
  pick("inlineOutlineMaxBytes", parseNonNegativeInt(env?.AGY_DART_INLINE_OUTLINE_MAX_BYTES), parseNonNegativeInt(cfg.inlineOutlineMaxBytes));
  pick(
    "noiseMaxReadBytes",
    parseNonNegativeInt(env?.AGY_DART_NOISE_MAX_READ_BYTES),
    parseNonNegativeInt(cfg.noiseMaxReadBytes)
  );
  pick(
    "reviewMaxReadBytes",
    parseNonNegativeInt(env?.AGY_DART_REVIEW_MAX_READ_BYTES),
    parseNonNegativeInt(cfg.reviewMaxReadBytes)
  );
  pick(
    "shellDumpMaxBytes",
    parseNonNegativeInt(env?.AGY_DART_SHELL_DUMP_MAX_BYTES),
    parseNonNegativeInt(cfg.shellDumpMaxBytes)
  );
  pick(
    "exemptExtensions",
    parseExemptExtensions(env?.AGY_DART_EXEMPT_EXTENSIONS),
    parseExemptExtensions(cfg.exemptExtensions)
  );
  pick(
    "exemptPaths",
    parseExemptPaths(env?.AGY_DART_EXEMPT_PATHS),
    parseExemptPaths(cfg.exemptPaths)
  );
  pick(
    "maxLineRange",
    parsePositiveInt(env?.AGY_DART_MAX_LINE_RANGE) ?? parsePositiveInt(env?.CONTEXT_MODE_MAX_LINE_RANGE),
    parsePositiveInt(cfg.maxLineRange)
  );
  pick(
    "maxOutputBytes",
    parsePositiveInt(env?.AGY_DART_MAX_OUTPUT_BYTES) ?? parsePositiveInt(env?.CONTEXT_MODE_MAX_OUTPUT_BYTES),
    parsePositiveInt(cfg.maxOutputBytes)
  );
  pick(
    "execTimeoutMs",
    clampInt(parsePositiveInt(env?.AGY_DART_EXEC_TIMEOUT_MS), 1000, 300000),
    clampInt(parsePositiveInt(cfg.execTimeoutMs), 1000, 300000)
  );
  pick(
    "execEnvAllowlist",
    parseEnvNameList(env?.AGY_DART_EXEC_ENV_ALLOWLIST),
    parseEnvNameList(cfg.execEnvAllowlist)
  );

  // 4. CLI filter & fast MCP caches
  pick("cliFilter", parseDisableEnvFlag(env?.AGY_DART_DISABLE_CLI_FILTER), cfgBool("cliFilter"));
  pick(
    "cliFilterAsyncBypassMs",
    clampInt(parseNonNegativeInt(env?.AGY_DART_CLI_FILTER_ASYNC_BYPASS_MS), 0, 60000),
    clampInt(parseNonNegativeInt(cfg.cliFilterAsyncBypassMs), 0, 60000)
  );
  pick("outlineDb", parseDisableEnvFlag(env?.AGY_DART_DISABLE_OUTLINE_DB), cfgBool("outlineDb"));
  pick(
    "searchCacheTtlMs",
    parseNonNegativeInt(env?.AGY_DART_SEARCH_CACHE_TTL_MS),
    parseNonNegativeInt(cfg.searchCacheTtlMs)
  );

  // 5. PreInvocation KV-cache watch & thresholds
  pick("cacheWatch", parseDisableEnvFlag(env?.AGY_DART_DISABLE_CACHE_WATCH), cfgBool("cacheWatch"));
  let cacheWatchInlineAlertsEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_CACHE_WATCH_INLINE_ALERTS) === true) {
    cacheWatchInlineAlertsEnv = false;
  } else {
    cacheWatchInlineAlertsEnv =
      parseEnvBool(env?.AGY_DART_CACHE_WATCH_INLINE_ALERTS) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_CACHE_WATCH_INLINE_ALERTS);
  }
  pick("cacheWatchInlineAlerts", cacheWatchInlineAlertsEnv, cfgBool("cacheWatchInlineAlerts"));
  pick("cacheTtlSec", parsePositiveNumber(env?.AGY_DART_CACHE_TTL_SEC), parsePositiveNumber(cfg.cacheTtlSec));
  pick("windowTokens", parsePositiveNumber(env?.AGY_DART_WINDOW_TOKENS), parsePositiveNumber(cfg.windowTokens));
  pick("warnTokens", parsePositiveNumber(env?.AGY_DART_WARN_TOKENS), parsePositiveNumber(cfg.warnTokens));
  pick("criticalTokens", parsePositiveNumber(env?.AGY_DART_CRITICAL_TOKENS), parsePositiveNumber(cfg.criticalTokens));

  // 6. Security controls
  let redactionEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_SECRET_REDACTION) === true) {
    redactionEnv = false;
  } else {
    redactionEnv =
      parseEnvBool(env?.AGY_DART_SECRET_REDACTION) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_SECRET_REDACTION);
  }
  pick("secretRedaction", redactionEnv, cfgBool("secretRedaction"));
  pick(
    "sensitiveFileGuard",
    parseGuardMode(env?.AGY_DART_SENSITIVE_FILE_GUARD),
    parseGuardMode(cfg.sensitiveFileGuard)
  );
  pick("allowPrivateUrls", parseEnvBool(env?.AGY_DART_ALLOW_PRIVATE_URLS), cfgBool("allowPrivateUrls"));

  // 7. Sidecar Stall Watchdog (lease state machine, dynamic thresholds, opt-in desktop notify)
  let watchdogEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_STALL_WATCHDOG) === true) {
    watchdogEnv = false;
  } else {
    watchdogEnv =
      parseEnvBool(env?.AGY_DART_STALL_WATCHDOG) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_STALL_WATCHDOG);
  }
  pick("stallWatchdog", watchdogEnv, cfgBool("stallWatchdog"));
  pick(
    "watchdogPollMs",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_POLL_MS), 1000, 60000),
    clampInt(parsePositiveInt(cfg.watchdogPollMs), 1000, 60000)
  );
  pick(
    "watchdogSuspectRatio",
    parseRatio(env?.AGY_DART_WATCHDOG_SUSPECT_RATIO, 0.25, 0.95),
    parseRatio(cfg.watchdogSuspectRatio, 0.25, 0.95)
  );
  pick(
    "watchdogLlmLowSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_LLM_LOW_SEC), 15, 3600),
    clampInt(parsePositiveInt(cfg.watchdogLlmLowSec), 15, 3600)
  );
  pick(
    "watchdogLlmHighSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_LLM_HIGH_SEC), 30, 7200),
    clampInt(parsePositiveInt(cfg.watchdogLlmHighSec), 30, 7200)
  );
  pick(
    "watchdogLlmMultimodalSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_LLM_MULTIMODAL_SEC), 30, 7200),
    clampInt(parsePositiveInt(cfg.watchdogLlmMultimodalSec), 30, 7200)
  );
  pick(
    "watchdogLlmReasoningSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_LLM_REASONING_SEC), 30, 7200),
    clampInt(parsePositiveInt(cfg.watchdogLlmReasoningSec), 30, 7200)
  );
  pick(
    "watchdogLlmCompoundSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_LLM_COMPOUND_SEC), 60, 14400),
    clampInt(parsePositiveInt(cfg.watchdogLlmCompoundSec), 60, 14400)
  );
  pick(
    "watchdogToolCmdSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_TOOL_CMD_SEC), 30, 7200),
    clampInt(parsePositiveInt(cfg.watchdogToolCmdSec), 30, 7200)
  );
  pick(
    "watchdogToolFastSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_TOOL_FAST_SEC), 15, 3600),
    clampInt(parsePositiveInt(cfg.watchdogToolFastSec), 15, 3600)
  );
  pick(
    "watchdogSubagentSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_SUBAGENT_SEC), 60, 14400),
    clampInt(parsePositiveInt(cfg.watchdogSubagentSec), 60, 14400)
  );
  pick(
    "watchdogDesktopNotify",
    parseEnvBool(env?.AGY_DART_WATCHDOG_DESKTOP_NOTIFY),
    cfgBool("watchdogDesktopNotify")
  );
  pick(
    "watchdogNotifyCooldownSec",
    clampInt(parsePositiveInt(env?.AGY_DART_WATCHDOG_NOTIFY_COOLDOWN_SEC), 30, 3600),
    clampInt(parsePositiveInt(cfg.watchdogNotifyCooldownSec), 30, 3600)
  );
  pick(
    "ttlDesktopNotify",
    parseEnvBool(env?.AGY_DART_TTL_DESKTOP_NOTIFY),
    cfgBool("ttlDesktopNotify")
  );
  pick(
    "ttlNotifyLeadSec",
    clampInt(parsePositiveInt(env?.AGY_DART_TTL_NOTIFY_LEAD_SEC), 15, 300),
    clampInt(parsePositiveInt(cfg.ttlNotifyLeadSec), 15, 300)
  );
  pick(
    "ttlNotifyMinTokens",
    clampInt(parsePositiveInt(env?.AGY_DART_TTL_NOTIFY_MIN_TOKENS), 4000, 500000),
    clampInt(parsePositiveInt(cfg.ttlNotifyMinTokens), 4000, 500000)
  );
  let ttlKeepaliveEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_TTL_KEEPALIVE) === true) {
    ttlKeepaliveEnv = false;
  } else {
    ttlKeepaliveEnv =
      parseEnvBool(env?.AGY_DART_TTL_KEEPALIVE) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_TTL_KEEPALIVE);
  }
  const configuredKeepaliveCount = clampInt(parseNonNegativeInt(cfg.ttlKeepaliveMaxCount), 0, 20);
  // Existing configs can opt in with a positive count alone.
  pick("ttlKeepalive", ttlKeepaliveEnv, cfgBool("ttlKeepalive") ?? (configuredKeepaliveCount > 0 ? true : undefined));
  const parseKeepaliveIntervalSec = (raw) => {
    if (raw === undefined || raw === null || typeof raw === "boolean" || typeof raw === "object") return undefined;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (!s) return undefined;
      if (s === "0" || s === "auto" || s === "adaptive" || s === "dynamic") return 0;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const floored = Math.floor(n);
    if (floored === 0) return 0;
    if (floored < 60) return undefined;
    return Math.min(3600, floored);
  };
  pick(
    "ttlKeepaliveMaxCount",
    clampInt(parseNonNegativeInt(env?.AGY_DART_TTL_KEEPALIVE_MAX_COUNT), 0, 20),
    configuredKeepaliveCount
  );
  pick(
    "ttlKeepaliveIntervalSec",
    parseKeepaliveIntervalSec(env?.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC),
    parseKeepaliveIntervalSec(cfg.ttlKeepaliveIntervalSec)
  );
  pick(
    "ttlKeepaliveLeadSec",
    clampInt(parsePositiveInt(env?.AGY_DART_TTL_KEEPALIVE_LEAD_SEC), 10, 180),
    clampInt(parsePositiveInt(cfg.ttlKeepaliveLeadSec), 10, 180)
  );
  pick(
    "ttlKeepaliveMinRemainSec",
    clampInt(parseNonNegativeInt(env?.AGY_DART_TTL_KEEPALIVE_MIN_REMAIN_SEC), 0, 120),
    clampInt(parseNonNegativeInt(cfg.ttlKeepaliveMinRemainSec), 0, 120)
  );
  pick(
    "ttlKeepaliveMinContextPct",
    clampInt(parseNonNegativeInt(env?.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT), 0, 100),
    clampInt(parseNonNegativeInt(cfg.ttlKeepaliveMinContextPct), 0, 100)
  );
  pick(
    "ttlKeepaliveMinTokens",
    clampInt(parseNonNegativeInt(env?.AGY_DART_TTL_KEEPALIVE_MIN_TOKENS), 0, 500000),
    clampInt(parseNonNegativeInt(cfg.ttlKeepaliveMinTokens), 0, 500000)
  );
  pick(
    "watermarkDesktopNotify",
    parseEnvBool(env?.AGY_DART_WATERMARK_DESKTOP_NOTIFY),
    cfgBool("watermarkDesktopNotify")
  );
  pick("toolLoading", parseToolLoading(env?.AGY_DART_TOOL_LOADING), parseToolLoading(cfg.toolLoading));
  let autoUpdateCheckEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_AUTO_UPDATE_CHECK) === true) {
    autoUpdateCheckEnv = false;
  } else {
    autoUpdateCheckEnv =
      parseEnvBool(env?.AGY_DART_AUTO_UPDATE_CHECK) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_AUTO_UPDATE_CHECK);
  }
  pick("autoUpdateCheck", autoUpdateCheckEnv, cfgBool("autoUpdateCheck"));
  let autoUpdateInstallEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_AUTO_UPDATE_INSTALL) === true) {
    autoUpdateInstallEnv = false;
  } else {
    autoUpdateInstallEnv =
      parseEnvBool(env?.AGY_DART_AUTO_UPDATE_INSTALL) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_AUTO_UPDATE_INSTALL);
  }
  pick("autoUpdateInstall", autoUpdateInstallEnv, cfgBool("autoUpdateInstall"));
  let safetyAuditEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_SAFETY_AUDIT) === true) {
    safetyAuditEnv = false;
  } else {
    safetyAuditEnv =
      parseEnvBool(env?.AGY_DART_SAFETY_AUDIT) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_SAFETY_AUDIT);
  }
  pick("safetyAudit", safetyAuditEnv, cfgBool("safetyAudit"));
  let safetyDesktopNotifyEnv;
  if (parseEnvBool(env?.AGY_DART_DISABLE_SAFETY_DESKTOP_NOTIFY) === true) {
    safetyDesktopNotifyEnv = false;
  } else {
    safetyDesktopNotifyEnv =
      parseEnvBool(env?.AGY_DART_SAFETY_DESKTOP_NOTIFY) ??
      parseDisableEnvFlag(env?.AGY_DART_DISABLE_SAFETY_DESKTOP_NOTIFY);
  }
  pick("safetyDesktopNotify", safetyDesktopNotifyEnv, cfgBool("safetyDesktopNotify"));
  pick(
    "safetyLogPaths",
    parseSafetyLogPaths(env?.AGY_DART_SAFETY_LOG_PATHS),
    parseSafetyLogPaths(cfg.safetyLogPaths)
  );
  pick("safetyStatePath", envStr("AGY_DART_SAFETY_STATE_PATH"), cfgStr("safetyStatePath"));
  pick(
    "safetyWindowHours",
    clampInt(parsePositiveInt(env?.AGY_DART_SAFETY_WINDOW_HOURS), 1, 24),
    clampInt(parsePositiveInt(cfg.safetyWindowHours), 1, 24)
  );
  pick(
    "safetyPrecheckWarnCount",
    clampInt(parsePositiveInt(env?.AGY_DART_SAFETY_PRECHECK_WARN), 100, 50000),
    clampInt(parsePositiveInt(cfg.safetyPrecheckWarnCount), 100, 50000)
  );
  pick(
    "safetyPrecheckLimit",
    clampInt(parsePositiveInt(env?.AGY_DART_SAFETY_PRECHECK_LIMIT), 100, 100000),
    clampInt(parsePositiveInt(cfg.safetyPrecheckLimit), 100, 100000)
  );
  pick(
    "safetyHeavyBurstCount",
    clampInt(parsePositiveInt(env?.AGY_DART_SAFETY_HEAVY_BURST_COUNT), 2, 100),
    clampInt(parsePositiveInt(cfg.safetyHeavyBurstCount), 2, 100)
  );
  pick(
    "safetyHeavyBurstWindowMin",
    clampInt(parsePositiveInt(env?.AGY_DART_SAFETY_HEAVY_BURST_WINDOW_MIN), 1, 60),
    clampInt(parsePositiveInt(cfg.safetyHeavyBurstWindowMin), 1, 60)
  );
  pick(
    "safetyStickyCharThreshold",
    clampInt(parsePositiveInt(env?.AGY_DART_SAFETY_STICKY_CHARS), 10000, 1000000),
    clampInt(parsePositiveInt(cfg.safetyStickyCharThreshold), 10000, 1000000)
  );
  pick("uiLang", parseUiLang(env?.AGY_DART_LANG), parseUiLang(cfg.uiLang));

  const snapshot = {
    configPath: loaded.path,
    fileExists: loaded.exists,
    configError: loaded.error,
    values,
    sources
  };
  if (
    !options.fresh &&
    activeScopedSnapshot &&
    activeScopedSnapshot.lazy &&
    activeScopedSnapshot.env === env &&
    !activeScopedSnapshot.snapshot &&
    (!activeScopedSnapshot.configPath || activeScopedSnapshot.configPath === snapshot.configPath)
  ) {
    activeScopedSnapshot.configPath = snapshot.configPath;
    activeScopedSnapshot.snapshot = snapshot;
  }
  return snapshot;
}

export function getEffectiveConfig(options = {}) {
  return getConfigSnapshot(options).values;
}

export function formatEffectiveConfigLines(snapshot = getConfigSnapshot(), extra = {}) {
  const { configPath, fileExists, configError, values, sources } = snapshot;
  const lines = [];
  const fileNote = configError
    ? `INVALID (${configError}; using defaults + env)`
    : fileExists
      ? "loaded"
      : "not found (using defaults + env)";
  lines.push(`  - Config file   : ${configPath} [${fileNote}]`);
  const summaryKeys = [
    "readHook",
    "readGuardMode",
    "readDedup",
    "diffRead",
    "cliFilter",
    "cacheWatch",
    "cacheWatchInlineAlerts",
    "stallWatchdog",
    "stablePrefixOnly",
    "outlineDb",
    "toolLoading",
    "secretRedaction",
    "sensitiveFileGuard",
    "allowPrivateUrls"
  ];
  const pairs = summaryKeys.map((k) => {
    const srcTag = sources[k] !== "default" ? `*${sources[k]}` : "";
    return `${k}=${values[k]}${srcTag}`;
  });
  lines.push(`  - Active flags  : ${pairs.slice(0, 6).join(", ")}`);
  lines.push(`                    ${pairs.slice(6).join(", ")}`);

  const effSourceCutoff =
    extra && Number.isFinite(extra.sourceCutoffBytes)
      ? extra.sourceCutoffBytes
      : values.maxReadBytes !== null && values.maxReadBytes !== undefined
        ? values.maxReadBytes
        : 46080;
  const effSourceProv =
    extra && typeof extra.sourceCutoffSource === "string" && extra.sourceCutoffSource
      ? extra.sourceCutoffSource
      : sources.maxReadBytes !== "default"
        ? sources.maxReadBytes
        : "default";
  const fmtKb = (b) => (b === 0 ? "0 (off)" : b % 1024 === 0 ? `${b / 1024} KB` : `${b} B`);
  const exemptSummary = [
    Array.isArray(values.exemptPaths) && values.exemptPaths.length > 0 ? `exemptPaths=${values.exemptPaths.length}` : "",
    Array.isArray(values.exemptExtensions) && values.exemptExtensions.length > 0 ? `exemptExt=${values.exemptExtensions.length}` : ""
  ]
    .filter(Boolean)
    .join(", ");
  lines.push(
    `  - Read guard    : mode=${values.readGuardMode} (${sources.readGuardMode}), source=${fmtKb(effSourceCutoff)} (${effSourceProv}), ` +
      `inlineOutlineMaxBytes=${values.inlineOutlineMaxBytes}, noise=${fmtKb(values.noiseMaxReadBytes)}, review=${fmtKb(values.reviewMaxReadBytes)}, shellDump=${fmtKb(values.shellDumpMaxBytes)}` +
      (exemptSummary ? `, ${exemptSummary}` : "")
  );
  lines.push(
    `  - Read dedup    : enabled=${values.readDedup} (${sources.readDedup}), minBytes=${fmtKb(values.readDedupMinBytes)}, ` +
      `maxSteps=${values.readDedupMaxSteps || "off"}, maxTurns=${values.readDedupMaxTurns || "off"}`
  );
  lines.push(
    `  - Stall watchdog: enabled=${values.stallWatchdog} (${sources.stallWatchdog}), ` +
      `llm=${values.watchdogLlmLowSec}s/${values.watchdogLlmHighSec}s/${values.watchdogLlmMultimodalSec}s, ` +
      `reasoning=${values.watchdogLlmReasoningSec}s/${values.watchdogLlmCompoundSec}s, ` +
      `tool=${values.watchdogToolFastSec}s/${values.watchdogToolCmdSec}s, bg=${values.watchdogSubagentSec}s, ` +
      `desktopNotify=${values.watchdogDesktopNotify} (${sources.watchdogDesktopNotify})`
  );
  const wmNotifyDisplay =
    values.watermarkDesktopNotify === null ? "auto" : String(values.watermarkDesktopNotify);
  const kaIntervalLabel = values.ttlKeepaliveIntervalSec > 0 ? `${values.ttlKeepaliveIntervalSec}s` : "auto";
  lines.push(
    `  - TTL alert     : desktopNotify=${values.ttlDesktopNotify} (${sources.ttlDesktopNotify}), ` +
      `watermarkNotify=${wmNotifyDisplay} (${sources.watermarkDesktopNotify}), ` +
      `keepalive=${values.ttlKeepalive} (${sources.ttlKeepalive}, max=${values.ttlKeepaliveMaxCount}, interval=${kaIntervalLabel}, lead=${values.ttlKeepaliveLeadSec}s, minRem=${values.ttlKeepaliveMinRemainSec}s, minCtx=${values.ttlKeepaliveMinContextPct}%), ` +
      `lead=${values.ttlNotifyLeadSec}s, minTokens=${values.ttlNotifyMinTokens}, lang=${values.uiLang} (${sources.uiLang})`
  );

  const overrides = Object.keys(sources)
    .filter((k) => sources[k] !== "default")
    .map((k) => `${k}=${JSON.stringify(values[k])} (${sources[k]})`);
  if (overrides.length > 0) {
    lines.push(`  - Overrides     : ${overrides.join(", ")}`);
  }
  return lines;
}
