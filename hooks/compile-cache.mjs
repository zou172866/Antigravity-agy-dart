import fs from "node:fs";
import * as nodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedPluginVersion = null;
let sqliteWarningFilterInstalled = false;

/**
 * Suppress Node 22.x `ExperimentalWarning: SQLite is an experimental feature`
 * on stderr so JSON-RPC stdio MCP servers and lifecycle hooks emit strictly 0 bytes
 * of stderr noise across Node 22.x and 24.x. Non-SQLite warnings pass through untouched.
 */
export function suppressSqliteExperimentalWarning() {
  if (sqliteWarningFilterInstalled) return false;
  sqliteWarningFilterInstalled = true;
  try {
    const origEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = (warning, ...args) => {
      const msg = typeof warning === "string" ? warning : String(warning?.message || "");
      const type = typeof args[0] === "string" ? args[0] : (args[0]?.type || warning?.name || "");
      if (/ExperimentalWarning/i.test(String(type)) && /sqlite/i.test(msg)) {
        return;
      }
      return origEmitWarning(warning, ...args);
    };
    return true;
  } catch {
    return false;
  }
}

// Install SQLite ExperimentalWarning filter immediately upon module evaluation so
// static ESM entrypoints importing compile-cache.mjs before store.js stay 0-byte stderr on Node 22.x.
suppressSqliteExperimentalWarning();

function readCompileCacheConfigOverrides() {
  try {
    const cfgPath =
      typeof process.env.AGY_DART_CONFIG_PATH === "string" && process.env.AGY_DART_CONFIG_PATH.trim()
        ? path.resolve(process.env.AGY_DART_CONFIG_PATH.trim())
        : path.join(os.homedir(), ".agy-dart", "config.json");
    if (!fs.existsSync(cfgPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readPluginVersion() {
  if (cachedPluginVersion) return cachedPluginVersion;
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) {
      cachedPluginVersion = pkg.version.trim();
      return cachedPluginVersion;
    }
  } catch {}
  cachedPluginVersion = "1.2.0";
  return cachedPluginVersion;
}

/**
 * Sanitize a cache version tag to a single safe path segment containing only [A-Za-z0-9._-].
 * Prevents path traversal (".", "..", separators) and falls back to "default".
 */
export function sanitizeCacheTag(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return cleaned || "default";
}

function isSubPath(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel);
}

/**
 * Best-effort pruning of stale versioned compile-cache directories.
 * Always retains `activeTag` plus up to `keepRecent - 1` most recently modified sibling directories.
 */
export function pruneStaleCompileCaches(rootDir, activeTag, keepRecent = 3) {
  const removed = [];
  const kept = [];
  try {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return { removed, kept };
    }
    const safeActive = sanitizeCacheTag(activeTag);
    const activeCompare = process.platform === "win32" ? safeActive.toLowerCase() : safeActive;
    const keepTotal = Math.max(1, Number.isFinite(keepRecent) ? Math.trunc(keepRecent) : 3);
    const resolvedRoot = path.resolve(rootDir);
    const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    const others = [];
    let activePresent = false;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryCompare = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
      if (entryCompare === activeCompare) {
        activePresent = true;
        kept.push(entry.name);
        continue;
      }
      const fullPath = path.resolve(resolvedRoot, entry.name);
      if (!isSubPath(resolvedRoot, fullPath)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs || 0;
      } catch {}
      others.push({ name: entry.name, fullPath, mtimeMs });
    }

    others.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.name.localeCompare(a.name, undefined, { numeric: true });
    });

    const keepOthers = Math.max(0, keepTotal - (activePresent ? 1 : 0));
    for (let i = 0; i < others.length; i++) {
      const item = others[i];
      if (i < keepOthers) {
        kept.push(item.name);
      } else {
        try {
          fs.rmSync(item.fullPath, { recursive: true, force: true });
          removed.push(item.name);
        } catch {}
      }
    }
  } catch {
    // Fail-open: never disturb hook execution
  }
  return { removed, kept };
}

/**
 * Enable Node.js versioned V8 compile cache (Node >= 22.8 / 24+; silent no-op on 22.0-22.7).
 * Strictly fail-open and silent on stdout/stderr so hook JSON protocol is never corrupted.
 */
export function enableVersionedCompileCache(options = {}) {
  suppressSqliteExperimentalWarning();
  try {
    const rawDisable = String(process.env.AGY_DART_DISABLE_COMPILE_CACHE ?? "").trim().toLowerCase();
    if (rawDisable === "1" || rawDisable === "true" || rawDisable === "yes" || rawDisable === "on") {
      return { enabled: false, reason: "disabled", cacheDir: null, tag: null };
    }
    const envExplicitEnable = rawDisable === "0" || rawDisable === "false" || rawDisable === "no" || rawDisable === "off";
    const fileCfg = options.rootDir !== undefined ? {} : readCompileCacheConfigOverrides();
    if (!envExplicitEnable && fileCfg.compileCache === false) {
      return { enabled: false, reason: "disabled", cacheDir: null, tag: null };
    }

    const enableFn =
      options.enableCompileCache !== undefined
        ? options.enableCompileCache
        : nodeModule?.enableCompileCache;
    if (typeof enableFn !== "function") {
      return { enabled: false, reason: "unsupported", cacheDir: null, tag: null };
    }

    const envDir =
      typeof process.env.AGY_DART_COMPILE_CACHE_DIR === "string"
        ? process.env.AGY_DART_COMPILE_CACHE_DIR.trim()
        : "";
    const cfgDir =
      typeof fileCfg.compileCacheDir === "string" && fileCfg.compileCacheDir.trim()
        ? fileCfg.compileCacheDir.trim()
        : "";
    const rootDir = path.resolve(
      options.rootDir || envDir || cfgDir || path.join(os.homedir(), ".agy-dart", "compile-cache")
    );
    const rawTag = options.tag !== undefined ? options.tag : readPluginVersion();
    const activeTag = sanitizeCacheTag(rawTag);
    const keepRecent = options.keepRecent !== undefined ? options.keepRecent : 3;
    const cacheDir = path.resolve(rootDir, activeTag);

    if (!isSubPath(rootDir, cacheDir)) {
      return { enabled: false, reason: "invalid_path", cacheDir: null, tag: activeTag };
    }

    const isNewDir = !fs.existsSync(cacheDir);
    if (isNewDir) {
      fs.mkdirSync(cacheDir, { recursive: true });
      pruneStaleCompileCaches(rootDir, activeTag, keepRecent);
    }

    const result = enableFn(cacheDir);
    return {
      enabled: true,
      cacheDir,
      tag: activeTag,
      created: isNewDir,
      status: result?.status ?? null
    };
  } catch {
    return { enabled: false, reason: "error", cacheDir: null, tag: null };
  }
}
