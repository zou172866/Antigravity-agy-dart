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
  compileCache: true,
  compileCacheDir: null,
  stablePrefixOnly: false,
  subagentIncludeGit: false,
  repoHubs: true,
  readHook: true,
  readDedup: true,
  diffRead: false, // Opt-in until multi-turn/fork baseline freshness is battle-tested
  diffReadMaxTurns: 12,
  diffReadMaxAgeMs: 15 * 60 * 1000,
  maxReadBytes: null,
  maxLineRange: null,
  maxOutputBytes: 8100,
  cliFilter: true,
  outlineDb: true,
  searchCacheTtlMs: 15000,
  cacheWatch: true,
  cacheTtlSec: null,
  windowTokens: null,
  warnTokens: null,
  criticalTokens: null,
  secretRedaction: true,
  sensitiveFileGuard: "off",
  allowPrivateUrls: false
});

let cachedFileState = {
  path: null,
  exists: false,
  mtimeMs: -1,
  size: -1,
  data: null,
  error: null
};

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

function parseGuardMode(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === "deny" || s === "block" || s === "strict") return "deny";
  if (s === "warn" || s === "1" || s === "true" || s === "remind") return "warn";
  if (s === "off" || s === "0" || s === "false" || s === "none") return "off";
  return undefined;
}

export function loadConfigFile(configPath = getConfigPath()) {
  const resolved = path.resolve(configPath);
  try {
    if (!fs.existsSync(resolved)) {
      cachedFileState = { path: resolved, exists: false, mtimeMs: -1, size: -1, data: {}, error: null };
      return { exists: false, data: {}, error: null, path: resolved };
    }
    const stat = fs.statSync(resolved);
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
}

/**
 * Resolve all effective agy-dart settings with provenance tracking ("env" | "config" | "default").
 */
export function getConfigSnapshot(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath ? path.resolve(options.configPath) : getConfigPath(env);
  const loaded = loadConfigFile(configPath);
  const cfg = loaded.data || {};
  const values = { ...CONFIG_DEFAULTS };
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
  pick("readDedup", parseDisableEnvFlag(env?.AGY_DART_DISABLE_READ_DEDUP), cfgBool("readDedup"));
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
    parseNonNegativeInt(env?.CONTEXT_MODE_MAX_READ_BYTES),
    parseNonNegativeInt(cfg.maxReadBytes)
  );
  pick(
    "maxLineRange",
    parsePositiveInt(env?.CONTEXT_MODE_MAX_LINE_RANGE),
    parsePositiveInt(cfg.maxLineRange)
  );
  pick(
    "maxOutputBytes",
    parsePositiveInt(env?.CONTEXT_MODE_MAX_OUTPUT_BYTES),
    parsePositiveInt(cfg.maxOutputBytes)
  );

  // 4. CLI filter & fast MCP caches
  pick("cliFilter", parseDisableEnvFlag(env?.AGY_DART_DISABLE_CLI_FILTER), cfgBool("cliFilter"));
  pick("outlineDb", parseDisableEnvFlag(env?.AGY_DART_DISABLE_OUTLINE_DB), cfgBool("outlineDb"));
  pick(
    "searchCacheTtlMs",
    parseNonNegativeInt(env?.AGY_DART_SEARCH_CACHE_TTL_MS),
    parseNonNegativeInt(cfg.searchCacheTtlMs)
  );

  // 5. PreInvocation KV-cache watch & thresholds
  pick("cacheWatch", parseDisableEnvFlag(env?.AGY_DART_DISABLE_CACHE_WATCH), cfgBool("cacheWatch"));
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

  return {
    configPath: loaded.path,
    fileExists: loaded.exists,
    configError: loaded.error,
    values,
    sources
  };
}

export function getEffectiveConfig(options = {}) {
  return getConfigSnapshot(options).values;
}

export function formatEffectiveConfigLines(snapshot = getConfigSnapshot()) {
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
    "readDedup",
    "diffRead",
    "cliFilter",
    "cacheWatch",
    "stablePrefixOnly",
    "outlineDb",
    "secretRedaction",
    "sensitiveFileGuard",
    "allowPrivateUrls"
  ];
  const pairs = summaryKeys.map((k) => {
    const srcTag = sources[k] !== "default" ? `*${sources[k]}` : "";
    return `${k}=${values[k]}${srcTag}`;
  });
  lines.push(`  - Active flags  : ${pairs.slice(0, 5).join(", ")}`);
  lines.push(`                    ${pairs.slice(5).join(", ")}`);

  const overrides = Object.keys(sources)
    .filter((k) => sources[k] !== "default")
    .map((k) => `${k}=${JSON.stringify(values[k])} (${sources[k]})`);
  if (overrides.length > 0) {
    lines.push(`  - Overrides     : ${overrides.join(", ")}`);
  }
  return lines;
}
