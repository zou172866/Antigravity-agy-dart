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
import {
  auditSafetyMonitor,
  formatSafetyAuditMarkdown
} from "../context/lib/safety-monitor-audit.js";
import { sha256Hex, stableSortObject, stableStringify } from "../context/lib/stable-json.js";

const DEFAULT_TIMEOUT_MS = 4000;
const SINGLE_RULE_WARN_TOKENS = 1500;
const SINGLE_RULE_TRUNCATE_BYTES = 24000;
const RULES_AGGREGATE_BUDGET_TOKENS = 20000;
const TOTAL_PREFIX_WARN_TOKENS = 6000;
const SINGLE_SKILL_FRONTMATTER_WARN_TOKENS = 250;
const SINGLE_SKILL_BODY_WARN_TOKENS = 3000;
const TOTAL_SKILLS_FRONTMATTER_WARN_TOKENS = 2000;
const MCP_SCHEMA_WARN_TOKENS = 3000;
const VALID_RULE_TRIGGERS = new Set(["always_on", "model_decision", "glob", "manual"]);
const SKILL_AUX_DIR_NAMES = Object.freeze(["examples", "references", "resources", "scripts"]);

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
  "PostInvocation",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "PreCompact",
  "Notification"
]);

const MID_SESSION_EVENTS = new Set(["PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse"]);
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

function canonicalPathKey(p) {
  const resolved = path.resolve(p);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {}
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
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

const SKILL_FRONTMATTER_REQUIRED_ANY_KEYS = new Set(["name", "description"]);
const UNQUOTED_YAML_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const BLOCK_SCALAR_HEADER_RE = /^[|>](?:[-+]|[1-9]|[-+][1-9]|[1-9][-+])?(?:[ \t]+#.*)?$/;
const FORBIDDEN_PLAIN_SCALAR_START_RE = /^[\]\},@`]/;

function scanQuotedScalar(text, startIdx, quote) {
  let i = startIdx;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 >= text.length) {
          return { closed: false, endIdx: text.length };
        }
        i += 2;
        continue;
      }
      if (ch === '"') {
        return { closed: true, endIdx: i + 1 };
      }
    } else if (ch === "'") {
      if (text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return { closed: true, endIdx: i + 1 };
    }
    i += 1;
  }
  return { closed: false, endIdx: text.length };
}

function isEmptyOrComment(tail) {
  return /^[ \t]*(?:#.*)?$/.test(tail);
}

function stripPlainInlineComment(val) {
  const idx = val.search(/[ \t]+#/);
  return idx === -1 ? val.trimEnd() : val.slice(0, idx).trimEnd();
}

function isValidPlainScalarText(rawText) {
  const cleaned = stripPlainInlineComment(rawText);
  if (!cleaned) return true;
  if (FORBIDDEN_PLAIN_SCALAR_START_RE.test(cleaned)) return false;
  if (/:(?:[ \t]|$)/.test(cleaned)) return false;
  return true;
}

function scanFlowCollection(text, startIdx, state) {
  let i = startIdx;
  while (i < text.length) {
    const ch = text[i];
    if (state.quote) {
      const res = scanQuotedScalar(text, i, state.quote);
      if (!res.closed) return { ok: true, closed: false };
      state.quote = null;
      const top = state.stack[state.stack.length - 1];
      if (top) top.hasContent = true;
      i = res.endIdx;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return { ok: true, closed: false };
    }
    if (ch === '"' || ch === "'") {
      state.quote = ch;
      i += 1;
      continue;
    }
    if (ch === "[" || ch === "{") {
      const parent = state.stack[state.stack.length - 1];
      if (parent) parent.hasContent = true;
      state.stack.push({ kind: ch, hasColon: false, hasContent: false });
      i += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      const top = state.stack[state.stack.length - 1];
      const expected = ch === "]" ? "[" : "{";
      if (!top || top.kind !== expected) return { ok: false, closed: false };
      if (top.kind === "{" && top.hasContent && !top.hasColon) return { ok: false, closed: false };
      state.stack.pop();
      i += 1;
      if (state.stack.length === 0) {
        return { ok: isEmptyOrComment(text.slice(i)), closed: true };
      }
      continue;
    }
    const top = state.stack[state.stack.length - 1];
    if (!top) return { ok: false, closed: false };
    if (ch === "," && top.kind === "{") {
      if (top.hasContent && !top.hasColon) return { ok: false, closed: false };
      top.hasColon = false;
      top.hasContent = false;
      i += 1;
      continue;
    }
    if (ch === ":" && top.kind === "{") {
      const next = text[i + 1];
      const prev = i > 0 ? text[i - 1] : "";
      if (
        next === undefined ||
        next === " " ||
        next === "\t" ||
        next === "," ||
        next === "}" ||
        prev === '"' ||
        prev === "'"
      ) {
        top.hasColon = true;
      }
      top.hasContent = true;
      i += 1;
      continue;
    }
    if (ch !== " " && ch !== "\t") {
      top.hasContent = true;
    }
    i += 1;
  }
  return { ok: true, closed: false };
}

function parseMappingEntry(trimmed) {
  if (!trimmed) return null;
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const res = scanQuotedScalar(trimmed, 1, trimmed[0]);
    if (!res.closed) return null;
    const key = trimmed.slice(1, res.endIdx - 1);
    const afterQuote = trimmed.slice(res.endIdx);
    const colonMatch = afterQuote.match(/^[ \t]*:(?:[ \t]+([\s\S]*)|[ \t]*)$/);
    if (!colonMatch || !key) return null;
    return { key, rawVal: (colonMatch[1] || "").trimStart() };
  }
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(trimmed)) return null;
  let colonIdx = -1;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "#" && i > 0 && (trimmed[i - 1] === " " || trimmed[i - 1] === "\t")) break;
    if (ch === ":") {
      const next = trimmed[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        colonIdx = i;
        break;
      }
    }
  }
  if (colonIdx <= 0) return null;
  const key = trimmed.slice(0, colonIdx).trimEnd();
  if (!UNQUOTED_YAML_KEY_RE.test(key)) return null;
  const rawVal = trimmed.slice(colonIdx + 1).trimStart();
  return { key, rawVal };
}

function validateYamlFrontmatter(inner, { mode = "skill" } = {}) {
  const lines = String(inner || "").split(/\r?\n/);
  const topLevelKeys = new Set();
  const containerStack = [{ kind: "mapping", indent: 0, keys: topLevelKeys }];
  let blockScalar = null;
  let quotedScalar = null;
  let flowState = null;
  let activePlainScalar = null;

  const parseValueExpr = (rawVal, ownerIndent, pushExpectValue) => {
    if (!rawVal || rawVal.startsWith("#")) {
      if (pushExpectValue) {
        containerStack.push({ kind: "expect_value", keyIndent: ownerIndent });
      }
      return true;
    }
    if (rawVal[0] === "|" || rawVal[0] === ">") {
      if (!BLOCK_SCALAR_HEADER_RE.test(rawVal)) return false;
      const digitMatch = rawVal.match(/^[|>][+-]?([1-9])/);
      const explicitIndent = digitMatch ? ownerIndent + Number(digitMatch[1]) : null;
      blockScalar = { keyIndent: ownerIndent, explicitIndent, contentIndent: null };
      return true;
    }
    if (rawVal[0] === '"' || rawVal[0] === "'") {
      const res = scanQuotedScalar(rawVal, 1, rawVal[0]);
      if (res.closed) {
        return isEmptyOrComment(rawVal.slice(res.endIdx));
      }
      quotedScalar = { quote: rawVal[0], keyIndent: ownerIndent };
      return true;
    }
    if (rawVal[0] === "[" || rawVal[0] === "{") {
      const st = { stack: [], quote: null, keyIndent: ownerIndent };
      const res = scanFlowCollection(rawVal, 0, st);
      if (!res.ok) return false;
      if (!res.closed) flowState = st;
      return true;
    }
    if (!isValidPlainScalarText(rawVal)) return false;
    activePlainScalar = { keyIndent: ownerIndent };
    return true;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];

    if (blockScalar) {
      if (/^[ \t]*$/.test(line)) continue;
      let leadingSpaces = 0;
      while (leadingSpaces < line.length && line[leadingSpaces] === " ") leadingSpaces += 1;
      if (leadingSpaces > blockScalar.keyIndent) {
        if (blockScalar.explicitIndent !== null) {
          if (leadingSpaces < blockScalar.explicitIndent) return { ok: false, topLevelKeys };
        } else if (blockScalar.contentIndent === null) {
          blockScalar.contentIndent = leadingSpaces;
        } else if (leadingSpaces < blockScalar.contentIndent) {
          return { ok: false, topLevelKeys };
        }
        continue;
      }
      blockScalar = null;
    }

    if (/^[ \t]*$/.test(line)) continue;
    if (/^ *\t/.test(line)) return { ok: false, topLevelKeys };

    let indent = 0;
    while (indent < line.length && line[indent] === " ") indent += 1;
    const trimmed = line.slice(indent);

    if (quotedScalar) {
      if (indent <= quotedScalar.keyIndent) return { ok: false, topLevelKeys };
      const res = scanQuotedScalar(trimmed, 0, quotedScalar.quote);
      if (res.closed) {
        if (!isEmptyOrComment(trimmed.slice(res.endIdx))) return { ok: false, topLevelKeys };
        quotedScalar = null;
      }
      continue;
    }

    if (flowState) {
      if (indent <= flowState.keyIndent) return { ok: false, topLevelKeys };
      const res = scanFlowCollection(trimmed, 0, flowState);
      if (!res.ok) return { ok: false, topLevelKeys };
      if (res.closed) flowState = null;
      continue;
    }

    if (trimmed.startsWith("#")) continue;

    if (activePlainScalar) {
      if (indent > activePlainScalar.keyIndent) {
        if (!isValidPlainScalarText(trimmed)) return { ok: false, topLevelKeys };
        continue;
      }
      activePlainScalar = null;
    }

    const isSeqItem = trimmed === "-" || /^-[ \t]/.test(trimmed);

    while (containerStack.length > 1) {
      const top = containerStack[containerStack.length - 1];
      if (top.kind === "expect_value") {
        if (indent > top.keyIndent || (indent === top.keyIndent && isSeqItem)) break;
        containerStack.pop();
        continue;
      }
      if (top.kind === "sequence") {
        if (indent > top.indent || (indent === top.indent && isSeqItem)) break;
        containerStack.pop();
        continue;
      }
      if (top.kind === "mapping") {
        if (indent >= top.indent) break;
        containerStack.pop();
        continue;
      }
      break;
    }

    const top = containerStack[containerStack.length - 1];

    if (isSeqItem) {
      if (top.kind === "expect_value") {
        if (indent < top.keyIndent) return { ok: false, topLevelKeys };
        containerStack.pop();
        containerStack.push({ kind: "sequence", indent });
      } else if (top.kind !== "sequence" || indent !== top.indent) {
        return { ok: false, topLevelKeys };
      }

      const afterDash = trimmed.slice(1);
      const wsMatch = afterDash.match(/^[ \t]*/);
      const itemRest = afterDash.slice(wsMatch[0].length);
      if (!itemRest || itemRest.startsWith("#")) {
        containerStack.push({ kind: "expect_value", keyIndent: indent });
        continue;
      }
      const itemIndent = indent + 1 + wsMatch[0].length;
      const itemMap = parseMappingEntry(itemRest);
      if (itemMap) {
        const nestedKeys = new Set([itemMap.key]);
        containerStack.push({ kind: "mapping", indent: itemIndent, keys: nestedKeys });
        if (!parseValueExpr(itemMap.rawVal, itemIndent, true)) return { ok: false, topLevelKeys };
      } else {
        if (!parseValueExpr(itemRest, indent, false)) return { ok: false, topLevelKeys };
      }
      continue;
    }

    const entry = parseMappingEntry(trimmed);
    if (entry) {
      if (top.kind === "expect_value") {
        if (indent <= top.keyIndent) return { ok: false, topLevelKeys };
        containerStack.pop();
        const nestedKeys = new Set([entry.key]);
        containerStack.push({ kind: "mapping", indent, keys: nestedKeys });
      } else if (top.kind === "mapping" && indent === top.indent) {
        if (top.keys.has(entry.key)) return { ok: false, topLevelKeys };
        top.keys.add(entry.key);
      } else {
        return { ok: false, topLevelKeys };
      }
      if (!parseValueExpr(entry.rawVal, indent, true)) return { ok: false, topLevelKeys };
      continue;
    }

    if (top.kind === "expect_value" && indent > top.keyIndent) {
      const ownerIndent = top.keyIndent;
      containerStack.pop();
      if (!parseValueExpr(trimmed, ownerIndent, false)) return { ok: false, topLevelKeys };
      continue;
    }

    return { ok: false, topLevelKeys };
  }

  if (quotedScalar !== null || flowState !== null) {
    return { ok: false, topLevelKeys };
  }
  if (topLevelKeys.size === 0) {
    return { ok: false, topLevelKeys };
  }
  if (mode === "skill") {
    const hasSkillMetaKey = [...topLevelKeys].some((k) => SKILL_FRONTMATTER_REQUIRED_ANY_KEYS.has(k));
    if (!hasSkillMetaKey) {
      return { ok: false, topLevelKeys };
    }
  }
  return { ok: true, topLevelKeys };
}

export function splitFrontmatter(markdown, options = {}) {
  const raw = String(markdown || "");
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = normalized.match(
    /^---[ \t]*\r?\n(?:(?:---|\.\.\.)[ \t]*(?:\r?\n|$)|([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/
  );
  if (!match || match[1] === undefined) {
    return { frontmatter: "", body: normalized, hasFrontmatter: false };
  }
  const frontmatter = match[0];
  const validation = validateYamlFrontmatter(match[1], options);
  if (!validation.ok) {
    return { frontmatter: "", body: normalized, hasFrontmatter: false };
  }
  return {
    frontmatter,
    body: normalized.slice(frontmatter.length),
    hasFrontmatter: true
  };
}

const IGNORED_SKILL_AUX_DIRS = new Set(["__pycache__", "node_modules"]);
const IGNORED_SKILL_AUX_FILE_RE = /\.py[co]$/i;

function inspectSkillAuxAssets(skillDir) {
  const auxDirSet = new Set();
  const recognizedSet = new Set(SKILL_AUX_DIR_NAMES);
  let auxFileCount = 0;
  let auxBytes = 0;
  let auxTokens = 0;

  if (!isDir(skillDir)) {
    return { auxDirs: [], auxFileCount, auxBytes, auxTokens };
  }

  const walk = (curDir, depth, topDirName) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareAscii(a.name, b.name));
    for (const ent of entries) {
      const lowerName = ent.name.toLowerCase();
      if (ent.name.startsWith(".") || IGNORED_SKILL_AUX_DIRS.has(lowerName)) continue;
      if (depth === 0 && lowerName === "skill.md") continue;
      const full = path.join(curDir, ent.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const nextTop = depth === 0 ? ent.name : topDirName;
        walk(full, depth + 1, nextTop);
      } else if (st.isFile()) {
        if (IGNORED_SKILL_AUX_FILE_RE.test(ent.name)) continue;
        auxFileCount += 1;
        if (topDirName && recognizedSet.has(topDirName)) {
          auxDirSet.add(topDirName);
        }
        if (st.size <= 2 * 1024 * 1024) {
          try {
            const buf = fs.readFileSync(full);
            auxBytes += buf.length;
            const probeLen = Math.min(buf.length, 4096);
            const isBinary = buf.subarray(0, probeLen).includes(0);
            auxTokens += isBinary ? estimateTokens(buf.length) : estimateTokens(buf.toString("utf8"));
            continue;
          } catch {}
        }
        auxBytes += st.size;
        auxTokens += estimateTokens(st.size);
      }
    }
  };

  walk(skillDir, 0, null);
  const auxDirs = SKILL_AUX_DIR_NAMES.filter((name) => auxDirSet.has(name));
  return { auxDirs, auxFileCount, auxBytes, auxTokens };
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
      if (ent.name.startsWith(".") || IGNORED_SKILL_AUX_DIRS.has(ent.name.toLowerCase())) continue;
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
    if (ent.name.startsWith(".") || IGNORED_SKILL_AUX_DIRS.has(ent.name.toLowerCase())) continue;
    const subDir = path.join(skillsRoot, ent.name);
    if (!ent.isDirectory() && !(ent.isSymbolicLink() && isDir(subDir))) continue;
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

function discoverPlugins(configDir, workspaceDir, { workspaceOnly = false } = {}) {
  const disabledSet = new Set();
  if (!workspaceOnly) {
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
      const manifestCandidates = [
        path.join(dir, ".antigravity-plugin", "plugin.json"),
        path.join(dir, ".gemini-plugin", "plugin.json"),
        path.join(dir, "plugin.json")
      ];
      const manifestPath = manifestCandidates.find((p) => isFile(p)) || "";
      if (manifestPath) {
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

  if (!workspaceOnly) {
    scanRoot(path.join(configDir, "plugins"), "plugin", true);
  }
  scanRoot(path.join(workspaceDir, ".agents", "plugins"), "workspace-plugin", false);

  return { activePlugins, disabledPlugins };
}

/* ============================================================================
 * Check 1: Turn-0 Rules & Skill YAML Frontmatter Prefix Audit
 * ========================================================================== */

function scanAndAuditSkills(configDir, workspaceDir, activePlugins, findings, seen = new Set(), { workspaceOnly = false } = {}) {
  const skillItems = [];

  const addSkillFile = ({ skillName, path: filePath }, scope, { legacyPath = false } = {}) => {
    if (!isFile(filePath)) return null;
    const key = canonicalPathKey(filePath);
    if (seen.has(key)) return null;
    seen.add(key);

    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    const { frontmatter, body, hasFrontmatter } = splitFrontmatter(text);
    const fmStats = measureTextStats(frontmatter);
    const bodyStats = measureTextStats(body);
    const aux = inspectSkillAuxAssets(path.dirname(filePath));
    const entry = {
      kind: "skill_frontmatter",
      scope,
      skillName,
      name: `skills/${skillName}/${path.basename(filePath)}`,
      path: path.resolve(filePath),
      bytes: fmStats.bytes,
      chars: fmStats.chars,
      cjkChars: fmStats.cjkChars,
      tokens: fmStats.tokens,
      sha256: fmStats.sha256,
      hasFrontmatter,
      bodyBytes: bodyStats.bytes,
      bodyTokens: bodyStats.tokens,
      auxDirs: aux.auxDirs,
      auxFileCount: aux.auxFileCount,
      auxBytes: aux.auxBytes,
      auxTokens: aux.auxTokens,
      legacyPath: Boolean(legacyPath)
    };
    skillItems.push(entry);
    return entry;
  };

  // Global configDir skills
  if (!workspaceOnly) {
    for (const s of listSkillFiles(path.join(configDir, "skills"))) {
      addSkillFile(s, "global");
    }
  }

  // Active plugin skills (both global & workspace plugins)
  for (const plugin of activePlugins) {
    for (const s of listSkillFiles(path.join(plugin.dir, "skills"))) {
      addSkillFile(s, plugin.scope);
    }
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

  // Legacy skill paths: <workspace>/.agent/skills/ and (when configDir basename === "config") <dirname(configDir)>/antigravity/skills/
  const scanLegacySkillsRoot = (legacyRoot, scope, target, legacyDisplay, modernTarget) => {
    const found = [];
    for (const s of listSkillFiles(legacyRoot)) {
      const added = addSkillFile(s, scope, { legacyPath: true });
      if (added) found.push(added);
    }
    if (found.length > 0) {
      const preview = found
        .slice(0, 5)
        .map((i) => i.skillName)
        .join(", ");
      const more = found.length > 5 ? `, +${found.length - 5} more` : "";
      findings.push({
        severity: "info",
        code: "legacy_skill_path",
        category: "prefix",
        target,
        message: `Found ${found.length} skill(s) in legacy path '${legacyDisplay}' (${preview}${more}).`,
        recommendation: `Migrate skills from '${legacyDisplay}' to '${modernTarget}' so current host versions discover them consistently.`
      });
    }
  };

  scanLegacySkillsRoot(
    path.join(workspaceDir, ".agent", "skills"),
    "workspace-legacy",
    "workspace:.agent/skills",
    ".agent/skills/",
    ".agents/skills/"
  );

  if (!workspaceOnly) {
    const cfgBase = path.basename(configDir);
    const isStandardConfigDir = process.platform === "win32" ? cfgBase.toLowerCase() === "config" : cfgBase === "config";
    if (isStandardConfigDir) {
      scanLegacySkillsRoot(
        path.join(path.dirname(configDir), "antigravity", "skills"),
        "global-legacy",
        "global:antigravity/skills",
        "antigravity/skills/",
        "~/.gemini/config/skills/"
      );
    }
  }

  // Rank descending by Turn-0 frontmatter tokens, then bodyTokens desc, then deterministic path tie-break
  skillItems.sort((a, b) =>
    b.tokens !== a.tokens
      ? b.tokens - a.tokens
      : b.bodyTokens !== a.bodyTokens
        ? b.bodyTokens - a.bodyTokens
        : compareAscii(a.path, b.path)
  );

  let skillFrontmatterBytes = 0;
  let skillFrontmatterChars = 0;
  let skillFrontmatterTokens = 0;
  let skillBodyBytes = 0;
  let skillBodyTokens = 0;
  let skillAuxFileCount = 0;
  let skillAuxBytes = 0;
  let skillAuxTokens = 0;
  let progressiveSkillCount = 0;
  let missingFrontmatterCount = 0;
  let legacySkillCount = 0;

  for (const item of skillItems) {
    skillFrontmatterBytes += item.bytes;
    skillFrontmatterChars += item.chars;
    skillFrontmatterTokens += item.tokens;
    skillBodyBytes += item.bodyBytes;
    skillBodyTokens += item.bodyTokens;
    skillAuxFileCount += item.auxFileCount;
    skillAuxBytes += item.auxBytes;
    skillAuxTokens += item.auxTokens;
    if (item.auxDirs.length > 0) progressiveSkillCount += 1;
    if (item.legacyPath) legacySkillCount += 1;

    const target = `${item.scope}:${item.name}`;
    if (!item.hasFrontmatter) {
      missingFrontmatterCount += 1;
      findings.push({
        severity: "warn",
        code: "missing_skill_frontmatter",
        category: "prefix",
        target,
        message: `Skill '${item.name}' is missing a valid YAML frontmatter block (\`--- ... ---\`).`,
        recommendation: `Add a concise YAML frontmatter header (\`name\` + 1-2 sentence \`description\`) at the top of '${item.name}' so hosts index it cleanly at Turn 0.`
      });
    } else if (item.tokens > SINGLE_SKILL_FRONTMATTER_WARN_TOKENS) {
      const cjkNote = item.cjkChars > 0 ? ` (${item.cjkChars} CJK chars)` : "";
      findings.push({
        severity: "warn",
        code: "oversized_skill_frontmatter",
        category: "prefix",
        target,
        message: `Skill frontmatter '${item.name}' is ~${item.tokens} est. tokens${cjkNote}, exceeding the ${SINGLE_SKILL_FRONTMATTER_WARN_TOKENS}-token single-skill Turn-0 recommendation.`,
        recommendation: `Compress the YAML \`description\` in '${item.name}' to a brief trigger summary and move usage details into the on-demand \`SKILL.md\` body.`
      });
    }

    if (item.bodyTokens > SINGLE_SKILL_BODY_WARN_TOKENS) {
      findings.push({
        severity: "info",
        code: "oversized_skill_body",
        category: "prefix",
        target,
        message: `Skill body '${item.name}' is ~${item.bodyTokens} est. tokens (>${SINGLE_SKILL_BODY_WARN_TOKENS} recommendation), loading heavy context whenever invoked.`,
        recommendation: `Split detailed playbooks, sample payloads, or deterministic helpers from '${item.name}' into on-demand \`references/\`, \`examples/\`, or \`scripts/\` subdirectories.`
      });
    }
  }

  if (skillFrontmatterTokens > TOTAL_SKILLS_FRONTMATTER_WARN_TOKENS) {
    const topSkills = skillItems
      .slice(0, 3)
      .map((i) => `${i.name} (${i.tokens} tok)`)
      .join(", ");
    findings.push({
      severity: "warn",
      code: "excessive_skills_frontmatter",
      category: "prefix",
      target: "turn0-skills-frontmatter",
      message: `Combined Turn-0 skill YAML frontmatter across ${skillItems.length} skill(s) is ~${skillFrontmatterTokens} est. tokens (>${TOTAL_SKILLS_FRONTMATTER_WARN_TOKENS} recommendation). Top contributors: ${topSkills}.`,
      recommendation: "Shorten verbose YAML descriptions in top-contributing skills or disable/uninstall unused skills to lower Turn-0 prefix tax."
    });
  }

  return {
    skillItems,
    skillCount: skillItems.length,
    progressiveSkillCount,
    missingFrontmatterCount,
    legacySkillCount,
    skillFrontmatterBytes,
    skillFrontmatterChars,
    skillFrontmatterTokens,
    skillBodyBytes,
    skillBodyTokens,
    skillAuxFileCount,
    skillAuxBytes,
    skillAuxTokens
  };
}

function listWorkspaceAncestorDirs(workspaceDir) {
  const start = path.resolve(workspaceDir);
  const chain = [start];
  let cur = start;
  let foundGit = false;
  try {
    if (fs.existsSync(path.join(cur, ".git"))) {
      foundGit = true;
    }
  } catch {}
  for (let depth = 0; !foundGit && depth < 10; depth++) {
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    chain.push(parent);
    try {
      if (fs.existsSync(path.join(parent, ".git"))) {
        foundGit = true;
        break;
      }
    } catch {}
    cur = parent;
  }
  return foundGit ? chain : [start];
}

function parseRuleFrontmatterMeta(frontmatterText) {
  const lines = String(frontmatterText || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^---[ \t]*$|^\.\.\.[ \t]*$/.test(l));
  let hasTriggerKey = false;
  let trigger = "";
  let description = "";
  const stripQuotes = (s) => {
    const t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      return t.slice(1, -1).trim();
    }
    return t;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trigMatch = line.match(/^trigger\s*:\s*(.*)$/i);
    if (trigMatch) {
      hasTriggerKey = true;
      trigger = stripQuotes(trigMatch[1].replace(/\s+#.*$/, "")).toLowerCase();
      continue;
    }
    const descMatch = line.match(/^description\s*:\s*(.*)$/i);
    if (descMatch) {
      const rest = descMatch[1].trim();
      if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
        const block = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^[ \t]+/.test(lines[j])) {
            block.push(lines[j].trim());
            i = j;
          } else {
            break;
          }
        }
        description = block.join(" ").trim();
      } else {
        description = stripQuotes(rest);
      }
    }
  }
  return { hasTriggerKey, trigger, description };
}

function auditTurn0Prefix(configDir, workspaceDir, activePlugins, findings, { workspaceOnly = false } = {}) {
  const seen = new Set();
  const ruleItems = [];
  const onDemandRules = [];
  let invalidRuleCount = 0;

  const addRuleFile = (filePath, scope, baseDir, { isStandalone = false } = {}) => {
    if (!isFile(filePath)) return;
    const key = canonicalPathKey(filePath);
    if (seen.has(key)) return;
    seen.add(key);

    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const fullStats = measureTextStats(text);
    const displayName = toPosixDisplay(filePath, baseDir);
    const baseUpper = path.basename(filePath).toUpperCase();
    const isUnconditionalDoc =
      isStandalone ||
      baseUpper === "AGENTS.MD" ||
      baseUpper === "GEMINI.MD" ||
      baseUpper === "CLAUDE.MD";

    let trigger = "always_on";
    let loadMode = "always_on";
    let turn0Stats = fullStats;
    let invalidTrigger = false;

    if (!isUnconditionalDoc) {
      const fm = splitFrontmatter(text, { mode: "rule" });
      if (fm.hasFrontmatter) {
        const meta = parseRuleFrontmatterMeta(fm.frontmatter);
        if (!meta.hasTriggerKey || !VALID_RULE_TRIGGERS.has(meta.trigger)) {
          invalidTrigger = true;
          trigger = meta.trigger || "missing";
          loadMode = "invalid";
          turn0Stats = { bytes: 0, chars: 0, cjkChars: 0, tokens: 0, sha256: fullStats.sha256 };
        } else {
          trigger = meta.trigger;
          loadMode = meta.trigger;
          if (meta.trigger === "model_decision") {
            const pointerText = meta.description ? `${displayName}: ${meta.description}` : displayName;
            turn0Stats = measureTextStats(pointerText);
          } else if (meta.trigger === "glob" || meta.trigger === "manual") {
            turn0Stats = { bytes: 0, chars: 0, cjkChars: 0, tokens: 0, sha256: fullStats.sha256 };
          }
        }
      }
    }

    if (invalidTrigger) {
      invalidRuleCount += 1;
      findings.push({
        severity: "warn",
        code: "invalid_rule_trigger",
        category: "prefix",
        target: `${scope}:${displayName}`,
        message: `Rule '${displayName}' has YAML frontmatter with missing or invalid trigger ('${trigger}'); Antigravity silently drops rules without a valid trigger (always_on, model_decision, glob, manual).`,
        recommendation: `Set 'trigger: always_on', 'trigger: model_decision' (with description), 'trigger: glob', or 'trigger: manual' in '${displayName}' frontmatter.`
      });
      onDemandRules.push({
        kind: "rule_invalid",
        scope,
        name: displayName,
        path: path.resolve(filePath),
        trigger,
        bodyBytes: fullStats.bytes,
        bodyTokens: fullStats.tokens,
        sha256: fullStats.sha256
      });
      return;
    }

    if (loadMode === "glob" || loadMode === "manual") {
      onDemandRules.push({
        kind: "rule_on_demand",
        scope,
        name: displayName,
        path: path.resolve(filePath),
        trigger,
        bodyBytes: fullStats.bytes,
        bodyTokens: fullStats.tokens,
        sha256: fullStats.sha256
      });
      return;
    }

    if (loadMode === "model_decision") {
      onDemandRules.push({
        kind: "rule_on_demand",
        scope,
        name: displayName,
        path: path.resolve(filePath),
        trigger,
        bodyBytes: fullStats.bytes,
        bodyTokens: fullStats.tokens,
        sha256: fullStats.sha256
      });
    }

    ruleItems.push({
      kind: "rule",
      scope,
      name: displayName,
      path: path.resolve(filePath),
      trigger,
      bytes: turn0Stats.bytes,
      chars: turn0Stats.chars,
      cjkChars: turn0Stats.cjkChars,
      tokens: turn0Stats.tokens,
      bodyBytes: fullStats.bytes,
      bodyTokens: fullStats.tokens,
      sha256: turn0Stats.sha256
    });
  };

  // Global standalone rules (~/.gemini/config/{AGENTS,GEMINI}.md and ~/.gemini/{AGENTS,GEMINI}.md)
  if (!workspaceOnly) {
    for (const rootFile of ["AGENTS.md", "GEMINI.md"]) {
      addRuleFile(path.join(configDir, rootFile), "global", configDir, { isStandalone: true });
    }
    const configBase = path.basename(path.resolve(configDir)).toLowerCase();
    const configParent = path.dirname(path.resolve(configDir));
    if (configBase === "config" && path.basename(configParent).toLowerCase() === ".gemini") {
      for (const rootFile of ["AGENTS.md", "GEMINI.md"]) {
        addRuleFile(path.join(configParent, rootFile), "global", configParent, { isStandalone: true });
      }
    }

    // Global configDir rules
    for (const f of listMarkdownFiles(path.join(configDir, "rules"))) {
      addRuleFile(f, "global", configDir);
    }
  }

  // Active plugin rules (both global & workspace plugins)
  for (const plugin of activePlugins) {
    for (const f of listMarkdownFiles(path.join(plugin.dir, "rules"))) {
      addRuleFile(f, plugin.scope, plugin.dir);
    }
  }

  // Workspace always-loaded & scoped rules (walking up to repo .git root when inside a repo)
  const ancestorDirs = listWorkspaceAncestorDirs(workspaceDir);
  for (const dir of ancestorDirs) {
    for (const rootFile of ["AGENTS.md", "GEMINI.md", "CLAUDE.md"]) {
      const candidate = path.join(dir, rootFile);
      if (isFile(candidate)) {
        addRuleFile(candidate, "workspace", workspaceDir, { isStandalone: true });
      }
    }
    for (const agentsRootFile of ["AGENTS.md", "GEMINI.md"]) {
      const candidate = path.join(dir, ".agents", agentsRootFile);
      if (isFile(candidate)) {
        addRuleFile(candidate, "workspace", workspaceDir, { isStandalone: true });
      }
    }
    for (const f of listMarkdownFiles(path.join(dir, ".gemini", "rules"))) {
      addRuleFile(f, "workspace", workspaceDir);
    }
    for (const f of listMarkdownFiles(path.join(dir, ".agents", "rules"))) {
      addRuleFile(f, "workspace", workspaceDir);
    }
  }

  // Scan and audit skills across global, plugin, workspace, and legacy paths
  const skillAudit = scanAndAuditSkills(configDir, workspaceDir, activePlugins, findings, seen, { workspaceOnly });
  const items = [...ruleItems, ...skillAudit.skillItems];

  // Rank descending by estimated tokens (deterministic path tie-break)
  items.sort((a, b) => (b.tokens !== a.tokens ? b.tokens - a.tokens : compareAscii(a.path, b.path)));

  let ruleCount = 0;
  let ruleTokens = 0;
  let alwaysOnRuleTokens = 0;
  let totalBytes = 0;
  let totalChars = 0;

  for (const item of items) {
    totalBytes += item.bytes;
    totalChars += item.chars;
    if (item.kind === "rule") {
      ruleCount += 1;
      ruleTokens += item.tokens;
      if (item.trigger === "always_on") {
        alwaysOnRuleTokens += item.tokens;
        if (item.bytes > SINGLE_RULE_TRUNCATE_BYTES) {
          findings.push({
            severity: "warn",
            code: "rule_truncation_limit",
            category: "prefix",
            target: `${item.scope}:${item.name}`,
            message: `Always-loaded rule '${item.name}' is ${item.bytes.toLocaleString("en-US")} bytes, exceeding Antigravity's ${SINGLE_RULE_TRUNCATE_BYTES.toLocaleString("en-US")}-byte (24 KB) per-rule truncation cap.`,
            recommendation: `Split '${item.name}' below 24 KB or move detailed guidance into an on-demand SKILL.md / model_decision rule so the tail is not silently truncated.`
          });
        }
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
      }
    }
  }

  if (alwaysOnRuleTokens > RULES_AGGREGATE_BUDGET_TOKENS) {
    findings.push({
      severity: "warn",
      code: "rules_aggregate_budget_exceeded",
      category: "prefix",
      target: "turn0-always-on-rules",
      message: `Combined global & always_on rules consume ~${alwaysOnRuleTokens} est. tokens, exceeding Antigravity's ${RULES_AGGREGATE_BUDGET_TOKENS.toLocaleString("en-US")}-token aggregate rule budget (host demotes overflow rules to on-demand pointers).`,
      recommendation: "Convert lower-priority rules to trigger: model_decision or glob, or move reference content into SKILL.md files."
    });
  }

  const onDemandRuleCount = onDemandRules.filter((r) => r.kind === "rule_on_demand").length;
  const onDemandRuleTokens = onDemandRules
    .filter((r) => r.kind === "rule_on_demand")
    .reduce((acc, r) => acc + r.bodyTokens, 0);

  const totalTokens = ruleTokens + skillAudit.skillFrontmatterTokens;
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
      singleRuleTruncateBytes: SINGLE_RULE_TRUNCATE_BYTES,
      rulesAggregateBudgetTokens: RULES_AGGREGATE_BUDGET_TOKENS,
      totalPrefixWarnTokens: TOTAL_PREFIX_WARN_TOKENS,
      singleSkillFrontmatterWarnTokens: SINGLE_SKILL_FRONTMATTER_WARN_TOKENS,
      singleSkillBodyWarnTokens: SINGLE_SKILL_BODY_WARN_TOKENS,
      totalSkillsFrontmatterWarnTokens: TOTAL_SKILLS_FRONTMATTER_WARN_TOKENS
    },
    ruleCount,
    onDemandRuleCount,
    onDemandRuleTokens,
    invalidRuleCount,
    skillCount: skillAudit.skillCount,
    progressiveSkillCount: skillAudit.progressiveSkillCount,
    legacySkillCount: skillAudit.legacySkillCount,
    ruleTokens,
    alwaysOnRuleTokens,
    skillFrontmatterTokens: skillAudit.skillFrontmatterTokens,
    skillBodyTokens: skillAudit.skillBodyTokens,
    skillAuxFileCount: skillAudit.skillAuxFileCount,
    skillAuxBytes: skillAudit.skillAuxBytes,
    skillAuxTokens: skillAudit.skillAuxTokens,
    totalTokens,
    totalBytes,
    totalChars,
    items,
    onDemandRules
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

const WIN_TASKKILL_BIN =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe")
    : "taskkill";

function killChildTree(child, usedShell, onDone = null) {
  let doneCalled = false;
  const done = () => {
    if (doneCalled) return;
    doneCalled = true;
    if (typeof onDone === "function") onDone();
  };
  if (!child) {
    done();
    return null;
  }
  const fallbackKill = () => {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };
  if (process.platform === "win32" && child.pid) {
    // On Windows, child.kill("SIGTERM") on a .cmd/.bat shell wrapper only kills outer cmd.exe
    // while setting child.signalCode = "SIGTERM" and leaving grandchild node.exe alive.
    // Always run taskkill /T /F when usedShell is true or child has not exited.
    if (!usedShell && child.exitCode !== null) {
      done();
      return null;
    }
    try {
      const killer = spawn(WIN_TASKKILL_BIN, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", () => {
        fallbackKill();
        done();
      });
      killer.on("close", (code) => {
        if (code !== 0) fallbackKill();
        done();
      });
      return killer;
    } catch {
      fallbackKill();
      done();
      return null;
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    done();
    return null;
  }
  fallbackKill();
  done();
  return null;
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
    let childClosed = false;
    let treeKillPending = false;
    let activeKiller = null;
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
      try {
        activeKiller?.unref();
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

      const isWinShell = process.platform === "win32" && needsShell;
      if ((childClosed || child.exitCode !== null) && !isWinShell) {
        finish(outcome);
        return;
      }

      const startTreeKill = () => {
        if (settled || treeKillPending) return;
        if (child.exitCode === null || isWinShell) {
          treeKillPending = true;
          activeKiller = killChildTree(child, needsShell, () => {
            treeKillPending = false;
            if (!settled && (childClosed || child.exitCode !== null)) {
              finish(outcome);
            }
          });
        }
      };

      if (!isWinShell) {
        const termTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGTERM");
            } catch {}
          }
        }, 80);
        termTimer.unref();
        timers.push(termTimer);
      }

      if (isWinShell && outcome?.status === "timeout") {
        // Server already timed out: run taskkill /T /F immediately and wait for it to finish
        // before resolving so grandchild processes cannot outlive cache-audit.mjs under load.
        startTreeKill();
      } else {
        const killTimer = setTimeout(startTreeKill, isWinShell ? 120 : 220);
        killTimer.unref();
        timers.push(killTimer);
      }

      const forceResolveTimer = setTimeout(() => {
        finish(outcome);
      }, isWinShell ? 2500 : 450);
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
      childClosed = true;
      if (pendingOutcome) {
        if (!treeKillPending) {
          finish(pendingOutcome);
        }
        return;
      }
      // Flush any trailing line without newline
      parseState.eof = true;
      handleMessages(drainMcpMessages(parseState));
      if (pendingOutcome) {
        if (!treeKillPending) {
          finish(pendingOutcome);
        }
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
        clientInfo: { name: "agy-dart-cache-audit", version: "1.6.0" }
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

async function auditMcpServers(configDir, workspaceDir, activePlugins, { live, timeoutMs, workspaceOnly = false }, findings) {
  const configSources = [];
  const seenConfigs = new Set();

  const addConfig = (configPath, scope, pluginRoot) => {
    if (!isFile(configPath)) return;
    const key = normalizePathKey(configPath);
    if (seenConfigs.has(key)) return;
    seenConfigs.add(key);
    configSources.push({ configPath: path.resolve(configPath), scope, pluginRoot: path.resolve(pluginRoot) });
  };

  if (!workspaceOnly) {
    addConfig(path.join(configDir, "mcp_config.json"), "global", configDir);
  }
  for (const plugin of activePlugins) {
    addConfig(path.join(plugin.dir, "mcp_config.json"), plugin.scope, plugin.dir);
  }
  for (const dir of listWorkspaceAncestorDirs(workspaceDir)) {
    addConfig(path.join(dir, ".agents", "mcp_config.json"), "workspace", dir);
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

      // Partition exposed tools into Turn-0 eager vs on-demand lazy catalog per Antigravity mcp_config.json spec
      const enabledSet = Array.isArray(entry.enabledTools)
        ? new Set(entry.enabledTools.map((t) => String(t)))
        : null;
      const disabledSet = Array.isArray(entry.disabledTools)
        ? new Set(entry.disabledTools.map((t) => String(t)))
        : new Set();
      const toolCfgMap = entry.tools && typeof entry.tools === "object" && !Array.isArray(entry.tools) ? entry.tools : {};
      const eagerTools = [];
      const lazyTools = [];
      for (const tool of run1.tools) {
        const tName = typeof tool?.name === "string" ? tool.name : "";
        if (enabledSet && !enabledSet.has(tName)) continue;
        if (disabledSet.has(tName)) continue;
        const tCfg = toolCfgMap[tName];
        if (tCfg && (tCfg.disabled === true || tCfg.enabled === false)) continue;
        if (tCfg && tCfg.eager === true) {
          eagerTools.push(tool);
        } else {
          lazyTools.push(tool);
        }
      }
      const eagerToolCount = eagerTools.length;
      const lazyToolCount = lazyTools.length;
      const eagerTokens = eagerTools.length > 0 ? estimateTokens(JSON.stringify(eagerTools)) : 0;
      const lazyCatalogTokens = lazyTools.length > 0 ? estimateTokens(JSON.stringify(lazyTools)) : 0;

      return {
        id,
        name,
        scope,
        configPath,
        transport: "stdio",
        command,
        status: deterministic ? "ok" : "non_deterministic",
        toolCount: run1.tools.length,
        eagerToolCount,
        lazyToolCount,
        bytes,
        tokens,
        eagerTokens,
        lazyCatalogTokens,
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
    let totalEagerSchemaTokens = 0;
    let totalLazyCatalogTokens = 0;
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
      totalEagerSchemaTokens += s.eagerTokens || 0;
      totalLazyCatalogTokens += s.lazyCatalogTokens || 0;
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

      if ((s.eagerTokens || 0) > MCP_SCHEMA_WARN_TOKENS) {
        findings.push({
          severity: "warn",
          code: "bloated_mcp_schema",
          category: "mcp",
          target: s.id,
          message: `MCP server '${s.id}' loads ${s.eagerToolCount}/${s.toolCount} eager tool(s) consuming ~${s.eagerTokens} est. Turn-0 tokens (>${MCP_SCHEMA_WARN_TOKENS} threshold).`,
          recommendation: "Remove eager: true from infrequent tools (Antigravity lazy-loads MCP tools by default), shorten verbose parameter descriptions, or disable unused tools."
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
      totalEagerSchemaTokens,
      totalLazyCatalogTokens,
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
        const inlineSnippet = tokens.slice(idx + 1).join(" ");
        const polyglotHookMatch = rawCommand.match(
          /s0=\/([A-Za-z0-9_.-]+)\/\.source;s1=\/([A-Za-z0-9_.-]+\.(?:m?js|cjs))\/\.source/
        );
        if (polyglotHookMatch && polyglotHookMatch[1] && polyglotHookMatch[2]) {
          const candidateAbs = path.resolve(baseDir, polyglotHookMatch[1], polyglotHookMatch[2]);
          if (isFile(candidateAbs)) {
            return { kind: "script", scriptPath: candidateAbs, inlineCode: null };
          }
        }
        const bootstrapHookMatch = inlineSnippet.match(
          /\br\s*=\s*['"](\.?\/?hooks\/[A-Za-z0-9_./-]+\.(?:m?js|cjs))['"]/
        );
        if (bootstrapHookMatch && bootstrapHookMatch[1]) {
          const candidateAbs = path.resolve(baseDir, bootstrapHookMatch[1]);
          if (isFile(candidateAbs)) {
            return { kind: "script", scriptPath: candidateAbs, inlineCode: null };
          }
        }
        return { kind: "inline", scriptPath: null, inlineCode: inlineSnippet };
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

function auditHooksAndPlugins(configDir, workspaceDir, activePlugins, disabledPlugins, findings, { workspaceOnly = false } = {}) {
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

  if (!workspaceOnly) {
    addHookConfig(path.join(configDir, "hooks.json"), "global", configDir);
  }
  for (const plugin of activePlugins) {
    addHookConfig(path.join(plugin.dir, "hooks.json"), plugin.scope, plugin.dir);
  }
  for (const dir of listWorkspaceAncestorDirs(workspaceDir)) {
    addHookConfig(path.join(dir, ".agents", "hooks.json"), "workspace", dir);
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

function formatBytesCompact(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function classifyFindingScopeGroup(finding, workspaceDir, { workspaceOnly = false } = {}) {
  if (finding?.scopeGroup === "workspace" || finding?.scopeGroup === "global") {
    return finding.scopeGroup;
  }
  const target = String(finding?.target || "");
  if (
    target.startsWith("workspace:") ||
    target.startsWith("workspace/") ||
    target.startsWith("workspace-plugin:") ||
    target.startsWith("workspace-legacy:")
  ) {
    return "workspace";
  }
  if (
    target.startsWith("global:") ||
    target.startsWith("global/") ||
    target.startsWith("global-legacy:") ||
    target.startsWith("plugin:") ||
    target === "safety-monitor"
  ) {
    return "global";
  }
  if (workspaceDir && target && path.isAbsolute(target)) {
    const wsKey = normalizePathKey(workspaceDir);
    const tKey = normalizePathKey(target);
    if (tKey === wsKey || tKey.startsWith(wsKey + path.sep)) {
      return "workspace";
    }
  }
  return workspaceOnly ? "workspace" : "global";
}

function annotateFindingsScope(sortedFindings, workspaceDir, { workspaceOnly = false } = {}) {
  let workspaceCount = 0;
  let globalCount = 0;
  const tagged = sortedFindings.map((f) => {
    const scopeGroup = classifyFindingScopeGroup(f, workspaceDir, { workspaceOnly });
    if (scopeGroup === "workspace") workspaceCount += 1;
    else globalCount += 1;
    return { ...f, scopeGroup };
  });
  return {
    findings: tagged,
    findingsByScope: {
      workspace: workspaceCount,
      global: globalCount
    }
  };
}

export function auditSkillsOnly(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const configDir = path.resolve(options.configDir || path.join(getHomeDir(), ".gemini", "config"));
  const workspaceOnly = Boolean(options.workspaceOnly);
  const findings = [];
  const { activePlugins } = discoverPlugins(configDir, workspace, { workspaceOnly });
  const skillAudit = scanAndAuditSkills(configDir, workspace, activePlugins, findings, new Set(), { workspaceOnly });

  const sortedRaw = sortFindings(findings);
  const { findings: sortedFindings, findingsByScope } = annotateFindingsScope(sortedRaw, workspace, { workspaceOnly });
  const { score, grade, scoreBreakdown } = computeHealthScore(sortedFindings);

  return stableSortObject({
    schemaVersion: "1.2",
    mode: "skills-only",
    options: {
      workspace,
      configDir,
      skillsOnly: true,
      ...(workspaceOnly ? { workspaceOnly: true } : {})
    },
    score,
    grade,
    scoreBreakdown,
    findingsByScope,
    thresholds: {
      singleSkillFrontmatterWarnTokens: SINGLE_SKILL_FRONTMATTER_WARN_TOKENS,
      singleSkillBodyWarnTokens: SINGLE_SKILL_BODY_WARN_TOKENS,
      totalSkillsFrontmatterWarnTokens: TOTAL_SKILLS_FRONTMATTER_WARN_TOKENS
    },
    summary: {
      skillCount: skillAudit.skillCount,
      progressiveSkillCount: skillAudit.progressiveSkillCount,
      missingFrontmatterCount: skillAudit.missingFrontmatterCount,
      legacySkillCount: skillAudit.legacySkillCount,
      totalFrontmatterBytes: skillAudit.skillFrontmatterBytes,
      totalFrontmatterTokens: skillAudit.skillFrontmatterTokens,
      totalBodyBytes: skillAudit.skillBodyBytes,
      totalBodyTokens: skillAudit.skillBodyTokens,
      totalAuxFileCount: skillAudit.skillAuxFileCount,
      totalAuxBytes: skillAudit.skillAuxBytes,
      totalAuxTokens: skillAudit.skillAuxTokens
    },
    skills: skillAudit.skillItems,
    findings: sortedFindings
  });
}

export function formatSkillsAuditMarkdown(report) {
  const sb = report.scoreBreakdown;
  const s = report.summary;
  const t = report.thresholds;
  const scopeNote = report.findingsByScope
    ? ` (workspace: ${report.findingsByScope.workspace}, global: ${report.findingsByScope.global})`
    : "";
  const lines = [
    "# Skills Turn-0 Tax & Progressive Disclosure Report",
    "",
    `- **Skills Health Score**: **${report.score}/100 (Grade ${report.grade})**`,
    `- **Findings**: ${sb.criticalCount} critical, ${sb.warnCount} warn, ${sb.infoCount} info${scopeNote}`,
    `- **Turn-0 Resident Frontmatter**: **~${s.totalFrontmatterTokens.toLocaleString("en-US")} tokens** across **${s.skillCount} skill(s)** (budget <= ${t.totalSkillsFrontmatterWarnTokens.toLocaleString("en-US")} tok; single skill <= ${t.singleSkillFrontmatterWarnTokens} tok)`,
    `- **On-Demand Payload (0 Turn-0 tax)**: body ~${s.totalBodyTokens.toLocaleString("en-US")} tok · progressive aux **${s.totalAuxFileCount} file(s)** (${formatBytesCompact(s.totalAuxBytes)}, ~${s.totalAuxTokens.toLocaleString("en-US")} tok, excluded from Turn 0)`,
    `- **Progressive Disclosure Adoption**: ${s.progressiveSkillCount}/${s.skillCount} skill(s) using \`references/\`, \`examples/\`, \`scripts/\`, or \`resources/\``,
    `- **Scope**: workspace=\`${toPosixDisplay(report.options.workspace)}\` · configDir=\`${toPosixDisplay(report.options.configDir)}\``,
    ""
  ];

  lines.push("## 1. Installed Skills Inventory", "");
  if (report.skills.length === 0) {
    lines.push("_No skills discovered in global config, active plugins, workspace, or legacy skill directories._", "");
  } else {
    const MAX_SKILL_ROWS = 50;
    const shown = report.skills.slice(0, MAX_SKILL_ROWS);
    const hidden = report.skills.slice(MAX_SKILL_ROWS);
    lines.push("| Scope | Skill | FM | Frontmatter Tok | Body Tok | Aux Dirs | Aux Payload (On-Demand) |");
    lines.push("| :--- | :--- | :---: | ---: | ---: | :--- | :--- |");
    for (const item of shown) {
      const fmLabel = item.hasFrontmatter ? "YES" : "MISSING";
      const auxDirsLabel = item.auxDirs.length > 0 ? `\`${mdCell(item.auxDirs.join(", "))}\`` : "—";
      const auxPayload =
        item.auxFileCount > 0
          ? `${item.auxFileCount} file(s) (${formatBytesCompact(item.auxBytes)}, ~${item.auxTokens} tok)`
          : "—";
      const scopeLabel = item.legacyPath && !item.scope.endsWith("-legacy") ? `${item.scope} [legacy]` : item.scope;
      lines.push(
        `| \`${mdCell(scopeLabel)}\` | \`${mdCell(item.name)}\` | ${fmLabel} | ${item.tokens} | ${item.bodyTokens} | ${auxDirsLabel} | ${auxPayload} |`
      );
    }
    if (hidden.length > 0) {
      const restFm = hidden.reduce((acc, i) => acc + i.tokens, 0);
      const restBody = hidden.reduce((acc, i) => acc + i.bodyTokens, 0);
      const restAuxFiles = hidden.reduce((acc, i) => acc + i.auxFileCount, 0);
      const restAuxBytes = hidden.reduce((acc, i) => acc + i.auxBytes, 0);
      const restAuxTok = hidden.reduce((acc, i) => acc + i.auxTokens, 0);
      lines.push(
        `| _..._ | _+${hidden.length} more (see \`--json\`)_ | — | ${restFm} | ${restBody} | — | ${restAuxFiles} file(s) (${formatBytesCompact(restAuxBytes)}, ~${restAuxTok} tok) |`
      );
    }
    lines.push(
      `| **TOTAL** | **${s.skillCount} skill(s)** | — | **${s.totalFrontmatterTokens}** | **${s.totalBodyTokens}** | **${s.progressiveSkillCount} progressive** | **${s.totalAuxFileCount} file(s) (${formatBytesCompact(s.totalAuxBytes)}, ~${s.totalAuxTokens} tok)** |`
    );
    lines.push("");
  }

  lines.push("## 2. Findings & Actionable Fixes", "");
  if (report.findings.length === 0) {
    lines.push("All Skills Turn-0 prefix & progressive-disclosure checks passed with zero findings.");
  } else {
    for (const f of report.findings) {
      const tag = f.severity.toUpperCase();
      lines.push(`- **[${tag}]** \`${f.code}\` (\`${mdCell(f.target)}\`): ${f.message}`);
      lines.push(`  - **Fix**: ${f.recommendation}`);
    }
  }

  return lines.join("\n");
}

export function auditSafetyMonitorOnly(options = {}) {
  return auditSafetyMonitor({
    ...(Array.isArray(options.safetyLogPaths) && options.safetyLogPaths.length > 0
      ? { logPaths: options.safetyLogPaths }
      : {}),
    ...(options.windowHours !== undefined ? { windowHours: options.windowHours } : {}),
    ...(options.persistState !== undefined ? { persistState: options.persistState } : {}),
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.disableDefaultDiscovery !== undefined
      ? { disableDefaultDiscovery: options.disableDefaultDiscovery }
      : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {})
  });
}

export { formatSafetyAuditMarkdown };

export async function auditEnvironmentCache(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const configDir = path.resolve(options.configDir || path.join(getHomeDir(), ".gemini", "config"));
  const live = options.live !== undefined ? Boolean(options.live) : true;
  const workspaceOnly = Boolean(options.workspaceOnly);
  const rawTimeout = options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0 ? Math.round(Number(rawTimeout)) : DEFAULT_TIMEOUT_MS;
  const includeSafety = Boolean(options.includeSafety);

  const findings = [];
  const { activePlugins, disabledPlugins } = discoverPlugins(configDir, workspace, { workspaceOnly });

  const prefix = auditTurn0Prefix(configDir, workspace, activePlugins, findings, { workspaceOnly });
  const mcp = await auditMcpServers(configDir, workspace, activePlugins, { live, timeoutMs, workspaceOnly }, findings);
  const hooks = auditHooksAndPlugins(configDir, workspace, activePlugins, disabledPlugins, findings, { workspaceOnly });
  let safety = null;
  if (includeSafety) {
    safety = auditSafetyMonitorOnly(options);
    if (safety.status === "429_avalanche") {
      findings.push({
        severity: "critical",
        category: "safety",
        code: "safety_429_avalanche",
        target: "safety-monitor",
        message: safety.summaryEn,
        recommendation:
          "Pause concurrent CLI/multi-window bursts, generate a Handoff Brief to start a fresh window, and wait for the 5h sir_flash_lite quota window reset."
      });
    } else if (safety.status === "heavy_burst_or_sticky" || safety.status === "approaching_quota") {
      findings.push({
        severity: safety.severity === "critical" ? "critical" : "warn",
        category: "safety",
        code: safety.status === "approaching_quota" ? "safety_approaching_quota" : "safety_heavy_burst_or_sticky",
        target: "safety-monitor",
        message: safety.summaryEn,
        recommendation:
          safety.actions?.[0]?.labelEn ||
          "Start a fresh conversation window via Handoff Brief and keep outside-workspace reads on native read_file."
      });
    }
  }

  const sortedRaw = sortFindings(findings);
  const { findings: sortedFindings, findingsByScope } = annotateFindingsScope(sortedRaw, workspace, { workspaceOnly });
  const { score, grade, scoreBreakdown } = computeHealthScore(sortedFindings);

  const totals = {
    rulesAndSkillsTokens: prefix.totalTokens,
    mcpSchemaTokens: mcp.totalSchemaTokens,
    eagerMcpSchemaTokens: mcp.totalEagerSchemaTokens,
    lazyMcpCatalogTokens: mcp.totalLazyCatalogTokens,
    estimatedTurn0Tokens: prefix.totalTokens + mcp.totalEagerSchemaTokens
  };

  return stableSortObject({
    schemaVersion: "1.2",
    options: {
      workspace,
      configDir,
      live,
      timeoutMs,
      ...(workspaceOnly ? { workspaceOnly: true } : {}),
      ...(includeSafety ? { includeSafety: true } : {})
    },
    score,
    grade,
    scoreBreakdown,
    findingsByScope,
    totals,
    prefix,
    mcp,
    hooks,
    ...(includeSafety ? { safety } : {}),
    findings: sortedFindings
  });
}

export function formatCacheAuditMarkdown(report) {
  const sb = report.scoreBreakdown;
  const eagerMcpTok = Number.isFinite(report.totals.eagerMcpSchemaTokens)
    ? report.totals.eagerMcpSchemaTokens
    : report.totals.mcpSchemaTokens;
  const lazyMcpTok = Number.isFinite(report.totals.lazyMcpCatalogTokens)
    ? report.totals.lazyMcpCatalogTokens
    : 0;
  const lazyNote = lazyMcpTok > 0 ? `; lazy MCP catalog: ${lazyMcpTok.toLocaleString("en-US")} tok` : "";
  const scopeCountNote = report.findingsByScope
    ? ` (workspace: ${report.findingsByScope.workspace}, global: ${report.findingsByScope.global})`
    : "";
  const workspaceOnlyNote = report.options?.workspaceOnly ? " · scopeFilter=workspace-only" : "";
  const lines = [
    "# Prompt Cache Environment Audit",
    "",
    `- **Health Score**: **${report.score}/100 (Grade ${report.grade})**`,
    `- **Findings**: ${sb.criticalCount} critical, ${sb.warnCount} warn, ${sb.infoCount} info${scopeCountNote}`,
    `- **Estimated Turn-0 Prefix**: **~${report.totals.estimatedTurn0Tokens.toLocaleString("en-US")} tokens** (rules & skills frontmatter: ${report.totals.rulesAndSkillsTokens.toLocaleString("en-US")} tok + eager MCP schemas: ${eagerMcpTok.toLocaleString("en-US")} tok${lazyNote})`,
    `- **Scope**: workspace=\`${toPosixDisplay(report.options.workspace)}\` · configDir=\`${toPosixDisplay(report.options.configDir)}\` · liveMCP=${report.options.live ? "on" : "off"}${workspaceOnlyNote}`,
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

  if (report.safety) {
    lines.push("", "## 5. Background Safety Monitor Audit (Issue #1886)", "");
    lines.push(formatSafetyAuditMarkdown(report.safety));
  }

  return lines.join("\n");
}

export function parseCliArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    workspace: process.cwd(),
    configDir: path.join(getHomeDir(), ".gemini", "config"),
    live: true,
    workspaceOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skillsOnly: false,
    safetyAudit: false,
    includeSafety: false,
    safetyLogPaths: [],
    windowHours: undefined,
    persistState: true,
    json: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--workspace-only") {
      opts.workspaceOnly = true;
    } else if (a === "--skills-only") {
      opts.skillsOnly = true;
    } else if (a === "--safety-audit") {
      opts.safetyAudit = true;
    } else if (a === "--with-safety") {
      opts.includeSafety = true;
    } else if (a === "--no-state") {
      opts.persistState = false;
    } else if (a === "--safety-log-path" || a.startsWith("--safety-log-path=")) {
      const next = a.includes("=") ? a.slice("--safety-log-path=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --safety-log-path");
      opts.safetyLogPaths.push(path.resolve(next));
    } else if (a === "--window-hours" || a.startsWith("--window-hours=")) {
      const next = a.includes("=") ? a.slice("--window-hours=".length) : args[++i];
      const parsed = Number(next);
      if (!next || !Number.isFinite(parsed) || parsed < 1 || parsed > 24) {
        throw new Error(`Invalid --window-hours value '${next}'. Expected integer 1..24.`);
      }
      opts.windowHours = Math.round(parsed);
    } else if (a === "--live") {
      opts.live = true;
    } else if (a === "--no-live") {
      opts.live = false;
    } else if (a === "--workspace" || a.startsWith("--workspace=")) {
      const next = a.includes("=") ? a.slice("--workspace=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --workspace");
      opts.workspace = path.resolve(next);
    } else if (a === "--config-dir" || a.startsWith("--config-dir=")) {
      const next = a.includes("=") ? a.slice("--config-dir=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --config-dir");
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
  --workspace <dir>         Workspace root to audit (default: current working directory)
  --config-dir <dir>        Antigravity config root (default: ~/.gemini/config)
  --workspace-only          Audit workspace-scoped rules, skills, plugins, MCP & hooks only (skip global config)
  --skills-only             Offline fast view: audit Skills Turn-0 tax & progressive disclosure only
  --safety-audit            Offline Safety Monitor quota-burn audit (Issue #1886 Desktop & CLI logs)
  --with-safety             Include Safety Monitor audit section in the full cache audit report
  --safety-log-path <path>  Override Safety Monitor log file/directory (repeatable)
  --window-hours <1..24>    Rolling Safety Monitor window in hours (default: 5)
  --no-state                Stateless Safety Monitor scan (do not read/write persisted rolling state)
  --live                    Probe configured stdio MCP servers live twice (default)
  --no-live                 Skip live MCP server probing
  --timeout <ms>            Per-server MCP probe timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --json                    Output machine-readable JSON report
  -h, --help                Show this help
`);
}

async function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.safetyAudit) {
    const report = auditSafetyMonitorOnly(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatSafetyAuditMarkdown(report) + "\n");
    }
    return;
  }
  if (opts.skillsOnly) {
    const report = auditSkillsOnly(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatSkillsAuditMarkdown(report) + "\n");
    }
    return;
  }
  const report = await auditEnvironmentCache(opts);
  if (report?.scoreBreakdown?.criticalCount === 0) {
    const hasCustomDbEnv = Boolean(process.env.AGY_DART_DB_PATH && process.env.AGY_DART_DB_PATH.trim());
    const defaultCfgDir = path.resolve(path.join(getHomeDir(), ".gemini", "config"));
    if (hasCustomDbEnv || path.resolve(opts.configDir) === defaultCfgDir) {
      try {
        const { suppressSqliteExperimentalWarning } = await import("../hooks/compile-cache.mjs");
        suppressSqliteExperimentalWarning();
        const { ContextModeStore } = await import("../context/lib/store.js");
        const store = new ContextModeStore({ hookMode: true });
        try {
          store.recordCacheAuditPassed();
        } finally {
          store.close();
        }
      } catch {}
    }
  }
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
