import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex, stableStringify } from "./stable-json.js";

import {
  DEFAULT_CACHE_TTL_SEC,
  CONTEXT_WARN_TOKENS,
  CONTEXT_CRITICAL_TOKENS,
  MIN_CACHEABLE_CONTEXT_TOKENS,
  BUST_DROP_RATIO,
  DEFAULT_CACHE_DISCOUNT_RATE,
  DEFAULT_INPUT_PRICE_PER_1M,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_MEDIA_EST_TOKENS,
  MODEL_CACHE_PROFILES,
  resolveModelProfile,
  computeCacheWarmth,
  roundUsd,
  estimateCostSavingsPct
} from "./cache/profiles.js";

export {
  DEFAULT_CACHE_TTL_SEC,
  CONTEXT_WARN_TOKENS,
  CONTEXT_CRITICAL_TOKENS,
  MIN_CACHEABLE_CONTEXT_TOKENS,
  BUST_DROP_RATIO,
  DEFAULT_CACHE_DISCOUNT_RATE,
  DEFAULT_INPUT_PRICE_PER_1M,
  DEFAULT_CACHE_WRITE_MULTIPLIER,
  DEFAULT_MEDIA_EST_TOKENS,
  MODEL_CACHE_PROFILES,
  resolveModelProfile,
  computeCacheWarmth,
  estimateCostSavingsPct
};

const COMPOSITION_KEYS = Object.freeze([
  "user",
  "thinking",
  "assistant",
  "toolCalls",
  "fileReads",
  "toolResults",
  "media"
]);

const COMPOSITION_LABELS = Object.freeze({
  thinking: "Thinking",
  fileReads: "File Reads",
  toolResults: "Tool Outputs",
  assistant: "Assistant",
  user: "User",
  toolCalls: "Tool Calls",
  media: "Media"
});

const PRIMARY_AGENT_NAMES = new Set(["", "primary", "main", "antigravity", "default"]);

const WARN_WINDOW_RATIO = 0.65;
const CRITICAL_WINDOW_RATIO = 0.80;
const COLD_COMPACT_WINDOW_RATIO = 0.30;
const DELAY_HOT_WINDOW_RATIO = 0.15;
const EMPIRICAL_TTL_TRIGGER_RATIO = 1.1;


function toNonNegNum(val) {
  if (typeof val === "number") {
    return Number.isFinite(val) && val >= 0 ? val : null;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function firstNonNeg(...vals) {
  for (const v of vals) {
    const n = toNonNegNum(v);
    if (n !== null) return n;
  }
  return null;
}

function firstPosOrNonNeg(...vals) {
  let zeroCandidate = null;
  for (const v of vals) {
    const n = toNonNegNum(v);
    if (n === null) continue;
    if (n > 0) return n;
    if (zeroCandidate === null) zeroCandidate = n;
  }
  return zeroCandidate;
}

function parsePositiveTokenLimit(val) {
  const n = toNonNegNum(val);
  return n !== null && n >= 1024 ? Math.round(n) : null;
}

/** Extract real per-conversation maxTokenLimit from transcript step metadata/config fields */
export function extractStepMaxTokenLimit(step) {
  if (!step || typeof step !== "object") return null;
  const candidates = [
    step.max_token_limit,
    step.maxTokenLimit,
    step.model_config?.max_token_limit,
    step.model_config?.maxTokenLimit,
    step.modelConfig?.max_token_limit,
    step.modelConfig?.maxTokenLimit,
    step.metadata?.maxTokenLimit,
    step.metadata?.max_token_limit,
    step.config?.maxTokenLimit,
    step.config?.max_token_limit
  ];
  for (const c of candidates) {
    const parsed = parsePositiveTokenLimit(c);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Extract normalized per-turn token usage across Antigravity, Anthropic, Gemini, and OpenAI schemas
 * without double-counting cached tokens when prompt_tokens/promptTokenCount is inclusive.
 */
export function extractStepTokenUsage(step) {
  if (!step || typeof step !== "object") {
    return {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      contextTokens: 0
    };
  }
  const usage =
    (step.usage && typeof step.usage === "object" ? step.usage : null) ||
    (step.usageMetadata && typeof step.usageMetadata === "object" ? step.usageMetadata : null) ||
    (step.usage_metadata && typeof step.usage_metadata === "object" ? step.usage_metadata : null) ||
    {};

  const hasOpenAiResponsesDetails =
    usage.input_tokens_details !== null &&
    typeof usage.input_tokens_details === "object" &&
    toNonNegNum(usage.input_tokens_details.cached_tokens) !== null;

  const cacheReadTokens =
    firstPosOrNonNeg(
      step.cache_read_tokens,
      step.cache_read_input_tokens,
      usage.cache_read_tokens,
      usage.cache_read_input_tokens,
      usage.cachedContentTokenCount,
      usage.cached_content_token_count,
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens,
      usage.prompt_cache_hit_tokens
    ) ?? 0;

  const cacheCreation1hTokens =
    firstPosOrNonNeg(
      step.cache_creation_1h_tokens,
      usage.cache_creation?.ephemeral_1h_input_tokens
    ) ?? 0;
  const cacheCreation5mTokens =
    firstPosOrNonNeg(usage.cache_creation?.ephemeral_5m_input_tokens) ?? 0;
  const rawCacheCreate = firstPosOrNonNeg(
    step.cache_creation_tokens,
    step.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cache_creation_input_tokens
  );
  const cacheCreationTokens =
    rawCacheCreate !== null ? rawCacheCreate : cacheCreation5mTokens + cacheCreation1hTokens;

  // Disjoint uncached input tokens (Antigravity top-level or Anthropic usage.input_tokens)
  // Note: OpenAI Responses API usage.input_tokens is INCLUSIVE of input_tokens_details.cached_tokens
  const disjointIn = hasOpenAiResponsesDetails
    ? firstPosOrNonNeg(step.input_tokens)
    : firstPosOrNonNeg(step.input_tokens, usage.input_tokens);
  // Inclusive total prompt tokens (OpenAI prompt_tokens / Responses usage.input_tokens / Gemini promptTokenCount)
  const inclusivePrompt = firstPosOrNonNeg(
    step.prompt_tokens,
    step.promptTokenCount,
    usage.prompt_tokens,
    hasOpenAiResponsesDetails ? usage.input_tokens : null,
    usage.promptTokenCount,
    usage.prompt_token_count
  );

  let inputTokens = 0;
  if (disjointIn !== null && (disjointIn > 0 || inclusivePrompt === null)) {
    inputTokens = disjointIn;
  } else if (inclusivePrompt !== null) {
    inputTokens = Math.max(0, inclusivePrompt - cacheReadTokens - cacheCreationTokens);
  }

  const outputTokens =
    firstPosOrNonNeg(
      step.output_tokens,
      usage.output_tokens,
      usage.completion_tokens,
      usage.candidatesTokenCount,
      usage.candidates_token_count
    ) ?? 0;

  const thinkingTokens =
    firstPosOrNonNeg(
      step.thinking_tokens,
      step.reasoning_tokens,
      usage.thinking_tokens,
      usage.thoughtsTokenCount,
      usage.thoughts_token_count,
      usage.reasoning_tokens,
      usage.completion_tokens_details?.reasoning_tokens,
      usage.output_tokens_details?.reasoning_tokens
    ) ?? 0;

  const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens;

  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation1hTokens,
    outputTokens,
    thinkingTokens,
    contextTokens
  };
}

function calibrateEmpiricalTtl(profile, maxWarmHitGapSec, hasExplicit1hWrite = false) {
  const profileTtl = profile?.ttlSec || DEFAULT_CACHE_TTL_SEC;
  const isExtended1hTierModel =
    Boolean(profile?.id && /^claude/i.test(profile.id)) ||
    (profile?.cacheWrite1hMultiplier || 1) > (profile?.cacheWriteMultiplier || 1);

  if (hasExplicit1hWrite) {
    const floor =
      maxWarmHitGapSec !== null && maxWarmHitGapSec > 3600
        ? Math.ceil(maxWarmHitGapSec / 60) * 60
        : 3600;
    return Math.max(profileTtl, floor);
  }
  if (maxWarmHitGapSec === null || !(maxWarmHitGapSec > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO)) {
    return null;
  }
  const roundedFloor = Math.ceil(maxWarmHitGapSec / 60) * 60;
  if (isExtended1hTierModel) {
    return maxWarmHitGapSec <= 3600 ? 3600 : roundedFloor;
  }
  return roundedFloor;
}

function parseTimeMs(iso) {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse JSONL transcript content into step objects (skips malformed lines) */
export function parseTranscriptLines(content) {
  if (!content || typeof content !== "string") return [];
  const steps = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        steps.push(parsed);
      }
    } catch {
      // Ignore partial or malformed lines
    }
  }
  return steps;
}

/**
 * Fast bounded-memory tail reader for large transcript.jsonl files.
 * Reads maxBytes from the end of the file (automatically widening up to 2 MB if
 * the final JSONL step itself is larger than maxBytes, e.g. large tool dump or media).
 */
export function readTranscriptTail(filePath, maxBytes = 131072) {
  if (!filePath) return [];
  const HARD_CAP_BYTES = 2 * 1024 * 1024;
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    fd = fs.openSync(filePath, "r");

    let windowBytes = Math.min(stat.size, Math.max(4096, maxBytes));
    while (true) {
      const offset = stat.size - windowBytes;
      const buf = Buffer.allocUnsafe(windowBytes);
      const bytesRead = fs.readSync(fd, buf, 0, windowBytes, offset);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      if (offset > 0) {
        const firstNl = text.indexOf("\n");
        if (firstNl >= 0) {
          text = text.slice(firstNl + 1);
        } else {
          text = "";
        }
      }
      const steps = parseTranscriptLines(text);
      const hasUsageStep = steps.some((s) => {
        const u = extractStepTokenUsage(s);
        return u.contextTokens > 0 || u.outputTokens > 0;
      });
      if (hasUsageStep || offset === 0 || windowBytes >= HARD_CAP_BYTES) {
        return steps;
      }
      windowBytes = Math.min(stat.size, Math.min(HARD_CAP_BYTES, windowBytes * 4));
    }
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function getCallArgs(call) {
  if (!call || typeof call !== "object") return null;
  const raw = call.args ?? call.arguments ?? call.input;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normPath(raw, baseCwd = "") {
  if (!raw) return "";
  let p = String(raw).trim().replace(/^["']|["']$/g, "");
  if (!p) return "";
  if (baseCwd && !path.isAbsolute(p) && !/^[a-zA-Z]:[\\/]/.test(p)) {
    p = path.posix.join(String(baseCwd).replace(/\\/g, "/"), p.replace(/\\/g, "/"));
  }
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function shortTargetLabel(rawPath, maxLen = 42) {
  if (!rawPath) return "";
  const cleaned = String(rawPath).trim().replace(/\\/g, "/");
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const tail = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (tail.length <= maxLen) return tail;
  }
  return cleaned.slice(0, maxLen - 3) + "...";
}

function unwrapEffectiveTool(call) {
  const rawName = String(call?.name || "").trim();
  const args = getCallArgs(call) || {};
  if (rawName === "call_mcp_tool") {
    const mcpTool = String(args.ToolName ?? args.toolName ?? "").trim();
    let mcpArgs = args.Arguments ?? args.arguments;
    if (typeof mcpArgs === "string") {
      try {
        mcpArgs = JSON.parse(mcpArgs);
      } catch {
        mcpArgs = {};
      }
    }
    return {
      rawName,
      tool: mcpTool ? `mcp:${mcpTool}` : "call_mcp_tool",
      bareTool: mcpTool || "call_mcp_tool",
      args: mcpArgs && typeof mcpArgs === "object" ? mcpArgs : {}
    };
  }
  return { rawName, tool: rawName || "unknown", bareTool: rawName || "unknown", args };
}

const TRANSIENT_CALL_KEYS = new Set(["toolSummary", "WaitMsBeforeAsync", "timeoutSec", "verifyTimeoutSec"]);

function cleanArgsForFingerprint(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replace(/\\/g, "/").trim().slice(0, 240);
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((v) => cleanArgsForFingerprint(v, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (TRANSIENT_CALL_KEYS.has(k)) continue;
    out[k] = cleanArgsForFingerprint(v, depth + 1);
  }
  return out;
}

/** Compute normalized canonical fingerprint and short display descriptor for a tool call */
export function describeToolCall(call) {
  const { tool, bareTool, args } = unwrapEffectiveTool(call);
  let target = "";

  if (bareTool === "read_file" || bareTool === "view_file") {
    const p = args.Path ?? args.path ?? args.filePath ?? args.AbsolutePath ?? args.absolutePath ?? "";
    const s = args.StartLine ?? args.startLine ?? args.start_line;
    const e = args.EndLine ?? args.endLine ?? args.end_line;
    target = shortTargetLabel(p) + (s || e ? `:L${s || 1}-${e || "eof"}` : "");
  } else if (
    bareTool === "edit_file" ||
    bareTool === "write_file" ||
    bareTool === "write_to_file" ||
    bareTool === "replace_file_content" ||
    bareTool === "multi_replace_file_content"
  ) {
    target = shortTargetLabel(
      args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath ?? ""
    );
  } else if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 1 && edits[0]?.path) {
      target = shortTargetLabel(edits[0].path);
    } else if (edits.length > 1) {
      target = `${edits.length} files`;
    }
  } else if (bareTool === "run_command") {
    target = shortTargetLabel(args.CommandLine ?? args.commandLine ?? args.command ?? "", 44);
  } else if (bareTool === "run_checks" || /(?:^|_)run_checks$/.test(bareTool)) {
    const cmds = Array.isArray(args.commands) ? args.commands : [];
    const first = cmds[0];
    const firstLabel = typeof first === "string" ? first : first?.name || first?.command || "";
    target = cmds.length > 1 ? `${shortTargetLabel(firstLabel, 24)} +${cmds.length - 1}` : shortTargetLabel(firstLabel, 40);
  } else if (bareTool === "batch_search" || /(?:^|_)batch_search$/.test(bareTool)) {
    const qs = Array.isArray(args.queries) ? args.queries : [];
    target = qs.length > 0 ? `${qs.length}q:${shortTargetLabel(qs[0]?.pattern || "", 26)}` : "";
  } else if (bareTool === "read_slices" || /(?:^|_)read_slices$/.test(bareTool)) {
    const o = Array.isArray(args.outlines) ? args.outlines.length : 0;
    const s = Array.isArray(args.slices) ? args.slices.length : 0;
    target = [o ? `${o} outlines` : "", s ? `${s} slices` : ""].filter(Boolean).join(", ");
  } else if (bareTool === "ctx_execute") {
    target = shortTargetLabel(args.intent || args.file || args.language || "shell", 36);
  } else if (bareTool === "ctx_index") {
    target = shortTargetLabel(args.url || args.path || args.label || "text", 36);
  } else if (bareTool === "ctx_search") {
    const qs = Array.isArray(args.queries) ? args.queries.join(",") : "";
    target = shortTargetLabel(qs, 36);
  } else if (args.Path || args.path || args.url || args.query) {
    target = shortTargetLabel(args.Path || args.path || args.url || args.query, 36);
  }

  const normalizedArgs = cleanArgsForFingerprint(args);
  const serialized = `${tool}:${stableStringify(normalizedArgs)}`;
  const fingerprint = serialized.length > 256 ? `${tool}:${sha256Hex(serialized).slice(0, 24)}` : serialized;
  const label = target ? `${tool}(${target})` : tool;

  return { tool, bareTool, target, label, fingerprint };
}

const IGNORED_LOOP_TOOLS = new Set(["finish", "notify_user", "task_boundary"]);
const READ_ONLY_INSPECT_TOOLS = new Set([
  "read_file",
  "view_file",
  "read_slices",
  "batch_search",
  "ctx_search",
  "ctx_stats",
  "ctx_doctor",
  "ctx_resume",
  "find_by_name",
  "grep_search",
  "list_dir"
]);

function isStepFailureResult(step, bareTool = "") {
  if (!step || typeof step !== "object") return false;
  if (step.status === "ERROR" || step.is_error === true || step.isError === true) return true;
  const code = step.exit_code ?? step.exitCode;
  if (typeof code === "number" && code !== 0) return true;
  const text = typeof step.content === "string" ? step.content : "";
  if (!text) return false;
  if (
    text.includes("Encountered error in step execution") ||
    text.includes("Atomic edit aborted") ||
    text.includes("Partial edit applied") ||
    text.includes("Tool error (") ||
    text.includes("Verify [FAIL") ||
    text.includes("Verify [TIMEOUT") ||
    text.includes("## [FAIL") ||
    text.includes("## [ERROR") ||
    text.includes("## [TIMEOUT")
  ) {
    return true;
  }
  // Explicit zero exit code or SUCCESS status without harness failure banners means command succeeded
  if (code === 0 || step.status === "SUCCESS") return false;
  // Never infer command failure from source code contents returned by read/search tools
  if (bareTool && READ_ONLY_INSPECT_TOOLS.has(bareTool)) return false;
  if (/(?:exit(?:ed)?(?:\s+with)?\s+code|FAIL\s*\(exit)\s*:?\s*[1-9]\d*/i.test(text)) {
    return true;
  }
  if (/(?:^|\n)\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|✖\s+|not ok\s+\d+|FAIL\s+\S)/m.test(text)) {
    return true;
  }
  const failCountMatch = text.match(/\b(\d+)\s+failed\b/i);
  if (failCountMatch && Number(failCountMatch[1]) > 0) {
    return true;
  }
  return false;
}

function extractCallEditPaths(call) {
  const { bareTool, args } = unwrapEffectiveTool(call);
  const paths = [];
  if (
    bareTool === "edit_file" ||
    bareTool === "write_file" ||
    bareTool === "write_to_file" ||
    bareTool === "replace_file_content" ||
    bareTool === "multi_replace_file_content"
  ) {
    const p = normPath(args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath);
    if (p) paths.push(p);
  } else if ((bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) && !args.dryRun) {
    const baseCwd = args.cwd || "";
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) {
        if (e && e.path) {
          const p = normPath(e.path, baseCwd);
          if (p) paths.push(p);
        }
      }
    }
  }
  return paths;
}

function isCheckOrVerifyCall(call) {
  const { bareTool, args } = unwrapEffectiveTool(call);
  if (
    bareTool === "run_command" ||
    bareTool === "run_checks" ||
    /(?:^|_)run_checks$/.test(bareTool) ||
    bareTool === "ctx_execute" ||
    bareTool === "ctx_batch"
  ) {
    return true;
  }
  if ((bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) && args.verify) {
    return true;
  }
  return false;
}

/**
 * CJK/UTF-8-aware byte & token estimator (never returns NaN or negative values).
 * Pure ASCII uses ~4 bytes/token; CJK ideographs/kana/hangul count ~1.0 token/char,
 * astral symbols (e.g. emoji) ~1.5 tokens/char, other multi-byte scripts ~0.5 tokens/char.
 */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { bytes: 0, estTokens: 0 };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0) return { bytes: 0, estTokens: 0 };
  if (bytes === text.length) {
    return { bytes, estTokens: Math.ceil(bytes / 4) };
  }
  let asciiCount = 0;
  let cjkCount = 0;
  let otherNonAscii = 0;
  let astralCount = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      asciiCount += 1;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      astralCount += 1;
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    } else if (
      (c >= 0x3000 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef)
    ) {
      cjkCount += 1;
    } else {
      otherNonAscii += 1;
    }
  }
  const rawTokens = asciiCount / 4 + cjkCount * 1.0 + otherNonAscii * 0.5 + astralCount * 1.5;
  const estTokens = Number.isFinite(rawTokens) && rawTokens > 0 ? Math.max(1, Math.ceil(rawTokens)) : 0;
  return { bytes, estTokens };
}

function extractStepText(val) {
  if (typeof val === "string") return val;
  if (val === null || val === undefined) return "";
  if (Array.isArray(val)) {
    const parts = [];
    for (const item of val) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        if (typeof item.text === "string") {
          parts.push(item.text);
        } else if (item.type !== "image" && item.type !== "image_url" && item.type !== "media") {
          try {
            parts.push(JSON.stringify(item));
          } catch {}
        }
      }
    }
    return parts.join("\n");
  }
  if (typeof val === "object") {
    if (typeof val.text === "string") return val.text;
    try {
      return JSON.stringify(val);
    } catch {
      return "";
    }
  }
  return "";
}

function serializeToolCallPayload(call) {
  if (!call || typeof call !== "object") return "";
  const name = typeof call.name === "string" ? call.name.trim() : "";
  const raw = call.args ?? call.arguments ?? call.input;
  let argsStr = "";
  if (typeof raw === "string") {
    argsStr = raw;
  } else if (raw !== undefined && raw !== null) {
    try {
      argsStr = JSON.stringify(raw);
    } catch {
      argsStr = String(raw);
    }
  }
  if (name && argsStr) return `${name} ${argsStr}`;
  return name || argsStr;
}

function isFileReadToolName(rawToolName) {
  if (typeof rawToolName !== "string") return false;
  const name = rawToolName.trim().toLowerCase();
  if (!name) return false;
  if (name === "read_file" || name === "view_file" || name === "read_slices") return true;
  return /(?:^|[:_/.])(read_file|view_file|read_slices)$/.test(name);
}

function isSubagentDelegationToolName(rawToolName) {
  if (typeof rawToolName !== "string") return false;
  const name = rawToolName.trim().toLowerCase();
  if (!name) return false;
  return name === "invoke_subagent" || /(?:^|[:_/.])invoke_subagent$/.test(name);
}

function isSubagentDelegationCall(call) {
  if (!call || typeof call !== "object") return false;
  const { bareTool, args } = unwrapEffectiveTool(call);
  const lower = bareTool.toLowerCase();
  if (isSubagentDelegationToolName(lower)) return true;
  if (lower === "swarm" || /(?:^|[:_/.])swarm$/.test(lower)) {
    const action = typeof args?.action === "string" ? args.action.trim().toLowerCase() : "";
    return action === "add";
  }
  return false;
}

export function isSubagentStep(step) {
  if (!step || typeof step !== "object") return false;
  if (step.subagent === true || step.is_subagent === true || step.isSubagent === true) return true;
  const source = typeof step.source === "string" ? step.source.trim().toUpperCase() : "";
  if (source === "SUBAGENT" || source === "SUB_AGENT") return true;
  const role = typeof step.role === "string" ? step.role.trim().toLowerCase() : "";
  if (role === "subagent" || role === "sub_agent") return true;
  if (typeof step.agent === "string") {
    const agentNorm = step.agent.trim().toLowerCase();
    if (agentNorm && !PRIMARY_AGENT_NAMES.has(agentNorm)) return true;
  }
  if (typeof step.agent_name === "string") {
    const agentNorm = step.agent_name.trim().toLowerCase();
    if (agentNorm && !PRIMARY_AGENT_NAMES.has(agentNorm)) return true;
  }
  if (typeof step.subagent_id === "string" && step.subagent_id.trim()) return true;
  if (typeof step.subagentId === "string" && step.subagentId.trim()) return true;
  return false;
}

function createRawCompositionBuckets() {
  return {
    user: { bytes: 0, estTokens: 0 },
    thinking: { bytes: 0, estTokens: 0 },
    assistant: { bytes: 0, estTokens: 0 },
    toolCalls: { bytes: 0, estTokens: 0 },
    fileReads: { bytes: 0, estTokens: 0 },
    toolResults: { bytes: 0, estTokens: 0 },
    media: { bytes: 0, estTokens: 0, mediaCount: 0 }
  };
}

function finalizeContextComposition(rawBuckets) {
  let totalBytes = 0;
  let totalEstTokens = 0;
  for (const key of COMPOSITION_KEYS) {
    const b = rawBuckets[key];
    b.bytes = Number.isFinite(b.bytes) && b.bytes > 0 ? Math.round(b.bytes) : 0;
    b.estTokens = Number.isFinite(b.estTokens) && b.estTokens > 0 ? Math.round(b.estTokens) : 0;
    totalBytes += b.bytes;
    totalEstTokens += b.estTokens;
  }
  let dominantCategory = null;
  let maxTok = 0;
  let maxBytes = -1;
  const out = {};
  for (const key of COMPOSITION_KEYS) {
    const b = rawBuckets[key];
    const pctRaw = totalEstTokens > 0 ? Number(((b.estTokens / totalEstTokens) * 100).toFixed(1)) : 0;
    const pct = Object.is(pctRaw, -0) || !Number.isFinite(pctRaw) ? 0 : pctRaw;
    if (key === "media") {
      const mc = Number.isFinite(b.mediaCount) && b.mediaCount > 0 ? Math.round(b.mediaCount) : 0;
      out.media = { bytes: b.bytes, estTokens: b.estTokens, pct, mediaCount: mc };
    } else {
      out[key] = { bytes: b.bytes, estTokens: b.estTokens, pct };
    }
    if (
      totalEstTokens > 0 &&
      (b.estTokens > maxTok || (b.estTokens === maxTok && b.estTokens > 0 && b.bytes > maxBytes))
    ) {
      maxTok = b.estTokens;
      maxBytes = b.bytes;
      dominantCategory = key;
    }
  }
  out.mediaCount = out.media.mediaCount;
  out.totalBytes = totalBytes;
  out.totalEstTokens = totalEstTokens;
  out.dominantCategory = dominantCategory;
  return out;
}

/** Return a clean zero-initialized contextComposition structure */
export function createEmptyContextComposition() {
  return finalizeContextComposition(createRawCompositionBuckets());
}

function createRawSubagentCounters() {
  return {
    primaryTurns: 0,
    subagentTurns: 0,
    primaryToolCalls: 0,
    subagentToolCalls: 0,
    subagentDelegations: 0,
    subagentResultBytes: 0,
    subagentResultEstTokens: 0,
    subagentTrafficEstTokens: 0
  };
}

function finalizeSubagentBreakdown(raw, totalEstTokens) {
  const safeInt = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const primaryTurns = safeInt(raw.primaryTurns);
  const subagentTurns = safeInt(raw.subagentTurns);
  const primaryToolCalls = safeInt(raw.primaryToolCalls);
  const subagentToolCalls = safeInt(raw.subagentToolCalls);
  const subagentDelegations = safeInt(raw.subagentDelegations);
  const subagentResultBytes = safeInt(raw.subagentResultBytes);
  const subagentResultEstTokens = safeInt(raw.subagentResultEstTokens);
  const subagentTrafficEstTokens = safeInt(raw.subagentTrafficEstTokens);
  const safeTotal = Number.isFinite(totalEstTokens) && totalEstTokens > 0 ? totalEstTokens : 0;
  const rawShare = safeTotal > 0 ? Math.min(100, (subagentTrafficEstTokens / safeTotal) * 100) : 0;
  const roundedShare = Number(rawShare.toFixed(1));
  const subagentSharePct = Object.is(roundedShare, -0) || !Number.isFinite(roundedShare) ? 0 : roundedShare;
  return {
    primaryTurns,
    subagentTurns,
    primaryToolCalls,
    subagentToolCalls,
    subagentDelegations,
    subagentResultBytes,
    subagentResultEstTokens,
    subagentTrafficEstTokens,
    subagentSharePct
  };
}

/** Return a clean zero-initialized subagentBreakdown structure */
export function createEmptySubagentBreakdown() {
  return finalizeSubagentBreakdown(createRawSubagentCounters(), 0);
}

/**
 * Analyze a single transcript session's steps for server-side KV-cache / Prompt Cache
 * hit rates, model-aware dynamic watermarks & TTL, cache-bust attribution, wasted re-prefill
 * tokens, doom-loop / oscillation monitoring, recent 15-turn hit trend, and top-3 context deltas.
 */
export function analyzeTranscriptCache(steps, options = {}) {
  const explicitTtlSec =
    Number.isFinite(options.ttlSec) && options.ttlSec > 0 ? options.ttlSec : null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const explicitWindowTokens =
    Number.isFinite(options.windowTokens) && options.windowTokens > 0 ? options.windowTokens : null;
  const explicitMaxTokenLimit =
    parsePositiveTokenLimit(options.maxTokenLimit);
  const explicitWarnTokens =
    Number.isFinite(options.warnTokens) && options.warnTokens > 0 ? options.warnTokens : null;
  const explicitCriticalTokens =
    Number.isFinite(options.criticalTokens) && options.criticalTokens > 0 ? options.criticalTokens : null;
  const explicitColdCompactTokens =
    Number.isFinite(options.coldCompactTokens) && options.coldCompactTokens > 0 ? options.coldCompactTokens : null;
  const explicitDelayHotTokens =
    Number.isFinite(options.delayHotMinTokens) && options.delayHotMinTokens > 0 ? options.delayHotMinTokens : null;
  const explicitDiscountRate =
    Number.isFinite(options.cacheDiscountRate) && options.cacheDiscountRate > 0 && options.cacheDiscountRate <= 1
      ? options.cacheDiscountRate
      : null;
  const explicitWriteMultiplier =
    Number.isFinite(options.cacheWriteMultiplier) && options.cacheWriteMultiplier >= 1
      ? options.cacheWriteMultiplier
      : null;
  const explicitInputPricePer1M =
    Number.isFinite(options.inputPricePer1M) && options.inputPricePer1M > 0
      ? options.inputPricePer1M
      : null;

  const bustsByCause = {
    ttl_idle_expiry: 0,
    model_switch: 0,
    compaction_or_truncation: 0,
    system_injection: 0,
    multimodal_media: 0,
    prefix_drift: 0
  };
  const recentBusts = [];
  const allTurns = [];
  const deltaAttributions = [];

  let turnsWithUsage = 0;
  let warmTurns = 0;
  let cachedTokensTotal = 0;
  let uncachedInputTokensTotal = 0;
  let cacheCreationTokensTotal = 0;
  let cacheCreation1hTokensTotal = 0;
  let outputTokensTotal = 0;
  let thinkingTokensTotal = 0;
  let wastedTokensTotal = 0;
  let wastedRewrittenTokens = 0;
  let hitRateSum = 0;
  let hitRateCount = 0;
  let peakContextTokens = 0;
  let currentContextTokens = 0;
  let currentModel = "";
  let transcriptMaxTokenLimit = null;
  let lastPlannerMs = null;
  let totalMediaCount = 0;
  let multimodalHighCtxTurns = 0;
  let duplicateReadCount = 0;
  let maxWarmHitGapSec = null;
  const maxWarmGapByProfile = new Map();
  const seen1hWriteByProfile = new Map();

  let prevCtxTokens = 0;
  let prevModel = "";
  let prevPlannerMs = null;
  let mediaLoadedSincePrev = false;
  let systemMsgSincePrev = false;
  let hasSeenPlanner = false;
  let prevTurnTools = [];

  const seenReadSignatures = new Set();

  // Doom-loop & edit<->fail oscillation tracking
  const LOOP_WINDOW_SIZE = 12;
  const recentCallWindow = []; // { fingerprint, label }
  let editEpoch = 0;
  const lastPassCheckEpoch = new Map();
  let pendingEditFiles = new Set();
  let editFailOscillations = 0;
  const oscillatingFilesCount = new Map();

  // Context composition & primary vs subagent attribution accumulators
  const compRaw = createRawCompositionBuckets();
  const subRaw = createRawSubagentCounters();
  let pendingToolCalls = [];
  let pendingCallCursor = 0;
  const pendingCallsById = new Map();

  for (let i = 0; i < (steps?.length || 0); i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") continue;

    const stepLimit = extractStepMaxTokenLimit(step);
    if (stepLimit !== null) {
      transcriptMaxTokenLimit = stepLimit;
    }

    const stepIsSubagent = isSubagentStep(step);

    let stepMediaBytes = 0;
    let stepMediaEstTokens = 0;
    if (Array.isArray(step.media) && step.media.length > 0) {
      totalMediaCount += step.media.length;
      if (hasSeenPlanner) mediaLoadedSincePrev = true;
      for (const item of step.media) {
        const explicitTok =
          item && typeof item === "object"
            ? firstNonNeg(item.tokens, item.estTokens, item.est_tokens, item.token_count, item.tokenCount)
            : null;
        const explicitBytes =
          item && typeof item === "object"
            ? firstNonNeg(item.bytes, item.size, item.byteSize, item.byte_size)
            : null;
        const itemEstTok = explicitTok !== null ? Math.round(explicitTok) : DEFAULT_MEDIA_EST_TOKENS;
        const itemBytes =
          explicitBytes !== null
            ? Math.round(explicitBytes)
            : item && typeof item === "object" && typeof item.data === "string"
              ? Buffer.byteLength(item.data, "utf8")
              : 0;
        stepMediaBytes += itemBytes;
        stepMediaEstTokens += itemEstTok;
        compRaw.media.bytes += itemBytes;
        compRaw.media.estTokens += itemEstTok;
        compRaw.media.mediaCount += 1;
      }
      if (stepIsSubagent) {
        subRaw.subagentResultBytes += stepMediaBytes;
        subRaw.subagentResultEstTokens += stepMediaEstTokens;
        subRaw.subagentTrafficEstTokens += stepMediaEstTokens;
      }
    }

    if (step.type === "USER_INPUT") {
      const userMeasure = estimateTextTokens(extractStepText(step.content ?? step.text));
      compRaw.user.bytes += userMeasure.bytes;
      compRaw.user.estTokens += userMeasure.estTokens;
      if (stepIsSubagent) {
        subRaw.subagentResultBytes += userMeasure.bytes;
        subRaw.subagentResultEstTokens += userMeasure.estTokens;
        subRaw.subagentTrafficEstTokens += userMeasure.estTokens;
      }
      // New user turn starts: clear previous turn's tool attribution so user prompt growth isn't misattributed
      prevTurnTools = [];
      pendingToolCalls = [];
      pendingCallCursor = 0;
      pendingCallsById.clear();
      continue;
    }

    if (step.type === "SYSTEM_MESSAGE") {
      if (hasSeenPlanner) {
        const msgText = typeof step.content === "string" ? step.content.trim() : "";
        if (msgText.length > 0) {
          systemMsgSincePrev = true;
        }
      }
      if (stepIsSubagent) {
        const subSysMeasure = estimateTextTokens(extractStepText(step.content ?? step.text));
        compRaw.toolResults.bytes += subSysMeasure.bytes;
        compRaw.toolResults.estTokens += subSysMeasure.estTokens;
        subRaw.subagentResultBytes += subSysMeasure.bytes;
        subRaw.subagentResultEstTokens += subSysMeasure.estTokens;
        subRaw.subagentTrafficEstTokens += subSysMeasure.estTokens;
      }
      continue;
    }

    if (step.type === "GENERIC" || step.type === "TOOL_RESULT") {
      let matchedCallMeta = null;
      const stepCallId = step.tool_call_id ?? step.call_id ?? null;
      if (stepCallId !== null && pendingCallsById.has(String(stepCallId))) {
        matchedCallMeta = pendingCallsById.get(String(stepCallId));
        matchedCallMeta.consumed = true;
      } else {
        while (pendingCallCursor < pendingToolCalls.length && pendingToolCalls[pendingCallCursor].consumed) {
          pendingCallCursor += 1;
        }
        if (pendingCallCursor < pendingToolCalls.length) {
          matchedCallMeta = pendingToolCalls[pendingCallCursor++];
          matchedCallMeta.consumed = true;
        }
      }
      const explicitToolName = String(step.tool_name ?? step.toolName ?? step.tool ?? step.name ?? "").trim();
      const effectiveToolName =
        explicitToolName && explicitToolName !== "call_mcp_tool"
          ? explicitToolName
          : matchedCallMeta?.bareTool || explicitToolName || "";
      const isFromDelegation =
        Boolean(matchedCallMeta?.isDelegation) || isSubagentDelegationToolName(explicitToolName);

      const resMeasure = estimateTextTokens(extractStepText(step.content ?? step.output ?? step.result));
      if (isFileReadToolName(effectiveToolName)) {
        compRaw.fileReads.bytes += resMeasure.bytes;
        compRaw.fileReads.estTokens += resMeasure.estTokens;
      } else {
        compRaw.toolResults.bytes += resMeasure.bytes;
        compRaw.toolResults.estTokens += resMeasure.estTokens;
      }
      if (stepIsSubagent || isFromDelegation) {
        subRaw.subagentResultBytes += resMeasure.bytes;
        subRaw.subagentResultEstTokens += resMeasure.estTokens;
        subRaw.subagentTrafficEstTokens += resMeasure.estTokens;
        if (isFromDelegation && !stepIsSubagent && (stepMediaBytes > 0 || stepMediaEstTokens > 0)) {
          subRaw.subagentResultBytes += stepMediaBytes;
          subRaw.subagentResultEstTokens += stepMediaEstTokens;
          subRaw.subagentTrafficEstTokens += stepMediaEstTokens;
        }
      }
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE") {
      if (stepIsSubagent) {
        const isSubResponse =
          step.type === "SUBAGENT_RESPONSE" || step.type === "SUBAGENT_TURN" || step.type === "ASSISTANT";
        if (isSubResponse) {
          subRaw.subagentTurns += 1;
        }
        const subTextMeasure = estimateTextTokens(
          extractStepText(step.content ?? step.text ?? step.output ?? step.result)
        );
        if (isSubResponse) {
          compRaw.assistant.bytes += subTextMeasure.bytes;
          compRaw.assistant.estTokens += subTextMeasure.estTokens;
        } else {
          compRaw.toolResults.bytes += subTextMeasure.bytes;
          compRaw.toolResults.estTokens += subTextMeasure.estTokens;
        }
        subRaw.subagentResultBytes += subTextMeasure.bytes;
        subRaw.subagentResultEstTokens += subTextMeasure.estTokens;
        subRaw.subagentTrafficEstTokens += subTextMeasure.estTokens;

        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          subRaw.subagentToolCalls += step.tool_calls.length;
          for (const call of step.tool_calls) {
            const callMeasure = estimateTextTokens(serializeToolCallPayload(call));
            compRaw.toolCalls.bytes += callMeasure.bytes;
            compRaw.toolCalls.estTokens += callMeasure.estTokens;
            subRaw.subagentResultBytes += callMeasure.bytes;
            subRaw.subagentResultEstTokens += callMeasure.estTokens;
            subRaw.subagentTrafficEstTokens += callMeasure.estTokens;
            if (isSubagentDelegationCall(call)) {
              subRaw.subagentDelegations += 1;
            }
          }
        }
      }
      continue;
    }

    // Track primary vs subagent planner turn & reset pending tool calls for following results
    if (stepIsSubagent) {
      subRaw.subagentTurns += 1;
    } else {
      subRaw.primaryTurns += 1;
    }
    pendingToolCalls = [];
    pendingCallCursor = 0;
    pendingCallsById.clear();

    // Collect immediately following tool result steps (GENERIC / TOOL_RESULT) before next PLANNER_RESPONSE / USER_INPUT
    const followingResults = [];
    for (let j = i + 1; j < steps.length; j++) {
      const nxt = steps[j];
      if (!nxt || typeof nxt !== "object") continue;
      if (nxt.type === "PLANNER_RESPONSE" || nxt.type === "USER_INPUT") break;
      if (nxt.type === "GENERIC" || nxt.type === "TOOL_RESULT") {
        followingResults.push(nxt);
      }
    }

    const currTurnTools = [];
    const turnEditedFiles = [];
    let turnRanCheck = false;
    const callBareTools = [];
    const resultByCallId = new Map();
    const bareToolByCallId = new Map();
    for (const r of followingResults) {
      const rid = r?.tool_call_id ?? r?.call_id ?? r?.toolCallId ?? null;
      if (rid !== null && rid !== undefined && String(rid).trim() !== "") {
        resultByCallId.set(String(rid), r);
      }
    }

    // Track duplicate read_file / view_file calls, edit invalidations, loop fingerprints & edit<->fail oscillations
    if (Array.isArray(step.tool_calls)) {
      const invalidatePath = (pNorm) => {
        if (!pNorm) return;
        const base = path.posix.basename(pNorm);
        for (const sig of Array.from(seenReadSignatures)) {
          const sigPath = sig.slice(0, sig.lastIndexOf(":", sig.lastIndexOf(":") - 1));
          if (
            sigPath === pNorm ||
            sigPath.endsWith(`/${pNorm}`) ||
            pNorm.endsWith(`/${sigPath}`) ||
            (pNorm === base && path.posix.basename(sigPath) === base)
          ) {
            seenReadSignatures.delete(sig);
          }
        }
      };

      if (stepIsSubagent) {
        subRaw.subagentToolCalls += step.tool_calls.length;
      } else {
        subRaw.primaryToolCalls += step.tool_calls.length;
      }

      for (let callIdx = 0; callIdx < step.tool_calls.length; callIdx++) {
        const call = step.tool_calls[callIdx];
        const name = call?.name || "";
        const args = getCallArgs(call);
        const desc = describeToolCall(call);
        callBareTools.push(desc.bareTool);

        const callMeasure = estimateTextTokens(serializeToolCallPayload(call));
        compRaw.toolCalls.bytes += callMeasure.bytes;
        compRaw.toolCalls.estTokens += callMeasure.estTokens;
        const isDelegation = isSubagentDelegationCall(call);
        if (isDelegation) {
          subRaw.subagentDelegations += 1;
          if (!stepIsSubagent) {
            subRaw.subagentTrafficEstTokens += callMeasure.estTokens;
          }
        }
        if (stepIsSubagent) {
          subRaw.subagentResultBytes += callMeasure.bytes;
          subRaw.subagentResultEstTokens += callMeasure.estTokens;
          subRaw.subagentTrafficEstTokens += callMeasure.estTokens;
        }
        const callMeta = {
          bareTool: desc.bareTool,
          tool: desc.tool,
          isDelegation,
          consumed: false
        };
        pendingToolCalls.push(callMeta);
        const callId = call?.id ?? call?.tool_call_id ?? call?.call_id ?? null;
        const callIdKey = callId !== null && callId !== undefined && String(callId).trim() !== "" ? String(callId) : null;
        if (callIdKey) {
          pendingCallsById.set(callIdKey, callMeta);
          bareToolByCallId.set(callIdKey, desc.bareTool);
        }
        const matchedResult = (callIdKey && resultByCallId.get(callIdKey)) || followingResults[callIdx];
        const callFailed = matchedResult ? isStepFailureResult(matchedResult, desc.bareTool) : false;
        const resultBytes =
          matchedResult && typeof matchedResult.content === "string"
            ? Buffer.byteLength(matchedResult.content, "utf8")
            : 0;

        if (desc.bareTool !== "finish") {
          currTurnTools.push({
            tool: desc.tool,
            target: desc.target,
            label: desc.label,
            resultBytes
          });
        }

        const edited = extractCallEditPaths(call);
        const isCheckCall = isCheckOrVerifyCall(call);
        for (const ep of edited) turnEditedFiles.push(ep);
        if (edited.length > 0 && !callFailed) editEpoch += 1;
        if (isCheckCall) turnRanCheck = true;

        if (!IGNORED_LOOP_TOOLS.has(desc.bareTool)) {
          let effectiveFp = desc.fingerprint;
          // Passing verification after a fresh edit is healthy TDD progress, not a doom loop
          if (
            isCheckCall &&
            Boolean(matchedResult) &&
            !callFailed &&
            editEpoch > 0 &&
            editEpoch > (lastPassCheckEpoch.get(desc.fingerprint) ?? 0)
          ) {
            lastPassCheckEpoch.set(desc.fingerprint, editEpoch);
            effectiveFp = `${desc.fingerprint}#pass_e${editEpoch}`;
          }
          recentCallWindow.push({ fingerprint: effectiveFp, label: desc.label });
          if (recentCallWindow.length > LOOP_WINDOW_SIZE) {
            recentCallWindow.shift();
          }
        }

        if ((name === "read_file" || name === "view_file") && args) {
          const p = normPath(args.Path ?? args.path ?? args.filePath ?? args.AbsolutePath ?? args.absolutePath);
          const sLine = args.StartLine ?? args.startLine ?? args.start_line ?? 1;
          const eLine = args.EndLine ?? args.endLine ?? args.end_line ?? "eof";
          if (p) {
            const sig = `${p}:${sLine}:${eLine}`;
            if (seenReadSignatures.has(sig)) {
              duplicateReadCount += 1;
            } else {
              seenReadSignatures.add(sig);
            }
          }
        } else if (
          (name === "edit_file" ||
            name === "write_file" ||
            name === "write_to_file" ||
            name === "replace_file_content" ||
            name === "multi_replace_file_content") &&
          args
        ) {
          invalidatePath(
            normPath(args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.filePath ?? args.AbsolutePath)
          );
        } else if ((name === "apply_edits" || /(?:^|_)apply_edits$/.test(name)) && args && !args.dryRun && Array.isArray(args.edits)) {
          const baseCwd = args.cwd || "";
          for (const e of args.edits) {
            if (e && e.path) invalidatePath(normPath(e.path, baseCwd));
          }
        } else if (name === "call_mcp_tool" && args) {
          const mcpTool = String(args.ToolName ?? args.toolName ?? "").trim();
          let mcpArgs = args.Arguments ?? args.arguments;
          if (typeof mcpArgs === "string") {
            try {
              mcpArgs = JSON.parse(mcpArgs);
            } catch {
              mcpArgs = null;
            }
          }
          if (mcpTool === "apply_edits" && mcpArgs && !mcpArgs.dryRun && Array.isArray(mcpArgs.edits)) {
            const baseCwd = mcpArgs.cwd || "";
            for (const e of mcpArgs.edits) {
              if (e && e.path) invalidatePath(normPath(e.path, baseCwd));
            }
          } else if (mcpTool === "ctx_resume") {
            seenReadSignatures.clear();
          }
        } else if (name === "ctx_resume" || /(?:^|_)ctx_resume$/.test(name)) {
          seenReadSignatures.clear();
        }
      }
    }

    // Update edit<->fail oscillation state from this turn's calls + following result steps
    const turnFailed = followingResults.some((r, rIdx) => {
      const rid = r?.tool_call_id ?? r?.call_id ?? r?.toolCallId ?? null;
      const bareTool =
        (rid !== null && rid !== undefined && bareToolByCallId.get(String(rid))) || callBareTools[rIdx] || "";
      return isStepFailureResult(r, bareTool);
    });
    if (turnEditedFiles.length > 0 && turnFailed) {
      editFailOscillations += 1;
      for (const f of turnEditedFiles) {
        const shortF = shortTargetLabel(f, 36);
        oscillatingFilesCount.set(shortF, (oscillatingFilesCount.get(shortF) || 0) + 1);
      }
      // Clear pending edits since this edit's failure has already been counted as an oscillation
      pendingEditFiles.clear();
    } else if (turnEditedFiles.length > 0 && turnRanCheck && !turnFailed && followingResults.length > 0) {
      // Edit + inline verify succeeded -> converged!
      editFailOscillations = 0;
      pendingEditFiles.clear();
      oscillatingFilesCount.clear();
    } else if (turnEditedFiles.length > 0) {
      for (const f of turnEditedFiles) pendingEditFiles.add(f);
    } else if (turnRanCheck && turnFailed) {
      if (pendingEditFiles.size > 0) {
        editFailOscillations += 1;
        for (const f of pendingEditFiles) {
          const shortF = shortTargetLabel(f, 36);
          oscillatingFilesCount.set(shortF, (oscillatingFilesCount.get(shortF) || 0) + 1);
        }
        pendingEditFiles.clear();
      }
    } else if (turnRanCheck && !turnFailed && followingResults.length > 0) {
      // Verification succeeded -> clear active oscillation streak
      editFailOscillations = 0;
      pendingEditFiles.clear();
      oscillatingFilesCount.clear();
    }

    const turnUsage = extractStepTokenUsage(step);
    const safeIn = turnUsage.inputTokens;
    const safeCache = turnUsage.cacheReadTokens;
    const safeCacheCreate = turnUsage.cacheCreationTokens;
    const safeCacheCreate1h = turnUsage.cacheCreation1hTokens;
    const safeOut = turnUsage.outputTokens;
    const safeThinking = turnUsage.thinkingTokens;
    const ctxTok = turnUsage.contextTokens;
    const tMs = parseTimeMs(step.created_at);
    const model = typeof step.model === "string" ? step.model : "";

    if (safeOut > 0) outputTokensTotal += safeOut;
    if (safeThinking > 0) thinkingTokensTotal += safeThinking;

    // Context composition for thinking & assistant visible output (no double-counting thinking vs thinking_tokens)
    const thinkingText = extractStepText(step.thinking ?? step.reasoning_content ?? step.reasoning);
    const thinkingMeasure = estimateTextTokens(thinkingText);
    const turnThinkingBytes = thinkingMeasure.bytes;
    const turnThinkingEstTokens = safeThinking > 0 ? safeThinking : thinkingMeasure.estTokens;
    compRaw.thinking.bytes += turnThinkingBytes;
    compRaw.thinking.estTokens += turnThinkingEstTokens;

    const assistantMeasure = estimateTextTokens(extractStepText(step.content));
    compRaw.assistant.bytes += assistantMeasure.bytes;
    compRaw.assistant.estTokens += assistantMeasure.estTokens;

    if (stepIsSubagent) {
      subRaw.subagentResultBytes += turnThinkingBytes + assistantMeasure.bytes;
      subRaw.subagentResultEstTokens += turnThinkingEstTokens + assistantMeasure.estTokens;
      subRaw.subagentTrafficEstTokens += turnThinkingEstTokens + assistantMeasure.estTokens;
    }

    if (ctxTok > 0) {
      turnsWithUsage += 1;
      cachedTokensTotal += safeCache;
      uncachedInputTokensTotal += safeIn;
      cacheCreationTokensTotal += safeCacheCreate;
      cacheCreation1hTokensTotal += safeCacheCreate1h;
      currentContextTokens = ctxTok;
      if (ctxTok > peakContextTokens) peakContextTokens = ctxTok;
      if (model) currentModel = model;
      if (tMs !== null) lastPlannerMs = tMs;

      const activeTurnProfile = resolveModelProfile(model || prevModel || currentModel);
      if (safeCacheCreate1h > 0) {
        seen1hWriteByProfile.set(activeTurnProfile.id, true);
      }

      if (totalMediaCount > 0 && ctxTok >= 150000) {
        multimodalHighCtxTurns += 1;
      }

      const turnHitRate = Number((safeCache / ctxTok).toFixed(4));
      if (ctxTok >= MIN_CACHEABLE_CONTEXT_TOKENS) {
        hitRateSum += safeCache / ctxTok;
        hitRateCount += 1;
      }

      const deltaTokens = hasSeenPlanner ? ctxTok - prevCtxTokens : 0;
      let dominantTrigger = null;
      if (prevTurnTools.length > 0) {
        dominantTrigger = prevTurnTools[0];
        for (const item of prevTurnTools) {
          if (item.resultBytes > dominantTrigger.resultBytes) {
            dominantTrigger = item;
          }
        }
        if (deltaTokens > 0) {
          deltaAttributions.push({
            stepIndex: step.step_index ?? i,
            turn: turnsWithUsage,
            deltaTokens,
            ctxTokens: ctxTok,
            tool: dominantTrigger.tool,
            target: dominantTrigger.target,
            label: dominantTrigger.label
          });
        }
      }

      let turnWasBust = false;
      let turnBustCause = null;

      // Check for cache bust relative to previous warm turn's prefix size
      if (hasSeenPlanner && prevCtxTokens >= MIN_CACHEABLE_CONTEXT_TOKENS) {
        warmTurns += 1;
        const retainedRatio = prevCtxTokens > 0 ? safeCache / prevCtxTokens : 1;
        const isBust = retainedRatio < BUST_DROP_RATIO || (prevCtxTokens >= 10000 && safeCache === 0);
        const gapSec =
          tMs !== null && prevPlannerMs !== null && tMs >= prevPlannerMs
            ? Math.round((tMs - prevPlannerMs) / 1000)
            : null;
        const sameModel = !prevModel || !model || prevModel === model;

        if (!isBust) {
          if (retainedRatio >= BUST_DROP_RATIO && safeCache > 0 && gapSec !== null && sameModel) {
            if (maxWarmHitGapSec === null || gapSec > maxWarmHitGapSec) {
              maxWarmHitGapSec = gapSec;
            }
            const prevProfileMax = maxWarmGapByProfile.get(activeTurnProfile.id);
            if (prevProfileMax === undefined || gapSec > prevProfileMax) {
              maxWarmGapByProfile.set(activeTurnProfile.id, gapSec);
            }
          }
        } else {
          turnWasBust = true;
          const calibratedTurnTtl =
            explicitTtlSec === null
              ? calibrateEmpiricalTtl(
                  activeTurnProfile,
                  maxWarmGapByProfile.get(activeTurnProfile.id) ?? null,
                  Boolean(seen1hWriteByProfile.get(activeTurnProfile.id))
                )
              : null;
          const turnTtlSec = explicitTtlSec ?? calibratedTurnTtl ?? activeTurnProfile.ttlSec;

          let cause = "prefix_drift";
          if (prevModel && model && model !== prevModel) {
            cause = "model_switch";
          } else if (ctxTok < prevCtxTokens * BUST_DROP_RATIO) {
            cause = "compaction_or_truncation";
            // Reset seen read signatures after compaction
            seenReadSignatures.clear();
          } else if (gapSec !== null && gapSec >= turnTtlSec) {
            cause = "ttl_idle_expiry";
          } else if (mediaLoadedSincePrev) {
            cause = "multimodal_media";
          } else if (systemMsgSincePrev) {
            cause = "system_injection";
          }

          turnBustCause = cause;
          const expectedReusable = Math.min(prevCtxTokens, ctxTok);
          const wastedTokens = Math.max(0, expectedReusable - safeCache);
          bustsByCause[cause] += 1;
          wastedTokensTotal += wastedTokens;
          wastedRewrittenTokens += Math.min(wastedTokens, safeCacheCreate);

          recentBusts.push({
            stepIndex: step.step_index ?? i,
            hasExplicitStepIndex: step.step_index !== undefined && step.step_index !== null,
            at: step.created_at || null,
            cause,
            prevCtxTokens,
            currCtxTokens: ctxTok,
            cacheReadTokens: safeCache,
            wastedTokens,
            gapSec,
            model: model || prevModel || null
          });
        }
      }

      allTurns.push({
        turn: turnsWithUsage,
        stepIndex: step.step_index ?? i,
        at: step.created_at || null,
        ctxTokens: ctxTok,
        cacheReadTokens: safeCache,
        cacheCreationTokens: safeCacheCreate,
        uncachedTokens: safeIn,
        thinkingTokens: safeThinking,
        hitRate: turnHitRate,
        deltaTokens,
        isBust: turnWasBust,
        bustCause: turnBustCause,
        triggerTool: dominantTrigger ? dominantTrigger.label : null
      });

      prevCtxTokens = ctxTok;
      if (model) prevModel = model;
      if (tMs !== null) prevPlannerMs = tMs;
      hasSeenPlanner = true;
      mediaLoadedSincePrev = false;
      systemMsgSincePrev = false;
    } else if (tMs !== null) {
      lastPlannerMs = tMs;
      if (!hasSeenPlanner) hasSeenPlanner = true;
    }

    prevTurnTools = currTurnTools;
  }

  // Resolve model-aware profile, per-conversation maxTokenLimit, empirical TTL, and API cost model
  const matchedProfile = resolveModelProfile(currentModel);
  let windowTokens;
  let windowSource;
  if (explicitWindowTokens !== null) {
    windowTokens = explicitWindowTokens;
    windowSource = "explicit";
  } else if (explicitMaxTokenLimit !== null) {
    windowTokens = explicitMaxTokenLimit;
    windowSource = "explicit";
  } else if (transcriptMaxTokenLimit !== null) {
    windowTokens = transcriptMaxTokenLimit;
    windowSource = "transcript";
  } else {
    windowTokens = matchedProfile.windowTokens;
    windowSource = "profile";
  }

  let ttlSec;
  let ttlSource;
  const activeProfileMaxWarmGap = maxWarmGapByProfile.get(matchedProfile.id) ?? null;
  const activeHas1hWrite = Boolean(seen1hWriteByProfile.get(matchedProfile.id));
  if (explicitTtlSec !== null) {
    ttlSec = explicitTtlSec;
    ttlSource = "explicit";
  } else {
    const calibratedTtl = calibrateEmpiricalTtl(matchedProfile, activeProfileMaxWarmGap, activeHas1hWrite);
    if (calibratedTtl !== null) {
      ttlSec = calibratedTtl;
      ttlSource = "empirical";
    } else {
      ttlSec = matchedProfile.ttlSec;
      ttlSource = "profile";
    }
  }

  const cacheDiscountRate = explicitDiscountRate ?? matchedProfile.cacheDiscountRate;
  const baseWriteMult = matchedProfile.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER;
  const longWriteMult = matchedProfile.cacheWrite1hMultiplier ?? baseWriteMult;
  let cacheWriteMultiplier;
  if (explicitWriteMultiplier !== null) {
    cacheWriteMultiplier = explicitWriteMultiplier;
  } else if (cacheCreation1hTokensTotal > 0 && cacheCreationTokensTotal > 0) {
    const tokens1h = Math.min(cacheCreation1hTokensTotal, cacheCreationTokensTotal);
    const tokens5m = cacheCreationTokensTotal - tokens1h;
    cacheWriteMultiplier = Number(
      ((tokens5m * baseWriteMult + tokens1h * longWriteMult) / cacheCreationTokensTotal).toFixed(4)
    );
  } else if (ttlSec >= 3600) {
    cacheWriteMultiplier = longWriteMult;
  } else {
    cacheWriteMultiplier = baseWriteMult;
  }

  const inputPricePer1M = explicitInputPricePer1M ?? matchedProfile.inputPer1M ?? DEFAULT_INPUT_PRICE_PER_1M;
  const warnTokens = explicitWarnTokens ?? Math.round(windowTokens * WARN_WINDOW_RATIO);
  const criticalTokens = explicitCriticalTokens ?? Math.round(windowTokens * CRITICAL_WINDOW_RATIO);
  const coldCompactTokens = explicitColdCompactTokens ?? Math.round(windowTokens * COLD_COMPACT_WINDOW_RATIO);
  const delayHotMinTokens = explicitDelayHotTokens ?? Math.round(windowTokens * DELAY_HOT_WINDOW_RATIO);
  const contextUtilization = windowTokens > 0 ? Number((currentContextTokens / windowTokens).toFixed(4)) : 0;

  const modelProfile = {
    id: matchedProfile.id,
    windowTokens,
    windowSource,
    defaultTtlSec: matchedProfile.ttlSec,
    cacheDiscountRate,
    inputPer1M: inputPricePer1M,
    cacheWriteMultiplier: baseWriteMult,
    cacheWrite1hMultiplier: longWriteMult
  };

  const totalInputAll = cachedTokensTotal + uncachedInputTokensTotal + cacheCreationTokensTotal;
  const weightedHitRate = totalInputAll > 0 ? cachedTokensTotal / totalInputAll : 0;
  const avgTurnHitRate = hitRateCount > 0 ? hitRateSum / hitRateCount : 0;
  const bustCount = Object.values(bustsByCause).reduce((a, b) => a + b, 0);

  const idleSeconds =
    lastPlannerMs !== null ? Math.max(0, Math.round((nowMs - lastPlannerMs) / 1000)) : null;
  const ttlRemainingSec =
    idleSeconds !== null ? Math.max(0, ttlSec - idleSeconds) : null;

  let ttlStatus = "cold";
  if (currentContextTokens >= MIN_CACHEABLE_CONTEXT_TOKENS && idleSeconds !== null) {
    if (idleSeconds >= ttlSec) ttlStatus = "expired";
    else if (ttlRemainingSec <= 60) ttlStatus = "expiring";
    else ttlStatus = "warm";
  }

  let watermark = "ok";
  if (currentContextTokens >= criticalTokens) watermark = "critical";
  else if (currentContextTokens >= warnTokens) watermark = "warn";

  const { cacheTemperature, compactAdvice } = computeCacheWarmth({
    currentContextTokens,
    idleSeconds,
    ttlSec,
    weightedHitRate,
    criticalTokens,
    coldCompactTokens,
    delayHotMinTokens
  });
  const estimatedCostSavingsPct = estimateCostSavingsPct(
    cachedTokensTotal,
    uncachedInputTokensTotal,
    cacheDiscountRate,
    cacheCreationTokensTotal,
    cacheWriteMultiplier
  );

  const pricePerToken = inputPricePer1M / 1e6;
  const actualCostTokenEquiv =
    uncachedInputTokensTotal +
    (1 - cacheDiscountRate) * cachedTokensTotal +
    cacheWriteMultiplier * cacheCreationTokensTotal;
  const estimatedInputCostUsd = roundUsd(actualCostTokenEquiv * pricePerToken);
  const estimatedSavedUsd = roundUsd((totalInputAll - actualCostTokenEquiv) * pricePerToken);
  const uncachedWastedTokens = Math.max(0, wastedTokensTotal - wastedRewrittenTokens);
  const estimatedWastedUsd = roundUsd(
    (uncachedWastedTokens * cacheDiscountRate +
      wastedRewrittenTokens * (cacheWriteMultiplier - (1 - cacheDiscountRate))) *
      pricePerToken
  );

  // Evaluate doom-loop / oscillation watch from trailing tool window
  const windowSize = recentCallWindow.length;
  const fpCounts = new Map();
  const fpLabel = new Map();
  for (const item of recentCallWindow) {
    fpCounts.set(item.fingerprint, (fpCounts.get(item.fingerprint) || 0) + 1);
    if (!fpLabel.has(item.fingerprint)) fpLabel.set(item.fingerprint, item.label);
  }
  let maxRepeatCount = 0;
  let topRepeatedCall = null;
  for (const [fp, cnt] of fpCounts.entries()) {
    if (cnt > maxRepeatCount) {
      maxRepeatCount = cnt;
      topRepeatedCall = fpLabel.get(fp) || null;
    }
  }
  const repeatRate = windowSize > 0 ? Number(((windowSize - fpCounts.size) / windowSize).toFixed(4)) : 0;
  const repeatCritical = maxRepeatCount >= 4 || (windowSize >= 6 && repeatRate >= 0.5 && maxRepeatCount >= 3);
  const repeatWarn = !repeatCritical && maxRepeatCount >= 3;
  const oscCritical = editFailOscillations >= 3;
  const oscWarn = !oscCritical && editFailOscillations >= 2;
  const hasRepeat = repeatCritical || repeatWarn;
  const hasOsc = oscCritical || oscWarn;
  const loopStatus = repeatCritical || oscCritical ? "critical" : repeatWarn || oscWarn ? "warn" : "ok";
  const loopReason =
    hasRepeat && hasOsc
      ? "repeat_and_oscillation"
      : hasOsc
        ? "edit_fail_oscillation"
        : hasRepeat
          ? "repeat_loop"
          : null;
  const oscillatingFiles = Array.from(oscillatingFilesCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file]) => file);

  const loopWatch = {
    status: loopStatus,
    windowSize,
    repeatRate,
    maxRepeatCount,
    topRepeatedCall: maxRepeatCount >= 2 ? topRepeatedCall : null,
    editFailOscillations,
    oscillatingFiles,
    reason: loopReason
  };

  const recentTurns = allTurns.slice(-15);
  const topContextDeltas = deltaAttributions
    .sort((a, b) => b.deltaTokens - a.deltaTokens || a.stepIndex - b.stepIndex)
    .slice(0, 3);
  const contextComposition = finalizeContextComposition(compRaw);
  const subagentBreakdown = finalizeSubagentBreakdown(subRaw, contextComposition.totalEstTokens);

  return {
    turnsWithUsage,
    warmTurns,
    cacheableTurns: hitRateCount,
    cachedTokensTotal,
    uncachedInputTokensTotal,
    cacheCreationTokensTotal,
    outputTokensTotal,
    thinkingTokensTotal,
    weightedHitRate: Number(weightedHitRate.toFixed(4)),
    avgTurnHitRate: Number(avgTurnHitRate.toFixed(4)),
    currentContextTokens,
    peakContextTokens,
    watermark,
    warnTokens,
    criticalTokens,
    coldCompactTokens,
    delayHotMinTokens,
    contextUtilization,
    windowSource,
    modelProfile,
    cacheDiscountRate,
    cacheWriteMultiplier,
    inputPricePer1M,
    currentModel: currentModel || null,
    lastPlannerAt: lastPlannerMs ? new Date(lastPlannerMs).toISOString() : null,
    idleSeconds,
    cacheTtlSec: ttlSec,
    ttlSource,
    maxWarmHitGapSec,
    ttlRemainingSec,
    ttlStatus,
    cacheTemperature,
    compactAdvice,
    estimatedCostSavingsPct,
    estimatedInputCostUsd,
    estimatedSavedUsd,
    estimatedWastedUsd,
    bustCount,
    bustsByCause,
    wastedTokensTotal,
    totalMediaCount,
    multimodalHighCtxTurns,
    duplicateReadCount,
    loopWatch,
    contextComposition,
    subagentBreakdown,
    recentTurns,
    topContextDeltas,
    recentBusts: recentBusts.slice(-10)
  };
}

/** Aggregate KV-cache diagnostics across multiple transcript step arrays */
export function analyzeMultipleSessionsCache(sessions, options = {}) {
  const bustsByCause = {
    ttl_idle_expiry: 0,
    model_switch: 0,
    compaction_or_truncation: 0,
    system_injection: 0,
    multimodal_media: 0,
    prefix_drift: 0
  };
  let sessionCount = 0;
  let turnsWithUsage = 0;
  let warmTurns = 0;
  let cachedTokensTotal = 0;
  let uncachedInputTokensTotal = 0;
  let cacheCreationTokensTotal = 0;
  let outputTokensTotal = 0;
  let thinkingTokensTotal = 0;
  let wastedTokensTotal = 0;
  let estimatedInputCostUsdSum = 0;
  let estimatedSavedUsdSum = 0;
  let estimatedWastedUsdSum = 0;
  let peakContextTokens = 0;
  let duplicateReadCount = 0;
  let multimodalHighCtxTurns = 0;
  let hitRateWeightedSum = 0;
  let hitRateTurnWeight = 0;
  let discountWeightedSum = 0;
  let discountTokenWeight = 0;
  let writeMultWeightedByCreateSum = 0;
  let writeMultCreateWeight = 0;
  let writeMultWeightedByAllSum = 0;
  let writeMultAllWeight = 0;
  let loopAlertSessions = 0;
  let maxEditFailOscillations = 0;
  let maxWarmHitGapSec = null;
  let anyEmpiricalTtl = false;
  let anyTranscriptWindow = false;
  const allRecentBusts = [];
  const allRecentTurns = [];
  const allTopDeltas = [];
  const aggCompRaw = createRawCompositionBuckets();
  const aggSubRaw = createRawSubagentCounters();

  for (const steps of sessions || []) {
    if (!Array.isArray(steps) || steps.length === 0) continue;
    const res = analyzeTranscriptCache(steps, options);
    if (res.contextComposition) {
      for (const key of COMPOSITION_KEYS) {
        const b = res.contextComposition[key];
        if (!b) continue;
        aggCompRaw[key].bytes += b.bytes || 0;
        aggCompRaw[key].estTokens += b.estTokens || 0;
        if (key === "media") {
          aggCompRaw.media.mediaCount += b.mediaCount || 0;
        }
      }
    }
    if (res.subagentBreakdown) {
      aggSubRaw.primaryTurns += res.subagentBreakdown.primaryTurns || 0;
      aggSubRaw.subagentTurns += res.subagentBreakdown.subagentTurns || 0;
      aggSubRaw.primaryToolCalls += res.subagentBreakdown.primaryToolCalls || 0;
      aggSubRaw.subagentToolCalls += res.subagentBreakdown.subagentToolCalls || 0;
      aggSubRaw.subagentDelegations += res.subagentBreakdown.subagentDelegations || 0;
      aggSubRaw.subagentResultBytes += res.subagentBreakdown.subagentResultBytes || 0;
      aggSubRaw.subagentResultEstTokens += res.subagentBreakdown.subagentResultEstTokens || 0;
      aggSubRaw.subagentTrafficEstTokens +=
        res.subagentBreakdown.subagentTrafficEstTokens ?? res.subagentBreakdown.subagentResultEstTokens ?? 0;
    }
    if (res.turnsWithUsage === 0) continue;
    sessionCount += 1;
    turnsWithUsage += res.turnsWithUsage;
    warmTurns += res.warmTurns;
    cachedTokensTotal += res.cachedTokensTotal;
    uncachedInputTokensTotal += res.uncachedInputTokensTotal;
    cacheCreationTokensTotal += res.cacheCreationTokensTotal || 0;
    outputTokensTotal += res.outputTokensTotal;
    thinkingTokensTotal += res.thinkingTokensTotal || 0;
    wastedTokensTotal += res.wastedTokensTotal;
    estimatedInputCostUsdSum += res.estimatedInputCostUsd || 0;
    estimatedSavedUsdSum += res.estimatedSavedUsd || 0;
    estimatedWastedUsdSum += res.estimatedWastedUsd || 0;
    if (res.peakContextTokens > peakContextTokens) peakContextTokens = res.peakContextTokens;
    duplicateReadCount += res.duplicateReadCount;
    multimodalHighCtxTurns += res.multimodalHighCtxTurns;
    const hitWeight = Number.isFinite(res.cacheableTurns) ? res.cacheableTurns : res.turnsWithUsage;
    if (hitWeight > 0) {
      hitRateWeightedSum += res.avgTurnHitRate * hitWeight;
      hitRateTurnWeight += hitWeight;
    }
    const sessTokens =
      res.cachedTokensTotal + res.uncachedInputTokensTotal + (res.cacheCreationTokensTotal || 0);
    discountWeightedSum += (res.cacheDiscountRate ?? DEFAULT_CACHE_DISCOUNT_RATE) * sessTokens;
    discountTokenWeight += sessTokens;
    const sessWriteMult = res.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER;
    if ((res.cacheCreationTokensTotal || 0) > 0) {
      writeMultWeightedByCreateSum += sessWriteMult * res.cacheCreationTokensTotal;
      writeMultCreateWeight += res.cacheCreationTokensTotal;
    }
    writeMultWeightedByAllSum += sessWriteMult * sessTokens;
    writeMultAllWeight += sessTokens;
    if (res.ttlSource === "empirical") anyEmpiricalTtl = true;
    if (res.windowSource === "transcript") anyTranscriptWindow = true;
    if (res.maxWarmHitGapSec !== null && res.maxWarmHitGapSec !== undefined) {
      maxWarmHitGapSec =
        maxWarmHitGapSec === null ? res.maxWarmHitGapSec : Math.max(maxWarmHitGapSec, res.maxWarmHitGapSec);
    }
    if (res.loopWatch && res.loopWatch.status !== "ok") {
      loopAlertSessions += 1;
    }
    if ((res.loopWatch?.editFailOscillations || 0) > maxEditFailOscillations) {
      maxEditFailOscillations = res.loopWatch.editFailOscillations;
    }
    for (const k of Object.keys(bustsByCause)) {
      bustsByCause[k] += res.bustsByCause[k] || 0;
    }
    for (const b of res.recentBusts) {
      allRecentBusts.push({ item: b, ts: parseTimeMs(b?.at), ord: allRecentBusts.length });
    }
    for (const t of res.recentTurns || []) {
      allRecentTurns.push({ item: t, ts: parseTimeMs(t?.at), ord: allRecentTurns.length });
    }
    for (const d of res.topContextDeltas || []) {
      allTopDeltas.push(d);
    }
  }

  const sortChronologically = (entries) => {
    const hasAnyTs = entries.some((e) => e.ts !== null);
    if (!hasAnyTs) return entries.map((e) => e.item);
    return entries
      .slice()
      .sort((a, b) => {
        if (a.ts !== null && b.ts !== null && a.ts !== b.ts) return a.ts - b.ts;
        if (a.ts !== null && b.ts === null) return 1;
        if (a.ts === null && b.ts !== null) return -1;
        return a.ord - b.ord;
      })
      .map((e) => e.item);
  };

  const totalInputAll = cachedTokensTotal + uncachedInputTokensTotal + cacheCreationTokensTotal;
  const bustCount = Object.values(bustsByCause).reduce((a, b) => a + b, 0);
  const effectiveDiscountRate =
    discountTokenWeight > 0 ? Number((discountWeightedSum / discountTokenWeight).toFixed(4)) : DEFAULT_CACHE_DISCOUNT_RATE;
  const effectiveWriteMultiplier =
    writeMultCreateWeight > 0
      ? Number((writeMultWeightedByCreateSum / writeMultCreateWeight).toFixed(4))
      : writeMultAllWeight > 0
        ? Number((writeMultWeightedByAllSum / writeMultAllWeight).toFixed(4))
        : DEFAULT_CACHE_WRITE_MULTIPLIER;
  const estimatedCostSavingsPct = estimateCostSavingsPct(
    cachedTokensTotal,
    uncachedInputTokensTotal,
    effectiveDiscountRate,
    cacheCreationTokensTotal,
    effectiveWriteMultiplier
  );
  const hasExplicitWindow =
    (Number.isFinite(options.windowTokens) && options.windowTokens > 0) ||
    parsePositiveTokenLimit(options.maxTokenLimit) !== null;
  const hasExplicitTtl = Number.isFinite(options.ttlSec) && options.ttlSec > 0;
  const windowSource = hasExplicitWindow ? "explicit" : anyTranscriptWindow ? "transcript" : "profile";
  const ttlSource = hasExplicitTtl ? "explicit" : anyEmpiricalTtl ? "empirical" : "profile";
  const topContextDeltas = allTopDeltas
    .sort((a, b) => b.deltaTokens - a.deltaTokens || a.stepIndex - b.stepIndex)
    .slice(0, 3);
  const sortedTurns = sortChronologically(allRecentTurns);
  const sortedBusts = sortChronologically(allRecentBusts);
  const contextComposition = finalizeContextComposition(aggCompRaw);
  const subagentBreakdown = finalizeSubagentBreakdown(aggSubRaw, contextComposition.totalEstTokens);

  return {
    sessions: sessionCount,
    turnsWithUsage,
    warmTurns,
    cachedTokensTotal,
    uncachedInputTokensTotal,
    cacheCreationTokensTotal,
    outputTokensTotal,
    thinkingTokensTotal,
    weightedHitRate: totalInputAll > 0 ? Number((cachedTokensTotal / totalInputAll).toFixed(4)) : 0,
    avgTurnHitRate: hitRateTurnWeight > 0 ? Number((hitRateWeightedSum / hitRateTurnWeight).toFixed(4)) : 0,
    cacheDiscountRate: effectiveDiscountRate,
    cacheWriteMultiplier: effectiveWriteMultiplier,
    estimatedCostSavingsPct,
    estimatedInputCostUsd: roundUsd(estimatedInputCostUsdSum),
    estimatedSavedUsd: roundUsd(estimatedSavedUsdSum),
    estimatedWastedUsd: roundUsd(estimatedWastedUsdSum),
    windowSource,
    ttlSource,
    maxWarmHitGapSec,
    peakContextTokens,
    bustCount,
    bustsByCause,
    wastedTokensTotal,
    multimodalHighCtxTurns,
    duplicateReadCount,
    loopAlertSessions,
    maxEditFailOscillations,
    contextComposition,
    subagentBreakdown,
    recentTurns: sortedTurns.slice(-15),
    topContextDeltas,
    recentBusts: sortedBusts.slice(-15)
  };
}

/**
 * Strictly validate a conversationId before joining it onto local brain root paths.
 * Blocks path traversal (`..`, `/`, `\`, drive letters, NUL bytes) and overly long inputs.
 */
export function isSafeConversationId(conversationId) {
  if (typeof conversationId !== "string") return false;
  const trimmed = conversationId.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return false;
  return /^[A-Za-z0-9._-]+$/.test(trimmed);
}

/**
 * Locate Antigravity transcript_full.jsonl / transcript.jsonl for a conversationId.
 * When exactOnly=false (default), falls back to the most recently modified local transcript
 * if conversationId is omitted, "all", "app", "default", or not found.
 */
export function findTranscriptForConversation(conversationId = null, optionsOrExtraRoots = {}) {
  const opts = Array.isArray(optionsOrExtraRoots)
    ? { extraRoots: optionsOrExtraRoots, exactOnly: false }
    : optionsOrExtraRoots || {};
  const extraRoots = Array.isArray(opts.extraRoots) ? opts.extraRoots : [];
  const exactOnly = Boolean(opts.exactOnly);

  const home = os.homedir();
  const roots = [
    ...extraRoots,
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain")
  ];

  const isSpecific =
    conversationId &&
    conversationId !== "default" &&
    conversationId !== "all" &&
    conversationId !== "lifetime" &&
    conversationId !== "app";

  if (isSpecific) {
    if (!isSafeConversationId(conversationId)) {
      return null;
    }
    const safeId = conversationId.trim();
    for (const root of roots) {
      if (!root || typeof root !== "string") continue;
      const resolvedRoot = path.resolve(root);
      let realRoot = null;
      const candidates = [
        path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript_full.jsonl"),
        path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript.jsonl"),
        path.join(resolvedRoot, safeId, ".system_generated", "transcript_full.jsonl"),
        path.join(resolvedRoot, safeId, ".system_generated", "transcript.jsonl"),
        path.join(resolvedRoot, safeId, "transcript_full.jsonl"),
        path.join(resolvedRoot, safeId, "transcript.jsonl")
      ];
      for (const c of candidates) {
        const resolvedCand = path.resolve(c);
        const rel = path.relative(
          process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot,
          process.platform === "win32" ? resolvedCand.toLowerCase() : resolvedCand
        );
        if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) continue;
        if (!fs.existsSync(resolvedCand)) continue;
        try {
          if (realRoot === null) realRoot = fs.realpathSync(resolvedRoot);
          const realCand = fs.realpathSync(resolvedCand);
          const realRel = path.relative(
            process.platform === "win32" ? realRoot.toLowerCase() : realRoot,
            process.platform === "win32" ? realCand.toLowerCase() : realCand
          );
          if (realRel && realRel !== ".." && !realRel.startsWith(`..${path.sep}`) && !realRel.startsWith("../") && !path.isAbsolute(realRel) && fs.statSync(realCand).isFile()) {
            return realCand;
          }
        } catch {
          // Reject unreadable or escaping symlink targets
        }
      }
    }
  }

  if (exactOnly) return null;

  // Fallback: pick most recently modified transcript across brain roots (bounded scan)
  let bestPath = null;
  let bestMtime = 0;
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const base = path.join(root, entry.name);
      const candidates = [
        path.join(base, ".system_generated", "logs", "transcript_full.jsonl"),
        path.join(base, ".system_generated", "logs", "transcript.jsonl"),
        path.join(base, ".system_generated", "transcript_full.jsonl"),
        path.join(base, ".system_generated", "transcript.jsonl")
      ];
      for (const c of candidates) {
        try {
          const st = fs.statSync(c);
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            bestPath = c;
          }
          break;
        } catch {
          // try next
        }
      }
    }
  }
  return bestPath;
}

/** Render a pure 7-bit ASCII hit-rate trend strip for the most recent turns */
export function renderHitRateAsciiTrend(recentTurns = []) {
  if (!Array.isArray(recentTurns) || recentTurns.length === 0) {
    return null;
  }
  const chars = [];
  let minRate = 1;
  let bustCount = 0;
  for (const t of recentTurns) {
    const rate = Math.max(0, Math.min(1, Number(t?.hitRate || 0)));
    if (rate < minRate) minRate = rate;
    if (t?.isBust) {
      bustCount += 1;
      chars.push("!");
    } else if (rate >= 0.90) {
      chars.push("#");
    } else if (rate >= 0.75) {
      chars.push("*");
    } else if (rate >= 0.50) {
      chars.push("=");
    } else if (rate >= 0.20) {
      chars.push("-");
    } else {
      chars.push(".");
    }
  }
  const lastRate = Math.max(0, Math.min(1, Number(recentTurns[recentTurns.length - 1]?.hitRate || 0)));
  const strip = `[${chars.join("")}]`;
  return {
    strip,
    line: `Trend (last ${recentTurns.length} turns): ${strip} (last: ${(lastRate * 100).toFixed(1)}%, min: ${(minRate * 100).toFixed(1)}%, busts: ${bustCount})`,
    legend: "Legend: # >=90% | * 75-89% | = 50-74% | - 20-49% | . <20% | ! cache bust"
  };
}

function formatUsdReport(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Render a concise Markdown table + ASCII trend strip + Top-3 context growth attribution */
export function formatCacheDiagMarkdown(diag) {
  const pct = (r) => `${(Number(r || 0) * 100).toFixed(1)}%`;
  const discountRate =
    Number.isFinite(diag.cacheDiscountRate) && diag.cacheDiscountRate > 0 && diag.cacheDiscountRate <= 1
      ? diag.cacheDiscountRate
      : DEFAULT_CACHE_DISCOUNT_RATE;
  const discountPct = Math.round(discountRate * 100);
  const writeMult =
    Number.isFinite(diag.cacheWriteMultiplier) && diag.cacheWriteMultiplier >= 1
      ? diag.cacheWriteMultiplier
      : DEFAULT_CACHE_WRITE_MULTIPLIER;
  const savingsPct =
    diag.estimatedCostSavingsPct !== undefined
      ? Number(diag.estimatedCostSavingsPct || 0)
      : estimateCostSavingsPct(
          diag.cachedTokensTotal || 0,
          diag.uncachedInputTokensTotal || 0,
          discountRate,
          diag.cacheCreationTokensTotal || 0,
          writeMult
        );
  const savingsDetail =
    diag.estimatedSavedUsd !== undefined
      ? `${savingsPct.toFixed(1)}% (${formatUsdReport(diag.estimatedSavedUsd)} ${diag.estimatedSavedUsd >= 0 ? "saved" : "net"})`
      : `${savingsPct.toFixed(1)}%`;
  const c = diag.bustsByCause || {};
  const lines = [
    "# agy-dart Prompt Cache (KV-Cache) Attribution Report",
    "",
    "| Metric | Value |",
    "| :--- | ---: |",
    `| Sessions analyzed | ${diag.sessions ?? 1} |`,
    `| Turns with token usage | ${diag.turnsWithUsage} (warm: ${diag.warmTurns}) |`,
    `| Weighted Prompt Cache hit rate | ${pct(diag.weightedHitRate)} |`,
    `| Average turn hit rate | ${pct(diag.avgTurnHitRate)} |`,
    `| Est. input cost savings (at ${discountPct}% cache discount) | ${savingsDetail} |`,
    `| Peak context size (tokens) | ${(diag.peakContextTokens || 0).toLocaleString("en-US")} |`
  ];
  if (diag.estimatedInputCostUsd !== undefined) {
    lines.push(
      `| Est. API-equivalent input cost | ${formatUsdReport(diag.estimatedInputCostUsd)} (wasted: ${formatUsdReport(diag.estimatedWastedUsd || 0)}) |`
    );
  }
  if ((diag.cacheCreationTokensTotal || 0) > 0) {
    lines.push(
      `| Cache write (creation) tokens | ${diag.cacheCreationTokensTotal.toLocaleString("en-US")} (${writeMult.toFixed(2)}x write) |`
    );
  }
  if ((diag.thinkingTokensTotal || 0) > 0) {
    lines.push(
      `| Thinking / reasoning tokens | ${diag.thinkingTokensTotal.toLocaleString("en-US")} |`
    );
  }
  if (diag.modelProfile?.id) {
    const winSrc = diag.windowSource || diag.modelProfile.windowSource;
    const ttlSrc = diag.ttlSource;
    const winTag = winSrc ? `, ${winSrc}` : "";
    const ttlTag = ttlSrc ? ` [${ttlSrc}]` : "";
    lines.push(
      `| Model profile / window | ${diag.modelProfile.id} (${Math.round(diag.modelProfile.windowTokens / 1000)}k${winTag}, TTL ${diag.cacheTtlSec ?? diag.modelProfile.defaultTtlSec}s${ttlTag}) |`
    );
  } else if (diag.windowSource || diag.ttlSource) {
    const srcParts = [];
    if (diag.windowSource) srcParts.push(`window: ${diag.windowSource}`);
    if (diag.ttlSource) {
      const gapPart = diag.maxWarmHitGapSec ? `, max warm gap ${diag.maxWarmHitGapSec}s` : "";
      srcParts.push(`TTL: ${diag.ttlSource}${gapPart}`);
    }
    lines.push(`| Calibration sources | ${srcParts.join(" / ")} |`);
  }
  const wastedTokensStr =
    diag.estimatedWastedUsd > 0
      ? `${(diag.wastedTokensTotal || 0).toLocaleString("en-US")} (~${formatUsdReport(diag.estimatedWastedUsd)})`
      : `${(diag.wastedTokensTotal || 0).toLocaleString("en-US")}`;
  lines.push(
    `| Total cache busts detected | ${diag.bustCount} |`,
    `| Wasted re-prefill tokens | ${wastedTokensStr} |`,
    `| Bust cause: Idle TTL expiry | ${c.ttl_idle_expiry || 0} |`,
    `| Bust cause: Compaction / truncation | ${c.compaction_or_truncation || 0} |`,
    `| Bust cause: Model switch | ${c.model_switch || 0} |`,
    `| Bust cause: System injection | ${c.system_injection || 0} |`,
    `| Bust cause: Multimodal media | ${c.multimodal_media || 0} |`,
    `| Bust cause: Prefix drift / eviction | ${c.prefix_drift || 0} |`,
    `| Duplicate identical read_file calls | ${diag.duplicateReadCount || 0} |`
  );
  if (diag.loopWatch && diag.loopWatch.status !== "ok") {
    lines.push(
      `| Convergence watch | ${diag.loopWatch.status.toUpperCase()} (${diag.loopWatch.reason}, osc=${diag.loopWatch.editFailOscillations}, maxRepeat=${diag.loopWatch.maxRepeatCount}) |`
    );
  } else if (diag.loopAlertSessions > 0) {
    lines.push(
      `| Sessions with loop/oscillation alerts | ${diag.loopAlertSessions} (max edit<->fail cycles: ${diag.maxEditFailOscillations || 0}) |`
    );
  }

  const trend = renderHitRateAsciiTrend(diag.recentTurns);
  if (trend) {
    lines.push("", "### Recent Turns Hit-Rate Trend (ASCII)", "", `\`${trend.line}\``, trend.legend);
  }

  if (Array.isArray(diag.topContextDeltas) && diag.topContextDeltas.length > 0) {
    lines.push(
      "",
      "### Top-3 Context Growth Steps (Tool Attribution)",
      "",
      "| Rank | Turn | Delta Tokens | Context | Tool Call |",
      "| ---: | ---: | ---: | ---: | :--- |"
    );
    diag.topContextDeltas.forEach((d, idx) => {
      const safeLabel = String(d.label || d.tool || "unknown").replace(/\|/g, "\\|");
      lines.push(
        `| ${idx + 1} | #${d.turn} | +${(d.deltaTokens || 0).toLocaleString("en-US")} | ${(d.ctxTokens || 0).toLocaleString("en-US")} | \`${safeLabel}\` |`
      );
    });
  }

  const comp = diag.contextComposition;
  if (comp && Number(comp.totalEstTokens || 0) > 0) {
    const activeRows = COMPOSITION_KEYS.map((key) => ({
      key,
      label: COMPOSITION_LABELS[key] || key,
      bucket: comp[key] || { bytes: 0, estTokens: 0, pct: 0 }
    }))
      .filter((item) => (item.bucket.estTokens || 0) > 0 || (item.bucket.bytes || 0) > 0)
      .sort((a, b) => (b.bucket.estTokens || 0) - (a.bucket.estTokens || 0));

    lines.push(
      "",
      "### Context Composition",
      "",
      "| Category | Est. Tokens | Share | Bytes |",
      "| :--- | ---: | ---: | ---: |"
    );
    for (const row of activeRows) {
      const mCnt = row.bucket.mediaCount || comp.mediaCount || 0;
      const mediaSuffix =
        row.key === "media" && mCnt > 0
          ? ` (${mCnt} ${mCnt === 1 ? "item" : "items"})`
          : "";
      lines.push(
        `| ${row.label}${mediaSuffix} | ${(row.bucket.estTokens || 0).toLocaleString("en-US")} | ${Number(row.bucket.pct || 0).toFixed(1)}% | ${(row.bucket.bytes || 0).toLocaleString("en-US")} |`
      );
    }
    const domLabel = comp.dominantCategory ? COMPOSITION_LABELS[comp.dominantCategory] || comp.dominantCategory : null;
    lines.push(
      `| **Total**${domLabel ? ` (dominant: ${domLabel})` : ""} | **${(comp.totalEstTokens || 0).toLocaleString("en-US")}** | **100.0%** | **${(comp.totalBytes || 0).toLocaleString("en-US")}** |`
    );
  }

  const sub = diag.subagentBreakdown;
  const subTrafficTok = sub ? (sub.subagentTrafficEstTokens ?? sub.subagentResultEstTokens ?? 0) : 0;
  if (
    sub &&
    ((sub.subagentDelegations || 0) > 0 ||
      (sub.subagentTurns || 0) > 0 ||
      subTrafficTok > 0)
  ) {
    lines.push(
      "",
      `**Subagent Attribution:** ${sub.subagentDelegations || 0} delegation(s) | Turns: ${sub.primaryTurns || 0} primary / ${sub.subagentTurns || 0} subagent | Tool calls: ${sub.primaryToolCalls || 0} primary / ${sub.subagentToolCalls || 0} subagent | Subagent traffic: ~${subTrafficTok.toLocaleString("en-US")} est. tokens (${Number(sub.subagentSharePct || 0).toFixed(1)}% of context)`
    );
  }

  return lines.join("\n");
}
