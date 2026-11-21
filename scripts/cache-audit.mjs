#!/usr/bin/env node
/**
 * agy-dart Environment-Wide Prompt Cache Auditor (`npm run cache:audit`).
 * Zero-dependency ESM script auditing all 4 prompt-cache health dimensions:
 *   1. Turn-0 always-loaded rules & skill YAML frontmatter prefix budget (CJK/UTF-8 aware)
 *   2. Configured MCP stdio server determinism (2x live `tools/list` SHA-256 comparison) & schema bloat
 *   3. Lifecycle hooks & plugin conflicts (UI-only safe pattern detection, dynamic timestamp/UUID taint check)
 *   4. Deterministic health score (0-100, grade A-F) & actionable remediation report
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256Hex, stableSortObject, stableStringify } from "../context/lib/stable-json.js";

const DEFAULT_TIMEOUT_MS = 4000;
const SINGLE_RULE_WARN_TOKENS = 1500;
const TOTAL_PREFIX_WARN_TOKENS = 6000;
const MCP_SCHEMA_WARN_TOKENS = 3000;

const PENALTY_WEIGHTS = Object.freeze({
  critical: 20,
  warn: 8,
  info: 2
});

const PENALTY_CAPS = Object.freeze({
  critical: 80,
  warn: 48,
  info: 10
});

const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart",
  "PreInvocation",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "PreCompact",
  "Notification"
]);

const MID_SESSION_EVENTS = new Set(["PreInvocation", "PreToolUse", "PostToolUse"]);
const TOOL_MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

const LEGACY_CONFLICTS_WITH_AGY_DART = Object.freeze([
  {
    plugin: "agy-fast",
    reason: "agy-dart already bundles agy-fast; keeping both duplicates rules, SessionStart snapshot hooks, and fast MCP tools."
  },
  {
    plugin: "antigravity-plugin-context-mode",
    reason: "agy-dart already integrates context-mode; keeping both duplicates PreToolUse hooks, rules, and context MCP tools."
  }
]);

const JS_KEYWORDS = new Set([
  "await", "async", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return",
  "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined",
  "var", "void", "while", "with", "yield", "JSON", "String", "Number", "Boolean",
  "Array", "Object", "Buffer", "Math", "Date", "Error", "RegExp", "Map", "Set",
  "Promise", "console", "process", "globalThis", "stringify", "parse", "join", "trim",
  "slice", "replace", "map", "filter", "toString", "length", "push", "concat"
]);

const VOLATILE_PATTERNS = Object.freeze([
  { name: "Date.now", langs: "js", regex: /\bDate\s*\.\s*now\s*\(/ },
  { name: "new Date", langs: "js", regex: /\bnew\s+Date\s*\(/ },
  { name: "toISOString", langs: "js", regex: /\.\s*toISOString\s*\(/ },
  { name: "toLocaleString", langs: "js", regex: /\.\s*toLocale(?:Date|Time)?String\s*\(/ },
  { name: "toUTCString", langs: "js", regex: /\.\s*toUTCString\s*\(/ },
  { name: "randomUUID", langs: "js", regex: /\brandomUUID\s*\(/ },
  { name: "Math.random", langs: "js", regex: /\bMath\s*\.\s*random\s*\(/ },
  { name: "$(date)", langs: "sh", regex: /\$\(\s*date\b|`\s*date\b/ },
  { name: "uuidgen", langs: "sh", regex: /\buuidgen\b|\/proc\/sys\/kernel\/random\/uuid/ },
  { name: "$RANDOM", langs: "sh", regex: /\$RANDOM\b|\$\{RANDOM\}/ },
  { name: "Get-Date", langs: "ps1", regex: /\bGet-Date\b/i },
  { name: "DateTime::Now", langs: "ps1", regex: /\[(?:System\.)?DateTime\]::(?:Utc)?Now\b/i },
  { name: "New-Guid", langs: "ps1", regex: /\bNew-Guid\b|\[(?:System\.)?Guid\]::NewGuid\s*\(/i },
  { name: "Get-Random", langs: "ps1", regex: /\bGet-Random\b/i }
]);

function compareAscii(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function getHomeDir() {
  return process.platform === "win32"
    ? process.env.USERPROFILE || process.env.HOME || os.homedir()
    : process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function normalizePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toPosixDisplay(p, baseDir = "") {
  if (baseDir) {
    const rel = path.relative(baseDir, p);
    if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, "/");
    }
  }
  return String(p || "").replace(/\\/g, "/");
}

function isCjkCodePoint(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x33ff) || // CJK Radicals, Kangxi, Symbols, Hiragana, Katakana, Bopomofo, Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xffef) || // Halfwidth and Fullwidth Forms
    (cp >= 0x20000 && cp <= 0x2fa1f)  // CJK Extensions B-F & Compatibility Supplement
  );
}

/**
 * CJK / UTF-8-aware token estimator (exact quarter-token integer formula aligned with scripts/prefix-budget.mjs).
 * Avoids both the ~4-5x undercount of `chars / 4` on CJK rules and IEEE-754 float drift.
 */
export function estimateTokens(input) {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.ceil(input / 4) : 0;
  }
  const str = String(input ?? "");
  if (!str) return 0;

  let quarterTokens = 0;
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      quarterTokens += 1; // 0.25 tok/char
    } else if (isCjkCodePoint(cp)) {
      quarterTokens += 5; // 1.25 tok/char
    } else if (cp > 0xffff) {
      quarterTokens += 6; // 1.50 tok/char
    } else {
      quarterTokens += 4; // 1.00 tok/char
    }
  }
  return Math.ceil(quarterTokens / 4);
}

function measureTextStats(text) {
  const str = String(text ?? "");
  let cjkChars = 0;
  let asciiChars = 0;
  let otherChars = 0;
  let quarterTokens = 0;

  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      asciiChars += 1;
      quarterTokens += 1;
    } else if (isCjkCodePoint(cp)) {
      cjkChars += 1;
      quarterTokens += 5;
    } else if (cp > 0xffff) {
      otherChars += 1;
      quarterTokens += 6;
    } else {
      otherChars += 1;
      quarterTokens += 4;
    }
  }

  return {
    bytes: Buffer.byteLength(str, "utf8"),
    chars: str.length,
    cjkChars,
    asciiChars,
    otherChars,
    tokens: Math.ceil(quarterTokens / 4),
    sha256: sha256Hex(str)
  };
}

function splitFrontmatter(markdown) {
  const normalized = String(markdown || "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: "", body: normalized };
  }
  const frontmatter = match[0];
  return {
    frontmatter,
    body: normalized.slice(frontmatter.length)
  };
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return { ok: true, data: JSON.parse(stripped), error: null };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listMarkdownFiles(dir, maxDepth = 2) {
  if (!isDir(dir)) return [];
  const out = [];
  const walk = (cur, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareAscii(a.name, b.name));
    for (const ent of entries) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const full = path.join(cur, ent.name);
      if (ent.isFile() && /\.md$/i.test(ent.name)) {
        out.push(full);
      } else if (ent.isDirectory() && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };
  walk(dir, 0);
  return out;
}

function listSkillFiles(skillsRoot) {
  if (!isDir(skillsRoot)) return [];
  let entries;
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => compareAscii(a.name, b.name));
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const subDir = path.join(skillsRoot, ent.name);
    const exact = path.join(subDir, "SKILL.md");
    if (isFile(exact)) {
      out.push({ skillName: ent.name, path: exact });
      continue;
    }
    const lower = path.join(subDir, "skill.md");
    if (isFile(lower)) {
      out.push({ skillName: ent.name, path: lower });
    }
  }
  return out;
}

function discoverPlugins(configDir, workspaceDir) {
  const disabledSet = new Set();
  const cfgPath = path.join(configDir, "config.json");
  if (isFile(cfgPath)) {
    const parsed = safeReadJson(cfgPath);
    if (parsed.ok && parsed.data && typeof parsed.data.plugins === "object" && parsed.data.plugins !== null) {
      for (const [key, val] of Object.entries(parsed.data.plugins)) {
        if (val && typeof val === "object" && val.enabled === false) {
          disabledSet.add(key);
        }
      }
    }
  }

  const activePlugins = [];
  const disabledPlugins = [];
  const seenPluginDirs = new Set();

  const scanRoot = (pluginsRoot, scopePrefix, checkDisabled) => {
    if (!isDir(pluginsRoot)) return;
    let entries;
    try {
      entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareAscii(a.name, b.name));
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const dir = path.join(pluginsRoot, ent.name);
      const dirKey = normalizePathKey(dir);
      if (seenPluginDirs.has(dirKey)) continue;
      seenPluginDirs.add(dirKey);
      let pluginName = ent.name;
      const manifestPath = path.join(dir, "plugin.json");
      if (isFile(manifestPath)) {
        const mf = safeReadJson(manifestPath);
        if (mf.ok && typeof mf.data?.name === "string" && mf.data.name.trim()) {
          pluginName = mf.data.name.trim();
        }
      }
      const isDisabled = checkDisabled && (disabledSet.has(ent.name) || disabledSet.has(pluginName));
      const record = {
        name: pluginName,
        dirName: ent.name,
        dir,
        scope: `${scopePrefix}:${pluginName}`
      };
      if (isDisabled) {
        disabledPlugins.push(record);
      } else {
        activePlugins.push(record);
      }
    }
  };

  scanRoot(path.join(configDir, "plugins"), "plugin", true);
  scanRoot(path.join(workspaceDir, ".agents", "plugins"), "workspace-plugin", false);

  return { activePlugins, disabledPlugins };
}

/* ============================================================================
 * Check 1: Turn-0 Rules & Skill YAML Frontmatter Prefix Audit
 * ========================================================================== */

function auditTurn0Prefix(configDir, workspaceDir, activePlugins, findings) {
  const seen = new Set();
  const items = [];

  const addRuleFile = (filePath, scope, baseDir) => {
    if (!isFile(filePath)) return;
    const key = normalizePathKey(filePath);
    if (seen.has(key)) return;
    seen.add(key);

    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const stats = measureTextStats(text);
    const displayName = toPosixDisplay(filePath, baseDir);
    items.push({
      kind: "rule",
      scope,
      name: displayName,
      path: path.resolve(filePath),
      bytes: stats.bytes,
      chars: stats.chars,
      cjkChars: stats.cjkChars,
      tokens: stats.tokens,
      sha256: stats.sha256
    });
  };

  const addSkillFile = ({ skillName, path: filePath }, scope) => {
    if (!isFile(filePath)) return;
    const key = normalizePathKey(filePath);
    if (seen.has(key)) return;
    seen.add(key);

    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const { frontmatter, body } = splitFrontmatter(text);
    const fmStats = measureTextStats(frontmatter);
    const bodyStats = measureTextStats(body);
    items.push({
      kind: "skill_frontmatter",
      scope,
      name: `skills/${skillName}/SKILL.md`,
      path: path.resolve(filePath),
      bytes: fmStats.bytes,
      chars: fmStats.chars,
      cjkChars: fmStats.cjkChars,
      tokens: fmStats.tokens,
      sha256: fmStats.sha256,
      bodyBytes: bodyStats.bytes,
      bodyTokens: bodyStats.tokens
    });
  };

  // Global configDir rules & skills
  for (const f of listMarkdownFiles(path.join(configDir, "rules"))) {
    addRuleFile(f, "global", configDir);
  }
  for (const s of listSkillFiles(path.join(configDir, "skills"))) {
    addSkillFile(s, "global");
  }

  // Active plugin rules & skills (both global & workspace plugins)
  for (const plugin of activePlugins) {
    for (const f of listMarkdownFiles(path.join(plugin.dir, "rules"))) {
      addRuleFile(f, plugin.scope, plugin.dir);
    }
    for (const s of listSkillFiles(path.join(plugin.dir, "skills"))) {
      addSkillFile(s, plugin.scope);
    }
  }

  // Workspace always-loaded root rules
  for (const rootFile of ["AGENTS.md", "GEMINI.md", "CLAUDE.md"]) {
    const candidate = path.join(workspaceDir, rootFile);
    if (isFile(candidate)) {
      addRuleFile(candidate, "workspace", workspaceDir);
    }
  }
  for (const f of listMarkdownFiles(path.join(workspaceDir, ".gemini", "rules"))) {
    addRuleFile(f, "workspace", workspaceDir);
  }
  for (const f of listMarkdownFiles(path.join(workspaceDir, ".agents", "rules"))) {
    addRuleFile(f, "workspace", workspaceDir);
  }

  // Workspace skills (support .agents/skills, .gemini/skills, and skills/)
  for (const skillsSub of [
    path.join(workspaceDir, ".agents", "skills"),
    path.join(workspaceDir, ".gemini", "skills"),
    path.join(workspaceDir, "skills")
  ]) {
    for (const s of listSkillFiles(skillsSub)) {
      addSkillFile(s, "workspace");
    }
  }

  // Rank descending by estimated tokens (deterministic path tie-break)
  items.sort((a, b) => (b.tokens !== a.tokens ? b.tokens - a.tokens : compareAscii(a.path, b.path)));

  let ruleCount = 0;
  let skillCount = 0;
  let ruleTokens = 0;
  let skillFrontmatterTokens = 0;
  let totalBytes = 0;
  let totalChars = 0;

  for (const item of items) {
    totalBytes += item.bytes;
    totalChars += item.chars;
    if (item.kind === "rule") {
      ruleCount += 1;
      ruleTokens += item.tokens;
      if (item.tokens > SINGLE_RULE_WARN_TOKENS) {
        const cjkNote = item.cjkChars > 0 ? ` (${item.cjkChars} CJK chars)` : "";
        findings.push({
          severity: "warn",
          code: "oversized_rule_file",
          category: "prefix",
          target: `${item.scope}:${item.name}`,
          message: `Always-loaded rule '${item.name}' is ~${item.tokens} est. tokens${cjkNote}, exceeding the ${SINGLE_RULE_WARN_TOKENS}-token single-file recommendation.`,
          recommendation: `Trim '${item.name}' to crisp routing/constraint bullets and move lengthy examples or playbooks into an on-demand SKILL.md body (only YAML frontmatter loads at Turn 0).`
        });
      }
    } else {
      skillCount += 1;
      skillFrontmatterTokens += item.tokens;
    }
  }

  const totalTokens = ruleTokens + skillFrontmatterTokens;
  if (totalTokens > TOTAL_PREFIX_WARN_TOKENS) {
    const topNames = items
      .slice(0, 3)
      .map((i) => `${i.name} (${i.tokens} tok)`)
      .join(", ");
    findings.push({
      severity: "warn",
      code: "excessive_prefix_budget",
      category: "prefix",
      target: "turn0-rules-and-skills",
      message: `Combined Turn-0 rules & skill frontmatter prefix is ~${totalTokens} est. tokens (>${TOTAL_PREFIX_WARN_TOKENS} budget). Top contributors: ${topNames}.`,
      recommendation: "Move bulky reference docs out of always-loaded rules into on-demand skills, shorten verbose skill descriptions, or disable unused plugins."
    });
  }

  return {
    thresholds: {
      singleRuleWarnTokens: SINGLE_RULE_WARN_TOKENS,
      totalPrefixWarnTokens: TOTAL_PREFIX_WARN_TOKENS
    },
    ruleCount,
    skillCount,
    ruleTokens,
    skillFrontmatterTokens,
    totalTokens,
    totalBytes,
    totalChars,
    items
  };
}

/* ============================================================================
 * Check 2: MCP Server Determinism & Schema Bloat Audit
 * ========================================================================== */

function substituteVars(value, vars) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined) {
      return String(vars[key]);
    }
    return match;
  });
}

function isRemoteMcpEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.command) return false;
  const transport = String(entry.type || entry.transport || "").toLowerCase();
  if (transport === "http" || transport === "sse" || transport === "streamable-http") return true;
  return Boolean(entry.serverUrl || entry.url || entry.httpUrl || entry.sseUrl || entry.endpoint);
}

function isSortedByName(tools) {
  for (let i = 1; i < tools.length; i++) {
    if (compareAscii(tools[i - 1]?.name, tools[i]?.name) > 0) {
      return false;
    }
  }
  return true;
}

function sortToolsByName(tools) {
  return [...tools].sort((a, b) => compareAscii(a?.name, b?.name));
}

function killChildTree(child, usedShell) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && usedShell && child.pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref();
      return;
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

/**
 * Extract JSON-RPC messages from a stdout buffer supporting both NDJSON and Content-Length framing.
 */
function drainMcpMessages(state) {
  const messages = [];
  while (state.buf.length > 0) {
    // Strip leading CR/LF whitespace between frames
    let start = 0;
    while (start < state.buf.length && (state.buf[start] === 0x0d || state.buf[start] === 0x0a || state.buf[start] === 0x20 || state.buf[start] === 0x09)) {
      start += 1;
    }
    if (start > 0) {
      state.buf = state.buf.subarray(start);
      if (state.buf.length === 0) break;
    }

    // Check for LSP-style Content-Length framing
    const prefix = state.buf.subarray(0, Math.min(state.buf.length, 32)).toString("ascii");
    if (/^Content-Length:/i.test(prefix)) {
      const sepCrlf = state.buf.indexOf("\r\n\r\n");
      const sepLf = state.buf.indexOf("\n\n");
      let headerEnd = -1;
      let sepLen = 0;
      if (sepCrlf !== -1 && (sepLf === -1 || sepCrlf < sepLf)) {
        headerEnd = sepCrlf;
        sepLen = 4;
      } else if (sepLf !== -1) {
        headerEnd = sepLf;
        sepLen = 2;
      }
      if (headerEnd === -1) break; // wait for complete headers

      const headersText = state.buf.subarray(0, headerEnd).toString("ascii");
      const lenMatch = headersText.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) {
        state.buf = state.buf.subarray(headerEnd + sepLen);
        continue;
      }
      const contentLength = Number.parseInt(lenMatch[1], 10);
      const bodyStart = headerEnd + sepLen;
      if (state.buf.length < bodyStart + contentLength) {
        break; // wait for full body
      }
      const bodyText = state.buf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      state.buf = state.buf.subarray(bodyStart + contentLength);
      try {
        messages.push(JSON.parse(bodyText));
      } catch {}
      continue;
    }

    // Newline-delimited JSON
    const nl = state.buf.indexOf(0x0a);
    if (nl === -1) {
      // Try parsing in case a server sent a single JSON object without trailing newline before close
      if (state.eof) {
        const line = state.buf.toString("utf8").trim();
        state.buf = Buffer.alloc(0);
        if (line.startsWith("{")) {
          try {
            messages.push(JSON.parse(line));
          } catch {}
        }
      }
      break;
    }

    const line = state.buf.subarray(0, nl).toString("utf8").trim();
    state.buf = state.buf.subarray(nl + 1);
    if (!line || !line.startsWith("{")) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {}
  }
  return messages;
}

function probeMcpServerOnce({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const isWin = process.platform === "win32";
    const resolvedCmd = command === "node" ? process.execPath : command;
    const needsShell =
      isWin &&
      resolvedCmd !== process.execPath &&
      (/\.(?:cmd|bat)$/i.test(resolvedCmd) ||
        ["npx", "npm", "pnpm", "yarn", "uvx"].includes(path.basename(resolvedCmd).toLowerCase()));

    let child;
    try {
      if (needsShell) {
        const strArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
        if (
          resolvedCmd.includes('"') ||
          /[\r\n\0]/.test(resolvedCmd) ||
          strArgs.some((a) => a.includes('"') || /[\r\n\0]/.test(a))
        ) {
          resolve({
            ok: false,
            status: "error",
            durationMs: Date.now() - t0,
            error: "Unsafe quote or control character in Windows shell-wrapped MCP server command/arguments"
          });
          return;
        }
        // Env-var indirection prevents cmd.exe metacharacter injection AND %VAR% environment expansion
        const cmdEnv = { ...env, __AGY_CMD_FILE: resolvedCmd };
        const argRefs = strArgs.map((arg, idx) => {
          const key = `__AGY_CMD_ARG_${idx}`;
          cmdEnv[key] = arg;
          return `"%${key}%"`;
        });
        const cmdLine = `"${['"%__AGY_CMD_FILE%"', ...argRefs].join(" ")}"`;
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdLine], {
          cwd,
          env: cmdEnv,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true
        });
      } else {
        child = spawn(resolvedCmd, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      }
      child.stdin?.on("error", () => {});
    } catch (err) {
      resolve({
        ok: false,
        status: "error",
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    let settled = false;
    let initSentToolsList = false;
    let pendingOutcome = null;
    let stderrSnippet = "";
    const parseState = { buf: Buffer.alloc(0), eof: false };
    const timers = [];

    const clearAllTimers = () => {
      while (timers.length > 0) {
        clearTimeout(timers.pop());
      }
    };

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      } catch {}
      try {
        child.unref();
      } catch {}
      resolve({
        ...outcome,
        durationMs: Date.now() - t0
      });
    };

    const beginTeardown = (outcome) => {
      if (settled || pendingOutcome) return;
      pendingOutcome = outcome;
      try {
        child.stdin?.end();
      } catch {}

      if (child.exitCode !== null || child.signalCode !== null) {
        finish(outcome);
        return;
      }

      const termTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      }, 80);
      termTimer.unref();
      timers.push(termTimer);

      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killChildTree(child, needsShell);
        }
      }, 220);
      killTimer.unref();
      timers.push(killTimer);

      const forceResolveTimer = setTimeout(() => {
        finish(outcome);
      }, 450);
      forceResolveTimer.unref();
      timers.push(forceResolveTimer);
    };

    const sendLine = (obj) => {
      try {
        if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(JSON.stringify(obj) + "\n");
        }
      } catch {}
    };

    const handleMessages = (msgs) => {
      for (const msg of msgs) {
        if (!msg || typeof msg !== "object") continue;
        if (msg.id === 1 && !initSentToolsList) {
          if (msg.error) {
            beginTeardown({
              ok: false,
              status: "error",
              error: `MCP initialize error: ${msg.error.message || JSON.stringify(msg.error)}`
            });
            return;
          }
          initSentToolsList = true;
          sendLine({ jsonrpc: "2.0", method: "notifications/initialized" });
          sendLine({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            beginTeardown({
              ok: false,
              status: "error",
              error: `MCP tools/list error: ${msg.error.message || JSON.stringify(msg.error)}`
            });
            return;
          }
          const tools = msg.result?.tools;
          if (!Array.isArray(tools)) {
            beginTeardown({
              ok: false,
              status: "error",
              error: "Invalid MCP tools/list response: result.tools is not an array"
            });
            return;
          }
          beginTeardown({
            ok: true,
            status: "ok",
            tools
          });
          return;
        }
      }
    };

    const overallTimer = setTimeout(() => {
      beginTeardown({
        ok: false,
        status: "timeout",
        error: `MCP tools/list timed out after ${timeoutMs}ms`
      });
    }, Math.max(200, timeoutMs));
    overallTimer.unref();
    timers.push(overallTimer);

    child.stdin?.on("error", () => {});

    child.stdout?.on("data", (chunk) => {
      if (settled || pendingOutcome) return;
      parseState.buf = Buffer.concat([parseState.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      handleMessages(drainMcpMessages(parseState));
    });

    child.stderr?.on("data", (chunk) => {
      if (stderrSnippet.length < 1024) {
        stderrSnippet += chunk.toString("utf8").slice(0, 1024 - stderrSnippet.length);
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: "error",
        error: err instanceof Error ? err.message : String(err)
      });
    });

    child.on("close", (code, signal) => {
      if (pendingOutcome) {
        finish(pendingOutcome);
        return;
      }
      // Flush any trailing line without newline
      parseState.eof = true;
      handleMessages(drainMcpMessages(parseState));
      if (pendingOutcome) {
        finish(pendingOutcome);
        return;
      }
      const detail = stderrSnippet.trim() ? `: ${stderrSnippet.trim().slice(0, 240)}` : "";
      finish({
        ok: false,
        status: "error",
        error: `MCP server exited before tools/list (code=${code}, signal=${signal})${detail}`
      });
    });

    // Begin MCP handshake
    sendLine({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agy-dart-cache-audit", version: "1.2.0" }
      }
    });
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, limit), items.length);
  const runners = Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function auditMcpServers(configDir, workspaceDir, activePlugins, { live, timeoutMs }, findings) {
  const configSources = [];
  const seenConfigs = new Set();

  const addConfig = (configPath, scope, pluginRoot) => {
    if (!isFile(configPath)) return;
    const key = normalizePathKey(configPath);
    if (seenConfigs.has(key)) return;
    seenConfigs.add(key);
    configSources.push({ configPath: path.resolve(configPath), scope, pluginRoot: path.resolve(pluginRoot) });
  };

  addConfig(path.join(configDir, "mcp_config.json"), "global", configDir);
  for (const plugin of activePlugins) {
    addConfig(path.join(plugin.dir, "mcp_config.json"), plugin.scope, plugin.dir);
  }
  addConfig(path.join(workspaceDir, ".gemini", "mcp_config.json"), "workspace", workspaceDir);

  const discovered = [];

  for (const src of configSources) {
    const parsed = safeReadJson(src.configPath);
    if (!parsed.ok) {
      findings.push({
        severity: "info",
        code: "invalid_config_json",
        category: "mcp",
        target: src.configPath,
        message: `Failed to parse MCP config '${toPosixDisplay(src.configPath)}': ${parsed.error}`,
        recommendation: "Fix JSON syntax in this mcp_config.json file."
      });
      continue;
    }
    const mcpServers = parsed.data?.mcpServers;
    if (!mcpServers || typeof mcpServers !== "object") continue;

    for (const serverName of Object.keys(mcpServers).sort(compareAscii)) {
      const entry = mcpServers[serverName];
      if (!entry || typeof entry !== "object") continue;
      discovered.push({
        id: `${src.scope}/${serverName}`,
        name: serverName,
        scope: src.scope,
        pluginRoot: src.pluginRoot,
        configPath: src.configPath,
        entry
      });
    }
  }

  let tmpProbeDir = "";
  const stdioCount = discovered.filter((d) => !d.entry.disabled && !isRemoteMcpEntry(d.entry) && Boolean(d.entry.command)).length;
  if (live && stdioCount > 0) {
    tmpProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-cache-audit-"));
  }

  try {
    const servers = await runWithConcurrency(discovered, 3, async (item, idx) => {
      const { id, name, scope, pluginRoot, configPath, entry } = item;

      if (entry.disabled === true) {
        return {
          id,
          name,
          scope,
          configPath,
          transport: isRemoteMcpEntry(entry) ? "remote" : "stdio",
          status: "skipped_disabled",
          toolCount: 0,
          bytes: 0,
          tokens: 0,
          rawSha256: null,
          rawSha256Run2: null,
          canonicalSha256: null,
          canonicalSha256Run2: null,
          deterministic: null,
          sortedByName: null,
          canonicalKeys: null,
          canonical: null,
          durationMs: 0,
          error: null
        };
      }

      if (isRemoteMcpEntry(entry)) {
        return {
          id,
          name,
          scope,
          configPath,
          transport: "remote",
          url: String(entry.serverUrl || entry.url || entry.httpUrl || entry.sseUrl || entry.endpoint || ""),
          status: "skipped_remote",
          toolCount: 0,
          bytes: 0,
          tokens: 0,
          rawSha256: null,
          rawSha256Run2: null,
          canonicalSha256: null,
          canonicalSha256Run2: null,
          deterministic: null,
          sortedByName: null,
          canonicalKeys: null,
          canonical: null,
          durationMs: 0,
          error: null
        };
      }

      if (typeof entry.command !== "string" || !entry.command.trim()) {
        return {
          id,
          name,
          scope,
          configPath,
          transport: "stdio",
          status: "skipped_invalid",
          toolCount: 0,
          bytes: 0,
          tokens: 0,
          rawSha256: null,
          rawSha256Run2: null,
          canonicalSha256: null,
          canonicalSha256Run2: null,
          deterministic: null,
          sortedByName: null,
          canonicalKeys: null,
          canonical: null,
          durationMs: 0,
          error: "Missing command in mcp_config.json entry"
        };
      }

      const pluginDataDir = tmpProbeDir ? path.join(tmpProbeDir, `data-${idx}`) : os.tmpdir();
      if (tmpProbeDir && live) {
        try {
          fs.mkdirSync(pluginDataDir, { recursive: true });
        } catch {}
      }
      const vars = {
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginDataDir,
        WORKSPACE: workspaceDir,
        workspaceFolder: workspaceDir
      };

      const command = substituteVars(entry.command.trim(), vars);
      const args = Array.isArray(entry.args) ? entry.args.map((a) => substituteVars(String(a), vars)) : [];
      const cwd =
        typeof entry.cwd === "string" && entry.cwd.trim()
          ? substituteVars(entry.cwd.trim(), vars)
          : scope.startsWith("plugin:") || scope.startsWith("workspace-plugin:")
            ? pluginRoot
            : workspaceDir;

      if (!live) {
        return {
          id,
          name,
          scope,
          configPath,
          transport: "stdio",
          command,
          status: "skipped_no_live",
          toolCount: 0,
          bytes: 0,
          tokens: 0,
          rawSha256: null,
          rawSha256Run2: null,
          canonicalSha256: null,
          canonicalSha256Run2: null,
          deterministic: null,
          sortedByName: null,
          canonicalKeys: null,
          canonical: null,
          durationMs: 0,
          error: null
        };
      }

      const childEnv = { ...process.env };
      if (entry.env && typeof entry.env === "object") {
        for (const [k, v] of Object.entries(entry.env)) {
          if (v !== undefined && v !== null) {
            childEnv[k] = substituteVars(String(v), vars);
          }
        }
      }
      if (!childEnv.AGY_DART_DB_PATH && tmpProbeDir) {
        childEnv.AGY_DART_DB_PATH = path.join(tmpProbeDir, `probe-${idx}.db`);
      }

      // Run 2 completely separate sessions so startup readdir/init jitter is reliably caught
      const run1 = await probeMcpServerOnce({ command, args, cwd, env: childEnv, timeoutMs });
      if (!run1.ok) {
        return {
          id,
          name,
          scope,
          configPath,
          transport: "stdio",
          command,
          status: run1.status,
          toolCount: 0,
          bytes: 0,
          tokens: 0,
          rawSha256: null,
          rawSha256Run2: null,
          canonicalSha256: null,
          canonicalSha256Run2: null,
          deterministic: null,
          sortedByName: null,
          canonicalKeys: null,
          canonical: null,
          durationMs: run1.durationMs,
          error: run1.error
        };
      }

      const run2 = await probeMcpServerOnce({ command, args, cwd, env: childEnv, timeoutMs });
      if (!run2.ok) {
        return {
          id,
          name,
          scope,
          configPath,
          transport: "stdio",
          command,
          status: run2.status,
          toolCount: run1.tools.length,
          bytes: Buffer.byteLength(JSON.stringify(run1.tools), "utf8"),
          tokens: estimateTokens(JSON.stringify(run1.tools)),
          rawSha256: sha256Hex(JSON.stringify(run1.tools)),
          rawSha256Run2: null,
          canonicalSha256: sha256Hex(stableStringify(sortToolsByName(run1.tools))),
          canonicalSha256Run2: null,
          deterministic: null,
          sortedByName: isSortedByName(run1.tools),
          canonicalKeys: JSON.stringify(run1.tools) === stableStringify(run1.tools),
          canonical: null,
          durationMs: run1.durationMs + run2.durationMs,
          error: `Run 2 failed: ${run2.error}`
        };
      }

      const rawJson1 = JSON.stringify(run1.tools);
      const rawJson2 = JSON.stringify(run2.tools);
      const rawSha1 = sha256Hex(rawJson1);
      const rawSha2 = sha256Hex(rawJson2);
      const canonicalJson1 = stableStringify(sortToolsByName(run1.tools));
      const canonicalJson2 = stableStringify(sortToolsByName(run2.tools));
      const canonicalSha1 = sha256Hex(canonicalJson1);
      const canonicalSha2 = sha256Hex(canonicalJson2);

      const deterministic = rawSha1 === rawSha2;
      const sorted = isSortedByName(run1.tools);
      const canonicalKeys = rawJson1 === stableStringify(run1.tools);
      const canonical = sorted && canonicalKeys;
      const bytes = Buffer.byteLength(rawJson1, "utf8");
      const tokens = estimateTokens(rawJson1);

      return {
        id,
        name,
        scope,
        configPath,
        transport: "stdio",
        command,
        status: deterministic ? "ok" : "non_deterministic",
        toolCount: run1.tools.length,
        bytes,
        tokens,
        rawSha256: rawSha1,
        rawSha256Run2: rawSha2,
        canonicalSha256: canonicalSha1,
        canonicalSha256Run2: canonicalSha2,
        deterministic,
        sortedByName: sorted,
        canonicalKeys,
        canonical,
        durationMs: run1.durationMs + run2.durationMs,
        error: null
      };
    });

    // Rank servers by estimated schema tokens descending (deterministic tie-break by id)
    servers.sort((a, b) => (b.tokens !== a.tokens ? b.tokens - a.tokens : compareAscii(a.id, b.id)));

    let probedCount = 0;
    let deterministicCount = 0;
    let nonDeterministicCount = 0;
    let skippedRemoteCount = 0;
    let skippedDisabledCount = 0;
    let errorCount = 0;
    let totalSchemaTokens = 0;
    let totalToolCount = 0;

    for (const s of servers) {
      if (s.status === "skipped_remote") {
        skippedRemoteCount += 1;
        continue;
      }
      if (s.status === "skipped_disabled") {
        skippedDisabledCount += 1;
        continue;
      }
      if (s.status === "skipped_no_live" || s.status === "skipped_invalid") {
        continue;
      }
      if (s.status === "error" || s.status === "timeout") {
        errorCount += 1;
        findings.push({
          severity: "info",
          code: "mcp_probe_failed",
          category: "mcp",
          target: s.id,
          message: `Could not verify MCP server '${s.id}' (${s.status}): ${s.error || "unknown error"}.`,
          recommendation: `Verify the server binary/args in '${toPosixDisplay(s.configPath)}' or increase --timeout if the server is slow to boot.`
        });
        continue;
      }

      probedCount += 1;
      totalSchemaTokens += s.tokens;
      totalToolCount += s.toolCount;

      if (s.deterministic === false) {
        nonDeterministicCount += 1;
        const driftKind =
          s.canonicalSha256 === s.canonicalSha256Run2
            ? "tool or key ordering changed between spawns"
            : "schema content changed between spawns";
        findings.push({
          severity: "critical",
          code: "non_deterministic_tools_list",
          category: "mcp",
          target: s.id,
          message: `MCP server '${s.id}' returned non-deterministic tools/list across two separate sessions (${driftKind}; run1=${s.rawSha256.slice(0, 12)}, run2=${s.rawSha256Run2.slice(0, 12)}) — causes KV-cache prefix busts on reconnect/reload.`,
          recommendation: "Sort tools deterministically by `name` and recursively sort object keys (e.g., stableSortObject) before returning `tools/list`, and remove dynamic timestamps/IDs from tool descriptions."
        });
      } else if (s.deterministic === true) {
        deterministicCount += 1;
        if (!s.sortedByName || !s.canonicalKeys) {
          const reasons = [];
          if (!s.sortedByName) reasons.push("tools not sorted by name");
          if (!s.canonicalKeys) reasons.push("JSON object keys not canonically sorted");
          findings.push({
            severity: "info",
            code: "non_canonical_tools_schema",
            category: "mcp",
            target: s.id,
            message: `MCP server '${s.id}' is deterministic across runs, but ${reasons.join(" and ")}.`,
            recommendation: "Sort `tools/list` output by tool name with canonical key ordering to protect against future serialization drift across upgrades."
          });
        }
      }

      if (s.tokens > MCP_SCHEMA_WARN_TOKENS) {
        findings.push({
          severity: "warn",
          code: "bloated_mcp_schema",
          category: "mcp",
          target: s.id,
          message: `MCP server '${s.id}' exposes ${s.toolCount} tools consuming ~${s.tokens} est. Turn-0 tokens (>${MCP_SCHEMA_WARN_TOKENS} threshold).`,
          recommendation: "Shorten verbose parameter descriptions, consolidate overlapping tools, or disable this MCP server when not actively needed."
        });
      }
    }

    return {
      thresholds: {
        serverSchemaWarnTokens: MCP_SCHEMA_WARN_TOKENS
      },
      liveProbed: Boolean(live),
      serverCount: servers.length,
      probedCount,
      deterministicCount,
      nonDeterministicCount,
      skippedRemoteCount,
      skippedDisabledCount,
      errorCount,
      totalSchemaTokens,
      totalToolCount,
      servers
    };
  } finally {
    if (tmpProbeDir) {
      try {
        fs.rmSync(tmpProbeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {}
    }
  }
}

/* ============================================================================
 * Check 3: Hooks & Plugin Conflict Audit
 * ========================================================================== */

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "case", "throw", "in", "instanceof", "typeof", "void",
  "delete", "of", "yield", "await", "else", "do", "new"
]);

const REGEX_PRECEDING_CHARS = new Set([
  "(", "[", "{", ",", ";", ":", "=", "?", "!", "&", "|", "^", "~", "+", "-", "*", "%", "<", ">", "/"
]);

function stripJsComments(source, { maskStrings = true } = {}) {
  const n = source.length;
  let out = "";
  let i = 0;
  let canStartRegex = true;
  // Stack of brace depths inside template `${ ... }` expressions (0 when waiting for closing `}`)
  const templateBraceStack = [];

  const scanTemplateText = (startPos) => {
    let k = startPos;
    while (k < n) {
      const tc = source[k];
      const tn = source[k + 1];
      if (tc === "\\" && k + 1 < n) {
        out += maskStrings ? (tn === "\n" ? "_\n" : "__") : tc + tn;
        k += 2;
        continue;
      }
      if (tc === "$" && tn === "{") {
        out += "${";
        templateBraceStack.push(0);
        canStartRegex = true;
        return k + 2;
      }
      if (tc === "`") {
        out += "`";
        canStartRegex = false;
        return k + 1;
      }
      out += maskStrings && tc !== "\n" && tc !== "\r" ? "_" : tc;
      k += 1;
    }
    canStartRegex = false;
    return k;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      // Line comment
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "/" && canStartRegex) {
      // JS regex literal: mask body in JS mode so regexes like `/systemMessage|Date\.now/` never false-positive
      let j = i + 1;
      let inCharClass = false;
      let closed = false;
      while (j < n) {
        const rc = source[j];
        if (rc === "\\" && j + 1 < n && source[j + 1] !== "\n" && source[j + 1] !== "\r") {
          j += 2;
          continue;
        }
        if (rc === "\n" || rc === "\r") {
          break;
        }
        if (rc === "[" && !inCharClass) {
          inCharClass = true;
        } else if (rc === "]" && inCharClass) {
          inCharClass = false;
        } else if (rc === "/" && !inCharClass) {
          closed = true;
          j += 1;
          while (j < n && /[a-z]/i.test(source[j])) j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        const rawRe = source.slice(i, j);
        if (maskStrings) {
          const lastSlash = rawRe.lastIndexOf("/");
          const bodyLen = Math.max(0, lastSlash - 1);
          out += `/${"_".repeat(bodyLen)}${rawRe.slice(lastSlash)}`;
        } else {
          out += rawRe;
        }
        i = j;
        canStartRegex = false;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        const sc = source[j];
        if (sc === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (sc === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const rawStr = source.slice(i, j);
      if (!maskStrings) {
        out += rawStr;
      } else {
        const isClosed = rawStr.length >= 2 && rawStr.endsWith(quote);
        const inner = isClosed ? rawStr.slice(1, -1) : rawStr.slice(1);
        let afterIdx = j;
        while (afterIdx < n && /\s/.test(source[afterIdx])) afterIdx += 1;
        const isTrackedPropKey = source[afterIdx] === ":" && (inner === "systemMessage" || inner === "user_markdown");
        if (inner.length === 0 || isTrackedPropKey) {
          out += rawStr;
        } else {
          const maskedInner = inner.replace(/[^\n\r]/g, "_");
          out += isClosed ? `${quote}${maskedInner}${quote}` : `${quote}${maskedInner}`;
        }
      }
      i = j;
      canStartRegex = false;
      continue;
    }
    if (ch === "`") {
      out += "`";
      i = scanTemplateText(i + 1);
      continue;
    }
    if (ch === "{") {
      if (templateBraceStack.length > 0) {
        templateBraceStack[templateBraceStack.length - 1] += 1;
      }
      out += ch;
      canStartRegex = true;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (templateBraceStack.length > 0) {
        const top = templateBraceStack[templateBraceStack.length - 1];
        if (top === 0) {
          templateBraceStack.pop();
          out += "}";
          i = scanTemplateText(i + 1);
          continue;
        }
        templateBraceStack[templateBraceStack.length - 1] = top - 1;
      }
      out += ch;
      canStartRegex = true;
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      out += word;
      canStartRegex = REGEX_PRECEDING_KEYWORDS.has(word);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(source[j])) j += 1;
      out += source.slice(i, j);
      canStartRegex = false;
      i = j;
      continue;
    }
    if (!/\s/.test(ch)) {
      if ((ch === "+" && next === "+") || (ch === "-" && next === "-")) {
        out += ch + next;
        i += 2;
        continue;
      }
      canStartRegex = REGEX_PRECEDING_CHARS.has(ch);
    }
    out += ch;
    i += 1;
  }
  return out;
}

function stripShellComments(source) {
  return source
    .split(/\r?\n/)
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\" && quote === '"' && i + 1 < line.length) {
            i += 1;
            continue;
          }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

function stripPs1Comments(source) {
  // PowerShell uses backtick `` ` `` (NOT backslash `\`) to escape quotes inside double-quoted strings,
  // `""` / `''` for doubled quotes, `@"..."@` / `@'...'@` here-strings, `<# ... #>` block comments, and `#` line comments.
  let out = "";
  const n = source.length;
  let i = 0;
  let quote = null;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === "`" && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    // PowerShell here-strings: @"<newline>...<newline>"@ (expandable) and @'<newline>...<newline>'@ (verbatim)
    if (ch === "@" && (next === '"' || next === "'")) {
      let nlIdx = i + 2;
      while (nlIdx < n && (source[nlIdx] === " " || source[nlIdx] === "\t")) nlIdx += 1;
      if (nlIdx < n && (source[nlIdx] === "\n" || source[nlIdx] === "\r")) {
        const hQuote = next;
        const isVerbatim = hQuote === "'";
        const lineStart = source[nlIdx] === "\r" && source[nlIdx + 1] === "\n" ? nlIdx + 2 : nlIdx + 1;
        out += source.slice(i, lineStart);
        i = lineStart;
        while (i < n) {
          // Closing delimiter MUST appear at column 0 (`"@` or `'@`)
          if (source[i] === hQuote && source[i + 1] === "@") {
            out += source.slice(i, i + 2);
            i += 2;
            break;
          }
          // Consume entire line
          while (i < n && source[i] !== "\n") {
            const c = source[i];
            out += isVerbatim && c !== "\r" ? "_" : c;
            i += 1;
          }
          if (i < n && source[i] === "\n") {
            out += "\n";
            i += 1;
          }
        }
        continue;
      }
    }
    if (ch === "<" && next === "#") {
      i += 2;
      while (i < n && !(source[i] === "#" && source[i + 1] === ">")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "#") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function stripCommentsForExt(source, ext) {
  const lower = String(ext || "").toLowerCase();
  if (lower === ".sh" || lower === ".bash") return stripShellComments(source);
  if (lower === ".ps1" || lower === ".psm1") return stripPs1Comments(source);
  if (lower === ".inline") return stripJsComments(source, { maskStrings: false });
  return stripJsComments(source);
}

function langGroupForExt(ext) {
  const lower = String(ext || "").toLowerCase();
  if (lower === ".sh" || lower === ".bash") return "sh";
  if (lower === ".ps1" || lower === ".psm1") return "ps1";
  if (lower === ".inline") return "all";
  return "js";
}

function findMatchingDelimiter(code, startIdx, openCh, closeCh) {
  let depth = 0;
  let quote = null;
  let escapedQuote = null;
  for (let i = startIdx; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (escapedQuote) {
      if (ch === "\\" && next === "\\") {
        i += 1;
        continue;
      }
      if (ch === "\\" && next === escapedQuote) {
        escapedQuote = null;
        i += 1;
        continue;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\" && i + 1 < code.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && (next === '"' || next === "'")) {
      escapedQuote = next;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractExpressionUntilTerminator(code, startIdx) {
  let i = startIdx;
  while (i < code.length && (code[i] === " " || code[i] === "\t" || code[i] === "\r" || code[i] === "\n")) {
    i += 1;
  }
  const begin = i;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = null;
  let escapedQuote = null;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (escapedQuote) {
      // Shell-escaped JSON string literal: \"...\" or \'...\'
      if (ch === "\\" && next === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\\" && next === escapedQuote) {
        escapedQuote = null;
        i += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r") break;
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === "\\" && i + 1 < code.length) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && (next === '"' || next === "'")) {
      escapedQuote = next;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      if (parenDepth === 0) break;
      parenDepth -= 1;
    } else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") {
      if (bracketDepth === 0) break;
      bracketDepth -= 1;
    } else if (ch === "{") braceDepth += 1;
    else if (ch === "}") {
      if (braceDepth === 0) break;
      braceDepth -= 1;
    } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (ch === "," || ch === ";") {
        break;
      }
      if (ch === "\n" || ch === "\r") {
        // Allow multiline expression continuation (e.g. `"a"\n + Date.now()` or `"a" +\r\n Date.now()`)
        let prevIdx = i - 1;
        while (
          prevIdx >= begin &&
          (code[prevIdx] === " " || code[prevIdx] === "\t" || code[prevIdx] === "\r" || code[prevIdx] === "\n")
        ) {
          prevIdx -= 1;
        }
        const prevChar = prevIdx >= begin ? code[prevIdx] : "";
        let nextIdx = i + 1;
        while (nextIdx < code.length && (code[nextIdx] === " " || code[nextIdx] === "\t" || code[nextIdx] === "\r" || code[nextIdx] === "\n")) {
          nextIdx += 1;
        }
        const nextChar = nextIdx < code.length ? code[nextIdx] : "";
        const nextTwo = nextIdx + 1 < code.length ? code.slice(nextIdx, nextIdx + 2) : "";
        const continuesPrev = prevChar === "+" || prevChar === "?" || prevChar === ":" || prevChar === "." || prevChar === "|" || prevChar === "&";
        const continuesNext =
          nextChar === "+" ||
          nextChar === "?" ||
          nextChar === ":" ||
          nextChar === "." ||
          nextTwo === "||" ||
          nextTwo === "&&" ||
          nextTwo === "??";
        if (!continuesPrev && !continuesNext) {
          break;
        }
      }
    }
    i += 1;
  }

  return { expr: code.slice(begin, i).trim(), endIdx: i };
}

function buildLocalSymbolTable(code, langGroup) {
  const table = new Map();
  const addDef = (name, snippet) => {
    if (!name || JS_KEYWORDS.has(name)) return;
    if (!table.has(name)) table.set(name, []);
    table.get(name).push(snippet);
  };

  if (langGroup === "sh" || langGroup === "all") {
    const shAssign = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm;
    let m;
    while ((m = shAssign.exec(code)) !== null) {
      addDef(m[1], m[2].trim());
    }
  }

  if (langGroup === "ps1" || langGroup === "all") {
    const psAssign = /\$([A-Za-z_][A-Za-z0-9_]*)\s*\+?=\s*([^\r\n;]+)/g;
    let m;
    while ((m = psAssign.exec(code)) !== null) {
      addDef(m[1], m[2].trim());
    }
  }

  if (langGroup === "js" || langGroup === "all") {
    // Variable declarations & assignments
    const varDecl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
    let m;
    while ((m = varDecl.exec(code)) !== null) {
      const { expr } = extractExpressionUntilTerminator(code, m.index + m[0].length);
      if (expr) addDef(m[1], expr);
    }

    // Reassignments & string appends (foo = ..., foo += ...)
    const reAssign = /(?:^|[;\n{}\s])([A-Za-z_$][\w$]*)\s*\+?=(?!=)/g;
    while ((m = reAssign.exec(code)) !== null) {
      const { expr } = extractExpressionUntilTerminator(code, m.index + m[0].length);
      if (expr) addDef(m[1], expr);
    }

    // Array pushes (lines.push(...))
    const pushCall = /\b([A-Za-z_$][\w$]*)\s*\.\s*push\s*\(/g;
    while ((m = pushCall.exec(code)) !== null) {
      const closeIdx = findMatchingDelimiter(code, m.index + m[0].length - 1, "(", ")");
      if (closeIdx !== -1) {
        addDef(m[1], code.slice(m.index + m[0].length, closeIdx).trim());
      }
    }

    // Function declarations — balance parens (handles default params with calls like `fn(ts = Date.now())`)
    // and scope default parameter taint ONLY to this function's own returned values (never polluting global symbols).
    const fnDecl = /\bfunction\*?\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fnDecl.exec(code)) !== null) {
      const parenStart = m.index + m[0].length - 1;
      const parenEnd = findMatchingDelimiter(code, parenStart, "(", ")");
      if (parenEnd === -1) continue;
      const paramStr = code.slice(parenStart + 1, parenEnd);
      const localDefaults = new Map();
      const defParamRe = /\b([A-Za-z_$][\w$]*)\s*=(?!=)/g;
      let pm;
      while ((pm = defParamRe.exec(paramStr)) !== null) {
        const { expr } = extractExpressionUntilTerminator(paramStr, pm.index + pm[0].length);
        if (expr) localDefaults.set(pm[1], expr);
      }
      let braceStart = parenEnd + 1;
      while (braceStart < code.length && /\s/.test(code[braceStart])) braceStart += 1;
      if (code[braceStart] !== "{") continue;
      const braceEnd = findMatchingDelimiter(code, braceStart, "{", "}");
      if (braceEnd !== -1) {
        const body = code.slice(braceStart + 1, braceEnd);
        const bodyVars = new Map();
        if (localDefaults.size > 0) {
          const bvRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
          let bm;
          while ((bm = bvRe.exec(body)) !== null) {
            const { expr } = extractExpressionUntilTerminator(body, bm.index + bm[0].length);
            if (expr) {
              if (!bodyVars.has(bm[1])) bodyVars.set(bm[1], []);
              bodyVars.get(bm[1]).push(expr);
            }
          }
        }
        const retRe = /\breturn\b/g;
        let rm;
        while ((rm = retRe.exec(body)) !== null) {
          const { expr } = extractExpressionUntilTerminator(body, rm.index + rm[0].length);
          if (expr) {
            addDef(m[1], expr);
            if (localDefaults.size > 0) {
              const seen = new Set();
              const queue = [...extractReferencedIdentifiers(expr, "js")];
              let hops = 0;
              while (queue.length > 0 && hops < 32) {
                const id = queue.shift();
                if (seen.has(id)) continue;
                seen.add(id);
                hops += 1;
                if (localDefaults.has(id)) {
                  addDef(m[1], localDefaults.get(id));
                } else if (bodyVars.has(id)) {
                  for (const rhs of bodyVars.get(id)) {
                    for (const subId of extractReferencedIdentifiers(rhs, "js")) {
                      if (!seen.has(subId)) queue.push(subId);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return table;
}

function matchVolatilePatterns(snippet, langGroup) {
  const hits = [];
  for (const p of VOLATILE_PATTERNS) {
    if (langGroup !== "all" && p.langs !== langGroup) continue;
    if (p.regex.test(snippet)) {
      hits.push(p.name);
    }
  }
  return hits;
}

function extractReferencedIdentifiers(snippet, langGroup) {
  const ids = new Set();
  if (langGroup === "sh" || langGroup === "all") {
    const shVar = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
    let m;
    while ((m = shVar.exec(snippet)) !== null) {
      ids.add(m[1]);
    }
  }
  if (langGroup === "ps1" || langGroup === "all") {
    const psVar = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = psVar.exec(snippet)) !== null) {
      ids.add(m[1]);
    }
  }
  if (langGroup === "js" || langGroup === "all") {
    const jsId = /\b([A-Za-z_$][\w$]*)\b/g;
    let m;
    while ((m = jsId.exec(snippet)) !== null) {
      const id = m[1];
      if (!JS_KEYWORDS.has(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Statically inspect a hook script (JS/MJS/TS/SH/PS1 or inline command) for:
 *  - non-empty `systemMessage` writes (cache prefix mutation risk on mid-session hooks)
 *  - Antigravity UI-only pattern (`systemMessage: ""` + `user_markdown` -> SAFE!)
 *  - dynamic timestamp / UUID / random injection flowing into `systemMessage`
 */
export function inspectHookSource(source, ext = ".mjs") {
  const stripped = stripCommentsForExt(String(source || ""), ext);
  const langGroup = langGroupForExt(ext);
  const hasUserMarkdown = /\buser_markdown\b/.test(stripped);

  let hasEmptySystemMessage = false;
  const nonEmptyExprs = [];

  // 1. Key-value & assignment writes to systemMessage (including JSON inside shell/PS1 strings)
  const writeRe = /(?:\\?["']systemMessage\\?["']|\bsystemMessage\b)\s*([:=])(?!=)/g;
  let m;
  while ((m = writeRe.exec(stripped)) !== null) {
    let idx = m.index + m[0].length;
    while (idx < stripped.length && /\s/.test(stripped[idx])) idx += 1;
    if (idx >= stripped.length) continue;

    // Outer Antigravity wrapper object: `systemMessage: { systemMessage: ..., metadata: ... }`
    if (stripped[idx] === "{") {
      const closeBrace = findMatchingDelimiter(stripped, idx, "{", "}");
      if (closeBrace !== -1) {
        const inner = stripped.slice(idx + 1, closeBrace);
        if (/\bsystemMessage\b/.test(inner)) {
          // Inner `systemMessage` property will be analyzed on subsequent iterations
          continue;
        }
        if (inner.trim()) {
          nonEmptyExprs.push(inner.trim());
        }
        continue;
      }
    }

    const { expr } = extractExpressionUntilTerminator(stripped, idx);
    if (!expr) continue;

    // Empty string literals (JS/JSON/escaped shell JSON: "", '', ``, \"\", \'\')
    if (/^(?:""|''|``|\\"\\"|\\'\\')$/.test(expr)) {
      hasEmptySystemMessage = true;
      continue;
    }

    // Nullish/falsy values or TS type annotations (`systemMessage: string`)
    if (/^(?:null|undefined|false|string|number|boolean|any|unknown|never|object)$/.test(expr)) {
      continue;
    }

    // Special case for shell JSON lines like `echo '{"systemMessage": "'"$(date)"'"}'` where
    // the closing `}` terminated `expr` early if outer quote wasn't opened inside `expr`
    nonEmptyExprs.push(expr);
  }

  // 2. JS/TS shorthand object property: `{ systemMessage }` (excluding destructuring `const { systemMessage } = ...`)
  if (langGroup === "js" || langGroup === "all") {
    const shortRe = /([{,]\s*)systemMessage(?=\s*[,}])/g;
    while ((m = shortRe.exec(stripped)) !== null) {
      // Find enclosing `{` and check it isn't followed by `=` (destructuring)
      let openBrace = -1;
      for (let k = m.index; k >= 0; k--) {
        if (stripped[k] === "{") {
          openBrace = k;
          break;
        }
        if (stripped[k] === "}" || stripped[k] === ";") break;
      }
      if (openBrace !== -1) {
        const closeBrace = findMatchingDelimiter(stripped, openBrace, "{", "}");
        if (closeBrace !== -1) {
          const after = stripped.slice(closeBrace + 1).trimStart();
          if (after.startsWith("=") && !after.startsWith("==")) {
            continue; // destructuring assignment, not object literal write
          }
        }
      }
      nonEmptyExprs.push("systemMessage");
    }
  }

  // 3. Check whether an identifier assigned to `systemMessage` is purely an empty string literal
  const symbolTable = buildLocalSymbolTable(stripped, langGroup);
  const filteredNonEmptyExprs = [];
  for (const expr of nonEmptyExprs) {
    if (/^[A-Za-z_$][\w$]*$/.test(expr) && symbolTable.has(expr)) {
      const defs = symbolTable.get(expr);
      if (defs.length > 0 && defs.every((d) => /^(?:""|''|``)$/.test(d.trim()))) {
        hasEmptySystemMessage = true;
        continue;
      }
    }
    filteredNonEmptyExprs.push(expr);
  }

  const writesNonEmptySystemMessage = filteredNonEmptyExprs.length > 0;
  const uiOnlySafe = !writesNonEmptySystemMessage && hasEmptySystemMessage && hasUserMarkdown;

  // 4. Bounded 3-hop dataflow taint analysis from non-empty systemMessage expressions -> volatile patterns
  const matchedDynamic = new Set();
  if (writesNonEmptySystemMessage) {
    const queue = filteredNonEmptyExprs.map((text) => ({ text, depth: 0 }));
    const visitedIds = new Set();

    while (queue.length > 0) {
      const { text, depth } = queue.shift();
      for (const hit of matchVolatilePatterns(text, langGroup)) {
        matchedDynamic.add(hit);
      }
      if (depth >= 3) continue;
      for (const id of extractReferencedIdentifiers(text, langGroup)) {
        if (visitedIds.has(id)) continue;
        visitedIds.add(id);
        const defs = symbolTable.get(id);
        if (!defs) continue;
        for (const defSnippet of defs) {
          queue.push({ text: defSnippet, depth: depth + 1 });
        }
      }
    }
  }

  const dynamicPatterns = [...matchedDynamic].sort(compareAscii);
  return {
    uiOnlySafe,
    hasEmptySystemMessage,
    hasUserMarkdown,
    writesNonEmptySystemMessage,
    injectsDynamicSystemMessage: dynamicPatterns.length > 0,
    dynamicPatterns
  };
}

function tokenizeCommand(command) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === "\\")) {
        cur += command[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".sh", ".bash", ".ps1", ".psm1"]);
const LAUNCHER_BINS = new Set([
  "node", "node.exe", "tsx", "ts-node", "bun", "bun.exe", "deno", "deno.exe",
  "bash", "sh", "zsh", "pwsh", "pwsh.exe", "powershell", "powershell.exe"
]);
const POWERSHELL_BINS = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe"]);
const VALUE_FLAGS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--conditions", "-C"
]);
const PS_VALUE_FLAGS = new Set([
  "-executionpolicy", "-ep", "-windowstyle", "-w",
  "-inputformat", "-outputformat", "-workingdirectory", "-wd"
]);
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

function resolveHookTarget(rawCommand, baseDir, workspaceDir) {
  const vars = {
    PLUGIN_ROOT: baseDir,
    WORKSPACE: workspaceDir,
    workspaceFolder: workspaceDir
  };
  const substituted = substituteVars(String(rawCommand || "").trim(), vars);
  const tokens = tokenizeCommand(substituted);
  if (tokens.length === 0) {
    return { kind: "empty", scriptPath: null, inlineCode: null };
  }

  const binLower = path.basename(tokens[0]).toLowerCase();
  const isLauncher = LAUNCHER_BINS.has(binLower);
  const isPowerShell = POWERSHELL_BINS.has(binLower);

  // Check if token[0] itself is a script file
  if (!isLauncher && SCRIPT_EXTENSIONS.has(path.extname(tokens[0]).toLowerCase())) {
    const abs = path.isAbsolute(tokens[0]) ? path.resolve(tokens[0]) : path.resolve(baseDir, tokens[0]);
    return { kind: "script", scriptPath: abs, inlineCode: null };
  }

  let idx = 1;
  if (binLower === "deno" || binLower === "deno.exe") {
    if (tokens[1] === "run") idx = 2;
  }

  while (idx < tokens.length) {
    const tok = tokens[idx];
    const tokLower = tok.toLowerCase();
    if (isPowerShell) {
      if ((tokLower === "-command" || tokLower === "-c") && idx + 1 < tokens.length) {
        return { kind: "inline", scriptPath: null, inlineCode: tokens.slice(idx + 1).join(" ") };
      }
      if (tokLower === "-file" || tokLower === "-f") {
        if (idx + 1 < tokens.length) {
          const candidate = tokens[idx + 1];
          const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(baseDir, candidate);
          return { kind: "script", scriptPath: abs, inlineCode: null };
        }
        break;
      }
      if (PS_VALUE_FLAGS.has(tokLower)) {
        idx += 2;
        continue;
      }
    } else {
      if (INLINE_CODE_FLAGS.has(tok) && idx + 1 < tokens.length) {
        return { kind: "inline", scriptPath: null, inlineCode: tokens[idx + 1] };
      }
      if (VALUE_FLAGS.has(tok)) {
        idx += 2;
        continue;
      }
    }
    if (tok.startsWith("-")) {
      idx += 1;
      continue;
    }
    const ext = path.extname(tok).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(ext) || isLauncher) {
      const abs = path.isAbsolute(tok) ? path.resolve(tok) : path.resolve(baseDir, tok);
      if (SCRIPT_EXTENSIONS.has(ext) || isFile(abs)) {
        return { kind: "script", scriptPath: abs, inlineCode: null };
      }
    }
    break;
  }

  return { kind: "inline", scriptPath: null, inlineCode: substituted };
}

function parseHooksConfig(data) {
  const extracted = [];
  if (!data || typeof data !== "object") return extracted;

  const visitEventList = (groupName, eventName, list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const matcher = typeof item.matcher === "string" ? item.matcher.trim() : "";
      if (Array.isArray(item.hooks)) {
        for (const sub of item.hooks) {
          if (!sub || typeof sub !== "object") continue;
          const subMatcher = typeof sub.matcher === "string" && sub.matcher.trim() ? sub.matcher.trim() : matcher;
          if (typeof sub.command === "string" && sub.command.trim()) {
            extracted.push({
              group: groupName,
              event: eventName,
              matcher: subMatcher,
              command: sub.command.trim(),
              timeout: sub.timeout ?? null
            });
          }
        }
      } else if (typeof item.command === "string" && item.command.trim()) {
        extracted.push({
          group: groupName,
          event: eventName,
          matcher,
          command: item.command.trim(),
          timeout: item.timeout ?? null
        });
      }
    }
  };

  for (const key of Object.keys(data).sort(compareAscii)) {
    const val = data[key];
    if (KNOWN_HOOK_EVENTS.has(key) && Array.isArray(val)) {
      visitEventList("default", key, val);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const ev of Object.keys(val).sort(compareAscii)) {
        if (KNOWN_HOOK_EVENTS.has(ev) && Array.isArray(val[ev])) {
          visitEventList(key, ev, val[ev]);
        }
      }
    }
  }

  return extracted;
}

function auditHooksAndPlugins(configDir, workspaceDir, activePlugins, disabledPlugins, findings) {
  // 1. Plugin conflict & duplicate install detection
  const conflicts = [];
  const activeByName = new Map();
  for (const plugin of activePlugins) {
    const key = plugin.name.toLowerCase();
    if (!activeByName.has(key)) activeByName.set(key, []);
    activeByName.get(key).push(plugin);
  }

  // Duplicate install of same plugin across global & workspace
  for (const [name, list] of [...activeByName.entries()].sort((a, b) => compareAscii(a[0], b[0]))) {
    if (list.length > 1) {
      const scopes = list.map((p) => p.scope).join(" & ");
      conflicts.push({
        plugin: list[0].name,
        conflictsWith: list[1].scope,
        reason: `Plugin '${list[0].name}' is installed multiple times (${scopes}).`
      });
      findings.push({
        severity: "warn",
        code: "duplicate_plugin_install",
        category: "plugins",
        target: list[0].name,
        message: `Plugin '${list[0].name}' is active in multiple locations (${scopes}), duplicating rules, hooks, and MCP servers.`,
        recommendation: `Remove or disable one copy of '${list[0].name}' so only a single installation stays active.`
      });
    }
  }

  // Legacy plugins coexisting with agy-dart
  if (activeByName.has("agy-dart")) {
    for (const legacy of LEGACY_CONFLICTS_WITH_AGY_DART) {
      if (activeByName.has(legacy.plugin)) {
        conflicts.push({
          plugin: "agy-dart",
          conflictsWith: legacy.plugin,
          reason: legacy.reason
        });
        findings.push({
          severity: "warn",
          code: "plugin_conflict",
          category: "plugins",
          target: `agy-dart + ${legacy.plugin}`,
          message: `Conflicting legacy plugin '${legacy.plugin}' is active alongside 'agy-dart': ${legacy.reason}`,
          recommendation: `Disable or uninstall '${legacy.plugin}' (e.g., set plugins["${legacy.plugin}"].enabled = false in config.json or remove its folder) since agy-dart supersedes it.`
        });
      }
    }
  }

  // 2. Discover & scan hooks.json files
  const hookConfigs = [];
  const seenConfigs = new Set();
  const addHookConfig = (configPath, scope, baseDir) => {
    if (!isFile(configPath)) return;
    const key = normalizePathKey(configPath);
    if (seenConfigs.has(key)) return;
    seenConfigs.add(key);
    hookConfigs.push({ configPath: path.resolve(configPath), scope, baseDir: path.resolve(baseDir) });
  };

  addHookConfig(path.join(configDir, "hooks.json"), "global", configDir);
  for (const plugin of activePlugins) {
    addHookConfig(path.join(plugin.dir, "hooks.json"), plugin.scope, plugin.dir);
  }
  addHookConfig(path.join(workspaceDir, ".gemini", "hooks.json"), "workspace", workspaceDir);

  const entries = [];

  for (const cfg of hookConfigs) {
    const parsed = safeReadJson(cfg.configPath);
    if (!parsed.ok) {
      findings.push({
        severity: "info",
        code: "invalid_config_json",
        category: "hooks",
        target: cfg.configPath,
        message: `Failed to parse hooks config '${toPosixDisplay(cfg.configPath)}': ${parsed.error}`,
        recommendation: "Fix JSON syntax in this hooks.json file."
      });
      continue;
    }

    const parsedHooks = parseHooksConfig(parsed.data);
    for (const hook of parsedHooks) {
      const targetLabel = `${cfg.scope}:${hook.event} (${hook.group})`;

      // 2a. Missing matcher on PreToolUse / PostToolUse
      if (TOOL_MATCHER_EVENTS.has(hook.event)) {
        if (!hook.matcher) {
          findings.push({
            severity: "warn",
            code: "missing_hook_matcher",
            category: "hooks",
            target: targetLabel,
            message: `${hook.event} hook in '${cfg.scope}' has no \`matcher\`, spawning a subprocess on every tool call and adding per-turn latency.`,
            recommendation: `Add a narrow regex \`matcher\` (e.g., "run_command|read_file") so '${hook.command}' only runs for relevant tools.`
          });
        } else if (hook.matcher === "*" || hook.matcher === ".*") {
          findings.push({
            severity: "info",
            code: "wildcard_hook_matcher",
            category: "hooks",
            target: targetLabel,
            message: `${hook.event} hook in '${cfg.scope}' uses catch-all matcher '${hook.matcher}', triggering on every tool call.`,
            recommendation: "Narrow the `matcher` regex to only the specific tool names that require interception."
          });
        }
      }

      // 2b. Static inspection of local script (or inline command) for SessionStart & mid-session hooks
      const resolved = resolveHookTarget(hook.command, cfg.baseDir, workspaceDir);
      let inspection = {
        uiOnlySafe: false,
        hasEmptySystemMessage: false,
        hasUserMarkdown: false,
        writesNonEmptySystemMessage: false,
        injectsDynamicSystemMessage: false,
        dynamicPatterns: []
      };
      const shouldInspectSource = hook.event === "SessionStart" || MID_SESSION_EVENTS.has(hook.event);
      let status = shouldInspectSource ? "safe" : "not_inspected";
      let scriptPath = resolved.scriptPath;

      if (shouldInspectSource) {
        if (resolved.kind === "script") {
          if (scriptPath && isFile(scriptPath)) {
            try {
              const source = fs.readFileSync(scriptPath, "utf8");
              inspection = inspectHookSource(source, path.extname(scriptPath));
            } catch {
              status = "missing_script";
            }
          } else {
            status = "missing_script";
          }
        } else if (resolved.kind === "inline" && resolved.inlineCode) {
          inspection = inspectHookSource(resolved.inlineCode, ".inline");
          status = "inline_command";
        }
      }

      const isMidSession = MID_SESSION_EVENTS.has(hook.event);

      if (inspection.uiOnlySafe) {
        status = "ui_only_safe";
      }

      if (isMidSession && inspection.writesNonEmptySystemMessage) {
        status = "warn";
        findings.push({
          severity: "warn",
          code: "mid_session_system_message",
          category: "hooks",
          target: scriptPath ? `${cfg.scope}:${toPosixDisplay(scriptPath, cfg.baseDir)}` : targetLabel,
          message: `Mid-session ${hook.event} hook writes a non-empty \`systemMessage\`, which mutates conversation history / prompt prefix mid-session.`,
          recommendation: "For user-facing notices in Antigravity, use the zero-prefix-pollution UI-only pattern (`systemMessage: \"\"` + `metadata: { user_markdown: \"...\" }`), or move static instructions to SessionStart."
        });
      }

      if (shouldInspectSource && inspection.injectsDynamicSystemMessage) {
        status = "critical";
        const patList = inspection.dynamicPatterns.join(", ");
        findings.push({
          severity: "critical",
          code: "dynamic_system_message_injection",
          category: "hooks",
          target: scriptPath ? `${cfg.scope}:${toPosixDisplay(scriptPath, cfg.baseDir)}` : targetLabel,
          message: `${hook.event} hook injects dynamic timestamp/UUID value(s) (${patList}) into \`systemMessage\`, causing repeatable KV-cache prefix busts.`,
          recommendation: "Remove dynamic timestamps/UUIDs from `systemMessage` (keep internal timestamps in DB/logs only, or display dynamic notices strictly inside `metadata.user_markdown` with `systemMessage: \"\"`)."
        });
      }

      entries.push({
        scope: cfg.scope,
        configPath: cfg.configPath,
        group: hook.group,
        event: hook.event,
        matcher: hook.matcher,
        command: hook.command,
        scriptPath,
        status,
        uiOnlySafe: inspection.uiOnlySafe,
        writesNonEmptySystemMessage: inspection.writesNonEmptySystemMessage,
        injectsDynamicSystemMessage: inspection.injectsDynamicSystemMessage,
        dynamicPatterns: inspection.dynamicPatterns
      });
    }
  }

  return {
    pluginCount: activePlugins.length,
    activePlugins: activePlugins.map((p) => ({ name: p.name, dir: p.dir, scope: p.scope })),
    disabledPlugins: disabledPlugins.map((p) => ({ name: p.name, dir: p.dir, scope: p.scope })),
    conflicts,
    hookConfigCount: hookConfigs.length,
    hookCount: entries.length,
    entries
  };
}

/* ============================================================================
 * Check 4: Deterministic Health Score & Markdown Report
 * ========================================================================== */

function computeHealthScore(findings) {
  let criticalCount = 0;
  let warnCount = 0;
  let infoCount = 0;

  for (const f of findings) {
    if (f.severity === "critical") criticalCount += 1;
    else if (f.severity === "warn") warnCount += 1;
    else infoCount += 1;
  }

  const criticalPenalty = Math.min(PENALTY_CAPS.critical, criticalCount * PENALTY_WEIGHTS.critical);
  const warnPenalty = Math.min(PENALTY_CAPS.warn, warnCount * PENALTY_WEIGHTS.warn);
  const infoPenalty = Math.min(PENALTY_CAPS.info, infoCount * PENALTY_WEIGHTS.info);
  const score = Math.max(0, Math.min(100, 100 - criticalPenalty - warnPenalty - infoPenalty));

  let grade = "F";
  if (score >= 90) grade = "A";
  else if (score >= 80) grade = "B";
  else if (score >= 70) grade = "C";
  else if (score >= 60) grade = "D";

  return {
    score,
    grade,
    scoreBreakdown: {
      base: 100,
      criticalCount,
      warnCount,
      infoCount,
      criticalPenalty,
      warnPenalty,
      infoPenalty,
      caps: { ...PENALTY_CAPS }
    }
  };
}

function severityRank(sev) {
  if (sev === "critical") return 0;
  if (sev === "warn") return 1;
  return 2;
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    const cat = compareAscii(a.category, b.category);
    if (cat !== 0) return cat;
    const code = compareAscii(a.code, b.code);
    if (code !== 0) return code;
    return compareAscii(a.target, b.target);
  });
}

function mdCell(text) {
  return String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

export async function auditEnvironmentCache(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const configDir = path.resolve(options.configDir || path.join(getHomeDir(), ".gemini", "config"));
  const live = options.live !== undefined ? Boolean(options.live) : true;
  const rawTimeout = options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0 ? Math.round(Number(rawTimeout)) : DEFAULT_TIMEOUT_MS;

  const findings = [];
  const { activePlugins, disabledPlugins } = discoverPlugins(configDir, workspace);

  const prefix = auditTurn0Prefix(configDir, workspace, activePlugins, findings);
  const mcp = await auditMcpServers(configDir, workspace, activePlugins, { live, timeoutMs }, findings);
  const hooks = auditHooksAndPlugins(configDir, workspace, activePlugins, disabledPlugins, findings);

  const sortedFindings = sortFindings(findings);
  const { score, grade, scoreBreakdown } = computeHealthScore(sortedFindings);

  const totals = {
    rulesAndSkillsTokens: prefix.totalTokens,
    mcpSchemaTokens: mcp.totalSchemaTokens,
    estimatedTurn0Tokens: prefix.totalTokens + mcp.totalSchemaTokens
  };

  return stableSortObject({
    schemaVersion: "1.2",
    options: {
      workspace,
      configDir,
      live,
      timeoutMs
    },
    score,
    grade,
    scoreBreakdown,
    totals,
    prefix,
    mcp,
    hooks,
    findings: sortedFindings
  });
}

export function formatCacheAuditMarkdown(report) {
  const sb = report.scoreBreakdown;
  const lines = [
    "# Prompt Cache Environment Audit",
    "",
    `- **Health Score**: **${report.score}/100 (Grade ${report.grade})**`,
    `- **Findings**: ${sb.criticalCount} critical, ${sb.warnCount} warn, ${sb.infoCount} info`,
    `- **Estimated Turn-0 Prefix**: **~${report.totals.estimatedTurn0Tokens.toLocaleString("en-US")} tokens** (rules & skills frontmatter: ${report.totals.rulesAndSkillsTokens.toLocaleString("en-US")} tok + MCP schemas: ${report.totals.mcpSchemaTokens.toLocaleString("en-US")} tok)`,
    `- **Scope**: workspace=\`${toPosixDisplay(report.options.workspace)}\` · configDir=\`${toPosixDisplay(report.options.configDir)}\` · liveMCP=${report.options.live ? "on" : "off"}`,
    ""
  ];

  // Section 1: Turn-0 Prefix Breakdown
  lines.push("## 1. Turn-0 Rules & Skills Frontmatter Prefix", "");
  if (report.prefix.items.length === 0) {
    lines.push("_No always-loaded rules or skill frontmatter files discovered._", "");
  } else {
    const MAX_PREFIX_ROWS = 25;
    const shown = report.prefix.items.slice(0, MAX_PREFIX_ROWS);
    const hidden = report.prefix.items.slice(MAX_PREFIX_ROWS);
    lines.push("| Kind | Scope | File | Bytes | CJK Chars | Est. Tokens | SHA-256 |");
    lines.push("| :--- | :--- | :--- | ---: | ---: | ---: | :--- |");
    for (const item of shown) {
      const kindLabel = item.kind === "rule" ? "rule" : "skill (fm)";
      lines.push(
        `| ${kindLabel} | \`${mdCell(item.scope)}\` | \`${mdCell(item.name)}\` | ${item.bytes} | ${item.cjkChars} | ${item.tokens} | \`${item.sha256.slice(0, 12)}\` |`
      );
    }
    if (hidden.length > 0) {
      const restBytes = hidden.reduce((acc, i) => acc + i.bytes, 0);
      const restCjk = hidden.reduce((acc, i) => acc + i.cjkChars, 0);
      const restTokens = hidden.reduce((acc, i) => acc + i.tokens, 0);
      lines.push(
        `| _..._ | _+${hidden.length} more_ | _(see \`--json\` for full list)_ | ${restBytes} | ${restCjk} | ${restTokens} | — |`
      );
    }
    lines.push(
      `| **TOTAL** | **${report.prefix.ruleCount} rules, ${report.prefix.skillCount} skills** | **Always-loaded Turn-0** | **${report.prefix.totalBytes}** | — | **${report.prefix.totalTokens}** | budget <= ${report.prefix.thresholds.totalPrefixWarnTokens} tok |`
    );
    lines.push("");
  }

  // Section 2: MCP Server Determinism & Schema Budget
  lines.push("## 2. MCP Server Determinism & Schema Bloat", "");
  if (report.mcp.servers.length === 0) {
    lines.push("_No MCP servers discovered._", "");
  } else {
    lines.push("| Server | Transport | Status | Tools | Est. Tokens | Deterministic | Canonical | Raw SHA-256 |");
    lines.push("| :--- | :--- | :--- | ---: | ---: | :---: | :---: | :--- |");
    for (const s of report.mcp.servers) {
      const det = s.deterministic === true ? "PASS" : s.deterministic === false ? "FAIL" : "—";
      const canon = s.canonical === true ? "YES" : s.canonical === false ? "NO" : "—";
      const hash = s.rawSha256 ? `\`${s.rawSha256.slice(0, 12)}\`` : "—";
      lines.push(
        `| \`${mdCell(s.id)}\` | ${mdCell(s.transport)} | ${mdCell(s.status)} | ${s.toolCount} | ${s.tokens} | ${det} | ${canon} | ${hash} |`
      );
    }
    lines.push("");
  }

  // Section 3: Hooks & Plugin Hygiene
  lines.push("## 3. Hooks & Plugin Hygiene", "");
  const activeNames = report.hooks.activePlugins.map((p) => p.name);
  lines.push(
    `- **Active Plugins (${report.hooks.pluginCount})**: ${activeNames.length > 0 ? activeNames.map((n) => `\`${n}\``).join(", ") : "_none_"}`
  );
  if (report.hooks.disabledPlugins.length > 0) {
    lines.push(
      `- **Disabled Plugins (${report.hooks.disabledPlugins.length})**: ${report.hooks.disabledPlugins.map((p) => `\`${p.name}\``).join(", ")}`
    );
  }
  lines.push("");

  if (report.hooks.entries.length > 0) {
    lines.push("| Scope | Event | Matcher | Status | Command |");
    lines.push("| :--- | :--- | :--- | :--- | :--- |");
    for (const h of report.hooks.entries) {
      const matcherDisp = h.matcher ? `\`${mdCell(h.matcher)}\`` : "—";
      const statusDisp = h.uiOnlySafe ? "ui_only_safe (0 tok)" : h.status;
      lines.push(
        `| \`${mdCell(h.scope)}\` | ${mdCell(h.event)} | ${matcherDisp} | ${mdCell(statusDisp)} | \`${mdCell(h.command)}\` |`
      );
    }
    lines.push("");
  }

  // Section 4: Findings & Actionable Fixes
  lines.push("## 4. Findings & Actionable Fixes", "");
  if (report.findings.length === 0) {
    lines.push("All prompt-cache hygiene checks passed with zero findings.");
  } else {
    for (const f of report.findings) {
      const tag = f.severity.toUpperCase();
      lines.push(`- **[${tag}]** \`${f.code}\` (\`${mdCell(f.target)}\`): ${f.message}`);
      lines.push(`  - **Fix**: ${f.recommendation}`);
    }
  }

  return lines.join("\n");
}

export function parseCliArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    workspace: process.cwd(),
    configDir: path.join(getHomeDir(), ".gemini", "config"),
    live: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--live") {
      opts.live = true;
    } else if (a === "--no-live") {
      opts.live = false;
    } else if (a === "--workspace" || a.startsWith("--workspace=")) {
      const next = a.includes("=") ? a.slice("--workspace=".length) : args[++i];
      if (!next) throw new Error("Missing path after --workspace");
      opts.workspace = path.resolve(next);
    } else if (a === "--config-dir" || a.startsWith("--config-dir=")) {
      const next = a.includes("=") ? a.slice("--config-dir=".length) : args[++i];
      if (!next) throw new Error("Missing path after --config-dir");
      opts.configDir = path.resolve(next);
    } else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const next = a.includes("=") ? a.slice("--timeout=".length) : args[++i];
      const parsed = Number(next);
      if (!next || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout value '${next}'. Expected positive milliseconds.`);
      }
      opts.timeoutMs = Math.round(parsed);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  return opts;
}

function printHelp() {
  process.stdout.write(`agy-dart Environment-Wide Prompt Cache Auditor

Usage:
  node scripts/cache-audit.mjs [options]

Options:
  --workspace <dir>    Workspace root to audit (default: current working directory)
  --config-dir <dir>   Antigravity config root (default: ~/.gemini/config)
  --live               Probe configured stdio MCP servers live twice (default)
  --no-live            Skip live MCP server probing
  --timeout <ms>       Per-server MCP probe timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --json               Output machine-readable JSON report
  -h, --help           Show this help
`);
}

async function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  const report = await auditEnvironmentCache(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatCacheAuditMarkdown(report) + "\n");
  }
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`cache:audit error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
