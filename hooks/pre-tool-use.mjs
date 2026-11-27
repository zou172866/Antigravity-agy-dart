#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enableVersionedCompileCache,
  isSameFilePath,
  readStdin,
  resolveDirectConversationId,
  resolveSessionId as resolveSharedSessionId
} from "./compile-cache.mjs";
import { getConfigSnapshot, getEffectiveConfig } from "../context/lib/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_FILTER_SCRIPT = path.resolve(__dirname, "cli-filter.mjs");
const PLUGIN_ROOT_POSIX = path.resolve(__dirname, "..").replace(/\\/g, "/");

const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __filename));

// Dynamically loaded AFTER enableVersionedCompileCache() in CLI runs so Node's V8 compile cache
// actually caches store.js & filter-rules.mjs AND 0-SQLite fast paths skip loading them entirely.
let ContextModeStoreClass = null;
let matchFilterRuleFn = null;
let unwrapSafeCompoundCommandFn = null;
let resolveCdTargetCwdFn = null;
let parseGitSubcommandFn = null;
let securityModule = null;
let textDiffModule = null;
let cacheAnalyzerModule = null;
let watchdogLeaseModule = null;

async function ensureStoreClass() {
  if (!ContextModeStoreClass) {
    ({ ContextModeStore: ContextModeStoreClass } = await import("../context/lib/store.js"));
  }
  return ContextModeStoreClass;
}

async function ensureFilterRules() {
  if (!matchFilterRuleFn) {
    ({
      matchFilterRule: matchFilterRuleFn,
      unwrapSafeCompoundCommand: unwrapSafeCompoundCommandFn,
      resolveCdTargetCwd: resolveCdTargetCwdFn,
      parseGitSubcommand: parseGitSubcommandFn
    } = await import("./filter-rules.mjs"));
  }
  return matchFilterRuleFn;
}

async function ensureSecurityModule() {
  if (!securityModule) {
    securityModule = await import("../context/lib/security.js");
  }
  return securityModule;
}

async function ensureTextDiffModule() {
  if (!textDiffModule) {
    textDiffModule = await import("../context/lib/text-diff.js");
  }
  return textDiffModule;
}

async function ensureCacheAnalyzer() {
  if (!cacheAnalyzerModule) {
    cacheAnalyzerModule = await import("../context/lib/cache-analyzer.js");
  }
  return cacheAnalyzerModule;
}

async function ensureWatchdogLease() {
  if (!watchdogLeaseModule) {
    watchdogLeaseModule = await import("../context/lib/watchdog-lease.js");
  }
  return watchdogLeaseModule;
}

if (!isDirectRun) {
  await Promise.all([ensureStoreClass(), ensureFilterRules(), ensureSecurityModule(), ensureTextDiffModule()]);
}

export const DEFAULT_MAX_READ_BYTES = 46080; // 45 KiB — exact alignment with Antigravity read_file host return cap
export const DEFAULT_NOISE_MAX_READ_BYTES = 16384; // 16 KB — Tier 1 high-noise logs/locks/minified bundles
export const DEFAULT_REVIEW_MAX_READ_BYTES = 131072; // 128 KB — Tier 3 .patch/.diff code-review files
export const DEFAULT_SHELL_DUMP_MAX_BYTES = 16384; // 16 KB — independent run_command cat/Get-Content dump limit
export const DEFAULT_MAX_LINE_RANGE = 800; // Clamped to Antigravity read_file host return cap
export const HOST_READ_MAX_LINES = 800; // Antigravity read_file host return cap (lines)
export const HOST_READ_MAX_BYTES = 46080; // Antigravity read_file host return cap (bytes)
export const LARGE_READ_CONFIRM_TTL_MS = 120 * 1000;
export const LARGE_READ_CONFIRM_SHORT_TTL_MS = 30 * 1000;
export const SENSITIVE_READ_CONFIRM_TTL_MS = 120 * 1000;
export const SENSITIVE_READ_CONFIRM_SHORT_TTL_MS = 30 * 1000;
export const DEFAULT_READ_DEDUP_MIN_BYTES = 4096; // 4 KB (~1,000 tokens) — prevents 2-strike backfire on small files / narrow slices
export const MIN_DEDUP_FILE_BYTES = DEFAULT_READ_DEDUP_MIN_BYTES;
export const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
export const MIN_DIFF_READ_BYTES = 1536;
export const MAX_DIFF_READ_BYTES = 6500;
export const MAX_DIFF_READ_RATIO = 0.4;
const MAX_SLICE_MEASURE_BYTES = 2 * 1024 * 1024;
const CTX_SERVER = "agy-dart_context";
const FAST_SERVER = "agy-dart_fast";

let sharedStore = null;
function getSharedStore() {
  if (!sharedStore) {
    if (!ContextModeStoreClass) {
      throw new Error("ContextModeStore not initialized");
    }
    sharedStore = new ContextModeStoreClass({ hookMode: true });
  }
  return sharedStore;
}

function closeSharedStore() {
  if (sharedStore) {
    try {
      sharedStore.close();
    } catch {}
    sharedStore = null;
  }
}

function isProtectionPaused(sessionId = null) {
  try {
    return getSharedStore().isPaused(sessionId);
  } catch {
    return false;
  }
}

function getMaxReadBytes(sessionId = null) {
  try {
    return getSharedStore().getCutoff(sessionId);
  } catch {
    const cfgMax = getEffectiveConfig().maxReadBytes;
    if (cfgMax !== null && cfgMax !== undefined) return cfgMax;
    return DEFAULT_MAX_READ_BYTES;
  }
}

function getShellDumpMaxBytes() {
  const cfgShell = getEffectiveConfig().shellDumpMaxBytes;
  if (cfgShell !== null && cfgShell !== undefined && Number.isFinite(Number(cfgShell))) {
    return Math.max(0, Math.floor(Number(cfgShell)));
  }
  return DEFAULT_SHELL_DUMP_MAX_BYTES;
}

function getExemptExtensions(sessionId = null) {
  const merged = new Set();
  try {
    for (const ext of getSharedStore().getExemptExtensions(sessionId)) {
      merged.add(ext);
    }
  } catch {
    for (const ext of BINARY_EXTENSIONS) {
      merged.add(ext);
    }
  }
  const cfgExts = getEffectiveConfig().exemptExtensions;
  if (Array.isArray(cfgExts)) {
    for (const ext of cfgExts) {
      if (typeof ext === "string" && ext) merged.add(ext.toLowerCase());
    }
  }
  return Array.from(merged);
}

export function getMaxLineRange(maxReadBytes = DEFAULT_MAX_READ_BYTES) {
  const cfgRange = getEffectiveConfig().maxLineRange;
  if (cfgRange !== null && cfgRange !== undefined && cfgRange > 0) {
    return Math.min(HOST_READ_MAX_LINES, cfgRange);
  }
  if (maxReadBytes === 0) return 0;
  return Math.min(HOST_READ_MAX_LINES, Math.max(50, Math.round(maxReadBytes / 40)));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(2)} MB`;
}

export function cleanStringArg(val) {
  if (val === undefined || val === null) return "";
  let str = String(val).trim();
  while (str.length >= 2) {
    const q = str[0];
    if ((q === '"' || q === "'") && str[str.length - 1] === q) {
      const inner = str.slice(1, -1);
      // Only unwrap if the entire value was wrapped in a single matching pair (never break `"exe" "arg"`)
      if (inner.includes(q)) break;
      str = inner.trim();
      continue;
    }
    break;
  }
  return str;
}

export function cleanFilePath(val) {
  let p = cleanStringArg(val);
  if (!p) return "";
  p = p.replace(/#L\d+(-L\d+)?$/i, "");
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      let rest = p.replace(/^file:\/\//i, "");
      try {
        rest = decodeURIComponent(rest);
      } catch {}
      if (/^\/[A-Za-z]:[\\/]/.test(rest)) {
        rest = rest.slice(1);
      }
      p = rest;
    }
  }
  return path.normalize(p.trim());
}

export function parseLineArg(val) {
  if (val === undefined || val === null || typeof val === "boolean") return null;
  if (typeof val === "number") {
    return Number.isSafeInteger(val) ? val : null;
  }
  const str = cleanStringArg(val);
  if (!str || str.toLowerCase() === "null" || str.toLowerCase() === "undefined") {
    return null;
  }
  if (!/^[+-]?\d+$/.test(str)) {
    return null;
  }
  const parsed = Number(str);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const KNOWN_TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".mdx", ".rst", ".adoc",
  ".cs", ".csx", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyw", ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh",
  ".rs", ".go", ".java", ".kt", ".kts", ".scala", ".rb", ".php",
  ".dart", ".swift", ".zig", ".lua", ".proto", ".prisma", ".cmake", ".gradle",
  ".sh", ".bash", ".ps1", ".psm1", ".psd1", ".bat", ".cmd",
  ".html", ".htm", ".xhtml", ".astro", ".css", ".scss", ".sass", ".less",
  ".json", ".jsonc", ".json5", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".sql", ".graphql", ".gql", ".diff", ".patch", ".txt", ".text", ".log", ".csv", ".tsv",
  ".vue", ".svelte", ".gd"
]);

const BINARY_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".avif", ".bmp", ".ico", ".tiff", ".tif",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".amr", ".mp4", ".webm", ".mkv", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".blend", ".fbx", ".obj", ".gltf", ".glb", ".wasm"
]);

const AGENT_INSTRUCTION_BASENAMES = new Set([
  "skill.md",
  "agents.md",
  "gemini.md",
  "claude.md"
]);

const NOISE_EXTENSIONS = new Set([
  ".log", ".csv", ".tsv", ".jsonl", ".ndjson", ".har", ".sql", ".map"
]);

const NOISE_LOCK_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "composer.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "gemfile.lock",
  "pipfile.lock",
  "uv.lock"
]);

const NOISE_SUFFIXES = [".min.js", ".min.mjs", ".min.cjs", ".min.css", ".bundle.js", ".chunk.js"];

const REVIEW_DIFF_EXTENSIONS = new Set([".patch", ".diff"]);

/** Linear O(|str|*|pat|) single-segment wildcard matcher (* and ?); zero RegExp, zero ReDoS */
function matchSegmentWildcard(str, pat) {
  let s = 0;
  let p = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === str[s])) {
      s++;
      p++;
    } else if (p < pat.length && pat[p] === "*") {
      starIdx = p++;
      matchIdx = s;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      s = ++matchIdx;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** Linear O(N*M) path segment glob matcher supporting **, *, ? without user regexes */
function matchPathSegments(segs, patSegs) {
  let s = 0;
  let p = 0;
  let starP = -1;
  let starS = 0;
  while (s < segs.length) {
    if (p < patSegs.length && patSegs[p] === "**") {
      starP = p++;
      starS = s;
    } else if (p < patSegs.length && matchSegmentWildcard(segs[s], patSegs[p])) {
      s++;
      p++;
    } else if (starP !== -1) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (p < patSegs.length && patSegs[p] === "**") p++;
  return p === patSegs.length;
}

/** Check whether absPath matches a single user-configured exemptPaths glob/prefix (linear, ReDoS-proof) */
export function matchesExemptPath(absPath, cwd, rawPattern, platform = process.platform) {
  if (!absPath || typeof rawPattern !== "string") return false;
  let pat = rawPattern.trim().replace(/\\/g, "/");
  if (!pat || pat.length > 256) return false;
  while (pat.startsWith("./")) pat = pat.slice(2);
  pat = pat.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!pat) return false;

  const isWin = platform === "win32";
  const pathMod = isWin ? path.win32 : path.posix;
  const fold = (s) => (isWin ? s.toLowerCase() : s);
  const absPosix = fold(String(absPath).replace(/\\/g, "/").replace(/\/{2,}/g, "/"));
  const normPat = fold(pat);

  let relPosix = "";
  if (cwd) {
    const rel = pathMod.relative(cwd, absPath);
    if (
      rel &&
      rel !== ".." &&
      !rel.startsWith("../") &&
      !rel.startsWith("..\\") &&
      !pathMod.isAbsolute(rel)
    ) {
      relPosix = fold(rel.replace(/\\/g, "/"));
    }
  }

  const isAbsPat = normPat.startsWith("/") || /^[a-z]:\//i.test(normPat);
  const hasWildcard = normPat.includes("*") || normPat.includes("?");

  const matchTarget = (target, patternStr) => {
    if (!target) return false;
    if (!hasWildcard) {
      return target === patternStr || target.startsWith(`${patternStr}/`);
    }
    const segs = target.split("/").filter(Boolean);
    const patSegs = patternStr.split("/").filter(Boolean);
    return matchPathSegments(segs, patSegs);
  };

  if (isAbsPat) {
    return matchTarget(absPosix, normPat);
  }
  if (relPosix && matchTarget(relPosix, normPat)) {
    return true;
  }
  if (normPat.startsWith("**/")) {
    return matchTarget(absPosix, normPat);
  }
  return false;
}

export function matchesAnyExemptPath(absPath, cwd, patterns, platform = process.platform) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const pat of patterns) {
    if (matchesExemptPath(absPath, cwd, pat, platform)) return true;
  }
  return false;
}

function isDenseMinifiedChunk(buf, bytesRead) {
  if (bytesRead < 1024) return false;
  let newlineCount = 0;
  let curLineLen = 0;
  let maxLineLen = 0;
  for (let i = 0; i < bytesRead; i++) {
    if (buf[i] === 0x0a) {
      newlineCount++;
      if (curLineLen > maxLineLen) maxLineLen = curLineLen;
      curLineLen = 0;
    } else {
      curLineLen++;
    }
  }
  if (curLineLen > maxLineLen) maxLineLen = curLineLen;
  const linesInSample = newlineCount + (buf[bytesRead - 1] !== 0x0a ? 1 : 0);
  const avgLineBytes = bytesRead / Math.max(1, linesInSample);
  return avgLineBytes > 512 && maxLineLen > 1024;
}

/** Per-invocation memoized file reader: eliminates duplicate realpathSync & full-file readFileSync calls */
export function createFileReadContext(absPath, fileSize = 0) {
  return {
    absPath,
    fileSize,
    _realPathLoaded: false,
    _realPath: absPath,
    _bufLoaded: false,
    _buf: null,
    _rangeBytesCache: new Map(),
    _remainingBytesCache: new Map(),
    _lineCountCache: null,
    getRealPath() {
      if (!this._realPathLoaded) {
        this._realPathLoaded = true;
        try {
          this._realPath = fs.realpathSync(this.absPath);
        } catch {
          this._realPath = this.absPath;
        }
      }
      return this._realPath;
    },
    getBuffer() {
      if (this.fileSize > MAX_SLICE_MEASURE_BYTES) return null;
      if (!this._bufLoaded) {
        this._bufLoaded = true;
        try {
          this._buf = fs.readFileSync(this.absPath);
        } catch {
          this._buf = null;
        }
      }
      return this._buf;
    }
  };
}

/** Probe 4 KB head (plus midpoint & tail when >8 KB) to detect minified / single-line dense text even behind >4 KB license headers */
function probeMinifiedHead(absPath, fileSize = 0, readCtx = null) {
  try {
    if (readCtx && readCtx._bufLoaded && readCtx._buf) {
      const cached = readCtx._buf;
      const totalSize = cached.length;
      if (totalSize === 0) return false;
      const headSlice = cached.subarray(0, Math.min(4096, totalSize));
      if (isDenseMinifiedChunk(headSlice, headSlice.length)) return true;
      if (totalSize > 8192) {
        const midOffset = Math.max(4096, Math.floor((totalSize - 4096) / 2));
        const midSlice = cached.subarray(midOffset, Math.min(totalSize, midOffset + 4096));
        if (isDenseMinifiedChunk(midSlice, midSlice.length)) {
          const tailOffset = Math.max(4096, totalSize - 4096);
          const tailSlice = cached.subarray(tailOffset, totalSize);
          if (isDenseMinifiedChunk(tailSlice, tailSlice.length)) return true;
        }
      }
      return false;
    }
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.allocUnsafe(4096);
    try {
      const headRead = fs.readSync(fd, buf, 0, 4096, 0);
      if (isDenseMinifiedChunk(buf, headRead)) return true;
      const totalSize = fileSize > 0 ? fileSize : fs.fstatSync(fd).size;
      if (totalSize > 8192) {
        const midOffset = Math.max(4096, Math.floor((totalSize - 4096) / 2));
        const midRead = fs.readSync(fd, buf, 0, 4096, midOffset);
        if (isDenseMinifiedChunk(buf, midRead)) {
          const tailOffset = Math.max(4096, totalSize - 4096);
          const tailRead = fs.readSync(fd, buf, 0, 4096, tailOffset);
          if (isDenseMinifiedChunk(buf, tailRead)) return true;
        }
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Classify non-binary file into Tier 1 ("noise"), Tier 2 ("source"), or Tier 3 ("review") */
export function classifyFileTier(
  absPath,
  ext,
  fileSize,
  noiseProbeThreshold = DEFAULT_NOISE_MAX_READ_BYTES,
  readCtx = null
) {
  const lowerExt = (ext || "").toLowerCase();
  const baseLower = path.basename(absPath || "").toLowerCase();

  let realAbsPath = absPath;
  if (readCtx) {
    realAbsPath = readCtx.getRealPath();
  } else {
    try {
      realAbsPath = fs.realpathSync(absPath);
    } catch {}
  }
  const realExt = realAbsPath !== absPath ? path.extname(realAbsPath).toLowerCase() : lowerExt;
  const realBaseLower = realAbsPath !== absPath ? path.basename(realAbsPath).toLowerCase() : baseLower;

  const isNoiseByName = (e, b) =>
    NOISE_EXTENSIONS.has(e) || NOISE_LOCK_BASENAMES.has(b) || NOISE_SUFFIXES.some((suf) => b.endsWith(suf));

  if (isNoiseByName(lowerExt, baseLower) || isNoiseByName(realExt, realBaseLower)) {
    const isMinifiedContent =
      NOISE_SUFFIXES.some((suf) => baseLower.endsWith(suf)) ||
      NOISE_SUFFIXES.some((suf) => realBaseLower.endsWith(suf));
    return { tier: "noise", isMinifiedContent };
  }

  if (REVIEW_DIFF_EXTENSIONS.has(lowerExt)) {
    return { tier: "review", isMinifiedContent: false };
  }

  if (noiseProbeThreshold > 0 && fileSize > noiseProbeThreshold && probeMinifiedHead(absPath, fileSize, readCtx)) {
    return { tier: "noise", isMinifiedContent: true };
  }

  return { tier: "source", isMinifiedContent: false };
}

function isPathInsideWorkspaceRoots(targetPath, payloadCwd, workspacePaths = []) {
  if (!targetPath) return true;
  const roots = [];
  if (Array.isArray(workspacePaths)) {
    for (const r of workspacePaths) {
      if (typeof r === "string" && r.trim()) roots.push(r.trim());
    }
  }
  if (typeof payloadCwd === "string" && payloadCwd.trim()) roots.push(payloadCwd.trim());
  if (roots.length === 0) return true;
  const norm = (p) => {
    const resolved = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const targetNorm = norm(targetPath);
  for (const root of roots) {
    const rootNorm = norm(root);
    if (!rootNorm) continue;
    if (targetNorm === rootNorm || targetNorm.startsWith(rootNorm + "/")) {
      return true;
    }
  }
  return false;
}

function isUserAttachedFile(filePath, absPath) {
  const normalized = (absPath || filePath || "").replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.user_uploaded/") ||
    normalized.includes("/user_uploaded/") ||
    normalized.includes("/.system_generated/uploads/")
  );
}

const AGENT_PLUGIN_INSTRUCTION_RE =
  /(?:^|\/)(?:\.gemini\/config|\.agents)\/plugins\/[^/]+\/(?:skills|rules|agents)\//;
const LEGACY_AGENT_INSTRUCTION_RE = /(?:^|\/)\.agent\/(?:skills|rules|agents)\//;

/** Exempt Antigravity's own skills, rules, agents, and builtin manuals so agents can read instructions whole */
export function isAgentInstructionFile(filePath, absPath) {
  const raw = (absPath || filePath || "").replace(/\\/g, "/");
  const lower = raw.toLowerCase();
  const base = path.posix.basename(lower);
  if (AGENT_INSTRUCTION_BASENAMES.has(base)) {
    return true;
  }
  return (
    lower.includes("/.gemini/antigravity/builtin/") ||
    lower.includes("/.gemini/config/skills/") ||
    lower.includes("/.gemini/config/rules/") ||
    lower.includes("/.gemini/config/agents/") ||
    lower.includes("/.gemini/antigravity-cli/skills/") ||
    lower.includes("/.gemini/skills/") ||
    lower.includes("/.agents/skills/") ||
    lower.includes("/.agents/rules/") ||
    lower.includes("/.agents/agents/") ||
    AGENT_PLUGIN_INSTRUCTION_RE.test(lower) ||
    LEGACY_AGENT_INSTRUCTION_RE.test(lower)
  );
}

function isBinaryFile(absPath, ext, readCtx = null) {
  const lowerExt = (ext || "").toLowerCase();
  if (KNOWN_TEXT_EXTENSIONS.has(lowerExt)) return false;
  if (BINARY_EXTENSIONS.has(lowerExt)) return true;
  try {
    if (readCtx && readCtx._bufLoaded && readCtx._buf) {
      const cached = readCtx._buf;
      const bytesRead = Math.min(512, cached.length);
      if (bytesRead === 0) return false;
      if (bytesRead >= 2 && ((cached[0] === 0xff && cached[1] === 0xfe) || (cached[0] === 0xfe && cached[1] === 0xff))) return false;
      if (bytesRead >= 3 && cached[0] === 0xef && cached[1] === 0xbb && cached[2] === 0xbf) return false;
      if (bytesRead >= 4 && cached[0] === 0x25 && cached[1] === 0x50 && cached[2] === 0x44 && cached[3] === 0x46) return true;
      for (let i = 0; i < bytesRead; i++) {
        if (cached[i] === 0) return true;
      }
      return false;
    }
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.allocUnsafe(512);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (bytesRead === 0) return false;
    if (bytesRead >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
    if (bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return false;
    if (bytesRead >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {}
  return false;
}

export { resolveSharedSessionId, resolveDirectConversationId };

export function hasExplicitConversationId(payload = {}, env = process.env) {
  const raw =
    payload.conversationId ||
    payload.conversation_id ||
    payload.common?.conversationId ||
    payload.common?.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    env?.ANTIGRAVITY_CONVERSATION_ID ||
    "";
  return typeof raw === "string" && raw.trim().length > 0 && raw.trim() !== "default";
}

const SUBAGENT_ROLE_GUARD_RE =
  /(?:^|[-_\s/])(?:sub[-_]?agent|worker|monitor|swarm|research(?:er)?|verifier|review(?:er)?|explor(?:er|e)|audit(?:or)?|investigat(?:or)?|browser|image[-_]?generator)(?:$|[-_\s/])|^(?:DeepCoder|DeepInvestigator)[A-Za-z0-9_-]*$/i;
const PRIMARY_HOST_ROLE_RE = /^(?:antigravity|main|default|primary|chat|user|assistant|cascade|coordinator)$/i;

export function isSubagentReadPayload(payload = {}, env = process.env) {
  if (env?.ANTIGRAVITY_PARENT_CONVERSATION_ID) return true;
  const envSub = String(env?.ANTIGRAVITY_SUBAGENT || "").trim().toLowerCase();
  if (envSub === "1" || envSub === "true") return true;
  const envSwarmWorker = String(env?.ANTIGRAVITY_SWARM_WORKER || "").trim().toLowerCase();
  if (envSwarmWorker === "1" || envSwarmWorker === "true") return true;
  if (!payload || typeof payload !== "object") return false;
  const common = payload.common && typeof payload.common === "object" && !Array.isArray(payload.common) ? payload.common : null;
  const meta = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata) ? payload.metadata : null;
  for (const bag of [payload, common, meta]) {
    if (!bag) continue;
    if (
      bag.subagent === true ||
      bag.isSubagent === true ||
      bag.is_subagent === true ||
      bag.swarmWorker === true ||
      bag.isSwarmWorker === true ||
      bag.is_swarm_worker === true
    ) {
      return true;
    }
    if (
      (typeof bag.subagentId === "string" && bag.subagentId.trim()) ||
      (typeof bag.subagent_id === "string" && bag.subagent_id.trim())
    ) {
      return true;
    }
    const workerName = [bag.workerName, bag.worker_name, bag.rosterName, bag.roster_name]
      .find((v) => typeof v === "string" && v.trim());
    if (workerName && !PRIMARY_HOST_ROLE_RE.test(workerName.trim())) {
      return true;
    }
    const swarmObj = bag.swarm && typeof bag.swarm === "object" && !Array.isArray(bag.swarm) ? bag.swarm : null;
    if (swarmObj) {
      if (swarmObj.isWorker === true || swarmObj.is_worker === true) return true;
      const swRole = typeof swarmObj.role === "string" ? swarmObj.role.trim() : "";
      if (swRole && !PRIMARY_HOST_ROLE_RE.test(swRole) && SUBAGENT_ROLE_GUARD_RE.test(swRole)) return true;
      const swName = [swarmObj.workerName, swarmObj.worker_name, swarmObj.name]
        .find((v) => typeof v === "string" && v.trim());
      if (swName && !PRIMARY_HOST_ROLE_RE.test(swName.trim()) && swRole.toLowerCase() !== "coordinator") {
        return true;
      }
    }
    const depth = Number(bag.nestingDepth ?? bag.nesting_depth);
    if (Number.isFinite(depth) && depth > 0) return true;
    if (
      bag.parentConversationId ||
      bag.parent_conversation_id ||
      bag.parentSessionId ||
      bag.parent_session_id
    ) {
      return true;
    }
  }
  const rootId =
    payload.rootConversationId ||
    payload.root_conversation_id ||
    common?.rootConversationId ||
    common?.root_conversation_id ||
    meta?.rootConversationId ||
    meta?.root_conversation_id ||
    "";
  const convId =
    payload.conversationId ||
    payload.conversation_id ||
    common?.conversationId ||
    common?.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    "";
  if (rootId && convId && rootId !== convId) return true;
  const roleCandidates = [
    payload.role,
    payload.agentRole,
    payload.agent_role,
    payload.agentType,
    payload.agent_type,
    payload.agentName,
    payload.agent_name,
    payload.swarmRole,
    payload.swarm_role,
    payload.sessionType,
    payload.session_type,
    payload.sessionKind,
    payload.session_kind,
    common?.role,
    common?.agentName,
    common?.agent_name,
    common?.swarmRole,
    common?.swarm_role,
    meta?.role,
    meta?.agentRole,
    meta?.agent_role,
    meta?.agentType,
    meta?.agent_type,
    meta?.agentName,
    meta?.agent_name,
    meta?.swarmRole,
    meta?.swarm_role
  ];
  for (const candidate of roleCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const clean = candidate.trim();
      if (!PRIMARY_HOST_ROLE_RE.test(clean) && (clean.toLowerCase() === "self" || SUBAGENT_ROLE_GUARD_RE.test(clean))) {
        return true;
      }
    }
  }
  return false;
}

export function resolveSubagentId(payload = {}) {
  return cleanStringArg(
    payload.subagentId ||
      payload.subagent_id ||
      payload.metadata?.subagentId ||
      payload.metadata?.subagent_id ||
      ""
  );
}

function hash8(val) {
  return createHash("sha256").update(String(val ?? ""), "utf8").digest("hex").slice(0, 8);
}

/**
 * 5-branch isolation matrix for 2-strike confirm keys (both large_read_confirm and sensitive_read_confirm):
 *   1. Independent explicit conversation -> conv:<directConvId> (120s TTL, refresh on allow)
 *   2. Shares parent convId + explicit subagentId -> sub:<directConvId>:<subIdHash8> (120s TTL, refresh on allow)
 *   3. Shares parent convId without subagentId -> sub:<directConvId>:<agentHash8> (30s TTL, do not consume)
 *   4. Only parent/root convId (no direct convId) -> sub:<sessionId>:<subIdOrAgentHash8> (30s TTL, consume iff subId)
 *   5. Pure anonymous call -> anon:<cwdHash8> (30s TTL, consume on allow)
 */
export function buildConfirmScope({
  directConvId,
  sessionId,
  hasExplicitConvId,
  subagentSharesParentContext,
  subagentId,
  agentName,
  cwd
}) {
  if (hasExplicitConvId && !subagentSharesParentContext) {
    return {
      scopeKey: `conv:${directConvId}`,
      ttlMs: LARGE_READ_CONFIRM_TTL_MS,
      consumeOnAllow: false,
      refreshOnAllow: true
    };
  }
  if (hasExplicitConvId && subagentSharesParentContext && subagentId) {
    return {
      scopeKey: `sub:${directConvId}:${hash8(subagentId)}`,
      ttlMs: LARGE_READ_CONFIRM_TTL_MS,
      consumeOnAllow: false,
      refreshOnAllow: true
    };
  }
  if (hasExplicitConvId && subagentSharesParentContext) {
    return {
      scopeKey: `sub:${directConvId}:${hash8(agentName || "subagent")}`,
      ttlMs: LARGE_READ_CONFIRM_SHORT_TTL_MS,
      consumeOnAllow: false,
      refreshOnAllow: false
    };
  }
  if (sessionId && sessionId !== "default") {
    const subTag = subagentId ? hash8(subagentId) : hash8(agentName || "subagent");
    return {
      scopeKey: `sub:${sessionId}:${subTag}`,
      ttlMs: LARGE_READ_CONFIRM_SHORT_TTL_MS,
      consumeOnAllow: Boolean(subagentId),
      refreshOnAllow: false
    };
  }
  return {
    scopeKey: `anon:${hash8(cwd || process.cwd())}`,
    ttlMs: LARGE_READ_CONFIRM_SHORT_TTL_MS,
    consumeOnAllow: true,
    refreshOnAllow: false
  };
}

export function resolveAgentName(payload = {}) {
  return (
    payload.agent ||
    payload.agentName ||
    payload.agent_name ||
    payload.agentType ||
    payload.agent_type ||
    payload.role ||
    (payload.subagent ? "subagent" : "antigravity")
  );
}

function recordInterception({
  sessionId,
  agent,
  cwd,
  toolName,
  path: targetPath,
  size,
  reason,
  kind = "interception",
  key = "blocked",
  returnedBytes = 0
}) {
  try {
    const st = getSharedStore();
    const effectiveSid =
      typeof st.resolveRootSessionId === "function"
        ? st.resolveRootSessionId(sessionId || "default")
        : sessionId || "default";
    st.recordEvent({
      sessionId: effectiveSid,
      worktree: cwd || process.cwd(),
      agent: agent || "antigravity",
      kind,
      tool: toolName,
      key,
      path: targetPath || null,
      ok: kind === "dedup" ? 1 : 0,
      exitCode: kind === "dedup" ? 0 : 1,
      bytes: size || 0,
      body: reason,
      sandboxBytes: size || 0,
      returnedBytes: returnedBytes || 0
    });
  } catch {}
}

function readUtf8TextSafe(absPath, readCtx = null) {
  try {
    const buf =
      readCtx && readCtx.fileSize <= MAX_SLICE_MEASURE_BYTES ? readCtx.getBuffer() : fs.readFileSync(absPath);
    if (!buf) return null;
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
      return null;
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Measure UTF-8 byte length of 1-based inclusive line range [startLine..endLine] with exactness metadata */
function measureLineRangeDetailed(absPath, startLine, endLine, fileSize, fallbackBytes, readCtx = null) {
  if (endLine === null || endLine === undefined) {
    return { bytes: fallbackBytes, exact: false, kind: "fallback" };
  }
  const sLine = Math.max(1, Number(startLine) || 1);
  const eLine = Number(endLine);
  if (!Number.isFinite(eLine) || eLine < sLine) {
    return { bytes: 0, exact: false, kind: "fallback" };
  }
  const cacheKey = `${sLine}:${eLine}`;
  if (readCtx && readCtx._rangeBytesCache.has(cacheKey)) {
    const cached = readCtx._rangeBytesCache.get(cacheKey);
    if (cached && typeof cached === "object") return cached;
  }
  const memo = (res) => {
    if (readCtx) readCtx._rangeBytesCache.set(cacheKey, res);
    return res;
  };
  try {
    if (fileSize <= MAX_SLICE_MEASURE_BYTES) {
      const buf = readCtx ? readCtx.getBuffer() : fs.readFileSync(absPath);
      if (!buf) return { bytes: fallbackBytes, exact: false, kind: "fallback" };
      if (buf.length === 0) return memo({ bytes: 0, exact: true, kind: "exact" });
      let lineNum = 1;
      let rangeStart = sLine === 1 ? 0 : null;
      let rangeEnd = buf.length;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          if (lineNum === eLine) {
            rangeEnd = i + 1;
            break;
          }
          lineNum++;
          if (lineNum === sLine) {
            rangeStart = i + 1;
          }
        }
      }
      if (rangeStart === null) return memo({ bytes: 0, exact: true, kind: "exact" });
      return memo({ bytes: Math.max(0, rangeEnd - rangeStart), exact: true, kind: "exact" });
    }

    // Bounded streaming scan (<= 2 MB) eliminates the >2 MB && sLine > 1 blind spot without risking OOM
    const CHUNK_SIZE = 65536;
    const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
    const fd = fs.openSync(absPath, "r");
    let scannedBytes = 0;
    let scannedNewlines = 0;
    let lineNum = 1;
    let rangeStart = sLine === 1 ? 0 : null;
    let rangeEnd = null;
    let hitCap = false;
    try {
      while (scannedBytes < MAX_SLICE_MEASURE_BYTES) {
        const toRead = Math.min(CHUNK_SIZE, MAX_SLICE_MEASURE_BYTES - scannedBytes);
        const bytesRead = fs.readSync(fd, chunk, 0, toRead, scannedBytes);
        if (bytesRead <= 0) break;
        for (let i = 0; i < bytesRead; i++) {
          if (chunk[i] === 0x0a) {
            scannedNewlines++;
            if (lineNum === eLine) {
              rangeEnd = scannedBytes + i + 1;
              break;
            }
            lineNum++;
            if (lineNum === sLine) {
              rangeStart = scannedBytes + i + 1;
            }
          }
        }
        scannedBytes += bytesRead;
        if (rangeEnd !== null) break;
        if (rangeStart !== null && scannedBytes - rangeStart > 262144) {
          rangeEnd = scannedBytes;
          hitCap = true;
          break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    if (rangeStart !== null) {
      if (rangeEnd !== null && !hitCap) {
        return memo({ bytes: Math.max(0, rangeEnd - rangeStart), exact: true, kind: "exact" });
      }
      if (scannedBytes >= fileSize && !hitCap) {
        return memo({ bytes: Math.max(0, scannedBytes - rangeStart), exact: true, kind: "exact" });
      }
      const partialBytes = Math.max(0, (rangeEnd !== null ? rangeEnd : scannedBytes) - rangeStart);
      if (hitCap) {
        return memo({ bytes: partialBytes, exact: false, kind: "lower_bound" });
      }
      const avgLineBytes = scannedBytes / Math.max(1, scannedNewlines + 1);
      const remainingLines = Math.max(1, eLine - lineNum + 1);
      const estTotal = Math.min(fileSize, Math.round(partialBytes + avgLineBytes * remainingLines));
      return memo({ bytes: Math.max(partialBytes, estTotal), exact: false, kind: "lower_bound" });
    }
    if (scannedBytes >= fileSize) {
      return memo({ bytes: 0, exact: true, kind: "exact" });
    }
    const avgLineBytes = scannedBytes / Math.max(1, scannedNewlines + 1);
    const span = Math.max(1, eLine - sLine + 1);
    return memo({
      bytes: Math.max(fallbackBytes, Math.min(fileSize, Math.round(avgLineBytes * span))),
      exact: false,
      kind: "estimated"
    });
  } catch {
    return { bytes: fallbackBytes, exact: false, kind: "fallback" };
  }
}

/** Measure UTF-8 byte length of 1-based inclusive line range [startLine..endLine] (bounded <=2 MB streaming for huge files) */
function measureLineRangeBytes(absPath, startLine, endLine, fileSize, fallbackBytes, readCtx = null) {
  return measureLineRangeDetailed(absPath, startLine, endLine, fileSize, fallbackBytes, readCtx).bytes;
}

/** Measure remaining UTF-8 bytes from 1-based startLine to EOF (used for open-ended StartLine continuations) */
function measureRemainingFromLineBytes(absPath, startLine, fileSize, readCtx = null) {
  const sLine = Math.max(1, Number(startLine) || 1);
  if (sLine <= 1) return fileSize;
  if (fileSize > MAX_SLICE_MEASURE_BYTES) return fileSize;
  if (readCtx && readCtx._remainingBytesCache.has(sLine)) {
    return readCtx._remainingBytesCache.get(sLine);
  }
  const memo = (val) => {
    if (readCtx) readCtx._remainingBytesCache.set(sLine, val);
    return val;
  };
  try {
    const buf = readCtx ? readCtx.getBuffer() : fs.readFileSync(absPath);
    if (!buf) return fileSize;
    if (buf.length === 0) return memo(0);
    let lineNum = 1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        lineNum++;
        if (lineNum === sLine) {
          return memo(Math.max(0, buf.length - (i + 1)));
        }
      }
    }
    return memo(0);
  } catch {
    return fileSize;
  }
}

/** Count exact lines (<= 2 MB) or estimate lines (> 2 MB) for actionable deny/soft-guard guidance */
function countFileLinesApprox(absPath, fileSize, readCtx = null) {
  if (readCtx && readCtx._lineCountCache !== null) {
    return readCtx._lineCountCache;
  }
  try {
    if (fileSize <= MAX_SLICE_MEASURE_BYTES) {
      const buf = readCtx ? readCtx.getBuffer() : fs.readFileSync(absPath);
      if (!buf) return { lines: 0, exact: false };
      if (buf.length === 0) {
        const res = { lines: 0, exact: true };
        if (readCtx) readCtx._lineCountCache = res;
        return res;
      }
      let nl = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) nl++;
      }
      const lines = nl + (buf[buf.length - 1] !== 0x0a ? 1 : 0);
      const res = { lines, exact: true };
      if (readCtx) readCtx._lineCountCache = res;
      return res;
    }
    const sampleSize = 65536;
    const buf = Buffer.allocUnsafe(sampleSize);
    const fd = fs.openSync(absPath, "r");
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, sampleSize, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (bytesRead <= 0) return { lines: 0, exact: false };
    let nl = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x0a) nl++;
    }
    const avg = bytesRead / Math.max(1, nl + 1);
    const res = { lines: Math.max(1, Math.round(fileSize / avg)), exact: false };
    if (readCtx) readCtx._lineCountCache = res;
    return res;
  } catch {
    return { lines: 0, exact: false };
  }
}

/**
 * Compute the effective inclusive end line that the host `read_file` tool will actually return
 * (Antigravity truncates at max 800 lines or 46,080 bytes), so read-dedup & diff-read never
 * record unread lines as EOF (`-1`) and falsely block subsequent paginated reads.
 */
export function computeEffectiveReadBounds(
  absPath,
  startLine,
  requestedEndLine,
  fileSize,
  maxHostLines = HOST_READ_MAX_LINES,
  maxHostBytes = HOST_READ_MAX_BYTES,
  readCtx = null
) {
  const sLine = Math.max(1, Number(startLine) || 1);
  const reqEnd = Number.isFinite(requestedEndLine) && requestedEndLine > 0 ? Math.floor(requestedEndLine) : null;
  const lineCapEnd = sLine + maxHostLines - 1;

  if (reqEnd !== null && reqEnd <= lineCapEnd && fileSize <= maxHostBytes) {
    return { effectiveEndLine: reqEnd, hostTruncated: false, skipCache: false };
  }

  if (fileSize > MAX_SLICE_MEASURE_BYTES) {
    return {
      effectiveEndLine: reqEnd !== null ? Math.min(reqEnd, lineCapEnd) : lineCapEnd,
      hostTruncated: true,
      skipCache: true
    };
  }

  try {
    const buf = readCtx ? readCtx.getBuffer() : fs.readFileSync(absPath);
    if (!buf) {
      return {
        effectiveEndLine: reqEnd !== null ? Math.min(reqEnd, lineCapEnd) : lineCapEnd,
        hostTruncated: true,
        skipCache: true
      };
    }
    if (buf.length === 0) {
      return { effectiveEndLine: reqEnd, hostTruncated: false, skipCache: false };
    }
    let lineNum = 1;
    let pos = 0;
    while (lineNum < sLine && pos < buf.length) {
      if (buf[pos] === 0x0a) lineNum++;
      pos++;
    }
    if (lineNum < sLine || pos >= buf.length) {
      return { effectiveEndLine: reqEnd, hostTruncated: false, skipCache: false };
    }

    let linesIncluded = 0;
    let bytesIncluded = 0;
    let lastCompleteLine = sLine - 1;
    let hitLineCap = false;
    let hitByteCap = false;
    let lineStart = pos;

    while (pos <= buf.length) {
      const atEnd = pos === buf.length;
      const isNl = !atEnd && buf[pos] === 0x0a;
      if (isNl || atEnd) {
        if (atEnd && pos === lineStart) break;
        const lineEnd = isNl ? pos + 1 : pos;
        const lineBytes = lineEnd - lineStart;
        const curLineNum = sLine + linesIncluded;

        if (reqEnd !== null && curLineNum > reqEnd) {
          break;
        }
        if (linesIncluded >= maxHostLines) {
          hitLineCap = true;
          break;
        }
        if (bytesIncluded + lineBytes > maxHostBytes) {
          hitByteCap = true;
          break;
        }
        bytesIncluded += lineBytes;
        linesIncluded++;
        lastCompleteLine = curLineNum;
        lineStart = lineEnd;
        if (atEnd) break;
      }
      pos++;
    }

    if (hitByteCap) {
      if (lastCompleteLine < sLine) {
        return { effectiveEndLine: sLine, hostTruncated: true, skipCache: true };
      }
      return { effectiveEndLine: lastCompleteLine, hostTruncated: true, skipCache: false };
    }
    if (hitLineCap) {
      return { effectiveEndLine: lastCompleteLine, hostTruncated: true, skipCache: false };
    }
    return { effectiveEndLine: reqEnd, hostTruncated: false, skipCache: false };
  } catch {
    return {
      effectiveEndLine: reqEnd !== null ? Math.min(reqEnd, lineCapEnd) : lineCapEnd,
      hostTruncated: true,
      skipCache: true
    };
  }
}

/** Build a shell-safe PreToolUse.overwrite command wrapping a noisy CLI command via cli-filter.mjs */
export function buildCliFilterRewrite(commandLine, sessionId = "default", cwd = process.cwd(), matchOptions = {}) {
  if (!matchFilterRuleFn) return null;
  const matched = matchFilterRuleFn(commandLine, { cwd, ...matchOptions });
  if (!matched) return null;
  const scriptPosix = CLI_FILTER_SCRIPT.replace(/\\/g, "/");
  // Bail out if plugin install path itself has shell-special characters
  if (/["$`\r\n]/.test(scriptPosix)) return null;

  const enc = (s) => `b:${Buffer.from(s, "utf8").toString("base64url")}`;
  const b64 = enc(matched.effectiveCommand);
  const origB64 = enc(commandLine.trim());
  const sessB64 = enc(sessionId || "default");
  const noteFlag = matched.note ? ` --note ${enc(matched.note)}` : "";

  return {
    ruleId: matched.rule.id,
    rewrittenCommand: `node "${scriptPosix}" --rule ${matched.rule.id} --b64 ${b64} --orig-b64 ${origB64} --session ${sessB64}${noteFlag}`,
    note: matched.note
  };
}

function extractFileDumpTargets(cmdAfterVerb) {
  const targets = [];
  const psValueFlags = new Set([
    "-encoding",
    "-delimiter",
    "-readcount",
    "-filter",
    "-include",
    "-exclude",
    "-stream",
    "-credential"
  ]);
  let i = 0;
  const len = cmdAfterVerb.length;
  let afterDoubleDash = false;
  let skipNextValue = false;
  while (i < len) {
    while (i < len && /\s/.test(cmdAfterVerb[i])) i++;
    if (i >= len || /[;|&]/.test(cmdAfterVerb[i])) break;
    let tok = "";
    let wasQuoted = false;
    while (i < len && !/\s/.test(cmdAfterVerb[i])) {
      const ch = cmdAfterVerb[i];
      if (/[;|&]/.test(ch)) break;
      if (ch === '"' || ch === "'") {
        wasQuoted = true;
        const q = ch;
        i++;
        while (i < len && cmdAfterVerb[i] !== q) {
          tok += cmdAfterVerb[i];
          i++;
        }
        if (i < len && cmdAfterVerb[i] === q) i++;
      } else {
        tok += ch;
        i++;
      }
    }
    if (skipNextValue) {
      if (tok || wasQuoted) {
        skipNextValue = false;
        continue;
      }
    }
    if (!tok) continue;
    if (!afterDoubleDash && !wasQuoted) {
      if (tok === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (tok.startsWith("-")) {
        const lowerTok = tok.toLowerCase();
        if (lowerTok === "-path" || lowerTok === "-literalpath") {
          continue;
        }
        if (psValueFlags.has(lowerTok)) {
          skipNextValue = true;
          continue;
        }
        continue;
      }
    }
    targets.push(tok);
  }
  return targets;
}

function scanDoubleQuotedEnd(cmd, openIdx) {
  const len = cmd.length;
  let k = openIdx + 1;
  while (k < len) {
    const c = cmd[k];
    if (c === "`" && k + 1 < len) {
      k += 2;
      continue;
    }
    if (c === "\\" && k + 1 < len) {
      if (cmd[k + 1] === "\\" && k + 2 < len && cmd[k + 2] === '"') {
        return k + 3;
      }
      if (cmd[k + 1] === '"') {
        const innerSoFar = cmd.slice(openIdx + 1, k + 1);
        const isWinDirPath = /^(?:[A-Za-z]:\\|\\\\|\.\.?\\)[^"<>|*?]*$/.test(innerSoFar);
        if (isWinDirPath || cmd.indexOf('"', k + 2) === -1) {
          return k + 2;
        }
        k += 2;
        continue;
      }
      k += 2;
      continue;
    }
    if (c === '"') {
      if (k > openIdx + 1 && k + 1 < len && cmd[k + 1] === '"') {
        k += 2;
        continue;
      }
      return k + 1;
    }
    k += 1;
  }
  return len;
}

function scanSingleQuotedEnd(cmd, openIdx) {
  const len = cmd.length;
  let k = openIdx + 1;
  while (k < len) {
    if (cmd[k] === "'") {
      if (k > openIdx + 1 && k + 1 < len && cmd[k + 1] === "'") {
        k += 2;
        continue;
      }
      return k + 1;
    }
    k += 1;
  }
  return len;
}

function stripQuotedCommandLiterals(cmd) {
  if (!cmd) return "";
  let out = "";
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    const ch = cmd[i];
    if (ch === '"') {
      out += '""';
      i = scanDoubleQuotedEnd(cmd, i);
      continue;
    }
    if (ch === "'") {
      out += '""';
      i = scanSingleQuotedEnd(cmd, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function splitTopLevelCommandSegments(cmd) {
  if (!cmd || typeof cmd !== "string") return [];
  const segments = [];
  let start = 0;
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    const ch = cmd[i];
    if (ch === '"') {
      i = scanDoubleQuotedEnd(cmd, i);
      continue;
    }
    if (ch === "'") {
      i = scanSingleQuotedEnd(cmd, i);
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      i += 1;
      while (i < len && depth > 0) {
        if (cmd[i] === '"') {
          i = scanDoubleQuotedEnd(cmd, i);
          continue;
        }
        if (cmd[i] === "'") {
          i = scanSingleQuotedEnd(cmd, i);
          continue;
        }
        if (cmd[i] === "(") depth += 1;
        else if (cmd[i] === ")") depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      const seg = cmd.slice(start, i).trim();
      if (seg) segments.push(seg);
      i++;
      start = i;
      continue;
    }
    if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
      const seg = cmd.slice(start, i).trim();
      if (seg) segments.push(seg);
      i += 2;
      start = i;
      continue;
    }
    i++;
  }
  const tail = cmd.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

function parseLeadingLooseGitSubcommand(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  let i = 0;
  const len = cmd.length;
  const nextTok = () => {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) return null;
    const start = i;
    let val = "";
    while (i < len && !/\s/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === "|" || ch === ";" || ch === "&") {
        if (i === start) return null;
        break;
      }
      if (ch === "'" || ch === '"') {
        const q = ch;
        i++;
        while (i < len && cmd[i] !== q) {
          if (q === '"' && cmd[i] === "\\" && i + 1 < len) {
            val += cmd[i + 1];
            i += 2;
            continue;
          }
          val += cmd[i];
          i++;
        }
        if (i < len && cmd[i] === q) i++;
      } else {
        val += ch;
        i++;
      }
    }
    return { val, end: i };
  };
  const first = nextTok();
  if (!first || !/^(?:.*[\\/])?git(?:\.exe)?$/i.test(first.val)) return null;
  const valueFlags = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);
  for (let step = 0; step < 24; step++) {
    const t = nextTok();
    if (!t) return null;
    if (valueFlags.has(t.val)) {
      if (!nextTok()) return null;
      continue;
    }
    if (t.val.startsWith("-")) {
      continue;
    }
    return { subcommand: t.val.toLowerCase(), rest: cmd.slice(t.end) };
  }
  return null;
}

function inspectSingleCommandSegment({ commandLine, cwd, sessionId, shellDumpMaxBytes, sensitiveGuardMode, secMod }) {
  const cleanCmd = cleanStringArg(commandLine);
  if (!cleanCmd) return { shouldDeny: false };

  // 1. Unbounded git log (catches arbitrary global options like `git -c core.pager=cat log` or `git --no-optional-locks log`)
  const gitParsed = (parseGitSubcommandFn ? parseGitSubcommandFn(cleanCmd) : null) || parseLeadingLooseGitSubcommand(cleanCmd);
  const isGitLog = Boolean(gitParsed && gitParsed.subcommand === "log");
  if (isGitLog) {
    const gitLogArgs = gitParsed.rest;
    const unquotedGitRest = stripQuotedCommandLiterals(gitLogArgs);
    const isLimited =
      /(?:^|\s)(?:-n\s*\d+|-\d+|--max-count(?:=|\s)\d+|--since(?:=|\s)\S+|--after(?:=|\s)\S+|\S+\.\.\S+)(?=\s|$)/i.test(
        gitLogArgs
      ) || /\s*\|\s*(?:head|Select-Object|select|more)\b/i.test(unquotedGitRest);
    if (!isLimited) {
      return {
        shouldDeny: true,
        reason:
          `[agy-dart protection] 'git log' without a count limiter risks dumping thousands of commits into context. ` +
          `Use ${FAST_SERVER} batch_search(type:"git", pattern:"log -n 10 --oneline"), add '-n 10', or run inside call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute").`,
        size: 32768,
        targetPath: "git log"
      };
    }
  }

  // Strip ALL stderr redirections (2>&1, 2>/dev/null, 2>NUL, 2>>err.log) before inspecting stdout redirects
  const cmdNoStderrRedir = cleanCmd.replace(
    /(?:^|\s)2>>?\s*(?:&\d+|"[^"]*"|'[^']*'|[^\s;|&]+)(?=\s|$|[;|&])/g,
    " "
  );
  const unquotedNoStderr = stripQuotedCommandLiterals(cmdNoStderrRedir);

  // 2. Direct curl / wget to stdout
  const fetchMatch = cleanCmd.match(/^\s*(curl|wget)(?:\.exe)?\b/i);
  if (fetchMatch) {
    const isCurl = fetchMatch[1].toLowerCase() === "curl";
    const writesToFile =
      />\s*[^>]/i.test(unquotedNoStderr) ||
      /(?:^|\s)(?:-o|-O|--output|--output-document)(?:=|\s+)(?!["']?-(?:["']?)(?:\s|$|[;|&]))(?:"[^"]+"|'[^']+'|\S+)/.test(
        cmdNoStderrRedir
      ) ||
      (isCurl && /(?:^|\s)(?:-O|--remote-name)(?=\s|$|[;|&])/.test(unquotedNoStderr));
    const hasLimiter = /\|\s*(head|Select-Object|select|more)\b/i.test(unquotedNoStderr);
    if (!writesToFile && !hasLimiter) {
      const urlMatch = cleanCmd.match(/https?:\/\/[^\s"']+/i);
      return {
        shouldDeny: true,
        reason:
          `[agy-dart protection] Direct curl/wget output to stdout risks flooding the context window. ` +
          `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute" or "ctx_index"), save to disk ('-o <file>'), or append '| head -n 50'.`,
        size: 32768,
        targetPath: urlMatch ? urlMatch[0] : cleanCmd
      };
    }
  }

  // 3. Raw file dump utilities (cat, Get-Content, gc; Windows-only `type`)
  const printMatch = cmdNoStderrRedir.match(/^\s*(cat|type|Get-Content|gc)(?:\.exe)?\b/i);
  if (printMatch) {
    const verb = printMatch[1].toLowerCase();
    if (verb === "type" && process.platform !== "win32") {
      return { shouldDeny: false };
    }

    const restAfterVerb = cmdNoStderrRedir.slice(printMatch[0].length);
    const rawTargets = extractFileDumpTargets(restAfterVerb);

    if (sensitiveGuardMode === "deny" && secMod) {
      for (const rawTarget of rawTargets) {
        if (!rawTarget || rawTarget.includes("*") || rawTarget.includes("?")) continue;
        const cleanTarget = cleanFilePath(rawTarget);
        if (!cleanTarget) continue;
        const absPath = path.isAbsolute(cleanTarget) ? cleanTarget : path.resolve(cwd, cleanTarget);
        let realAbsPath = absPath;
        try {
          realAbsPath = fs.realpathSync(absPath);
        } catch {}
        const sensDirect = secMod.detectSensitiveFile(absPath);
        const sensReal = realAbsPath !== absPath ? secMod.detectSensitiveFile(realAbsPath) : { sensitive: false, reason: null };
        const sens = sensDirect.sensitive ? sensDirect : sensReal;
        if (sens.sensitive) {
          return {
            shouldDeny: true,
            reason:
              `[agy-dart sensitive-file] Command attempts to dump sensitive file '${cleanTarget}' (${sens.reason}), blocked by AGY_DART_SENSITIVE_FILE_GUARD=deny.`,
            size: 4096,
            targetPath: cleanTarget
          };
        }
      }
    }

    const hasLimiter =
      /(-Head|-TotalCount|-First|-Tail)\s+\d+/i.test(unquotedNoStderr) ||
      /\|\s*(head|Select-Object|select\s+(-[a-zA-Z]+\s+)*-First|more|Out-Null|Set-Content|Out-File)\b/i.test(unquotedNoStderr) ||
      />\s*[^>]/i.test(unquotedNoStderr);

    if (hasLimiter) return { shouldDeny: false };

    let cumulativeNonExemptBytes = 0;
    for (const rawTarget of rawTargets) {
      if (rawTarget.includes("*") || rawTarget.includes("?")) {
        return {
          shouldDeny: true,
          reason:
            `[agy-dart protection] Wildcard file dump ('${rawTarget}') risks flooding the context window. ` +
            `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute") or append '| Select-Object -First 50'.`,
          size: 32768,
          targetPath: rawTarget
        };
      }

      const cleanTarget = cleanFilePath(rawTarget);
      const absPath = path.isAbsolute(cleanTarget) ? cleanTarget : path.resolve(cwd, cleanTarget);
      let checked = false;
      try {
        if (fs.existsSync(absPath)) {
          checked = true;
          let realAbsPath = absPath;
          try {
            realAbsPath = fs.realpathSync(absPath);
          } catch {}
          if (isAgentInstructionFile(rawTarget, absPath) && isAgentInstructionFile(realAbsPath, realAbsPath)) continue;
          const stat = fs.statSync(absPath);
          cumulativeNonExemptBytes += stat.size;
          if (shellDumpMaxBytes > 0 && (stat.size > shellDumpMaxBytes || cumulativeNonExemptBytes > shellDumpMaxBytes)) {
            const reportSize = Math.max(stat.size, cumulativeNonExemptBytes);
            return {
              shouldDeny: true,
              reason:
                `[agy-dart protection] Command attempts an un-paged dump of '${cleanTarget}' (${formatBytes(reportSize)}), ` +
                `exceeding the ${formatBytes(shellDumpMaxBytes)} shell dump limit. ` +
                `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute") or append '| Select-Object -First 50' / '-Head 50'.`,
              size: reportSize,
              targetPath: cleanTarget
            };
          }
        }
      } catch {}

      if (!checked) {
        return {
          shouldDeny: true,
          reason:
            `[agy-dart protection] Command matches an un-paged file dump ('${rawTarget}') that could flood the context window. ` +
            `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute") or append '| Select-Object -First 50' / '| head -n 50'.`,
          size: 32768,
          targetPath: cleanTarget || rawTarget
        };
      }
    }
  }

  return { shouldDeny: false };
}

function unquoteShellScriptArg(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("'") && s.endsWith("'") && scanSingleQuotedEnd(s, 0) === s.length) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"') && s.endsWith('"') && scanDoubleQuotedEnd(s, 0) === s.length) {
    return s
      .slice(1, -1)
      .replace(/`(["`$])/g, "$1")
      .replace(/\\(["\\])/g, "$1")
      .replace(/""/g, '"');
  }
  return s;
}

function extractBalancedParens(str, openParenIdx) {
  const len = str.length;
  let depth = 1;
  let k = openParenIdx + 1;
  while (k < len && depth > 0) {
    const ch = str[k];
    if (ch === '"') {
      k = scanDoubleQuotedEnd(str, k);
      continue;
    }
    if (ch === "'") {
      k = scanSingleQuotedEnd(str, k);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return { inner: str.slice(openParenIdx + 1, k).trim(), endIdx: k + 1 };
      }
    }
    k += 1;
  }
  return null;
}

function extractNestedShellCommands(seg) {
  const nested = [];
  if (!seg || typeof seg !== "string") return nested;

  // 1. Inline cmd.exe `/c ...`
  const cmdMatch = /^(?:.*[\\/])?cmd(?:\.exe)?\s+(?:\/[dDsSqQ]\s+)*\/[cC]\s+([\s\S]+)$/i.exec(seg);
  if (cmdMatch && cmdMatch[1]) {
    const inner = unquoteShellScriptArg(cmdMatch[1]);
    if (inner && inner !== seg) nested.push(inner);
  }

  // 2. Inline PowerShell / POSIX shell `-Command` / `-c`
  const shLead = /^(?:(?:"[^"]+"|'[^']+'|\S+)[\\/])?(powershell|pwsh|bash|sh|zsh|dash)(?:\.exe)?(?=["']?\s)/i.exec(seg);
  if (shLead) {
    const isPs = /^p(?:owershell|wsh)$/i.test(shLead[1]);
    const psValFlags = new Set(["-executionpolicy", "-ep", "-windowstyle", "-w", "-outputformat", "-of", "-inputformat", "-if"]);
    let pos = shLead[0].length;
    if (seg[pos] === '"' || seg[pos] === "'") pos += 1;
    const len = seg.length;
    while (pos < len) {
      while (pos < len && /\s/.test(seg[pos])) pos += 1;
      if (pos >= len) break;
      const tokStart = pos;
      while (pos < len && !/\s/.test(seg[pos])) {
        if (seg[pos] === '"') pos = scanDoubleQuotedEnd(seg, pos);
        else if (seg[pos] === "'") pos = scanSingleQuotedEnd(seg, pos);
        else pos += 1;
      }
      const tok = seg.slice(tokStart, pos);
      const lowerTok = tok.toLowerCase();
      if ((isPs && (lowerTok === "-command" || lowerTok === "-c")) || (!isPs && tok === "-c")) {
        const rawRest = seg.slice(pos).trim();
        const inner = unquoteShellScriptArg(rawRest);
        if (inner && inner !== seg) nested.push(inner);
        break;
      }
      if (isPs && psValFlags.has(lowerTok)) {
        while (pos < len && /\s/.test(seg[pos])) pos += 1;
        while (pos < len && !/\s/.test(seg[pos])) {
          if (seg[pos] === '"') pos = scanDoubleQuotedEnd(seg, pos);
          else if (seg[pos] === "'") pos = scanSingleQuotedEnd(seg, pos);
          else pos += 1;
        }
        continue;
      }
      if (!tok.startsWith("-")) break;
    }
  }

  // 3. Command substitutions `$(...)` (outside single quotes, including inside `"..."`) and unquoted `(...)`
  const len = seg.length;
  let i = 0;
  while (i < len) {
    const ch = seg[i];
    if (ch === "'") {
      i = scanSingleQuotedEnd(seg, i);
      continue;
    }
    if (ch === '"') {
      const closeIdx = scanDoubleQuotedEnd(seg, i);
      let j = i + 1;
      const innerEnd = closeIdx > i + 1 && seg[closeIdx - 1] === '"' ? closeIdx - 1 : closeIdx;
      while (j < innerEnd) {
        if ((seg[j] === "\\" || seg[j] === "`") && j + 1 < innerEnd) {
          j += 2;
          continue;
        }
        if (seg[j] === "$" && seg[j + 1] === "(") {
          const sub = extractBalancedParens(seg, j + 1);
          if (sub) {
            if (sub.inner) nested.push(sub.inner);
            j = sub.endIdx;
            continue;
          }
        }
        j += 1;
      }
      i = closeIdx;
      continue;
    }
    if (ch === "$" && seg[i + 1] === "(") {
      const sub = extractBalancedParens(seg, i + 1);
      if (sub) {
        if (sub.inner) nested.push(sub.inner);
        i = sub.endIdx;
        continue;
      }
    }
    if (ch === "(") {
      const sub = extractBalancedParens(seg, i);
      if (sub) {
        if (sub.inner) nested.push(sub.inner);
        i = sub.endIdx;
        continue;
      }
    }
    i += 1;
  }

  return nested;
}

function inspectCommandRecursive({ commandLine, cwd, sessionId, shellDumpMaxBytes, effSensMode, secMod, depth }) {
  if (!commandLine || typeof commandLine !== "string" || depth > 3) {
    return { shouldDeny: false };
  }
  const cleanCmd = cleanStringArg(commandLine);
  const segments = splitTopLevelCommandSegments(cleanCmd);
  if (segments.length === 0) return { shouldDeny: false };

  let activeCwd = cwd || process.cwd();
  for (const seg of segments) {
    const cdStep = /^(?:cd(?:\s+\/d)?|Set-Location|sl)\s+("[^"]+"|'[^']+'|\S+)\s*$/i.exec(seg);
    if (cdStep) {
      let rawDir = cdStep[1];
      if ((rawDir.startsWith('"') && rawDir.endsWith('"')) || (rawDir.startsWith("'") && rawDir.endsWith("'"))) {
        rawDir = rawDir.slice(1, -1);
      }
      if (rawDir && !rawDir.startsWith("-")) {
        activeCwd = resolveCdTargetCwdFn ? resolveCdTargetCwdFn(activeCwd, rawDir) : path.resolve(activeCwd, rawDir);
      }
      continue;
    }
    const res = inspectSingleCommandSegment({
      commandLine: seg,
      cwd: activeCwd,
      sessionId,
      shellDumpMaxBytes,
      sensitiveGuardMode: effSensMode,
      secMod
    });
    if (res.shouldDeny) return res;

    if (depth < 3) {
      const nestedCmds = extractNestedShellCommands(seg);
      for (const nestedCmd of nestedCmds) {
        const nestedRes = inspectCommandRecursive({
          commandLine: nestedCmd,
          cwd: activeCwd,
          sessionId,
          shellDumpMaxBytes,
          effSensMode,
          secMod,
          depth: depth + 1
        });
        if (nestedRes.shouldDeny) return nestedRes;
      }
    }
  }

  return { shouldDeny: false };
}

export function inspectCommand({ commandLine, cwd, sessionId, sensitiveGuardMode = null }) {
  if (!commandLine || typeof commandLine !== "string") {
    return { shouldDeny: false };
  }

  const shellDumpMaxBytes = getShellDumpMaxBytes();
  const effSensMode = sensitiveGuardMode || getEffectiveConfig().sensitiveFileGuard || "off";
  const secMod = effSensMode === "deny" ? securityModule : null;

  return inspectCommandRecursive({
    commandLine,
    cwd,
    sessionId,
    shellDumpMaxBytes,
    effSensMode,
    secMod,
    depth: 0
  });
}

let outlineModule;
function ensureCodeOutlineModule() {
  return outlineModule ??= import("../context/lib/code-outline.js");
}

function normalizePreToolPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { payload: null, bridgeInput: undefined, bridgeToolName: "" };
  }
  const payload = { ...rawPayload };
  let bridgeInput;
  let bridgeToolName = "";
  if (!payload.toolCall && (payload.hook_event_name === "PreToolUse" || typeof payload.tool_name === "string")) {
    bridgeInput = payload.tool_input || {};
    bridgeToolName = String(payload.tool_name || "");
    const lowerTool = bridgeToolName.toLowerCase();
    const start = Math.max(1, Number(bridgeInput.offset) || 1);
    if (lowerTool === "read") {
      payload.toolCall = {
        name: "read_file",
        args: {
          Path: bridgeInput.file_path ?? bridgeInput.path,
          ...(bridgeInput.offset || bridgeInput.limit ? { StartLine: start } : {}),
          ...(bridgeInput.limit > 0 ? { EndLine: start + bridgeInput.limit - 1 } : {})
        }
      };
    } else if (lowerTool === "bash" || lowerTool === "pwsh") {
      payload.toolCall = { name: "run_command", args: bridgeInput };
      if (typeof bridgeInput.workdir === "string" && bridgeInput.workdir.trim()) {
        const baseCwd = payload.cwd || process.cwd();
        payload.cwd = path.isAbsolute(bridgeInput.workdir.trim())
          ? bridgeInput.workdir.trim()
          : path.resolve(baseCwd, bridgeInput.workdir.trim());
      }
    }
  }
  if (payload.common?.conversationId && !payload.conversationId) {
    payload.conversationId = payload.common.conversationId;
  }
  return { payload, bridgeInput, bridgeToolName };
}

function formatHookVerdict(verdict, bridgeInput) {
  if (bridgeInput !== undefined) {
    const output = {};
    if (verdict.decision === "deny") {
      output.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason
      };
    } else if (verdict.overwrite) {
      output.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        updatedInput: { ...bridgeInput, ...verdict.overwrite }
      };
    }
    return output;
  }
  return verdict;
}

export async function evaluatePreToolPayload(rawPayload) {
  const { payload, bridgeInput, bridgeToolName } = normalizePreToolPayload(rawPayload);
  if (!payload) return { verdict: { decision: "allow" }, bridgeInput };
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};
  const cwd = payload.cwd || process.cwd();
  const sessionId = resolveSharedSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);
  const isSubagentCall = isSubagentReadPayload(payload);
  const subagentId = resolveSubagentId(payload);
  const agentName = resolveAgentName(payload);
  const cfgSnapshot = getConfigSnapshot();
  const effectiveCfg = cfgSnapshot.values;

  const done = (verdict) => ({ verdict, bridgeInput });

  // 0-SQLite fast path: bypass DB & heavy module loading entirely for unconditionally allowed tools/files
  if (toolName !== "read_file" && toolName !== "view_file" && toolName !== "run_command") {
    return done({ decision: "allow" });
  }

  let preParsedRead = null;
  if (toolName === "read_file" || toolName === "view_file") {
    if (!effectiveCfg.readHook) {
      return done({ decision: "allow" });
    }
    const rawFilePath = args.Path || args.path || args.file_path || args.filePath || args.AbsolutePath || args.absolutePath || "";
    const filePath = cleanFilePath(rawFilePath);
    if (!filePath) {
      return done({ decision: "allow" });
    }
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const ext = path.extname(absPath).toLowerCase();
    const guardActive = (effectiveCfg.sensitiveFileGuard || "off") !== "off";
    const isViewFilePageRange =
      toolName === "view_file" &&
      ((args.StartPage !== undefined && args.StartPage !== null && String(args.StartPage).trim() !== "") ||
        (args.EndPage !== undefined && args.EndPage !== null && String(args.EndPage).trim() !== "") ||
        (args.startPage !== undefined && args.startPage !== null && String(args.startPage).trim() !== "") ||
        (args.endPage !== undefined && args.endPage !== null && String(args.endPage).trim() !== ""));
    if (
      !guardActive &&
      (isUserAttachedFile(rawFilePath, absPath) ||
        isAgentInstructionFile(rawFilePath, absPath) ||
        BINARY_EXTENSIONS.has(ext) ||
        isViewFilePageRange)
    ) {
      return done({ decision: "allow" });
    }
    preParsedRead = { rawFilePath, filePath, absPath, ext, isViewFilePageRange };
  }

  try {

  // Load ContextModeStore (and filter-rules for run_command) AFTER enableVersionedCompileCache()
  // so V8 bytecode caching captures these heavy modules on every guarded invocation.
  await ensureStoreClass();
  if (toolName === "run_command") {
    await ensureFilterRules();
    if ((effectiveCfg.sensitiveFileGuard || "off") === "deny") {
      await ensureSecurityModule();
    }
  }

  let independentSubagentResolved = null;
  let discoveredParentConvId = "";
  const isIndependentSubagentRead = async () => {
    if (independentSubagentResolved !== null) return independentSubagentResolved;
    if (!directConvId || directConvId === "default") {
      independentSubagentResolved = false;
      return false;
    }
    const explicitDepth = Number(
      payload.nestingDepth ?? payload.nesting_depth ?? payload.metadata?.nestingDepth ?? payload.metadata?.nesting_depth
    );
    if (
      (sessionId && sessionId !== "default" && directConvId !== sessionId) ||
      (Number.isFinite(explicitDepth) && explicitDepth > 0)
    ) {
      independentSubagentResolved = true;
      return true;
    }
    // Inline subagent with explicit subagentId sharing parent conversationId (e.g. `{ conversationId: "p-main", subagent: true, subagentId: "sub-A" }`)
    // shares the parent's context window and must keep 2-strike confirm isolation rather than bypassing read guards.
    if (subagentId && directConvId === sessionId) {
      independentSubagentResolved = false;
      return false;
    }
    try {
      const wl = await ensureWatchdogLease();
      const st = getSharedStore();
      const existingLease = typeof wl.readWatchdogLease === "function" ? wl.readWatchdogLease(st, directConvId) : null;
      if (existingLease) {
        if (
          existingLease.isSubagent === true ||
          (existingLease.parentConversationId && existingLease.parentConversationId !== directConvId) ||
          (existingLease.rootSessionId && existingLease.rootSessionId !== directConvId)
        ) {
          discoveredParentConvId = existingLease.parentConversationId || "";
          independentSubagentResolved = true;
          return true;
        }
        if (existingLease.convTitle) {
          independentSubagentResolved = false;
          return false;
        }
      }
      const allowDefaultSummaryDb =
        Boolean(process.env.AGY_DART_SUMMARY_DB_PATH) || cfgSnapshot.sources.dbPath === "default";
      const txPath =
        (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) ||
        (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) ||
        existingLease?.transcriptPath ||
        (typeof wl.resolveCandidateTranscriptPath === "function"
          ? wl.resolveCandidateTranscriptPath(directConvId, { allowDefaultDb: allowDefaultSummaryDb })
          : "");
      if (allowDefaultSummaryDb || txPath) {
        const summary = wl.lookupConversationSummary?.(directConvId, {
          transcriptPath: txPath,
          allowDefaultDb: allowDefaultSummaryDb,
          checkSubagent: true,
          allowUntitledCustomAgent: false
        });
        if (summary?.isSubagent) {
          discoveredParentConvId = summary.parentConversationId || "";
          independentSubagentResolved = true;
          return true;
        }
        if (summary?.title) {
          independentSubagentResolved = false;
          return false;
        }
      }
      if (txPath && wl.detectSubagentFromTranscriptFile?.(txPath)) {
        independentSubagentResolved = true;
        return true;
      }
    } catch {}
    independentSubagentResolved = false;
    return false;
  };

  const touchWatchdogPreTool = async (decision = "allow") => {
    if (!effectiveCfg.stallWatchdog || !directConvId || directConvId === "default") return;
    try {
      const st = getSharedStore();
      if (typeof st.isWatchdogEnabled === "function" && !st.isWatchdogEnabled()) return;
      const wl = await ensureWatchdogLease();
      if (isSubagentCall && directConvId === sessionId && !subagentId && independentSubagentResolved === null) {
        await isIndependentSubagentRead();
      }
      const sharesParentLease = Boolean(
        isSubagentCall && directConvId === sessionId && independentSubagentResolved !== true
      );
      const effectiveSubagent = Boolean(!sharesParentLease && (isSubagentCall || independentSubagentResolved === true));
      wl.recordHookLeaseTransition(st, "PreToolUse", payload, {
        directConvId,
        rootSessionId:
          sessionId && sessionId !== directConvId
            ? sessionId
            : discoveredParentConvId || sessionId,
        ...(discoveredParentConvId ? { parentConversationId: discoveredParentConvId } : {}),
        isSubagent: effectiveSubagent,
        suppressPayloadSubagent: sharesParentLease,
        cwd,
        toolName,
        toolArgs: args,
        decision,
        asyncBypassMs: effectiveCfg.cliFilterAsyncBypassMs ?? 2000
      });
    } catch {}
  };

  if (isProtectionPaused(sessionId)) {
    await touchWatchdogPreTool("allow");
    return done({ decision: "allow" });
  }

  // 1. Guard read_file / view_file (unless disabled via env/config for ultra-low-latency mode B)
  if (preParsedRead) {
    const { filePath, absPath, ext } = preParsedRead;
    const rawStartLine = parseLineArg(args.StartLine ?? args.startLine ?? args.start_line);
    const startLine = rawStartLine !== null && rawStartLine >= 1 ? rawStartLine : 1;
    const rawEndLine = parseLineArg(args.EndLine ?? args.endLine ?? args.end_line);
    const endLine = rawEndLine !== null && rawEndLine > 0 ? rawEndLine : null;
    const byteOffset = Math.max(0, parseLineArg(args.ByteOffset ?? args.byteOffset ?? args.byte_offset) ?? 0);
    const maxReadBytes = getMaxReadBytes(sessionId);
    const readGuardMode = effectiveCfg.readGuardMode || "soft";
    const normKey = process.platform === "win32" ? absPath.toLowerCase() : absPath;

    const hasExplicitConvId = hasExplicitConversationId(payload);
    const subagentSharesParentContext = isSubagentCall && directConvId === sessionId;
    const confirmScope = buildConfirmScope({
      directConvId,
      sessionId,
      hasExplicitConvId,
      subagentSharesParentContext,
      subagentId,
      agentName,
      cwd
    });

    try {
      let rawStat = null;
      try {
        rawStat = fs.statSync(absPath, { bigint: true });
      } catch {}
      if (rawStat) {
        if (!rawStat.isFile()) {
          return done({ decision: "allow" });
        }
        const stat = {
          size: Number(rawStat.size),
          mtimeMs: Number(rawStat.mtimeNs / 1000n) / 1000,
          ctimeMs: Number(rawStat.ctimeNs / 1000n) / 1000,
          ino: String(rawStat.ino)
        };
        const readCtx = createFileReadContext(absPath, stat.size);

        // Optional sensitive credential file read guard (ALWAYS runs BEFORE Tier 0, exemptions & size guard)
        const rawSensMode = effectiveCfg.sensitiveFileGuard || "off";
        if (rawSensMode === "warn" || rawSensMode === "deny") {
          const sec = await ensureSecurityModule();
          const guardMode = sec.getSensitiveFileGuardMode();
          if (guardMode === "warn" || guardMode === "deny") {
            const realAbsPath = readCtx.getRealPath();
            const sensDirect = sec.detectSensitiveFile(absPath);
            const sensReal =
              realAbsPath !== absPath ? sec.detectSensitiveFile(realAbsPath) : { sensitive: false, reason: null };
            const sens = sensDirect.sensitive ? sensDirect : sensReal;
            if (sens.sensitive) {
              const confirmKey = `sensitive_read_confirm:${confirmScope.scopeKey}:${normKey}`;
              if (guardMode === "deny") {
                const reason =
                  `[agy-dart sensitive-file] Reading '${filePath}' (${sens.reason}) is blocked by AGY_DART_SENSITIVE_FILE_GUARD=deny to keep raw secrets out of LLM context.`;
                recordInterception({
                  sessionId,
                  agent: agentName,
                  cwd,
                  toolName,
                  path: filePath,
                  size: stat.size,
                  reason,
                  key: "sensitive_file"
                });
                await touchWatchdogPreTool("deny");
                return done({ decision: "deny", reason });
              }
              const sensTtlMs =
                confirmScope.ttlMs === LARGE_READ_CONFIRM_TTL_MS
                  ? SENSITIVE_READ_CONFIRM_TTL_MS
                  : SENSITIVE_READ_CONFIRM_SHORT_TTL_MS;
              const confirmed = getSharedStore().getTimedMeta(confirmKey, "", sensTtlMs);
              if (!confirmed) {
                getSharedStore().setTimedMeta(confirmKey, "1");
                const reason =
                  `[agy-dart sensitive-file] '${filePath}' looks like a sensitive file (${sens.reason}). Avoid pulling raw credentials into LLM context (or use ctx_index which redacts common secrets). Call ${toolName} once more if you intentionally need to inspect it.`;
                recordInterception({
                  sessionId,
                  agent: agentName,
                  cwd,
                  toolName,
                  path: filePath,
                  size: stat.size,
                  reason,
                  key: "sensitive_file_warn"
                });
                await touchWatchdogPreTool("deny");
                return done({ decision: "deny", reason });
              } else if (confirmScope.consumeOnAllow) {
                try {
                  getSharedStore().deleteMeta(confirmKey);
                } catch {}
              }
            }
          }
        }

        // Tier 0: unconditional allow (attachments, instruction files, binary files, view_file page ranges)
        if (
          isUserAttachedFile(preParsedRead.rawFilePath, absPath) ||
          isAgentInstructionFile(preParsedRead.rawFilePath, absPath) ||
          BINARY_EXTENSIONS.has(ext) ||
          preParsedRead.isViewFilePageRange
        ) {
          return done({ decision: "allow" });
        }

        const isBinary = isBinaryFile(absPath, ext, readCtx);
        if (isBinary) {
          return done({ decision: "allow" });
        }

        // Prepare Three-State Read Cache state upfront so cache hits run BEFORE Section 1a (eliminates 3-strike trap!)
        const readDedupMinBytes = Number(effectiveCfg.readDedupMinBytes ?? DEFAULT_READ_DEDUP_MIN_BYTES);
        const diffReadCandidate = effectiveCfg.diffRead === true && stat.size <= MAX_SNAPSHOT_FILE_BYTES;
        let estBytes;
        if (endLine !== null) {
          const spanEst = Math.min(stat.size, Math.max(1, endLine - startLine + 1) * 45);
          estBytes =
            stat.size < readDedupMinBytes && !(diffReadCandidate && stat.size >= MIN_DIFF_READ_BYTES)
              ? Math.min(stat.size, spanEst)
              : measureLineRangeBytes(absPath, startLine, endLine, stat.size, spanEst, readCtx);
        } else if (startLine > 1) {
          estBytes =
            stat.size < readDedupMinBytes && !(diffReadCandidate && stat.size >= MIN_DIFF_READ_BYTES)
              ? stat.size
              : measureRemainingFromLineBytes(absPath, startLine, stat.size, readCtx);
        } else {
          estBytes = stat.size;
        }

        let dedupEnabled = true;
        try {
          dedupEnabled = getSharedStore().isReadDedupEnabled(sessionId);
        } catch {}

        const canUseReadCache = dedupEnabled && hasExplicitConvId && !subagentSharesParentContext;
        const meetsDedupMinBytes =
          stat.size > 0 && (readDedupMinBytes <= 0 || estBytes >= readDedupMinBytes);
        const diffReadEnabled = canUseReadCache && diffReadCandidate;
        const meetsDiffMinBytes = diffReadEnabled && stat.size > 0 && estBytes >= MIN_DIFF_READ_BYTES;
        const diffReadMaxTurns = effectiveCfg.diffReadMaxTurns;
        const diffReadMaxAgeMs = effectiveCfg.diffReadMaxAgeMs;
        const readDedupMaxSteps = Number(effectiveCfg.readDedupMaxSteps ?? 40);
        const readDedupMaxTurns = Number(effectiveCfg.readDedupMaxTurns ?? 12);
        const rawStepIdx = payload.stepIdx ?? payload.step_idx ?? payload.stepIndex ?? payload.step_index;
        const currentStepIdx =
          rawStepIdx !== undefined &&
          rawStepIdx !== null &&
          rawStepIdx !== "" &&
          typeof rawStepIdx !== "boolean" &&
          Number.isFinite(Number(rawStepIdx)) &&
          Number(rawStepIdx) >= 0
            ? Math.floor(Number(rawStepIdx))
            : null;

        let readBounds = null;
        let effectiveEndLine = endLine;
        let convTurnSeq = 0;
        let convTurnSeqLoaded = false;
        let currentRangeText = null;
        let currentSha256 = null;
        let currentRangeBytes = 0;
        let skipSizeGuardDueToCacheBypass = false;

        const loadCurrentRange = async () => {
          if (currentRangeText !== null) return true;
          const rawDisk = readUtf8TextSafe(absPath, readCtx);
          if (rawDisk === null) return false;
          const { extractLineSlice } = await ensureTextDiffModule();
          currentRangeText = extractLineSlice(rawDisk, startLine, effectiveEndLine, 1);
          const sliceBytes = Buffer.byteLength(currentRangeText, "utf8");
          currentRangeBytes =
            effectiveEndLine === null && startLine === 1 ? Math.max(sliceBytes, stat.size) : sliceBytes;
          currentSha256 = sha256Text(currentRangeText);
          return true;
        };

        // Reset any stale `/compact` cmd stamp when a normal non-compact user prompt arrives (0 writes when absent)
        const rawLastUserInput = payload.lastUserInput ?? payload.last_user_input ?? "";
        const isSlashCompactInput =
          typeof rawLastUserInput === "string" && /^\s*\/compact(?:\s|$)/i.test(rawLastUserInput);
        if (canUseReadCache && typeof rawLastUserInput === "string" && rawLastUserInput.trim() && !isSlashCompactInput) {
          try {
            const st = getSharedStore();
            const staleCmdKey = `compact_invalidated:cmd:${directConvId}`;
            if (st.getMeta(staleCmdKey, null) !== null) {
              st.deleteMeta(staleCmdKey);
            }
          } catch {}
        }

        // Zero-overhead-on-allow slow-path compaction guard: ONLY runs right before a State-2 or State-3 deny
        let lazyCompactionChecked = false;
        let lazyCompactionResult = null;
        const checkLazyCompactionOnSlowPath = async ({ dupRow = null, snapshotRow = null } = {}) => {
          if (lazyCompactionChecked) return lazyCompactionResult;
          lazyCompactionChecked = true;
          try {
            const store = getSharedStore();

            // 1. Defensive stepIdx rollback check (covers both file_reads and file_snapshots)
            const trackedStep = dupRow ? dupRow.read_step : snapshotRow ? snapshotRow.read_step : null;
            if (
              currentStepIdx !== null &&
              trackedStep !== null &&
              trackedStep !== undefined &&
              Number.isFinite(Number(trackedStep)) &&
              currentStepIdx < Number(trackedStep)
            ) {
              store.invalidateFileReads(directConvId, null);
              lazyCompactionResult = { invalidated: true, reason: "step_rollback" };
              return lazyCompactionResult;
            }

            // 2. Unstamped `/compact` in payload.lastUserInput
            if (isSlashCompactInput) {
              const cmdText = rawLastUserInput.trim().slice(0, 128);
              const cmdKey = `compact_invalidated:cmd:${directConvId}`;
              let storedCmd = null;
              try {
                const rawStored = store.getTimedMeta(cmdKey, "");
                if (rawStored) storedCmd = JSON.parse(rawStored);
              } catch {}

              let alreadyHandled = false;
              if (storedCmd && storedCmd.text === cmdText) {
                if (dupRow) {
                  const rStep =
                    dupRow.read_step !== null && dupRow.read_step !== undefined && Number.isFinite(Number(dupRow.read_step))
                      ? Number(dupRow.read_step)
                      : null;
                  const rTurn =
                    dupRow.read_turn_seq !== null &&
                    dupRow.read_turn_seq !== undefined &&
                    Number.isFinite(Number(dupRow.read_turn_seq))
                      ? Number(dupRow.read_turn_seq)
                      : null;
                  if (
                    (storedCmd.ts && Number(dupRow.read_ts) >= Number(storedCmd.ts)) ||
                    (storedCmd.stepIdx !== null && storedCmd.stepIdx !== undefined && rStep !== null && rStep >= Number(storedCmd.stepIdx)) ||
                    (storedCmd.initialNumSteps !== null &&
                      storedCmd.initialNumSteps !== undefined &&
                      rStep !== null &&
                      rStep >= Number(storedCmd.initialNumSteps)) ||
                    (storedCmd.turnSeq !== null &&
                      storedCmd.turnSeq !== undefined &&
                      Number(storedCmd.turnSeq) > 0 &&
                      rTurn !== null &&
                      rTurn >= Number(storedCmd.turnSeq))
                  ) {
                    alreadyHandled = true;
                  }
                } else if (snapshotRow) {
                  const sStep =
                    snapshotRow.read_step !== null &&
                    snapshotRow.read_step !== undefined &&
                    Number.isFinite(Number(snapshotRow.read_step))
                      ? Number(snapshotRow.read_step)
                      : null;
                  if (
                    (storedCmd.ts && Number(snapshotRow.updated_ts) >= Number(storedCmd.ts)) ||
                    (storedCmd.stepIdx !== null && storedCmd.stepIdx !== undefined && sStep !== null && sStep >= Number(storedCmd.stepIdx)) ||
                    (storedCmd.initialNumSteps !== null &&
                      storedCmd.initialNumSteps !== undefined &&
                      sStep !== null &&
                      sStep >= Number(storedCmd.initialNumSteps)) ||
                    (storedCmd.turnSeq !== null &&
                      storedCmd.turnSeq !== undefined &&
                      Number(storedCmd.turnSeq) > 0 &&
                      Number(snapshotRow.full_read_seq) >= Number(storedCmd.turnSeq))
                  ) {
                    alreadyHandled = true;
                  }
                }
              }

              if (!alreadyHandled) {
                store.invalidateFileReads(directConvId, null);
                store.setTimedMeta(
                  cmdKey,
                  JSON.stringify({
                    text: cmdText,
                    initialNumSteps: null,
                    stepIdx: currentStepIdx,
                    turnSeq: convTurnSeq,
                    ts: Date.now()
                  })
                );
                lazyCompactionResult = { invalidated: true, reason: "slash_compact" };
                return lazyCompactionResult;
              }
            }

            // 3. Lazy transcript.jsonl tail scan (statSync size/mtime fast-skip)
            let txPath =
              typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()
                ? payload.transcriptPath.trim()
                : typeof payload.transcript_path === "string" && payload.transcript_path.trim()
                  ? payload.transcript_path.trim()
                  : "";
            let caMod = null;
            if (!txPath || !fs.existsSync(txPath)) {
              caMod = await ensureCacheAnalyzer();
              txPath = caMod.findTranscriptForConversation(directConvId, { exactOnly: true }) || "";
            }
            if (txPath && fs.existsSync(txPath)) {
              const txStat = fs.statSync(txPath);
              if (txStat.isFile() && txStat.size > 0) {
                const txStatKey = `compact_invalidated:tx_stat:${directConvId}`;
                const statSig = `${txStat.size}:${Math.round(txStat.mtimeMs)}:${txPath}`;
                if (store.getTimedMeta(txStatKey, "") !== statSig) {
                  if (!caMod) caMod = await ensureCacheAnalyzer();
                  const event = caMod.inspectTranscriptCompaction(txPath, { maxBytes: 131072 });
                  store.setTimedMeta(txStatKey, statSig);
                  if (event && event.stamp) {
                    const lastCompactKey = `compact_invalidated:${directConvId}`;
                    if (store.getTimedMeta(lastCompactKey, "") !== event.stamp) {
                      if (event.hasExplicitStepIndex && Number.isFinite(event.stepIndex)) {
                        store.invalidateFileReadsBefore(directConvId, { maxStep: event.stepIndex });
                      } else {
                        store.invalidateFileReads(directConvId, null);
                      }
                      store.setTimedMeta(lastCompactKey, event.stamp);

                      if (dupRow) {
                        const dupPreservedAfterCompact =
                          event.hasExplicitStepIndex &&
                          dupRow.read_step !== null &&
                          dupRow.read_step !== undefined &&
                          Number.isFinite(Number(dupRow.read_step)) &&
                          Number(dupRow.read_step) > event.stepIndex;
                        if (!dupPreservedAfterCompact) {
                          lazyCompactionResult = { invalidated: true, reason: event.kind, event };
                          return lazyCompactionResult;
                        }
                      } else if (snapshotRow) {
                        const stillHasSnap = store.findFileSnapshot({
                          sessionId: directConvId,
                          filePath: absPath,
                          startLine,
                          endLine: effectiveEndLine,
                          ino: null,
                          maxAgeMs: diffReadMaxAgeMs
                        });
                        if (!stillHasSnap) {
                          lazyCompactionResult = { invalidated: true, reason: event.kind, event };
                          return lazyCompactionResult;
                        }
                      } else {
                        lazyCompactionResult = { invalidated: true, reason: event.kind, event };
                        return lazyCompactionResult;
                      }
                    }
                  }
                }
              }
            }
          } catch {
            // Fail-open on any filesystem/DB error during lazy compaction inspection
          }
          lazyCompactionResult = { invalidated: false };
          return lazyCompactionResult;
        };

        // Pre-1a Read Cache Priority Check (State 2 unchanged dedup / State 3 diff-read / armed bypass)
        if (canUseReadCache && (meetsDedupMinBytes || meetsDiffMinBytes) && byteOffset <= 0) {
          readBounds = computeEffectiveReadBounds(
            absPath,
            startLine,
            endLine,
            stat.size,
            HOST_READ_MAX_LINES,
            HOST_READ_MAX_BYTES,
            readCtx
          );
          effectiveEndLine = readBounds.effectiveEndLine;
          if (!readBounds.skipCache) {
            try {
              const store = getSharedStore();
              convTurnSeq = store.getConversationTurnSeq(directConvId);
              convTurnSeqLoaded = true;
              let dup = meetsDedupMinBytes
                ? store.findDuplicateRead({
                    sessionId: directConvId,
                    filePath: absPath,
                    startLine,
                    endLine: effectiveEndLine,
                    mtimeMs: stat.mtimeMs,
                    fileSize: stat.size,
                    ctimeMs: stat.ctimeMs,
                    ino: stat.ino,
                    currentStepIdx,
                    maxStepGap: readDedupMaxSteps,
                    currentTurnSeq: convTurnSeq,
                    maxTurnGap: readDedupMaxTurns
                  })
                : null;

              let compactionInvalidatedThisCall = false;
              if (dup && Number(dup.bypass_armed) === 0) {
                const compCheck = await checkLazyCompactionOnSlowPath({ dupRow: dup });
                if (compCheck?.invalidated) {
                  dup = null;
                  compactionInvalidatedThisCall = true;
                }
              }

              if (dup && Number(dup.bypass_armed) === 0) {
                if (readGuardMode !== "strict" && (await isIndependentSubagentRead())) {
                  dup = null;
                } else {
                  store.armReadBypass({
                    sessionId: directConvId,
                    filePath: absPath,
                    startLine: dup.start_line,
                    endLine: dup.end_line
                  });
                  const rangeLabel = effectiveEndLine !== null ? `lines ${startLine}-${effectiveEndLine}` : "full file";
                  const dedupReason =
                    `[agy-dart read-dedup] '${filePath}' (${rangeLabel}, ~${formatBytes(estBytes)}) was already allowed unchanged earlier in this session ` +
                    `(mtime & size identical). Reuse the copy in context if it completed; if that earlier read was cancelled/failed or context was compacted, call ${toolName} once more to retry immediately.`;

                  recordInterception({
                    sessionId,
                    agent: agentName,
                    cwd,
                    toolName,
                    path: filePath,
                    size: estBytes,
                    reason: dedupReason,
                    kind: "dedup",
                    key: "unchanged_reread"
                  });

                  await touchWatchdogPreTool("deny");
                  return done({ decision: "deny", reason: dedupReason });
                }
              }

              if (dup && Number(dup.bypass_armed) === 1) {
                skipSizeGuardDueToCacheBypass = true;
                const rangeLabel = effectiveEndLine !== null ? `lines ${startLine}-${effectiveEndLine}` : "full file";
                recordInterception({
                  sessionId,
                  agent: agentName,
                  cwd,
                  toolName,
                  path: filePath,
                  size: estBytes,
                  returnedBytes: estBytes,
                  reason: `[agy-dart read-dedup] 2-strike bypass allowed (${rangeLabel}, ~${formatBytes(estBytes)})`,
                  kind: "dedup",
                  key: "dedup_bypass"
                });
              } else if (!dup && !compactionInvalidatedThisCall && meetsDiffMinBytes) {
                const snapshot = store.findFileSnapshot({
                  sessionId: directConvId,
                  filePath: absPath,
                  startLine,
                  endLine: effectiveEndLine,
                  ino: null,
                  maxAgeMs: diffReadMaxAgeMs
                });

                const baselineFullTs = snapshot ? Number(snapshot.full_read_ts || snapshot.updated_ts || 0) : 0;
                const baselineFullSeq = snapshot ? Number(snapshot.full_read_seq || 0) : 0;
                const baselineReadStep =
                  snapshot &&
                  snapshot.read_step !== null &&
                  snapshot.read_step !== undefined &&
                  Number.isFinite(Number(snapshot.read_step))
                    ? Number(snapshot.read_step)
                    : null;
                const bypassArmed = Boolean(snapshot && Number(snapshot.bypass_armed) === 1);
                const ageFresh = !snapshot || diffReadMaxAgeMs <= 0 || Date.now() - baselineFullTs <= diffReadMaxAgeMs;
                const turnsFresh =
                  !snapshot ||
                  (convTurnSeq >= Math.max(0, baselineFullSeq) &&
                    (diffReadMaxTurns <= 0 || convTurnSeq - Math.max(0, baselineFullSeq) <= diffReadMaxTurns));
                const stepRolledBack = Boolean(
                  snapshot && currentStepIdx !== null && baselineReadStep !== null && currentStepIdx < baselineReadStep
                );

                if (stepRolledBack) {
                  try {
                    store.invalidateFileReads(directConvId, null);
                  } catch {}
                } else if (snapshot && bypassArmed) {
                  skipSizeGuardDueToCacheBypass = true;
                } else if (snapshot && !bypassArmed && ageFresh && turnsFresh) {
                  if (await loadCurrentRange()) {
                    const { computeUnifiedDiff, extractLineSlice } = await ensureTextDiffModule();
                    const baselineText = snapshot.isExactRange
                      ? snapshot.content
                      : extractLineSlice(snapshot.content, startLine, effectiveEndLine, snapshot.start_line);
                    const baselineSha256 = snapshot.isExactRange ? snapshot.sha256 : sha256Text(baselineText);

                    if (currentSha256 !== baselineSha256 && currentRangeBytes >= MIN_DIFF_READ_BYTES) {
                      const diff = computeUnifiedDiff(baselineText, currentRangeText, {
                        fileLabel: path.basename(filePath),
                        startLine,
                        maxDiffBytes: MAX_DIFF_READ_BYTES
                      });

                      if (
                        diff.changed &&
                        !diff.truncated &&
                        diff.diffBytes > 0 &&
                        diff.diffBytes <= MAX_DIFF_READ_BYTES &&
                        diff.diffBytes < currentRangeBytes * MAX_DIFF_READ_RATIO
                      ) {
                        const compCheck = await checkLazyCompactionOnSlowPath({ snapshotRow: snapshot });
                        if (
                          !compCheck?.invalidated &&
                          !(readGuardMode !== "strict" && (await isIndependentSubagentRead()))
                        ) {
                          store.saveFileSnapshot({
                            sessionId: directConvId,
                            filePath: absPath,
                            startLine,
                            endLine: effectiveEndLine,
                            sha256: currentSha256,
                            mtimeMs: stat.mtimeMs,
                            fileSize: stat.size,
                            ino: null,
                            content: currentRangeText,
                            bypassArmed: 1,
                            fullReadTs: baselineFullTs || Date.now(),
                            fullReadSeq: baselineFullSeq || convTurnSeq,
                            readStep: baselineReadStep
                          });

                          const rangeLabel = effectiveEndLine !== null ? `lines ${startLine}-${effectiveEndLine}` : "full file";
                          const pctSaved = Math.max(1, Math.round((1 - diff.diffBytes / currentRangeBytes) * 100));
                          const baseShort = String(baselineSha256 || "").slice(0, 8) || "unknown";
                          const baseTimeIso = baselineFullTs ? `${new Date(baselineFullTs).toISOString().slice(11, 19)}Z` : "prior";
                          const diffReason =
                            `[agy-dart diff-read] '${filePath}' (${rangeLabel}) changed since baseline ${baseShort} @ ${baseTimeIso} ` +
                            `(+${diff.addedLines}/-${diff.removedLines} lines, diff ${formatBytes(diff.diffBytes)} vs full ${formatBytes(currentRangeBytes)}, -${pctSaved}%):\n` +
                            `\`\`\`diff\n${diff.diff}\n\`\`\`\n` +
                            `Baseline: prior full copy in this conversation (${baseShort}). Reuse the prior copy + diff above; if you need the full file verbatim (如需全文请重读, e.g. after /compact), call ${toolName} once more to bypass.`;

                          recordInterception({
                            sessionId,
                            agent: agentName,
                            cwd,
                            toolName,
                            path: filePath,
                            size: currentRangeBytes,
                            returnedBytes: diff.diffBytes,
                            reason: diffReason,
                            kind: "dedup",
                            key: "modified_diff"
                          });

                          await touchWatchdogPreTool("deny");
                          return done({ decision: "deny", reason: diffReason });
                        }
                      }
                    }
                  }
                }
              }
            } catch {
              // Fail-open on DB/diff errors
            }
          }
        }

        // Section 1a: Tiered File Size Guard (exemptExtensions / exemptPaths / readGuardMode=off ONLY skip 1a, NEVER 1b readDedup!)
        const realAbsForGuard = readCtx.getRealPath();
        const realExtForGuard = realAbsForGuard !== absPath ? path.extname(realAbsForGuard).toLowerCase() : ext;
        const exemptExtensions = getExemptExtensions(sessionId);
        const isExemptExt =
          Boolean(ext && exemptExtensions.includes(ext)) &&
          (realAbsForGuard === absPath || Boolean(realExtForGuard && exemptExtensions.includes(realExtForGuard)));
        let isExemptPath = matchesAnyExemptPath(absPath, cwd, effectiveCfg.exemptPaths);
        if (isExemptPath && realAbsForGuard !== absPath) {
          let realCwdForExempt = cwd;
          try {
            realCwdForExempt = fs.realpathSync(cwd);
          } catch {}
          if (!matchesAnyExemptPath(realAbsForGuard, realCwdForExempt, effectiveCfg.exemptPaths)) {
            isExemptPath = false;
          }
        }
        const isReadSizeExempt = isExemptExt || isExemptPath;

        if (!skipSizeGuardDueToCacheBypass && !isReadSizeExempt && readGuardMode !== "off" && maxReadBytes > 0) {
          const cfgNoiseMax = Number(effectiveCfg.noiseMaxReadBytes ?? DEFAULT_NOISE_MAX_READ_BYTES);
          const cfgReviewMax = Number(effectiveCfg.reviewMaxReadBytes ?? DEFAULT_REVIEW_MAX_READ_BYTES);
          const noiseIsExplicit = cfgSnapshot.sources.noiseMaxReadBytes !== "default";
          const reviewIsExplicit = cfgSnapshot.sources.reviewMaxReadBytes !== "default";
          const noiseProbeThreshold = noiseIsExplicit
            ? cfgNoiseMax
            : cfgNoiseMax === 0
              ? 0
              : Math.min(maxReadBytes, cfgNoiseMax);

          const { tier, isMinifiedContent } = classifyFileTier(absPath, ext, stat.size, noiseProbeThreshold, readCtx);
          let tierCutoffBytes;
          if (tier === "noise") {
            tierCutoffBytes = noiseIsExplicit
              ? cfgNoiseMax
              : cfgNoiseMax === 0
                ? 0
                : Math.min(maxReadBytes, cfgNoiseMax);
          } else if (tier === "review") {
            tierCutoffBytes = reviewIsExplicit
              ? cfgReviewMax
              : cfgReviewMax === 0
                ? 0
                : Math.max(maxReadBytes, cfgReviewMax);
          } else {
            tierCutoffBytes = maxReadBytes;
          }

          if (tierCutoffBytes > 0) {
            const tierMaxLineRange = getMaxLineRange(tierCutoffBytes);
            const fullConfirmKey = `large_read_confirm:${confirmScope.scopeKey}:${normKey}:full`;
            const fileSig = `${Math.round(stat.mtimeMs)}:${stat.size}`;

            let priorReadSummary = null;
            let hasPriorFullConfirm = false;
            const loadPriorReadSummary = () => {
              if (priorReadSummary !== null) return priorReadSummary;
              try {
                if (hasExplicitConvId) {
                  priorReadSummary = getSharedStore().getPriorReadSummary(directConvId, absPath);
                  return priorReadSummary;
                }
              } catch {}
              priorReadSummary = { hasPrior: false, hasFullOrLargeRead: false, maxEndLine: 0 };
              return priorReadSummary;
            };
            const checkPriorFullConfirmOnly = () => {
              if (hasPriorFullConfirm) return true;
              try {
                const st = getSharedStore();
                const priorFull = st.getTimedMeta(fullConfirmKey, "", confirmScope.ttlMs);
                if (priorFull === fileSig) {
                  hasPriorFullConfirm = true;
                  return true;
                }
              } catch {}
              return false;
            };
            const checkPriorByteContinuation = () => {
              if (checkPriorFullConfirmOnly()) return true;
              return loadPriorReadSummary().hasFullOrLargeRead;
            };
            const checkPriorLineContinuation = (reqStartLine) => {
              if (checkPriorFullConfirmOnly()) return true;
              const summary = loadPriorReadSummary();
              if (!summary.hasFullOrLargeRead) return false;
              return summary.maxEndLine === -1 || (summary.maxEndLine >= 50 && reqStartLine >= summary.maxEndLine);
            };

            const remainingBytes = Math.max(0, stat.size - byteOffset);
            let isContinuationAllow = false;
            if (byteOffset > 0) {
              if (remainingBytes <= tierCutoffBytes) {
                isContinuationAllow = true;
              } else if (readGuardMode !== "strict" && byteOffset >= HOST_READ_MAX_BYTES) {
                if (tier !== "noise" && checkPriorByteContinuation()) {
                  isContinuationAllow = true;
                } else if (tier === "noise" && checkPriorFullConfirmOnly()) {
                  isContinuationAllow = true;
                }
              }
            } else if (startLine > 1 && endLine === null && !isMinifiedContent) {
              const remainingFromStart = measureRemainingFromLineBytes(absPath, startLine, stat.size, readCtx);
              if (remainingFromStart <= tierCutoffBytes) {
                isContinuationAllow = true;
              } else if (readGuardMode !== "strict" && tier !== "noise" && checkPriorLineContinuation(startLine)) {
                isContinuationAllow = true;
              }
            }
            if (isContinuationAllow && hasPriorFullConfirm && confirmScope.refreshOnAllow) {
              try {
                getSharedStore().setTimedMeta(fullConfirmKey, fileSig);
              } catch {}
            }

            if (!isContinuationAllow) {
              const isLargeFile = remainingBytes > tierCutoffBytes;
              const isBoundedSlice = endLine !== null;
              const requestedLineSpan = isBoundedSlice ? Math.max(1, endLine - startLine + 1) : 1;
              const rawWideRange =
                tierMaxLineRange > 0 && (!isBoundedSlice || requestedLineSpan > tierMaxLineRange);
              const maxPagedSliceBytes = Math.max(HOST_READ_MAX_BYTES, tierCutoffBytes * 2);
              const sliceMeasure =
                isLargeFile && isBoundedSlice
                  ? measureLineRangeDetailed(absPath, startLine, endLine, stat.size, remainingBytes, readCtx)
                  : { bytes: 0, exact: false, kind: "fallback" };
              const slicedRangeBytes = sliceMeasure.bytes;
              const avgSliceLineBytes = slicedRangeBytes / requestedLineSpan;
              const isMinifiedDenseSlice =
                sliceMeasure.kind !== "fallback" && slicedRangeBytes > tierCutoffBytes && avgSliceLineBytes > 512;
              const isOversizedMultiLineSlice =
                sliceMeasure.kind !== "fallback" && !isMinifiedDenseSlice && slicedRangeBytes > maxPagedSliceBytes;
              // Allow bounded non-minified line slices ONLY when an exact full measurement confirms
              // the UTF-8 byte length fits within tierCutoffBytes (never unlock on fallback/lower-bound/estimates).
              const isSmallVerifiedSlice =
                isBoundedSlice &&
                byteOffset === 0 &&
                !isMinifiedContent &&
                !isMinifiedDenseSlice &&
                sliceMeasure.exact === true &&
                slicedRangeBytes <= tierCutoffBytes;
              const isWideRange = rawWideRange && !isSmallVerifiedSlice;

              if (isLargeFile && (isWideRange || isMinifiedDenseSlice || isOversizedMultiLineSlice)) {
                const independentSubagent =
                  readGuardMode !== "strict" ? await isIndependentSubagentRead() : false;
                const effectiveSubagentCall = Boolean(isSubagentCall || independentSubagent);
                const isHardDeny =
                  readGuardMode === "strict" ||
                  (!effectiveSubagentCall && (tier === "noise" || isMinifiedDenseSlice));

                const modeSig = isMinifiedDenseSlice
                  ? "dense"
                  : endLine !== null
                    ? `slice:${startLine}:${endLine}`
                    : "full";
                const confirmKey = `large_read_confirm:${confirmScope.scopeKey}:${normKey}:${modeSig}`;

                let softBypassAllowed = independentSubagent;
                if (!isHardDeny && !softBypassAllowed) {
                  try {
                    const st = getSharedStore();
                    const prevSig = st.getTimedMeta(confirmKey, "", confirmScope.ttlMs);
                    if (prevSig === fileSig) {
                      softBypassAllowed = true;
                      if (confirmScope.consumeOnAllow) {
                        st.deleteMeta(confirmKey);
                      } else if (confirmScope.refreshOnAllow) {
                        st.setTimedMeta(confirmKey, fileSig);
                      }
                    }
                  } catch {}
                }

                if (!softBypassAllowed) {
                  if (!isHardDeny) {
                    try {
                      getSharedStore().setTimedMeta(confirmKey, fileSig);
                    } catch {}
                  }

                  const lineInfo = countFileLinesApprox(absPath, stat.size, readCtx);
                  const lineMeta =
                    lineInfo.lines > 0
                      ? `, ${lineInfo.exact ? "" : "~"}${lineInfo.lines.toLocaleString()} lines`
                      : "";
                  const reportedBytes =
                    isMinifiedDenseSlice ||
                    isOversizedMultiLineSlice ||
                    (isBoundedSlice && sliceMeasure.kind !== "fallback" && slicedRangeBytes > 0)
                      ? slicedRangeBytes
                      : remainingBytes;
                  const subjectLabel = isBoundedSlice
                    ? `File slice (lines ${startLine}-${endLine})`
                    : "File";
                  const subjectMeta = isBoundedSlice ? "" : lineMeta;
                  const hasDeclaredWorkspace = Boolean(
                    (typeof payload?.cwd === "string" && payload.cwd.trim()) ||
                      (Array.isArray(payload?.workspacePaths) && payload.workspacePaths.some((p) => typeof p === "string" && p.trim()))
                  );
                  const isOutsideWorkspace =
                    hasDeclaredWorkspace &&
                    !isPathInsideWorkspaceRoots(absPath, payload?.cwd, payload?.workspacePaths);
                  const softRetryHint = !isHardDeny
                    ? ` Or call ${toolName} once more to proceed (host caps each read at 45 KiB / ${HOST_READ_MAX_LINES} lines).`
                    : "";

                  let reason;
                  if (isMinifiedDenseSlice) {
                    reason =
                      `[agy-dart protection] File slice is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens), exceeding the ${formatBytes(tierCutoffBytes)} context limit. ` +
                      `Reading giant single-line/minified content risks severe context bloat. ` +
                      (isSubagentCall || isOutsideWorkspace
                        ? `${isOutsideWorkspace ? "File is outside the active workspace; prefer inspecting specific native " + toolName + " offsets or narrow ranges instead of MCP tools." : "Prefer inspecting specific offsets or narrow ranges."}${softRetryHint}`
                        : `For logs/docs/data use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_index" or "ctx_execute", path:"${filePath}").${softRetryHint}`);
                  } else if (isOversizedMultiLineSlice) {
                    const suggestedLines = Math.max(
                      20,
                      Math.min(tierMaxLineRange, Math.floor(maxPagedSliceBytes / Math.max(1, avgSliceLineBytes)))
                    );
                    reason =
                      `[agy-dart protection] File slice (${requestedLineSpan} lines, ~${Math.round(avgSliceLineBytes)} B/line) is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens), exceeding the ${formatBytes(maxPagedSliceBytes)} paged slice cap. ` +
                      `Pass a smaller StartLine/EndLine window (<= ${suggestedLines} lines)${
                        isSubagentCall
                          ? `.${softRetryHint}`
                          : isOutsideWorkspace
                            ? ` using native ${toolName} (keeps allowed_tool fast-path with 0 cloud safety review for files outside the workspace).${softRetryHint}`
                            : `, or use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_index" or "ctx_execute", path:"${filePath}").${softRetryHint}`
                      }`;
                  } else if (tier === "review") {
                    const lineRangeHint =
                      tierMaxLineRange > 0 ? `StartLine/EndLine (<= ${tierMaxLineRange} lines)` : "StartLine/EndLine";
                    const reviewSubject = isBoundedSlice
                      ? `Diff/patch slice (lines ${startLine}-${endLine})`
                      : "Diff/patch file";
                    reason =
                      `[agy-dart protection] ${reviewSubject} is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens${subjectMeta}), exceeding the ${formatBytes(tierCutoffBytes)} review limit. ` +
                      (isSubagentCall
                        ? `Use ${lineRangeHint} to inspect specific hunks.${softRetryHint}`
                        : isOutsideWorkspace
                          ? `File is outside the active workspace; use native ${toolName} with ${lineRangeHint} (keeps allowed_tool fast-path with 0 cloud safety review) instead of MCP tools.${softRetryHint}`
                          : `Outline changed files & hunks via native ${toolName} with ${lineRangeHint} (allowed_tool, 0 cloud safety review) for single-file reads, or batch multiple diff files via ${FAST_SERVER} read_slices({ outlines }).${softRetryHint}`);
                  } else if (isSubagentCall) {
                    const lineRangeHint =
                      tierMaxLineRange > 0 ? `StartLine/EndLine (<= ${tierMaxLineRange} lines)` : "StartLine/EndLine";
                    reason =
                      `[agy-dart protection] ${subjectLabel} is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens${subjectMeta}), exceeding the ${formatBytes(tierCutoffBytes)} context limit. ` +
                      `Use native ${toolName} with ${lineRangeHint} to read relevant sections${isOutsideWorkspace ? "" : ` (or ${FAST_SERVER} read_slices if available)`}.${softRetryHint}`;
                  } else if (isOutsideWorkspace) {
                    const lineRangeHint =
                      tierMaxLineRange > 0 ? `StartLine/EndLine (<= ${tierMaxLineRange} lines)` : "StartLine/EndLine";
                    reason =
                      `[agy-dart protection] ${subjectLabel} is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens${subjectMeta}), exceeding the ${formatBytes(tierCutoffBytes)} context limit. ` +
                      `File is outside the active workspace; use native ${toolName} with ${lineRangeHint} (keeps allowed_tool fast-path with 0 cloud safety review) instead of MCP tools.${softRetryHint}`;
                  } else {
                    const lineRangeHint =
                      tierMaxLineRange > 0 ? `StartLine/EndLine (<= ${tierMaxLineRange} lines)` : "StartLine/EndLine";
                    const bloatText = isBoundedSlice
                      ? "Reading an oversized slice risks context bloat."
                      : "Reading the entire file risks severe context bloat.";
                    reason =
                      `[agy-dart protection] ${subjectLabel} is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens${subjectMeta}), exceeding the ${formatBytes(tierCutoffBytes)} context limit. ` +
                      `${bloatText} ` +
                      (tier === "source"
                        ? `Use native ${toolName} with ${lineRangeHint} (allowed_tool, 0 cloud safety review) for single-file reads; for logs/docs/data use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_index" or "ctx_execute", path:"${filePath}").${softRetryHint}`
                        : `For logs/docs/data use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_index" or "ctx_execute", path:"${filePath}") or outline via ${FAST_SERVER} read_slices({ outlines }) / read targeted ${lineRangeHint}.${softRetryHint}`);
                  }

                  let outlineBlock = "";
                  if ((tier === "source" || tier === "review") && !isMinifiedDenseSlice && !isOversizedMultiLineSlice &&
                      stat.size <= Math.min(524288, effectiveCfg.inlineOutlineMaxBytes) && effectiveCfg.inlineOutlineMaxBytes > 0) {
                    try {
                      const source = readUtf8TextSafe(absPath, readCtx);
                      if (source) {
                        const { extractSymbolsFromLines, renderOutlineWithinBudget } = await ensureCodeOutlineModule();
                        const lines = source.split(/\r?\n/);
                        const symbols = extractSymbolsFromLines(absPath, lines);
                        if (symbols.length) {
                          const readHintName = bridgeToolName === "read" ? "read" : "Read";
                          const next = bridgeInput ? `${readHintName}(file_path, offset, limit)` : `${toolName}(Path, StartLine, EndLine)`;
                          const hint = "Use " + next + " for up to " + tierMaxLineRange + " lines" +
                            (bridgeInput ? "." : " (allowed_tool, 0 cloud safety review).") +
                            (isHardDeny ? "" : " Repeat this read once if necessary.");
                          const block = renderOutlineWithinBudget(path.basename(absPath), lines.length, symbols, 3400, 1, { bracketLines: true });
                          if (Buffer.byteLength(block) <= 3400) {
                            outlineBlock = block;
                            const compactDetail = isOutsideWorkspace
                              ? `File is outside the active workspace; free inline outline attached below — use native ${toolName}(Path, StartLine, EndLine) (allowed_tool, 0 cloud safety review) instead of MCP tools.${softRetryHint}`
                              : tier === "review"
                                ? `Outline changed files & hunks is attached below — use native ${toolName}(Path, StartLine, EndLine) (allowed_tool, 0 cloud safety review) without extra read_slices MCP calls.${softRetryHint}`
                                : `Free inline outline attached below — use native ${toolName}(Path, StartLine, EndLine) (allowed_tool, 0 cloud safety review) without extra read_slices MCP calls.${softRetryHint}`;
                            const compactHeader = `[agy-dart protection] ${subjectLabel} is ${formatBytes(reportedBytes)} (~${Math.round(reportedBytes / 4).toLocaleString()} tokens${subjectMeta}), exceeding the ${formatBytes(tierCutoffBytes)} limit. ${compactDetail}\n`;
                            const prefix = bridgeInput ? "" : compactHeader;
                            reason = (Buffer.byteLength(prefix + hint + "\n" + block) <= 4500 ? prefix : "") + hint + "\n" + block;
                          }
                        }
                      }
                    } catch { /* Preserve the original guard when outlining is unavailable. */ }
                  }
                  recordInterception({
                    sessionId,
                    agent: agentName,
                    cwd,
                    toolName,
                    path: filePath,
                    size: stat.size,
                    returnedBytes: Buffer.byteLength(outlineBlock),
                    reason
                  });

                  try {
                    getSharedStore().recordGhostInterception({
                      sessionId,
                      filePath: absPath,
                      fileSize: stat.size,
                      cutoffBytes: tierCutoffBytes
                    });
                  } catch {}

                  await touchWatchdogPreTool("deny");
                  return done({ decision: "deny", reason });
                }
              } else if (
                byteOffset === 0 &&
                endLine !== null &&
                isLargeFile &&
                (confirmScope.refreshOnAllow || confirmScope.consumeOnAllow)
              ) {
                // Agent obeyed Strike 1 with a compliant narrow slice: clear any stale :full confirm token
                try {
                  getSharedStore().deleteMeta(fullConfirmKey);
                } catch {}
              }
            }
          }
        }

        // 1b. State 1 (First read) / Strike 2 bypass / stale baseline / large rewrite fallback:
        // Record this allowed read (resets bypass_armed = 0) and save compressed snapshot baseline anchored to this full read.
        if (canUseReadCache && (meetsDedupMinBytes || meetsDiffMinBytes) && byteOffset <= 0) {
          if (!readBounds) {
            readBounds = computeEffectiveReadBounds(
              absPath,
              startLine,
              endLine,
              stat.size,
              HOST_READ_MAX_LINES,
              HOST_READ_MAX_BYTES,
              readCtx
            );
            effectiveEndLine = readBounds.effectiveEndLine;
          }
          if (!readBounds.skipCache) {
            try {
              const store = getSharedStore();
              if (!convTurnSeqLoaded) {
                convTurnSeq = store.getConversationTurnSeq(directConvId);
                convTurnSeqLoaded = true;
              }
              if (meetsDedupMinBytes) {
                store.recordFileRead({
                  sessionId: directConvId,
                  filePath: absPath,
                  startLine,
                  endLine: effectiveEndLine,
                  mtimeMs: stat.mtimeMs,
                  fileSize: stat.size,
                  ctimeMs: stat.ctimeMs,
                  ino: stat.ino,
                  byteEst: readBounds.hostTruncated ? Math.max(estBytes, HOST_READ_MAX_BYTES) : estBytes,
                  stepIdx: currentStepIdx,
                  turnSeq: convTurnSeq
                });
              }

              if (meetsDiffMinBytes && (await loadCurrentRange())) {
                store.saveFileSnapshot({
                  sessionId: directConvId,
                  filePath: absPath,
                  startLine,
                  endLine: effectiveEndLine,
                  sha256: currentSha256,
                  mtimeMs: stat.mtimeMs,
                  fileSize: stat.size,
                  ino: null,
                  content: currentRangeText,
                  bypassArmed: 0,
                  fullReadTs: Date.now(),
                  fullReadSeq: convTurnSeq,
                  readStep: currentStepIdx
                });
              }
            } catch {
              // Fail-open on DB/diff errors
            }
          }
        }

        // 1c. Track allowed paged recalls against any prior Ghost Registry interception (even if dedup is off)
        if (endLine !== null) {
          try {
            const store = getSharedStore();
            if (store.hasGhostInterception(sessionId, absPath)) {
              const actualBytes = measureLineRangeBytes(absPath, startLine, endLine, stat.size, estBytes, readCtx);
              store.recordGhostRecall({
                sessionId,
                filePath: absPath,
                bytesRead: actualBytes
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 2. Guard run_command:
  //    2a. Trusted built-in CLI filter rewrites (e.g. bounds `git log` -> `git log -n 30`)
  //    2b. Hard-deny unbounded raw file dumps / stdout downloads / unbounded git log (when CLI filter off)
  //        (MUST execute BEFORE untrusted repo-level `.agy-dart/filters.json` rules!)
  //    2c. Custom project-level declarative CLI filter rules (`.agy-dart/filters.json`)
  if (toolName === "run_command") {
    const cmdKey =
      "CommandLine" in args
        ? "CommandLine"
        : "commandLine" in args
          ? "commandLine"
          : "command";
    const rawCommandLine = args[cmdKey] || "";
    const trimmedCmd = String(rawCommandLine).trim();
    const isDaemon = Boolean(args.IsDaemon || args.isDaemon || args.run_in_background || args.runInBackground);
    const rawWaitMs = args.WaitMsBeforeAsync ?? args.waitMsBeforeAsync;
    const parsedWaitMs =
      rawWaitMs !== undefined && rawWaitMs !== null && rawWaitMs !== "" && typeof rawWaitMs !== "boolean"
        ? Number(rawWaitMs)
        : NaN;
    const asyncBypassMs = Number(effectiveCfg.cliFilterAsyncBypassMs ?? 2000);
    const isAsyncBackground =
      asyncBypassMs > 0 && Number.isFinite(parsedWaitMs) && parsedWaitMs >= 0 && parsedWaitMs <= asyncBypassMs;
    const bypassCliFilter = isDaemon || isAsyncBackground;
    const sandboxReadOverride = !/["$`\r\n)]/.test(PLUGIN_ROOT_POSIX)
      ? [`read_file(${PLUGIN_ROOT_POSIX})`]
      : undefined;

    let cliFilterEnabled = true;
    let cliSessionId = sessionId;
    try {
      const st = getSharedStore();
      cliFilterEnabled = st.isCliFilterEnabled(sessionId);
      if (typeof st.resolveRootSessionId === "function") {
        cliSessionId = st.resolveRootSessionId(sessionId);
      }
    } catch {}

    // 2a. Trusted built-in CLI filter rules
    if (cliFilterEnabled && !bypassCliFilter && trimmedCmd) {
      const builtinRewrite = buildCliFilterRewrite(trimmedCmd, cliSessionId, cwd, { builtinOnly: true });
      if (builtinRewrite) {
        await touchWatchdogPreTool("allow");
        return done({
          decision: "allow",
          overwrite: {
            [cmdKey]: builtinRewrite.rewrittenCommand
          },
          ...(sandboxReadOverride ? { permissionOverrides: sandboxReadOverride } : {})
        });
      }
    }

    // 2b. Hard-deny unbounded raw file dumps / stdout downloads / unbounded git log / sensitive file dumps
    let inspection = inspectCommand({
      commandLine: rawCommandLine,
      cwd,
      sessionId,
      sensitiveGuardMode: effectiveCfg.sensitiveFileGuard
    });
    if (!inspection.shouldDeny && trimmedCmd && unwrapSafeCompoundCommandFn && resolveCdTargetCwdFn) {
      const unwrapped = unwrapSafeCompoundCommandFn(trimmedCmd);
      if (unwrapped && (unwrapped.cdPath || unwrapped.hasStderrRedirect)) {
        const targetCwd = unwrapped.cdPath ? resolveCdTargetCwdFn(cwd, unwrapped.cdPath) : cwd;
        inspection = inspectCommand({
          commandLine: unwrapped.innerCommand,
          cwd: targetCwd,
          sessionId,
          sensitiveGuardMode: effectiveCfg.sensitiveFileGuard
        });
      }
    }

    if (inspection.shouldDeny) {
      recordInterception({
        sessionId,
        agent: agentName,
        cwd,
        toolName,
        path: inspection.targetPath || cleanStringArg(rawCommandLine),
        size: inspection.size || 32768,
        reason: inspection.reason
      });

      await touchWatchdogPreTool("deny");
      return done({ decision: "deny", reason: inspection.reason });
    }

    // 2c. Project-level declarative CLI filter rules (only after hard-deny security checks pass)
    if (cliFilterEnabled && !bypassCliFilter && trimmedCmd) {
      const customRewrite = buildCliFilterRewrite(trimmedCmd, cliSessionId, cwd, { customOnly: true });
      if (customRewrite) {
        await touchWatchdogPreTool("allow");
        return done({
          decision: "allow",
          overwrite: {
            [cmdKey]: customRewrite.rewrittenCommand
          },
          ...(sandboxReadOverride ? { permissionOverrides: sandboxReadOverride } : {})
        });
      }
    }
  }

  await touchWatchdogPreTool("allow");
  return done({ decision: "allow" });
  } finally {
    closeSharedStore();
  }
}

async function main() {
  enableVersionedCompileCache();
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    process.exit(0);
  }
  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    process.exit(0);
  }
  const { verdict, bridgeInput } = await evaluatePreToolPayload(payload);
  process.stdout.write(JSON.stringify(formatHookVerdict(verdict, bridgeInput)) + "\n");
  process.exit(0);
}

if (isDirectRun) {
  main().catch(() => {
    closeSharedStore();
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    process.exit(0);
  });
}
