/**
 * Read-only Safety Monitor Quota-Burn Auditor for Antigravity Desktop & CLI (Issue #1886).
 *
 * Grounded in verified Desktop (`language_server.log`) and CLI (`cli-*.log`) telemetry:
 *  - Stage 1: local rule gate `agy_tool_safety` (`allowed_tool` vs `unquoted_shell_operators` / `unknown_command` / `unsupported_tool: <name>`)
 *  - Stage 2: lightweight cloud pre-check `sir_flash_lite` (`MODEL_TIER_FLASH_LITE`, ~48K char cap, ~4,400/5h quota cliff)
 *  - Stage 3: heavy secondary review `severe_internal_risks_agy` (`gemini-4-hydrogen-sonar`, ~300K char cap)
 *  - Exact HTTP attribution via shared goroutine/thread ID (`tid`) on `http_helpers.go` `streamGenerateContent`
 *  - Incremental byte-offset reader + fast substring pre-filter (handles 140+ MB noisy Desktop logs in ms)
 *  - Atomic rolling-bucket persistence (`safety-audit-state.json`) so Desktop restart truncations never erase 5h history
 *  - Strictly zero external dependencies, strictly read-only on Antigravity logs, fail-open, and secret-redacted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getEffectiveConfig } from "./config.js";
import { redactSecrets } from "./security.js";
import { stableSortObject } from "./stable-json.js";

export const SAFETY_AUDIT_SCHEMA_VERSION = "1.0";
const STATE_FILE_VERSION = 1;

export const DEFAULT_SAFETY_CONFIG = Object.freeze({
  windowHours: 5,
  retentionHours: 24,
  precheckWarnCount: 3500,
  precheckLimit: 4400,
  heavyBurstCount: 3,
  heavyBurstWindowMin: 5,
  stickyCharThreshold: 150000,
  maxColdScanBytes: 256 * 1024 * 1024,
  maxFiles: 24,
  readChunkBytes: 256 * 1024,
  maxRecentHeavyEvents: 30,
  tidStaleMs: 2 * 60 * 1000
});

export const FAST_PREFILTER_SUBSTRINGS = Object.freeze([
  "Monitor ",
  "LLM Monitor ",
  "streamGenerateContent",
  "RESOURCE_EXHAUSTED",
  "Too Many Requests",
  "parent sir_flash_lite",
  "running it anyway",
  "[Sonar]",
  "429"
]);

export const DEFAULT_LOG_PATTERNS = Object.freeze({
  // Global header matcher used to split Windows CLI interleaved goroutine lines safely
  glogHeaderGlobal:
    /(?:ERROR: logging before google\.Init:\s*)?[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+[A-Za-z0-9_.-]+:\d+\]/g,
  glogHeaderLine:
    /^(?:ERROR: logging before google\.Init:\s*)?(?<level>[IWEF])(?<mmdd>\d{4}) (?<time>\d{2}:\d{2}:\d{2}\.\d+)\s+(?<tid>\d+)\s+(?<file>[A-Za-z0-9_.-]+):(?<line>\d+)\]\s*(?<msg>.*)$/,
  monitorFinished:
    /^Monitor (?<monitor>\S+) FINISHED: triggered=(?<triggered>true|false)(?:, reason="(?<reason>.*)")?, duration=(?<duration>[0-9.]+(?:ns|µs|us|ms|s))$/,
  monitorSkipped: /^Monitor (?<monitor>\S+) SKIPPED\b/,
  llmMonitorStart: /^LLM Monitor (?<monitor>\S+): Starting evaluation$/,
  llmMonitorTrajectory: /^LLM Monitor (?<monitor>\S+): Trajectory formatted, length: (?<chars>\d+)$/,
  llmMonitorCalling: /^LLM Monitor (?<monitor>\S+): Calling LLM \(model: (?<model>[^)]+)\)$/,
  llmMonitorResponse: /^LLM Monitor (?<monitor>\S+): LLM response received, length: (?<chars>\d+)$/,
  llmMonitorComplete:
    /^LLM Monitor (?<monitor>\S+): Evaluation complete\. Triggered: (?<triggered>true|false), Severity: (?<severity>\d+), Confidence: (?<confidence>\d+)$/,
  streamGenerateContent: /^URL:\s+(?<url>https:\/\/[^\s]+streamGenerateContent[^\s]*)/,
  sonarActiveTags:
    /^\[Sonar\] Resolved active tags: \[(?<tags>[^\]]*)\] \(detected surface: "(?<surface>[^"]*)"\)$/,
  mainLogRestart:
    /^\[(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]\s+\[info\]\s+Starting app \((?<version>[^)]+)\)/,
  http429Strict: /(?:RESOURCE_EXHAUSTED|Too Many Requests|(?:HTTP|status|code|err(?:or)?)[=:\s(]+429\b)/i,
  parentFailedFallback: /(?:parent\s+sir_flash_lite\s+failed|running it anyway)/i,
  isoTimestamp: /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/,
  fallbackHeavyModel: /\b(?:severe_internal_risks_agy|gemini-4-hydrogen-sonar|hydrogen-sonar)\b/i,
  fallbackTrajectoryChars:
    /(?:(?:trajectory[_\s]?(?:formatted[,\s]+)?(?:length|chars)|payload[_\s]?chars|chars)\s*[=:]\s*(\d+)|(\d[\d,]{3,})\s*chars?\b|~?(\d+(?:\.\d+)?)\s*[kK]\s*chars?\b)/i,
  cliLogFilename: /^cli-(\d{8})_(\d{6})\.log$/i
});

const ANSI_AND_CTRL_RE = /(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f])/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,24}\b/g;

// In-process memo cache keyed by stateKey for near-zero-cost repeated polling
let memoryStateCache = new Map();

export function resetSafetyAuditCache() {
  memoryStateCache = new Map();
}

function stripLoneSurrogates(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // skip unpaired low surrogate
    } else {
      out += text[i];
    }
  }
  return out;
}

export function sanitizeSafetyText(raw, maxLen = 220, homeDir = os.homedir()) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw)
    .replace(ANSI_AND_CTRL_RE, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (homeDir) {
    const normHome = String(homeDir).replace(/\\/g, "/").replace(/\/+$/, "");
    if (normHome.length >= 3) {
      const escapedHome = normHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const homeRe = new RegExp(escapedHome.replace(/\//g, "[\\\\/]"), "gi");
      s = s.replace(homeRe, "~");
    }
  }
  s = s.replace(EMAIL_RE, "[REDACTED:EMAIL]");
  s = redactSecrets(s, { force: true }).text;
  s = stripLoneSurrogates(s);
  if (s.length > maxLen) {
    s = s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
  }
  return s;
}

function anonymizePathForDisplay(absPath, homeDir = os.homedir(), env = process.env) {
  if (!absPath) return "";
  let disp = String(absPath).replace(/\\/g, "/");
  const appData = typeof env?.APPDATA === "string" ? env.APPDATA.trim().replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (appData && disp.toLowerCase().startsWith(appData.toLowerCase() + "/")) {
    disp = "%APPDATA%" + disp.slice(appData.length);
  }
  return sanitizeSafetyText(disp, 180, homeDir);
}

/**
 * Split Windows CLI lines where concurrent goroutines interleaved mid-line without newline.
 * Preserves Desktop `ERROR: logging before google.Init: ` headers intact.
 */
export function splitInterleavedGlogLine(rawLine) {
  if (!rawLine || typeof rawLine !== "string") return [];
  const re = new RegExp(DEFAULT_LOG_PATTERNS.glogHeaderGlobal.source, "g");
  const starts = [];
  let m;
  while ((m = re.exec(rawLine)) !== null) {
    starts.push(m.index);
    if (m[0].length === 0) re.lastIndex++;
  }
  if (starts.length <= 1) {
    return [rawLine];
  }
  const parts = [];
  if (starts[0] > 0) {
    const lead = rawLine.slice(0, starts[0]).trim();
    if (lead) parts.push(lead);
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : rawLine.length;
    const slice = rawLine.slice(starts[i], end).trim();
    if (slice) parts.push(slice);
  }
  return parts;
}

/**
 * Parse glog MMDD + HH:MM:SS.uuuuuu timestamp (local time) inferring year from file mtimeMs
 * with Dec 31 -> Jan 1 rollover handling.
 */
export function parseGlogTimestampMs(mmdd, timeStr, refMs = Date.now()) {
  if (!mmdd || mmdd.length !== 4 || !timeStr) return null;
  const month = Number(mmdd.slice(0, 2));
  const day = Number(mmdd.slice(2, 4));
  const timeMatch = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!timeMatch || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hh = Number(timeMatch[1]);
  const mm = Number(timeMatch[2]);
  const ss = Number(timeMatch[3]);
  const frac = (timeMatch[4] || "0").slice(0, 3).padEnd(3, "0");
  const ms = Number(frac);
  if (hh > 23 || mm > 59 || ss > 59) return null;

  const refDate = new Date(Number.isFinite(refMs) && refMs > 0 ? refMs : Date.now());
  const baseYear = refDate.getFullYear();
  let candidate = new Date(baseYear, month - 1, day, hh, mm, ss, ms).getTime();
  if (!Number.isFinite(candidate)) return null;

  const thirtySixHours = 36 * 60 * 60 * 1000;
  const halfYear = 180 * 24 * 60 * 60 * 1000;
  if (candidate - refDate.getTime() > thirtySixHours) {
    candidate = new Date(baseYear - 1, month - 1, day, hh, mm, ss, ms).getTime();
  } else if (refDate.getTime() - candidate > halfYear) {
    candidate = new Date(baseYear + 1, month - 1, day, hh, mm, ss, ms).getTime();
  }
  return Number.isFinite(candidate) ? candidate : null;
}

/** Parse Go duration strings like `19µs`, `51.4us`, `12.5ms`, `5.5605827s`, `120ns` into milliseconds. */
export function parseDurationMs(durStr) {
  if (typeof durStr !== "string") return 0;
  const m = durStr.trim().match(/^([0-9.]+)\s*(ns|µs|us|ms|s)$/i);
  if (!m) return 0;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val < 0) return 0;
  const unit = m[2].toLowerCase();
  if (unit === "ns") return val / 1e6;
  if (unit === "µs" || unit === "us") return val / 1e3;
  if (unit === "ms") return val;
  if (unit === "s") return val * 1000;
  return 0;
}

function fastMatchesSafetyPrefilter(line) {
  for (let i = 0; i < FAST_PREFILTER_SUBSTRINGS.length; i++) {
    if (line.includes(FAST_PREFILTER_SUBSTRINGS[i])) return true;
  }
  return false;
}

function normalizeTriggerReason(rawReason) {
  const clean = sanitizeSafetyText(rawReason || "other", 96);
  if (!clean) return "other";
  if (clean === "allowed_tool") return "allowed_tool";
  if (clean === "unquoted_shell_operators") return "unquoted_shell_operators";
  if (clean === "unknown_command") return "unknown_command";
  if (clean === "absolute_path") return "absolute_path";
  const unsup = clean.match(/^unsupported_tool:\s*(.+)$/i);
  if (unsup) {
    const tool = unsup[1].trim().replace(/[^A-Za-z0-9_.:-]/g, "");
    return tool ? `unsupported_tool: ${tool}` : "unsupported_tool";
  }
  return clean;
}

function classifyReasonCategory(reasonKey) {
  if (reasonKey === "unquoted_shell_operators" || reasonKey === "unknown_command") return "shell";
  if (reasonKey === "absolute_path") return "path";
  if (reasonKey.startsWith("unsupported_tool: mcp_agy-dart")) return "agy_dart_mcp";
  if (reasonKey.startsWith("unsupported_tool: mcp_") || reasonKey === "unsupported_tool: call_mcp_tool") {
    return "mcp";
  }
  if (reasonKey.startsWith("unsupported_tool:")) return "native_tool";
  return "other";
}

function createEmptyBucket() {
  return {
    stage1Total: 0,
    stage1Allowed: 0,
    stage1Triggered: 0,
    precheckCalls: 0,
    precheckTriggeredTrue: 0,
    precheckTriggeredFalse: 0,
    precheckCharsTotal: 0,
    precheckCharsMax: 0,
    precheckDurationMs: 0,
    heavyCalls: 0,
    heavyTriggeredTrue: 0,
    heavyTriggeredFalse: 0,
    heavyCharsTotal: 0,
    heavyCharsMax: 0,
    heavyLargeCount: 0,
    heavyDurationMs: 0,
    rateLimit429Count: 0,
    fallbackEscalationCount: 0,
    streamMain: 0,
    streamPrecheck: 0,
    streamHeavy: 0,
    reasons: {}
  };
}

function getOrCreateBucket(buckets, tsMs) {
  const key = String(Math.floor(tsMs / 60000));
  let b = buckets[key];
  if (!b) {
    b = createEmptyBucket();
    buckets[key] = b;
  }
  return b;
}

function createEmptyState() {
  return {
    version: STATE_FILE_VERSION,
    updatedAtMs: 0,
    restartTruncationsDetected: 0,
    files: {},
    buckets: {},
    recentHeavyEvents: [],
    sonarTags: []
  };
}

function pruneState(state, nowMs, retentionHours, maxRecentHeavyEvents) {
  const minMinute = Math.floor((nowMs - retentionHours * 3600 * 1000) / 60000);
  for (const key of Object.keys(state.buckets || {})) {
    const m = Number(key);
    if (!Number.isFinite(m) || m < minMinute) {
      delete state.buckets[key];
    }
  }
  const minTs = nowMs - retentionHours * 3600 * 1000;
  if (Array.isArray(state.recentHeavyEvents)) {
    state.recentHeavyEvents = state.recentHeavyEvents
      .filter((e) => e && Number.isFinite(e.ts) && e.ts >= minTs)
      .sort((a, b) => a.ts - b.ts)
      .slice(-maxRecentHeavyEvents);
  } else {
    state.recentHeavyEvents = [];
  }
  // Keep file cursor table bounded
  const fileEntries = Object.entries(state.files || {});
  if (fileEntries.length > 96) {
    fileEntries.sort((a, b) => Number(b[1]?.mtimeMs || 0) - Number(a[1]?.mtimeMs || 0));
    state.files = Object.fromEntries(fileEntries.slice(0, 96));
  }
}

function safeCanonicalKey(filePath, platform = process.platform) {
  const resolved = path.resolve(filePath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expandPathInput(raw, homeDir = os.homedir(), env = process.env) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (!s) return "";
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(homeDir, s.slice(1));
  }
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, varName) => {
    const v = env?.[varName];
    return typeof v === "string" && v ? v : `%${varName}%`;
  });
  return path.resolve(s);
}

function readMainLogLastRestart(mainLogPath, env = process.env) {
  try {
    const st = fs.lstatSync(mainLogPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0) return null;
    const readSize = Math.min(st.size, 64 * 1024);
    const startOffset = st.size - readSize;
    const fd = fs.openSync(mainLogPath, "r");
    try {
      const buf = Buffer.allocUnsafe(readSize);
      const n = fs.readSync(fd, buf, 0, readSize, startOffset);
      const text = buf.subarray(0, n).toString("utf8");
      const lines = text.split(/\r?\n/);
      let lastRestart = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(DEFAULT_LOG_PATTERNS.mainLogRestart);
        if (m?.groups?.ts) {
          const parsedMs = Date.parse(m.groups.ts.replace(" ", "T"));
          lastRestart = {
            ts: m.groups.ts,
            tsMs: Number.isFinite(parsedMs) ? parsedMs : null,
            version: sanitizeSafetyText(m.groups.version || "", 32)
          };
          break;
        }
      }
      return lastRestart;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    void env;
    return null;
  }
}

/**
 * Discover candidate Antigravity Desktop and CLI log files across Windows, macOS, and Linux.
 * Deduplicates `antigravity-cli/cli.log` whenever `antigravity-cli/log/cli-*.log` is present.
 */
export function discoverSafetyLogSources(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || env?.USERPROFILE || env?.HOME || os.homedir();
  const maxFiles = Math.max(1, Number(options.maxFiles || DEFAULT_SAFETY_CONFIG.maxFiles));
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const lookbackMs = Number.isFinite(options.lookbackMs)
    ? options.lookbackMs
    : Math.max(DEFAULT_SAFETY_CONFIG.retentionHours * 3600 * 1000, 7 * 24 * 3600 * 1000);

  const explicitPaths = Array.isArray(options.logPaths) ? options.logPaths : [];
  const disableDefaults =
    options.disableDefaultDiscovery === true ||
    env?.AGY_DART_SAFETY_DISABLE_DEFAULT_DISCOVERY === "1" ||
    env?.AGY_DART_SAFETY_DISABLE_DEFAULT_DISCOVERY === "true";

  const candidateSpecs = [];
  for (const p of explicitPaths) {
    const resolved = expandPathInput(p, homeDir, env);
    if (resolved) candidateSpecs.push({ path: resolved, kind: "custom" });
  }

  let mainLogCandidate = null;

  if (!disableDefaults && explicitPaths.length === 0) {
    if (platform === "win32") {
      const appData = typeof env?.APPDATA === "string" && env.APPDATA.trim() ? env.APPDATA.trim() : "";
      const localAppData = typeof env?.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim() ? env.LOCALAPPDATA.trim() : "";
      const roamingFallback = path.join(homeDir, "AppData", "Roaming");
      const desktopDirs = [];
      if (appData) desktopDirs.push(path.join(appData, "Antigravity", "logs"));
      if (roamingFallback.toLowerCase() !== appData.toLowerCase()) {
        desktopDirs.push(path.join(roamingFallback, "Antigravity", "logs"));
      }
      if (localAppData) desktopDirs.push(path.join(localAppData, "Antigravity", "logs"));
      for (const dir of desktopDirs) {
        candidateSpecs.push({ path: path.join(dir, "language_server.log"), kind: "desktop_language_server" });
        if (!mainLogCandidate) mainLogCandidate = path.join(dir, "main.log");
      }
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity-cli", "log"), kind: "cli_logs_dir" });
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity-cli", "cli.log"), kind: "cli_single_fallback" });
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity", "logs"), kind: "desktop_extra_dir" });
    } else if (platform === "darwin") {
      const appSuppLogs = path.join(homeDir, "Library", "Application Support", "Antigravity", "logs");
      mainLogCandidate = path.join(appSuppLogs, "main.log");
      candidateSpecs.push({ path: path.join(appSuppLogs, "language_server.log"), kind: "desktop_language_server" });
      candidateSpecs.push({ path: path.join(homeDir, "Library", "Logs", "Antigravity"), kind: "desktop_extra_dir" });
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity-cli", "log"), kind: "cli_logs_dir" });
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity-cli", "cli.log"), kind: "cli_single_fallback" });
    } else {
      const xdgConfig = typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : path.join(homeDir, ".config");
      const xdgState = typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim()
        ? env.XDG_STATE_HOME.trim()
        : path.join(homeDir, ".local", "state");
      const cfgLogs = path.join(xdgConfig, "Antigravity", "logs");
      mainLogCandidate = path.join(cfgLogs, "main.log");
      candidateSpecs.push({ path: path.join(cfgLogs, "language_server.log"), kind: "desktop_language_server" });
      candidateSpecs.push({ path: path.join(xdgState, "Antigravity", "logs"), kind: "desktop_extra_dir" });
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity-cli", "log"), kind: "cli_logs_dir" });
      candidateSpecs.push({ path: path.join(homeDir, ".gemini", "antigravity-cli", "cli.log"), kind: "cli_single_fallback" });
    }
  }

  const seenPaths = new Set();
  const discovered = [];
  let foundCliDirLogs = false;

  const tryAddFile = (filePath, kind) => {
    const key = safeCanonicalKey(filePath, platform);
    if (seenPaths.has(key)) return;
    let st;
    try {
      st = fs.lstatSync(filePath);
    } catch {
      return;
    }
    if (!st.isFile() || st.isSymbolicLink()) return;
    seenPaths.add(key);
    discovered.push({
      path: path.resolve(filePath),
      key,
      kind,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ino: Number.isFinite(st.ino) ? st.ino : 0
    });
  };

  for (const spec of candidateSpecs) {
    if (spec.kind === "cli_single_fallback" && foundCliDirLogs) {
      // antigravity-cli/cli.log is a byte-for-byte duplicate of the newest log/cli-*.log
      continue;
    }
    let st;
    try {
      st = fs.lstatSync(spec.path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      const base = path.basename(spec.path).toLowerCase();
      if (spec.kind !== "custom" && base === "main.log") continue;
      tryAddFile(spec.path, spec.kind);
    } else if (st.isDirectory()) {
      let entries;
      try {
        entries = fs.readdirSync(spec.path, { withFileTypes: true });
      } catch {
        continue;
      }
      const dirFiles = [];
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const lower = ent.name.toLowerCase();
        if (!lower.endsWith(".log")) continue;
        if (lower === "main.log") continue;
        if (spec.kind === "cli_logs_dir" && !DEFAULT_LOG_PATTERNS.cliLogFilename.test(ent.name)) continue;
        const full = path.join(spec.path, ent.name);
        let fst;
        try {
          fst = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (!fst.isFile() || fst.isSymbolicLink()) continue;
        dirFiles.push({ full, mtimeMs: fst.mtimeMs, name: ent.name });
      }
      dirFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      // If custom directory contains both `log/cli-*.log` or `cli.log` and `cli-*.log`, avoid dup `cli.log`
      const hasTimestampedCli = dirFiles.some((f) => DEFAULT_LOG_PATTERNS.cliLogFilename.test(f.name));
      for (const f of dirFiles) {
        if (hasTimestampedCli && f.name.toLowerCase() === "cli.log") continue;
        if (spec.kind !== "custom" && nowMs - f.mtimeMs > lookbackMs) continue;
        tryAddFile(f.full, spec.kind);
        if (spec.kind === "cli_logs_dir") foundCliDirLogs = true;
      }
    }
  }

  discovered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const capped = discovered.slice(0, maxFiles);
  const lastDesktopRestart = mainLogCandidate ? readMainLogLastRestart(mainLogCandidate, env) : null;

  return {
    files: capped,
    totalDiscovered: discovered.length,
    lastDesktopRestart
  };
}

/**
 * Process a single log line (after interleaved glog splitting) into rolling minute buckets.
 */
function processNormalizedRecord(record, state, ctx) {
  if (!record || !fastMatchesSafetyPrefilter(record)) return;

  const glogMatch = record.match(DEFAULT_LOG_PATTERNS.glogHeaderLine);
  let tsMs = null;
  let tid = "";
  let srcFile = "";
  let msg = record;

  if (glogMatch?.groups) {
    tsMs = parseGlogTimestampMs(glogMatch.groups.mmdd, glogMatch.groups.time, ctx.fileMtimeMs);
    tid = glogMatch.groups.tid || "";
    srcFile = (glogMatch.groups.file || "").toLowerCase();
    msg = glogMatch.groups.msg || "";
  } else {
    const iso = record.match(DEFAULT_LOG_PATTERNS.isoTimestamp);
    if (iso) {
      const parsed = Date.parse(iso[1].replace(" ", "T"));
      if (Number.isFinite(parsed)) tsMs = parsed;
    }
  }

  if (tsMs === null) {
    tsMs = ctx.lastTsMs || ctx.fileMtimeMs || ctx.nowMs;
  } else {
    ctx.lastTsMs = tsMs;
  }

  // Prune stale tid entries lazily
  if (tid && ctx.activeMonitorByTid.size > 64) {
    for (const [k, v] of ctx.activeMonitorByTid.entries()) {
      if (tsMs - v.ts > ctx.tidStaleMs) ctx.activeMonitorByTid.delete(k);
    }
  }

  const bucket = getOrCreateBucket(state.buckets, tsMs);

  // 0. [Sonar] active tags (metadata)
  if (msg.startsWith("[Sonar]")) {
    const sm = msg.match(DEFAULT_LOG_PATTERNS.sonarActiveTags);
    if (sm?.groups?.tags) {
      const tags = sm.groups.tags
        .split(/\s+/)
        .map((t) => sanitizeSafetyText(t, 48))
        .filter(Boolean)
        .slice(0, 12);
      if (tags.length > 0) state.sonarTags = tags;
    }
    return;
  }

  // 1. Fail-open 429 fallback marker (`parent sir_flash_lite failed, running it anyway`)
  if (DEFAULT_LOG_PATTERNS.parentFailedFallback.test(msg)) {
    bucket.fallbackEscalationCount += 1;
    return;
  }

  // 2. Stage 1 / 2 / 3 Monitor FINISHED lines
  const monFin = msg.match(DEFAULT_LOG_PATTERNS.monitorFinished);
  if (monFin?.groups) {
    const mon = monFin.groups.monitor;
    const triggered = monFin.groups.triggered === "true";
    const durMs = parseDurationMs(monFin.groups.duration);
    if (mon === "agy_tool_safety") {
      bucket.stage1Total += 1;
      if (triggered) {
        bucket.stage1Triggered += 1;
        const normReason = normalizeTriggerReason(monFin.groups.reason || "other");
        bucket.reasons[normReason] = (bucket.reasons[normReason] || 0) + 1;
        ctx.lastTrigger = { ts: tsMs, reason: normReason };
      } else {
        bucket.stage1Allowed += 1;
      }
      return;
    }
    if (mon === "sir_flash_lite") {
      bucket.precheckDurationMs += durMs;
      return;
    }
    if (mon === "severe_internal_risks_agy") {
      bucket.heavyDurationMs += durMs;
      // Backfill durationMs onto latest matching heavy event within 15s
      for (let i = state.recentHeavyEvents.length - 1; i >= 0; i--) {
        const ev = state.recentHeavyEvents[i];
        if (ev && ev.durationMs === 0 && Math.abs(tsMs - ev.ts) <= 15000) {
          ev.durationMs = Math.round(durMs);
          break;
        }
      }
      return;
    }
    return;
  }

  // 3. Monitor SKIPPED lines (no-op for counters, avoids false 429 matches)
  if (DEFAULT_LOG_PATTERNS.monitorSkipped.test(msg)) {
    return;
  }

  // 4. LLM Monitor lifecycle lines
  if (msg.startsWith("LLM Monitor ")) {
    const startM = msg.match(DEFAULT_LOG_PATTERNS.llmMonitorStart);
    if (startM?.groups) {
      const mon = startM.groups.monitor;
      if (tid) {
        ctx.pendingByTid.set(tid, { monitor: mon, ts: tsMs, chars: 0, model: "" });
      }
      return;
    }

    const trajM = msg.match(DEFAULT_LOG_PATTERNS.llmMonitorTrajectory);
    if (trajM?.groups) {
      const mon = trajM.groups.monitor;
      const chars = Number(trajM.groups.chars) || 0;
      if (tid) {
        const cur = ctx.pendingByTid.get(tid) || { monitor: mon, ts: tsMs, chars: 0, model: "" };
        cur.chars = chars;
        cur.ts = tsMs;
        ctx.pendingByTid.set(tid, cur);
      }
      if (mon === "sir_flash_lite") {
        bucket.precheckCharsTotal += chars;
        if (chars > bucket.precheckCharsMax) bucket.precheckCharsMax = chars;
      } else if (mon === "severe_internal_risks_agy") {
        bucket.heavyCharsTotal += chars;
        if (chars > bucket.heavyCharsMax) bucket.heavyCharsMax = chars;
        if (chars >= ctx.stickyCharThreshold) bucket.heavyLargeCount += 1;
      }
      return;
    }

    const callM = msg.match(DEFAULT_LOG_PATTERNS.llmMonitorCalling);
    if (callM?.groups) {
      const mon = callM.groups.monitor;
      const model = sanitizeSafetyText(callM.groups.model || "", 64);
      if (tid) {
        ctx.activeMonitorByTid.set(tid, { monitor: mon, ts: tsMs });
        const cur = ctx.pendingByTid.get(tid) || { monitor: mon, ts: tsMs, chars: 0, model: "" };
        cur.model = model;
        cur.ts = tsMs;
        ctx.pendingByTid.set(tid, cur);
      }
      if (mon === "sir_flash_lite") {
        bucket.precheckCalls += 1;
      } else if (mon === "severe_internal_risks_agy") {
        bucket.heavyCalls += 1;
      }
      return;
    }

    const compM = msg.match(DEFAULT_LOG_PATTERNS.llmMonitorComplete);
    if (compM?.groups) {
      const mon = compM.groups.monitor;
      const triggered = compM.groups.triggered === "true";
      const pending = tid ? ctx.pendingByTid.get(tid) : null;
      if (tid) {
        ctx.activeMonitorByTid.delete(tid);
        ctx.pendingByTid.delete(tid);
      }
      if (mon === "sir_flash_lite") {
        if (triggered) bucket.precheckTriggeredTrue += 1;
        else bucket.precheckTriggeredFalse += 1;
      } else if (mon === "severe_internal_risks_agy") {
        if (triggered) bucket.heavyTriggeredTrue += 1;
        else bucket.heavyTriggeredFalse += 1;
        const recentReason =
          ctx.lastTrigger && Math.abs(tsMs - ctx.lastTrigger.ts) <= 15000 ? ctx.lastTrigger.reason : "unknown";
        state.recentHeavyEvents.push({
          ts: tsMs,
          chars: pending?.chars || 0,
          durationMs: 0,
          triggered,
          reason: recentReason,
          model: pending?.model || "gemini-4-hydrogen-sonar"
        });
        if (state.recentHeavyEvents.length > ctx.maxRecentHeavyEvents * 2) {
          state.recentHeavyEvents = state.recentHeavyEvents.slice(-ctx.maxRecentHeavyEvents);
        }
      }
      return;
    }

    if (DEFAULT_LOG_PATTERNS.llmMonitorResponse.test(msg)) {
      return;
    }
  }

  // 5. streamGenerateContent attribution via shared `tid`
  if (msg.includes("streamGenerateContent")) {
    const streamM = msg.match(DEFAULT_LOG_PATTERNS.streamGenerateContent);
    if (streamM) {
      const active = tid ? ctx.activeMonitorByTid.get(tid) : null;
      if (active && tsMs - active.ts <= ctx.tidStaleMs) {
        if (active.monitor === "sir_flash_lite") {
          bucket.streamPrecheck += 1;
        } else if (active.monitor === "severe_internal_risks_agy") {
          bucket.streamHeavy += 1;
        } else {
          bucket.streamMain += 1;
        }
      } else {
        bucket.streamMain += 1;
      }
      // Note: do NOT return yet in case an inline HTTP 429 error sits on the same line
    }
  }

  // 6. Strict 429 / RESOURCE_EXHAUSTED detection (defends against 4,561 naive '429' false positives)
  if (srcFile !== "csrf_interceptor.go") {
    const msgWithoutReason = srcFile === "runner.go" ? msg.replace(/reason=".*"/, "") : msg;
    if (DEFAULT_LOG_PATTERNS.http429Strict.test(msgWithoutReason)) {
      const active = tid ? ctx.activeMonitorByTid.get(tid) : null;
      const hasSafetyContext =
        Boolean(active && tsMs - active.ts <= ctx.tidStaleMs) ||
        srcFile === "llm_monitor.go" ||
        /\b(?:sir_flash_lite|severe_internal_risks_agy|hydrogen-sonar|MODEL_TIER_FLASH_LITE|safety)\b/i.test(
          msgWithoutReason
        );
      if (hasSafetyContext) {
        bucket.rateLimit429Count += 1;
      }
      return;
    }
  }

  // 7. Non-glog graceful fallback for future / custom synthetic log formats
  if (!glogMatch) {
    if (/\bsir_flash_lite\b/i.test(msg) && !/skipped/i.test(msg)) {
      bucket.precheckCalls += 1;
      if (/triggered\s*[:=]\s*true/i.test(msg)) bucket.precheckTriggeredTrue += 1;
      else if (/triggered\s*[:=]\s*false/i.test(msg)) bucket.precheckTriggeredFalse += 1;
      return;
    }
    if (DEFAULT_LOG_PATTERNS.fallbackHeavyModel.test(msg) && !/skipped/i.test(msg)) {
      bucket.heavyCalls += 1;
      let chars = 0;
      const cm = msg.match(DEFAULT_LOG_PATTERNS.fallbackTrajectoryChars);
      if (cm) {
        if (cm[1]) chars = Number(cm[1]) || 0;
        else if (cm[2]) chars = Number(cm[2].replace(/,/g, "")) || 0;
        else if (cm[3]) chars = Math.round(Number(cm[3]) * 1000) || 0;
      }
      if (chars > 0) {
        bucket.heavyCharsTotal += chars;
        if (chars > bucket.heavyCharsMax) bucket.heavyCharsMax = chars;
        if (chars >= ctx.stickyCharThreshold) bucket.heavyLargeCount += 1;
      }
      const trigFalse = /triggered\s*[:=]\s*false/i.test(msg);
      const trigTrue = /triggered\s*[:=]\s*true/i.test(msg);
      if (trigFalse) bucket.heavyTriggeredFalse += 1;
      else if (trigTrue) bucket.heavyTriggeredTrue += 1;
      state.recentHeavyEvents.push({
        ts: tsMs,
        chars,
        durationMs: 0,
        triggered: trigTrue,
        reason: "unknown",
        model: "gemini-4-hydrogen-sonar"
      });
    }
  }
}

/**
 * Pure helper to parse an array of raw log lines (useful for direct unit testing & fixtures).
 */
export function parseSafetyLogLines(lines, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const state = options.state || createEmptyState();
  const ctx = {
    fileMtimeMs: Number.isFinite(options.fileMtimeMs) ? options.fileMtimeMs : nowMs,
    nowMs,
    lastTsMs: null,
    lastTrigger: null,
    activeMonitorByTid: new Map(),
    pendingByTid: new Map(),
    stickyCharThreshold: Number(options.stickyCharThreshold || DEFAULT_SAFETY_CONFIG.stickyCharThreshold),
    maxRecentHeavyEvents: Number(options.maxRecentHeavyEvents || DEFAULT_SAFETY_CONFIG.maxRecentHeavyEvents),
    tidStaleMs: Number(options.tidStaleMs || DEFAULT_SAFETY_CONFIG.tidStaleMs)
  };
  for (const rawLine of lines || []) {
    if (!rawLine || typeof rawLine !== "string") continue;
    if (!fastMatchesSafetyPrefilter(rawLine)) continue;
    const records = splitInterleavedGlogLine(rawLine);
    for (const rec of records) {
      processNormalizedRecord(rec, state, ctx);
    }
  }
  return state;
}

const MAX_PENDING_LINE_BYTES = 64 * 1024;
const EMPTY_BUF = Buffer.alloc(0);
const RECOGNIZED_GLOG_LINE_RE = /^(?:ERROR:\s+logging before google\.Init:\s*)?[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+/;

function isRecognizedSafetyLogLine(line) {
  if (!line) return false;
  return (
    RECOGNIZED_GLOG_LINE_RE.test(line) ||
    DEFAULT_LOG_PATTERNS.isoTimestamp.test(line) ||
    fastMatchesSafetyPrefilter(line)
  );
}

function scanFileIncremental(fileMeta, state, options) {
  const cursor = state.files[fileMeta.key] || null;
  const maxColdScanBytes = Number(options.maxColdScanBytes || DEFAULT_SAFETY_CONFIG.maxColdScanBytes);
  const chunkBytes = Number(options.readChunkBytes || DEFAULT_SAFETY_CONFIG.readChunkBytes);
  const maxPendingLineBytes =
    Number.isFinite(Number(options.maxPendingLineBytes)) && Number(options.maxPendingLineBytes) >= 256
      ? Math.floor(Number(options.maxPendingLineBytes))
      : MAX_PENDING_LINE_BYTES;
  const flushEof = Boolean(options.flushEof);

  if (
    !flushEof &&
    cursor &&
    cursor.size === fileMeta.size &&
    cursor.mtimeMs === fileMeta.mtimeMs &&
    (cursor.ino === 0 || fileMeta.ino === 0 || cursor.ino === fileMeta.ino)
  ) {
    return {
      bytesScanned: 0,
      cacheHit: true,
      truncatedRestart: false,
      recognizedLines: Number(cursor.recognizedLines || 0),
      oversizedLinesSkipped: Number(cursor.oversizedLinesSkipped || 0)
    };
  }

  let startOffset = 0;
  let truncatedRestart = false;
  let prevInFlight = null;
  let oversizedSkipActive = false;
  let recognizedLines = 0;
  let oversizedLinesSkipped = 0;

  if (cursor) {
    const inodeChanged = cursor.ino > 0 && fileMeta.ino > 0 && cursor.ino !== fileMeta.ino;
    const sizeShrank = fileMeta.size < cursor.offset;
    if (inodeChanged || sizeShrank) {
      truncatedRestart = true;
      startOffset = 0;
      prevInFlight = null;
      oversizedSkipActive = false;
      recognizedLines = 0;
      oversizedLinesSkipped = 0;
      state.restartTruncationsDetected = (state.restartTruncationsDetected || 0) + 1;
    } else {
      startOffset = cursor.offset;
      prevInFlight = cursor.inFlight && typeof cursor.inFlight === "object" ? cursor.inFlight : null;
      oversizedSkipActive = Boolean(cursor.oversizedSkipActive);
      recognizedLines = Number(cursor.recognizedLines || 0);
      oversizedLinesSkipped = Number(cursor.oversizedLinesSkipped || 0);
    }
  }

  let skipFirstPartial = false;
  if (startOffset === 0 && fileMeta.size > maxColdScanBytes) {
    startOffset = fileMeta.size - maxColdScanBytes;
    skipFirstPartial = true;
    prevInFlight = null;
    oversizedSkipActive = false;
  }

  const totalToRead = Math.max(0, fileMeta.size - startOffset);
  if (totalToRead === 0) {
    state.files[fileMeta.key] = {
      offset: startOffset,
      size: fileMeta.size,
      mtimeMs: fileMeta.mtimeMs,
      ino: fileMeta.ino,
      recognizedLines,
      oversizedLinesSkipped,
      ...(oversizedSkipActive ? { oversizedSkipActive: true } : {}),
      ...(prevInFlight ? { inFlight: prevInFlight } : {})
    };
    return { bytesScanned: 0, cacheHit: false, truncatedRestart, recognizedLines, oversizedLinesSkipped };
  }

  const refNowMs = Math.max(Number(options.nowMs) || 0, Number(fileMeta.mtimeMs) || 0);
  const tidStaleMs = DEFAULT_SAFETY_CONFIG.tidStaleMs;
  const activeMonitorByTid = new Map();
  const pendingByTid = new Map();
  let lastTrigger = null;

  if (prevInFlight) {
    if (
      prevInFlight.lastTrigger &&
      typeof prevInFlight.lastTrigger === "object" &&
      Number.isFinite(prevInFlight.lastTrigger.ts) &&
      refNowMs - prevInFlight.lastTrigger.ts <= tidStaleMs
    ) {
      lastTrigger = {
        reason: String(prevInFlight.lastTrigger.reason || "unknown"),
        ts: prevInFlight.lastTrigger.ts
      };
    }
    if (Array.isArray(prevInFlight.activeMonitorByTid)) {
      for (const item of prevInFlight.activeMonitorByTid) {
        if (!item || typeof item.tid !== "string" || !Number.isFinite(item.ts)) continue;
        if (refNowMs - item.ts <= tidStaleMs) {
          activeMonitorByTid.set(item.tid, {
            monitor: String(item.monitor || ""),
            ts: item.ts
          });
        }
      }
    }
    if (Array.isArray(prevInFlight.pendingByTid)) {
      for (const item of prevInFlight.pendingByTid) {
        if (!item || typeof item.tid !== "string" || !Number.isFinite(item.ts)) continue;
        if (refNowMs - item.ts <= tidStaleMs) {
          pendingByTid.set(item.tid, {
            monitor: String(item.monitor || ""),
            chars: Number(item.chars) || 0,
            ts: item.ts,
            model: typeof item.model === "string" ? item.model : ""
          });
        }
      }
    }
  }

  const ctx = {
    fileMtimeMs: fileMeta.mtimeMs,
    nowMs: options.nowMs,
    lastTsMs: Number.isFinite(prevInFlight?.lastTsMs) ? prevInFlight.lastTsMs : null,
    lastTrigger,
    activeMonitorByTid,
    pendingByTid,
    stickyCharThreshold: options.stickyCharThreshold,
    maxRecentHeavyEvents: DEFAULT_SAFETY_CONFIG.maxRecentHeavyEvents,
    tidStaleMs
  };

  const processCompleteLineBuffer = (lineBuf) => {
    let trimmedBuf = lineBuf;
    if (trimmedBuf.length > 0 && trimmedBuf[trimmedBuf.length - 1] === 0x0d) {
      trimmedBuf = trimmedBuf.subarray(0, trimmedBuf.length - 1);
    }
    if (trimmedBuf.length === 0) return;
    const line = trimmedBuf.toString("utf8");
    if (isRecognizedSafetyLogLine(line)) {
      recognizedLines += 1;
    }
    if (!fastMatchesSafetyPrefilter(line)) return;
    const records = splitInterleavedGlogLine(line);
    for (let j = 0; j < records.length; j++) {
      processNormalizedRecord(records[j], state, ctx);
    }
  };

  let fd = null;
  let bytesReadTotal = 0;
  try {
    fd = fs.openSync(fileMeta.path, "r");
    const buf = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(4096, totalToRead)));
    let pos = startOffset;
    let committedOffset = startOffset;
    let remaining = totalToRead;
    let pendingBuf = EMPTY_BUF;

    while (remaining > 0) {
      const toRead = Math.min(buf.length, remaining);
      const n = fs.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      pos += n;
      remaining -= n;
      bytesReadTotal += n;

      const slice = buf.subarray(0, n);
      let segStart = 0;
      while (segStart < n) {
        const nlIdx = slice.indexOf(0x0a, segStart);
        if (nlIdx < 0) break;
        const segLen = nlIdx - segStart;
        const totalLineBytes = pendingBuf.length + segLen + 1;
        committedOffset += totalLineBytes;

        if (oversizedSkipActive) {
          oversizedSkipActive = false;
          pendingBuf = EMPTY_BUF;
        } else if (skipFirstPartial) {
          skipFirstPartial = false;
          pendingBuf = EMPTY_BUF;
        } else {
          const lineBuf =
            pendingBuf.length > 0
              ? Buffer.concat([pendingBuf, slice.subarray(segStart, nlIdx)], pendingBuf.length + segLen)
              : slice.subarray(segStart, nlIdx);
          pendingBuf = EMPTY_BUF;
          if (lineBuf.length > maxPendingLineBytes) {
            oversizedLinesSkipped += 1;
          } else {
            processCompleteLineBuffer(lineBuf);
          }
        }
        segStart = nlIdx + 1;
      }

      if (segStart < n) {
        const tailSlice = slice.subarray(segStart, n);
        if (oversizedSkipActive) {
          committedOffset += tailSlice.length;
        } else if (pendingBuf.length + tailSlice.length > maxPendingLineBytes) {
          oversizedSkipActive = true;
          oversizedLinesSkipped += 1;
          committedOffset += pendingBuf.length + tailSlice.length;
          pendingBuf = EMPTY_BUF;
        } else {
          pendingBuf =
            pendingBuf.length > 0
              ? Buffer.concat([pendingBuf, tailSlice], pendingBuf.length + tailSlice.length)
              : Buffer.from(tailSlice);
        }
      }
    }

    // Only commit an unterminated trailing EOF line during one-shot stateless static scans (`--no-state`).
    // Stateful live incremental polling leaves `offset` at `committedOffset` (the exact byte after the last `\n`)
    // so split writes and split multi-byte UTF-8 sequences are re-read cleanly once terminated.
    if (flushEof && pendingBuf.length > 0 && !skipFirstPartial && !oversizedSkipActive) {
      committedOffset += pendingBuf.length;
      processCompleteLineBuffer(pendingBuf);
      pendingBuf = EMPTY_BUF;
    }

    const persistRefMs = Math.max(refNowMs, Number(ctx.lastTsMs) || 0);
    const savedActive = [];
    for (const [tidKey, val] of ctx.activeMonitorByTid.entries()) {
      if (val && Number.isFinite(val.ts) && persistRefMs - val.ts <= tidStaleMs) {
        savedActive.push({ tid: tidKey, monitor: val.monitor, ts: val.ts });
      }
    }
    savedActive.sort((a, b) => b.ts - a.ts);
    const savedPending = [];
    for (const [tidKey, val] of ctx.pendingByTid.entries()) {
      if (val && Number.isFinite(val.ts) && persistRefMs - val.ts <= tidStaleMs) {
        savedPending.push({
          tid: tidKey,
          monitor: val.monitor,
          chars: Number(val.chars) || 0,
          ts: val.ts,
          model: typeof val.model === "string" ? val.model : ""
        });
      }
    }
    savedPending.sort((a, b) => b.ts - a.ts);
    const savedLastTrigger =
      ctx.lastTrigger && Number.isFinite(ctx.lastTrigger.ts) && persistRefMs - ctx.lastTrigger.ts <= tidStaleMs
        ? { reason: String(ctx.lastTrigger.reason || "unknown"), ts: ctx.lastTrigger.ts }
        : null;
    const inFlight =
      savedLastTrigger || savedActive.length > 0 || savedPending.length > 0
        ? {
            lastTsMs: Number.isFinite(ctx.lastTsMs) ? ctx.lastTsMs : null,
            lastTrigger: savedLastTrigger,
            activeMonitorByTid: savedActive.slice(0, 16),
            pendingByTid: savedPending.slice(0, 16)
          }
        : undefined;

    state.files[fileMeta.key] = {
      offset: committedOffset,
      size: fileMeta.size,
      mtimeMs: fileMeta.mtimeMs,
      ino: fileMeta.ino,
      recognizedLines,
      oversizedLinesSkipped,
      ...(oversizedSkipActive ? { oversizedSkipActive: true } : {}),
      ...(inFlight ? { inFlight } : {})
    };
  } catch {
    // Fail-open on locked/disappeared files
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  return { bytesScanned: bytesReadTotal, cacheHit: false, truncatedRestart, recognizedLines, oversizedLinesSkipped };
}

function resolveDefaultStatePath(cfg, env = process.env, homeDir = os.homedir()) {
  if (cfg?.safetyStatePath) return path.resolve(cfg.safetyStatePath);
  if (cfg?.dbPath) return path.join(path.dirname(path.resolve(cfg.dbPath)), "safety-audit-state.json");
  return path.join(homeDir, ".agy-dart", "safety-audit-state.json");
}

function loadPersistedState(statePath) {
  if (!statePath) return createEmptyState();
  const cached = memoryStateCache.get(statePath);
  try {
    if (!fs.existsSync(statePath)) {
      return cached ? cached.state : createEmptyState();
    }
    const st = fs.statSync(statePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.state;
    }
    const raw = fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_FILE_VERSION) {
      return createEmptyState();
    }
    const normalized = {
      version: STATE_FILE_VERSION,
      updatedAtMs: Number(parsed.updatedAtMs) || 0,
      restartTruncationsDetected: Number(parsed.restartTruncationsDetected) || 0,
      files: parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files : {},
      buckets: parsed.buckets && typeof parsed.buckets === "object" && !Array.isArray(parsed.buckets) ? parsed.buckets : {},
      recentHeavyEvents: Array.isArray(parsed.recentHeavyEvents) ? parsed.recentHeavyEvents : [],
      sonarTags: Array.isArray(parsed.sonarTags) ? parsed.sonarTags : []
    };
    memoryStateCache.set(statePath, { mtimeMs: st.mtimeMs, size: st.size, state: normalized });
    return normalized;
  } catch {
    return createEmptyState();
  }
}

function savePersistedState(statePath, state) {
  if (!statePath) return;
  try {
    const dir = path.dirname(statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify(state);
    fs.writeFileSync(tmpPath, body, "utf8");
    try {
      fs.renameSync(tmpPath, statePath);
    } catch {
      fs.writeFileSync(statePath, body, "utf8");
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    try {
      const st = fs.statSync(statePath);
      memoryStateCache.set(statePath, { mtimeMs: st.mtimeMs, size: st.size, state });
    } catch {}
  } catch {
    // Fail-open if state path is read-only
  }
}

function aggregateWindowBuckets(buckets, minMinute, maxMinute) {
  const agg = createEmptyBucket();
  let activeMinutes = 0;
  for (const [key, b] of Object.entries(buckets || {})) {
    const m = Number(key);
    if (!Number.isFinite(m) || m < minMinute || m > maxMinute || !b) continue;
    activeMinutes += 1;
    agg.stage1Total += Number(b.stage1Total) || 0;
    agg.stage1Allowed += Number(b.stage1Allowed) || 0;
    agg.stage1Triggered += Number(b.stage1Triggered) || 0;
    agg.precheckCalls += Number(b.precheckCalls) || 0;
    agg.precheckTriggeredTrue += Number(b.precheckTriggeredTrue) || 0;
    agg.precheckTriggeredFalse += Number(b.precheckTriggeredFalse) || 0;
    agg.precheckCharsTotal += Number(b.precheckCharsTotal) || 0;
    agg.precheckCharsMax = Math.max(agg.precheckCharsMax, Number(b.precheckCharsMax) || 0);
    agg.precheckDurationMs += Number(b.precheckDurationMs) || 0;
    agg.heavyCalls += Number(b.heavyCalls) || 0;
    agg.heavyTriggeredTrue += Number(b.heavyTriggeredTrue) || 0;
    agg.heavyTriggeredFalse += Number(b.heavyTriggeredFalse) || 0;
    agg.heavyCharsTotal += Number(b.heavyCharsTotal) || 0;
    agg.heavyCharsMax = Math.max(agg.heavyCharsMax, Number(b.heavyCharsMax) || 0);
    agg.heavyLargeCount += Number(b.heavyLargeCount) || 0;
    agg.heavyDurationMs += Number(b.heavyDurationMs) || 0;
    agg.rateLimit429Count += Number(b.rateLimit429Count) || 0;
    agg.fallbackEscalationCount += Number(b.fallbackEscalationCount) || 0;
    agg.streamMain += Number(b.streamMain) || 0;
    agg.streamPrecheck += Number(b.streamPrecheck) || 0;
    agg.streamHeavy += Number(b.streamHeavy) || 0;
    if (b.reasons && typeof b.reasons === "object") {
      for (const [rk, rv] of Object.entries(b.reasons)) {
        agg.reasons[rk] = (agg.reasons[rk] || 0) + (Number(rv) || 0);
      }
    }
  }
  return { agg, activeMinutes };
}

function buildTriggerReasonsList(reasonsMap) {
  const entries = Object.entries(reasonsMap || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((acc, [, c]) => acc + c, 0);
  return entries.map(([reason, count]) => ({
    reason: sanitizeSafetyText(reason, 80),
    category: classifyReasonCategory(reason),
    count,
    pct: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0
  }));
}

function computeConsecutiveLargeFalseAlarms(events, stickyCharThreshold) {
  let maxStreak = 0;
  let curStreak = 0;
  let streakCharsSum = 0;
  let maxStreakAvgChars = 0;
  for (const ev of events) {
    if (ev && ev.triggered === false && Number(ev.chars || 0) >= stickyCharThreshold) {
      curStreak += 1;
      streakCharsSum += Number(ev.chars || 0);
      if (curStreak >= maxStreak) {
        maxStreak = curStreak;
        maxStreakAvgChars = Math.round(streakCharsSum / curStreak);
      }
    } else {
      curStreak = 0;
      streakCharsSum = 0;
    }
  }
  return { maxStreak, maxStreakAvgChars };
}

function classifySafetyStatus({
  filesDiscovered,
  parseStatus = "recognized",
  agg,
  recentHeavyWindow,
  recentHeavy15m,
  precheckWarnCount,
  precheckLimit,
  heavyBurstCount,
  heavyBurstWindowMin,
  stickyCharThreshold,
  windowHours
}) {
  const totalSafetyEvents =
    agg.stage1Total +
    agg.precheckCalls +
    agg.heavyCalls +
    agg.rateLimit429Count +
    agg.fallbackEscalationCount;

  if (filesDiscovered === 0 && totalSafetyEvents === 0) {
    return {
      status: "not_detected",
      severity: "none",
      verdictCode: "SAFETY_LOGS_NOT_DETECTED",
      summaryEn: "No Antigravity Desktop/CLI safety logs detected on this host.",
      summaryZh: "未检测到本机 Antigravity 桌面端或 CLI 日志文件（静默降级，不误报）。",
      actions: []
    };
  }

  if (totalSafetyEvents === 0) {
    if (parseStatus === "unrecognized_format") {
      return {
        status: "no_safety_events",
        severity: "none",
        verdictCode: "UNRECOGNIZED_LOG_FORMAT",
        summaryEn: `Logs scanned (${filesDiscovered} file(s)), but no recognized Antigravity log format was detected — zero events cannot be confirmed.`,
        summaryZh: `已扫描 ${filesDiscovered} 份日志，但未识别到已知 Antigravity 日志格式，尚不能判定为零事件。`,
        actions: []
      };
    }
    return {
      status: "no_safety_events",
      severity: "none",
      verdictCode: "NO_SAFETY_EVENTS_IN_WINDOW",
      summaryEn: `Logs scanned (${filesDiscovered} file(s)), but 0 safety monitor events recorded in the last ${windowHours}h.`,
      summaryZh: `已扫描 ${filesDiscovered} 份日志，最近 ${windowHours} 小时内未记录到后台安全审查事件。`,
      actions: []
    };
  }

  const heavyAvgChars = agg.heavyCalls > 0 ? Math.round(agg.heavyCharsTotal / agg.heavyCalls) : 0;
  const hiddenTotal = agg.streamPrecheck + agg.streamHeavy;
  const streamTotal = agg.streamMain + hiddenTotal;
  const hiddenSharePct = streamTotal > 0 ? Number(((hiddenTotal / streamTotal) * 100).toFixed(1)) : null;
  const unparentedHeavyJump =
    agg.heavyCalls >= 2 && agg.precheckTriggeredTrue >= 0 && agg.heavyCalls > agg.precheckTriggeredTrue + 1;

  // 1. Critical: 429 Avalanche (Issue #1886 Path 1)
  if (
    agg.fallbackEscalationCount > 0 ||
    (agg.rateLimit429Count >= 1 && agg.heavyCalls >= 1) ||
    unparentedHeavyJump
  ) {
    const detailBits = [];
    if (agg.rateLimit429Count > 0) detailBits.push(`${agg.rateLimit429Count} HTTP 429`);
    if (agg.fallbackEscalationCount > 0) detailBits.push(`${agg.fallbackEscalationCount} fallback(s)`);
    detailBits.push(`${agg.heavyCalls} heavy review(s)`);
    return {
      status: "429_avalanche",
      severity: "critical",
      verdictCode: "SAFETY_429_AVALANCHE",
      summaryEn: `Suspected 429 safety-monitor avalanche (${detailBits.join(", ")}) escalating calls to gemini-4-hydrogen-sonar (avg ${Math.round(heavyAvgChars / 1000)}K chars).`,
      summaryZh: `疑似触发 429 后台审查雪崩（${detailBits.join(" / ")}），工具调用正被降级送往 gemini-4-hydrogen-sonar 重型复审（均值 ${Math.round(heavyAvgChars / 1000)}K 字符）。`,
      actions: [
        {
          id: "handoff_new_window",
          labelEn: "Generate Handoff Brief & switch to a fresh window",
          labelZh: "立即生成交接简报（Handoff Brief）并切新窗口"
        },
        {
          id: "reduce_concurrent_cli",
          labelEn: "Pause parallel CLI sessions and wait for the 5h sir_flash_lite quota window reset",
          labelZh: "暂停多并发 CLI / 多窗口高频工具任务，等待 5 小时 sir_flash_lite 窗口重置"
        },
        {
          id: "avoid_external_mcp_reads",
          labelEn: "Use native read_file for files outside the workspace (allowed_tool, 0 cloud checks)",
          labelZh: "读取工作区外文件/配置时优先使用原生 read_file（命中白名单，0 次云端审查）"
        }
      ]
    };
  }

  // 2. Zero-429 Heavy False-Alarm Burst or Sticky Review (Issue #1886 Path 2A/2B)
  const heavyBurstRecent = recentHeavyWindow.length;
  const heavyChars15m = recentHeavy15m.reduce((acc, e) => acc + (Number(e.chars) || 0), 0);
  const { maxStreak, maxStreakAvgChars } = computeConsecutiveLargeFalseAlarms(
    recentHeavy15m,
    stickyCharThreshold
  );
  const isHeavyBurst = heavyBurstRecent >= heavyBurstCount;
  const isStickyLargeFalseAlarm = maxStreak >= 3 && maxStreakAvgChars >= stickyCharThreshold;
  const isHeavyVolumeAlert = agg.heavyCalls >= 4 && heavyAvgChars >= stickyCharThreshold && agg.heavyTriggeredFalse >= 3;

  if (isHeavyBurst || isStickyLargeFalseAlarm || isHeavyVolumeAlert) {
    const severity = heavyBurstRecent >= heavyBurstCount * 2 || heavyChars15m >= 1_000_000 ? "critical" : "warn";
    const falseAlarmNoteEn =
      agg.heavyTriggeredFalse > 0
        ? ` (${agg.heavyTriggeredFalse}/${agg.heavyCalls} false alarm)`
        : "";
    const falseAlarmNoteZh =
      agg.heavyTriggeredFalse > 0
        ? `（其中 ${agg.heavyTriggeredFalse}/${agg.heavyCalls} 次为误报放行）`
        : "";
    return {
      status: "heavy_burst_or_sticky",
      severity,
      verdictCode: "SAFETY_ZERO_429_HEAVY_BURST",
      summaryEn: `Zero-429 heavy safety review burst detected: ${agg.heavyCalls} gemini-4-hydrogen-sonar call(s) in ${windowHours}h (${heavyBurstRecent} in last ${heavyBurstWindowMin}m), avg ${Math.round(heavyAvgChars / 1000)}K chars${falseAlarmNoteEn}.`,
      summaryZh: `检测到零 429 重型安全复审连环触发：最近 ${windowHours} 小时共 ${agg.heavyCalls} 次 gemini-4-hydrogen-sonar（近 ${heavyBurstWindowMin} 分钟 ${heavyBurstRecent} 次），均长 ${Math.round(heavyAvgChars / 1000)}K 字符${falseAlarmNoteZh}。`,
      actions: [
        {
          id: "handoff_new_window",
          labelEn: "Generate Handoff Brief and start a fresh window to truncate 200K–300K review trajectories",
          labelZh: "生成交接简报并开新窗口，截断 200K–300K 字符的重型复审尾巴"
        },
        {
          id: "avoid_external_mcp_reads",
          labelEn: "Use native read_file instead of MCP tools for outside-workspace configs/logs",
          labelZh: "读取工作区外配置/插件/日志时改用原生 read_file，避免 MCP 跨区触发 Signal E 误报"
        }
      ]
    };
  }

  // 3. Approaching 5h sir_flash_lite Quota Cliff
  if (agg.precheckCalls >= precheckWarnCount) {
    const pct = Math.round((agg.precheckCalls / Math.max(1, precheckLimit)) * 100);
    return {
      status: "approaching_quota",
      severity: "warn",
      verdictCode: "SAFETY_PRECHECK_APPROACHING_CLIFF",
      summaryEn: `5h sir_flash_lite pre-checks reached ${agg.precheckCalls.toLocaleString("en-US")}/${precheckLimit.toLocaleString("en-US")} (${pct}%), approaching the ~4,400 429 avalanche cliff.`,
      summaryZh: `5 小时内 sir_flash_lite 轻量预检已达 ${agg.precheckCalls.toLocaleString("en-US")}/${precheckLimit.toLocaleString("en-US")}（${pct}%），逼近 ~4,400 次 429 降级悬崖。`,
      actions: [
        {
          id: "reduce_concurrent_cli",
          labelEn: "Slow down concurrent CLI/multi-window tool loops to stay below the 4,400/5h threshold",
          labelZh: "降低多并发 CLI / 多窗口工具调用密度，避免撞上 4,400 次/5h 429 红线"
        },
        {
          id: "batch_in_workspace",
          labelEn: "Batch in-workspace edits/searches (apply_edits / batch_search) and avoid unquoted shell operators",
          labelZh: "工作区内尽量合并多次编辑/搜索，减少不必要的带管道/分号 shell 碎片调用"
        }
      ]
    };
  }

  // 4. Normal / Baseline (still transparently surfaces hidden safety tax)
  const shareNoteEn = hiddenSharePct !== null ? ` · ${hiddenSharePct}% hidden stream requests` : "";
  const shareNoteZh = hiddenSharePct !== null ? ` · 隐藏请求占比 ${hiddenSharePct}%` : "";
  return {
    status: "ok",
    severity: "ok",
    verdictCode: "SAFETY_MONITOR_NORMAL",
    summaryEn: `Safety monitor normal: ${agg.precheckCalls}/${precheckLimit} pre-checks (${windowHours}h), ${agg.heavyCalls} heavy review(s), 0 429 avalanche${shareNoteEn}.`,
    summaryZh: `后台审查处于常态：近 ${windowHours}h 预检 ${agg.precheckCalls}/${precheckLimit} 次、重型复审 ${agg.heavyCalls} 次、0 次 429 雪崩${shareNoteZh}。`,
    actions: []
  };
}

/**
 * Main read-only Safety Monitor audit entrypoint.
 * Safe, bounded, incremental, secret-redacted, and restart-truncation resilient.
 */
export function auditSafetyMonitor(options = {}) {
  const t0 = Date.now();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || env?.USERPROFILE || env?.HOME || os.homedir();
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  let cfg = {};
  try {
    cfg = getEffectiveConfig({ env, ...(options.configPath ? { configPath: options.configPath } : {}) });
  } catch {
    cfg = {};
  }

  const enabled = options.enabled !== undefined ? Boolean(options.enabled) : cfg.safetyAudit !== false;
  const windowHours = Math.max(1, Math.min(24, Number(options.windowHours ?? cfg.safetyWindowHours ?? DEFAULT_SAFETY_CONFIG.windowHours) || 5));
  const precheckWarnCount = Math.max(100, Number(options.precheckWarnCount ?? cfg.safetyPrecheckWarnCount ?? DEFAULT_SAFETY_CONFIG.precheckWarnCount) || 3500);
  const precheckLimit = Math.max(precheckWarnCount, Number(options.precheckLimit ?? cfg.safetyPrecheckLimit ?? DEFAULT_SAFETY_CONFIG.precheckLimit) || 4400);
  const heavyBurstCount = Math.max(2, Number(options.heavyBurstCount ?? cfg.safetyHeavyBurstCount ?? DEFAULT_SAFETY_CONFIG.heavyBurstCount) || 3);
  const heavyBurstWindowMin = Math.max(1, Number(options.heavyBurstWindowMin ?? cfg.safetyHeavyBurstWindowMin ?? DEFAULT_SAFETY_CONFIG.heavyBurstWindowMin) || 5);
  const stickyCharThreshold = Math.max(10000, Number(options.stickyCharThreshold ?? cfg.safetyStickyCharThreshold ?? DEFAULT_SAFETY_CONFIG.stickyCharThreshold) || 150000);

  if (!enabled) {
    return stableSortObject({
      schemaVersion: SAFETY_AUDIT_SCHEMA_VERSION,
      enabled: false,
      status: "disabled",
      severity: "none",
      verdictCode: "SAFETY_AUDIT_DISABLED",
      summaryEn: "Safety monitor audit is disabled in agy-dart configuration.",
      summaryZh: "已在 agy-dart 配置中关闭后台安全审查监测。",
      actions: [],
      windowHours,
      sampledAt: new Date(nowMs).toISOString(),
      window: null,
      streamRequests: null,
      triggerReasons: [],
      recentHeavyEvents: [],
      sources: {
        filesDiscovered: 0,
        filesScanned: 0,
        bytesScanned: 0,
        cacheHits: 0,
        restartTruncationsDetected: 0,
        lastDesktopRestart: null,
        scanMs: Math.max(0, Date.now() - t0),
        paths: []
      }
    });
  }

  const configuredLogPaths =
    Array.isArray(options.logPaths) && options.logPaths.length > 0
      ? options.logPaths
      : Array.isArray(cfg.safetyLogPaths) && cfg.safetyLogPaths.length > 0
        ? cfg.safetyLogPaths
        : [];

  const discovery = discoverSafetyLogSources({
    platform,
    env,
    homeDir,
    nowMs,
    logPaths: configuredLogPaths,
    disableDefaultDiscovery: options.disableDefaultDiscovery === true,
    maxFiles: options.maxFiles || DEFAULT_SAFETY_CONFIG.maxFiles
  });

  const persistState = options.persistState !== false;
  const statePath = persistState
    ? options.statePath
      ? path.resolve(options.statePath)
      : resolveDefaultStatePath(cfg, env, homeDir)
    : null;

  const state = persistState ? loadPersistedState(statePath) : createEmptyState();
  let bytesScanned = 0;
  let cacheHits = 0;
  let filesScanned = 0;
  let totalRecognizedLines = 0;
  let totalOversizedLinesSkipped = 0;
  let totalDiscoveredBytes = 0;
  let mutated = false;

  for (const fileMeta of discovery.files) {
    totalDiscoveredBytes += Number(fileMeta.size || 0);
    const res = scanFileIncremental(fileMeta, state, {
      nowMs,
      stickyCharThreshold,
      maxColdScanBytes: options.maxColdScanBytes || DEFAULT_SAFETY_CONFIG.maxColdScanBytes,
      readChunkBytes: options.readChunkBytes || DEFAULT_SAFETY_CONFIG.readChunkBytes,
      maxPendingLineBytes: options.maxPendingLineBytes,
      flushEof: !persistState
    });
    filesScanned += 1;
    bytesScanned += res.bytesScanned;
    totalRecognizedLines += Number(res.recognizedLines || 0);
    totalOversizedLinesSkipped += Number(res.oversizedLinesSkipped || 0);
    if (res.cacheHit) cacheHits += 1;
    if (res.bytesScanned > 0 || res.truncatedRestart) mutated = true;
  }

  pruneState(state, nowMs, DEFAULT_SAFETY_CONFIG.retentionHours, DEFAULT_SAFETY_CONFIG.maxRecentHeavyEvents);
  if (persistState && mutated) {
    state.updatedAtMs = nowMs;
    savePersistedState(statePath, state);
  }

  const maxMinute = Math.floor(nowMs / 60000);
  const minMinute = Math.floor((nowMs - windowHours * 3600 * 1000) / 60000);
  const { agg, activeMinutes } = aggregateWindowBuckets(state.buckets, minMinute, maxMinute);

  const burstCutoffMs = nowMs - heavyBurstWindowMin * 60 * 1000;
  const fifteenMinCutoffMs = nowMs - 15 * 60 * 1000;
  const windowCutoffMs = nowMs - windowHours * 3600 * 1000;

  const recentHeavyInWindow = state.recentHeavyEvents.filter((e) => e.ts >= windowCutoffMs);
  const recentHeavyBurst = recentHeavyInWindow.filter((e) => e.ts >= burstCutoffMs);
  const recentHeavy15m = recentHeavyInWindow.filter((e) => e.ts >= fifteenMinCutoffMs);

  const totalSafetyEvents =
    agg.stage1Total +
    agg.precheckCalls +
    agg.heavyCalls +
    agg.rateLimit429Count +
    agg.fallbackEscalationCount;
  const parseStatus =
    discovery.files.length === 0
      ? "not_detected"
      : totalSafetyEvents > 0 || totalRecognizedLines > 0
        ? "recognized"
        : totalDiscoveredBytes === 0
          ? "empty"
          : "unrecognized_format";

  const verdict = classifySafetyStatus({
    filesDiscovered: discovery.files.length,
    parseStatus,
    agg,
    recentHeavyWindow: recentHeavyBurst,
    recentHeavy15m,
    precheckWarnCount,
    precheckLimit,
    heavyBurstCount,
    heavyBurstWindowMin,
    stickyCharThreshold,
    windowHours
  });

  const precheckAvgChars = agg.precheckCalls > 0 ? Math.round(agg.precheckCharsTotal / agg.precheckCalls) : 0;
  const heavyAvgChars = agg.heavyCalls > 0 ? Math.round(agg.heavyCharsTotal / agg.heavyCalls) : 0;
  const totalHiddenChars = agg.precheckCharsTotal + agg.heavyCharsTotal;
  const hiddenStreamTotal = agg.streamPrecheck + agg.streamHeavy;
  const totalStream = agg.streamMain + hiddenStreamTotal;
  const hiddenSharePct = totalStream > 0 ? Number(((hiddenStreamTotal / totalStream) * 100).toFixed(1)) : null;
  const heavyFalseAlarmRatePct =
    agg.heavyTriggeredTrue + agg.heavyTriggeredFalse > 0
      ? Number(((agg.heavyTriggeredFalse / (agg.heavyTriggeredTrue + agg.heavyTriggeredFalse)) * 100).toFixed(1))
      : null;

  const triggerReasons = buildTriggerReasonsList(agg.reasons);
  const { maxStreak, maxStreakAvgChars } = computeConsecutiveLargeFalseAlarms(
    recentHeavy15m,
    stickyCharThreshold
  );

  return stableSortObject({
    schemaVersion: SAFETY_AUDIT_SCHEMA_VERSION,
    enabled: true,
    status: verdict.status,
    severity: verdict.severity,
    verdictCode: verdict.verdictCode,
    summaryEn: verdict.summaryEn,
    summaryZh: verdict.summaryZh,
    actions: verdict.actions,
    windowHours,
    sampledAt: new Date(nowMs).toISOString(),
    window: {
      activeMinutes,
      stage1Total: agg.stage1Total,
      stage1Allowed: agg.stage1Allowed,
      stage1Triggered: agg.stage1Triggered,
      precheckCount: agg.precheckCalls,
      precheckLimit,
      precheckWarnCount,
      precheckUtilizationPct: Number(((agg.precheckCalls / Math.max(1, precheckLimit)) * 100).toFixed(1)),
      precheckTriggeredTrue: agg.precheckTriggeredTrue,
      precheckTriggeredFalse: agg.precheckTriggeredFalse,
      precheckTotalChars: agg.precheckCharsTotal,
      precheckAvgChars,
      precheckMaxChars: agg.precheckCharsMax,
      precheckLatencySec: Number((agg.precheckDurationMs / 1000).toFixed(2)),
      heavyReviewCount: agg.heavyCalls,
      heavyTriggeredTrue: agg.heavyTriggeredTrue,
      heavyTriggeredFalse: agg.heavyTriggeredFalse,
      heavyFalseAlarmRatePct,
      heavyTotalChars: agg.heavyCharsTotal,
      heavyAvgChars,
      heavyMaxChars: agg.heavyCharsMax,
      heavyLargeCount: agg.heavyLargeCount,
      heavyLatencySec: Number((agg.heavyDurationMs / 1000).toFixed(2)),
      totalLatencySec: Number(((agg.precheckDurationMs + agg.heavyDurationMs) / 1000).toFixed(2)),
      rateLimit429Count: agg.rateLimit429Count,
      fallbackEscalationCount: agg.fallbackEscalationCount,
      recentHeavyBurst5m: recentHeavyBurst.length,
      consecutiveLargeFalseAlarms: maxStreak,
      consecutiveLargeAvgChars: maxStreakAvgChars,
      totalHiddenChars,
      estimatedHiddenInputTokensLow: Math.round(totalHiddenChars / 4),
      estimatedHiddenInputTokensHigh: Math.round(totalHiddenChars / 3),
      estimationNote:
        "Lower-bound estimate from logged formatted trajectory chars (3-4 chars/tok); excludes monitor system prompt and provider cache discounts."
    },
    streamRequests: {
      total: totalStream,
      mainOrOther: agg.streamMain,
      hiddenPrecheck: agg.streamPrecheck,
      hiddenHeavy: agg.streamHeavy,
      hiddenTotal: hiddenStreamTotal,
      hiddenSharePct
    },
    triggerReasons: triggerReasons.slice(0, 12),
    recentHeavyEvents: recentHeavyInWindow.slice(-10).map((e) => ({
      ts: new Date(e.ts).toISOString(),
      chars: e.chars,
      durationMs: e.durationMs,
      triggered: Boolean(e.triggered),
      reason: sanitizeSafetyText(e.reason || "unknown", 64),
      model: sanitizeSafetyText(e.model || "gemini-4-hydrogen-sonar", 48)
    })),
    sonarTags: Array.isArray(state.sonarTags) ? state.sonarTags.slice(0, 8) : [],
    sources: {
      filesDiscovered: discovery.files.length,
      filesScanned,
      bytesScanned,
      cacheHits,
      parseStatus,
      recognizedLines: totalRecognizedLines,
      oversizedLinesSkipped: totalOversizedLinesSkipped,
      statePersisted: persistState,
      restartTruncationsDetected: Number(state.restartTruncationsDetected || 0),
      lastDesktopRestart: discovery.lastDesktopRestart,
      scanMs: Math.max(0, Date.now() - t0),
      paths: discovery.files.slice(0, 6).map((f) => ({
        kind: f.kind,
        path: anonymizePathForDisplay(f.path, homeDir, env),
        sizeBytes: f.size
      }))
    }
  });
}

/**
 * Compact summary tailored for `ctx_doctor` (strictly small to protect the <= 8.4 KB MCP invariant).
 */
export function formatSafetyAuditCompactForDoctor(report, { minimal = false } = {}) {
  if (!report || typeof report !== "object") {
    return { status: "not_detected", severity: "none" };
  }
  const w = report.window || {};
  const sr = report.streamRequests || {};
  const base = {
    status: String(report.status || "not_detected"),
    severity: String(report.severity || "none"),
    windowHours: Number(report.windowHours || 5),
    precheckCount: Number(w.precheckCount || 0),
    precheckLimit: Number(w.precheckLimit || 4400),
    rateLimit429Count: Number(w.rateLimit429Count || 0),
    fallbackEscalationCount: Number(w.fallbackEscalationCount || 0),
    heavyReviewCount: Number(w.heavyReviewCount || 0),
    heavyFalseAlarmCount: Number(w.heavyTriggeredFalse || 0),
    heavyAvgChars: Number(w.heavyAvgChars || 0),
    hiddenStreamSharePct: sr.hiddenSharePct ?? null,
    filesScanned: Number(report.sources?.filesScanned || 0)
  };
  if (minimal) {
    return base;
  }
  return {
    ...base,
    totalLatencySec: Number(w.totalLatencySec || 0),
    estimatedHiddenTokensRange:
      w.totalHiddenChars > 0
        ? `${w.estimatedHiddenInputTokensLow}-${w.estimatedHiddenInputTokensHigh}`
        : "0",
    topTriggerReasons: Array.isArray(report.triggerReasons)
      ? report.triggerReasons.slice(0, 4).map((r) => ({
          reason: sanitizeSafetyText(r.reason, 48),
          count: r.count,
          pct: r.pct
        }))
      : [],
    diagnosis: sanitizeSafetyText(report.summaryEn || "", 180),
    recommendedAction: sanitizeSafetyText(report.actions?.[0]?.labelEn || "", 160)
  };
}

/**
 * Format a shareable, fully redacted Markdown report for CLI `--safety-audit` and Dashboard copy button.
 */
export function formatSafetyAuditMarkdown(report) {
  if (!report || typeof report !== "object") {
    return "# Safety Monitor Quota Audit\n\nNo report data available.\n";
  }
  const w = report.window || {};
  const sr = report.streamRequests || {};
  const src = report.sources || {};
  const lines = [
    "# Antigravity Safety Monitor Quota-Burn Audit (Issue #1886)",
    "",
    `- **Status**: \`${report.status}\` (severity: **${String(report.severity || "none").toUpperCase()}**)`,
    `- **Window**: rolling ${report.windowHours || 5}h · sampled at \`${report.sampledAt || ""}\``,
    `- **Diagnosis**: ${report.summaryEn || ""}`,
    ""
  ];

  if (report.status === "not_detected" || report.status === "disabled") {
    lines.push(
      "_Tip: Override log discovery paths with `--safety-log-path <dir-or-file>` or `AGY_DART_SAFETY_LOG_PATHS`._"
    );
    return lines.join("\n");
  }

  lines.push("## 1. Pipeline & Hidden-Request Summary", "");
  lines.push("| Metric | Value |");
  lines.push("| :--- | ---: |");
  lines.push(
    `| Stage 1 \`agy_tool_safety\` checks (allowed / triggered) | ${w.stage1Total || 0} (${w.stage1Allowed || 0} / ${w.stage1Triggered || 0}) |`
  );
  lines.push(
    `| Stage 2 \`sir_flash_lite\` pre-checks (${report.windowHours || 5}h) | ${w.precheckCount || 0} / ${w.precheckLimit || 4400} (${w.precheckUtilizationPct || 0}%) |`
  );
  lines.push(
    `| Stage 3 \`severe_internal_risks_agy\` (\`gemini-4-hydrogen-sonar\`) | ${w.heavyReviewCount || 0} (false alarms: ${w.heavyTriggeredFalse || 0}${w.heavyFalseAlarmRatePct !== null && w.heavyFalseAlarmRatePct !== undefined ? ` / ${w.heavyFalseAlarmRatePct}%` : ""}) |`
  );
  lines.push(
    `| Stage 3 trajectory chars (avg / max / total) | ${(w.heavyAvgChars || 0).toLocaleString("en-US")} / ${(w.heavyMaxChars || 0).toLocaleString("en-US")} / ${(w.heavyTotalChars || 0).toLocaleString("en-US")} |`
  );
  lines.push(
    `| HTTP 429 / \`parent sir_flash_lite failed\` fallbacks | ${w.rateLimit429Count || 0} / ${w.fallbackEscalationCount || 0} |`
  );
  lines.push(
    `| \`streamGenerateContent\` hidden share (tid-attributed) | ${sr.hiddenTotal || 0} / ${sr.total || 0}${sr.hiddenSharePct !== null && sr.hiddenSharePct !== undefined ? ` (${sr.hiddenSharePct}%)` : ""} |`
  );
  lines.push(
    `| Cumulative monitor latency tax | ${w.totalLatencySec || 0}s (precheck ${w.precheckLatencySec || 0}s + heavy ${w.heavyLatencySec || 0}s) |`
  );
  lines.push(
    `| Est. hidden input tokens (lower-bound 3–4 chars/tok) | ~${(w.estimatedHiddenInputTokensLow || 0).toLocaleString("en-US")} – ${(w.estimatedHiddenInputTokensHigh || 0).toLocaleString("en-US")} |`
  );
  lines.push("");

  lines.push("## 2. Stage 1 Trigger Reasons Breakdown", "");
  if (!Array.isArray(report.triggerReasons) || report.triggerReasons.length === 0) {
    lines.push("_No Stage 1 trigger reasons recorded in this window._", "");
  } else {
    lines.push("| Trigger Reason | Category | Count | Share |");
    lines.push("| :--- | :--- | ---: | ---: |");
    for (const r of report.triggerReasons) {
      lines.push(`| \`${r.reason}\` | ${r.category} | ${r.count} | ${r.pct}% |`);
    }
    lines.push("");
  }

  if (Array.isArray(report.actions) && report.actions.length > 0) {
    lines.push("## 3. Recommended Stop-Loss Actions", "");
    for (const act of report.actions) {
      lines.push(`- ${act.labelEn}`);
    }
    lines.push("");
  }

  lines.push("## 4. Scanned Sources (Redacted)", "");
  lines.push(
    `- Files scanned: ${src.filesScanned || 0} · delta bytes read: ${(src.bytesScanned || 0).toLocaleString("en-US")} B · scan time: ${src.scanMs || 0}ms · state persisted: ${src.statePersisted ? "yes" : "no"} · restart truncations survived: ${src.restartTruncationsDetected || 0}`
  );
  if (src.lastDesktopRestart?.ts) {
    lines.push(
      `- Last Desktop restart (\`main.log\`): \`${src.lastDesktopRestart.ts}\` (${src.lastDesktopRestart.version || "unknown"})`
    );
  }
  for (const p of src.paths || []) {
    lines.push(`- \`[${p.kind}]\` \`${p.path}\` (${p.sizeBytes.toLocaleString("en-US")} B)`);
  }
  lines.push("", `> _Note: ${w.estimationNote || "Lower-bound estimate from local logs."}_`);
  return lines.join("\n");
}
