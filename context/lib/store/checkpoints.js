import path from "node:path";
import { redactSecrets } from "../security.js";
import {
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES
} from "./schema.js";

const MAX_FAILURE_EXCERPT_LINES = 5;
const MAX_FAILURE_EXCERPT_BYTES = 500;
const MAX_CHECKPOINT_UNRESOLVED = 5;
const WORKSPACE_CHECKPOINT_FAILURE_TTL_MS = 6 * 60 * 60 * 1000;
const CHECK_DURATION_SUFFIX_RE = /\s+\(\d+(?:\.\d+)?\s*(?:ms|s)\)$/i;

export function stripCheckDurationSuffix(name = "") {
  const collapsed = String(name || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.replace(CHECK_DURATION_SUFFIX_RE, "").trim();
}

const CHECK_BUILD_KIND_RE =
  /\b(?:build|bundle|compile|tsc|vue-tsc|svelte-check|typecheck|type-check|lint|eslint|oxlint|biome|ruff|flake8|mypy|pyright|basedpyright|pylint|stylelint|shellcheck|clippy|vet|webpack|rollup|tsup|esbuild|vite\s+build|electron-vite\s+build|next\s+build|nuxt\s+build|astro\s+build|cargo\s+(?:build|check|clippy)|go\s+(?:build|vet)|dotnet\s+build|gradle\s+build|mvn\s+(?:compile|package))\b/i;

const CHECK_TEST_RUNNER_RE =
  /\b(?:vitest|jest|pytest|mocha|ava|playwright|cypress|unittest|rspec|phpunit|ctest|node\s+--test|cargo\s+test|go\s+test|dotnet\s+test|bun\s+test|npm\s+(?:t|test|run\s+[a-z0-9_.:/-]*test[a-z0-9_.:/-]*)|pnpm\s+(?:run\s+)?[a-z0-9_.:/-]*test[a-z0-9_.:/-]*|yarn\s+(?:run\s+)?[a-z0-9_.:/-]*test[a-z0-9_.:/-]*)\b/i;

const CHECK_RUNNER_PREFIX_RE =
  /^(?:(?:npx(?:\.cmd)?(?:\s+(?:-y|--yes|--no-install|-p\s+\S+))*|npm(?:\.cmd)?\s+exec(?:\s+--)?|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:exec|dlx)(?:\s+--)?|bunx(?:\.cmd)?|(?:uv|poetry|pipenv|pdm|hatch)(?:\.exe)?\s+run|(?:python3?|py)(?:\.exe)?(?:\s+-[a-zA-Z0-9]+)*\s+-m|dotnet(?:\.exe)?\s+tool\s+run)\s+)+/i;

const CHECK_PURE_SETUP_RE =
  /^(?:(?:cd|chdir|pushd|set-location|push-location|sl)(?:\s|$)|export\s+[a-z_][a-z0-9_]*=|set\s+(?:"[a-z_][a-z0-9_]*=|[a-z_][a-z0-9_]*=)|\$env:[a-z0-9_]+\s*=|[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)(?:\s+[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*$)/i;

const CHECK_READ_ONLY_HEAD_RE =
  /^(?:git(?:\.exe)?\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|-c\s+(?:"[^"]*"|'[^']*'|\S+))\s+)*(?:diff|status|log|show|branch|rev-parse|ls-files|grep|blame|shortlog|describe|tag|reflog|ls-tree|cat-file|check-ignore|for-each-ref|remote(?!\s+(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b))|(?:cat|head|tail|less|more|ls|dir|echo|printf|pwd|which|where|type|rg|ripgrep|grep|egrep|fgrep|select-string|sls|findstr|get-content|get-childitem|get-location|get-item|gc|gci|gl|stat|wc|file|tree|find|write-output|write-host|format-table|select-object|measure-object|sort-object|test-path|resolve-path|true)(?:\.exe)?)(?:\s|$)/i;

const CHECK_PS_FAILFAST_ABORT_RE =
  /^if\s*\(\s*(?:\$lastexitcode\s+-ne\s+0|-not\s+\$\?)\s*\)\s*\{\s*(?:exit\s+(?:\$lastexitcode|[1-9]\d*)|throw\b[^}]*)\s*;?\s*\}$/i;

const CHECK_PS_IF_PREV_OK_RE =
  /^if\s*\(\s*(?:\$lastexitcode\s+-eq\s+0|\$\?)\s*\)\s*\{([\s\S]+)\}$/i;

const CHECK_FILTER_STAGE_RE =
  /^(?:grep|egrep|fgrep|rg|ripgrep|select-string|sls|findstr)(?:\.exe)?(?:\s|$)/i;

const CHECK_KEY_EMBEDDED_DURATION_RE = /\s+\(\d+(?:\.\d+)?\s*(?:ms|s)\)(?=\||,|$)/i;

const GENERIC_CHECK_NAMES = new Set([
  "test",
  "tests",
  "unit",
  "spec",
  "vitest",
  "jest",
  "pytest",
  "mocha",
  "ava",
  "playwright",
  "cypress",
  "build",
  "tsc",
  "typecheck",
  "type-check",
  "lint",
  "eslint",
  "biome",
  "check",
  "checks",
  "verify",
  "run_checks"
]);

const GENERIC_TEST_STEMS = new Set(["index", "main", "app", "test", "tests", "spec", "specs", "unit", "all"]);

const DEFAULT_FILTER_VALUE_FLAGS = new Set([
  "-t",
  "--testnamepattern",
  "--test-name-pattern",
  "--test-skip-pattern",
  "-k",
  "--grep",
  "-g",
  "--fgrep",
  "--filter",
  "-f",
  "-m",
  "--mark",
  "--tag",
  "--tags",
  "--group",
  "--suite",
  "--case",
  "--match",
  "--select",
  "--test-match",
  "--test-filter",
  "-run",
  "--run",
  "-skip",
  "--skip"
]);

const DEFAULT_SELECTOR_VALUE_FLAGS = new Set(["-p", "--project", "-w", "--workspace"]);

const DEFAULT_NARROWING_BOOL_FLAGS = new Set([
  "--only",
  "--only-failures",
  "--lf",
  "--last-failed",
  "--ff",
  "--failed-first",
  "--changed",
  "--onlychanged",
  "--only-changed",
  "--related",
  "--exact"
]);

const DEFAULT_IGNORED_VALUE_FLAGS = new Set([
  "--reporter",
  "-r",
  "--config",
  "-c",
  "--timeout",
  "--test-timeout",
  "--workers",
  "--maxworkers",
  "--max-workers",
  "--pool",
  "--tb",
  "--maxfail",
  "--dir",
  "--root",
  "--cwd",
  "--prefix",
  "--env",
  "--environment",
  "--output",
  "-o"
]);

export function classifyCheckKind(name = "", cmd = "") {
  const combined = `${name || ""} ${cmd || ""}`.trim();
  if (!combined) return "check";
  if (CHECK_TEST_RUNNER_RE.test(cmd || "")) return "test";
  if (
    CHECK_BUILD_KIND_RE.test(combined) &&
    !/\b(?:vitest|jest|pytest|mocha|ava|playwright|cypress|unittest|rspec|phpunit|node\s+--test|npm\s+(?:t|test))\b/i.test(
      combined
    )
  ) {
    return "build";
  }
  if (/\b(?:test|tests|spec|e2e|smoke|unit|integration|vitest|jest|pytest|mocha)\b/i.test(combined)) {
    return "test";
  }
  return "check";
}

export function formatCheckDisplayName(name = "", cmd = "") {
  const cleanName = stripCheckDurationSuffix(name);
  if (cleanName) return cleanName.slice(0, 80);
  const cleanCmd = String(cmd || "").replace(/\s+/g, " ").trim();
  if (cleanCmd) return cleanCmd.slice(0, 80);
  return "check";
}

function splitShellArgsSimple(text = "") {
  const out = [];
  let cur = "";
  let quote = "";
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else if (ch === "\\" && quote === '"' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        cur += s[++i];
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
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitSimpleOutsideQuotes(str, matchSep) {
  const parts = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
        cur += str[++i];
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const sepLen = matchSep(str, i);
    if (sepLen > 0) {
      parts.push(cur.trim());
      cur = "";
      i += sepLen - 1;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

function normalizeCheckStageHead(stage = "") {
  let s = String(stage || "").trim().replace(/^&\s+/, "");
  const stripPath = (str) => {
    const m = str.match(/^("([^"]+)"|'([^']+)'|([^\s"']+))(?:\s+(.*))?$/);
    if (!m) return str;
    const rawExec = m[2] ?? m[3] ?? m[4] ?? "";
    const rest = m[5] || "";
    if (!/(?:^|[\\/])scripts[\\/]/i.test(rawExec) && /[\\/]/.test(rawExec)) {
      const base = rawExec.replace(/^.*[\\/]/, "");
      return rest ? `${base} ${rest}` : base;
    }
    return str;
  };
  while (s) {
    s = stripPath(s);
    const envCmd = s.match(/^(?:env|cross-env)(?:\s+(?:-u\s+\S+|-i))*\s+(.*)$/i);
    if (envCmd) {
      s = envCmd[1].trim();
      continue;
    }
    const assign = s.match(/^[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+(.*)$/i);
    if (assign) {
      s = assign[1].trim();
      continue;
    }
    break;
  }
  return stripPath(s).replace(CHECK_RUNNER_PREFIX_RE, "").trim();
}

const CHECK_SHELL_WRAPPER_RE =
  /^(?:(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-(?:NoProfile|NonInteractive|NoLogo|nop|noni)|-ExecutionPolicy\s+\S+)\s+)*(?:-Command|-c)\s+|(?:bash|sh|zsh)(?:\.exe)?\s+(?:-[a-zA-Z]*c)\s+|cmd(?:\.exe)?\s+(?:\/[a-zA-Z]+\s+)*\/c\s+)(.+)$/i;

function unwrapSimpleShellWrapper(clause = "") {
  const s = String(clause || "").trim();
  const m = s.match(CHECK_SHELL_WRAPPER_RE);
  if (!m) return "";
  const payload = String(m[1] || "")
    .replace(/\s+2>&1\s*$/g, "")
    .replace(/\s+2>(?:\/dev\/null|\$null|nul)\s*$/gi, "")
    .trim();
  if (!payload) return "";
  if (payload.length >= 2 && (payload[0] === '"' || payload[0] === "'") && payload[payload.length - 1] === payload[0]) {
    const inner = payload.slice(1, -1);
    return payload[0] === "'" ? inner.trim() : inner.replace(/\\"/g, '"').replace(/`"/g, '"').trim();
  }
  return payload;
}

function checkClauseHasFilterStage(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitSimpleOutsideQuotes(trimmed, (s, i) =>
    s[i] === "|" && s[i + 1] !== "|" && s[i - 1] !== "|" ? 1 : 0
  );
  for (const rawStage of stages) {
    const cleaned = rawStage
      .replace(/\b2>&1\b/g, "")
      .replace(/\b2>(?:\/dev\/null|\$null|nul)\b/gi, "")
      .trim();
    const norm = normalizeCheckStageHead(cleaned);
    if (norm && CHECK_FILTER_STAGE_RE.test(norm)) return true;
  }
  return false;
}

function collectCommandCandidateStages(command = "", depth = 0, { skipFilterStages = false } = {}) {
  const cleanCmd = String(command || "").trim().replace(/^["'](.*)["']$/, "$1").trim();
  if (!cleanCmd) return { stages: [], hasOrOp: false, sawFiltered: false };
  const semiParts = splitSimpleOutsideQuotes(cleanCmd, (s, i) => (s[i] === ";" ? 1 : 0));
  const selectedSegs = [];
  let segIdx = semiParts.length - 1;
  while (segIdx >= 0) {
    const rawSeg = (semiParts[segIdx] || "").trim();
    if (!rawSeg) {
      segIdx -= 1;
      continue;
    }
    if (CHECK_PS_FAILFAST_ABORT_RE.test(rawSeg)) {
      segIdx -= 1;
      continue;
    }
    const okMatch = rawSeg.match(CHECK_PS_IF_PREV_OK_RE);
    if (okMatch) {
      selectedSegs.unshift({ unwrappedFromOk: okMatch[1].trim() });
      segIdx -= 1;
      continue;
    }
    selectedSegs.unshift({ raw: rawSeg });
    if (segIdx > 0) {
      const prevSeg = (semiParts[segIdx - 1] || "").trim();
      if (prevSeg && CHECK_PS_FAILFAST_ABORT_RE.test(prevSeg)) {
        segIdx -= 1;
        continue;
      }
    }
    break;
  }

  let hasOrOp = false;
  let sawFiltered = false;
  const out = [];
  const processRawSeg = (seg) => {
    let inS = false;
    let inD = false;
    for (let i = 0; i < seg.length - 1; i++) {
      const c = seg[i];
      if (inS) { if (c === "'") inS = false; continue; }
      if (inD) { if (c === "\\") { i++; continue; } if (c === '"') inD = false; continue; }
      if (c === "'") { inS = true; continue; }
      if (c === '"') { inD = true; continue; }
      if (c === "|" && seg[i + 1] === "|") hasOrOp = true;
    }
    const clauses = splitSimpleOutsideQuotes(seg, (s, i) =>
      (s[i] === "&" && s[i + 1] === "&") || (s[i] === "|" && s[i + 1] === "|") ? 2 : 0
    );
    const local = [];
    for (let idx = clauses.length - 1; idx >= 0; idx--) {
      const clause = clauses[idx];
      if (!clause || CHECK_PURE_SETUP_RE.test(clause)) continue;
      if (depth < 2) {
        const unwrapped = unwrapSimpleShellWrapper(clause);
        if (unwrapped) {
          const inner = collectCommandCandidateStages(unwrapped, depth + 1, { skipFilterStages });
          if (inner.hasOrOp) hasOrOp = true;
          if (inner.sawFiltered) sawFiltered = true;
          if (inner.stages.length > 0) {
            local.push(...inner.stages);
            continue;
          }
        }
      }
      if (checkClauseHasFilterStage(clause)) {
        sawFiltered = true;
        if (skipFilterStages) continue;
      }
      const stages = splitSimpleOutsideQuotes(clause, (s, i) =>
        s[i] === "|" && s[i + 1] !== "|" && s[i - 1] !== "|" ? 1 : 0
      );
      if (stages.length === 0) continue;
      const stage0 = stages[0]
        .replace(/\b2>&1\b/g, "")
        .replace(/\b[12]>(?:\/dev\/null|\$null|nul|\S+)\b/gi, "")
        .trim();
      const normHead = normalizeCheckStageHead(stage0);
      if (!normHead || CHECK_READ_ONLY_HEAD_RE.test(normHead)) continue;
      local.push(normHead);
    }
    return local;
  };

  for (let i = selectedSegs.length - 1; i >= 0; i--) {
    const item = selectedSegs[i];
    if (item.unwrappedFromOk) {
      const inner = collectCommandCandidateStages(item.unwrappedFromOk, depth + 1, { skipFilterStages });
      if (inner.hasOrOp) hasOrOp = true;
      if (inner.sawFiltered) sawFiltered = true;
      out.push(...inner.stages);
    } else {
      out.push(...processRawSeg(item.raw));
    }
  }
  return { stages: out, hasOrOp, sawFiltered };
}

function extractPrimaryStageFromCommand(command = "", preferredKind = "", depth = 0) {
  const { stages } = collectCommandCandidateStages(command, depth);
  if (stages.length === 0) return "";
  if (stages.length > 1 && (preferredKind === "test" || preferredKind === "build")) {
    const matched = stages.find((st) => classifyCheckKind("", st) === preferredKind);
    if (matched) return matched;
  }
  return stages[0];
}

function normalizeCheckTargetToken(raw = "") {
  let t = String(raw || "").trim();
  if (!t) return "";
  t = t.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/");
  t = t.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!t || t === "." || t === "./" || t === "..." || t === "./..." || t === "*" || t === "**") {
    return "";
  }
  return t.toLowerCase();
}

function stripTestFileStem(pathToken = "") {
  const norm = normalizeCheckTargetToken(pathToken);
  if (!norm) return "";
  const parts = norm.split("/");
  const base = parts[parts.length - 1] || "";
  const stripped = base
    .replace(/\.(?:test|spec|e2e)\.(?:[cm]?[jt]sx?|py|rb|php|go|rs)$/i, "")
    .replace(/\.(?:[cm]?[jt]sx?|py|rb|php|go|rs)$/i, "")
    .replace(/^(?:test_|spec_)/i, "")
    .replace(/(?:_test|_spec|\.test|\.spec)$/i, "");
  return stripped.trim();
}

function splitCheckTargetSubSelector(token = "") {
  const s = String(token || "");
  const doubleColonIdx = s.indexOf("::");
  if (doubleColonIdx > 0) {
    return { base: s.slice(0, doubleColonIdx), sub: s.slice(doubleColonIdx) };
  }
  const lineMatch = s.match(/^(.+?[./][^:]+)(:\d+(?::\d+)?)$/);
  if (lineMatch) {
    return { base: lineMatch[1], sub: lineMatch[2] };
  }
  return { base: s, sub: "" };
}

export function extractCheckIdentity(
  kind = "check",
  name = "",
  command = "",
  { missingDetails = false, batchKeys = null, primaryStage: precomputedStage = "" } = {}
) {
  const safeKind = kind || classifyCheckKind(name, command);
  if (missingDetails) {
    const cleanBatchKeys = Array.isArray(batchKeys)
      ? Array.from(new Set(batchKeys.map((k) => String(k || "").trim()).filter(Boolean))).sort()
      : [];
    return {
      kind: safeKind,
      tool: "run_checks",
      targets: [],
      pathTargets: [],
      scopeSelectors: [],
      filters: [],
      isBroad: false,
      isMissingSummary: true,
      batchKeys: cleanBatchKeys,
      checkKey: cleanBatchKeys.length > 0 ? `run_checks:missing:${cleanBatchKeys.join(",")}` : "run_checks:missing"
    };
  }
  const cleanCmd = String(command || "").trim();
  const primaryStage = precomputedStage || extractPrimaryStageFromCommand(cleanCmd, safeKind);

  let tool = "";
  let pathTargets = [];
  let scopeSelectors = [];
  let filters = [];
  let isBroad = false;

  if (primaryStage) {
    const rawTokens = splitShellArgsSimple(primaryStage);
    const headRaw = (rawTokens[0] || "").replace(/\\/g, "/");
    const head = headRaw.split("/").pop().replace(/\.(?:exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
    const rest = rawTokens.slice(1);

    const collectArgs = (
      argsList,
      {
        filterValueFlags = DEFAULT_FILTER_VALUE_FLAGS,
        selectorValueFlags = DEFAULT_SELECTOR_VALUE_FLAGS,
        narrowingBoolFlags = DEFAULT_NARROWING_BOOL_FLAGS,
        ignoredValueFlags = DEFAULT_IGNORED_VALUE_FLAGS,
        skipSubcommands = new Set(),
        parseFlagsAfterDoubleDash = false,
        positionalAsFilter = false,
        cargoTestMode = false
      } = {}
    ) => {
      const paths = [];
      const selectors = [];
      const filt = [];
      let afterDoubleDash = false;
      for (let idx = 0; idx < argsList.length; idx++) {
        const tok = argsList[idx];
        if (!tok) continue;
        if (!afterDoubleDash && tok === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (!afterDoubleDash && idx === 0 && skipSubcommands.has(tok.toLowerCase())) {
          continue;
        }
        const canParseFlag = !afterDoubleDash || parseFlagsAfterDoubleDash;
        if (canParseFlag && tok.startsWith("-")) {
          const eqIdx = tok.indexOf("=");
          const flagName = (eqIdx >= 0 ? tok.slice(0, eqIdx) : tok).toLowerCase();
          const inlineVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;
          if (cargoTestMode) {
            if (flagName === "--test" || flagName === "--bin" || flagName === "--example") {
              const val = inlineVal !== null ? inlineVal : idx + 1 < argsList.length ? argsList[++idx] : "";
              const normVal = normalizeCheckTargetToken(val);
              if (normVal) selectors.push(`cargo-target:${flagName.slice(2)}:${normVal}`);
              continue;
            }
            if (flagName === "--lib" || flagName === "--doc" || flagName === "--bins" || flagName === "--tests") {
              selectors.push(`cargo-target:${flagName.slice(2)}`);
              continue;
            }
            if (flagName === "-p" || flagName === "--package") {
              const val = inlineVal !== null ? inlineVal : idx + 1 < argsList.length ? argsList[++idx] : "";
              const normVal = normalizeCheckTargetToken(val);
              if (normVal) selectors.push(`ws:${normVal}`);
              continue;
            }
            if (flagName === "--exact" || flagName === "--ignored") {
              filt.push(`narrow:${flagName}`);
              continue;
            }
          }
          if (flagName === "--shard") {
            const val = inlineVal !== null ? inlineVal : idx + 1 < argsList.length ? argsList[++idx] : "";
            const normVal = normalizeCheckTargetToken(val);
            if (normVal) filt.push(`shard:${normVal}`);
            continue;
          }
          if (selectorValueFlags.has(flagName)) {
            const val = inlineVal !== null ? inlineVal : idx + 1 < argsList.length ? argsList[++idx] : "";
            const normVal = normalizeCheckTargetToken(val);
            if (normVal) {
              const prefix = flagName === "-w" || flagName === "--workspace" ? "ws" : "project";
              selectors.push(`${prefix}:${normVal}`);
            }
            continue;
          }
          if (filterValueFlags.has(flagName)) {
            const val = inlineVal !== null ? inlineVal : idx + 1 < argsList.length ? argsList[++idx] : "";
            const normVal = normalizeCheckTargetToken(val);
            if (normVal) filt.push(`filter:${normVal}`);
            continue;
          }
          if (narrowingBoolFlags.has(flagName)) {
            filt.push(`narrow:${flagName}`);
            continue;
          }
          if (ignoredValueFlags.has(flagName)) {
            if (inlineVal === null && idx + 1 < argsList.length && !argsList[idx + 1].startsWith("-")) {
              idx += 1;
            }
            continue;
          }
          continue;
        }
        const normPos = normalizeCheckTargetToken(tok);
        if (normPos) {
          if (positionalAsFilter) {
            filt.push(`filter:${normPos}`);
          } else {
            paths.push(normPos);
          }
        }
      }
      return {
        pathTargets: Array.from(new Set(paths)).sort(),
        scopeSelectors: Array.from(new Set(selectors)).sort(),
        filters: Array.from(new Set(filt)).sort()
      };
    };

    if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
      let idx = 0;
      const wsTargets = [];
      while (idx < rest.length && rest[idx].startsWith("-")) {
        const flag = rest[idx].toLowerCase();
        if (flag === "-w" || flag === "--workspace" || flag === "--filter" || flag === "-f") {
          if (idx + 1 < rest.length) {
            const normWs = normalizeCheckTargetToken(rest[++idx]);
            if (normWs) wsTargets.push(`ws:${normWs}`);
          }
        } else if (flag.startsWith("--workspace=") || flag.startsWith("--filter=")) {
          const normWs = normalizeCheckTargetToken(flag.slice(flag.indexOf("=") + 1));
          if (normWs) wsTargets.push(`ws:${normWs}`);
        } else if (flag === "--prefix" || flag === "--cwd" || flag === "--dir" || flag === "-c") {
          if (idx + 1 < rest.length) idx += 1;
        }
        idx += 1;
      }
      let sub = (rest[idx] || "").toLowerCase();
      let afterSub = rest.slice(idx + 1);
      if (sub === "run" || sub === "run-script") {
        sub = (afterSub[0] || "").toLowerCase();
        afterSub = afterSub.slice(1);
      }
      const parsed = collectArgs(afterSub, {
        parseFlagsAfterDoubleDash: true,
        narrowingBoolFlags: new Set([...DEFAULT_NARROWING_BOOL_FLAGS, "-o"]),
        ignoredValueFlags: new Set(Array.from(DEFAULT_IGNORED_VALUE_FLAGS).filter((f) => f !== "-o"))
      });
      pathTargets = parsed.pathTargets;
      filters = parsed.filters;
      if (sub === "t" || sub === "test") {
        tool = "pkg-test";
        scopeSelectors = Array.from(new Set([...wsTargets, ...parsed.scopeSelectors])).sort();
        isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
      } else if (sub === "build") {
        tool = "pkg-build";
        scopeSelectors = Array.from(new Set([...wsTargets, ...parsed.scopeSelectors])).sort();
        isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
      } else if (sub) {
        tool = "pkg-script";
        scopeSelectors = Array.from(new Set([`script:${sub}`, ...wsTargets, ...parsed.scopeSelectors])).sort();
        isBroad = false;
      } else {
        tool = head;
        scopeSelectors = Array.from(new Set([...wsTargets, ...parsed.scopeSelectors])).sort();
        isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
      }
    } else if (head === "node") {
      const hasTestFlag = rest.some((t) => t === "--test");
      if (hasTestFlag) {
        tool = "node-test";
        const parsed = collectArgs(rest, {
          filterValueFlags: new Set(["--test-name-pattern", "--test-skip-pattern"]),
          selectorValueFlags: new Set(),
          narrowingBoolFlags: new Set(["--test-only"]),
          ignoredValueFlags: new Set([
            "--test-reporter",
            "--test-reporter-destination",
            "--test-concurrency",
            "--test-timeout",
            "--import",
            "--loader",
            "--require",
            "-r",
            "--conditions",
            "-c"
          ]),
          parseFlagsAfterDoubleDash: true
        });
        pathTargets = parsed.pathTargets;
        scopeSelectors = parsed.scopeSelectors;
        filters = parsed.filters;
        isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
      } else {
        tool = "node";
        const parsed = collectArgs(rest);
        pathTargets = parsed.pathTargets;
        scopeSelectors = parsed.scopeSelectors;
        filters = parsed.filters;
        isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
      }
    } else if (head === "cargo") {
      const sub = (rest[0] || "").toLowerCase();
      tool = sub ? `cargo-${sub}` : "cargo";
      const isCargoTest = sub === "test" || sub === "nextest";
      const parsed = collectArgs(rest.slice(sub ? 1 : 0), {
        parseFlagsAfterDoubleDash: isCargoTest,
        positionalAsFilter: isCargoTest,
        cargoTestMode: isCargoTest
      });
      pathTargets = parsed.pathTargets;
      scopeSelectors = parsed.scopeSelectors;
      filters = parsed.filters;
      isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
    } else if (head === "go") {
      const sub = (rest[0] || "").toLowerCase();
      tool = sub ? `go-${sub}` : "go";
      const parsed = collectArgs(rest.slice(sub ? 1 : 0), {
        narrowingBoolFlags: new Set([...DEFAULT_NARROWING_BOOL_FLAGS, "-short"])
      });
      pathTargets = parsed.pathTargets;
      scopeSelectors = parsed.scopeSelectors;
      filters = parsed.filters;
      isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
    } else if (head === "dotnet" || head === "deno") {
      const sub = (rest[0] || "").toLowerCase();
      tool = sub ? `${head}-${sub}` : head;
      const parsed = collectArgs(rest.slice(sub ? 1 : 0), { parseFlagsAfterDoubleDash: true });
      pathTargets = parsed.pathTargets;
      scopeSelectors = parsed.scopeSelectors;
      filters = parsed.filters;
      isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
    } else if (head === "vitest" || head === "jest" || head === "playwright" || head === "cypress" || head === "mocha" || head === "pytest") {
      tool = head;
      const isJestLike = head === "vitest" || head === "jest";
      const parsed = collectArgs(rest, {
        skipSubcommands: head === "vitest" || head === "playwright" || head === "cypress" ? new Set(["run", "test"]) : new Set(),
        parseFlagsAfterDoubleDash: true,
        narrowingBoolFlags: isJestLike ? new Set([...DEFAULT_NARROWING_BOOL_FLAGS, "-o"]) : DEFAULT_NARROWING_BOOL_FLAGS,
        ignoredValueFlags: isJestLike
          ? new Set(Array.from(DEFAULT_IGNORED_VALUE_FLAGS).filter((f) => f !== "-o"))
          : DEFAULT_IGNORED_VALUE_FLAGS
      });
      pathTargets = parsed.pathTargets;
      scopeSelectors = parsed.scopeSelectors;
      filters = parsed.filters;
      isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
    } else if (head === "electron-vite" || head === "vite" || head === "next" || head === "nuxt" || head === "turbo" || head === "nx") {
      const sub = (rest[0] || "").toLowerCase();
      tool = sub ? `${head}-${sub}` : head;
      const parsed = collectArgs(rest.slice(sub ? 1 : 0));
      pathTargets = parsed.pathTargets;
      scopeSelectors = parsed.scopeSelectors;
      filters = parsed.filters;
      isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
    } else if (head) {
      tool = head;
      const parsed = collectArgs(rest);
      pathTargets = parsed.pathTargets;
      scopeSelectors = parsed.scopeSelectors;
      filters = parsed.filters;
      isBroad = pathTargets.length === 0 && scopeSelectors.length === 0 && filters.length === 0;
    }
  }

  const cleanName = stripCheckDurationSuffix(name).toLowerCase();
  if (!tool) {
    if (cleanName && !GENERIC_CHECK_NAMES.has(cleanName)) {
      tool = "named";
      scopeSelectors = [`name:${cleanName}`];
      isBroad = false;
    } else {
      tool = cleanName || safeKind;
      isBroad = true;
    }
  } else if (
    pathTargets.length === 0 &&
    scopeSelectors.length === 0 &&
    filters.length === 0 &&
    cleanName &&
    !GENERIC_CHECK_NAMES.has(cleanName) &&
    cleanName !== tool
  ) {
    const rawCmdLower = cleanCmd.toLowerCase();
    if (!rawCmdLower || (!rawCmdLower.includes(cleanName) && cleanName.length <= 40)) {
      scopeSelectors = [`name:${cleanName}`];
      isBroad = false;
    }
  }

  const targets = Array.from(new Set([...scopeSelectors, ...pathTargets, ...filters])).sort();
  const checkKey = `${safeKind}:${tool}:${targets.length > 0 ? targets.join("|") : "*"}`;
  return {
    kind: safeKind,
    tool,
    targets,
    pathTargets,
    scopeSelectors,
    filters,
    isBroad,
    isMissingSummary: false,
    checkKey
  };
}

function checkTargetCovers(passTarget, failTarget) {
  if (!passTarget || !failTarget) return false;
  if (passTarget === failTarget) return true;
  const passHasPrefix = /^(?:filter|shard|narrow|script|ws|project|name|cargo-target):/.test(passTarget);
  const failHasPrefix = /^(?:filter|shard|narrow|script|ws|project|name|cargo-target):/.test(failTarget);
  if (passHasPrefix || failHasPrefix) return false;
  const passParts = splitCheckTargetSubSelector(passTarget);
  const failParts = splitCheckTargetSubSelector(failTarget);
  if (passParts.sub) {
    if (!failParts.sub) return false;
    if (passParts.sub !== failParts.sub && !failParts.sub.startsWith(`${passParts.sub}::`)) {
      return false;
    }
  }
  const pBase = passParts.base;
  const fBase = failParts.base;
  if (pBase === fBase) return true;
  if (fBase.endsWith(`/${pBase}`) || pBase.endsWith(`/${fBase}`)) return true;
  if (fBase.startsWith(`${pBase}/`)) return true;
  const passHasSlash = pBase.includes("/");
  const failHasSlash = fBase.includes("/");
  if (passHasSlash !== failHasSlash) {
    const passStem = stripTestFileStem(pBase);
    const failStem = stripTestFileStem(fBase);
    if (passStem && failStem && passStem === failStem && !GENERIC_TEST_STEMS.has(passStem)) {
      return true;
    }
  }
  return false;
}

function areCheckToolsCompatibleForBroadPass(passId, failId) {
  if (!passId || !failId) return false;
  if (passId.tool === failId.tool) return true;
  if (passId.kind === "test" && passId.tool === "pkg-test") return true;
  if (
    passId.kind === "build" &&
    passId.tool === "pkg-build" &&
    (failId.tool === "pkg-build" ||
      failId.tool.endsWith("-build") ||
      failId.tool === "webpack" ||
      failId.tool === "rollup" ||
      failId.tool === "esbuild" ||
      failId.tool === "tsup")
  ) {
    return true;
  }
  return false;
}

export function doesPassResolveFailure(passId, failId) {
  if (!passId || !failId) return false;
  if (failId.isMissingSummary) return false;
  if (passId.kind !== failId.kind) return false;
  if (passId.checkKey === failId.checkKey) return true;
  if (passId.isBroad) {
    return areCheckToolsCompatibleForBroadPass(passId, failId);
  }
  if (failId.isBroad) {
    return false;
  }
  if (passId.tool !== failId.tool && passId.tool !== "named" && failId.tool !== "named") {
    return false;
  }
  const passFilters = Array.isArray(passId.filters) ? passId.filters : [];
  const failFilters = Array.isArray(failId.filters) ? failId.filters : [];
  if (passFilters.some((pf) => !failFilters.includes(pf))) {
    return false;
  }
  const passSelectors = Array.isArray(passId.scopeSelectors) ? passId.scopeSelectors : [];
  const failSelectors = Array.isArray(failId.scopeSelectors) ? failId.scopeSelectors : [];
  if (passSelectors.some((ps) => !failSelectors.includes(ps))) {
    return false;
  }
  if (failSelectors.some((fs) => /^(?:script|name):/.test(fs) && !passSelectors.includes(fs))) {
    return false;
  }
  const passPaths = Array.isArray(passId.pathTargets) ? passId.pathTargets : [];
  const failPaths = Array.isArray(failId.pathTargets) ? failId.pathTargets : [];
  if (passPaths.length > 0) {
    if (failPaths.length === 0) return false;
    if (!failPaths.every((ft) => passPaths.some((pt) => checkTargetCovers(pt, ft)))) {
      return false;
    }
  }
  if (failPaths.length === 0 && failSelectors.length === 0 && failFilters.length === 0) {
    return false;
  }
  return true;
}

export function extractCompoundPassIdentities(kind = "check", name = "", command = "") {
  const cleanCmd = String(command || "").trim();
  if (cleanCmd) {
    const { stages, hasOrOp, sawFiltered } = collectCommandCandidateStages(cleanCmd, 0, {
      skipFilterStages: true
    });
    if (hasOrOp) return [];
    if (stages.length === 0 && sawFiltered) return [];
    const byKey = new Map();
    if (stages.length === 1) {
      const singleId = extractCheckIdentity(kind, name, stages[0], { primaryStage: stages[0] });
      if (singleId && !singleId.isMissingSummary) byKey.set(singleId.checkKey, singleId);
      return Array.from(byKey.values());
    }
    if (!sawFiltered) {
      const primary = extractCheckIdentity(kind, name, cleanCmd);
      if (primary && !primary.isMissingSummary) {
        byKey.set(primary.checkKey, primary);
      }
    }
    for (const stage of stages) {
      const clauseKind = classifyCheckKind("", stage);
      const clauseId = extractCheckIdentity(clauseKind, "", stage, { primaryStage: stage });
      if (clauseId && !clauseId.isMissingSummary && !byKey.has(clauseId.checkKey)) {
        byKey.set(clauseId.checkKey, clauseId);
      }
    }
    return Array.from(byKey.values());
  }
  const primary = extractCheckIdentity(kind, name, command);
  return primary && !primary.isMissingSummary ? [primary] : [];
}

export function extractBatchCheckIdentities(commands = [], blockResults = []) {
  const byKey = new Map();
  const batchCommands = [];
  const seenCmdKey = new Set();
  const addEntry = (rawName, rawCmd) => {
    const name = stripCheckDurationSuffix(rawName);
    const command = String(rawCmd || "").replace(/\s+/g, " ").trim();
    if (!name && !command) return;
    const kind = classifyCheckKind(name, command);
    const id = extractCheckIdentity(kind, name, command);
    if (!id || id.isMissingSummary) return;
    if (!byKey.has(id.checkKey)) {
      byKey.set(id.checkKey, id);
    }
    if (!seenCmdKey.has(id.checkKey) && batchCommands.length < 12) {
      seenCmdKey.add(id.checkKey);
      batchCommands.push({
        name: name.slice(0, 60),
        command: command.slice(0, 120)
      });
    }
  };
  let cmdList = commands;
  if (typeof cmdList === "string") {
    try {
      const parsed = JSON.parse(cmdList);
      cmdList = Array.isArray(parsed) ? parsed : [];
    } catch {
      cmdList = [];
    }
  }
  if (Array.isArray(cmdList)) {
    for (const c of cmdList) {
      if (typeof c === "string") addEntry("", c);
      else if (c && typeof c === "object") addEntry(c.name || "", c.command || c.cmd || "");
    }
  }
  if (Array.isArray(blockResults)) {
    for (const b of blockResults) {
      if (!b || b.missingDetails) continue;
      addEntry(b.name || "", b.cmd || b.command || "");
    }
  }
  const batchKeys = Array.from(byKey.keys()).sort();
  const identities = batchKeys.map((k) => byKey.get(k));
  return { identities, batchKeys, batchCommands };
}

export function doesBatchPassResolveMissingFailure(passBatchIds = [], failSlot = null, { passTotalCount = 0 } = {}) {
  if (!failSlot || typeof failSlot !== "object") return false;
  const passIds = Array.isArray(passBatchIds) ? passBatchIds.filter(Boolean) : [];
  let failIds =
    Array.isArray(failSlot._batchIdentities) && failSlot._batchIdentities.length > 0
      ? failSlot._batchIdentities
      : [];
  if (failIds.length === 0 && Array.isArray(failSlot.batchCommands) && failSlot.batchCommands.length > 0) {
    failIds = extractBatchCheckIdentities(failSlot.batchCommands, []).identities;
  }
  const failTotal = Math.max(0, Number(failSlot.batchTotalCount || 0));
  const failKeys = Array.isArray(failSlot.batchKeys) ? failSlot.batchKeys.filter(Boolean) : [];
  const effPassTotal = Math.max(passIds.length, Number(passTotalCount || 0));

  if (failIds.length > 0 && (failTotal === 0 || failIds.length >= failTotal)) {
    if (passIds.length === 0) return false;
    return failIds.every((req) => passIds.some((p) => doesPassResolveFailure(p, req)));
  }
  if (failKeys.length > 0 && (failTotal === 0 || failKeys.length >= failTotal)) {
    if (passIds.length === 0) return false;
    const passKeySet = new Set(passIds.map((p) => p.checkKey));
    return failKeys.every((fk) => passKeySet.has(fk));
  }
  if (failTotal > 0 && effPassTotal < failTotal) {
    return false;
  }
  if (failIds.length > 0) {
    return failIds.every((req) => passIds.some((p) => doesPassResolveFailure(p, req)));
  }
  if (failKeys.length > 0) {
    const passKeySet = new Set(passIds.map((p) => p.checkKey));
    return failKeys.every((fk) => passKeySet.has(fk));
  }
  return effPassTotal > 0;
}

function toCompactCheckpointFailure(entry, fallbackKind = "test") {
  if (!entry || typeof entry !== "object") return null;
  const fullCmd = String(entry.command || "").trim();
  const cmd = fullCmd.slice(0, 512);
  const rawName = stripCheckDurationSuffix(entry.name || "");
  const name = (rawName || cmd || (fallbackKind === "build" ? "build" : "test")).trim().slice(0, 80);
  const missingDetails = Boolean(entry.missingDetails);
  const kind = entry.kind || fallbackKind || "test";
  const batchKeys = Array.isArray(entry.batchKeys)
    ? Array.from(
        new Set(
          entry.batchKeys
            .map((k) => String(k || "").trim().replace(/\s+\(\d+(?:\.\d+)?\s*(?:ms|s)\)(?=\||,|$)/gi, ""))
            .filter(Boolean)
        )
      )
        .sort()
        .slice(0, 12)
    : [];
  const batchCommands = Array.isArray(entry.batchCommands)
    ? entry.batchCommands
        .map((c) => ({
          name: stripCheckDurationSuffix(c?.name || "").slice(0, 60),
          command: String(c?.command || "").trim().slice(0, 200)
        }))
        .filter((c) => c.name || c.command)
        .slice(0, 10)
    : [];
  const batchTotalCount = Math.max(0, Number(entry.batchTotalCount || 0));
  const rawCheckKey = typeof entry.checkKey === "string" ? entry.checkKey.trim() : "";
  const checkKey =
    rawCheckKey && !CHECK_KEY_EMBEDDED_DURATION_RE.test(rawCheckKey)
      ? rawCheckKey
      : extractCheckIdentity(kind, name, fullCmd || cmd, { missingDetails, batchKeys }).checkKey;
  return {
    command: cmd,
    name,
    kind,
    checkKey,
    exitCode: missingDetails ? null : (entry.exitCode ?? 1),
    summary: String(entry.summary || "").trim().slice(0, 220),
    failureExcerpt: typeof entry.failureExcerpt === "string" ? entry.failureExcerpt : "",
    missingDetails,
    missingFailureCount: missingDetails ? Math.max(1, Number(entry.missingFailureCount || 1)) : 0,
    ...(batchKeys.length > 0 ? { batchKeys } : {}),
    ...(batchCommands.length > 0 ? { batchCommands } : {}),
    ...(batchTotalCount > 0 ? { batchTotalCount } : {}),
    at: entry.at || null
  };
}

function isWorkspaceTimestampExpired(rawAt, nowMs = Date.now(), fallbackAt = null) {
  const effectiveAt = rawAt || fallbackAt;
  if (!effectiveAt) return false;
  const ts = Date.parse(effectiveAt);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts > WORKSPACE_CHECKPOINT_FAILURE_TTL_MS;
}

function pruneWorkspaceUnresolvedFailures(items = [], nowMs = Date.now(), fallbackAt = null) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    return !isWorkspaceTimestampExpired(item.at, nowMs, fallbackAt);
  });
}

function expandPassIdentitiesFromList(entries = [], fallbackIds = []) {
  const byKey = new Map();
  for (const id of fallbackIds) {
    if (id && !id.isMissingSummary) byKey.set(id.checkKey, id);
  }
  for (const entry of entries) {
    if (!entry) continue;
    const name = stripCheckDurationSuffix(entry.name || "");
    const cmd = String(entry.command || entry.cmd || "").trim();
    if (!name && !cmd) continue;
    const kind = classifyCheckKind(name, cmd);
    for (const pid of extractCompoundPassIdentities(kind, name, cmd)) {
      if (pid && !pid.isMissingSummary && !byKey.has(pid.checkKey)) {
        byKey.set(pid.checkKey, pid);
      }
    }
  }
  return Array.from(byKey.values());
}

function extractPriorUnresolvedFailures(prev, fallbackKind = "test", { isWorkspaceAnon = false, nowMs = Date.now() } = {}) {
  if (!prev || typeof prev !== "object") return [];
  let out = [];
  if (Array.isArray(prev.unresolvedFailures) && prev.unresolvedFailures.length > 0) {
    out = prev.unresolvedFailures
      .map((item) => toCompactCheckpointFailure(item, fallbackKind))
      .filter(Boolean)
      .slice(0, MAX_CHECKPOINT_UNRESOLVED);
  } else if (!prev.ok && prev.outcome !== "timeout" && !prev.timedOut) {
    const one = toCompactCheckpointFailure(prev, fallbackKind);
    out = one ? [one] : [];
  } else if (prev.previousFailure && typeof prev.previousFailure === "object") {
    const one = toCompactCheckpointFailure(prev.previousFailure, fallbackKind);
    out = one ? [one] : [];
  }
  return isWorkspaceAnon ? pruneWorkspaceUnresolvedFailures(out, nowMs, prev.at || null) : out;
}

function mergeCheckpointFailures(newItems = [], existingItems = []) {
  const byKey = new Map();
  const out = [];
  for (const item of [...newItems, ...existingItems]) {
    if (!item) continue;
    const dedupKey = item.checkKey || `${item.kind}:${item.command || item.name}`;
    if (byKey.has(dedupKey)) continue;
    byKey.set(dedupKey, true);
    out.push(item);
    if (out.length >= MAX_CHECKPOINT_UNRESOLVED) break;
  }
  return out;
}

function truncateExcerptUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const limit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 0;
  if (limit === 0) return "";
  const str = String(text);
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let cut = limit;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  if (cut > 0) {
    let lastLead = cut - 1;
    while (lastLead > 0 && (buf[lastLead] & 0xc0) === 0x80) {
      lastLead -= 1;
    }
    const lead = buf[lastLead];
    let expectedLen = 1;
    if ((lead & 0xe0) === 0xc0) expectedLen = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
    if (cut - lastLead < expectedLen) {
      cut = lastLead;
    }
  }
  let out = buf.subarray(0, cut).toString("utf8");
  if (out.length > 0) {
    const lastCode = out.charCodeAt(out.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      out = out.slice(0, -1);
    }
  }
  return out;
}

function normalizeFailureExcerpt(rawExcerpt) {
  if (typeof rawExcerpt !== "string" || !rawExcerpt.trim()) return "";
  const redacted = redactSecrets(rawExcerpt).text;
  const lines = redacted
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => {
      let clean = line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trim();
      if (typeof clean.toWellFormed === "function") clean = clean.toWellFormed();
      return clean;
    })
    .filter(Boolean)
    .slice(0, MAX_FAILURE_EXCERPT_LINES);
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= MAX_FAILURE_EXCERPT_BYTES) {
    return joined;
  }
  return truncateExcerptUtf8Safe(joined, MAX_FAILURE_EXCERPT_BYTES).trimEnd();
}

export class CheckpointMethods {
  /** Record modified file paths into the session's structured compaction checkpoint ledger */
  recordModifiedFiles(sessionId, filePaths = [], { worktree = "", tool = null } = {}) {
    this.open();
    const sid = sessionId || "default";
    const list = Array.isArray(filePaths) ? filePaths : [filePaths];
    const cleaned = list
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    if (cleaned.length === 0) return this.getSessionCheckpoint(sid);

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const normKey = (p) => {
      const posix = p.replace(/\\/g, "/");
      return process.platform === "win32" ? posix.toLowerCase() : posix;
    };

    const MAX_CHECKPOINT_FILES = 30;
    this._withBusyRetry(() => {
      let inTx = false;
      try {
        this.db.exec("BEGIN IMMEDIATE;");
        inTx = true;
        const row = this.db
          .prepare("SELECT worktree, modified_files_json, last_test_json, last_build_json FROM session_checkpoints WHERE session_id = ?")
          .get(sid);

        let existing = [];
        if (row?.modified_files_json) {
          try {
            const parsed = JSON.parse(row.modified_files_json);
            if (Array.isArray(parsed)) existing = parsed;
          } catch {}
        }

        const byKey = new Map();
        for (const item of existing) {
          if (!item) continue;
          const p = typeof item === "string" ? item : item.path;
          if (!p) continue;
          byKey.set(normKey(p), typeof item === "string" ? { path: p, edits: 1, lastTool: null, updatedAt: nowIso } : item);
        }

        for (const rawPath of cleaned) {
          const displayPath = worktree
            ? (() => {
                const rel = path.relative(worktree, rawPath);
                if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel)) {
                  return rel.replace(/\\/g, "/");
                }
                return rawPath.replace(/\\/g, "/");
              })()
            : rawPath.replace(/\\/g, "/");
          const k = normKey(displayPath);
          const prev = byKey.get(k);
          byKey.delete(k); // Move to most-recent end
          byKey.set(k, {
            path: displayPath,
            edits: (prev?.edits || 0) + 1,
            lastTool: tool || prev?.lastTool || null,
            updatedAt: nowIso
          });
        }

        const merged = Array.from(byKey.values()).slice(-MAX_CHECKPOINT_FILES);
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              modified_files_json = excluded.modified_files_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(
            sid,
            worktree || row?.worktree || "",
            JSON.stringify(merged),
            row?.last_test_json ?? null,
            row?.last_build_json ?? null,
            now,
            nowIso
          );

        this.db.exec("COMMIT;");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { this.db.exec("ROLLBACK;"); } catch {}
        }
        throw err;
      }
    });

    return this.getSessionCheckpoint(sid);
  }

  /** Record latest test or build verification status into the session checkpoint ledger */
  recordVerificationResult(
    sessionId,
    {
      kind = "test",
      command = "",
      ruleId = "",
      exitCode = 0,
      passed = null,
      outcome = null,
      timedOut = false,
      missingDetails = false,
      missingFailureCount = 0,
      summary = "",
      failureExcerpt = "",
      sourceId = null,
      worktree = "",
      batchCommands = null,
      batchTotalCount = 0,
      failedCommands = null,
      passedCommands = null
    } = {}
  ) {
    this.open();
    const sid = sessionId || "default";
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const isBuild = kind === "build";
    const slotKind = isBuild ? "build" : "test";
    const parsedExitCode =
      exitCode !== null &&
      exitCode !== undefined &&
      typeof exitCode !== "boolean" &&
      String(exitCode).trim() !== "" &&
      Number.isFinite(Number(exitCode))
        ? Number(exitCode)
        : null;
    const isTimeout = outcome === "timeout" || timedOut === true;
    const ok = isTimeout
      ? false
      : passed !== null && passed !== undefined
        ? Boolean(passed)
        : parsedExitCode === 0;
    const effectiveOutcome = isTimeout ? "timeout" : ok ? "pass" : "fail";
    const normalizedExcerpt = effectiveOutcome === "fail" ? normalizeFailureExcerpt(failureExcerpt) : "";
    const fullCommand = String(command || "").trim();
    const cleanCommand = fullCommand.slice(0, 140);
    const cleanSummary = String(summary || "").trim().slice(0, 220);
    const isRunChecks = String(ruleId || "") === "run_checks";
    const batchMeta = isRunChecks
      ? extractBatchCheckIdentities(batchCommands || [], [
          ...(Array.isArray(passedCommands) ? passedCommands : []),
          ...(Array.isArray(failedCommands) ? failedCommands : [])
        ])
      : { identities: [], batchKeys: [], batchCommands: [] };
    const effectiveBatchTotal = Math.max(
      0,
      Number(batchTotalCount || 0) || (isRunChecks ? batchMeta.identities.length : 0)
    );
    const incomingIdentity = extractCheckIdentity(slotKind, "", fullCommand || cleanCommand, {
      missingDetails: effectiveOutcome === "fail" && Boolean(missingDetails),
      batchKeys: batchMeta.batchKeys
    });
    const passedBatchNames =
      effectiveOutcome === "pass" && isRunChecks
        ? Array.from(
            new Set(
              (Array.isArray(passedCommands) && passedCommands.length > 0
                ? passedCommands
                : Array.isArray(batchCommands)
                  ? batchCommands
                  : []
              )
                .map((c) => stripCheckDurationSuffix(c?.name || "") || String(c?.command || "").replace(/\s+/g, " ").trim())
                .filter(Boolean)
            )
          ).slice(0, 4)
        : [];
    const payloadObj = {
      command: cleanCommand,
      ruleId: String(ruleId || ""),
      checkKey: incomingIdentity.checkKey,
      ok,
      outcome: effectiveOutcome,
      exitCode: parsedExitCode,
      summary: cleanSummary,
      sourceId: sourceId || null,
      at: nowIso
    };
    if (isTimeout) {
      payloadObj.timedOut = true;
    }
    if (passedBatchNames.length > 1) {
      payloadObj.batchNames = passedBatchNames;
    }
    if (effectiveOutcome === "fail" && missingDetails) {
      payloadObj.missingDetails = true;
      payloadObj.missingFailureCount = Math.max(1, Number(missingFailureCount) || 1);
      if (batchMeta.batchKeys.length > 0) payloadObj.batchKeys = batchMeta.batchKeys.slice(0, 12);
      if (batchMeta.batchCommands.length > 0) payloadObj.batchCommands = batchMeta.batchCommands.slice(0, 10);
      if (effectiveBatchTotal > 0) payloadObj.batchTotalCount = effectiveBatchTotal;
    }
    if (normalizedExcerpt) {
      payloadObj.failureExcerpt = normalizedExcerpt;
    }

    const resolvePriorFailuresWithPassIds = (priorFailures, passIds, passBatchTotal = 0) =>
      priorFailures.filter((f) => {
        if (!f) return false;
        if (f.missingDetails) {
          if (!isRunChecks) return true;
          return !doesBatchPassResolveMissingFailure(passIds, f, { passTotalCount: passBatchTotal });
        }
        const failId = extractCheckIdentity(f.kind || slotKind, f.name || "", f.command || "", {
          missingDetails: false
        });
        return !passIds.some((pid) => doesPassResolveFailure(pid, failId));
      });

    this._withBusyRetry(() => {
      let inTx = false;
      try {
        this.db.exec("BEGIN IMMEDIATE;");
        inTx = true;
        let priorUnresolved = [];
        try {
          const existingRow = this.db
            .prepare("SELECT last_test_json, last_build_json FROM session_checkpoints WHERE session_id = ?")
            .get(sid);
          const rawPrev = isBuild ? existingRow?.last_build_json : existingRow?.last_test_json;
          if (rawPrev) {
            const prev = JSON.parse(rawPrev);
            priorUnresolved = extractPriorUnresolvedFailures(prev, slotKind, {
              isWorkspaceAnon: /^workspace:/i.test(sid),
              nowMs: now
            });
          }
        } catch {}

        if (isTimeout) {
          if (priorUnresolved.length > 0) {
            payloadObj.unresolvedFailures = priorUnresolved.slice(0, MAX_CHECKPOINT_UNRESOLVED);
            payloadObj.previousFailure = priorUnresolved[0];
          }
        } else if (effectiveOutcome === "fail") {
          let remainingPrior = priorUnresolved;
          if (isRunChecks && Array.isArray(passedCommands) && passedCommands.length > 0) {
            const passOnlyIds = expandPassIdentitiesFromList(
              passedCommands,
              extractBatchCheckIdentities([], passedCommands).identities
            );
            if (passOnlyIds.length > 0) {
              remainingPrior = remainingPrior.filter((f) => {
                if (!f || f.missingDetails) return true;
                const failId = extractCheckIdentity(f.kind || slotKind, f.name || "", f.command || "", {
                  missingDetails: false
                });
                return !passOnlyIds.some((pid) => doesPassResolveFailure(pid, failId));
              });
            }
          }
          const newFailures = [];
          if (missingDetails) {
            const missItem = toCompactCheckpointFailure(
              {
                command: cleanCommand,
                name: cleanCommand || cleanSummary || "run_checks",
                kind: slotKind,
                checkKey: incomingIdentity.checkKey,
                exitCode: null,
                summary: cleanSummary,
                failureExcerpt: "",
                missingDetails: true,
                missingFailureCount: Math.max(1, Number(missingFailureCount) || 1),
                batchKeys: batchMeta.batchKeys,
                batchCommands: batchMeta.batchCommands,
                batchTotalCount: effectiveBatchTotal,
                at: nowIso
              },
              slotKind
            );
            if (missItem) newFailures.push(missItem);
          } else if (isRunChecks && Array.isArray(failedCommands) && failedCommands.length > 0) {
            for (const fc of failedCommands.slice(0, MAX_CHECKPOINT_UNRESOLVED)) {
              const fcName = stripCheckDurationSuffix(fc?.name || "");
              const fcCmd = String(fc?.command || "").trim();
              const fcKind = classifyCheckKind(fcName, fcCmd);
              const fcId = extractCheckIdentity(fcKind, fcName, fcCmd);
              const item = toCompactCheckpointFailure(
                {
                  command: fcCmd || fcName || cleanCommand,
                  name: fcName || fcCmd || cleanCommand,
                  kind: fcKind,
                  checkKey: fcId.checkKey,
                  exitCode: parsedExitCode ?? 1,
                  summary: cleanSummary,
                  failureExcerpt: normalizedExcerpt,
                  missingDetails: false,
                  at: nowIso
                },
                slotKind
              );
              if (item) newFailures.push(item);
            }
          } else {
            const item = toCompactCheckpointFailure(
              {
                command: fullCommand || cleanCommand,
                name: cleanCommand || slotKind,
                kind: slotKind,
                checkKey: incomingIdentity.checkKey,
                exitCode: parsedExitCode ?? 1,
                summary: cleanSummary,
                failureExcerpt: normalizedExcerpt,
                missingDetails: false,
                at: nowIso
              },
              slotKind
            );
            if (item) newFailures.push(item);
          }
          const mergedFailures = mergeCheckpointFailures(newFailures, remainingPrior);
          if (mergedFailures.length > 0) {
            payloadObj.unresolvedFailures = mergedFailures;
          }
        } else {
          // effectiveOutcome === "pass"
          const hasExplicitPassed = Array.isArray(passedCommands) && passedCommands.length > 0;
          const passIds = isRunChecks
            ? expandPassIdentitiesFromList(
                hasExplicitPassed
                  ? passedCommands
                  : Array.isArray(batchCommands)
                    ? batchCommands
                    : [],
                hasExplicitPassed
                  ? []
                  : batchMeta.identities.length > 0
                    ? batchMeta.identities
                    : extractCompoundPassIdentities(slotKind, "", fullCommand || cleanCommand)
              )
            : extractCompoundPassIdentities(slotKind, "", fullCommand || cleanCommand);
          const remaining = resolvePriorFailuresWithPassIds(priorUnresolved, passIds, effectiveBatchTotal);
          if (remaining.length > 0) {
            payloadObj.unresolvedFailures = remaining.slice(0, MAX_CHECKPOINT_UNRESOLVED);
          }
        }

        const payload = JSON.stringify(payloadObj);
        if (isBuild) {
          this.db
            .prepare(`
              INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
              VALUES (?, ?, '[]', NULL, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
                last_build_json = excluded.last_build_json,
                updated_ts = excluded.updated_ts,
                updated_at = excluded.updated_at
            `)
            .run(sid, worktree || "", payload, now, nowIso);
        } else {
          this.db
            .prepare(`
              INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
              VALUES (?, ?, '[]', ?, NULL, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
                last_test_json = excluded.last_test_json,
                updated_ts = excluded.updated_ts,
                updated_at = excluded.updated_at
            `)
            .run(sid, worktree || "", payload, now, nowIso);
        }
        this.db.exec("COMMIT;");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { this.db.exec("ROLLBACK;"); } catch {}
        }
        throw err;
      }
    });

    return this.getSessionCheckpoint(sid);
  }

  /** Retrieve compact structured session checkpoint for compaction recovery */
  getSessionCheckpoint(sessionId) {
    this.open();
    const sid = sessionId || "default";
    const row =
      sid === "all" || sid === "lifetime" || sid === "app"
        ? this.db
            .prepare("SELECT * FROM session_checkpoints ORDER BY updated_ts DESC LIMIT 1")
            .get()
        : this.db
            .prepare("SELECT * FROM session_checkpoints WHERE session_id = ?")
            .get(sid);

    if (!row) {
      return {
        modifiedFiles: [],
        modifiedFileCount: 0,
        lastTest: null,
        lastBuild: null,
        updatedAt: null
      };
    }

    let rawFiles = [];
    try {
      const parsed = JSON.parse(row.modified_files_json || "[]");
      if (Array.isArray(parsed)) rawFiles = parsed;
    } catch {}

    const modifiedFiles = rawFiles
      .map((item) => (typeof item === "string" ? item : item?.path))
      .filter(Boolean)
      .reverse()
      .slice(0, 20);

    const isWorkspaceAnon = /^workspace:/i.test(String(row.session_id || sid || ""));
    const pruneSlot = (slot) => {
      if (!slot || typeof slot !== "object") return slot;
      if (!isWorkspaceAnon) return slot;
      const nowMs = Date.now();
      const copy = { ...slot };
      const hadUnresolved = Array.isArray(copy.unresolvedFailures) && copy.unresolvedFailures.length > 0;
      if (hadUnresolved) {
        const fresh = pruneWorkspaceUnresolvedFailures(copy.unresolvedFailures, nowMs, copy.at || null);
        if (fresh.length > 0) copy.unresolvedFailures = fresh;
        else delete copy.unresolvedFailures;
      }
      if (copy.previousFailure && typeof copy.previousFailure === "object") {
        if (isWorkspaceTimestampExpired(copy.previousFailure.at, nowMs, copy.at || null)) {
          delete copy.previousFailure;
        }
      }
      const isTimeout = copy.outcome === "timeout" || copy.timedOut === true;
      if (!copy.ok && !isTimeout) {
        if (hadUnresolved && !copy.unresolvedFailures) {
          return null;
        }
        if (isWorkspaceTimestampExpired(copy.at, nowMs, null) && !copy.unresolvedFailures) {
          return null;
        }
      }
      return copy;
    };

    let lastTest = null;
    if (row.last_test_json) {
      try { lastTest = pruneSlot(JSON.parse(row.last_test_json)); } catch {}
    }
    let lastBuild = null;
    if (row.last_build_json) {
      try { lastBuild = pruneSlot(JSON.parse(row.last_build_json)); } catch {}
    }

    return {
      modifiedFiles,
      modifiedFileCount: rawFiles.length,
      lastTest,
      lastBuild,
      updatedAt: row.updated_at || null
    };
  }

  /** Returns true if at least one non-default conversation checkpoint exists (shared MCP server hint) */
  hasNonDefaultCheckpoints() {
    this.open();
    try {
      const row = this.db
        .prepare("SELECT 1 AS hit FROM session_checkpoints WHERE session_id != 'default' LIMIT 1")
        .get();
      return Boolean(row && row.hit === 1);
    } catch {
      return false;
    }
  }

  /** Read git-HEAD-keyed workspace skeleton cache */
  getRepoCache(workspaceDir, headSha, kind, maxAgeMs = 7 * 24 * 3600 * 1000) {
    this.open();
    const normDir = this._normalizeTrackPath(workspaceDir);
    const row = this.db
      .prepare("SELECT payload, updated_ts FROM repo_cache WHERE workspace_dir = ? AND head_sha = ? AND kind = ?")
      .get(normDir, String(headSha || "nogit"), String(kind || "hotspots"));
    if (!row) return null;
    if (maxAgeMs > 0 && Date.now() - Number(row.updated_ts) > maxAgeMs) return null;
    return row.payload;
  }

  /** Write git-HEAD-keyed workspace skeleton cache and prune obsolete commits for same workspace */
  setRepoCache(workspaceDir, headSha, kind, payload) {
    this.open();
    const normDir = this._normalizeTrackPath(workspaceDir);
    const sha = String(headSha || "nogit");
    const k = String(kind || "hotspots");
    const now = Date.now();
    this._withWriteTx(() => {
      this.db
        .prepare("DELETE FROM repo_cache WHERE workspace_dir = ? AND kind = ? AND head_sha != ?")
        .run(normDir, k, sha);
      this.db
        .prepare(`
          INSERT INTO repo_cache (workspace_dir, head_sha, kind, payload, updated_ts)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(workspace_dir, head_sha, kind) DO UPDATE SET
            payload = excluded.payload,
            updated_ts = excluded.updated_ts
        `)
        .run(normDir, sha, k, String(payload ?? ""), now);
    });
  }

  /**
   * Look up persistent L2 outline symbols for a file by normalized path, mtimeMs (±1 ms tolerance), and exact fileSize.
   * Touches updated_ts for LRU recency on hit and returns `{ lineCount, symbols }` or `null`.
   */
  getOutlineCache(filePath, mtimeMs, fileSize, version = null) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;
    const mtime = Number(mtimeMs);
    const size = Number(fileSize);
    if (!Number.isFinite(mtime) || !Number.isFinite(size)) return null;

    const row = this.db
      .prepare("SELECT mtime_ms, file_size, line_count, symbols_json FROM outline_cache WHERE file_path = ?")
      .get(norm);
    if (!row) return null;
    if (Math.abs(Number(row.mtime_ms) - mtime) > 1 || Number(row.file_size) !== size) {
      return null;
    }

    let symbols;
    try {
      const entry = JSON.parse(row.symbols_json);
      if (version !== null && entry.version !== version) return null;
      symbols = Array.isArray(entry) ? entry : entry.symbols;
    } catch {
      return null;
    }
    if (!Array.isArray(symbols)) return null;

    try {
      this._withBusyRetry(() => {
        this.db
          .prepare("UPDATE outline_cache SET updated_ts = ? WHERE file_path = ?")
          .run(Date.now(), norm);
      });
    } catch {
      // Best-effort LRU touch
    }

    return {
      lineCount: Number(row.line_count),
      symbols
    };
  }

  /**
   * Persist extracted outline symbols in SQLite L2 cache (bounded to max 512 entries LRU, skipping >128 KB JSON).
   */
  setOutlineCache(filePath, mtimeMs, fileSize, lineCount, symbols, options = {}) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm || !Array.isArray(symbols)) return false;
    const mtime = Number(mtimeMs);
    const size = Number(fileSize);
    const lines = Math.max(0, Math.trunc(Number(lineCount) || 0));
    if (!Number.isFinite(mtime) || !Number.isFinite(size) || size < 0) return false;

    const symbolsJson = JSON.stringify(options.version ? { version: options.version, symbols } : symbols);
    if (Buffer.byteLength(symbolsJson, "utf8") > MAX_OUTLINE_JSON_BYTES) {
      return false;
    }

    const now = Date.now();
    const cap =
      Number.isFinite(options?.maxEntries) && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : MAX_OUTLINE_CACHE_DB_ENTRIES;

    this._withWriteTx(() => {
      this.db
        .prepare(`
          INSERT INTO outline_cache (file_path, mtime_ms, file_size, line_count, symbols_json, updated_ts)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            line_count = excluded.line_count,
            symbols_json = excluded.symbols_json,
            updated_ts = excluded.updated_ts
        `)
        .run(norm, mtime, Math.trunc(size), lines, symbolsJson, now);

      const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM outline_cache").get();
      if (countRow && countRow.cnt > cap) {
        const excess = countRow.cnt - cap;
        this.db
          .prepare(`
            DELETE FROM outline_cache
            WHERE rowid IN (
              SELECT rowid FROM outline_cache
              ORDER BY updated_ts ASC, rowid ASC
              LIMIT ?
            )
          `)
          .run(excess);
      }
    });

    return true;
  }

  /** Delete one path, an array of paths, or all entries from persistent outline_cache */
  deleteOutlineCache(filePath = null) {
    this.open();
    return this._withBusyRetry(() => {
      if (filePath === null || filePath === undefined || filePath === "") {
        const res = this.db.prepare("DELETE FROM outline_cache").run();
        return res.changes || 0;
      }
      if (Array.isArray(filePath)) {
        const norms = Array.from(
          new Set(
            filePath
              .map((p) => (typeof p === "string" ? this._normalizeTrackPath(p) : ""))
              .filter(Boolean)
          )
        );
        if (norms.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < norms.length; i += 400) {
          const batch = norms.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          const res = this.db
            .prepare(`DELETE FROM outline_cache WHERE file_path IN (${placeholders})`)
            .run(...batch);
          total += res.changes || 0;
        }
        return total;
      }
      const norm = this._normalizeTrackPath(filePath);
      if (!norm) return 0;
      const res = this.db.prepare("DELETE FROM outline_cache WHERE file_path = ?").run(norm);
      return res.changes || 0;
    });
  }
}
