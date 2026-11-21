/**
 * Declarative CLI output filter rules for agy-dart PreToolUse.overwrite.
 * Clean-room zero-dependency implementation inspired by MIT-licensed tokf patterns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  /(?:^|\b)(?:error|err!|fail(?:ed|ure)?|fatal|panic|exception|traceback|assertionerror|syntaxerror|typeerror|referenceerror|enoent|eacces|econnrefused|not ok|✖|✗)(?:\b|:|$)/i;

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

/** Truncate string strictly by UTF-8 byte length without breaking multi-byte characters */
export function truncateUtf8Safe(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
  return sliced.replace(/\uFFFD+$/, "");
}

/** Take strictly the last <= maxBytes UTF-8 bytes without splitting a leading multi-byte character */
export function truncateTailUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = Math.max(0, buf.length - Math.max(0, maxBytes));
  // Advance past any UTF-8 continuation bytes (10xxxxxx)
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8").replace(/^\uFFFD+/, "");
}

/** Preserve both head context (~35%) and failure tail/summary (~65%) within <= maxBytes UTF-8 */
export function truncateHeadTailUtf8Safe(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n... [middle omitted to stay <=8.8KB; tail failure/summary preserved] ...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const avail = maxBytes - markerBytes;
  if (avail < 200) return truncateTailUtf8Safe(text, maxBytes);
  const headBudget = Math.floor(avail * 0.35);
  const tailBudget = avail - headBudget;
  const head = truncateUtf8Safe(text, headBudget).replace(/\s+$/, "");
  const tail = truncateTailUtf8Safe(text, tailBudget).replace(/^\s+/, "");
  return `${head}${marker}${tail}`;
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

  const chargeBarrierBypass = () => {
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
          if (!chargeBarrierBypass()) return false;
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
            if (!chargeBarrierBypass()) return false;
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

/** Rule 2: git diff */
function filterGitDiff(combined, exitCode) {
  if (exitCode !== 0) return combined;
  const lines = combined.split("\n");
  const files = [];
  let curFile = null;
  let inHunk = false;
  const compactHunks = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const mQuoted = /^diff --git "a\/(.+?)" "b\/(.+)"$/.exec(line);
      const mPlain = !mQuoted ? /^diff --git a\/(.+?) b\/(.+)$/.exec(line) : null;
      const name = mQuoted ? mQuoted[2] : mPlain ? mPlain[2] : line.slice(11);
      curFile = { name, added: 0, removed: 0 };
      files.push(curFile);
      compactHunks.push(`=== ${name}`);
      continue;
    }
    if (!inHunk && (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      compactHunks.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      if (curFile) curFile.added += 1;
      compactHunks.push(line);
      continue;
    }
    if (line.startsWith("-")) {
      if (curFile) curFile.removed += 1;
      compactHunks.push(line);
      continue;
    }
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
      compactHunks.push(line);
    }
  }

  if (files.length === 0) return combined;

  const summaryHeader = [
    `Files changed: ${files.length}`,
    ...files.slice(0, 40).map((f) => `  ${f.name} (+${f.added} / -${f.removed})`),
    ...(files.length > 40 ? [`  ... (+${files.length - 40} more files)`] : []),
    ""
  ].join("\n");

  const headerBytes = Buffer.byteLength(summaryHeader, "utf8");
  const hunkBudget = Math.max(1200, MAX_FILTERED_OUTPUT_BYTES - headerBytes - 300);
  const { text: hunkText, omitted } = compactLinesBudget(compactHunks, hunkBudget);
  const tail = omitted > 0 ? `\n... [+${omitted} diff lines omitted; narrow with 'git diff -- <file>' or ctx_search]` : "";
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

/** Rule 4: test runners (node --test, npm/pnpm/yarn test, vitest, jest, pytest, go test, cargo test) */
function filterTestRunner(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  const summaryRe =
    /(?:^|\s)(?:tests?\s+\d+|suites?\s+\d+|pass(?:ed)?\s*[:=]?\s*\d+|fail(?:ed|ures?)?\s*[:=]?\s*\d+|skipped?\s*[:=]?\s*\d+|duration_ms|test result:|passed in \d|failed in \d|ran \d+ tests?|total:\s*\d+|Tests:\s+|Test Suites:\s+|FAIL\s+|PASS\s+|ok\s+\S+\s+\d|---\s+FAIL:|errors?\b)/i;

  if (exitCode === 0) {
    // Passing run: keep summary lines, warnings, and test count totals; collapse passing checklists
    const kept = [];
    for (const line of nonEmpty) {
      if (
        summaryRe.test(line) ||
        /\bwarn(?:ing)?\b/i.test(line) ||
        /^ℹ\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(line.trim())
      ) {
        kept.push(line);
      }
    }
    if (kept.length > 0) {
      const unique = [];
      for (const l of kept) {
        if (unique[unique.length - 1] !== l) unique.push(l);
      }
      return `PASS (exit 0) — ${nonEmpty.length} raw lines compacted:\n${unique.slice(-40).join("\n")}`;
    }
    // Fallback: last 20 lines
    return `PASS (exit 0) — tail:\n${nonEmpty.slice(-20).join("\n")}`;
  }

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
function filterGhCli(combined, exitCode) {
  if (exitCode !== 0) return combined;
  if (combined.includes("diff --git ")) {
    return filterGitDiff(combined, exitCode);
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
function filterPlaywright(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  if (exitCode === 0) {
    const keepRe =
      /(?:Running\s+\d+\s+tests?|\b\d+\s+(?:passed|failed|flaky|skipped|interrupted)\b|Slow test file|\bwarn(?:ing)?\b)/i;
    const kept = nonEmpty.filter((l) => keepRe.test(l));
    if (kept.length > 0) {
      return `PASS (exit 0) — ${nonEmpty.length} raw lines compacted:\n${kept.slice(-35).join("\n")}`;
    }
    return `PASS (exit 0) — tail:\n${nonEmpty.slice(-20).join("\n")}`;
  }

  // On failure: strip passing test lines, keep all failure blocks, locators, call logs & summary
  const passLineRe = /^\s*(?:✓|✔|ok\s+\d+)\s+\d+\s+\[[^\]]+\]/i;
  const kept = lines.filter((l) => !passLineRe.test(l));
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
    filter: filterTestRunner
  },
  {
    id: "build-lint",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run\s+)?(?:build|lint|typecheck|check)(?:\s|$)|(?:npx(?:\.cmd)?\s+)?(?:tsc|eslint|biome|vite\s+build|next\s+build|webpack)(?:\s|$)|ruff\s+check(?:\s|$)|mypy(?:\s|$)|flake8(?:\s|$)|cargo(?:\.exe)?\s+(?:build|check|clippy)(?:\s|$)|go(?:\.exe)?\s+(?:build|vet)(?:\s|$)|dotnet(?:\.exe)?\s+build(?:\s|$))/i,
    filter: filterBuildLint
  },
  {
    id: "pkg-install",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:install|i|ci|add|update)(?:\s|$)|(?:pip|pip3|uv\s+pip)(?:\.exe)?\s+install(?:\s|$))/i,
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
  const baseCwd = options?.cwd || process.cwd();
  const searchCwds = [];
  if (unwrapped.cdPath) {
    const targetCwd = resolveCdTargetCwd(baseCwd, unwrapped.cdPath);
    if (targetCwd) searchCwds.push(targetCwd);
  }
  const resolvedBase = path.resolve(baseCwd);
  if (!searchCwds.some((d) => path.resolve(d) === resolvedBase)) {
    searchCwds.push(resolvedBase);
  }
  for (const dir of searchCwds) {
    const projectRules = loadProjectFilterRules(dir);
    for (const rule of projectRules) {
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
  const sourceHint = options.sourceId
    ? ` full output indexed as ${options.sourceId} (query via agy-dart_context ctx_search)`
    : "";

  const reserveFooter = Math.max(
    220,
    140 +
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

  if (!crushedJson) {
    const stderrForGuard = rawStderr || (typeof options.capturedStderr === "string" ? options.capturedStderr : "");
    const cleanedStderr = stderrForGuard ? stripAnsiAndProgress(stderrForGuard) : "";
    filtered = rule ? rule.filter(cleaned, exitCode, { cleanedStderr }) : cleaned;
    if (!filtered && cleaned) filtered = cleaned;

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
  if (Buffer.byteLength(filtered, "utf8") > maxBytes - reserveFooter) {
    filtered = keepTail
      ? truncateHeadTailUtf8Safe(filtered, maxBytes - reserveFooter)
      : truncateUtf8Safe(filtered, maxBytes - reserveFooter);
    truncated = true;
  }

  let filteredBodyBytes = Buffer.byteLength(filtered, "utf8");
  // Never inflate tiny already-compact outputs when no truncation, JSON crush, or rewrite note occurred
  if (
    !truncated &&
    !crushedJson &&
    !options.note &&
    filteredBodyBytes >= rawBytes &&
    Buffer.byteLength(cleaned, "utf8") <= maxBytes
  ) {
    filtered = cleaned;
    filteredBodyBytes = Buffer.byteLength(filtered, "utf8");
  }

  const savedBytes = Math.max(0, rawBytes - filteredBodyBytes);
  const wasFiltered = truncated || crushedJson || savedBytes >= 256 || Boolean(options.note);

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
