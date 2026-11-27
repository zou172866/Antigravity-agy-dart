/**
 * Declarative CLI output filter rules for agy-dart PreToolUse.overwrite.
 * Clean-room zero-dependency implementation inspired by MIT-licensed tokf patterns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { truncateUtf8Safe } from "../context/lib/stable-json.js";
export { truncateUtf8Safe };

let smartCrushJsonFn = null;
let isJsonLikeFn = null;
try {
  const crusher = await import("../context/lib/json-crusher.js");
  smartCrushJsonFn = crusher.smartCrushJson;
  isJsonLikeFn = crusher.isJsonLike;
} catch {
  // Fail-open when running from partial isolated copies without json-crusher.js
}

export const MAX_FILTERED_OUTPUT_BYTES = 7900; // Leaves ~900 B headroom for Antigravity overwrite notice (<= 8.8 KB total)

const MAX_PROJECT_RULES_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_RULES_COUNT = 20;
const MAX_CUSTOM_REGEX_LENGTH = 256;
const MAX_PROJECT_RULES_CACHE_ENTRIES = 32;
const MAX_CUSTOM_REGEX_LINE_CHARS = 4096;
const MAX_CUSTOM_MATCH_CMD_CHARS = 2048;
const MAX_CUSTOM_FILTER_MS = 150;
const CUSTOM_RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const FAIL_ERROR_LINE_RE =
  /(?:(?:^|\b)(?:error|err!|fail(?:ed|ure)?|fatal|panic|exception|traceback|assertionerror|syntaxerror|typeerror|referenceerror|rangeerror|enoent|eacces|econnrefused|not\s+ok|segmentation fault|segfault)(?:\b|:|$)|(?:^|\s)[✖✗](?:\s|$)|\bERR_[A-Z0-9_]{3,}\b)/i;
const PASCAL_ERROR_CLASS_RE = /\b[A-Z][A-Za-z0-9_]*(?:Error|Exception)\b(?:\s*[:\[(]|$)/;
const ZERO_ERROR_CLAUSE_RE =
  /\b(?:0\s+(?:errors?|fail(?:ed|ures?)?)\b|(?:errors?|fail(?:ed|ures?)?)\s*[:=]?\s*0(?=$|\.(?=\s|$)|\s*[,;)\]\}|/(]|\s+(?:pass(?:ed)?|fail(?:ed|ures?)?|errors?|warnings?|skipped?|ignored|todo|total|ok|tests?|suites?|assertions?|duration)\b|\s*$))/gi;
const FAILURE_EXCERPT_TIMEOUT_RE = /\btimed\s+out\b/i;

export function isFailureAnchorLine(line, { includeTimeout = false } = {}) {
  if (typeof line !== "string" || !line.trim()) return false;
  const cleaned = line.replace(ZERO_ERROR_CLAUSE_RE, " ");
  if (!cleaned.trim()) return false;
  return (
    FAIL_ERROR_LINE_RE.test(cleaned) ||
    PASCAL_ERROR_CLASS_RE.test(cleaned) ||
    Boolean(includeTimeout && FAILURE_EXCERPT_TIMEOUT_RE.test(cleaned))
  );
}

const FAILURE_EXCERPT_PASS_NOISE_RE =
  /^\s*(?:PASS\b|---\s*PASS\b|ok(?:\s+\d+\b|\s+-)|[✓✔](?:\s|$)|-\s*\[PASS\b|##\s*\[PASS\b|\[PASS\b|\$\s+)/i;
const FAILURE_EXCERPT_PASS_LINE_TAIL_RE = /(?:\bPASSED\b(?:\s*\[[^\]]*\])?|\.\.\.\s*ok)\s*$/i;
const FAILURE_EXCERPT_NON_ANCHOR_RE = /^\s*#\s*Subtest\s*:/i;
const FAILURE_EXCERPT_SUITE_START_RE = /^\s*▶(?:\s|$)/;
const FAILURE_EXCERPT_TAP_META_NOISE_RE =
  /^\s*(?:---|\.\.\.|duration_ms\s*:.*|type\s*:\s*['"]?(?:test|suite)['"]?|location\s*:.*|failureType\s*:.*|operator\s*:.*|stack\s*:\s*(?:[|>][+-]?\d*|[|>]\d*[+-]?)?)\s*$/i;
const TAP_NOT_OK_RE = /^\s*not\s+ok\b/i;
const TAP_OK_RE = /^\s*ok(?:\s+\d+\b|\s+-|\s*#\s*(?:SKIP|TODO)\b|\s*$)/i;
const TAP_DIRECTIVE_PREFIX_RE = /^\s*(?:not\s+ok(?=\s|#)|ok(?=\s+(?:\d+\b|-(?:\s|$)|[^:=,\s])|\s*#))/i;
const TAP_DIRECTIVE_TAG_RE = /^#\s*(?:TODO|SKIP)\b/i;
const TAP_STRUCTURAL_BOUNDARY_RE =
  /^(?:(?:not\s+)?ok(?:\s|#|$)|\d+\.\.\d+$|#\s*Subtest\s*:|TAP\s+version\s+\d+$|Bail\s+out!)/i;
const TAP_YAML_BLOCK_SCALAR_RE = /^(?:[|>][+-]?\d*|[|>]\d*[+-]?)$/;
const TAP_YAML_SKIP_KEYS = new Set(["duration_ms", "type", "location", "failuretype", "operator"]);
const TAP_YAML_SUPPLEMENT_KEYS = new Set(["code", "name", "expected", "actual"]);

export function isTapDirectiveResultLine(line) {
  if (typeof line !== "string" || !line) return false;
  const prefixMatch = line.match(TAP_DIRECTIVE_PREFIX_RE);
  if (!prefixMatch) return false;
  const rest = line.slice(prefixMatch[0].length);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "#") continue;
    let backslashes = 0;
    for (let p = i - 1; p >= 0 && rest[p] === "\\"; p--) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) continue; // Escaped literal `\#` in TAP description
    if (TAP_DIRECTIVE_TAG_RE.test(rest.slice(i))) {
      return true;
    }
  }
  return false;
}

function skipTapYamlBlock(entries, resultIdx) {
  const result = entries[resultIdx];
  if (!result) return resultIdx;
  const yamlStartIdx = resultIdx + 1;
  if (yamlStartIdx >= entries.length) return resultIdx;
  const yamlStart = entries[yamlStartIdx];
  if (yamlStart.text !== "---" || yamlStart.indent < result.indent) {
    return resultIdx;
  }
  const yamlIndent = yamlStart.indent;
  let j = yamlStartIdx + 1;
  while (j < entries.length) {
    const entry = entries[j];
    if (entry.indent < yamlIndent) {
      return j - 1;
    }
    if (entry.text === "..." && entry.indent <= yamlIndent) {
      return j;
    }
    if (entry.indent === yamlIndent && TAP_STRUCTURAL_BOUNDARY_RE.test(entry.text)) {
      return j - 1;
    }
    j += 1;
  }
  return entries.length - 1;
}

export function stripTapDirectiveBlocks(text) {
  if (!text || typeof text !== "string") return "";
  const rawLines = text.split(/\r?\n/);
  const entries = [];
  for (const rawLine of rawLines) {
    const leadMatch = rawLine.match(/^([ \t]*)/);
    const indent = leadMatch ? leadMatch[1].replace(/\t/g, "  ").length : 0;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    entries.push({ text: trimmed, raw: rawLine, indent });
  }
  if (entries.length === 0) return "";
  const kept = [];
  for (let i = 0; i < entries.length; i++) {
    if (isTapDirectiveResultLine(entries[i].text)) {
      i = skipTapYamlBlock(entries, i);
      continue;
    }
    kept.push(entries[i].raw);
  }
  return kept.join("\n");
}

function unquoteSimpleYamlScalar(val) {
  const s = typeof val === "string" ? val.trim() : "";
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function extractTapYamlDiagnosticLines(entries, anchorIdx, lineCap) {
  const anchor = entries[anchorIdx];
  if (!anchor || !TAP_NOT_OK_RE.test(anchor.text) || isTapDirectiveResultLine(anchor.text)) return null;
  const yamlStartIdx = anchorIdx + 1;
  if (yamlStartIdx >= entries.length || entries[yamlStartIdx].text !== "---") return null;
  const yamlIndent = entries[yamlStartIdx].indent;
  if (yamlIndent < anchor.indent) return null;

  const diagLines = [];
  const supplementLines = [];
  const fallbackStackLines = [];
  const otherLines = [];

  for (let j = yamlStartIdx + 1; j < entries.length; j++) {
    const entry = entries[j];
    if (entry.indent < yamlIndent) break;
    if (entry.text === "..." && entry.indent <= yamlIndent) break;
    if (entry.indent === yamlIndent && TAP_STRUCTURAL_BOUNDARY_RE.test(entry.text)) break;
    if (entry.indent !== yamlIndent) continue;

    const kvMatch = entry.text.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      otherLines.push(entry.text);
      continue;
    }
    const rawKey = kvMatch[1];
    const key = rawKey.toLowerCase();
    const val = kvMatch[2].trim();

    if (TAP_YAML_BLOCK_SCALAR_RE.test(val)) {
      const blockLines = [];
      let k = j + 1;
      while (k < entries.length && entries[k].indent > yamlIndent) {
        blockLines.push(entries[k].text);
        k += 1;
      }
      j = k - 1;
      if (blockLines.length === 0) continue;
      if (key === "error" || key === "message") {
        diagLines.push(`${rawKey}: ${blockLines[0]}`);
        for (let b = 1; b < blockLines.length; b++) {
          diagLines.push(blockLines[b]);
        }
      } else if (TAP_YAML_SUPPLEMENT_KEYS.has(key)) {
        supplementLines.push(`${rawKey}: ${blockLines[0]}`);
      } else if (key === "stack") {
        const userFrame = blockLines.find((l) => !/\(node:/.test(l)) || blockLines[0];
        if (userFrame) fallbackStackLines.push(userFrame);
      }
      continue;
    }

    if (TAP_YAML_SKIP_KEYS.has(key)) {
      continue;
    }
    if (key === "stack") {
      const cleanedStack = unquoteSimpleYamlScalar(val);
      if (cleanedStack) {
        if (!/\(node:/.test(cleanedStack)) {
          fallbackStackLines.unshift(cleanedStack);
        } else {
          fallbackStackLines.push(cleanedStack);
        }
      }
      continue;
    }
    if (key === "error" || key === "message") {
      const quoteChar = val.startsWith("'") ? "'" : val.startsWith('"') ? '"' : "";
      const isClosedQuote = (seg, isFirst) => {
        const body = isFirst ? seg.slice(1) : seg;
        if (!body.endsWith(quoteChar)) return false;
        if (quoteChar === "'") {
          let trailing = 0;
          for (let p = body.length - 1; p >= 0 && body[p] === "'"; p--) trailing += 1;
          return trailing % 2 === 1;
        }
        let bs = 0;
        for (let p = body.length - 2; p >= 0 && body[p] === "\\"; p--) bs += 1;
        return bs % 2 === 0;
      };
      if (quoteChar && !isClosedQuote(val, true)) {
        const quotedLines = [val.slice(1)];
        let k = j + 1;
        while (k < entries.length && entries[k].indent > yamlIndent) {
          const seg = entries[k].text;
          quotedLines.push(seg);
          k += 1;
          if (isClosedQuote(seg, false)) {
            break;
          }
        }
        j = k - 1;
        const lastIdx = quotedLines.length - 1;
        if (lastIdx >= 0 && quotedLines[lastIdx].endsWith(quoteChar)) {
          quotedLines[lastIdx] = quotedLines[lastIdx].slice(0, -1);
        }
        const cleanedQuoted = quotedLines
          .map((l) => (quoteChar === "'" ? l.replace(/''/g, "'") : l.replace(/\\"/g, '"')).trim())
          .filter(Boolean);
        if (cleanedQuoted.length > 0) {
          diagLines.push(`${rawKey}: ${cleanedQuoted[0]}`);
          for (let q = 1; q < cleanedQuoted.length; q++) {
            diagLines.push(cleanedQuoted[q]);
          }
        }
        continue;
      }
      const cleanedVal = unquoteSimpleYamlScalar(val);
      if (cleanedVal) {
        diagLines.push(`${rawKey}: ${cleanedVal}`);
      }
    } else if (TAP_YAML_SUPPLEMENT_KEYS.has(key)) {
      if (val) {
        supplementLines.push(`${rawKey}: ${val}`);
      }
    } else if (val) {
      otherLines.push(entry.text);
    }
  }

  const chosen = [anchor.text];
  const pushUnique = (list) => {
    for (const line of list) {
      if (chosen.length >= lineCap) break;
      if (!line || chosen.includes(line)) continue;
      chosen.push(line);
    }
  };
  pushUnique(diagLines);
  pushUnique(supplementLines);
  if (chosen.length === 1) {
    pushUnique(otherLines);
    pushUnique(fallbackStackLines);
  }
  return chosen;
}
const FAILURE_EXCERPT_CASE_HEADER_RE =
  /^\s*(?:●|❯|▶|×|✖|---\s*FAIL\b|FAIL(?:ED)?\b|not ok\b|File\s+"|In file\b|Test\s+\S|Suite\s+\S)/i;
const FAILURE_EXCERPT_DETAIL_ANCHOR_RE =
  /^\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|Error\s*:|Expected\s*:|Actual\s*:|E\s{2,})/i;

export function isPassingNoiseLine(line) {
  if (!line) return false;
  if (isTapDirectiveResultLine(line)) return true;
  if (TAP_NOT_OK_RE.test(line)) return false;
  if (TAP_OK_RE.test(line)) return true;
  return FAILURE_EXCERPT_PASS_NOISE_RE.test(line) || FAILURE_EXCERPT_PASS_LINE_TAIL_RE.test(line);
}

/**
 * Extract a concise, bounded failure excerpt (case name, first real error, and immediate context)
 * from failed test/build output. Reuses `isFailureAnchorLine()` (so `0 failed` / `0 errors` are
 * ignored), skips passing-test lines (e.g. `✔ handles error cases`, `PASS ...`, `... PASSED`,
 * `--- PASS:`, `... ok`), and returns `""` when no real error anchor exists so callers clear
 * stale excerpts.
 */
export function extractFailureExcerpt(text, { maxLines = 5, maxBytes = 500 } = {}) {
  if (!text || typeof text !== "string") return "";
  const lineCap = Number.isFinite(Number(maxLines)) && Number(maxLines) > 0 ? Math.floor(Number(maxLines)) : 5;
  const byteCap = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : 500;
  const cleanedText = stripAnsiAndProgress(text);
  const rawLines = cleanedText.split("\n");
  const entries = [];
  for (const rawLine of rawLines) {
    const cleanedRaw = rawLine.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
    const leadMatch = cleanedRaw.match(/^([ \t]*)/);
    const indent = leadMatch ? leadMatch[1].replace(/\t/g, "  ").length : 0;
    let line = cleanedRaw.replace(/\t+/g, " ").trim();
    if (typeof line.toWellFormed === "function") {
      line = line.toWellFormed();
    }
    if (!line) continue;
    if (line.startsWith("[agy-dart cli-filter:")) continue;
    entries.push({ text: line, indent });
  }
  if (entries.length === 0) return "";
  const lines = entries.map((e) => e.text);

  const skippedTapIndices = new Set();
  let firstAnchorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTapDirectiveResultLine(line)) {
      const skipEnd = skipTapYamlBlock(entries, i);
      for (let s = i; s <= skipEnd; s++) skippedTapIndices.add(s);
      i = skipEnd;
      continue;
    }
    if (
      isPassingNoiseLine(line) ||
      FAILURE_EXCERPT_NON_ANCHOR_RE.test(line) ||
      FAILURE_EXCERPT_SUITE_START_RE.test(line)
    ) {
      continue;
    }
    if (isFailureAnchorLine(line, { includeTimeout: true })) {
      firstAnchorIdx = i;
      break;
    }
  }
  if (firstAnchorIdx < 0) return "";

  let selectedLines = extractTapYamlDiagnosticLines(entries, firstAnchorIdx, lineCap);
  let anchorPosInSelected = 0;

  if (!selectedLines) {
    const chosenIndices = [];
    const prevIdx = firstAnchorIdx - 1;
    const prevLine = prevIdx >= 0 ? lines[prevIdx] : "";
    const shouldIncludePrev =
      prevIdx >= 0 &&
      !skippedTapIndices.has(prevIdx) &&
      !isPassingNoiseLine(prevLine) &&
      !FAILURE_EXCERPT_NON_ANCHOR_RE.test(prevLine) &&
      !FAILURE_EXCERPT_TAP_META_NOISE_RE.test(prevLine) &&
      (FAILURE_EXCERPT_CASE_HEADER_RE.test(prevLine) ||
        FAILURE_EXCERPT_DETAIL_ANCHOR_RE.test(lines[firstAnchorIdx]) ||
        firstAnchorIdx === lines.length - 1);

    if (shouldIncludePrev && lineCap > 1) {
      chosenIndices.push(prevIdx);
      anchorPosInSelected = 1;
    }
    chosenIndices.push(firstAnchorIdx);
    const seenLineTexts = new Set(chosenIndices.map((idx) => lines[idx]));
    const specSummaryCounterRe = /^ℹ\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i;
    for (let i = firstAnchorIdx + 1; i < lines.length && chosenIndices.length < lineCap; i++) {
      if (isTapDirectiveResultLine(lines[i])) {
        i = skipTapYamlBlock(entries, i);
        continue;
      }
      if (
        isPassingNoiseLine(lines[i]) ||
        specSummaryCounterRe.test(lines[i]) ||
        FAILURE_EXCERPT_NON_ANCHOR_RE.test(lines[i]) ||
        FAILURE_EXCERPT_TAP_META_NOISE_RE.test(lines[i])
      ) {
        continue;
      }
      if (seenLineTexts.has(lines[i])) {
        continue;
      }
      seenLineTexts.add(lines[i]);
      chosenIndices.push(i);
    }
    selectedLines = chosenIndices.map((idx) => lines[idx]);
  }

  const clipSafe = (str, cap) => {
    if (cap <= 0) return "";
    if (Buffer.byteLength(str, "utf8") <= cap) return str;
    const suffix = cap >= 24 ? "..." : "";
    const innerCap = Math.max(0, cap - Buffer.byteLength(suffix, "utf8"));
    let cut = truncateUtf8Safe(str, innerCap);
    if (cut.length > 0) {
      const lastCode = cut.charCodeAt(cut.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        cut = cut.slice(0, -1);
      }
    }
    return suffix && cut ? `${cut}${suffix}` : cut;
  };

  const fullJoined = selectedLines.join("\n");
  if (Buffer.byteLength(fullJoined, "utf8") <= byteCap) {
    return fullJoined;
  }

  const out = [];
  let usedBytes = 0;
  const perLineSoftCap =
    selectedLines.length > 1 ? Math.min(byteCap, Math.max(120, Math.floor(byteCap * 0.6))) : byteCap;

  for (let i = 0; i < selectedLines.length; i++) {
    const sepBytes = out.length > 0 ? 1 : 0;
    const rem = byteCap - usedBytes - sepBytes;
    if (rem <= 0) break;
    const isAnchorPos = i === anchorPosInSelected;
    const lineBudget = Math.min(rem, isAnchorPos && out.length === 0 ? Math.max(perLineSoftCap, Math.floor(byteCap * 0.7)) : perLineSoftCap);
    const rawLine = selectedLines[i];
    if (Buffer.byteLength(rawLine, "utf8") <= lineBudget) {
      out.push(rawLine);
      usedBytes += sepBytes + Buffer.byteLength(rawLine, "utf8");
    } else if (rem >= 24 || out.length === 0) {
      const clipped = clipSafe(rawLine, Math.min(rem, lineBudget));
      if (!clipped) break;
      out.push(clipped);
      usedBytes += sepBytes + Buffer.byteLength(clipped, "utf8");
    } else {
      break;
    }
  }

  let result = out.join("\n");
  if (Buffer.byteLength(result, "utf8") > byteCap) {
    result = clipSafe(result, byteCap);
  }
  return result;
}

const projectRulesCache = new Map();

export function resolveCdTargetCwd(baseCwd, cdPath) {
  if (!cdPath || typeof cdPath !== "string") return baseCwd || process.cwd();
  let expanded = cdPath;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(baseCwd || process.cwd(), expanded);
}

/** Take strictly the last <= maxBytes UTF-8 bytes without splitting a leading multi-byte character or stripping legitimate U+FFFD */
export function truncateTailUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 0;
  if (limit === 0) return "";
  const str = String(text);
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let start = Math.max(0, buf.length - limit);
  // Advance past any UTF-8 continuation bytes (10xxxxxx) to land strictly on a UTF-8 lead byte
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  let out = buf.subarray(start).toString("utf8");
  if (out.length > 0) {
    const firstCode = out.charCodeAt(0);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      out = out.slice(1);
    }
  }
  return out;
}

/** Preserve both head context (~35%) and failure tail/summary (~65%) within <= maxBytes UTF-8 */
export function truncateHeadTailUtf8Safe(
  text, maxBytes,
  marker = "\n... [middle omitted to stay <=8.8KB; tail failure/summary preserved] ...\n",
  maxChars = Number.MAX_SAFE_INTEGER
) {
  if (!text || maxBytes <= 0 || maxChars <= 0) return "";
  if (text.length <= maxChars && Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const avail = maxBytes - markerBytes;
  const availChars = maxChars - marker.length;
  const tailWithin = (bytes, chars) => truncateTailUtf8Safe(text.slice(-chars).replace(/^[\uDC00-\uDFFF]/, ""), bytes);
  if (avail < 200 || availChars < 64) return tailWithin(maxBytes, maxChars);
  const headBudget = Math.floor(avail * 0.35);
  const tailBudget = avail - headBudget;
  const headChars = Math.floor(availChars * 0.35);
  const head = truncateUtf8Safe(text.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, ""), headBudget).trimEnd();
  const tail = tailWithin(tailBudget, availChars - headChars).trimStart();
  return `${head}${marker}${tail}`;
}

/**
 * Compact oversized failing command output while preserving error anchor blocks (±3 lines)
 * hidden anywhere in the output (including the middle of 30 KB+ logs), prioritizing:
 *   1. First root-cause error block
 *   2. Last error block
 *   3. Head command summary & Tail exit/test summary
 * Strictly enforces <= maxBytes UTF-8 without splitting multi-byte characters.
 * Returns null if no error anchors are found so callers fall back to head/tail truncation.
 */
export function compactFailureWithErrorAnchors(text, maxBytes) {
  if (!text || typeof text !== "string" || !Number.isFinite(maxBytes) || maxBytes < 450) {
    return null;
  }
  const normalized = text.includes("\r") ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : text;
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  const lines = normalized.split("\n");
  if (lines.length < 10) {
    return null;
  }

  // 1. Locate error anchor lines (stripping zero-count clauses like "0 failed" / "0 errors" / "fail 0")
  const anchors = [];
  const anchorSet = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (isFailureAnchorLine(lines[i])) {
      anchors.push(i);
      anchorSet.add(i);
    }
  }
  if (anchors.length === 0) {
    return null;
  }

  // 2. Build merged ±3 line windows around error anchors while retaining exact anchor indices per block
  const CTX_RADIUS = 3;
  const blocks = [];
  for (const a of anchors) {
    const start = Math.max(0, a - CTX_RADIUS);
    const end = Math.min(lines.length - 1, a + CTX_RADIUS);
    if (blocks.length > 0 && start <= blocks[blocks.length - 1].end + 1) {
      const prev = blocks[blocks.length - 1];
      prev.end = Math.max(prev.end, end);
      prev.anchors.push(a);
    } else {
      blocks.push({ start, end, anchors: [a] });
    }
  }

  const markerStr = (omitted) => `... [${omitted} lines omitted] ...`;
  const CLIP_SUFFIX = " ...[clipped]";
  const CLIP_SUFFIX_BYTES = Buffer.byteLength(CLIP_SUFFIX, "utf8");

  // Map<lineIdx, { text, prio, bytes }> where smaller prio = higher retention priority
  const chosen = new Map();
  let usedBytes = 0;

  const clipLineText = (rawLine, maxLineBytes, fromTail = false) => {
    const cap = Math.max(16, Math.floor(maxLineBytes));
    if (Buffer.byteLength(rawLine, "utf8") <= cap) return rawLine;
    if (cap <= CLIP_SUFFIX_BYTES + 16) {
      return fromTail ? truncateTailUtf8Safe(rawLine, cap) : truncateUtf8Safe(rawLine, cap);
    }
    const innerCap = cap - CLIP_SUFFIX_BYTES;
    return fromTail
      ? `...[clipped] ${truncateTailUtf8Safe(rawLine, innerCap)}`
      : `${truncateUtf8Safe(rawLine, innerCap)}${CLIP_SUFFIX}`;
  };

  const trySelectLine = (idx, budgetCap, prio, { allowClip = false, maxLineShare = 0, fromTail = false } = {}) => {
    if (idx < 0 || idx >= lines.length) return false;
    if (chosen.has(idx)) {
      const existing = chosen.get(idx);
      if (prio < existing.prio) existing.prio = prio;
      return true;
    }
    const rem = budgetCap - usedBytes;
    if (rem < 2) return false;
    const raw = lines[idx];
    const rawBytes = Buffer.byteLength(raw, "utf8") + 1;
    const effectiveLineCap =
      allowClip && maxLineShare > 0 ? Math.min(rem - 1, Math.max(120, maxLineShare)) : rem - 1;
    if (rawBytes <= rem && (!allowClip || maxLineShare <= 0 || rawBytes - 1 <= effectiveLineCap)) {
      chosen.set(idx, { text: raw, prio, bytes: rawBytes });
      usedBytes += rawBytes;
      return true;
    }
    if (allowClip && effectiveLineCap >= 48) {
      const clipped = clipLineText(raw, effectiveLineCap, fromTail);
      const cb = Buffer.byteLength(clipped, "utf8") + 1;
      if (cb <= rem) {
        chosen.set(idx, { text: clipped, prio, bytes: cb });
        usedBytes += cb;
        return true;
      }
    }
    return false;
  };

  const addRangeWithBudget = (start, end, allocBudget, prio, fromTail = false) => {
    if (allocBudget <= 0 || start > end) return 0;
    const startUsed = usedBytes;
    const cap = startUsed + allocBudget;
    let addedAny = false;
    const step = fromTail ? -1 : 1;
    for (let i = fromTail ? end : start; fromTail ? i >= start : i <= end; i += step) {
      if (chosen.has(i)) {
        const ex = chosen.get(i);
        if (prio < ex.prio) ex.prio = prio;
        addedAny = true;
        continue;
      }
      const rem = cap - usedBytes;
      if (rem < 24) break;
      const lineShare = Math.min(rem - 1, Math.max(160, Math.floor(allocBudget * 0.65)));
      const effPrio =
        fromTail && (anchorSet.has(i) || i === lines.length - 1) ? Math.min(prio, 2) : prio;
      if (!trySelectLine(i, cap, effPrio, { allowClip: !addedAny || rem >= 96, maxLineShare: lineShare, fromTail })) {
        break;
      }
      addedAny = true;
    }
    return usedBytes - startUsed;
  };

  const addErrorBlockWithBudget = (block, allocBudget, anchorPrio, ctxPrio, { fromLastAnchor = false } = {}) => {
    if (allocBudget <= 0 || !block) return 0;
    const startUsed = usedBytes;
    const cap = startUsed + allocBudget;
    const singleLineCap = Math.max(180, Math.floor(allocBudget * 0.55));
    const orderedAnchors = fromLastAnchor ? block.anchors.slice().reverse() : block.anchors;

    for (const a of orderedAnchors) {
      if (cap - usedBytes < 32) break;
      // Pass 1 for this anchor: anchor line itself + immediate following stack lines
      trySelectLine(a, cap, anchorPrio, { allowClip: true, maxLineShare: singleLineCap, fromTail: false });
      const followEnd = Math.min(block.end, a + CTX_RADIUS);
      for (let i = a + 1; i <= followEnd; i++) {
        if (cap - usedBytes < 32) break;
        const p = anchorSet.has(i) ? anchorPrio : anchorPrio + 0.5;
        trySelectLine(i, cap, p, { allowClip: true, maxLineShare: singleLineCap, fromTail: false });
      }
      // Pass 2 for this anchor: preceding ±3 context lines (avoids fragmented tiny omission markers)
      const prevStart = Math.max(block.start, a - CTX_RADIUS);
      for (let i = prevStart; i < a; i++) {
        if (cap - usedBytes < 32) break;
        if (chosen.has(i)) continue;
        trySelectLine(i, cap, ctxPrio, { allowClip: false });
      }
    }
    return usedBytes - startUsed;
  };

  // Reserve space for omitted-line markers (head, first error, last error, tail)
  const BASE_MARKER_RESERVE = 200;
  const EXTRA_BLOCK_MARKER_COST = 42;
  const contentBudget = Math.max(220, maxBytes - BASE_MARKER_RESERVE);

  // Priority A: Tail exit/test summary (last 15 lines, up to 24% of budget)
  const tailStart = Math.max(0, lines.length - 15);
  addRangeWithBudget(tailStart, lines.length - 1, Math.floor(contentBudget * 0.24), 3, true);

  // Priority B: Head command overview (first 6 lines, up to 12% of budget)
  const headEnd = Math.min(lines.length - 1, 5);
  addRangeWithBudget(0, headEnd, Math.floor(contentBudget * 0.12), 5, false);

  // Priority C: Error anchor blocks (first root-cause block + last error block + intermediate blocks)
  const remAfterHeadTail = Math.max(0, contentBudget - usedBytes);
  if (blocks.length === 1) {
    if (blocks[0].anchors.length >= 2) {
      const leadBudget = Math.floor(remAfterHeadTail * 0.55);
      addErrorBlockWithBudget(blocks[0], leadBudget, 1, 4, { fromLastAnchor: false });
      const tailAnchorBudget = Math.max(0, contentBudget - usedBytes);
      addErrorBlockWithBudget(blocks[0], tailAnchorBudget, 2, 4, { fromLastAnchor: true });
    } else {
      addErrorBlockWithBudget(blocks[0], remAfterHeadTail, 1, 4, { fromLastAnchor: false });
    }
  } else {
    const firstBlockBudget = Math.floor(remAfterHeadTail * 0.52);
    addErrorBlockWithBudget(blocks[0], firstBlockBudget, 1, 4);

    const lastBlock = blocks[blocks.length - 1];
    const remBeforeLast = Math.max(0, contentBudget - usedBytes);
    const lastBlockBudget = blocks.length === 2 ? remBeforeLast : Math.floor(remBeforeLast * 0.55);
    addErrorBlockWithBudget(lastBlock, lastBlockBudget, 2, 4, { fromLastAnchor: true });

    for (let bi = 1; bi < blocks.length - 1; bi++) {
      const rem = contentBudget - usedBytes - EXTRA_BLOCK_MARKER_COST;
      if (rem < 120) break;
      const added = addErrorBlockWithBudget(
        blocks[bi],
        Math.min(rem, Math.floor(contentBudget * 0.25)),
        6,
        6.5
      );
      if (added > 0) {
        usedBytes += EXTRA_BLOCK_MARKER_COST;
      }
    }
  }

  // Priority D: Expand tail context upward if substantial unused budget remains
  const unusedBudget = contentBudget - usedBytes;
  if (unusedBudget > 400) {
    addRangeWithBudget(Math.max(0, lines.length - 60), lines.length - 1, unusedBudget, 7, true);
  }

  if (chosen.size === 0) {
    return null;
  }

  const assembleSelected = () => {
    const sortedIdx = Array.from(chosen.keys()).sort((a, b) => a - b);
    const outParts = [];
    if (sortedIdx[0] > 0) {
      outParts.push(markerStr(sortedIdx[0]));
    }
    for (let k = 0; k < sortedIdx.length; k++) {
      const idx = sortedIdx[k];
      if (k > 0 && idx > sortedIdx[k - 1] + 1) {
        outParts.push(markerStr(idx - sortedIdx[k - 1] - 1));
      }
      outParts.push(chosen.get(idx).text);
    }
    const lastChosen = sortedIdx[sortedIdx.length - 1];
    if (lastChosen < lines.length - 1) {
      outParts.push(markerStr(lines.length - 1 - lastChosen));
    }
    return outParts.join("\n");
  };

  let assembled = assembleSelected();
  // Exact priority-preserving trim: drop lowest-priority lines first so middle root-cause anchors are NEVER sliced out
  while (Buffer.byteLength(assembled, "utf8") > maxBytes && chosen.size > 1) {
    let victimIdx = -1;
    let worstPrio = -1;
    let worstBytes = -1;
    for (const [idx, entry] of chosen.entries()) {
      if (entry.prio > worstPrio || (entry.prio === worstPrio && entry.bytes > worstBytes)) {
        worstPrio = entry.prio;
        worstBytes = entry.bytes;
        victimIdx = idx;
      }
    }
    if (victimIdx < 0) break;
    chosen.delete(victimIdx);
    assembled = assembleSelected();
  }
  if (Buffer.byteLength(assembled, "utf8") > maxBytes && chosen.size === 1) {
    const [[onlyIdx, entry]] = chosen.entries();
    const overhead = Buffer.byteLength(assembled, "utf8") - Buffer.byteLength(entry.text, "utf8");
    const clipped = clipLineText(entry.text, Math.max(16, maxBytes - overhead), false);
    chosen.set(onlyIdx, { ...entry, text: clipped, bytes: Buffer.byteLength(clipped, "utf8") + 1 });
    assembled = assembleSelected();
  }
  if (Buffer.byteLength(assembled, "utf8") > maxBytes) {
    assembled = truncateUtf8Safe(assembled, maxBytes);
  }
  return assembled;
}

/** Strip ANSI CSI/OSC sequences and collapse carriage-return progress spinner overwrites */
export function stripAnsiAndProgress(text) {
  if (!text) return "";
  // Strip ANSI OSC and CSI escape sequences
  let clean = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");

  // Normalize CRLF -> LF first, then resolve standalone \r progress bar overwrites
  clean = clean.replace(/\r\n/g, "\n");
  if (clean.includes("\r")) {
    clean = clean
      .split("\n")
      .map((line) => {
        if (!line.includes("\r")) return line;
        const parts = line.split("\r").filter((p) => p.length > 0);
        return parts.length > 0 ? parts[parts.length - 1] : "";
      })
      .join("\n");
  }
  return clean;
}

/** Sanitize diagnostic strings (rule IDs/patterns) against ANSI/control injection and UTF-16 surrogate splits */
function sanitizeDiagText(val, maxBytes = 80) {
  if (val === undefined || val === null) return "";
  let clean = stripAnsiAndProgress(String(val));
  if (typeof clean.toWellFormed === "function") {
    clean = clean.toWellFormed();
  }
  clean = clean.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return truncateUtf8Safe(clean, maxBytes);
}

/**
 * Resolve a command name on Windows honoring per-directory PATHEXT precedence.
 * Returns the full path ONLY when the highest-priority match is a native `.exe`;
 * immediately returns `null` if an earlier PATH directory or extension matches a `.cmd`/`.bat`/`.ps1` shim
 * (preventing stale global `.exe` binaries later in PATH from hijacking local project shims).
 */
export function resolveWindowsExeOnPath(cmdName, cwd = process.cwd(), env = process.env) {
  if (!cmdName || typeof cmdName !== "string" || /[\r\n\0]/.test(cmdName)) return null;
  const hasSep = cmdName.includes("/") || cmdName.includes("\\");
  const tryFile = (p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  };

  const baseName = path.win32.basename(cmdName);
  const explicitExt = path.win32.extname(baseName).toLowerCase();
  const pathextRaw =
    env?.PATHEXT || env?.Pathext || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1";
  const exts = [];
  for (const rawExt of pathextRaw.split(";")) {
    const cleanExt = rawExt.trim().toLowerCase();
    if (!cleanExt) continue;
    const normExt = cleanExt.startsWith(".") ? cleanExt : `.${cleanExt}`;
    if (!exts.includes(normExt)) exts.push(normExt);
  }
  for (const mustExt of [".com", ".exe", ".bat", ".cmd", ".ps1"]) {
    if (!exts.includes(mustExt)) exts.push(mustExt);
  }

  const checkDirCandidate = (dirPath, name) => {
    const targetBase = path.join(dirPath, name);
    if (explicitExt && exts.includes(explicitExt)) {
      const exactHit = tryFile(targetBase);
      if (exactHit) {
        return { matched: true, exePath: explicitExt === ".exe" ? exactHit : null };
      }
      return { matched: false, exePath: null };
    }
    for (const ext of exts) {
      const hit = tryFile(`${targetBase}${ext}`);
      if (hit) {
        return { matched: true, exePath: ext === ".exe" ? hit : null };
      }
    }
    if (explicitExt) {
      const rawHit = tryFile(targetBase);
      if (rawHit) {
        return { matched: true, exePath: explicitExt === ".exe" ? rawHit : null };
      }
    }
    return { matched: false, exePath: null };
  };

  if (hasSep) {
    const resolved = path.resolve(cwd || process.cwd(), cmdName);
    const res = checkDirCandidate(path.dirname(resolved), path.basename(resolved));
    return res.matched ? res.exePath : null;
  }

  const pathEnv = env?.PATH || env?.Path || "";
  const searchDirs = [];
  const nodeBinDirs = ["node_modules/.bin"];
  void nodeBinDirs;
  for (const dir of pathEnv.split(";")) {
    const cleanDir = dir.trim().replace(/^"|"$/g, "");
    if (cleanDir) searchDirs.push(cleanDir);
  }
  for (const cleanDir of searchDirs) {
    const res = checkDirCandidate(cleanDir, cmdName);
    if (res.matched) {
      return res.exePath;
    }
  }
  return null;
}

/**
 * Parse a simple single command line into `{ bin, args }` for direct `shell: false` execution on Windows.
 * Handles PowerShell `''` escaped single quotes inside `'...'`, preserves UNC `\\server\share` inside `"..."`,
 * and resolves trailing backslash `"E:\repo\"` vs C-style `\"` accurately.
 */
export function tryParseSimpleCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const tokens = [];
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;
    let tok = "";
    let hasContent = false;
    while (i < len && !/\s/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === "'") {
        hasContent = true;
        const openIdx = i;
        i++;
        let closed = false;
        while (i < len) {
          if (cmd[i] === "'") {
            if (i + 1 < len && cmd[i + 1] === "'") {
              // Empty `''` standalone token vs PowerShell escaped `''` inside `'don''t'` or `''''`
              if (i === openIdx + 1 && (i + 2 >= len || /\s/.test(cmd[i + 2]))) {
                i += 2;
                closed = true;
                break;
              }
              tok += "'";
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          tok += cmd[i];
          i++;
        }
        if (!closed) return null;
      } else if (ch === '"') {
        hasContent = true;
        i++;
        let closed = false;
        while (i < len) {
          if (cmd[i] === "\\" && i + 1 < len) {
            if (cmd[i + 1] === "\\" && i + 2 < len && cmd[i + 2] === '"') {
              // Escaped trailing backslash before closing quote: `"E:\\repo\\"` -> `E:\repo\`
              tok += "\\";
              i += 3;
              closed = true;
              break;
            }
            if (cmd[i + 1] === '"') {
              // If another `"` exists later in `cmd`, treat `\"` as escaped quote; otherwise treat `\` as
              // Windows trailing path separator (`"E:\repo\"`) and `"` as the closing quote.
              if (cmd.indexOf('"', i + 2) !== -1) {
                tok += '"';
                i += 2;
                continue;
              }
              tok += "\\";
              i += 2;
              closed = true;
              break;
            }
          }
          if (cmd[i] === '"') {
            i++;
            closed = true;
            break;
          }
          tok += cmd[i];
          i++;
        }
        if (!closed) return null;
      } else {
        if (/[|;&<>`$()%!{}#\r\n\0]/.test(ch)) return null;
        tok += ch;
        hasContent = true;
        i++;
      }
    }
    if (hasContent) tokens.push(tok);
  }
  if (tokens.length === 0) return null;
  return { bin: tokens[0], args: tokens.slice(1) };
}

function hasSiblingPs1Script(exePath) {
  if (!exePath || typeof exePath !== "string") return false;
  const dir = path.dirname(exePath);
  const stem = path.basename(exePath, path.extname(exePath));
  if (!dir || !stem) return false;
  const ps1Path = path.join(dir, `${stem}.ps1`);
  try {
    return fs.existsSync(ps1Path) && fs.statSync(ps1Path).isFile();
  } catch {
    return false;
  }
}

function hasWindowsCrossShellHazard(innerCmd, targetCwd, env = process.env) {
  if (!innerCmd || typeof innerCmd !== "string") return false;
  let hasUnquotedComma = false;
  let hasStandaloneDoubleDash = false;
  let hasSingleQuotedDoubleQuote = false;

  let i = 0;
  const len = innerCmd.length;
  while (i < len) {
    while (i < len && /\s/.test(innerCmd[i])) i++;
    if (i >= len) break;
    const tokStart = i;
    let tokHasQuote = false;
    while (i < len && !/\s/.test(innerCmd[i])) {
      const ch = innerCmd[i];
      if (ch === "'") {
        tokHasQuote = true;
        i++;
        while (i < len) {
          if (innerCmd[i] === "'") {
            if (i + 1 < len && innerCmd[i + 1] === "'") {
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (innerCmd[i] === '"') hasSingleQuotedDoubleQuote = true;
          i++;
        }
      } else if (ch === '"') {
        tokHasQuote = true;
        i++;
        while (i < len) {
          if (innerCmd[i] === "\\" && i + 1 < len) {
            if (innerCmd[i + 1] === "\\" && i + 2 < len && innerCmd[i + 2] === '"') {
              i += 3;
              break;
            }
            if (innerCmd[i + 1] === '"') {
              if (innerCmd.indexOf('"', i + 2) !== -1) {
                i += 2;
                continue;
              }
              i += 2;
              break;
            }
          }
          if (innerCmd[i] === '"') {
            i++;
            break;
          }
          i++;
        }
      } else {
        if (ch === ",") hasUnquotedComma = true;
        i++;
      }
    }
    const rawTok = innerCmd.slice(tokStart, i);
    if (!tokHasQuote && rawTok === "--") {
      hasStandaloneDoubleDash = true;
    }
  }

  if (hasUnquotedComma) {
    return true;
  }
  if (hasStandaloneDoubleDash || hasSingleQuotedDoubleQuote) {
    const parsed = tryParseSimpleCommand(innerCmd);
    const exePath = parsed ? resolveWindowsExeOnPath(parsed.bin, targetCwd, env) : null;
    if (!parsed || !exePath) {
      return true;
    }
    if (hasStandaloneDoubleDash && !/\.exe$/i.test(parsed.bin) && hasSiblingPs1Script(exePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Linear O(N) tokenizer for `git` / `git.exe` invocations with safe leading global options.
 * Supports `-C <path>`, `-C<path>`, `--no-pager`, `-P`, `--git-dir <path>` / `--git-dir=<path>`,
 * and `--work-tree <path>` / `--work-tree=<path>`.
 * Rejects unclosed quotes, unknown/unsafe leading flags (e.g. `-c`, `--exec-path`, `--paginate`,
 * `--help`, `--version`), and unquoted shell operators before the subcommand.
 */
export function parseGitSubcommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const len = cmd.length;
  let i = 0;

  const readToken = () => {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) return null;
    const start = i;
    let unquoted = "";
    let hasQuote = false;
    while (i < len && !/\s/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        hasQuote = true;
        const quote = ch;
        i++;
        let closed = false;
        while (i < len) {
          if (quote === '"' && cmd[i] === "\\" && i + 1 < len) {
            const nxt = cmd[i + 1];
            if (nxt === '"' || nxt === "\\") {
              unquoted += nxt;
              i += 2;
              continue;
            }
          }
          if (cmd[i] === quote) {
            i++;
            closed = true;
            break;
          }
          unquoted += cmd[i];
          i++;
        }
        if (!closed) return { invalid: true };
      } else {
        if (/[|;&<>`$()\r\n\0]/.test(ch)) {
          if (i === start) return { operator: true };
          break;
        }
        unquoted += ch;
        i++;
      }
    }
    return {
      raw: cmd.slice(start, i),
      value: unquoted,
      hasQuote,
      start,
      end: i
    };
  };

  const first = readToken();
  if (!first || first.invalid || first.operator || first.hasQuote) return null;
  if (!/^git(?:\.exe)?$/i.test(first.value)) return null;

  const MAX_GLOBAL_OPTS = 16;
  for (let optionCount = 0; optionCount <= MAX_GLOBAL_OPTS; optionCount++) {
    const tok = readToken();
    if (!tok || tok.invalid || tok.operator) return null;

    if (!tok.hasQuote && (tok.value === "--no-pager" || tok.value === "-P")) {
      continue;
    }
    if (!tok.hasQuote && (tok.value === "-C" || tok.value === "--git-dir" || tok.value === "--work-tree")) {
      const arg = readToken();
      if (!arg || arg.invalid || arg.operator || !arg.value) return null;
      continue;
    }
    const startsQuoted = tok.raw.startsWith('"') || tok.raw.startsWith("'");
    if (
      !startsQuoted &&
      (/^--(?:git-dir|work-tree)=.+/.test(tok.value) || /^-C.+/.test(tok.value))
    ) {
      continue;
    }

    if (tok.hasQuote || tok.value.startsWith("-")) {
      return null;
    }

    if (!/^[a-z][a-z0-9-]*$/i.test(tok.value)) {
      return null;
    }

    return {
      subcommand: tok.value.toLowerCase(),
      subcommandStart: tok.start,
      subcommandEnd: tok.end,
      rest: cmd.slice(tok.end)
    };
  }

  return null;
}

const PKG_MANAGER_VALUE_FLAGS = new Set([
  "--prefix",
  "--cwd",
  "--dir",
  "--workspace",
  "--filter",
  "--loglevel"
]);
const PKG_MANAGER_BOOL_FLAGS = new Set([
  "--silent",
  "--workspaces",
  "--ws",
  "--workspace-root",
  "--recursive",
  "-r",
  "--if-present",
  "--no-audit",
  "--no-fund"
]);

/**
 * Linear O(N) tokenizer for `npm`/`pnpm`/`yarn`/`bun` invocations with safe leading options
 * (e.g. `--prefix <dir>`, `-C <dir>`, `--cwd <dir>`, `--dir <dir>`, `--workspace <pkg>`, `--filter <pkg>`).
 * Rejects unclosed quotes, unknown leading flags, missing option values, and shell operators before the subcommand.
 */
export function parsePkgManagerCommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const len = cmd.length;
  let i = 0;

  const readToken = () => {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) return null;
    const start = i;
    let unquoted = "";
    let hasQuote = false;
    while (i < len && !/\s/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        hasQuote = true;
        const quote = ch;
        i++;
        let closed = false;
        while (i < len) {
          if (quote === "'" && cmd[i] === "'" && i + 1 < len && cmd[i + 1] === "'") {
            unquoted += "'";
            i += 2;
            continue;
          }
          if (quote === '"' && cmd[i] === "\\" && i + 1 < len) {
            if (cmd[i + 1] === "\\" && i + 2 < len && cmd[i + 2] === '"') {
              unquoted += "\\";
              i += 3;
              closed = true;
              break;
            }
            if (cmd[i + 1] === '"') {
              if (cmd.indexOf('"', i + 2) !== -1) {
                unquoted += '"';
                i += 2;
                continue;
              }
              unquoted += "\\";
              i += 2;
              closed = true;
              break;
            }
          }
          if (cmd[i] === quote) {
            i++;
            closed = true;
            break;
          }
          unquoted += cmd[i];
          i++;
        }
        if (!closed) return { invalid: true };
      } else {
        if (/[|;&<>`$()\r\n\0]/.test(ch)) {
          if (i === start) return { operator: true };
          break;
        }
        unquoted += ch;
        i++;
      }
    }
    return {
      raw: cmd.slice(start, i),
      value: unquoted,
      hasQuote,
      start,
      end: i
    };
  };

  const first = readToken();
  if (!first || first.invalid || first.operator || first.hasQuote) return null;
  const binMatch = /^(npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?$/i.exec(first.value);
  if (!binMatch) return null;
  const manager = binMatch[1].toLowerCase();

  const consumeSafeLeadingOpts = (maxOpts = 16) => {
    for (let optCount = 0; optCount <= maxOpts; optCount++) {
      const tok = readToken();
      if (!tok || tok.invalid || tok.operator) return null;
      if (!tok.hasQuote && PKG_MANAGER_BOOL_FLAGS.has(tok.value)) {
        continue;
      }
      if (
        !tok.hasQuote &&
        (PKG_MANAGER_VALUE_FLAGS.has(tok.value) ||
          tok.value === "-C" ||
          ((manager === "pnpm" || manager === "bun") && tok.value === "-F"))
      ) {
        const arg = readToken();
        if (!arg || arg.invalid || arg.operator || !arg.value) return null;
        continue;
      }
      const startsQuoted = tok.raw.startsWith('"') || tok.raw.startsWith("'");
      if (
        !startsQuoted &&
        (/^--(?:prefix|cwd|dir|workspace|filter|loglevel)=.+/.test(tok.value) ||
          /^-C.+/.test(tok.value) ||
          ((manager === "pnpm" || manager === "bun") && /^-F.+/.test(tok.value)))
      ) {
        continue;
      }
      if (tok.hasQuote || tok.value.startsWith("-")) {
        return null;
      }
      return tok;
    }
    return null;
  };

  let tok = consumeSafeLeadingOpts(16);
  if (!tok) return null;

  // Support `yarn [--cwd dir] workspace <pkg> [run] <script>`
  if (manager === "yarn" && tok.value.toLowerCase() === "workspace") {
    const pkgTok = readToken();
    if (!pkgTok || pkgTok.invalid || pkgTok.operator || !pkgTok.value || pkgTok.value.startsWith("-")) {
      return null;
    }
    tok = consumeSafeLeadingOpts(8);
    if (!tok) return null;
  }

  const action = tok.value.toLowerCase();
  if (action === "run" || action === "run-script") {
    const scriptTok = consumeSafeLeadingOpts(8);
    if (!scriptTok || !/^[a-z0-9][a-z0-9:._-]*$/i.test(scriptTok.value)) return null;
    return {
      manager,
      action: "run",
      subcommand: scriptTok.value.toLowerCase(),
      subcommandStart: scriptTok.start,
      subcommandEnd: scriptTok.end,
      rest: cmd.slice(scriptTok.end)
    };
  }

  if (!/^[a-z0-9][a-z0-9:._-]*$/i.test(tok.value)) return null;
  return {
    manager,
    action,
    subcommand: action,
    subcommandStart: tok.start,
    subcommandEnd: tok.end,
    rest: cmd.slice(tok.end)
  };
}

/**
 * Returns true if the command contains shell pipelines, redirections, chaining,
 * subshells, newlines, NUL bytes, cmd.exe expansion/escape characters (`%`, `!`,
 * non-git-rev `^`), or PowerShell script blocks/splatting (`{`, `}`, leading `@` / `@(` / `@{`).
 * Prevents both shell injection and cross-shell semantic drift when rewriting via cli-filter.mjs.
 */
export function hasUnsafeShellSyntax(cmd) {
  if (!cmd || typeof cmd !== "string") return true;
  if (/[\r\n\0|;&<>`$()%!{}]/.test(cmd)) return true;
  // PowerShell splatting (`@var`), array/hash/here-string (`@(`, `@{`, `@"`, `@'`), or cmd `@echo`
  if (/(?:^|\s)@|@[({"']/.test(cmd)) return true;
  // Reject unquoted `#` (PowerShell / POSIX shell comment truncates subsequent arguments)
  {
    let q = null;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (q) {
        if (q === '"' && ch === "\\" && i + 1 < cmd.length) {
          i++;
          continue;
        }
        if (ch === q) q = null;
      } else if (ch === "'" || ch === '"') {
        q = ch;
      } else if (ch === "#") {
        return true;
      }
    }
  }
  // Caret `^`: cmd.exe escape char. Only allow benign git parent-revspec suffixes (e.g. `git diff HEAD^`, `HEAD^1..HEAD`).
  if (cmd.includes("^")) {
    const gitParsed = parseGitSubcommand(cmd);
    if (!gitParsed || !["diff", "log", "show"].includes(gitParsed.subcommand)) return true;
    // Never allow `^` inside leading git global option arguments (e.g. `-C bad^dir`), only in revspecs after subcommand.
    if (cmd.slice(0, gitParsed.subcommandEnd).includes("^")) return true;
    const strippedGitRefs = gitParsed.rest.replace(/(?<=[A-Za-z0-9_.-])\^+(?:\d+)?(?=\s|\.\.|$)/g, "");
    if (strippedGitRefs.includes("^")) return true;
  }
  return false;
}

const LEADING_SAFE_CD_RE =
  /^(cd(?:\s+\/d)?\s+)("(?:[^"`$%()|;&<>!^{}@\0\r\n]+)"|'(?:[^'`$%()|;&<>!^{}@\0\r\n]+)'|[^\s"'`$%()|;&<>!^{}@\0\r\n]+)(\s+&&\s+)([\s\S]+)$/i;
const TRAILING_STDERR_REDIRECT_RE = /^([\s\S]+?)\s+(2>&1)$/;

/**
 * Safely unwrap optional single leading `cd [/d] <safe_path> && ` and optional
 * single trailing `2>&1`. Rejects subshells, extra chaining, pipes, file redirects,
 * backticks, `$()`, NUL bytes, and unsafe cd targets.
 * Returns { cdPrefix, cdPath, innerCommand, hasStderrRedirect, trailingRedirect } or null.
 */
export function unwrapSafeCompoundCommand(commandLine) {
  if (!commandLine || typeof commandLine !== "string") return null;
  if (/[\r\n\0]/.test(commandLine)) return null;
  const trimmed = commandLine.trim();
  if (!trimmed) return null;

  let cdPrefix = "";
  let cdPath = null;
  let rest = trimmed;

  const cdMatch = LEADING_SAFE_CD_RE.exec(trimmed);
  if (cdMatch) {
    const rawTarget = cdMatch[2];
    let unquoted = rawTarget;
    if (
      (rawTarget.startsWith('"') && rawTarget.endsWith('"')) ||
      (rawTarget.startsWith("'") && rawTarget.endsWith("'"))
    ) {
      unquoted = rawTarget.slice(1, -1);
    }
    if (!unquoted.trim()) return null;
    // Reject `cd -` / `cd "-"` (depends on shell OLDPWD) or unknown cd flags
    if (unquoted.startsWith("-")) return null;
    // Reject `cd ~otheruser` (only `~`, `~/...`, `~\...` are safely expanded)
    if (unquoted.startsWith("~") && unquoted !== "~" && !unquoted.startsWith("~/") && !unquoted.startsWith("~\\")) {
      return null;
    }
    // Reject bare `cd /d && ...` (backtracked flag with no target) or Windows glued `cd /dC:\x` / `cd /d\foo`
    if (
      unquoted.toLowerCase() === "/d" ||
      /^\/d(?:[A-Za-z]:|\\)/i.test(unquoted) ||
      (process.platform === "win32" && /^\/d[^/]/i.test(unquoted))
    ) {
      return null;
    }
    cdPrefix = `${cdMatch[1]}${rawTarget}${cdMatch[3]}`;
    cdPath = unquoted;
    rest = cdMatch[4].trim();
  }

  let innerCommand = rest;
  let hasStderrRedirect = false;
  let trailingRedirect = "";

  const redirMatch = TRAILING_STDERR_REDIRECT_RE.exec(rest);
  if (redirMatch) {
    innerCommand = redirMatch[1].trim();
    hasStderrRedirect = true;
    trailingRedirect = " 2>&1";
  }

  if (!innerCommand || hasUnsafeShellSyntax(innerCommand)) {
    return null;
  }

  return {
    cdPrefix,
    cdPath,
    innerCommand,
    hasStderrRedirect,
    trailingRedirect
  };
}

const SKIP_FLAGS_RE =
  /(?:^|\s)(?:--help|-h|--version|-V|--watch|-w|--ui|--interactive|-i|--json|--porcelain(?:=\S+)?|--short|-s|--stat|--numstat|--shortstat|--name-only|--name-status|--format(?:=\S+)?|--pretty(?:=\S+)?|--reporter(?:=|\s+)json|(?:--output|-o)(?:=|\s+)(?:json|yaml|jsonpath\S*|go-template\S*)|-o(?:json|yaml))(?=\s|$)/;

function compactLinesBudget(lines, maxBytes) {
  const out = [];
  let used = 0;
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const b = Buffer.byteLength(line, "utf8") + 1;
    if (used + b > maxBytes) {
      omitted = lines.length - i;
      break;
    }
    out.push(line);
    used += b;
  }
  return { text: out.join("\n"), omitted };
}

/**
 * Defensive zero-dep ReDoS validator for user-provided project filter regexes.
 * Rejects nested quantifiers (e.g. (a+)+, ([a-z]+)*, (.*a){10}), ambiguous
 * quantified alternations (e.g. (a|aa)+), backreferences, huge bounds, and invalid syntax.
 */
export function isSafeRegex(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_CUSTOM_REGEX_LENGTH) {
    return false;
  }

  const readQuantifier = (str, pos) => {
    if (pos >= str.length) return null;
    const ch = str[pos];
    if (ch === "+" || ch === "*") {
      const lazy = str[pos + 1] === "?" ? 1 : 0;
      return {
        end: pos + 1 + lazy,
        isRepeating: true,
        isUnbounded: true,
        isVariableRepeat: true,
        minZero: ch === "*"
      };
    }
    if (ch === "?") {
      const lazy = str[pos + 1] === "?" ? 1 : 0;
      return {
        end: pos + 1 + lazy,
        isRepeating: false,
        isUnbounded: false,
        isVariableRepeat: false,
        minZero: true
      };
    }
    if (ch === "{") {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(str.slice(pos));
      if (!m) return null;
      const min = Number(m[1]);
      const hasComma = m[0].includes(",");
      const max = m[2] !== undefined && m[2] !== "" ? Number(m[2]) : hasComma ? Infinity : min;
      if (min > 100 || (Number.isFinite(max) && max > 200) || (Number.isFinite(max) && max < min)) {
        return { invalid: true };
      }
      const nextPos = pos + m[0].length;
      const lazy = str[nextPos] === "?" ? 1 : 0;
      return {
        end: nextPos + lazy,
        min,
        max,
        isRepeating: max > 1,
        isUnbounded: !Number.isFinite(max),
        isVariableRepeat: !Number.isFinite(max) || (max > 1 && max > min),
        minZero: min === 0
      };
    }
    return null;
  };

  // Exact ASCII (0..127) bitmask + non-ASCII whitespace flag + non-ASCII wildcard flag + exact non-ASCII code point set.
  // ASCII letters are case-folded whenever ignoreCase is active (root compiles with `/i`, toggled by `(?-i:...)`).
  const csEmpty = () => [0, 0, 0, 0, false, false, null];
  const csClone = (cs) => [cs[0], cs[1], cs[2], cs[3], cs[4], cs[5], cs[6] ? new Set(cs[6]) : null];
  const csAll = () => [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, true, true, null];

  const csAddBitRaw = (cs, code) => {
    cs[code >>> 5] = (cs[code >>> 5] | (1 << (code & 31))) >>> 0;
  };

  const csAddNonAsciiCode = (cs, code) => {
    if (cs[5]) return;
    if (!cs[6]) cs[6] = new Set();
    cs[6].add(code);
    if (cs[6].size > 32) {
      cs[5] = true;
      cs[6] = null;
    }
  };

  const csAddCode = (cs, code, ignoreCase = true) => {
    if (code >= 0 && code < 128) {
      csAddBitRaw(cs, code);
      if (ignoreCase) {
        if (code >= 65 && code <= 90) csAddBitRaw(cs, code + 32);
        else if (code >= 97 && code <= 122) csAddBitRaw(cs, code - 32);
      }
    } else if (code >= 128) {
      const ch = String.fromCodePoint(code);
      if (/\s/.test(ch)) {
        cs[4] = true;
      } else {
        csAddNonAsciiCode(cs, code);
        if (ignoreCase) {
          const lo = ch.toLowerCase();
          const hi = ch.toUpperCase();
          if (lo.length === 1) {
            const lc = lo.codePointAt(0);
            if (lc >= 128) csAddNonAsciiCode(cs, lc);
          }
          if (hi.length === 1) {
            const hc = hi.codePointAt(0);
            if (hc >= 128) csAddNonAsciiCode(cs, hc);
          }
        }
      }
    }
  };

  const csFromCode = (code, ignoreCase = true) => {
    const cs = csEmpty();
    csAddCode(cs, code, ignoreCase);
    return cs;
  };

  const csUnionInto = (dst, src) => {
    dst[0] = (dst[0] | src[0]) >>> 0;
    dst[1] = (dst[1] | src[1]) >>> 0;
    dst[2] = (dst[2] | src[2]) >>> 0;
    dst[3] = (dst[3] | src[3]) >>> 0;
    if (src[4]) dst[4] = true;
    if (src[5]) {
      dst[5] = true;
      dst[6] = null;
    } else if (!dst[5] && src[6]) {
      for (const cp of src[6]) {
        csAddNonAsciiCode(dst, cp);
        if (dst[5]) break;
      }
    }
    return dst;
  };

  const csOverlaps = (a, b) => {
    if (
      ((a[0] & b[0]) | (a[1] & b[1]) | (a[2] & b[2]) | (a[3] & b[3])) !== 0 ||
      (a[4] && b[4]) ||
      (a[5] && b[5])
    ) {
      return true;
    }
    if (a[5] && b[6] && b[6].size > 0) return true;
    if (b[5] && a[6] && a[6].size > 0) return true;
    if (a[6] && b[6]) {
      for (const cp of a[6]) {
        if (b[6].has(cp)) return true;
      }
    }
    return false;
  };

  const csEquals = (a, b) => {
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3] || a[4] !== b[4] || a[5] !== b[5]) {
      return false;
    }
    const sa = a[6];
    const sb = b[6];
    if (!sa && !sb) return true;
    if (!sa || !sb || sa.size !== sb.size) return false;
    for (const cp of sa) {
      if (!sb.has(cp)) return false;
    }
    return true;
  };

  const csIsEmpty = (cs) =>
    (cs[0] | cs[1] | cs[2] | cs[3]) === 0 && !cs[4] && !cs[5] && (!cs[6] || cs[6].size === 0);

  const buildRangeCs = (ranges, nonAsciiSpace = false, nonAsciiNonSpace = false) => {
    const cs = csEmpty();
    for (const [lo, hi] of ranges) {
      for (let c = lo; c <= hi; c++) csAddCode(cs, c);
    }
    cs[4] = nonAsciiSpace;
    cs[5] = nonAsciiNonSpace;
    if (nonAsciiNonSpace) cs[6] = null;
    return cs;
  };

  const CS_DIGIT = buildRangeCs([[48, 57]], false, false);
  const CS_NON_DIGIT = [~CS_DIGIT[0] >>> 0, ~CS_DIGIT[1] >>> 0, ~CS_DIGIT[2] >>> 0, ~CS_DIGIT[3] >>> 0, true, true, null];
  const CS_WORD = buildRangeCs([[48, 57], [65, 90], [95, 95], [97, 122]], false, false);
  const CS_NON_WORD = [~CS_WORD[0] >>> 0, ~CS_WORD[1] >>> 0, ~CS_WORD[2] >>> 0, ~CS_WORD[3] >>> 0, true, true, null];
  const CS_SPACE = buildRangeCs([[9, 13], [32, 32]], true, false);
  const CS_NON_SPACE = [~CS_SPACE[0] >>> 0, ~CS_SPACE[1] >>> 0, ~CS_SPACE[2] >>> 0, ~CS_SPACE[3] >>> 0, false, true, null];
  const CS_ALL = csAll();
  const CS_DOT = (() => {
    const cs = csAll();
    // Without `s` flag, `.` excludes \n (10) and \r (13)
    cs[0] = (cs[0] & ~(1 << 10) & ~(1 << 13)) >>> 0;
    return cs;
  })();

  const parseEscape = (pos, inClass, ignoreCase = true) => {
    if (pos + 1 >= source.length) return null;
    const c = source[pos + 1];
    if (!inClass && ((c >= "1" && c <= "9") || (c === "k" && source[pos + 2] === "<"))) {
      // Numbered or named backreferences can trigger exponential backtracking
      return null;
    }
    if (!inClass && (c === "b" || c === "B")) {
      return { end: pos + 2, isZeroWidth: true, cs: null };
    }
    if (c === "d") return { end: pos + 2, kind: "set", cs: CS_DIGIT, coversSpace: false, coversNonSpace: false };
    if (c === "D") return { end: pos + 2, kind: "set", cs: CS_NON_DIGIT, coversSpace: true, coversNonSpace: true };
    if (c === "w") return { end: pos + 2, kind: "set", cs: CS_WORD, coversSpace: false, coversNonSpace: false };
    if (c === "W") return { end: pos + 2, kind: "set", cs: CS_NON_WORD, coversSpace: true, coversNonSpace: true };
    if (c === "s") return { end: pos + 2, kind: "set", cs: CS_SPACE, coversSpace: true, coversNonSpace: false };
    if (c === "S") return { end: pos + 2, kind: "set", cs: CS_NON_SPACE, coversSpace: false, coversNonSpace: true };
    if (c === "n") return { end: pos + 2, kind: "char", code: 10, cs: csFromCode(10, ignoreCase) };
    if (c === "r") return { end: pos + 2, kind: "char", code: 13, cs: csFromCode(13, ignoreCase) };
    if (c === "t") return { end: pos + 2, kind: "char", code: 9, cs: csFromCode(9, ignoreCase) };
    if (c === "f") return { end: pos + 2, kind: "char", code: 12, cs: csFromCode(12, ignoreCase) };
    if (c === "v") return { end: pos + 2, kind: "char", code: 11, cs: csFromCode(11, ignoreCase) };
    if (inClass && c === "b") return { end: pos + 2, kind: "char", code: 8, cs: csFromCode(8, ignoreCase) };

    if (c === "x" && pos + 3 < source.length && /^[0-9a-fA-F]{2}$/.test(source.slice(pos + 2, pos + 4))) {
      const code = parseInt(source.slice(pos + 2, pos + 4), 16);
      return { end: pos + 4, kind: "char", code, cs: csFromCode(code, ignoreCase) };
    }
    if (c === "u" && pos + 5 < source.length && /^[0-9a-fA-F]{4}$/.test(source.slice(pos + 2, pos + 6))) {
      const code = parseInt(source.slice(pos + 2, pos + 6), 16);
      return { end: pos + 6, kind: "char", code, cs: csFromCode(code, ignoreCase) };
    }
    if (c === "c") {
      if (pos + 2 < source.length && (inClass ? /[0-9A-Za-z_]/.test(source[pos + 2]) : /[A-Za-z]/.test(source[pos + 2]))) {
        const code = source.charCodeAt(pos + 2) % 32;
        return { end: pos + 3, kind: "char", code, cs: csFromCode(code, ignoreCase) };
      }
      // Reject malformed/bare `\c` rather than over-approximating with CS_ALL (which collapses under `[^...]`)
      return null;
    }
    if (c === "0" || (inClass && c >= "1" && c <= "7")) {
      let val = Number(c);
      let end = pos + 2;
      while (end < source.length && end < pos + 4 && source[end] >= "0" && source[end] <= "7") {
        const nextVal = val * 8 + Number(source[end]);
        if (nextVal > 255) break;
        val = nextVal;
        end++;
      }
      return { end, kind: "char", code: val, cs: csFromCode(val, ignoreCase) };
    }
    // Note: custom rules compile with `/i` (no `/u`), so `\p`/`\P` are identity escapes for literal `p`/`P`
    // and any trailing `{m,n}` is a quantifier — never swallow `\p{...}` as a non-quantified atom.
    const litCode = c.charCodeAt(0);
    return { end: pos + 2, kind: "char", code: litCode, cs: csFromCode(litCode, ignoreCase) };
  };

  const parseCharClass = (startPos, ignoreCase = true) => {
    let p = startPos + 1;
    if (p >= source.length) return null;
    let negated = false;
    if (source[p] === "^") {
      negated = true;
      p++;
    }
    const cs = csEmpty();
    let coversAllNonAsciiSpace = false;
    let coversAllNonAsciiNonSpace = false;
    let hasApprox = false;

    const readClassItem = (idx) => {
      if (source[idx] === "\\") {
        return parseEscape(idx, true, ignoreCase);
      }
      const code = source.charCodeAt(idx);
      return { end: idx + 1, kind: "char", code, cs: csFromCode(code, ignoreCase) };
    };

    const mergeItem = (item) => {
      csUnionInto(cs, item.cs);
      if (item.coversSpace) coversAllNonAsciiSpace = true;
      if (item.coversNonSpace) coversAllNonAsciiNonSpace = true;
      if (item.approx) hasApprox = true;
    };

    while (p < source.length && source[p] !== "]") {
      const first = readClassItem(p);
      if (!first) return null;
      p = first.end;
      if (first.kind === "char" && p < source.length && source[p] === "-" && p + 1 < source.length && source[p + 1] !== "]") {
        const second = readClassItem(p + 1);
        if (!second) return null;
        if (second.kind === "char") {
          if (second.code < first.code) return null;
          const asciiEnd = Math.min(second.code, 127);
          for (let code = first.code; code <= asciiEnd; code++) {
            csAddCode(cs, code, ignoreCase);
          }
          if (second.code >= 128) {
            cs[4] = true;
            cs[5] = true;
            cs[6] = null;
          }
          p = second.end;
          continue;
        }
        // Range against shorthand (Annex B): conservatively include endpoints, '-' and shorthand
        mergeItem(first);
        csAddCode(cs, 45, ignoreCase);
        mergeItem(second);
        p = second.end;
        continue;
      }
      mergeItem(first);
    }

    if (p >= source.length || source[p] !== "]") return null;

    if (negated) {
      // Structural soundness invariant: never bitwise-invert an over-approximated set
      if (hasApprox) {
        return { end: p + 1, cs: CS_ALL };
      }
      return {
        end: p + 1,
        cs: [
          ~cs[0] >>> 0,
          ~cs[1] >>> 0,
          ~cs[2] >>> 0,
          ~cs[3] >>> 0,
          !coversAllNonAsciiSpace,
          !coversAllNonAsciiNonSpace,
          null
        ]
      };
    }
    return { end: p + 1, cs };
  };

  // List of active preceding variable-repeat entries: { cs, seps } (capped at 16 distinct entries).
  // `seps` records mandatory non-empty charsets observed after `cs`; if any mandatory separator
  // since `cs` is disjoint from a subsequent variable repeat `B`, `B` runs cannot overlap across
  // distinct separator positions (Disjoint-Separator Barrier -> O(N) linear time).
  const makePrevEntry = (cs, seps = []) => ({ cs, seps });
  const clonePrevEntry = (e) => ({ cs: e.cs, seps: e.seps.length > 0 ? e.seps.slice() : [] });
  const sepsEqual = (a, b) => a.length === b.length && a.every((x, idx) => csEquals(x, b[idx]));

  const addPrevEntry = (list, entry) => {
    if (!entry || !entry.cs || csIsEmpty(entry.cs)) return;
    if (list.length === 1 && csEquals(list[0].cs, CS_ALL) && list[0].seps.length === 0) return;
    if ((csEquals(entry.cs, CS_ALL) && entry.seps.length === 0) || list.length >= 16) {
      list.length = 0;
      list.push(makePrevEntry(CS_ALL, []));
      return;
    }
    for (let idx = 0; idx < list.length; idx++) {
      const existing = list[idx];
      if (!csEquals(existing.cs, entry.cs)) continue;
      if (existing.seps.length === 0) return;
      if (entry.seps.length === 0) {
        list[idx] = makePrevEntry(entry.cs, []);
        return;
      }
      if (sepsEqual(existing.seps, entry.seps)) return;
    }
    list.push(clonePrevEntry(entry));
  };

  const clonePrevList = (list) => (list && list.length > 0 ? list.map(clonePrevEntry) : null);

  const unionPrevLists = (a, b) => {
    if (!a || a.length === 0) return clonePrevList(b);
    if (!b || b.length === 0) return clonePrevList(a);
    const out = a.map(clonePrevEntry);
    for (const item of b) addPrevEntry(out, item);
    return out;
  };

  const entryConflictsWithCs = (entry, cs) => {
    if (!csOverlaps(entry.cs, cs)) return false;
    for (const sep of entry.seps) {
      if (!csOverlaps(sep, cs)) return false;
    }
    return true;
  };

  const prevOverlapsCs = (prevList, cs) => {
    if (!prevList || prevList.length === 0 || !cs || csIsEmpty(cs)) return false;
    for (const p of prevList) {
      if (entryConflictsWithCs(p, cs)) return true;
    }
    return false;
  };

  const rawPrevOverlapsCs = (prevList, cs) => {
    if (!prevList || prevList.length === 0 || !cs || csIsEmpty(cs)) return false;
    for (const p of prevList) {
      if (csOverlaps(p.cs, cs)) return true;
    }
    return false;
  };

  const retainOverlappingPrev = (prevList, cs) => {
    if (!prevList || prevList.length === 0 || !cs || csIsEmpty(cs)) return null;
    let kept = null;
    for (const p of prevList) {
      if (csOverlaps(p.cs, cs)) {
        if (!kept) kept = [];
        addPrevEntry(kept, p);
      }
    }
    return kept;
  };

  const filterOverlappingPrev = (prevList, cs) => {
    if (!prevList || prevList.length === 0) return null;
    if (!cs || csIsEmpty(cs)) return null;
    let kept = null;
    for (const p of prevList) {
      if (csOverlaps(p.cs, cs)) {
        if (!kept) kept = [];
        const nextSeps = p.seps.length > 0 ? p.seps.slice() : [];
        if (nextSeps.length < 4 && !nextSeps.some((s) => csEquals(s, cs))) {
          nextSeps.push(cs);
        }
        addPrevEntry(kept, makePrevEntry(p.cs, nextSeps));
      }
    }
    return kept;
  };

  const hasAmbiguousAlternation = (branches, ignoreCase = true) => {
    if (branches.length < 2) return false;
    const seen = new Set();
    for (const raw of branches) {
      const b = ignoreCase ? raw.toLowerCase() : raw;
      if (!b) return true;
      // Wildcards / character classes / escapes / anchors / nested groups in quantified alternation risk exponential overlap
      if (/[.[\\+*?{(^$]/.test(b)) return true;
      if (seen.has(b)) return true;
      for (const prev of seen) {
        if (prev.startsWith(b) || b.startsWith(prev)) return true;
      }
      seen.add(b);
    }
    return false;
  };

  // Total non-deterministic branching budget (2^12 = 4096 max paths) covering `?`, `{0,1}`,
  // nullable alternations `(a|)`, and chained non-quantified ambiguous alternations `(a|aa)...`.
  const MAX_NONDET_CHOICE_BITS = 12;
  let nonDetChoiceBits = 0;
  let unanchoredVarRepeatCharged = false;
  let anchoredOverlapPenaltyCharged = false;
  let barrierBypassCount = 0;
  // Track optional / ambiguous choices seen before a later overlapping variable repeat
  // so patterns like `a?a?a?a?a+!` or `(?:a|)a?a?a?a+!` cannot bypass overlap penalties.
  let preOptionalChoices = [];
  // Allow at most one start-anchored non-dotAll `\s+.*` / `\s+.+` idiom per branch (e.g. `^\s*(?:FAIL|PASS)\s+.*\(12ms\)$`),
  // never unanchored (which is O(N^3)), never multiline/dotAll, and never inside lookarounds or repeating groups.
  let spaceWildcardUsed = false;

  const clonePreOpt = (list) =>
    list.map((e) => ({ cs: csClone(e.cs), bits: e.bits, unanchored: e.unanchored, upgraded: e.upgraded }));

  const mergePreOptionalInto = (target, src) => {
    for (const item of src) {
      const dup = target.some(
        (t) => t.bits === item.bits && t.unanchored === item.unanchored && csEquals(t.cs, item.cs)
      );
      if (dup) continue;
      if (target.length >= 16) {
        // Never drop budget tracking past cap: conservatively fold into last bucket
        const last = target[target.length - 1];
        csUnionInto(last.cs, item.cs);
        last.bits = Math.min(MAX_NONDET_CHOICE_BITS, last.bits + item.bits);
        last.unanchored = last.unanchored || item.unanchored;
        last.upgraded = false;
      } else {
        target.push({ cs: csClone(item.cs), bits: item.bits, unanchored: item.unanchored, upgraded: false });
      }
    }
  };

  const makeFrame = (
    incomingPrev,
    isLookaround = false,
    inMultiline = false,
    inDotAll = false,
    incomingAnchoredStart = false,
    inIgnoreCase = true
  ) => ({
    isLookaround,
    inMultiline,
    inDotAll,
    inIgnoreCase,
    incomingAnchoredStart,
    curAnchoredStart: incomingAnchoredStart,
    allBranchesAnchored: true,
    lookaroundVarPrevs: null,
    incomingPrev: clonePrevList(incomingPrev),
    curPrev: clonePrevList(incomingPrev),
    curEmpty: true,
    branchEndPrevs: [],
    canMatchEmpty: false,
    allChars: csEmpty(),
    startCs: csEmpty(),
    hasAtoms: false,
    hasQuantifier: false,
    hasOptionalQuantifier: false,
    hasNestedGroup: false,
    usedSpaceWildcard: false,
    hasAlternation: false,
    hasAmbiguousAlt: false,
    branches: [],
    curBranch: "",
    incomingNonDetBits: nonDetChoiceBits,
    branchMaxNonDetBits: nonDetChoiceBits,
    incomingUnanchoredCharged: unanchoredVarRepeatCharged,
    branchAnyUnanchoredCharged: unanchoredVarRepeatCharged,
    incomingAnchoredOverlapCharged: anchoredOverlapPenaltyCharged,
    branchAnyAnchoredOverlapCharged: anchoredOverlapPenaltyCharged,
    incomingBarrierBypass: barrierBypassCount,
    branchMaxBarrierBypass: barrierBypassCount,
    incomingSpaceWildcard: spaceWildcardUsed,
    branchAnySpaceWildcard: spaceWildcardUsed,
    incomingPreOptionalChoices: clonePreOpt(preOptionalChoices),
    branchMergedPreOptionalChoices: clonePreOpt(preOptionalChoices)
  });

  const stack = [makeFrame(null, false, false, false, false, true)];

  const consumeNonDetBits = (bits) => {
    nonDetChoiceBits += bits;
    return nonDetChoiceBits <= MAX_NONDET_CHOICE_BITS;
  };

  const recordPreOptionalChoice = (cs, bits, unanchored) => {
    if (!cs || csIsEmpty(cs) || bits <= 0) return;
    if (preOptionalChoices.length >= 16) {
      const last = preOptionalChoices[preOptionalChoices.length - 1];
      csUnionInto(last.cs, cs);
      last.bits = Math.min(MAX_NONDET_CHOICE_BITS, last.bits + bits);
      last.unanchored = last.unanchored || unanchored;
      last.upgraded = false;
      return;
    }
    preOptionalChoices.push({ cs: csClone(cs), bits, unanchored, upgraded: false });
  };

  const chargeVarRepeatInteraction = (repeatCs, isAnchored) => {
    if (!isAnchored) {
      if (!unanchoredVarRepeatCharged) {
        unanchoredVarRepeatCharged = true;
        if (!consumeNonDetBits(8)) return false;
      }
      for (const entry of preOptionalChoices) {
        if (!entry.upgraded && csOverlaps(entry.cs, repeatCs)) {
          entry.upgraded = true;
          if (!consumeNonDetBits(entry.bits)) return false;
        }
      }
    } else if (!spaceWildcardUsed && !anchoredOverlapPenaltyCharged) {
      for (const entry of preOptionalChoices) {
        if (csOverlaps(entry.cs, repeatCs)) {
          anchoredOverlapPenaltyCharged = true;
          if (!consumeNonDetBits(4)) return false;
          break;
        }
      }
    }
    return true;
  };

  const chargeBarrierBypass = (activePrev, repeatCs, isAnchored) => {
    if (!isAnchored && repeatCs && repeatCs[5] && activePrev) {
      let broadOverlaps = 0;
      for (const p of activePrev) {
        if (p.cs[5] && csOverlaps(p.cs, repeatCs)) broadOverlaps += 1;
      }
      if (broadOverlaps >= 2) return false;
    }
    barrierBypassCount += 1;
    return barrierBypassCount <= 3;
  };

  const chargeOptionalChoice = (choiceCs, baseBits, activePrev, isAnchored) => {
    const overlapsPrev = rawPrevOverlapsCs(activePrev, choiceCs);
    if (!isAnchored) {
      if (overlapsPrev) {
        const mult = barrierBypassCount >= 3 && prevOverlapsCs(activePrev, choiceCs) ? 3 : 2;
        return consumeNonDetBits(baseBits * mult);
      }
      recordPreOptionalChoice(choiceCs, baseBits, true);
      return consumeNonDetBits(baseBits);
    }
    if (spaceWildcardUsed && prevOverlapsCs(activePrev, choiceCs)) {
      return consumeNonDetBits(baseBits * 2);
    }
    if (overlapsPrev && !spaceWildcardUsed && !anchoredOverlapPenaltyCharged) {
      anchoredOverlapPenaltyCharged = true;
      if (!consumeNonDetBits(4)) return false;
    } else if (!overlapsPrev) {
      recordPreOptionalChoice(choiceCs, baseBits, false);
    }
    return consumeNonDetBits(baseBits);
  };

  const recordLookaroundVarRepeat = (nextList) => {
    if (!nextList || nextList.length === 0) return;
    for (let k = stack.length - 1; k >= 1; k--) {
      if (stack[k].isLookaround) {
        stack[k].lookaroundVarPrevs = unionPrevLists(stack[k].lookaroundVarPrevs, nextList);
        break;
      }
    }
  };

  const consumeAtom = (atomCs, q, isZeroWidth = false) => {
    const top = stack[stack.length - 1];
    if (isZeroWidth) {
      if (q && q.isRepeating) return false;
      return true;
    }
    if (top.curEmpty) {
      csUnionInto(top.startCs, atomCs);
    }
    top.hasAtoms = true;
    csUnionInto(top.allChars, atomCs);
    if (q) {
      if (readQuantifier(source, q.end)) return false;
      top.hasQuantifier = true;
      if (q.minZero) top.hasOptionalQuantifier = true;
      if (q.isVariableRepeat) {
        if (!chargeVarRepeatInteraction(atomCs, top.curAnchoredStart)) return false;
        if (prevOverlapsCs(top.curPrev, atomCs)) {
          const isSingleSpaceWildcard =
            !spaceWildcardUsed &&
            top.curAnchoredStart &&
            !top.inMultiline &&
            !top.inDotAll &&
            csEquals(atomCs, CS_DOT) &&
            !stack.some((f) => f.isLookaround) &&
            top.curPrev &&
            top.curPrev.length > 0 &&
            top.curPrev.every((p) => csEquals(p.cs, CS_SPACE));
          if (!isSingleSpaceWildcard) return false;
          const spaceCost = anchoredOverlapPenaltyCharged ? 5 : 9;
          if (!consumeNonDetBits(spaceCost)) return false;
          for (const entry of preOptionalChoices) {
            if (!entry.upgraded && (csOverlaps(entry.cs, atomCs) || csOverlaps(entry.cs, CS_SPACE))) {
              entry.upgraded = true;
              if (!consumeNonDetBits(entry.bits)) return false;
            }
          }
          spaceWildcardUsed = true;
          top.usedSpaceWildcard = true;
        } else if (rawPrevOverlapsCs(top.curPrev, atomCs)) {
          if (!chargeBarrierBypass(top.curPrev, atomCs, top.curAnchoredStart)) return false;
        }
        const nextList = csIsEmpty(atomCs) ? null : [makePrevEntry(atomCs, [])];
        recordLookaroundVarRepeat(nextList);
        const retained = retainOverlappingPrev(top.curPrev, atomCs);
        top.curPrev = q.minZero
          ? unionPrevLists(top.curPrev, nextList)
          : unionPrevLists(retained, nextList);
        if (!q.minZero) top.curEmpty = false;
      } else if (!q.minZero) {
        top.curPrev = filterOverlappingPrev(top.curPrev, atomCs);
        top.curEmpty = false;
      } else if (!chargeOptionalChoice(atomCs, 1, top.curPrev, top.curAnchoredStart)) {
        return false;
      }
    } else {
      top.curPrev = filterOverlappingPrev(top.curPrev, atomCs);
      top.curEmpty = false;
    }
    return true;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const top = stack[stack.length - 1];

    if (ch === "\\") {
      const esc = parseEscape(i, false, top.inIgnoreCase);
      if (!esc) return false;
      const q = readQuantifier(source, esc.end);
      if (q?.invalid) return false;
      if (stack.length > 1) {
        top.curBranch += source.slice(i, q ? q.end : esc.end);
      }
      if (!consumeAtom(esc.cs, q, Boolean(esc.isZeroWidth))) return false;
      i = (q ? q.end : esc.end) - 1;
      continue;
    }

    if (ch === "[") {
      const cc = parseCharClass(i, top.inIgnoreCase);
      if (!cc) return false;
      const q = readQuantifier(source, cc.end);
      if (q?.invalid) return false;
      if (stack.length > 1) {
        top.curBranch += "[" + (q ? source.slice(cc.end, q.end) : "");
      }
      if (!consumeAtom(cc.cs, q, false)) return false;
      i = (q ? q.end : cc.end) - 1;
      continue;
    }

    if (ch === "(") {
      // Root frame occupies index 0 -> allow up to 6 nested groups
      if (stack.length >= 7) return false;
      let isLookaround = false;
      let childMultiline = top.inMultiline;
      let childDotAll = top.inDotAll;
      let childIgnoreCase = top.inIgnoreCase;
      if (source[i + 1] === "?") {
        if (source[i + 2] === ":") {
          i += 2;
        } else if (source[i + 2] === "=" || source[i + 2] === "!") {
          isLookaround = true;
          i += 2;
        } else if (source[i + 2] === "<" && (source[i + 3] === "=" || source[i + 3] === "!")) {
          isLookaround = true;
          i += 3;
        } else if (source[i + 2] === "<") {
          const closeAngle = source.indexOf(">", i + 3);
          if (closeAngle === -1) return false;
          i = closeAngle;
        } else {
          // ES2025 inline modifier group (?ims-ims:...)
          const modMatch = /^([ims]*)(?:-([ims]*))?:/.exec(source.slice(i + 2));
          if (!modMatch) return false;
          const enableFlags = modMatch[1] || "";
          const disableFlags = modMatch[2] || "";
          if (enableFlags.includes("i")) childIgnoreCase = true;
          if (disableFlags.includes("i")) childIgnoreCase = false;
          if (enableFlags.includes("m")) childMultiline = true;
          if (disableFlags.includes("m")) childMultiline = false;
          if (enableFlags.includes("s")) childDotAll = true;
          if (disableFlags.includes("s")) childDotAll = false;
          i += 1 + modMatch[0].length;
        }
      }
      if (isLookaround && stack.some((f) => f.isLookaround)) {
        // Disallow nested lookarounds (`(?=...(?!...))` / `(?=...(?=...)...)`) to prevent O(N^k) backtracking
        return false;
      }
      // Inherit active `top.curPrev` into lookarounds too so `\w+(?=\w+...)` cannot bypass overlap checks
      stack.push(
        makeFrame(top.curPrev, isLookaround, childMultiline, childDotAll, top.curAnchoredStart, childIgnoreCase)
      );
      continue;
    }

    if (ch === "|") {
      top.hasAlternation = true;
      top.branches.push(top.curBranch);
      top.curBranch = "";
      top.branchEndPrevs.push(top.curPrev);
      if (top.curEmpty) top.canMatchEmpty = true;
      top.allBranchesAnchored = top.allBranchesAnchored && top.curAnchoredStart;
      top.curAnchoredStart = top.incomingAnchoredStart;
      top.curPrev = clonePrevList(top.incomingPrev);
      top.curEmpty = true;
      // Record branch maxima and reset per-branch budgets back to frame entry for the next alternative
      top.branchMaxNonDetBits = Math.max(top.branchMaxNonDetBits, nonDetChoiceBits);
      top.branchAnyUnanchoredCharged = top.branchAnyUnanchoredCharged || unanchoredVarRepeatCharged;
      top.branchAnyAnchoredOverlapCharged = top.branchAnyAnchoredOverlapCharged || anchoredOverlapPenaltyCharged;
      top.branchMaxBarrierBypass = Math.max(top.branchMaxBarrierBypass, barrierBypassCount);
      top.branchAnySpaceWildcard = top.branchAnySpaceWildcard || spaceWildcardUsed;
      mergePreOptionalInto(top.branchMergedPreOptionalChoices, preOptionalChoices);
      nonDetChoiceBits = top.incomingNonDetBits;
      unanchoredVarRepeatCharged = top.incomingUnanchoredCharged;
      anchoredOverlapPenaltyCharged = top.incomingAnchoredOverlapCharged;
      barrierBypassCount = top.incomingBarrierBypass;
      spaceWildcardUsed = top.incomingSpaceWildcard;
      preOptionalChoices = clonePreOpt(top.incomingPreOptionalChoices);
      continue;
    }

    if (ch === ")") {
      if (stack.length <= 1) return false;
      const frame = stack.pop();
      const parent = stack[stack.length - 1];
      frame.branches.push(frame.curBranch);
      frame.branchEndPrevs.push(frame.curPrev);
      if (frame.curEmpty) frame.canMatchEmpty = true;
      frame.allBranchesAnchored = frame.allBranchesAnchored && frame.curAnchoredStart;

      // Combine branch-scoped budgets using worst-case max/OR across alternatives
      if (frame.hasAlternation) {
        nonDetChoiceBits = Math.max(frame.branchMaxNonDetBits, nonDetChoiceBits);
        unanchoredVarRepeatCharged = frame.branchAnyUnanchoredCharged || unanchoredVarRepeatCharged;
        anchoredOverlapPenaltyCharged = frame.branchAnyAnchoredOverlapCharged || anchoredOverlapPenaltyCharged;
        barrierBypassCount = Math.max(frame.branchMaxBarrierBypass, barrierBypassCount);
        spaceWildcardUsed = frame.branchAnySpaceWildcard || spaceWildcardUsed;
        mergePreOptionalInto(frame.branchMergedPreOptionalChoices, preOptionalChoices);
        preOptionalChoices = frame.branchMergedPreOptionalChoices;
      }

      const selfAmbiguous = frame.hasAlternation && hasAmbiguousAlternation(frame.branches, frame.inIgnoreCase);
      const groupHasAmbiguousAlt = frame.hasAmbiguousAlt || selfAmbiguous;

      let outgoingPrev = null;
      for (const branchPrev of frame.branchEndPrevs) {
        outgoingPrev = unionPrevLists(outgoingPrev, branchPrev);
      }

      const q = readQuantifier(source, i + 1);
      if (q?.invalid) return false;
      if (q && readQuantifier(source, q.end)) return false;

      let safeBoundedGroup = false;
      if (q && q.isRepeating) {
        if (frame.isLookaround) return false;
        if (groupHasAmbiguousAlt) return false;
        if (frame.canMatchEmpty) return false;
        if (frame.hasQuantifier) {
          // Allow safe small bounded repeating groups with disjoint inter-iteration boundaries
          // (e.g. `^(?:\d+\.){2}\d+$`, `(?:\w+\s+){1,3}failed`, `^(?:\d{1,3}\.){3}\d{1,3}$`)
          // while rejecting unbounded/nested/alternating/self-overlapping groups like `(a+)+`, `(.*a){10}`, `(\w+\s*)+`.
          safeBoundedGroup =
            !q.isUnbounded &&
            Number.isFinite(q.max) &&
            q.max <= 8 &&
            !frame.hasAlternation &&
            !frame.hasNestedGroup &&
            !frame.hasOptionalQuantifier &&
            !frame.usedSpaceWildcard &&
            !csIsEmpty(frame.startCs) &&
            !rawPrevOverlapsCs(outgoingPrev, frame.startCs);
          if (!safeBoundedGroup) return false;
        }
      }

      parent.hasNestedGroup = true;
      if (frame.hasQuantifier || q) {
        parent.hasQuantifier = true;
      }
      if (frame.hasOptionalQuantifier || (q && q.minZero)) {
        parent.hasOptionalQuantifier = true;
      }
      if (frame.usedSpaceWildcard) {
        parent.usedSpaceWildcard = true;
      }
      if (groupHasAmbiguousAlt) {
        parent.hasAmbiguousAlt = true;
      }
      if (stack.length > 1) {
        parent.curBranch += `(${frame.branches.join("|")})`;
        if (q) parent.curBranch += source.slice(i + 1, q.end);
      }

      if (frame.isLookaround) {
        // Reject optional lookarounds (`(?=...) ?` / `{0,1}`) and still charge ambiguous alternations inside lookarounds
        if (q && q.minZero) return false;
        if (frame.hasAlternation && (selfAmbiguous || frame.canMatchEmpty)) {
          const altBits = Math.max(1, Math.ceil(Math.log2(frame.branches.length)));
          if (!chargeOptionalChoice(frame.allChars, altBits, frame.incomingPrev, parent.curAnchoredStart)) {
            return false;
          }
        }
        // Propagate any variable repeats inside a lookaround back to the parent so patterns like
        // `(?<=\w+)\w+`, `(?=a+b)a+`, or `(?=.*x)(?=.*y)` cannot bypass overlap checks on exit.
        if (frame.lookaroundVarPrevs) {
          parent.curPrev = unionPrevLists(parent.curPrev, frame.lookaroundVarPrevs);
        }
      } else {
        if (frame.hasAtoms) {
          if (parent.curEmpty) {
            csUnionInto(parent.startCs, frame.startCs);
          }
          parent.hasAtoms = true;
          csUnionInto(parent.allChars, frame.allChars);
        }
        if (q && q.isVariableRepeat) {
          const groupCs = frame.hasAtoms ? csClone(frame.allChars) : CS_ALL;
          const canUseStartCsEntry =
            frame.hasAtoms &&
            !frame.canMatchEmpty &&
            !frame.hasAlternation &&
            !frame.hasNestedGroup &&
            !frame.hasOptionalQuantifier &&
            !frame.usedSpaceWildcard &&
            !csIsEmpty(frame.startCs) &&
            (!frame.hasQuantifier || safeBoundedGroup);
          const entryCs = canUseStartCsEntry ? frame.startCs : groupCs;
          if (!chargeVarRepeatInteraction(groupCs, parent.curAnchoredStart)) return false;
          if (prevOverlapsCs(frame.incomingPrev, entryCs)) return false;
          if (rawPrevOverlapsCs(frame.incomingPrev, entryCs)) {
            if (!chargeBarrierBypass(frame.incomingPrev, entryCs, parent.curAnchoredStart)) return false;
          }
          const nextList = csIsEmpty(groupCs) ? null : [makePrevEntry(groupCs, [])];
          recordLookaroundVarRepeat(nextList);
          const retained = retainOverlappingPrev(frame.incomingPrev, groupCs);
          parent.curPrev = q.minZero
            ? unionPrevLists(frame.incomingPrev, nextList)
            : unionPrevLists(retained, nextList);
          if (!q.minZero && !frame.canMatchEmpty) {
            parent.curEmpty = false;
          }
        } else {
          // Account for non-deterministic choice points in chained non-quantified alternations
          // such as `(a|aa)(a|aa)...` or `(a|)(a|)...`
          if (frame.hasAlternation && (selfAmbiguous || frame.canMatchEmpty)) {
            const altBits = Math.max(1, Math.ceil(Math.log2(frame.branches.length)));
            if (!chargeOptionalChoice(frame.allChars, altBits, frame.incomingPrev, parent.curAnchoredStart)) {
              return false;
            }
          }
          let mergedPrev = outgoingPrev;
          if (q && q.minZero) {
            const optGroupCs = frame.hasAtoms ? frame.allChars : null;
            if (!chargeOptionalChoice(optGroupCs, 1, frame.incomingPrev, parent.curAnchoredStart)) return false;
            mergedPrev = unionPrevLists(mergedPrev, frame.incomingPrev);
          } else {
            if (frame.allBranchesAnchored) {
              parent.curAnchoredStart = true;
            }
            if (!frame.canMatchEmpty) {
              parent.curEmpty = false;
            }
          }
          parent.curPrev = mergedPrev;
        }
      }

      if (q) {
        i = q.end - 1;
      }
      continue;
    }

    if (ch === ".") {
      const q = readQuantifier(source, i + 1);
      if (q?.invalid) return false;
      const dotCs = top.inDotAll ? CS_ALL : CS_DOT;
      if (!consumeAtom(dotCs, q, false)) return false;
      if (stack.length > 1) {
        top.curBranch += ".";
        if (q) top.curBranch += source.slice(i + 1, q.end);
      }
      if (q) i = q.end - 1;
      continue;
    }

    if (ch === "+" || ch === "*" || ch === "?" || ch === "{") {
      const q = readQuantifier(source, i);
      if (q?.invalid) return false;
      if (q) {
        top.hasQuantifier = true;
        if (readQuantifier(source, q.end)) return false;
        if (stack.length > 1) top.curBranch += source.slice(i, q.end);
        i = q.end - 1;
        continue;
      }
    }

    if (ch === "^" || ch === "$") {
      const anchorQ = readQuantifier(source, i + 1);
      if (anchorQ?.invalid || (anchorQ && anchorQ.isRepeating)) return false;
      if (stack.length > 1) top.curBranch += ch;
      // Only reset overlap tracking when NOT in inline multiline mode (?m:...), where ^/$ match every newline
      if (!top.inMultiline) {
        top.curPrev = null;
        if (ch === "^" && top.curEmpty && !top.isLookaround) {
          top.curAnchoredStart = true;
        }
      }
      if (anchorQ) i = anchorQ.end - 1;
      continue;
    }

    if (stack.length > 1) {
      top.curBranch += ch;
    }
    const litQ = readQuantifier(source, i + 1);
    if (litQ?.invalid) return false;
    if (!consumeAtom(csFromCode(ch.charCodeAt(0), top.inIgnoreCase), litQ, false)) return false;
    if (litQ) {
      if (stack.length > 1) {
        top.curBranch += source.slice(i + 1, litQ.end);
      }
      i = litQ.end - 1;
    }
  }

  if (stack.length !== 1) return false;

  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

/** Rule 1: git status */
function filterGitStatus(combined, exitCode) {
  if (exitCode !== 0) return combined;
  const lines = combined.split("\n");
  const keep = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    // Drop verbose git hint lines
    if (/^\(use "git /i.test(t)) continue;
    if (/^no changes added to commit/i.test(t)) continue;
    if (/^nothing added to commit but untracked/i.test(t)) continue;
    keep.push(raw.trimEnd());
  }
  return keep.join("\n");
}

function parseGitDiffPath(line) {
  if (!line || line.length > 1024) return "";
  const rest = line.slice(11).trim();
  if (!rest) return "";
  const readToken = (str, start, isSecond = false) => {
    let i = start;
    while (i < str.length && str[i] === " ") i++;
    if (i >= str.length) return null;
    if (str[i] === '"') {
      let j = i + 1;
      let val = "";
      while (j < str.length) {
        if (str[j] === "\\" && j + 1 < str.length) {
          val += str[j] + str[j + 1];
          j += 2;
          continue;
        }
        if (str[j] === '"') {
          return { val, next: j + 1 };
        }
        val += str[j];
        j++;
      }
      return { val, next: j };
    }
    if (isSecond) {
      return { val: str.slice(i), next: str.length };
    }
    const nextQuoteB = str.indexOf(' "b/', i);
    if (nextQuoteB !== -1) return { val: str.slice(i, nextQuoteB), next: nextQuoteB + 1 };
    const nextPlainB = str.indexOf(" b/", i);
    if (nextPlainB !== -1) return { val: str.slice(i, nextPlainB), next: nextPlainB + 1 };
    const sp = str.indexOf(" ", i);
    if (sp === -1) return { val: str.slice(i), next: str.length };
    return { val: str.slice(i, sp), next: sp + 1 };
  };
  const first = readToken(rest, 0, false);
  if (!first) return rest;
  const second = readToken(rest, first.next, true);
  const chosen = second && second.val ? second.val : first.val;
  return chosen.replace(/^[ab]\//, "").trim();
}

function isLikelyGitDiffHeaderFollowup(nextLine) {
  if (typeof nextLine !== "string") return false;
  return (
    nextLine.startsWith("index ") ||
    nextLine.startsWith("new file mode ") ||
    nextLine.startsWith("deleted file mode ") ||
    nextLine.startsWith("old mode ") ||
    nextLine.startsWith("new mode ") ||
    nextLine.startsWith("rename from ") ||
    nextLine.startsWith("copy from ") ||
    nextLine.startsWith("Binary files ") ||
    nextLine.startsWith("similarity index ") ||
    nextLine.startsWith("--- ")
  );
}

/** Rule 2: git diff (3-stage context-preserving filter: lossless within budget -> 1-line ctx -> compact +/-; honors -U/--unified/-W/--word-diff & mailbox patches) */
function filterGitDiff(combined, exitCode, ctx = {}) {
  if (exitCode !== 0) return combined;
  const cmdStr = String(ctx?.command || "");
  const hasExplicitContextFlag =
    /(?:^|\s)(?:-U\s*\d+|--unified(?:=\d+)?|-W|--function-context|--word-diff(?:=\S+)?)(?=\s|$)/.test(cmdStr);
  const isWordDiffCmd = /(?:^|\s)--word-diff(?:=\S+)?(?=\s|$)/.test(cmdStr);

  const lines = combined.replace(/\r\n/g, "\n").split("\n");
  const files = [];
  const mailboxSubjects = [];
  let curFile = null;
  let inHunk = false;
  let inCommitMsg = false;
  let pendingFromSha = "";
  const entries = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const fromMatch = /^From ([0-9a-f]{40})\s/.exec(line);
    if (fromMatch) {
      inHunk = false;
      inCommitMsg = true;
      pendingFromSha = fromMatch[1].slice(0, 8);
      continue;
    }
    if (inCommitMsg) {
      if (line === "---") {
        inCommitMsg = false;
        continue;
      }
      const subjMatch = /^Subject:\s*(.+)$/i.exec(line);
      if (subjMatch && mailboxSubjects.length < 10) {
        mailboxSubjects.push(`${pendingFromSha || "commit"} ${subjMatch[1].trim().slice(0, 100)}`);
        continue;
      }
      if (!line.startsWith("diff --git ") || !isLikelyGitDiffHeaderFollowup(lines[idx + 1])) {
        continue;
      }
      inCommitMsg = false;
    }

    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const name = parseGitDiffPath(line) || line.slice(11);
      curFile = { name, added: 0, removed: 0 };
      files.push(curFile);
      entries.push({ text: `=== ${name}`, kind: "file" });
      continue;
    }
    if (!inHunk && (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      entries.push({ text: line, kind: "hunk" });
      continue;
    }
    if (!inHunk) {
      if (
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("Binary files ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("copy from ") ||
        line.startsWith("copy to ")
      ) {
        entries.push({ text: line, kind: "meta" });
      }
      continue;
    }

    // Inside hunk
    if (line === "-- " && (lines[idx + 1] === undefined || /^\d+\.\d+/.test(lines[idx + 1].trim()))) {
      inHunk = false;
      continue;
    }
    const openAdd = line.indexOf("{+");
    const hasWordAdd = openAdd !== -1 && line.indexOf("+}", openAdd + 2) !== -1;
    const openDel = line.indexOf("[-");
    const hasWordDel = openDel !== -1 && line.indexOf("-]", openDel + 2) !== -1;
    if (hasWordAdd || hasWordDel) {
      if (curFile && hasWordAdd) curFile.added += 1;
      if (curFile && hasWordDel) curFile.removed += 1;
      entries.push({ text: line, kind: "change" });
      continue;
    }
    if (!isWordDiffCmd) {
      if (line.startsWith("+")) {
        if (curFile) curFile.added += 1;
        entries.push({ text: line, kind: "change" });
        continue;
      }
      if (line.startsWith("-")) {
        if (curFile) curFile.removed += 1;
        entries.push({ text: line, kind: "change" });
        continue;
      }
    }
    if (line.startsWith(" ") || line === "" || line.startsWith("\\ No newline") || isWordDiffCmd) {
      entries.push({ text: line, kind: "context" });
    }
  }

  if (files.length === 0) return combined;

  const headerLines = [];
  if (mailboxSubjects.length > 0) {
    headerLines.push(`Patches: ${mailboxSubjects.length}`);
    for (const s of mailboxSubjects) headerLines.push(`  ${s}`);
  }
  headerLines.push(
    `Files changed: ${files.length}`,
    ...files.slice(0, 40).map((f) => `  ${f.name} (+${f.added} / -${f.removed})`),
    ...(files.length > 40 ? [`  ... (+${files.length - 40} more files)`] : []),
    ""
  );
  const summaryHeader = headerLines.join("\n");

  const effectiveMaxBytes =
    Number.isFinite(ctx?.maxBytes) && ctx.maxBytes > 0 ? ctx.maxBytes : MAX_FILTERED_OUTPUT_BYTES;
  const headerBytes = Buffer.byteLength(summaryHeader, "utf8");
  const hunkBudget = Math.max(800, effectiveMaxBytes - headerBytes - 180);
  const ctxHint = ctx?.sourceId ? `ctx_search(sourceId:"${ctx.sourceId}")` : "ctx_search";

  // Stage 1: Lossless within budget (100% of context lines preserved)
  const allLines = entries.map((e) => e.text);
  const allText = allLines.join("\n");
  if (Buffer.byteLength(allText, "utf8") <= hunkBudget) {
    return `${summaryHeader}${allText}`;
  }

  // Stage 2: Over budget + explicit context flag (-U/--unified/-W/--word-diff) -> preserve context, cap to budget
  if (hasExplicitContextFlag) {
    const { text: hunkText, omitted } = compactLinesBudget(allLines, hunkBudget);
    if (Array.isArray(ctx?.notes)) ctx.notes.push("context-preserved, capped");
    const tail =
      omitted > 0
        ? `\n... [+${omitted} diff lines omitted; narrow with 'git diff -- <file>' or ${ctxHint}]`
        : "";
    return `${summaryHeader}${hunkText}${tail}`;
  }

  // Stage 3a: Ordinary over-budget diff -> keep 1 line of context before/after every changed line
  const keepCtx1 = new Array(entries.length).fill(false);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind !== "context") {
      keepCtx1[i] = true;
    }
    if (entries[i].kind === "change") {
      if (i > 0 && entries[i - 1].kind === "context") keepCtx1[i - 1] = true;
      if (i + 1 < entries.length && entries[i + 1].kind === "context") keepCtx1[i + 1] = true;
    }
  }
  const ctx1Lines = [];
  let droppedForCtx1 = 0;
  for (let i = 0; i < entries.length; i++) {
    if (keepCtx1[i]) ctx1Lines.push(entries[i].text);
    else droppedForCtx1 += 1;
  }
  const ctx1Text = ctx1Lines.join("\n");
  if (Buffer.byteLength(ctx1Text, "utf8") <= hunkBudget) {
    if (droppedForCtx1 > 0 && Array.isArray(ctx?.notes)) ctx.notes.push("context trimmed to 1 line");
    return `${summaryHeader}${ctx1Text}`;
  }

  // Stage 3b: Still over budget -> compact +/- hunks only
  const compactLines = entries.filter((e) => e.kind !== "context").map((e) => e.text);
  const { text: hunkText, omitted } = compactLinesBudget(compactLines, hunkBudget);
  if (Array.isArray(ctx?.notes)) ctx.notes.push("context compacted");
  const tail =
    omitted > 0
      ? `\n... [+${omitted} diff lines omitted; narrow with 'git diff -- <file>' or ${ctxHint}]`
      : "";
  return `${summaryHeader}${hunkText}${tail}`;
}

/** Rule 3: git log */
function filterGitLog(combined, exitCode) {
  if (exitCode !== 0) return combined;
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length <= 40 && Buffer.byteLength(combined, "utf8") <= 3500) {
    return lines.join("\n");
  }
  // Compact full multi-line commit blocks into concise single-line entries when default format was used
  const commits = [];
  let curHash = "";
  let curAuthor = "";
  let curDate = "";
  let curMsg = "";
  const flush = () => {
    if (!curHash) return;
    commits.push(`${curHash.slice(0, 8)} ${curDate ? `[${curDate}] ` : ""}${curAuthor ? `<${curAuthor}> ` : ""}${curMsg}`.trim());
    curHash = "";
    curAuthor = "";
    curDate = "";
    curMsg = "";
  };
  let sawCommitHeader = false;
  for (const line of lines) {
    const cm = /^commit\s+([0-9a-f]{7,40})/i.exec(line);
    if (cm) {
      sawCommitHeader = true;
      flush();
      curHash = cm[1];
      continue;
    }
    if (sawCommitHeader) {
      if (line.startsWith("Author:")) {
        curAuthor = line.slice(7).replace(/<[^>]+>/, "").trim().slice(0, 24);
      } else if (line.startsWith("Date:")) {
        curDate = line.slice(5).trim().slice(0, 16);
      } else if (!curMsg && line.trim()) {
        curMsg = line.trim().slice(0, 100);
      }
    }
  }
  flush();
  if (sawCommitHeader && commits.length > 0) {
    const shown = commits.slice(0, 35);
    if (commits.length > shown.length) {
      shown.push(`... [+${commits.length - shown.length} more commits omitted]`);
    }
    return shown.join("\n");
  }
  const shownLines = lines.slice(0, 45);
  if (lines.length > shownLines.length) {
    shownLines.push(`... [+${lines.length - shownLines.length} more lines omitted]`);
  }
  return shownLines.join("\n");
}

// Find a run of identical lines, or lines with one consecutive numeric counter.
// Any other value change ends the run so that the exceptional line remains visible.
function repeatedRunEnd(lines, start) {
  const first = lines[start];
  const second = lines[start + 1];
  let end = start + 1;
  if (second === undefined) return end;
  if (first === second) {
    while (lines[end] === first) end++;
    return end;
  }
  const left = first.split(/(\d+)/);
  const right = second.split(/(\d+)/);
  if (left.length !== right.length) return end;
  const counter = left.findIndex((part, i) => part !== right[i]);
  if (counter < 0 || counter % 2 === 0) return end;
  const initial = Number(left[counter]);
  if (!Number.isSafeInteger(initial)) return end;
  const prefix = left.slice(0, counter).join("");
  const suffix = left.slice(counter + 1).join("");
  const width = left[counter].length;
  while (end < lines.length) {
    const value = String(initial + (end - start)).padStart(width, "0");
    if (lines[end] !== prefix + value + suffix) break;
    end++;
  }
  return end;
}

const PASS_REPORTER_LINE = /^\s*(?:TAP version \d+$|# Subtest: |ok \d+(?:\s+-\s|$)|[✔✓]\s+.*\([\d.]+\s*(?:ms|s)\)\s*$|--- PASS: |PASS\s+\S+\.(?:[cm]?[jt]sx?|py)\b|test \S+ \.\.\. ok$|---$|\.\.\.$|\d+\.\.\d+$)/;
const TAP_TEST_METADATA = /^\s+(?:duration_ms:\s+[\d.]+|type:\s+['"]?(?:test|suite)['"]?)\s*$/;
const TEST_TOTAL_LINE = /^\s*(?:[#ℹ]\s*)?(?:(?:tests?|suites?|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d|(?:Tests|Test Suites|test result):|\d+ passed\b|Ran \d+ tests?\b)/i;

export function compactPassingTestOutput(text, maxBytes, maxChars = maxBytes) {
  const fits = value => value.length <= maxChars && Buffer.byteLength(value, "utf8") <= maxBytes;
  if (fits(text)) return text;
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const header = `PASS (exit 0) — ${lines.length} raw lines compacted:\n`;
  if (!fits(header)) return truncateUtf8Safe(header.slice(0, maxChars), maxBytes);
  const withoutReporter = lines.filter(line =>
    !(PASS_REPORTER_LINE.test(line) || TAP_TEST_METADATA.test(line)) ||
    /\bwarn(?:ing)?\b/i.test(line) || isFailureAnchorLine(line)
  );
  const diagnostics = withoutReporter.length ? withoutReporter : lines;
  let body = diagnostics.join("\n");
  if (fits(header + body)) return header + body;

  const kept = [];
  for (let start = 0; start < diagnostics.length;) {
    const end = repeatedRunEnd(diagnostics, start);
    if (end - start >= 4) {
      kept.push(diagnostics[start], `... [${end - start - 2} repeated lines omitted] ...`, diagnostics[end - 1]);
    } else {
      kept.push(...diagnostics.slice(start, end));
    }
    start = end;
  }
  body = kept.join("\n");
  if (fits(header + body)) return header + body;

  // Keep warnings and the final counts visible even when unique diagnostics overflow.
  const summaries = [];
  const other = [];
  for (const line of kept) {
    if (TEST_TOTAL_LINE.test(line) || /\bwarn(?:ing)?\b/i.test(line) || isFailureAnchorLine(line)) summaries.push(line);
    else other.push(line);
  }
  const marker = "\n... [middle output omitted] ...\n";
  const availableBytes = maxBytes - Buffer.byteLength(header, "utf8");
  const availableChars = maxChars - header.length;
  const otherText = other.join("\n");
  const summary = truncateHeadTailUtf8Safe(
    summaries.join("\n"),
    Math.max(Math.floor(availableBytes / 2), availableBytes - Buffer.byteLength(otherText, "utf8") - (other.length ? 1 : 0)),
    marker,
    Math.max(Math.floor(availableChars / 2), availableChars - otherText.length - (other.length ? 1 : 0))
  );
  const tail = summary && other.length ? "\n" + summary : summary;
  body = truncateHeadTailUtf8Safe(otherText, availableBytes - Buffer.byteLength(tail, "utf8"), marker, availableChars - tail.length);
  return header + body + tail;
}

/** Rule 4: test runners (node --test, npm/pnpm/yarn test, vitest, jest, pytest, go test, cargo test) */
function filterTestRunner(combined, exitCode, ctx) {
  if (exitCode === 0) return compactPassingTestOutput(combined, ctx.maxBytes);
  const lines = combined.split("\n").map((l) => l.trimEnd());

  // Failing run: strip pure passing check lines, keep all failure blocks, assertions, stacks & summary
  const passNoiseRe = /^\s*(?:✔|✓|ok\s+\d+|PASS\s+|test\s+\S+\s+\.\.\.\s+ok\s*$|---\s+PASS:|passed\b.*\[100%\]|\.\s*$)/i;
  const kept = [];
  for (const line of lines) {
    if (passNoiseRe.test(line)) continue;
    kept.push(line);
  }
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed || combined;
}

/** Rule 5: build / lint / typecheck */
function filterBuildLint(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (exitCode === 0) {
    const important = lines.filter((l) =>
      /(?:warn(?:ing)?|error|built in|compiled|finished|done in|0 errors|succeeded|bundle|dist\/)/i.test(l)
    );
    if (important.length > 0 && important.length < lines.length) {
      return `OK (exit 0) — ${lines.length} raw lines compacted:\n${important.slice(-30).join("\n")}`;
    }
    return lines.slice(-25).join("\n");
  }

  // On failure: deduplicate repeated lines & strip progress noise while preserving all errors + context
  const progressRe = /^\s*(?:Compiling\s+|Downloading\s+|Updating\s+|Checking\s+|Fetching\s+|transforming\s*\(|rendering chunks|computing gzip)/i;
  const kept = [];
  for (const l of lines) {
    if (progressRe.test(l)) continue;
    if (kept[kept.length - 1] === l) continue;
    kept.push(l);
  }
  return kept.join("\n");
}

/** Rule 6: package install */
function filterPkgInstall(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (exitCode === 0) {
    const kept = lines.filter((l) =>
      /(?:added|removed|changed|audited|up to date|vulnerabilit|done in|installed|successfully|resolved|packages|warn|error)/i.test(l) &&
      !/npm warn deprecated/i.test(l) &&
      !/looking for funding/i.test(l)
    );
    return kept.length > 0 ? kept.slice(-25).join("\n") : lines.slice(-15).join("\n");
  }
  return lines.filter((l) => !/looking for funding/i.test(l)).slice(-80).join("\n");
}

/** Rule 7: docker build */
function filterDockerBuild(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (exitCode === 0) {
    const kept = lines.filter((l) =>
      /(?:^#\d+\s+\[|naming to|exporting to image|FINISHED|ERROR|WARN|Successfully built|Successfully tagged)/i.test(l)
    );
    return kept.length > 0 ? kept.slice(-35).join("\n") : lines.slice(-20).join("\n");
  }
  // Keep error tail
  return lines.slice(-100).join("\n");
}

/** Rule 8: GitHub CLI (gh pr view/diff/checks, gh run view, gh issue view) */
function filterGhCli(combined, exitCode, ctx = {}) {
  if (exitCode !== 0) return combined;
  const rawCmdStr = String(ctx?.command || "").trim();
  const unwrapped = rawCmdStr ? unwrapSafeCompoundCommand(rawCmdStr) : null;
  const cmdStr = unwrapped ? unwrapped.innerCommand : rawCmdStr;
  const isPrDiffCmd = /^gh(?:\.exe)?\s+pr\s+diff(?:\s|$)/i.test(cmdStr);
  const head512 = combined.replace(/\r\n/g, "\n").slice(0, 512).trimStart();
  const startsLikeDiff =
    /^diff --git /.test(head512) || /^From [0-9a-f]{40}\s/.test(head512);
  if (isPrDiffCmd || startsLikeDiff) {
    return filterGitDiff(combined, exitCode, ctx);
  }
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 45 && Buffer.byteLength(combined, "utf8") <= 4500) {
    return combined.replace(/\n{3,}/g, "\n\n").trim();
  }
  const importantRe =
    /(?:^(?:title|state|author|labels|assignees|reviewers|projects|milestone|number|url|branch|head|base|status|conclusion|workflow|job|step|checks?):|\b(?:FAIL|FAILED|ERROR|WARN|WARNING|CANCELLED|TIMED_OUT|SKIPPED|PENDING|PASS|PASSED|SUCCESS)\b|[✓✔✘×✗])/i;
  const head = nonEmpty.slice(0, 20);
  const tailImportant = nonEmpty.slice(20).filter((l) => importantRe.test(l));
  const merged = [...head];
  if (tailImportant.length > 0) {
    const omitted = nonEmpty.length - head.length - tailImportant.length;
    if (omitted > 0) merged.push(`... [+${omitted} body/log lines omitted]`);
    merged.push(...tailImportant.slice(-45));
  } else {
    merged.push(`... [+${nonEmpty.length - head.length - 15} middle lines omitted]`, ...nonEmpty.slice(-15));
  }
  return merged.join("\n");
}

/** Rule 9: Kubernetes CLI (kubectl logs/describe/get) */
function filterKubectl(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 45 && Buffer.byteLength(combined, "utf8") <= 4500) {
    return nonEmpty.join("\n");
  }

  // Collapse consecutive identical lines first
  const deduped = [];
  let repeatCount = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    const line = nonEmpty[i];
    if (deduped.length > 0 && deduped[deduped.length - 1] === line) {
      repeatCount += 1;
      continue;
    }
    if (repeatCount > 0) {
      deduped.push(`  ... [repeated ${repeatCount}x]`);
      repeatCount = 0;
    }
    deduped.push(line);
  }
  if (repeatCount > 0) deduped.push(`  ... [repeated ${repeatCount}x]`);

  if (exitCode !== 0) {
    return deduped.slice(-100).join("\n");
  }

  const probeNoiseRe = /(?:kube-probe|GET\s+\/(?:healthz|livez|readyz|metrics)\b.*\s200\b)/i;
  const cleaned = deduped.filter((l) => !probeNoiseRe.test(l));
  if (cleaned.length <= 60) return cleaned.join("\n");

  const anomalyRe =
    /(?:error|err\b|warn(?:ing)?|fatal|panic|exception|fail(?:ed|ure)?|CrashLoopBackOff|OOMKilled|ImagePullBackOff|ErrImagePull|Evicted|Unhealthy|BackOff|Pending|Terminating|Events:|Conditions:|Status:|State:|Last State:|Restart Count:)/i;
  const header = cleaned.slice(0, 15);
  const middle = cleaned.slice(15, -20).filter((l) => anomalyRe.test(l));
  const tail = cleaned.slice(-20);
  const out = [...header];
  if (middle.length > 0) {
    out.push(`... [filtered ${cleaned.length - 35} lines -> ${middle.length} alert/status lines]`);
    out.push(...middle.slice(-30));
  } else {
    out.push(`... [+${cleaned.length - 35} middle lines omitted]`);
  }
  out.push(...tail);
  return out.join("\n");
}

/** Rule 10: Terraform (terraform plan/apply/validate) */
function filterTerraform(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const refreshNoiseRe =
    /^\s*\S+:\s+(?:Refreshing state|Reading\.\.\.|Read complete after|Still reading|Still creating|Still modifying|Still destroying)\b/i;

  const withoutRefresh = lines.filter((l) => !refreshNoiseRe.test(l));
  if (exitCode !== 0) {
    return withoutRefresh.join("\n").replace(/\n{3,}/g, "\n\n").trim() || combined;
  }

  const nonEmpty = withoutRefresh.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 50 && Buffer.byteLength(withoutRefresh.join("\n"), "utf8") <= 4500) {
    return withoutRefresh.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const keepRe =
    /(?:^\s*#\s+\S+\s+(?:will be|must be|has changed|is tainted)|^\s*[+\-~!]\s+(?:resource|module|data)|^Plan:|^Apply complete!|^Destroy complete!|^No changes\.|^Success!|^Outputs:|^(?:│\s*)?(?:Error|Warning):|^[╷╵])/i;
  const kept = nonEmpty.filter((l) => keepRe.test(l));
  if (kept.length > 0) {
    return `Terraform OK (exit 0) — ${lines.length} raw lines compacted:\n${kept.slice(-70).join("\n")}`;
  }
  return nonEmpty.slice(-35).join("\n");
}

/** Rule 11: Playwright test runner */
function filterPlaywright(combined, exitCode, ctx) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const passLineRe = /^\s*(?:✓|✔|ok\s+\d+)\s+\d+\s+\[[^\]]+\]/i;
  const kept = lines.filter((line) => !passLineRe.test(line));
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (exitCode === 0) return compactPassingTestOutput(collapsed || combined, ctx.maxBytes);
  return collapsed || combined;
}

/** Apply a declarative project rule from .agy-dart/filters.json */
function filterDeclarativeRule(ruleDef, combined, exitCode, ctx = {}) {
  const rawLines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = rawLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return combined;

  const testLine = (re, line) =>
    re.test(line.length > MAX_CUSTOM_REGEX_LINE_CHARS ? line.slice(0, MAX_CUSTOM_REGEX_LINE_CHARS) : line);

  const isFail = exitCode !== 0;
  let stderrLineSet = null;
  if (isFail && typeof ctx?.cleanedStderr === "string" && ctx.cleanedStderr.trim()) {
    stderrLineSet = new Set(
      ctx.cleanedStderr
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0)
    );
  }
  const isProtectedErrorLine = (line) =>
    isFail && ((stderrLineSet && stderrLineSet.has(line)) || FAIL_ERROR_LINE_RE.test(line));

  const t0 = performance.now();
  let timedOut = false;
  const survived = [];
  const keepMatchedLines = [];
  const protectedErrorLines = [];

  for (let idx = 0; idx < nonEmpty.length; idx++) {
    const l = nonEmpty[idx];
    if ((l.length >= 256 || (idx & 15) === 15) && performance.now() - t0 > MAX_CUSTOM_FILTER_MS) {
      timedOut = true;
      break;
    }
    const protectedErr = isProtectedErrorLine(l);
    // Single-pass evaluation: test `keep` at most once per line and skip `drop` when `keep` or failure-protection applies
    const keepHit = ruleDef.keep ? testLine(ruleDef.keep, l) : false;
    if (protectedErr) {
      survived.push(l);
      protectedErrorLines.push(l);
      if (keepHit) keepMatchedLines.push(l);
      continue;
    }
    if (keepHit) {
      survived.push(l);
      keepMatchedLines.push(l);
      continue;
    }
    if (ruleDef.drop) {
      if (l.length >= 256 && performance.now() - t0 > MAX_CUSTOM_FILTER_MS) {
        timedOut = true;
        break;
      }
      if (testLine(ruleDef.drop, l)) {
        continue;
      }
    }
    survived.push(l);
  }

  const protectedErrorSet = isFail && protectedErrorLines.length > 0 ? new Set(protectedErrorLines) : null;
  let kept;
  if (timedOut) {
    // Fail-open to bounded head/tail snapshot if a custom regex approaches wall-clock budget across many lines
    kept = nonEmpty;
  } else if (ruleDef.keep) {
    if (keepMatchedLines.length > 0) {
      if (protectedErrorSet) {
        // Never allow untrusted custom `keep`/`drop` rules to silently swallow crash/error diagnostics on failure
        const keepSet = new Set(keepMatchedLines);
        kept = survived.filter((l) => keepSet.has(l) || protectedErrorSet.has(l));
      } else {
        kept = keepMatchedLines;
      }
    } else if (isFail) {
      // Never swallow an unexpected crash/error if keep pattern didn't match; let head + protectedErrors + tail apply below
      kept = survived;
    } else {
      kept = survived.slice(-Math.min(20, ruleDef.maxLines));
    }
  } else {
    kept = survived;
  }

  const maxLines = ruleDef.maxLines;
  if (kept.length > maxLines) {
    if ((isFail && (ruleDef.preserveTailOnFail || ruleDef.custom || protectedErrorLines.length > 0)) || timedOut) {
      const headCount = Math.max(1, Math.floor(maxLines * 0.35));
      const tailCount = Math.max(1, maxLines - headCount);
      const headSlice = kept.slice(0, headCount);
      const tailSlice = kept.slice(-tailCount);
      let extraErrors = [];
      if (protectedErrorSet) {
        const shown = new Set([...headSlice, ...tailSlice]);
        const missingErrors = Array.from(new Set(protectedErrorLines.filter((l) => !shown.has(l))));
        if (missingErrors.length > 0 && !tailSlice.some((l) => protectedErrorSet.has(l))) {
          extraErrors = missingErrors.slice(-Math.min(5, Math.max(1, tailCount)));
        }
      }
      const omitted = Math.max(0, kept.length - headSlice.length - tailSlice.length - extraErrors.length);
      kept =
        omitted > 0 || extraErrors.length > 0
          ? [
              ...headSlice,
              ...(omitted > 0 ? [`... [+${omitted} lines omitted; ${timedOut ? "filter budget exceeded, " : ""}tail preserved]`] : []),
              ...extraErrors,
              ...tailSlice
            ]
          : [...headSlice, ...tailSlice];
    } else {
      const omitted = kept.length - maxLines;
      kept = [...kept.slice(0, maxLines), `... [+${omitted} lines omitted]`];
    }
  }

  return kept.join("\n");
}

function parseProjectFilterFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { exists: false, stat: null, error: null, compiled: [], rejected: [] };
  }

  if (!stat.isFile()) {
    return { exists: true, stat, error: "not_a_file", compiled: [], rejected: [] };
  }
  if (stat.size <= 0) {
    return { exists: true, stat, error: "empty_file", compiled: [], rejected: [] };
  }
  if (stat.size > MAX_PROJECT_RULES_FILE_BYTES) {
    return { exists: true, stat, error: "file_too_large", compiled: [], rejected: [] };
  }

  let parsed;
  try {
    const raw = fs.readFileSync(absPath, "utf8").replace(/^\uFEFF/, "");
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, stat, error: "invalid_json", compiled: [], rejected: [] };
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) {
    return { exists: true, stat, error: "invalid_schema", compiled: [], rejected: [] };
  }
  if (parsed.rules.length > MAX_PROJECT_RULES_COUNT) {
    return { exists: true, stat, error: "too_many_rules", compiled: [], rejected: [] };
  }

  const seenIds = new Set();
  const compiled = [];
  const rejected = [];

  for (let idx = 0; idx < parsed.rules.length; idx++) {
    const item = parsed.rules[idx];
    if (!item || typeof item !== "object") {
      rejected.push({ id: `#${idx}`, field: "entry", reason: "invalid_entry" });
      continue;
    }
    const rawId = typeof item.id === "string" ? item.id.trim() : "";
    if (!CUSTOM_RULE_ID_RE.test(rawId)) {
      rejected.push({ id: sanitizeDiagText(rawId, 48) || `#${idx}`, field: "id", reason: "invalid_id" });
      continue;
    }
    if (seenIds.has(rawId)) {
      rejected.push({ id: rawId, field: "id", reason: "duplicate_id" });
      continue;
    }

    if (typeof item.match !== "string" || !isSafeRegex(item.match)) {
      rejected.push({
        id: rawId,
        field: "match",
        reason: typeof item.match === "string" ? "unsafe_or_invalid_regex" : "missing_match",
        pattern: typeof item.match === "string" ? sanitizeDiagText(item.match, 80) : undefined
      });
      continue;
    }
    let matchRe;
    try {
      matchRe = new RegExp(item.match, "i");
    } catch {
      rejected.push({ id: rawId, field: "match", reason: "invalid_regex", pattern: sanitizeDiagText(item.match, 80) });
      continue;
    }

    let keepRe = null;
    if (item.keep !== undefined && item.keep !== null && item.keep !== "") {
      if (typeof item.keep !== "string" || !isSafeRegex(item.keep)) {
        rejected.push({
          id: rawId,
          field: "keep",
          reason: typeof item.keep === "string" ? "unsafe_or_invalid_regex" : "invalid_keep",
          pattern: typeof item.keep === "string" ? sanitizeDiagText(item.keep, 80) : undefined
        });
        continue;
      }
      try {
        keepRe = new RegExp(item.keep, "i");
      } catch {
        rejected.push({ id: rawId, field: "keep", reason: "invalid_regex", pattern: sanitizeDiagText(item.keep, 80) });
        continue;
      }
    }

    let dropRe = null;
    if (item.drop !== undefined && item.drop !== null && item.drop !== "") {
      if (typeof item.drop !== "string" || !isSafeRegex(item.drop)) {
        rejected.push({
          id: rawId,
          field: "drop",
          reason: typeof item.drop === "string" ? "unsafe_or_invalid_regex" : "invalid_drop",
          pattern: typeof item.drop === "string" ? sanitizeDiagText(item.drop, 80) : undefined
        });
        continue;
      }
      try {
        dropRe = new RegExp(item.drop, "i");
      } catch {
        rejected.push({ id: rawId, field: "drop", reason: "invalid_regex", pattern: sanitizeDiagText(item.drop, 80) });
        continue;
      }
    }

    const rawMaxLines = Number(item.maxLines);
    const maxLines =
      Number.isInteger(rawMaxLines) && rawMaxLines >= 1
        ? Math.min(500, rawMaxLines)
        : 80;
    const preserveTailOnFail =
      typeof item.preserveTailOnFail === "boolean" ? item.preserveTailOnFail : true;

    const ruleDef = {
      id: `custom:${rawId}`,
      rawId,
      custom: true,
      pattern: matchRe,
      keep: keepRe,
      drop: dropRe,
      maxLines,
      preserveTailOnFail,
      filter: null
    };
    ruleDef.filter = (combined, exitCode, ctx) => filterDeclarativeRule(ruleDef, combined, exitCode, ctx);

    seenIds.add(rawId);
    compiled.push(ruleDef);
  }

  return { exists: true, stat, error: null, compiled, rejected };
}

/**
 * Inspect `<cwd>/.agy-dart/filters.json` for diagnostics (`doctor` / `ctx_doctor`),
 * surfacing file-level parse/size errors and individual rules rejected by `isSafeRegex` or ID validation.
 */
export function inspectProjectFilterRules(cwd = process.cwd()) {
  if (!cwd || typeof cwd !== "string") {
    return { path: "", exists: false, error: null, loadedCount: 0, loadedIds: [], rejectedCount: 0, rejected: [] };
  }
  const absPath = path.join(path.resolve(cwd), ".agy-dart", "filters.json");
  const parsed = parseProjectFilterFile(absPath);
  return {
    path: absPath,
    exists: parsed.exists,
    error: parsed.error,
    loadedCount: parsed.compiled.length,
    loadedIds: parsed.compiled.map((r) => r.id),
    rejectedCount: parsed.rejected.length,
    rejected: parsed.rejected
  };
}

/**
 * Load declarative project-level filter rules from `<cwd>/.agy-dart/filters.json`.
 * Cached by `absPath + mtimeMs + size`, max 64 KB, max 20 rules, strictly fail-open
 * on missing/malformed files or ReDoS-prone/invalid regexes.
 */
export function loadProjectFilterRules(cwd = process.cwd()) {
  if (!cwd || typeof cwd !== "string") return [];
  const absPath = path.join(path.resolve(cwd), ".agy-dart", "filters.json");

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    projectRulesCache.delete(absPath);
    return [];
  }

  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROJECT_RULES_FILE_BYTES) {
    projectRulesCache.delete(absPath);
    return [];
  }

  const cached = projectRulesCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.rules;
  }

  const parsed = parseProjectFilterFile(absPath);
  if (parsed.error) {
    projectRulesCache.delete(absPath);
    return [];
  }

  if (projectRulesCache.size >= MAX_PROJECT_RULES_CACHE_ENTRIES) {
    const oldestKey = projectRulesCache.keys().next().value;
    if (oldestKey !== undefined) projectRulesCache.delete(oldestKey);
  }
  projectRulesCache.set(absPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    rules: parsed.compiled
  });

  return parsed.compiled;
}

export const FILTER_RULES = [
  {
    id: "git-status",
    pattern: /^git(?:\.exe)?\s+status(?:\s|$)/i,
    match(cmd) {
      const parsed = parseGitSubcommand(cmd);
      return parsed && parsed.subcommand === "status" ? { matched: true, skipTarget: parsed.rest } : false;
    },
    filter: filterGitStatus
  },
  {
    id: "git-diff",
    pattern: /^git(?:\.exe)?\s+diff(?:\s|$)/i,
    match(cmd) {
      const parsed = parseGitSubcommand(cmd);
      return parsed && parsed.subcommand === "diff" ? { matched: true, skipTarget: parsed.rest } : false;
    },
    prepareCommand(cmd) {
      if (/(?:^|\s)--word-diff=color(?=\s|$)/i.test(cmd)) {
        return {
          effectiveCommand: cmd.replace(/((?:^|\s))--word-diff=color(?=\s|$)/gi, "$1--word-diff=plain"),
          note: "normalized --word-diff=color to plain"
        };
      }
      return { effectiveCommand: cmd, note: null };
    },
    filter: filterGitDiff
  },
  {
    id: "git-log",
    pattern: /^git(?:\.exe)?\s+log(?:\s|$)/i,
    match(cmd) {
      const parsed = parseGitSubcommand(cmd);
      return parsed && parsed.subcommand === "log" ? { matched: true, skipTarget: parsed.rest } : false;
    },
    // Never strip diff hunks or custom graph/raw views when user explicitly asks for patches
    skipFlags: /(?:^|\s)(?:-p|--patch|-u|--raw|--graph|--cc)(?=\s|$)/,
    filter: filterGitLog,
    prepareCommand(cmd) {
      const parsed = parseGitSubcommand(cmd);
      const rest = parsed && parsed.subcommand === "log" ? parsed.rest : cmd;
      const hasBound =
        /(?:^|\s)(?:-n\s*\d+|-\d+|--max-count(?:=|\s)\d+|--since(?:=|\s)\S+|--after(?:=|\s)\S+|\S+\.\.\S+)(?=\s|$)/i.test(
          rest
        );
      if (hasBound) return { effectiveCommand: cmd, note: null };
      const bounded =
        parsed && parsed.subcommand === "log"
          ? `${cmd.slice(0, parsed.subcommandEnd)} -n 30${cmd.slice(parsed.subcommandEnd)}`
          : cmd.replace(/^git(?:\.exe)?\s+log\b/i, "$& -n 30");
      return { effectiveCommand: bounded, note: "bounded unbounded git log to -n 30" };
    }
  },
  {
    id: "test-runner",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run\s+)?test(?:\s|$)|node(?:\.exe)?\s+--test(?:\s|$)|(?:npx(?:\.cmd)?\s+)?(?:vitest|jest|mocha|ava)(?:\s|$)|pytest(?:\s|$)|python(?:3)?(?:\.exe)?\s+-m\s+(?:pytest|unittest)(?:\s|$)|go(?:\.exe)?\s+test(?:\s|$)|cargo(?:\.exe)?\s+test(?:\s|$)|dotnet(?:\.exe)?\s+test(?:\s|$))/i,
    match(cmd) {
      const pm = parsePkgManagerCommand(cmd);
      if (pm) {
        return pm.subcommand === "test" ? { matched: true, skipTarget: pm.rest } : false;
      }
      return this.pattern.test(cmd);
    },
    filter: filterTestRunner
  },
  {
    id: "build-lint",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run\s+)?(?:build|lint|typecheck|check)(?:\s|$)|(?:npx(?:\.cmd)?\s+)?(?:tsc|eslint|biome|vite\s+build|next\s+build|webpack)(?:\s|$)|ruff\s+check(?:\s|$)|mypy(?:\s|$)|flake8(?:\s|$)|cargo(?:\.exe)?\s+(?:build|check|clippy)(?:\s|$)|go(?:\.exe)?\s+(?:build|vet)(?:\s|$)|dotnet(?:\.exe)?\s+build(?:\s|$))/i,
    match(cmd) {
      const pm = parsePkgManagerCommand(cmd);
      if (pm) {
        return ["build", "lint", "typecheck", "check"].includes(pm.subcommand)
          ? { matched: true, skipTarget: pm.rest }
          : false;
      }
      return this.pattern.test(cmd);
    },
    filter: filterBuildLint
  },
  {
    id: "pkg-install",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:install|i|ci|add|update)(?:\s|$)|(?:pip|pip3|uv\s+pip)(?:\.exe)?\s+install(?:\s|$))/i,
    match(cmd) {
      const pm = parsePkgManagerCommand(cmd);
      if (pm) {
        return pm.action !== "run" && ["install", "i", "ci", "add", "update"].includes(pm.subcommand)
          ? { matched: true, skipTarget: pm.rest }
          : false;
      }
      return this.pattern.test(cmd);
    },
    filter: filterPkgInstall
  },
  {
    id: "docker-build",
    preserveTailOnFail: true,
    pattern: /^docker(?:\.exe)?\s+(?:compose\s+)?build(?:\s|$)/i,
    filter: filterDockerBuild
  },
  {
    id: "gh-cli",
    preserveTailOnFail: true,
    pattern: /^gh(?:\.exe)?\s+(?:pr\s+(?:view|diff|checks)|run\s+view|issue\s+view)(?:\s|$)/i,
    skipFlags: /(?:^|\s)(?:--web|--jq(?:=|\s)\S+|--template(?:=|\s)\S+)(?=\s|$)/,
    filter: filterGhCli
  },
  {
    id: "kubectl",
    preserveTailOnFail: true,
    pattern: /^kubectl(?:\.exe)?\s+(?:logs|describe|get)(?:\s|$)/i,
    skipFlags: /(?:^|\s)(?:-f|--follow)(?=\s|$)/,
    filter: filterKubectl
  },
  {
    id: "terraform",
    preserveTailOnFail: true,
    pattern: /^terraform(?:\.exe)?\s+(?:plan|apply|validate)(?:\s|$)/i,
    skipFlags: /(?:^|\s)-json(?=\s|$)/,
    filter: filterTerraform
  },
  {
    id: "playwright",
    preserveTailOnFail: true,
    pattern: /^(?:(?:npx|pnpm|yarn|bunx)(?:\.cmd|\.exe)?\s+)?playwright(?:\.cmd|\.exe)?\s+test(?:\s|$)/i,
    match(cmd) {
      if (this.pattern.test(cmd)) return true;
      const pm = parsePkgManagerCommand(cmd);
      if (!pm) return false;
      if (
        pm.action !== "run" &&
        pm.manager !== "npm" &&
        pm.subcommand === "playwright" &&
        /^\s+test(?:\s|$)/i.test(pm.rest)
      ) {
        return { matched: true, skipTarget: pm.rest };
      }
      if (pm.action === "exec" && /^\s+playwright(?:\.cmd|\.exe)?\s+test(?:\s|$)/i.test(pm.rest)) {
        return { matched: true, skipTarget: pm.rest };
      }
      return false;
    },
    filter: filterPlaywright
  }
];

function rewrapCompound(unwrapped, effectiveInner) {
  return `${unwrapped.cdPrefix}${effectiveInner}${unwrapped.trailingRedirect}`;
}

/**
 * Determine whether a CommandLine should be transparently rewritten through cli-filter.mjs.
 * Supports optional safe single leading `cd [/d] <path> &&` and trailing `2>&1`.
 * Checks built-in rules first, then valid repo-level `.agy-dart/filters.json` rules.
 * Returns { rule, effectiveCommand, note } or null if command should run untouched.
 */
export function matchFilterRule(commandLine, options = {}) {
  if (!commandLine || typeof commandLine !== "string") return null;
  const trimmed = commandLine.trim();
  if (!trimmed) return null;
  if (trimmed.includes("cli-filter.mjs")) return null;

  const unwrapped = unwrapSafeCompoundCommand(trimmed);
  if (!unwrapped) return null;
  const inner = unwrapped.innerCommand;
  if (SKIP_FLAGS_RE.test(inner)) return null;

  const baseCwd = options?.cwd || process.cwd();
  const effectiveTargetCwd = unwrapped.cdPath ? resolveCdTargetCwd(baseCwd, unwrapped.cdPath) : baseCwd;
  const activePlatform = options?.platform || process.platform;
  if (activePlatform === "win32" && hasWindowsCrossShellHazard(inner, effectiveTargetCwd, options?.env || process.env)) {
    return null;
  }

  if (!options.customOnly) {
    for (const rule of FILTER_RULES) {
      const matchResult = typeof rule.match === "function" ? rule.match(inner) : rule.pattern.test(inner);
      if (matchResult) {
        const skipTarget =
          typeof matchResult === "object" && typeof matchResult.skipTarget === "string"
            ? matchResult.skipTarget
            : inner;
        if (rule.skipFlags && rule.skipFlags.test(skipTarget)) {
          return null;
        }
        if (typeof rule.prepareCommand === "function") {
          const prep = rule.prepareCommand(inner);
          return {
            rule,
            effectiveCommand: rewrapCompound(unwrapped, prep.effectiveCommand),
            note: prep.note || null
          };
        }
        return {
          rule,
          effectiveCommand: rewrapCompound(unwrapped, inner),
          note: null
        };
      }
    }
  }

  if (options.builtinOnly) return null;

  // Enforce command-line length budget before matching custom project regexes
  if (inner.length > MAX_CUSTOM_MATCH_CMD_CHARS) return null;

  // Fallback to project-level declarative rules (.agy-dart/filters.json)
  // Prefer the unwrapped `cd <path>` target directory first, then fall back to caller cwd.
  const searchCwds = [];
  if (unwrapped.cdPath) {
    const targetCwd = resolveCdTargetCwd(baseCwd, unwrapped.cdPath);
    if (targetCwd) searchCwds.push(targetCwd);
  }
  const resolvedBase = path.resolve(baseCwd);
  if (!searchCwds.some((d) => path.resolve(d) === resolvedBase)) {
    searchCwds.push(resolvedBase);
  }
  const matchDeadline = Date.now() + 25;
  for (const dir of searchCwds) {
    const projectRules = loadProjectFilterRules(dir);
    for (const rule of projectRules) {
      if (Date.now() > matchDeadline) return null;
      if (rule.pattern.test(inner)) {
        return {
          rule,
          effectiveCommand: rewrapCompound(unwrapped, inner),
          note: null
        };
      }
    }
  }

  return null;
}

/**
 * Apply the matched filter rule to raw stdout/stderr and enforce the <= 7900 B UTF-8 cap.
 * Automatically runs structural JSON/JSONL SmartCrusher when output is large JSON/JSONL.
 */
export function applyFilterRule(ruleId, rawStdout, rawStderr, exitCode = 0, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_FILTERED_OUTPUT_BYTES;
  const rawCombined =
    (rawStdout || "") +
    (rawStderr ? (rawStdout && !rawStdout.endsWith("\n") ? "\n" : "") + rawStderr : "");
  const rawBytes = Buffer.byteLength(rawCombined, "utf8");
  const cleaned = stripAnsiAndProgress(rawCombined);
  // A complete passing log needs no footer. Don't withhold its last few hundred bytes to reserve one.
  if (ruleId === "test-runner" && exitCode === 0 && !options.note && rawBytes <= maxBytes && !isJsonLikeFn?.(cleaned)) {
    return {
      filteredText: cleaned,
      rawBytes,
      filteredBytes: Buffer.byteLength(cleaned, "utf8"),
      wasFiltered: false,
      truncated: false,
      crushedJson: false
    };
  }

  let rule = FILTER_RULES.find((r) => r.id === ruleId);
  if (!rule && typeof ruleId === "string" && ruleId.startsWith("custom:")) {
    const cwd = options.cwd || process.cwd();
    const rawCmd = typeof options.command === "string" ? options.command.trim() : "";
    const unwrappedCmd = rawCmd ? unwrapSafeCompoundCommand(rawCmd) : null;
    const innerCmd = unwrappedCmd ? unwrappedCmd.innerCommand : rawCmd;
    const searchDirs = [];
    if (unwrappedCmd?.cdPath) {
      const targetCwd = resolveCdTargetCwd(cwd, unwrappedCmd.cdPath);
      if (targetCwd) searchDirs.push(targetCwd);
    }
    if (!searchDirs.some((d) => path.resolve(d) === path.resolve(cwd))) {
      searchDirs.push(cwd);
    }
    if (options.fallbackCwd && !searchDirs.some((d) => path.resolve(d) === path.resolve(options.fallbackCwd))) {
      searchDirs.push(options.fallbackCwd);
    }
    if (innerCmd && innerCmd.length <= MAX_CUSTOM_MATCH_CMD_CHARS) {
      for (const dir of searchDirs) {
        const candidate = loadProjectFilterRules(dir).find((r) => r.id === ruleId && r.pattern.test(innerCmd));
        if (candidate) {
          rule = candidate;
          break;
        }
      }
    }
    if (!rule) {
      for (const dir of searchDirs) {
        const candidate = loadProjectFilterRules(dir).find((r) => r.id === ruleId);
        if (candidate) {
          rule = candidate;
          break;
        }
      }
    }
  }

  const noteParts = [];
  if (options.note) noteParts.push(options.note);
  const passingTest = exitCode === 0 && (ruleId === "test-runner" || ruleId === "playwright");
  const queryHint = passingTest ? "use ctx_search for details missing from this preview" : "query via agy-dart_context ctx_search";
  const indexLabel = options.truncatedCapture ? "head+tail output indexed" : "full output indexed";
  const sourceHint = options.sourceId
    ? ` ${indexLabel} as ${options.sourceId} (${queryHint})`
    : "";

  const reserveFooter = Math.max(
    240,
    160 +
      Buffer.byteLength(String(ruleId || ""), "utf8") +
      Buffer.byteLength(noteParts.join(", "), "utf8") +
      Buffer.byteLength(sourceHint, "utf8")
  );
  const jsonCrushThreshold = Math.max(512, maxBytes - 300);
  const crushBudget = Math.max(256, maxBytes - reserveFooter);

  let filtered = "";
  let crushedJson = false;
  let truncated = false;

  // For large JSON/JSONL payloads without explicit line keep/drop overrides, crush structurally
  // instead of mangling JSON lines or blindly byte-truncating mid-object.
  const hasExplicitLineFilters = Boolean(rule?.custom && (rule.keep || rule.drop));
  if (
    !hasExplicitLineFilters &&
    smartCrushJsonFn &&
    isJsonLikeFn &&
    Buffer.byteLength(cleaned, "utf8") > jsonCrushThreshold &&
    isJsonLikeFn(cleaned)
  ) {
    const crushed = smartCrushJsonFn(cleaned, {
      maxBytes: crushBudget,
      sourceId: options.sourceId || null
    });
    if (crushed.crushed) {
      filtered = crushed.text;
      crushedJson = true;
      noteParts.push("json-crushed");
    }
  }

  const ruleNotes = [];
  if (!crushedJson) {
    const stderrForGuard = rawStderr || (typeof options.capturedStderr === "string" ? options.capturedStderr : "");
    const cleanedStderr = stderrForGuard ? stripAnsiAndProgress(stderrForGuard) : "";
    filtered = rule
      ? rule.filter(cleaned, exitCode, {
          cleanedStderr,
          command: typeof options.command === "string" ? options.command : "",
          maxBytes: crushBudget,
          sourceId: options.sourceId || null,
          notes: ruleNotes
        })
      : cleaned;
    if (!filtered && cleaned) filtered = cleaned;
    for (const rn of ruleNotes) {
      if (typeof rn === "string" && rn.trim()) noteParts.push(rn.trim());
    }

    // Also structurally crush if post-rule output is STILL large JSON/JSONL
    if (
      smartCrushJsonFn &&
      isJsonLikeFn &&
      Buffer.byteLength(filtered, "utf8") > jsonCrushThreshold &&
      isJsonLikeFn(filtered)
    ) {
      const crushed = smartCrushJsonFn(filtered, {
        maxBytes: crushBudget,
        sourceId: options.sourceId || null
      });
      if (crushed.crushed) {
        filtered = crushed.text;
        crushedJson = true;
        noteParts.push("json-crushed");
      }
    }
  }

  const keepTail = exitCode !== 0 && (Boolean(rule?.preserveTailOnFail) || Boolean(rule?.custom));
  const effectiveReserve = Math.max(
    reserveFooter,
    (exitCode !== 0 ? 200 : 180) +
      Buffer.byteLength(String(ruleId || ""), "utf8") +
      Buffer.byteLength(noteParts.join(", "), "utf8") +
      Buffer.byteLength(sourceHint, "utf8")
  );
  const bodyBudget = Math.max(0, maxBytes - effectiveReserve);
  if (Buffer.byteLength(filtered, "utf8") > bodyBudget) {
    if (exitCode !== 0) {
      const anchored = compactFailureWithErrorAnchors(filtered, bodyBudget);
      if (anchored !== null) {
        filtered = anchored;
        noteParts.push("error-anchors");
      } else {
        filtered = keepTail
          ? truncateHeadTailUtf8Safe(filtered, bodyBudget)
          : truncateUtf8Safe(filtered, bodyBudget);
      }
    } else {
      filtered = truncateUtf8Safe(filtered, bodyBudget);
    }
    truncated = true;
  }

  const hasRuleNotes = ruleNotes.length > 0;
  let filteredBodyBytes = Buffer.byteLength(filtered, "utf8");
  // Never inflate tiny already-compact outputs when no truncation, JSON crush, or rewrite/rule note occurred
  if (
    !truncated &&
    !crushedJson &&
    !options.note &&
    !hasRuleNotes &&
    filteredBodyBytes >= rawBytes &&
    Buffer.byteLength(cleaned, "utf8") <= maxBytes
  ) {
    filtered = cleaned;
    filteredBodyBytes = Buffer.byteLength(filtered, "utf8");
  }

  const savedBytes = Math.max(0, rawBytes - filteredBodyBytes);
  const wasFiltered = truncated || crushedJson || savedBytes >= 256 || Boolean(options.note) || hasRuleNotes;

  if (wasFiltered) {
    const pct = rawBytes > 0 ? ((savedBytes / rawBytes) * 100).toFixed(0) : "0";
    const meta = [
      `rule=${ruleId}`,
      `${rawBytes}B -> ${filteredBodyBytes}B (-${pct}%)`,
      ...noteParts
    ].join(", ");
    const footer = `\n[agy-dart cli-filter: ${meta}${truncated ? ", capped <=8.8KB" : ""}${sourceHint ? `;${sourceHint}` : ""}]`;
    const combinedWithFooter = filtered + footer;
    filtered =
      Buffer.byteLength(combinedWithFooter, "utf8") <= maxBytes
        ? combinedWithFooter
        : (keepTail
            ? truncateHeadTailUtf8Safe(filtered, maxBytes - Buffer.byteLength(footer, "utf8"))
            : truncateUtf8Safe(filtered, maxBytes - Buffer.byteLength(footer, "utf8"))) + footer;
  }

  const finalBytes = Buffer.byteLength(filtered, "utf8");
  return {
    filteredText: filtered,
    rawBytes,
    filteredBytes: finalBytes,
    wasFiltered,
    truncated,
    crushedJson
  };
}
