#!/usr/bin/env node
/**
 * Static import-graph verifier for agy-dart packaging (`scripts/install.mjs`).
 *
 * Traverses all runtime entrypoints declared in hooks.json, mcp_config.json,
 * sidecars/dashboard/sidecar.json, and scripts/install.mjs to prove:
 *   1. Every transitively imported local JS/MJS module or spawned helper script
 *      is listed in RUNTIME_FILES (zero missing-module install bugs).
 *   2. Every file in RUNTIME_FILES and DEVTOOLS_FILES exists on disk.
 *   3. Zero DEVTOOLS_FILES leak into the runtime import graph.
 *   4. Every module transitively imported by DEVTOOLS_FILES is covered by
 *      RUNTIME_FILES U DEVTOOLS_FILES.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVTOOLS_FILES, FILES_TO_COPY, RUNTIME_FILES } from "./install.mjs";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const REPO_ROOT = path.resolve(__dirname, "..");

function toPosixRel(rootDir, absPath) {
  return path.relative(rootDir, absPath).replace(/\\/g, "/");
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "yield",
  "await",
  "in",
  "instanceof",
  "new",
  "else",
  "do",
  "export",
  "default",
  "debugger",
  "break",
  "continue",
  "extends"
]);

const CONTROL_FLOW_PAREN_KEYWORDS = new Set(["if", "while", "for", "with"]);

const RESTRICTED_ASI_KEYWORDS = new Set(["return", "yield"]);

const FOR_OF_INVALID_PREV_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "typeof",
  "void",
  "delete",
  "await",
  "new",
  "in",
  "instanceof",
  "return",
  "throw",
  "yield",
  "case"
]);

const EXPR_BRACE_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "yield",
  "await",
  "in",
  "instanceof",
  "new",
  "extends",
  "default"
]);

const EXPR_DECL_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "yield",
  "await",
  "in",
  "instanceof",
  "new",
  "extends"
]);

const EXPR_BRACE_PRECEDING_PUNCTS = new Set([
  "=",
  "(",
  "[",
  ",",
  "?",
  "!",
  "~",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "<",
  ">",
  "${",
  "..."
]);

const ID_START_RE = /[\p{ID_Start}$_]/u;
const ID_CONT_RE = /[\p{ID_Continue}$]/u;

function isForOfKeyword(tok) {
  return Boolean(tok && tok.isForOf);
}

function canStartRegexLiteral(prevToken) {
  if (!prevToken) return true;
  if (prevToken.type === "string") {
    return Boolean(prevToken.isImportExportString);
  }
  if (prevToken.type === "punct") {
    if (prevToken.value === ")") return Boolean(prevToken.controlFlowClose);
    if (prevToken.value === "}") return !prevToken.isExprClose;
    return prevToken.value !== "]" && prevToken.value !== "++" && prevToken.value !== "--";
  }
  if (prevToken.type === "ident") {
    return (
      (!prevToken.isMemberProp && REGEX_PRECEDING_KEYWORDS.has(prevToken.value)) ||
      Boolean(prevToken.isForOf) ||
      Boolean(prevToken.isJumpLabel)
    );
  }
  return false;
}

function decodeJsStringEscape(source, backslashIdx, n) {
  if (backslashIdx + 1 >= n) return { text: "", end: n };
  const esc = source[backslashIdx + 1];
  if (esc === "\r") {
    return { text: "", end: source[backslashIdx + 2] === "\n" ? backslashIdx + 3 : backslashIdx + 2 };
  }
  if (esc === "\n" || esc === "\u2028" || esc === "\u2029") {
    return { text: "", end: backslashIdx + 2 };
  }
  if (esc === "n") return { text: "\n", end: backslashIdx + 2 };
  if (esc === "r") return { text: "\r", end: backslashIdx + 2 };
  if (esc === "t") return { text: "\t", end: backslashIdx + 2 };
  if (esc === "b") return { text: "\b", end: backslashIdx + 2 };
  if (esc === "f") return { text: "\f", end: backslashIdx + 2 };
  if (esc === "v") return { text: "\v", end: backslashIdx + 2 };
  if (esc === "0" && !(source[backslashIdx + 2] >= "0" && source[backslashIdx + 2] <= "9")) {
    return { text: "\0", end: backslashIdx + 2 };
  }
  if (esc === "x" && backslashIdx + 3 < n) {
    const hex = source.slice(backslashIdx + 2, backslashIdx + 4);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      return { text: String.fromCharCode(parseInt(hex, 16)), end: backslashIdx + 4 };
    }
  }
  if (esc === "u") {
    if (source[backslashIdx + 2] === "{") {
      let j = backslashIdx + 3;
      while (j < n) {
        const c = source.charCodeAt(j);
        const isHex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        if (!isHex) break;
        j++;
      }
      if (j > backslashIdx + 3 && j < n && source[j] === "}") {
        const rawHex = source.slice(backslashIdx + 3, j);
        const strippedHex = rawHex.replace(/^0+/, "") || "0";
        if (strippedHex.length <= 6) {
          const cp = parseInt(strippedHex, 16);
          if (cp <= 0x10ffff) {
            return { text: String.fromCodePoint(cp), end: j + 1 };
          }
        }
      }
    } else if (backslashIdx + 5 < n) {
      const hex = source.slice(backslashIdx + 2, backslashIdx + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { text: String.fromCharCode(parseInt(hex, 16)), end: backslashIdx + 6 };
      }
    }
  }
  return { text: esc, end: backslashIdx + 2 };
}

/**
 * Lightweight, linear-time JS lexer that strips comments, preserves strings/template
 * expressions without leaking comment markers inside strings or fake imports inside
 * string/template literals, and produces a flat token stream for specifier extraction.
 */
export function tokenizeJsForSpecifiers(source, options = {}) {
  const tokens = [];
  const n = source.length;
  const useRegexMemo = options?.disableRegexMemo !== true;
  let i = 0;

  // Skip leading shebang line (supports LF, CRLF, and CR-only line endings)
  if (source.startsWith("#!")) {
    while (i < n && source[i] !== "\n" && source[i] !== "\r") i++;
  }

  // Unified nesting scope stack tracking template interpolations, parens, brackets,
  // object-literal / expression-body vs statement-block braces, per-scope ternary `?` depth,
  // and nested class/function declaration-vs-expression body stacks.
  const scopeStack = [{ kind: "root", ternaryDepth: 0, pendingDeclBodies: [] }];
  const topScope = () => scopeStack[scopeStack.length - 1];
  let hadLineTerminator = false;
  let lastAsyncLtBefore = false;
  // O(N) per-line visited bitmask for failed regex literal scans (bit 1 = !inClass, bit 2 = inClass)
  let failedLineMask = null;
  let failedLineBase = -1;
  let failedLineEnd = -1;
  const pushToken = (tok) => {
    tokens.push(tok);
    hadLineTerminator = false;
  };

  const scanTemplateChunk = (startIdx) => {
    let p = startIdx;
    let raw = "";
    while (p < n) {
      const c = source[p];
      if (c === "\\") {
        const dec = decodeJsStringEscape(source, p, n);
        raw += dec.text;
        p = dec.end;
        continue;
      }
      if (c === "`") {
        return { end: p + 1, interpolated: false, raw };
      }
      if (c === "$" && source[p + 1] === "{") {
        return { end: p + 2, interpolated: true, raw };
      }
      raw += c;
      p++;
    }
    return { end: n, interpolated: false, raw };
  };

  while (i < n) {
    const ch = source[i];
    const chCode = ch.charCodeAt(0);

    // Whitespace (ASCII + NBSP/BOM/Unicode line & space separators)
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\r" ||
      ch === "\n" ||
      ch === "\f" ||
      ch === "\v" ||
      ch === "\u00a0" ||
      ch === "\ufeff" ||
      ch === "\u2028" ||
      ch === "\u2029" ||
      (chCode >= 0x80 && /\s/.test(ch))
    ) {
      if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") {
        hadLineTerminator = true;
      }
      i++;
      continue;
    }

    // Line comment
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < n && source[i] !== "\n" && source[i] !== "\r" && source[i] !== "\u2028" && source[i] !== "\u2029") {
        i++;
      }
      continue;
    }

    // Block comment
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        const cc = source[i];
        if (cc === "\n" || cc === "\r" || cc === "\u2028" || cc === "\u2029") {
          hadLineTerminator = true;
        }
        i++;
      }
      i = i < n ? i + 2 : n;
      continue;
    }

    // Regex literal vs division operator (strictly O(N) via lazily allocated per-line Uint8Array visited bitmask)
    if (ch === "/") {
      if (useRegexMemo && failedLineMask !== null && i >= failedLineEnd) {
        failedLineMask = null;
        failedLineBase = -1;
        failedLineEnd = -1;
      }
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      if (canStartRegexLiteral(prev)) {
        let p = i + 1;
        let inClass = false;
        let closed = false;
        while (p < n) {
          const rc = source[p];
          if (rc === "\n" || rc === "\r" || rc === "\u2028" || rc === "\u2029") break;
          if (useRegexMemo && failedLineMask !== null && p >= failedLineBase && p < failedLineEnd) {
            const bit = inClass ? 2 : 1;
            const idx = p - failedLineBase;
            if ((failedLineMask[idx] & bit) !== 0) break;
            failedLineMask[idx] |= bit;
          }
          if (rc === "\\") {
            if (
              p + 1 < n &&
              (source[p + 1] === "\n" || source[p + 1] === "\r" || source[p + 1] === "\u2028" || source[p + 1] === "\u2029")
            ) {
              break;
            }
            p += 2;
            continue;
          }
          if (rc === "[") {
            inClass = true;
            p++;
            continue;
          }
          if (rc === "]") {
            inClass = false;
            p++;
            continue;
          }
          if (rc === "/" && !inClass) {
            closed = true;
            p++;
            while (p < n && /[a-zA-Z]/.test(source[p])) p++;
            break;
          }
          p++;
        }
        if (closed) {
          pushToken({ type: "other", value: "regex" });
          i = p;
          continue;
        }
        if (useRegexMemo && failedLineMask === null) {
          const lineEnd =
            p < n &&
            source[p] === "\\" &&
            p + 1 < n &&
            (source[p + 1] === "\n" || source[p + 1] === "\r" || source[p + 1] === "\u2028" || source[p + 1] === "\u2029")
              ? p + 1
              : Math.min(p, n);
          const base = i + 1;
          if (lineEnd > base) {
            const mask = new Uint8Array(lineEnd - base);
            let rp = base;
            let rInClass = false;
            while (rp < lineEnd) {
              mask[rp - base] |= rInClass ? 2 : 1;
              const rrc = source[rp];
              if (rrc === "\\") {
                if (rp + 1 >= lineEnd) break;
                rp += 2;
                continue;
              }
              if (rrc === "[") {
                rInClass = true;
              } else if (rrc === "]") {
                rInClass = false;
              }
              rp++;
            }
            failedLineMask = mask;
            failedLineBase = base;
            failedLineEnd = lineEnd;
          }
        }
      }
      pushToken({ type: "punct", value: "/" });
      i++;
      continue;
    }

    // Single or double quoted string literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const isImportExportString = Boolean(
        prev && prev.type === "ident" && !prev.isMemberProp && (prev.value === "import" || prev.value === "from")
      );
      let p = i + 1;
      let val = "";
      while (p < n) {
        const sc = source[p];
        if (sc === "\\") {
          const dec = decodeJsStringEscape(source, p, n);
          val += dec.text;
          p = dec.end;
          continue;
        }
        if (sc === quote) {
          p++;
          break;
        }
        if (sc === "\n" || sc === "\r") break;
        val += sc;
        p++;
      }
      pushToken(isImportExportString ? { type: "string", value: val, isImportExportString: true } : { type: "string", value: val });
      i = p;
      continue;
    }

    // Template literal
    if (ch === "`") {
      const chunk = scanTemplateChunk(i + 1);
      if (chunk.interpolated) {
        pushToken({ type: "punct", value: "${" });
        scopeStack.push({ kind: "template", ternaryDepth: 0, pendingDeclBodies: [] });
      } else {
        pushToken({ type: "template_static", value: chunk.raw });
      }
      i = chunk.end;
      continue;
    }

    // Identifier / keyword (supports ASCII fast-path and non-BMP astral Unicode identifiers)
    const isAsciiIdStart =
      (chCode >= 65 && chCode <= 90) || (chCode >= 97 && chCode <= 122) || chCode === 36 || chCode === 95;
    let idFirstLen = 0;
    if (isAsciiIdStart) {
      idFirstLen = 1;
    } else if (chCode >= 0x80) {
      const cp = source.codePointAt(i);
      const cpStr = String.fromCodePoint(cp);
      if (ID_START_RE.test(cpStr)) {
        idFirstLen = cpStr.length;
      }
    }
    if (idFirstLen > 0) {
      let p = i + idFirstLen;
      while (p < n) {
        const c = source.charCodeAt(p);
        if (
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 36 ||
          c === 95
        ) {
          p++;
          continue;
        }
        if (c < 0x80) break;
        const ccp = source.codePointAt(p);
        const cStr = String.fromCodePoint(ccp);
        if (!ID_CONT_RE.test(cStr)) break;
        p += cStr.length;
      }
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const prevLt = hadLineTerminator;
      const isMemberProp = Boolean(prev && prev.type === "punct" && (prev.value === "." || prev.value === "#"));
      const value = source.slice(i, p);
      const curScope = topScope();
      const isJumpLabel = Boolean(
        !isMemberProp &&
          !prevLt &&
          prev?.type === "ident" &&
          !prev.isMemberProp &&
          (prev.value === "break" || prev.value === "continue")
      );
      let isForOf = false;
      if (!isMemberProp && value === "of" && curScope.kind === "paren" && curScope.isForHeader && prev) {
        if (
          (prev.type === "punct" && (prev.value === "]" || prev.value === "}" || prev.value === ")")) ||
          (prev.type === "ident" && (prev.isMemberProp || !FOR_OF_INVALID_PREV_KEYWORDS.has(prev.value)))
        ) {
          isForOf = true;
          curScope.isForHeader = false;
        }
      }
      if (!isMemberProp && value === "async") {
        lastAsyncLtBefore = prevLt;
      }
      if (!isMemberProp && (value === "function" || value === "class")) {
        const isAsyncFn =
          value === "function" &&
          !prevLt &&
          prev?.type === "ident" &&
          !prev.isMemberProp &&
          prev.value === "async";
        const beforeKw = isAsyncFn ? (tokens.length > 1 ? tokens[tokens.length - 2] : null) : prev;
        const beforeLt = isAsyncFn ? lastAsyncLtBefore : prevLt;
        const isExprDecl = Boolean(
          beforeKw &&
            ((beforeKw.type === "punct" &&
              (EXPR_BRACE_PRECEDING_PUNCTS.has(beforeKw.value) ||
                (beforeKw.value === ":" && (beforeKw.isTernaryColon || curScope.kind === "obj")))) ||
              (beforeKw.type === "ident" &&
                !beforeKw.isMemberProp &&
                ((EXPR_DECL_PRECEDING_KEYWORDS.has(beforeKw.value) &&
                  !(RESTRICTED_ASI_KEYWORDS.has(beforeKw.value) && beforeLt)) ||
                  isForOfKeyword(beforeKw))))
        );
        curScope.pendingDeclBodies.push(isExprDecl);
      }
      const depth = scopeStack.length - 1;
      const tok = { type: "ident", value, depth };
      if (isMemberProp) tok.isMemberProp = true;
      if (isForOf) tok.isForOf = true;
      if (isJumpLabel) tok.isJumpLabel = true;
      pushToken(tok);
      i = p;
      continue;
    }

    // Number literal
    if (ch >= "0" && ch <= "9") {
      let p = i + 1;
      while (p < n && /[0-9a-zA-Z_.]/.test(source[p])) p++;
      pushToken({ type: "other", value: source.slice(i, p) });
      i = p;
      continue;
    }

    // Spread/rest operator `...` (expression context before `{}` in `{ ...{ a: 1 } / 2 }`)
    if (ch === "." && source[i + 1] === "." && source[i + 2] === ".") {
      pushToken({ type: "punct", value: "..." });
      i += 3;
      continue;
    }

    // Increment/decrement operators (keep `/` after `a++` or `a--` as division, not regex)
    if ((ch === "+" && source[i + 1] === "+") || (ch === "-" && source[i + 1] === "-")) {
      pushToken({ type: "punct", value: ch + ch });
      i += 2;
      continue;
    }

    // Track control-flow header parentheses (`if (...)`, `while (...)`, `for [await] (...)`, `with (...)`)
    if (ch === "(") {
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const prev2 = tokens.length > 1 ? tokens[tokens.length - 2] : null;
      const isControlKw =
        prev?.type === "ident" &&
        !prev.isMemberProp &&
        CONTROL_FLOW_PAREN_KEYWORDS.has(prev.value);
      const isForKw = prev?.type === "ident" && !prev.isMemberProp && prev.value === "for";
      const isForAwait =
        prev?.type === "ident" &&
        !prev.isMemberProp &&
        prev.value === "await" &&
        prev2?.type === "ident" &&
        !prev2.isMemberProp &&
        prev2.value === "for";
      scopeStack.push({
        kind: "paren",
        ternaryDepth: 0,
        pendingDeclBodies: [],
        controlFlow: Boolean(isControlKw || isForAwait),
        isForHeader: Boolean(isForKw || isForAwait)
      });
      pushToken({ type: "punct", value: "(" });
      i++;
      continue;
    }

    if (ch === ")") {
      const controlFlowClose =
        scopeStack.length > 1 && topScope().kind === "paren" ? scopeStack.pop().controlFlow : false;
      pushToken(controlFlowClose ? { type: "punct", value: ")", controlFlowClose: true } : { type: "punct", value: ")" });
      i++;
      continue;
    }

    if (ch === "[") {
      scopeStack.push({ kind: "bracket", ternaryDepth: 0, pendingDeclBodies: [] });
      pushToken({ type: "punct", value: "[" });
      i++;
      continue;
    }

    if (ch === "]") {
      if (scopeStack.length > 1 && topScope().kind === "bracket") {
        scopeStack.pop();
      }
      pushToken({ type: "punct", value: "]" });
      i++;
      continue;
    }

    // Track object-literal / function-expr / class-expr `{ ... }` vs statement block `{ ... }`
    // so `const y = { a: 1 } / 2` and `const f = function() {} / 2` lex `/` as division,
    // while `return\n{ foo(); } /[/*]/` respects ASI and lexes `/` as a regex literal.
    if (ch === "{") {
      const curScope = topScope();
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const prev2 = tokens.length > 1 ? tokens[tokens.length - 2] : null;
      const prevLt = hadLineTerminator;
      const isArrowBody =
        prev?.type === "punct" && prev.value === ">" && prev2?.type === "punct" && prev2.value === "=";
      const isExprColon = Boolean(
        prev?.type === "punct" &&
          prev.value === ":" &&
          (prev.isTernaryColon || curScope.kind === "obj")
      );
      const isRestrictedAsiKw = Boolean(
        prev?.type === "ident" && !prev.isMemberProp && RESTRICTED_ASI_KEYWORDS.has(prev.value) && prevLt
      );
      const isExprBrace = Boolean(
        !isArrowBody &&
          !isRestrictedAsiKw &&
          prev &&
          (isExprColon ||
            (prev.type === "punct" && EXPR_BRACE_PRECEDING_PUNCTS.has(prev.value)) ||
            (prev.type === "ident" && !prev.isMemberProp && EXPR_BRACE_PRECEDING_KEYWORDS.has(prev.value)) ||
            isForOfKeyword(prev))
      );
      const isPendingExprBody =
        !isExprBrace && !isArrowBody && curScope.pendingDeclBodies.length > 0
          ? Boolean(curScope.pendingDeclBodies.pop())
          : false;
      scopeStack.push({
        kind: isExprBrace ? "obj" : "block",
        exprClose: isExprBrace || isPendingExprBody,
        ternaryDepth: 0,
        pendingDeclBodies: []
      });
      pushToken({ type: "punct", value: "{" });
      i++;
      continue;
    }

    if (ch === "}") {
      const cur = topScope();
      if (cur.kind === "template") {
        scopeStack.pop();
        const chunk = scanTemplateChunk(i + 1);
        if (chunk.interpolated) {
          scopeStack.push({ kind: "template", ternaryDepth: 0, pendingDeclBodies: [] });
          pushToken({ type: "punct", value: "${" });
        } else {
          pushToken({ type: "other", value: "template_end" });
        }
        i = chunk.end;
        continue;
      }
      let isExprClose = false;
      if (cur.kind === "obj" || cur.kind === "block") {
        scopeStack.pop();
        isExprClose = Boolean(cur.exprClose);
      }
      pushToken(isExprClose ? { type: "punct", value: "}", isExprClose: true } : { type: "punct", value: "}" });
      i++;
      continue;
    }

    if (ch === "?") {
      const next = source[i + 1];
      const next2 = source[i + 2];
      const isOptionalChain = next === "." && !(next2 >= "0" && next2 <= "9");
      const isNullish = next === "?" || source[i - 1] === "?";
      if (!isOptionalChain && !isNullish) {
        topScope().ternaryDepth += 1;
      }
      pushToken({ type: "punct", value: "?" });
      i++;
      continue;
    }

    if (ch === ":") {
      const cur = topScope();
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const isTernaryColon = cur.ternaryDepth > 0;
      if (isTernaryColon) {
        cur.ternaryDepth -= 1;
      } else if (
        prev?.type === "ident" &&
        !prev.isMemberProp &&
        (prev.value === "function" || prev.value === "class") &&
        cur.pendingDeclBodies.length > 0
      ) {
        // `{ class: 1 }` or `{ function: 1 }` property label is not a declaration body
        cur.pendingDeclBodies.pop();
      }
      pushToken(isTernaryColon ? { type: "punct", value: ":", isTernaryColon: true } : { type: "punct", value: ":" });
      i++;
      continue;
    }

    if (ch === ";") {
      const cur = topScope();
      cur.ternaryDepth = 0;
      cur.pendingDeclBodies.length = 0;
      if (cur.isForHeader) cur.isForHeader = false;
      pushToken({ type: "punct", value: ";" });
      i++;
      continue;
    }

    // Punctuation
    pushToken({ type: "punct", value: ch });
    i++;
  }

  return tokens;
}

/**
 * Extract relative JS/MJS module specifiers and sibling script references from source text.
 */
export function extractLocalSpecifiers(source, fileAbsPath, rootDir = REPO_ROOT) {
  const tokens = tokenizeJsForSpecifiers(source);
  const found = new Set();
  const dir = path.dirname(fileAbsPath);

  const isStringLike = (tok) => Boolean(tok && (tok.type === "string" || tok.type === "template_static"));
  const isIdent = (tok, val) => Boolean(tok && tok.type === "ident" && (val === undefined || tok.value === val));
  const isPunct = (tok, val) => Boolean(tok && tok.type === "punct" && tok.value === val);

  const addRel = (spec, allowExtFallback = false) => {
    if (!spec || typeof spec !== "string") return;
    const cleanSpec = spec.replace(/[?#].*$/, "");
    if (!cleanSpec.startsWith("./") && !cleanSpec.startsWith("../")) return;
    const baseCandidate = path.resolve(dir, cleanSpec);
    if (fs.existsSync(baseCandidate) && fs.statSync(baseCandidate).isFile()) {
      found.add(toPosixRel(rootDir, baseCandidate));
      return;
    }
    if (allowExtFallback) {
      for (const ext of [".js", ".mjs", ".cjs", ".json"]) {
        const withExt = baseCandidate + ext;
        if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
          found.add(toPosixRel(rootDir, withExt));
          return;
        }
      }
    }
  };

  // Precompute `{` -> `}` matching indices in O(T) so malformed unclosed `{` never degrades to O(T^2)
  const braceMatch = new Int32Array(tokens.length).fill(-1);
  const braceStack = [];
  for (let k = 0; k < tokens.length; k++) {
    if (isPunct(tokens[k], "{")) {
      braceStack.push(k);
    } else if (isPunct(tokens[k], "}")) {
      if (braceStack.length > 0) {
        braceMatch[braceStack.pop()] = k;
      }
    }
  }
  const findMatchingBrace = (openIdx) => (openIdx >= 0 && openIdx < braceMatch.length ? braceMatch[openIdx] : -1);

  // Extract a string-like first call argument, unwrapping optional grouping parens e.g. `import(("./x.js"))`
  const extractFirstStringCallArg = (openParenIdx, allowTrailingComma = true) => {
    let k = openParenIdx + 1;
    let groupDepth = 0;
    while (k < tokens.length && isPunct(tokens[k], "(")) {
      groupDepth++;
      k++;
    }
    const arg = tokens[k];
    if (!isStringLike(arg)) return null;
    k++;
    while (groupDepth > 0) {
      if (!isPunct(tokens[k], ")")) return null;
      groupDepth--;
      k++;
    }
    const sep = tokens[k];
    if (isPunct(sep, ")") || (allowTrailingComma && isPunct(sep, ","))) {
      return { value: arg.value, endIdx: k };
    }
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const afterMember = isPunct(prev, ".") || isPunct(prev, "#");

    // 1. Static & dynamic `import` statements/expressions + `import.meta.resolve(...)`
    if (!afterMember && isIdent(tok, "import")) {
      const t1 = tokens[i + 1];
      if (!t1) continue;

      // import.meta.resolve("./x.js")
      if (
        isPunct(t1, ".") &&
        isIdent(tokens[i + 2], "meta") &&
        isPunct(tokens[i + 3], ".") &&
        isIdent(tokens[i + 4], "resolve") &&
        isPunct(tokens[i + 5], "(")
      ) {
        const resArg = extractFirstStringCallArg(i + 5, true);
        if (resArg) {
          addRel(resArg.value);
          i = resArg.endIdx;
        }
        continue;
      }

      // Side-effect import: import "./x.js"
      if (t1.type === "string") {
        addRel(t1.value);
        i += 1;
        continue;
      }

      // Dynamic import: import("./x.js"), import(("./x.js")), or import("./data.json", { with: { type: "json" } })
      if (isPunct(t1, "(")) {
        const dynArg = extractFirstStringCallArg(i + 1, true);
        if (dynArg) {
          addRel(dynArg.value);
        }
        continue;
      }

      // import * as ns from "./x.js"
      if (isPunct(t1, "*") && isIdent(tokens[i + 2], "as") && isIdent(tokens[i + 3]) && isIdent(tokens[i + 4], "from") && tokens[i + 5]?.type === "string") {
        addRel(tokens[i + 5].value);
        i += 5;
        continue;
      }

      // import { ... } from "./x.js"
      if (isPunct(t1, "{")) {
        const closeIdx = findMatchingBrace(i + 1);
        if (closeIdx !== -1 && isIdent(tokens[closeIdx + 1], "from") && tokens[closeIdx + 2]?.type === "string") {
          addRel(tokens[closeIdx + 2].value);
          i = closeIdx + 2;
        }
        continue;
      }

      // import def from "./x.js" | import def, * as ns from "./x.js" | import def, { ... } from "./x.js"
      if (isIdent(t1)) {
        const t2 = tokens[i + 2];
        if (isIdent(t2, "from") && tokens[i + 3]?.type === "string") {
          addRel(tokens[i + 3].value);
          i += 3;
          continue;
        }
        if (isPunct(t2, ",")) {
          const t3 = tokens[i + 3];
          if (isPunct(t3, "*") && isIdent(tokens[i + 4], "as") && isIdent(tokens[i + 5]) && isIdent(tokens[i + 6], "from") && tokens[i + 7]?.type === "string") {
            addRel(tokens[i + 7].value);
            i += 7;
            continue;
          }
          if (isPunct(t3, "{")) {
            const closeIdx = findMatchingBrace(i + 3);
            if (closeIdx !== -1 && isIdent(tokens[closeIdx + 1], "from") && tokens[closeIdx + 2]?.type === "string") {
              addRel(tokens[closeIdx + 2].value);
              i = closeIdx + 2;
              continue;
            }
          }
        }
      }
      continue;
    }

    // 2. Static `export ... from "./x.js"` re-exports (never bleeds from `export { local }` or `export const`)
    if (!afterMember && isIdent(tok, "export")) {
      const t1 = tokens[i + 1];
      if (!t1) continue;

      if (isPunct(t1, "*")) {
        if (isIdent(tokens[i + 2], "from") && tokens[i + 3]?.type === "string") {
          addRel(tokens[i + 3].value);
          i += 3;
          continue;
        }
        if (
          isIdent(tokens[i + 2], "as") &&
          (isIdent(tokens[i + 3]) || tokens[i + 3]?.type === "string") &&
          isIdent(tokens[i + 4], "from") &&
          tokens[i + 5]?.type === "string"
        ) {
          addRel(tokens[i + 5].value);
          i += 5;
          continue;
        }
      } else if (isPunct(t1, "{")) {
        const closeIdx = findMatchingBrace(i + 1);
        if (closeIdx !== -1) {
          if (isIdent(tokens[closeIdx + 1], "from") && tokens[closeIdx + 2]?.type === "string") {
            addRel(tokens[closeIdx + 2].value);
            i = closeIdx + 2;
          } else {
            i = closeIdx;
          }
        }
      }
      continue;
    }

    // 3. CommonJS require("./...") (supports extensionless fallback and grouped string arg)
    if (!afterMember && isIdent(tok, "require") && isPunct(tokens[i + 1], "(")) {
      const reqArg = extractFirstStringCallArg(i + 1, false);
      if (reqArg) {
        addRel(reqArg.value, true);
        i = reqArg.endIdx;
      }
      continue;
    }

    // 4. Relative URL asset/module resolution via new URL("./...", import.meta.url)
    if (
      !afterMember &&
      isIdent(tok, "new") &&
      isIdent(tokens[i + 1], "URL") &&
      isPunct(tokens[i + 2], "(") &&
      isStringLike(tokens[i + 3]) &&
      isPunct(tokens[i + 4], ",") &&
      isIdent(tokens[i + 5], "import") &&
      isPunct(tokens[i + 6], ".") &&
      isIdent(tokens[i + 7], "meta") &&
      isPunct(tokens[i + 8], ".") &&
      isIdent(tokens[i + 9], "url")
    ) {
      addRel(tokens[i + 3].value);
      i += 9;
      continue;
    }

    // 5. Direct sibling/child helper script spawns via path.resolve/join(__dirname | import.meta.dirname, ...)
    if (
      !afterMember &&
      isIdent(tok, "path") &&
      isPunct(tokens[i + 1], ".") &&
      (isIdent(tokens[i + 2], "resolve") || isIdent(tokens[i + 2], "join")) &&
      isPunct(tokens[i + 3], "(")
    ) {
      let argsStart = -1;
      if (isIdent(tokens[i + 4], "__dirname") && isPunct(tokens[i + 5], ",")) {
        argsStart = i + 6;
      } else if (
        isIdent(tokens[i + 4], "import") &&
        isPunct(tokens[i + 5], ".") &&
        isIdent(tokens[i + 6], "meta") &&
        isPunct(tokens[i + 7], ".") &&
        isIdent(tokens[i + 8], "dirname") &&
        isPunct(tokens[i + 9], ",")
      ) {
        argsStart = i + 10;
      }
      if (argsStart !== -1) {
        const parts = [];
        let k = argsStart;
        let valid = true;
        while (k < tokens.length && !isPunct(tokens[k], ")")) {
          if (isStringLike(tokens[k])) {
            parts.push(tokens[k].value);
            k++;
            if (isPunct(tokens[k], ",")) k++;
          } else {
            valid = false;
            break;
          }
        }
        if (valid && parts.length > 0 && isPunct(tokens[k], ")")) {
          const last = parts[parts.length - 1];
          if (/\.(?:m?js|cjs|html|json|svg|md)$/i.test(last)) {
            const candidate = path.resolve(dir, ...parts);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              found.add(toPosixRel(rootDir, candidate));
            }
          }
          i = k;
        }
      }
    }
  }

  return Array.from(found).sort();
}

export function discoverRuntimeEntrypoints(rootDir = REPO_ROOT) {
  const entries = new Set(["scripts/install.mjs"]);

  // 1. hooks.json
  const hooksJson = JSON.parse(fs.readFileSync(path.join(rootDir, "hooks.json"), "utf8"));
  const collectHookCommands = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectHookCommands(item);
      return;
    }
    if (typeof node.command === "string") {
      const m = node.command.match(
        /\bnode(?:\.exe)?(?:\s+--?[A-Za-z0-9_=-]+)*\s+(?:"([^"]+\.(?:m?js|cjs))"|'([^']+\.(?:m?js|cjs))'|([^\s"']+\.(?:m?js|cjs)))/i
      );
      const rawScript = m ? (m[1] || m[2] || m[3]) : null;
      if (rawScript) {
        const cleaned = rawScript
          .replace(/^\$\{PLUGIN_ROOT\}[\\/]/, "")
          .replace(/^\.[\\/]/, "")
          .replace(/\\/g, "/");
        entries.add(cleaned);
      }
    }
    for (const v of Object.values(node)) collectHookCommands(v);
  };
  collectHookCommands(hooksJson);

  // 2. mcp_config.json
  const mcpJson = JSON.parse(fs.readFileSync(path.join(rootDir, "mcp_config.json"), "utf8"));
  for (const srv of Object.values(mcpJson.mcpServers || {})) {
    for (const arg of srv.args || []) {
      const cleaned = String(arg).replace(/^\$\{PLUGIN_ROOT\}[\\/]/, "").replace(/\\/g, "/");
      if (/\.(?:m?js|cjs)$/i.test(cleaned)) entries.add(cleaned);
    }
  }

  // 3. sidecars/dashboard/sidecar.json
  const sidecarDir = path.join(rootDir, "sidecars", "dashboard");
  const sidecarJson = JSON.parse(fs.readFileSync(path.join(sidecarDir, "sidecar.json"), "utf8"));
  for (const arg of sidecarJson.args || []) {
    if (/\.(?:m?js|cjs)$/i.test(String(arg))) {
      entries.add(toPosixRel(rootDir, path.resolve(sidecarDir, String(arg))));
    }
  }

  return Array.from(entries).sort();
}

export function collectImportGraph(entrypoints, rootDir = REPO_ROOT) {
  const visited = new Set();
  const edges = new Map();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const rel = queue.shift().replace(/\\/g, "/");
    if (visited.has(rel)) continue;
    visited.add(rel);
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      edges.set(rel, []);
      continue;
    }
    if (!/\.(?:m?js|cjs)$/i.test(rel)) {
      edges.set(rel, []);
      continue;
    }
    const src = fs.readFileSync(abs, "utf8");
    const deps = extractLocalSpecifiers(src, abs, rootDir);
    edges.set(rel, deps);
    for (const d of deps) {
      if (!visited.has(d)) queue.push(d);
    }
  }

  return {
    reachable: Array.from(visited).sort(),
    edges: Object.fromEntries(Array.from(edges.entries()).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export function verifyPackageManifest(rootDir = REPO_ROOT) {
  const runtimeSet = new Set(RUNTIME_FILES);
  const devtoolsSet = new Set(DEVTOOLS_FILES);
  const allSet = new Set(FILES_TO_COPY);

  const missingOnDisk = FILES_TO_COPY.filter((rel) => !fs.existsSync(path.join(rootDir, rel)));
  const overlap = RUNTIME_FILES.filter((rel) => devtoolsSet.has(rel));

  const runtimeEntries = discoverRuntimeEntrypoints(rootDir);
  const runtimeGraph = collectImportGraph(runtimeEntries, rootDir);
  const missingFromRuntimeManifest = runtimeGraph.reachable.filter((rel) => !runtimeSet.has(rel));
  const devtoolsLeakedIntoRuntime = runtimeGraph.reachable.filter((rel) => devtoolsSet.has(rel));

  const devtoolsGraph = collectImportGraph(DEVTOOLS_FILES, rootDir);
  const missingFromFullManifest = devtoolsGraph.reachable.filter((rel) => !allSet.has(rel));

  const ok =
    missingOnDisk.length === 0 &&
    overlap.length === 0 &&
    missingFromRuntimeManifest.length === 0 &&
    devtoolsLeakedIntoRuntime.length === 0 &&
    missingFromFullManifest.length === 0;

  return {
    ok,
    runtimeEntrypoints: runtimeEntries,
    runtimeReachableCount: runtimeGraph.reachable.length,
    runtimeManifestCount: RUNTIME_FILES.length,
    devtoolsManifestCount: DEVTOOLS_FILES.length,
    missingOnDisk,
    overlap,
    missingFromRuntimeManifest,
    devtoolsLeakedIntoRuntime,
    missingFromFullManifest,
    runtimeGraph: runtimeGraph.edges
  };
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

if (isDirectRun) {
  const asJson = process.argv.includes("--json");
  const report = verifyPackageManifest(REPO_ROOT);
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(`Package import-graph verification: ${report.ok ? "PASS" : "FAIL"}`);
    console.log(`  - Runtime entrypoints : ${report.runtimeEntrypoints.length} (${report.runtimeEntrypoints.join(", ")})`);
    console.log(`  - Reachable modules   : ${report.runtimeReachableCount} (manifest runtime=${report.runtimeManifestCount}, devtools=${report.devtoolsManifestCount})`);
    if (report.missingOnDisk.length) console.error(`  - Missing on disk     : ${report.missingOnDisk.join(", ")}`);
    if (report.overlap.length) console.error(`  - Manifest overlap    : ${report.overlap.join(", ")}`);
    if (report.missingFromRuntimeManifest.length) console.error(`  - Missing from RUNTIME_FILES: ${report.missingFromRuntimeManifest.join(", ")}`);
    if (report.devtoolsLeakedIntoRuntime.length) console.error(`  - Devtools leaked into runtime: ${report.devtoolsLeakedIntoRuntime.join(", ")}`);
    if (report.missingFromFullManifest.length) console.error(`  - Missing from full manifest: ${report.missingFromFullManifest.join(", ")}`);
  }
  if (!report.ok) process.exit(1);
}
