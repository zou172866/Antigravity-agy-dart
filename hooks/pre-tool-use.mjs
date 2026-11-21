#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_FILTER_SCRIPT = path.resolve(__dirname, "cli-filter.mjs");

function isMainModule() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(process.argv[1]) === norm(__filename);
}

const isDirectRun = isMainModule();

// Dynamically loaded AFTER enableVersionedCompileCache() in CLI runs so Node's V8 compile cache
// actually caches store.js & filter-rules.mjs AND 0-SQLite fast paths skip loading them entirely.
let ContextModeStoreClass = null;
let matchFilterRuleFn = null;
let unwrapSafeCompoundCommandFn = null;
let resolveCdTargetCwdFn = null;
let parseGitSubcommandFn = null;
let securityModule = null;
let textDiffModule = null;

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

if (!isDirectRun) {
  await Promise.all([ensureStoreClass(), ensureFilterRules(), ensureSecurityModule(), ensureTextDiffModule()]);
}

export const DEFAULT_MAX_READ_BYTES = 16384; // 16 KB balanced default (~410 lines)
export const DEFAULT_MAX_LINE_RANGE = 410;
export const HOST_READ_MAX_LINES = 800; // Antigravity read_file host return cap (lines)
export const HOST_READ_MAX_BYTES = 46080; // Antigravity read_file host return cap (bytes)
export const MIN_DEDUP_FILE_BYTES = 1024;
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

function getExemptExtensions(sessionId = null) {
  try {
    return getSharedStore().getExemptExtensions(sessionId);
  } catch {
    return Array.from(BINARY_EXTENSIONS);
  }
}

function getMaxLineRange(maxReadBytes = DEFAULT_MAX_READ_BYTES) {
  const cfgRange = getEffectiveConfig().maxLineRange;
  if (cfgRange !== null && cfgRange !== undefined && cfgRange > 0) {
    return cfgRange;
  }
  if (maxReadBytes === 0) return 0;
  return Math.max(50, Math.round(maxReadBytes / 40));
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
  if (val === undefined || val === null) return null;
  const str = cleanStringArg(val);
  if (!str || str.toLowerCase() === "null" || str.toLowerCase() === "undefined") {
    return null;
  }
  const parsed = parseInt(str, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

const KNOWN_TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".rst", ".adoc",
  ".cs", ".csx", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyw", ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh",
  ".rs", ".go", ".java", ".kt", ".kts", ".scala", ".rb", ".php",
  ".sh", ".bash", ".ps1", ".psm1", ".psd1", ".bat", ".cmd",
  ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less",
  ".json", ".jsonc", ".json5", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".sql", ".graphql", ".gql", ".diff", ".patch", ".txt", ".text", ".log", ".csv", ".tsv",
  ".vue", ".svelte", ".gd"
]);

const BINARY_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".tif",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".mp4", ".webm", ".mkv", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".blend", ".fbx", ".obj", ".gltf", ".glb", ".wasm"
]);

const AGENT_INSTRUCTION_BASENAMES = new Set([
  "skill.md",
  "agents.md",
  "gemini.md",
  "claude.md"
]);

function isUserAttachedFile(filePath, absPath) {
  const normalized = (absPath || filePath || "").replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.user_uploaded/") ||
    normalized.includes("/user_uploaded/") ||
    normalized.includes("/.system_generated/uploads/")
  );
}

/** Exempt Antigravity's own skills, rules, and builtin manuals so agents can read instructions whole */
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
    lower.includes("/.agents/skills/") ||
    lower.includes("/.agents/rules/")
  );
}

function isBinaryFile(absPath, ext) {
  const lowerExt = (ext || "").toLowerCase();
  if (KNOWN_TEXT_EXTENSIONS.has(lowerExt)) return false;
  if (BINARY_EXTENSIONS.has(lowerExt)) return true;
  try {
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
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

export function resolveSharedSessionId(payload = {}) {
  return (
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

export function resolveDirectConversationId(payload = {}, env = process.env) {
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    env?.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

export function hasExplicitConversationId(payload = {}, env = process.env) {
  const raw =
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    env?.ANTIGRAVITY_CONVERSATION_ID ||
    "";
  return typeof raw === "string" && raw.trim().length > 0 && raw.trim() !== "default";
}

export function isSubagentReadPayload(payload = {}, env = process.env) {
  if (env?.ANTIGRAVITY_PARENT_CONVERSATION_ID) return true;
  const envSub = String(env?.ANTIGRAVITY_SUBAGENT || "").trim().toLowerCase();
  if (envSub === "1" || envSub === "true") return true;
  if (!payload || typeof payload !== "object") return false;
  if (payload.subagent === true || payload.isSubagent === true || payload.is_subagent === true) return true;
  if (payload.parentConversationId || payload.parent_conversation_id || payload.parentSessionId || payload.parent_session_id) {
    return true;
  }
  const rootId = payload.rootConversationId || payload.root_conversation_id || "";
  const convId = payload.conversationId || payload.conversation_id || payload.sessionId || payload.session_id || "";
  if (rootId && convId && rootId !== convId) return true;
  return false;
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
    getSharedStore().recordEvent({
      sessionId: sessionId || "default",
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

function readUtf8TextSafe(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
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

/** Measure exact UTF-8 byte length of 1-based inclusive line range [startLine..endLine] */
function measureLineRangeBytes(absPath, startLine, endLine, fileSize, fallbackBytes) {
  if (endLine === null || endLine === undefined) return fallbackBytes;
  const sLine = Math.max(1, Number(startLine) || 1);
  const eLine = Number(endLine);
  if (!Number.isFinite(eLine) || eLine < sLine) return 0;
  if (fileSize > MAX_SLICE_MEASURE_BYTES) return fallbackBytes;
  try {
    const buf = fs.readFileSync(absPath);
    if (buf.length === 0) return 0;
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
    if (rangeStart === null) return 0;
    return Math.max(0, rangeEnd - rangeStart);
  } catch {
    return fallbackBytes;
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
  maxHostBytes = HOST_READ_MAX_BYTES
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
    const buf = fs.readFileSync(absPath);
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

function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const onData = (chunk) => {
      data += chunk;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
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
    if (!tok) continue;
    if (skipNextValue) {
      skipNextValue = false;
      continue;
    }
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

export function inspectCommand({ commandLine, cwd, sessionId }) {
  if (!commandLine || typeof commandLine !== "string") {
    return { shouldDeny: false };
  }

  const cleanCmd = cleanStringArg(commandLine);
  const maxReadBytes = getMaxReadBytes(sessionId);
  const exemptExtensions = getExemptExtensions(sessionId);

  // 1. Unbounded git log (supports safe leading global git options like `-C <path>`, `--no-pager`, `-P`, `--git-dir`, `--work-tree`)
  const gitParsed = parseGitSubcommandFn ? parseGitSubcommandFn(cleanCmd) : null;
  const isGitLog =
    (gitParsed && gitParsed.subcommand === "log") ||
    (!parseGitSubcommandFn && /^\s*git(?:\.exe)?\s+log\b/i.test(cleanCmd));
  if (isGitLog) {
    const gitLogArgs = gitParsed ? gitParsed.rest : cleanCmd;
    const isLimited =
      /(?:^|\s)(?:-n\s*\d+|-\d+|--max-count(?:=|\s)\d+|--since(?:=|\s)\S+|--after(?:=|\s)\S+|\S+\.\.\S+)(?=\s|$)|\s*\|\s*(?:head|Select-Object|select|more)\b/i.test(
        gitLogArgs
      );
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

  // 2. Direct curl / wget to stdout
  const fetchMatch = cleanCmd.match(/^\s*(curl|wget)(?:\.exe)?\b/i);
  if (fetchMatch) {
    const isCurl = fetchMatch[1].toLowerCase() === "curl";
    const writesToFile =
      />\s*[^>]/i.test(cmdNoStderrRedir) ||
      /(?:^|\s)(?:-o|-O|--output|--output-document)(?:=|\s+)(?!["']?-(?:["']?)(?:\s|$|[;|&]))(?:"[^"]+"|'[^']+'|\S+)/.test(
        cmdNoStderrRedir
      ) ||
      (isCurl && /(?:^|\s)(?:-O|--remote-name)(?=\s|$|[;|&])/.test(cmdNoStderrRedir));
    const hasLimiter = /\|\s*(head|Select-Object|select|more)/i.test(cmdNoStderrRedir);
    if (!writesToFile && !hasLimiter) {
      const urlMatch = cleanCmd.match(/https?:\/\/[^\s"']+/i);
      if (urlMatch) {
        try {
          const parsedUrl = new URL(urlMatch[0]);
          const ext = path.extname(parsedUrl.pathname).toLowerCase();
          if (ext && exemptExtensions.includes(ext)) {
            return { shouldDeny: false };
          }
        } catch {}
      }
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

    const hasLimiter =
      /(-Head|-TotalCount|-First|-Tail)\s+\d+/i.test(cmdNoStderrRedir) ||
      /\|\s*(head|Select-Object|select\s+(-[a-zA-Z]+\s+)*-First|more|Out-Null|Set-Content|Out-File)/i.test(cmdNoStderrRedir) ||
      />\s*[^>]/i.test(cmdNoStderrRedir);

    if (hasLimiter) return { shouldDeny: false };

    const restAfterVerb = cmdNoStderrRedir.slice(printMatch[0].length);
    const rawTargets = extractFileDumpTargets(restAfterVerb);

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
          if (isAgentInstructionFile(rawTarget, absPath)) continue;
          const ext = path.extname(absPath).toLowerCase();
          if (ext && exemptExtensions.includes(ext)) continue;
          const stat = fs.statSync(absPath);
          cumulativeNonExemptBytes += stat.size;
          if (maxReadBytes > 0 && (stat.size > maxReadBytes || cumulativeNonExemptBytes > maxReadBytes)) {
            const reportSize = Math.max(stat.size, cumulativeNonExemptBytes);
            return {
              shouldDeny: true,
              reason:
                `[agy-dart protection] Command attempts an un-paged dump of '${cleanTarget}' (${formatBytes(reportSize)}), ` +
                `exceeding the ${formatBytes(maxReadBytes)} context limit. ` +
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

function finishAllow() {
  closeSharedStore();
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
  process.exit(0);
}

async function main() {
  enableVersionedCompileCache();

  const rawInput = await readStdin();
  if (!rawInput.trim()) return finishAllow();

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return finishAllow();
  }

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};
  const cwd = payload.cwd || process.cwd();
  const sessionId = resolveSharedSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);
  const isSubagentCall = isSubagentReadPayload(payload);
  const agentName = resolveAgentName(payload);
  const effectiveCfg = getEffectiveConfig();

  // 0-SQLite fast path: bypass DB & heavy module loading entirely for unconditionally allowed tools/files
  if (toolName !== "read_file" && toolName !== "view_file" && toolName !== "run_command") {
    return finishAllow();
  }

  let preParsedRead = null;
  if (toolName === "read_file" || toolName === "view_file") {
    if (!effectiveCfg.readHook) {
      return finishAllow();
    }
    const rawFilePath = args.Path || args.path || args.filePath || args.AbsolutePath || args.absolutePath || "";
    const filePath = cleanFilePath(rawFilePath);
    if (!filePath) {
      return finishAllow();
    }
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const ext = path.extname(absPath).toLowerCase();
    if (
      isUserAttachedFile(rawFilePath, absPath) ||
      isAgentInstructionFile(rawFilePath, absPath) ||
      BINARY_EXTENSIONS.has(ext)
    ) {
      return finishAllow();
    }
    preParsedRead = { rawFilePath, filePath, absPath, ext };
  }

  // Load ContextModeStore (and filter-rules for run_command) AFTER enableVersionedCompileCache()
  // so V8 bytecode caching captures these heavy modules on every guarded invocation.
  await ensureStoreClass();
  if (toolName === "run_command") {
    await ensureFilterRules();
  }

  if (isProtectionPaused(sessionId)) {
    return finishAllow();
  }

  // 1. Guard read_file / view_file (unless disabled via env for ultra-low-latency mode B)
  if (preParsedRead) {
    const { filePath, absPath, ext } = preParsedRead;
    const rawStartLine = parseLineArg(args.StartLine ?? args.startLine ?? args.start_line);
    const startLine = rawStartLine !== null && rawStartLine >= 1 ? rawStartLine : 1;
    const rawEndLine = parseLineArg(args.EndLine ?? args.endLine ?? args.end_line);
    const endLine = rawEndLine !== null && rawEndLine > 0 ? rawEndLine : null;
    const maxReadBytes = getMaxReadBytes(sessionId);
    const maxLineRange = getMaxLineRange(maxReadBytes);

    try {
      if (fs.existsSync(absPath)) {
        const rawStat = fs.statSync(absPath, { bigint: true });
        if (!rawStat.isFile()) {
          return finishAllow();
        }
        const stat = {
          size: Number(rawStat.size),
          mtimeMs: Number(rawStat.mtimeNs / 1000n) / 1000,
          ctimeMs: Number(rawStat.ctimeNs / 1000n) / 1000,
          ino: String(rawStat.ino)
        };

        // Optional sensitive credential file read guard (opt-in via config/AGY_DART_SENSITIVE_FILE_GUARD=warn|deny)
        const rawSensMode = effectiveCfg.sensitiveFileGuard || "off";
        if (rawSensMode === "warn" || rawSensMode === "deny") {
          const sec = await ensureSecurityModule();
          const guardMode = sec.getSensitiveFileGuardMode();
          if (guardMode === "warn" || guardMode === "deny") {
            let realAbsPath = absPath;
            try {
              realAbsPath = fs.realpathSync(absPath);
            } catch {}
            const sensDirect = sec.detectSensitiveFile(absPath);
            const sensReal =
              realAbsPath !== absPath ? sec.detectSensitiveFile(realAbsPath) : { sensitive: false, reason: null };
            const sens = sensDirect.sensitive ? sensDirect : sensReal;
            if (sens.sensitive) {
              const normKey = process.platform === "win32" ? absPath.toLowerCase() : absPath;
              const confirmKey = `sensitive_read_confirm:${sessionId}:${normKey}`;
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
                closeSharedStore();
                process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n");
                process.exit(0);
              }
              const confirmed = getSharedStore().getTimedMeta(confirmKey, "");
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
                closeSharedStore();
                process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n");
                process.exit(0);
              }
            }
          }
        }

        const exemptExtensions = getExemptExtensions(sessionId);
        const isExemptExt = exemptExtensions.includes(ext);
        const isBinary = isBinaryFile(absPath, ext);

        if (isExemptExt || isBinary) {
          return finishAllow();
        }

        const isLargeFile = maxReadBytes > 0 && stat.size > maxReadBytes;
        const isWideRange = maxLineRange > 0 && (endLine === null || (endLine - startLine) > maxLineRange);

        if (isLargeFile && isWideRange) {
          const lineInstruction =
            maxLineRange > 0
              ? ` or outline via ${FAST_SERVER} read_slices({ outlines }) then pass StartLine/EndLine (<= ${maxLineRange} lines).`
              : "";
          const reason =
            `[agy-dart protection] File is ${formatBytes(stat.size)} (~${Math.round(stat.size / 4).toLocaleString()} tokens), exceeding the ${formatBytes(maxReadBytes)} context limit. ` +
            `Reading the entire file risks severe context bloat. ` +
            `For logs/docs/data use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_index" or "ctx_execute", path:"${filePath}")${lineInstruction}`;

          recordInterception({
            sessionId,
            agent: agentName,
            cwd,
            toolName,
            path: filePath,
            size: stat.size,
            reason
          });

          try {
            getSharedStore().recordGhostInterception({
              sessionId,
              filePath: absPath,
              fileSize: stat.size,
              cutoffBytes: maxReadBytes
            });
          } catch {}

          closeSharedStore();
          process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n");
          process.exit(0);
        }

        // 1b. Three-State Session File Read Cache: Full -> Unchanged Dedup -> Compact Unified Diff on Modified
        const byteOffset = parseLineArg(args.ByteOffset ?? args.byteOffset) ?? 0;
        const estBytes =
          endLine !== null
            ? Math.min(stat.size, Math.max(MIN_DEDUP_FILE_BYTES, Math.max(1, endLine - startLine + 1) * 45))
            : stat.size;
        let dedupEnabled = true;
        try {
          dedupEnabled = getSharedStore().isReadDedupEnabled(sessionId);
        } catch {}

        const hasExplicitConvId = hasExplicitConversationId(payload);
        const subagentSharesParentContext = isSubagentCall && directConvId === sessionId;
        const canUseReadCache = dedupEnabled && hasExplicitConvId && !subagentSharesParentContext;
        const diffReadEnabled =
          canUseReadCache &&
          effectiveCfg.diffRead === true &&
          stat.size <= MAX_SNAPSHOT_FILE_BYTES;
        const diffReadMaxTurns = effectiveCfg.diffReadMaxTurns;
        const diffReadMaxAgeMs = effectiveCfg.diffReadMaxAgeMs;

        if (canUseReadCache && stat.size >= MIN_DEDUP_FILE_BYTES && byteOffset <= 0) {
          const readBounds = computeEffectiveReadBounds(absPath, startLine, endLine, stat.size);
          const effectiveEndLine = readBounds.effectiveEndLine;
          if (!readBounds.skipCache) {
            try {
              const store = getSharedStore();
              const convTurnSeq = diffReadEnabled ? store.getConversationTurnSeq(directConvId) : 0;
              const dup = store.findDuplicateRead({
                sessionId: directConvId,
                filePath: absPath,
                startLine,
                endLine: effectiveEndLine,
                mtimeMs: stat.mtimeMs,
                fileSize: stat.size,
                ctimeMs: stat.ctimeMs,
                ino: stat.ino
              });

              // State 2 (Unchanged covering read): 2-strike bypass
              if (dup && Number(dup.bypass_armed) === 0) {
                store.armReadBypass({
                  sessionId: directConvId,
                  filePath: absPath,
                  startLine: dup.start_line,
                  endLine: dup.end_line
                });
                const rangeLabel = effectiveEndLine !== null ? `lines ${startLine}-${effectiveEndLine}` : "full file";
                const dedupReason =
                  `[agy-dart read-dedup] '${filePath}' (${rangeLabel}, ~${formatBytes(estBytes)}) was already read unchanged earlier in this session ` +
                  `(mtime & size identical). Reuse the copy already in context to save tokens; if context was compacted and you truly need a fresh copy, call ${toolName} once more to bypass.`;

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

                closeSharedStore();
                process.stdout.write(JSON.stringify({ decision: "deny", reason: dedupReason }) + "\n");
                process.exit(0);
              }

              let currentRangeText = null;
              let currentSha256 = null;
              let currentRangeBytes = 0;

              const loadCurrentRange = async () => {
                if (currentRangeText !== null) return true;
                const rawDisk = readUtf8TextSafe(absPath);
                if (rawDisk === null) return false;
                const { extractLineSlice } = await ensureTextDiffModule();
                currentRangeText = extractLineSlice(rawDisk, startLine, effectiveEndLine, 1);
                const sliceBytes = Buffer.byteLength(currentRangeText, "utf8");
                currentRangeBytes =
                  effectiveEndLine === null && startLine === 1 ? Math.max(sliceBytes, stat.size) : sliceBytes;
                currentSha256 = sha256Text(currentRangeText);
                return true;
              };

              // State 3 (Modified file previously snapshotted in the SAME direct conversation within recent N turns & age)
              // Omit `ino` filter here so atomic-rename edits (apply_edits, git checkout, prettier) still hit the baseline;
              // MAX_DIFF_READ_RATIO (0.4) already guards against unrelated file replacement.
              if (!dup && diffReadEnabled) {
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
                const bypassArmed = Boolean(snapshot && Number(snapshot.bypass_armed) === 1);
                const ageFresh = !snapshot || (diffReadMaxAgeMs <= 0) || (Date.now() - baselineFullTs <= diffReadMaxAgeMs);
                const turnsFresh =
                  !snapshot ||
                  diffReadMaxTurns <= 0 ||
                  convTurnSeq - Math.max(0, baselineFullSeq) <= diffReadMaxTurns;

                // Never chain a second diff when bypass_armed === 1 (a prior diff was already delivered
                // without a subsequent full verbatim read): fall through to full-file allow and re-anchor baseline.
                if (snapshot && !bypassArmed && ageFresh && turnsFresh && (await loadCurrentRange())) {
                  const { computeUnifiedDiff, extractLineSlice } = await ensureTextDiffModule();
                  const baselineText = snapshot.isExactRange
                    ? snapshot.content
                    : extractLineSlice(snapshot.content, startLine, effectiveEndLine, snapshot.start_line);
                  const baselineSha256 = snapshot.isExactRange ? snapshot.sha256 : sha256Text(baselineText);

                  if (currentSha256 === baselineSha256) {
                    // PostToolUse edit invalidation with unchanged disk bytes (v1.1 compatibility) -> allow full verbatim.
                  } else if (currentRangeBytes >= MIN_DIFF_READ_BYTES) {
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
                        fullReadSeq: baselineFullSeq || convTurnSeq
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

                      closeSharedStore();
                      process.stdout.write(JSON.stringify({ decision: "deny", reason: diffReason }) + "\n");
                      process.exit(0);
                    }
                  }
                }
              }

              // State 1 (First read) / Strike 2 bypass / stale baseline / large rewrite fallback:
              // Record this allowed read (resets bypass_armed = 0) and save compressed snapshot baseline anchored to this full read.
              store.recordFileRead({
                sessionId: directConvId,
                filePath: absPath,
                startLine,
                endLine: effectiveEndLine,
                mtimeMs: stat.mtimeMs,
                fileSize: stat.size,
                ctimeMs: stat.ctimeMs,
                ino: stat.ino,
                byteEst: estBytes
              });

              if (diffReadEnabled && (await loadCurrentRange())) {
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
                  fullReadSeq: convTurnSeq
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
              const actualBytes = measureLineRangeBytes(absPath, startLine, endLine, stat.size, estBytes);
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
    const isDaemon = Boolean(args.IsDaemon || args.isDaemon);

    let cliFilterEnabled = true;
    try {
      cliFilterEnabled = getSharedStore().isCliFilterEnabled(sessionId);
    } catch {}

    // 2a. Trusted built-in CLI filter rules
    if (cliFilterEnabled && !isDaemon && trimmedCmd) {
      const builtinRewrite = buildCliFilterRewrite(trimmedCmd, sessionId, cwd, { builtinOnly: true });
      if (builtinRewrite) {
        closeSharedStore();
        process.stdout.write(
          JSON.stringify({
            decision: "allow",
            overwrite: {
              [cmdKey]: builtinRewrite.rewrittenCommand
            }
          }) + "\n"
        );
        process.exit(0);
      }
    }

    // 2b. Hard-deny unbounded raw file dumps / stdout downloads / unbounded git log
    let inspection = inspectCommand({ commandLine: rawCommandLine, cwd, sessionId });
    if (!inspection.shouldDeny && trimmedCmd && unwrapSafeCompoundCommandFn && resolveCdTargetCwdFn) {
      const unwrapped = unwrapSafeCompoundCommandFn(trimmedCmd);
      if (unwrapped && (unwrapped.cdPath || unwrapped.hasStderrRedirect)) {
        const targetCwd = unwrapped.cdPath ? resolveCdTargetCwdFn(cwd, unwrapped.cdPath) : cwd;
        inspection = inspectCommand({ commandLine: unwrapped.innerCommand, cwd: targetCwd, sessionId });
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

      closeSharedStore();
      process.stdout.write(JSON.stringify({ decision: "deny", reason: inspection.reason }) + "\n");
      process.exit(0);
    }

    // 2c. Project-level declarative CLI filter rules (only after hard-deny security checks pass)
    if (cliFilterEnabled && !isDaemon && trimmedCmd) {
      const customRewrite = buildCliFilterRewrite(trimmedCmd, sessionId, cwd, { customOnly: true });
      if (customRewrite) {
        closeSharedStore();
        process.stdout.write(
          JSON.stringify({
            decision: "allow",
            overwrite: {
              [cmdKey]: customRewrite.rewrittenCommand
            }
          }) + "\n"
        );
        process.exit(0);
      }
    }
  }

  return finishAllow();
}

if (isDirectRun) {
  main().catch(() => {
    finishAllow();
  });
}
