/**
 * Ultra-lightweight (<1ms ESM load) Watchdog Lease writer/reader shared by
 * lifecycle hooks (PreInvocation / PreToolUse / PostToolUse / Stop) and
 * the Sidecar Watchdog engine (`context/lib/watchdog.js`).
 *
 * Deliberately keeps top-level imports restricted to tiny Node built-ins and
 * `./security.js` (`node:sqlite` is loaded lazily only when `lookupConversationSummary`
 * opens an existing `conversation_summaries.db`) so hooks never pay heavy parse costs.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./security.js";
import { truncateUtf8Safe } from "./stable-json.js";
export { truncateUtf8Safe };

export const WATCHDOG_LEASE_PREFIX = "watchdog_lease:";
export const WATCHDOG_PHASES = Object.freeze({
  IDLE: "IDLE",
  LLM_INFLIGHT: "LLM_INFLIGHT",
  TOOL_RUNNING: "TOOL_RUNNING",
  SUBAGENT_BG: "SUBAGENT_BG"
});

const RESERVED_CONV_IDS = new Set(["default", "all", "lifetime", "app"]);
const SLASH_COMPACT_RE = /^\s*\/compact(?:\s|$)/i;
export const TTL_KEEPALIVE_PROMPT_RE = /\[agy-dart TTL(?:保活| Keepalive)(?:\s|\])/i;
export const HEADLESS_FINISH_PROMPT_RE =
  /\bWhen you are done,\s*call the finish tool with your result\./i;
export const SUBAGENT_ROLE_RE =
  /(?:^|[-_\s/])(?:sub[-_]?agent|worker|monitor|swarm|research(?:er)?|verifier|review(?:er)?|explor(?:er|e)|audit(?:or)?|investigat(?:or)?|browser|image[-_]?generator)(?:$|[-_\s/])|^(?:DeepCoder|DeepInvestigator)[A-Za-z0-9_-]*$/i;
const PRIMARY_HOST_AGENT_NAME_RE = /^(?:antigravity|main|default|primary|chat|user|assistant|cascade|coordinator)$/i;
const SUBAGENT_GENESIS_SYS_MSG_RE =
  /\[Message\]\s+timestamp=\S+\s+sender=[0-9a-f-]{8,}|<original_task>|<subagent_reminder>|\brunning as a subagent,\s*invoked by a caller agent\b|<swarm_(?:brief|board|assignment)>|\[Swarm\s+(?:Brief|Assignment|Worker)\b|\bYou are a swarm worker\b|\bswarm_monitor\s+SKILL\.md\b/i;
export const SUBAGENT_TOOL_RE =
  /^(?:subagent|task|agent|delegate|call_subagent|invoke_subagent|run_workflow|schedule|manage_task|send_message|browser_subagent|spawn_subagent|run_subagent)$/i;
export const LONG_MCP_TOOL_RE = /^(?:ctx_execute|ctx_batch|run_checks)$/i;
export const SLOW_GEN_TOOL_RE = /^(?:generate_image|image_generator)$/i;
const LOW_OR_MEDIUM_EFFORT_RE = /(?:^|[-_/\s(])(?:low|medium|med|minimal)(?:$|[-_/\s)])/i;
const HIGH_REASONING_MODEL_RE =
  /(?:^|[-_/\s(])(?:high|xhigh)(?:$|[-_/\s)])|thinking|(?:^|[-_/\s(])o[134](?:$|[-_/\s.)])|deepseek[-_/\s]?r1|(?:^|[-_/\s(])opus(?:$|[-_/\s).\d])|gemini[-_/\s]?4(?:[-_/\s.])?(?:carbon|neon)(?:$|[-_/\s.\d])|orchestrator[-_/\s._]*neon/i;
export const KNOWN_MCP_TOOL_RE =
  /^(?:ctx_execute|ctx_batch|ctx_index|ctx_search|ctx_resume|ctx_stats|ctx_doctor|ctx_purge|batch_search|apply_edits|read_slices|run_checks|list_resources|read_resource)$/i;
const HOST_NAMESPACE_RE = /^(?:default_api|builtin|host|antigravity|core|native)$/i;
const BG_RESPONSE_RE = /\b(?:running as a background task|background task with task id|scheduled|running in the background)\b/i;
const MAX_PENDING_SLOW_CALLS = 8;

export function isTtlKeepalivePrompt(rawText) {
  if (typeof rawText !== "string" || !rawText) return false;
  return TTL_KEEPALIVE_PROMPT_RE.test(rawText);
}

export function isHeadlessWorkerPrompt(rawText) {
  if (typeof rawText !== "string" || !rawText) return false;
  return HEADLESS_FINISH_PROMPT_RE.test(rawText);
}

export function isSummaryMetadataSubagent({
  conversationId = "",
  parentConversationId = "",
  rootConversationId = "",
  nestingDepth = 0,
  agentName = "",
  title = "",
  allowUntitledCustomAgent = true
} = {}) {
  const safeConv = sanitizeConversationId(conversationId);
  const safeParent = sanitizeConversationId(parentConversationId);
  if (safeParent && safeParent !== safeConv) return true;
  const safeRoot = sanitizeConversationId(rootConversationId);
  if (safeRoot && safeConv && safeRoot !== safeConv) return true;
  const depthNum = Number(nestingDepth);
  if (Number.isFinite(depthNum) && depthNum > 0) return true;
  const cleanAgent = typeof agentName === "string" ? agentName.trim() : "";
  if (!cleanAgent || PRIMARY_HOST_AGENT_NAME_RE.test(cleanAgent)) return false;
  if (cleanAgent.toLowerCase() === "self" || SUBAGENT_ROLE_RE.test(cleanAgent)) return true;
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle && allowUntitledCustomAgent !== false) return true;
  return false;
}

export function isTrajectoryMetadataSubagent(conversationId = "", metaEventOrObj = {}) {
  if (!metaEventOrObj || typeof metaEventOrObj !== "object" || Array.isArray(metaEventOrObj)) {
    return false;
  }
  const metaEvent = metaEventOrObj;
  const metaObj =
    metaEvent.metadata && typeof metaEvent.metadata === "object" && !Array.isArray(metaEvent.metadata)
      ? metaEvent.metadata
      : metaEvent;
  if (
    metaObj.subagent === true ||
    metaObj.isSubagent === true ||
    metaObj.is_subagent === true ||
    metaEvent.subagent === true ||
    metaEvent.isSubagent === true ||
    metaEvent.is_subagent === true
  ) {
    return true;
  }
  const subagentSpec =
    metaObj.subagentSpec ??
    metaObj.subagent_spec ??
    metaEvent.subagentSpec ??
    metaEvent.subagent_spec ??
    null;
  if (subagentSpec && typeof subagentSpec === "object" && !Array.isArray(subagentSpec) && Object.keys(subagentSpec).length > 0) {
    return true;
  }
  const isBattleFork = Boolean(
    metaObj.isBattleModeFork ||
      metaObj.is_battle_mode_fork ||
      metaObj.isBattleMode ||
      metaObj.is_battle_mode ||
      metaEvent.isBattleModeFork ||
      metaEvent.is_battle_mode_fork
  );
  const safeConv = sanitizeConversationId(conversationId);
  const safeRoot = sanitizeConversationId(
    metaObj.rootConversationId ||
      metaObj.root_conversation_id ||
      metaEvent.rootConversationId ||
      metaEvent.root_conversation_id ||
      ""
  );
  if (!isBattleFork && safeConv && safeRoot && safeRoot !== safeConv) {
    return true;
  }
  const staticCfg =
    metaObj.staticConfig && typeof metaObj.staticConfig === "object"
      ? metaObj.staticConfig
      : metaObj.static_config && typeof metaObj.static_config === "object"
        ? metaObj.static_config
        : null;
  const resolvedAgentName =
    (typeof subagentSpec?.name === "string" && subagentSpec.name) ||
    (typeof subagentSpec?.agentName === "string" && subagentSpec.agentName) ||
    (typeof subagentSpec?.agent_name === "string" && subagentSpec.agent_name) ||
    (typeof subagentSpec?.typeName === "string" && subagentSpec.typeName) ||
    (typeof subagentSpec?.type_name === "string" && subagentSpec.type_name) ||
    (typeof staticCfg?.name === "string" && staticCfg.name) ||
    (typeof staticCfg?.agentName === "string" && staticCfg.agentName) ||
    (typeof staticCfg?.agent_name === "string" && staticCfg.agent_name) ||
    metaObj.agentName ||
    metaObj.agent_name ||
    metaEvent.agentName ||
    metaEvent.agent_name ||
    "";
  const hasExplicitTitleField = Boolean(
    Object.prototype.hasOwnProperty.call(metaObj, "title") ||
      Object.prototype.hasOwnProperty.call(metaEvent, "title") ||
      (metaEvent.annotations && typeof metaEvent.annotations === "object")
  );
  const resolvedTitle =
    metaObj.title ||
    metaEvent.title ||
    metaEvent.annotations?.title ||
    "";
  return isSummaryMetadataSubagent({
    conversationId,
    parentConversationId:
      metaObj.parentConversationId ||
      metaObj.parent_conversation_id ||
      metaEvent.parentConversationId ||
      metaEvent.parent_conversation_id ||
      "",
    rootConversationId: isBattleFork ? "" : safeRoot,
    nestingDepth:
      metaObj.nestingDepth ??
      metaObj.nesting_depth ??
      metaEvent.nestingDepth ??
      metaEvent.nesting_depth ??
      0,
    agentName: resolvedAgentName,
    title: resolvedTitle,
    allowUntitledCustomAgent: hasExplicitTitleField
  });
}

function extractGenesisStepText(step) {
  if (!step || typeof step !== "object") return "";
  for (const key of ["user_input", "content", "text", "message"]) {
    const val = step[key];
    if (typeof val === "string" && val) return val;
    if (Array.isArray(val)) {
      const joined = val
        .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    } else if (val && typeof val === "object" && typeof val.text === "string" && val.text) {
      return val.text;
    }
  }
  return "";
}

export function classifyTranscriptGenesisSteps(steps = [], { isFromStart = false } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) return "unknown";
  for (const s of steps) {
    if (!s || typeof s !== "object" || isEmbeddedSubagentStepLite(s)) continue;
    const stType = String(s.type || "").toUpperCase();
    const stRole = String(s.role || "").toLowerCase();
    if (stType === "USER_INPUT" || stRole === "user" || typeof s.user_input === "string") {
      const uTxt = extractGenesisStepText(s);
      if (uTxt && isHeadlessWorkerPrompt(uTxt)) return "subagent";
    }
    for (const arr of [s.tool_calls, s.toolCalls, s.function_calls, s.functionCalls]) {
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        if (!c || typeof c !== "object") continue;
        const n = c.name || c.tool || c.function?.name || "";
        if (extractBareToolName(n) === "finish") return "subagent";
      }
    }
  }

  const startsAtZero = Boolean(isFromStart || steps[0]?.step_index === 0);
  if (!startsAtZero) return "unknown";

  let sawSysStep0 = false;
  let sawSubagentSysMsg = false;
  let sawRealUserInput = false;
  for (let i = 0; i < steps.length && i < 10; i++) {
    const o = steps[i];
    if (!o || typeof o !== "object" || isEmbeddedSubagentStepLite(o)) continue;
    const t = String(o.type || "").toUpperCase();
    const role = String(o.role || "").toLowerCase();
    if (t === "PLANNER_RESPONSE" || role === "assistant" || role === "model") {
      break;
    }
    const txt = extractGenesisStepText(o);
    if (txt && isHeadlessWorkerPrompt(txt)) return "subagent";
    if (t === "USER_INPUT" || role === "user") {
      sawRealUserInput = true;
      break;
    }
    if (t === "SYSTEM_MESSAGE") {
      if (o.step_index === 0 || (i === 0 && isFromStart && o.step_index === undefined)) {
        sawSysStep0 = true;
      }
      if (o.source === "SYSTEM" || (txt && SUBAGENT_GENESIS_SYS_MSG_RE.test(txt))) {
        sawSubagentSysMsg = true;
      }
    }
  }
  if (sawSysStep0 && sawSubagentSysMsg && !sawRealUserInput) return "subagent";
  if (sawRealUserInput) return "human";
  return "unknown";
}

export function detectSubagentFromTranscriptSteps(steps = [], options = {}) {
  return classifyTranscriptGenesisSteps(steps, options) === "subagent";
}

export function classifyTranscriptGenesisFile(transcriptPath, maxBytes = 262144) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return "unknown";
  let fd = null;
  try {
    const cleanPath = transcriptPath.trim();
    if (!fs.existsSync(cleanPath)) return "unknown";
    const cap = Math.min(524288, Math.max(8192, Math.floor(Number(maxBytes) || 262144)));
    fd = fs.openSync(cleanPath, "r");
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile() || fstat.size <= 0) return "unknown";
    const toRead = Math.min(cap, fstat.size);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    if (bytesRead <= 0) return "unknown";

    const headText = buf.subarray(0, bytesRead).toString("utf8");
    const rawLines = headText.split(/\r?\n/);
    const parsedSteps = [];
    let partialSubagentSysLine = false;
    let partialUserLine = false;

    for (let i = 0; i < rawLines.length && parsedSteps.length < 10; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") parsedSteps.push(obj);
      } catch {
        // Truncated oversized genesis line at buffer boundary
        if (/^\{\s*(?:"[^"]+"\s*:\s*[^,]+,\s*){0,6}"type"\s*:\s*"USER_INPUT"/.test(line)) {
          if (HEADLESS_FINISH_PROMPT_RE.test(line)) return "subagent";
          partialUserLine = true;
        } else if (
          /^\{\s*(?:"[^"]+"\s*:\s*[^,]+,\s*){0,6}"type"\s*:\s*"SYSTEM_MESSAGE"/.test(line) &&
          (/"source"\s*:\s*"SYSTEM"\b/.test(line) || SUBAGENT_GENESIS_SYS_MSG_RE.test(line))
        ) {
          partialSubagentSysLine = true;
        }
        break;
      }
    }

    const stepCls = classifyTranscriptGenesisSteps(parsedSteps, { isFromStart: true });
    if (stepCls === "subagent" || stepCls === "human") {
      return stepCls;
    }
    const hasPlannerOrUserInParsed = parsedSteps.some((s) => {
      const t = String(s?.type || "").toUpperCase();
      const r = String(s?.role || "").toLowerCase();
      return t === "USER_INPUT" || r === "user" || t === "PLANNER_RESPONSE" || r === "assistant" || r === "model";
    });
    if (partialUserLine && !hasPlannerOrUserInParsed) {
      return "human";
    }
    if (
      partialSubagentSysLine &&
      !partialUserLine &&
      !hasPlannerOrUserInParsed &&
      (parsedSteps.length === 0 || String(parsedSteps[0]?.type || "").toUpperCase() === "SYSTEM_MESSAGE")
    ) {
      return "subagent";
    }
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function detectSubagentFromTranscriptFile(transcriptPath, maxBytes = 262144) {
  return classifyTranscriptGenesisFile(transcriptPath, maxBytes) === "subagent";
}

function toLeaseNonNegNum(val) {
  if (val === undefined || val === null || val === "" || typeof val === "boolean") return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function firstLeasePosOrNonNeg(...vals) {
  let sawZero = false;
  for (const v of vals) {
    const n = toLeaseNonNegNum(v);
    if (n !== null) {
      if (n > 0) return n;
      sawZero = true;
    }
  }
  return sawZero ? 0 : null;
}

const ISO_SUBSECOND_RE = /:\d{2}\.\d+/;

export function parseStepPrefillTimestampInfo(step) {
  if (!step || typeof step !== "object") return { ms: 0, subSecond: false };
  for (const field of ["created_at", "timestamp", "ts", "completed_at", "updated_at"]) {
    const v = step[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 1e11) {
      return { ms: Math.floor(v), subSecond: true };
    }
    if (typeof v === "string" && v.trim()) {
      const trimmed = v.trim();
      const ms = Date.parse(trimmed);
      if (Number.isFinite(ms) && ms > 0) {
        const floorMs = Math.floor(ms);
        const subSecond = ISO_SUBSECOND_RE.test(trimmed) || floorMs % 1000 !== 0;
        return { ms: floorMs, subSecond };
      }
    }
  }
  return { ms: 0, subSecond: false };
}

export function parseStepPrefillTimestampMs(step) {
  return parseStepPrefillTimestampInfo(step).ms;
}

function extractLightweightStepUsage(step) {
  if (!step || typeof step !== "object") {
    return {
      contextTokens: 0,
      cacheReadTokens: 0,
      cacheReadReported: false,
      cacheCreationTokens: 0,
      maxTokens: 0,
      model: ""
    };
  }
  const usage =
    (step.usage && typeof step.usage === "object" ? step.usage : null) ||
    (step.usageMetadata && typeof step.usageMetadata === "object" ? step.usageMetadata : null) ||
    (step.usage_metadata && typeof step.usage_metadata === "object" ? step.usage_metadata : null) ||
    {};
  const hasAnthropicCacheFields =
    toLeaseNonNegNum(step.cache_read_input_tokens) !== null ||
    toLeaseNonNegNum(usage.cache_read_input_tokens) !== null ||
    toLeaseNonNegNum(step.cache_creation_input_tokens) !== null ||
    toLeaseNonNegNum(usage.cache_creation_input_tokens) !== null ||
    Boolean(usage.cache_creation && typeof usage.cache_creation === "object");
  const hasInclusiveGateway =
    !hasAnthropicCacheFields &&
    (toLeaseNonNegNum(usage.input_tokens_details?.cached_tokens) !== null ||
      toLeaseNonNegNum(usage.prompt_tokens_details?.cached_tokens) !== null ||
      toLeaseNonNegNum(usage.cachedContentTokenCount) !== null ||
      toLeaseNonNegNum(usage.cached_content_token_count) !== null ||
      toLeaseNonNegNum(usage.prompt_cache_hit_tokens) !== null);
  const rawCacheRead = firstLeasePosOrNonNeg(
    step.cache_read_tokens,
    step.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cache_read_input_tokens,
    usage.cachedContentTokenCount,
    usage.cached_content_token_count,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens
  );
  const cacheReadReported = rawCacheRead !== null;
  const cacheReadTokens = rawCacheRead ?? 0;
  const cacheCreate1h =
    firstLeasePosOrNonNeg(step.cache_creation_1h_tokens, usage.cache_creation?.ephemeral_1h_input_tokens) ?? 0;
  const cacheCreate5m = firstLeasePosOrNonNeg(usage.cache_creation?.ephemeral_5m_input_tokens) ?? 0;
  const rawCreate = firstLeasePosOrNonNeg(
    step.cache_creation_tokens,
    step.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cache_creation_input_tokens
  );
  const cacheCreationTokens = rawCreate !== null ? rawCreate : cacheCreate5m + cacheCreate1h;
  const disjointIn = hasInclusiveGateway
    ? firstLeasePosOrNonNeg(step.input_tokens)
    : firstLeasePosOrNonNeg(step.input_tokens, usage.input_tokens);
  const inclusivePrompt = firstLeasePosOrNonNeg(
    step.prompt_tokens,
    step.promptTokenCount,
    usage.prompt_tokens,
    hasInclusiveGateway ? usage.input_tokens : null,
    usage.promptTokenCount,
    usage.prompt_token_count
  );
  let inputTokens = 0;
  if (disjointIn !== null && (disjointIn > 0 || inclusivePrompt === null)) {
    inputTokens = disjointIn;
  } else if (inclusivePrompt !== null) {
    inputTokens = Math.max(0, inclusivePrompt - cacheReadTokens - cacheCreationTokens);
  }
  const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens;

  let maxTokens = 0;
  for (const cand of [
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
  ]) {
    const parsedLim = toLeaseNonNegNum(cand);
    if (parsedLim !== null && parsedLim >= 8000 && parsedLim <= 10_000_000) {
      maxTokens = parsedLim;
      break;
    }
  }
  const model = typeof step.model === "string" && step.model.trim() ? step.model.trim().slice(0, 96) : "";
  return { contextTokens, cacheReadTokens, cacheReadReported, cacheCreationTokens, maxTokens, model };
}

const TTL_KEEPALIVE_ROUND_RE = /\[agy-dart TTL(?:保活| Keepalive)\s+(\d+)\/\d+\]/i;
const TTL_KEEPALIVE_MANUAL_RE = /\[agy-dart TTL(?:保活\s*手动| Keepalive\s+Manual)(?:\s|\])/i;

function isEmbeddedSubagentStepLite(step) {
  if (!step || typeof step !== "object") return false;
  if (step.is_subagent === true || step.isSubagent === true) return true;
  if (typeof step.parent_conversation_id === "string" && step.parent_conversation_id.trim()) return true;
  if (typeof step.parentConversationId === "string" && step.parentConversationId.trim()) return true;
  return false;
}

function stepHasActiveNonFinishCallsLite(step) {
  if (!step || typeof step !== "object") return false;
  const checkCallObj = (c) => {
    if (!c || typeof c !== "object") return false;
    const rawName = c.name || c.tool || c.function?.name || "";
    const bare = extractBareToolName(rawName);
    return Boolean(bare && bare !== "finish");
  };
  for (const arr of [step.tool_calls, step.toolCalls, step.function_calls, step.functionCalls]) {
    if (Array.isArray(arr) && arr.some(checkCallObj)) return true;
  }
  for (const single of [step.tool_call, step.toolCall, step.function_call, step.functionCall]) {
    if (checkCallObj(single)) return true;
  }
  if (Array.isArray(step.content)) {
    for (const part of step.content) {
      if (
        part &&
        typeof part === "object" &&
        (part.type === "tool_use" || part.type === "tool_call" || part.type === "function_call") &&
        checkCallObj(part)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Zero-dependency tail step inspector shared by Stop hook, Sidecar cache-diag, and Watchdog:
 * extracts latest primary PLANNER_RESPONSE prefill origin (`created_at`), token usage (`cacheReadTokens`,
 * `contextTokens`), window limit, tool-continuation state, and keepalive round provenance.
 */
export function inspectLatestTurnInSteps(steps = []) {
  const empty = {
    hasPlanner: false,
    prefillTs: 0,
    prefillSubSecond: false,
    contextTokens: 0,
    cacheReadTokens: 0,
    cacheReadReported: false,
    cacheCreationTokens: 0,
    maxTokens: 0,
    model: "",
    hasPromptAfterLastPlanner: false,
    hasToolContinuationAfterLastPlanner: false,
    precededByKeepalivePrompt: false,
    precededByGenuineUser: false,
    keepaliveRound: null,
    keepaliveMode: "",
    keepalivePromptTs: 0,
    keepalivePromptSubSecond: false
  };
  if (!Array.isArray(steps) || steps.length === 0) return empty;

  let lastPlannerIdx = -1;
  let lastPlannerUsage = null;
  let lastPlannerPrefillTs = 0;
  let lastPlannerPrefillSubSecond = false;
  let latestMaxTokens = 0;
  let latestModel = "";

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== "object" || isEmbeddedSubagentStepLite(s)) continue;
    const sysObj = s.systemMessage || s.system_message;
    if (sysObj && typeof sysObj === "object" && sysObj.systemMessage === "" && sysObj.metadata?.user_markdown) {
      continue;
    }
    const usage = extractLightweightStepUsage(s);
    if (usage.maxTokens > 0) latestMaxTokens = usage.maxTokens;
    if (usage.model) latestModel = usage.model;
    const tUpper = String(s.type || "").toUpperCase();
    const rLower = String(s.role || "").toLowerCase();
    if (tUpper === "PLANNER_RESPONSE" || ((rLower === "assistant" || rLower === "model") && usage.contextTokens > 0)) {
      lastPlannerIdx = i;
      lastPlannerUsage = usage;
      const tsInfo = parseStepPrefillTimestampInfo(s);
      lastPlannerPrefillTs = tsInfo.ms;
      lastPlannerPrefillSubSecond = tsInfo.subSecond;
    }
  }

  if (lastPlannerIdx < 0 || !lastPlannerUsage) return empty;

  const lastPlannerHasActiveToolCalls = stepHasActiveNonFinishCallsLite(steps[lastPlannerIdx]);
  let hasPromptAfterLastPlanner = false;
  let sawToolResultAfterLastPlanner = false;
  for (let i = lastPlannerIdx + 1; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== "object" || isEmbeddedSubagentStepLite(s)) continue;
    const sysObj = s.systemMessage || s.system_message;
    if (sysObj && typeof sysObj === "object" && sysObj.systemMessage === "" && sysObj.metadata?.user_markdown) {
      continue;
    }
    const tUpper = String(s.type || "").toUpperCase();
    const rLower = String(s.role || "").toLowerCase();
    if (
      tUpper === "GENERIC" ||
      tUpper === "TOOL_OUTPUT" ||
      tUpper === "TOOL_RESULT" ||
      rLower === "tool" ||
      s.tool_result !== undefined ||
      s.tool_call_id !== undefined ||
      s.toolCallId !== undefined ||
      s.call_id !== undefined
    ) {
      sawToolResultAfterLastPlanner = true;
      continue;
    }
    if (tUpper === "USER_INPUT" || rLower === "user" || tUpper === "SYSTEM_MESSAGE") {
      const txt = extractGenesisStepText(s).trim();
      if (txt) {
        hasPromptAfterLastPlanner = true;
        break;
      }
    }
  }

  let sawKeepaliveBeforePlanner = false;
  let sawGenuineUserBeforePlanner = false;
  let sawGenuineUserAfterKeepalive = false;
  let keepaliveRound = null;
  let keepaliveMode = "";
  let keepalivePromptTs = 0;
  let keepalivePromptSubSecond = false;
  for (let i = lastPlannerIdx - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s || typeof s !== "object" || isEmbeddedSubagentStepLite(s)) continue;
    const sysObj = s.systemMessage || s.system_message;
    if (sysObj && typeof sysObj === "object" && sysObj.systemMessage === "" && sysObj.metadata?.user_markdown) {
      continue;
    }
    const tUpper = String(s.type || "").toUpperCase();
    const rLower = String(s.role || "").toLowerCase();
    if (tUpper === "PLANNER_RESPONSE" || rLower === "assistant" || rLower === "model") {
      if (sawKeepaliveBeforePlanner || sawGenuineUserBeforePlanner) {
        break;
      }
      const prevUsage = extractLightweightStepUsage(s);
      const hasToolCalls =
        stepHasActiveNonFinishCallsLite(s) ||
        Array.isArray(s.tool_calls) ||
        Array.isArray(s.toolCalls) ||
        Array.isArray(s.function_calls) ||
        Array.isArray(s.functionCalls);
      if (!hasToolCalls && (tUpper === "PLANNER_RESPONSE" || prevUsage.contextTokens > 0)) {
        break;
      }
      continue;
    }
    if (tUpper === "USER_INPUT" || rLower === "user" || tUpper === "SYSTEM_MESSAGE") {
      const txt = extractGenesisStepText(s).trim();
      if (!txt) continue;
      if (isTtlKeepalivePrompt(txt)) {
        if (!sawKeepaliveBeforePlanner) {
          sawKeepaliveBeforePlanner = true;
          const promptTsInfo = parseStepPrefillTimestampInfo(s);
          if (promptTsInfo.ms > 0) {
            keepalivePromptTs = promptTsInfo.ms;
            keepalivePromptSubSecond = promptTsInfo.subSecond;
          }
          const roundMatch = txt.match(TTL_KEEPALIVE_ROUND_RE);
          if (roundMatch && Number.isFinite(Number(roundMatch[1])) && Number(roundMatch[1]) >= 1) {
            keepaliveRound = Math.floor(Number(roundMatch[1]));
            keepaliveMode = "auto";
          } else if (TTL_KEEPALIVE_MANUAL_RE.test(txt)) {
            keepaliveMode = "manual";
          }
        }
      } else if (tUpper === "USER_INPUT" || rLower === "user") {
        const userTs = parseStepPrefillTimestampMs(s);
        if (
          sawKeepaliveBeforePlanner &&
          !sawGenuineUserBeforePlanner &&
          keepalivePromptTs > 0 &&
          userTs > 0 &&
          keepalivePromptTs - userTs > 30_000
        ) {
          break;
        }
        sawGenuineUserBeforePlanner = true;
        if (!sawKeepaliveBeforePlanner) {
          sawGenuineUserAfterKeepalive = true;
        }
      }
    }
  }

  const precededByKeepalivePrompt = sawKeepaliveBeforePlanner && !sawGenuineUserBeforePlanner;
  return {
    hasPlanner: true,
    prefillTs: lastPlannerPrefillTs,
    prefillSubSecond: lastPlannerPrefillSubSecond,
    contextTokens: lastPlannerUsage.contextTokens,
    cacheReadTokens: lastPlannerUsage.cacheReadTokens,
    cacheReadReported: Boolean(lastPlannerUsage.cacheReadReported),
    cacheCreationTokens: lastPlannerUsage.cacheCreationTokens,
    maxTokens: lastPlannerUsage.maxTokens || latestMaxTokens,
    model: lastPlannerUsage.model || latestModel,
    hasPromptAfterLastPlanner,
    hasToolContinuationAfterLastPlanner: Boolean(lastPlannerHasActiveToolCalls || sawToolResultAfterLastPlanner),
    precededByKeepalivePrompt,
    precededByGenuineUser: sawGenuineUserAfterKeepalive,
    keepaliveRound: precededByKeepalivePrompt ? keepaliveRound : null,
    keepaliveMode: precededByKeepalivePrompt ? keepaliveMode : "",
    keepalivePromptTs: precededByKeepalivePrompt ? keepalivePromptTs : 0,
    keepalivePromptSubSecond: precededByKeepalivePrompt ? keepalivePromptSubSecond : false
  };
}

export function hasPendingKeepaliveColdCheck(kaState) {
  if (!kaState || typeof kaState !== "object") return false;
  if (kaState.coldMissTripped) return false;
  if (kaState.pendingAck || kaState.inKeepaliveTurn) return false;
  const pendingId = typeof kaState.pendingColdCheckId === "string" ? kaState.pendingColdCheckId.trim() : "";
  const checkedId = typeof kaState.lastColdCheckedId === "string" ? kaState.lastColdCheckedId.trim() : "";
  if (pendingId && pendingId !== checkedId) return true;
  const usedCount = Number.isFinite(Number(kaState.usedCount)) ? Math.floor(Number(kaState.usedCount)) : 0;
  const lastColdCheckUsed = Number.isFinite(Number(kaState.lastColdCheckUsed))
    ? Math.floor(Number(kaState.lastColdCheckUsed))
    : 0;
  return usedCount >= 1 && lastColdCheckUsed < usedCount;
}

export function isKeepaliveTurnFlushedForRound(info, kaState) {
  if (
    !info ||
    !info.hasPlanner ||
    info.hasPromptAfterLastPlanner ||
    info.hasToolContinuationAfterLastPlanner ||
    info.precededByGenuineUser ||
    !info.precededByKeepalivePrompt ||
    !(info.contextTokens > 0)
  ) {
    return false;
  }
  const usedCount = Number.isFinite(Number(kaState?.usedCount)) ? Math.floor(Number(kaState.usedCount)) : 0;
  const lastSentTs = Number.isFinite(Number(kaState?.lastSentTs)) ? Math.floor(Number(kaState.lastSentTs)) : 0;
  const lastIdleAnchorTs = Number.isFinite(Number(kaState?.lastIdleAnchorTs))
    ? Math.floor(Number(kaState.lastIdleAnchorTs))
    : 0;
  const prefillTs = Number.isFinite(Number(info.prefillTs)) ? Math.floor(Number(info.prefillTs)) : 0;
  const promptTs = Number.isFinite(Number(info.keepalivePromptTs)) ? Math.floor(Number(info.keepalivePromptTs)) : 0;
  const dispatchMode =
    kaState?.lastDispatchMode === "manual" || kaState?.lastDispatchMode === "auto"
      ? kaState.lastDispatchMode
      : "";
  const causalFloor = Math.max(lastIdleAnchorTs, lastSentTs);
  const toInterval = (ts, subSecond) => {
    if (!(ts > 0)) return null;
    const isExact = subSecond !== false;
    return { lo: ts, hi: isExact ? ts : ts + 999, isExact };
  };
  const prefillRange = toInterval(prefillTs, info.prefillSubSecond);
  const promptRange = toInterval(promptTs, info.keepalivePromptSubSecond);

  // Hard exclusion: treat second-level timestamps as [ts, ts + 999] intervals and exact
  // sub-second timestamps as [ts, ts]. Any timestamp whose upper bound is strictly earlier
  // than causalFloor cannot belong to this dispatch / idle cycle.
  if (causalFloor > 0) {
    if (prefillRange && prefillRange.hi < causalFloor) {
      return false;
    }
    if (promptRange && promptRange.hi < causalFloor) {
      return false;
    }
  }
  if (dispatchMode === "manual" && info.keepaliveRound !== null) {
    return false;
  }
  if (dispatchMode === "auto" && info.keepaliveMode === "manual") {
    return false;
  }
  if (info.keepaliveRound !== null && usedCount > 0 && info.keepaliveRound !== usedCount) {
    return false;
  }
  // Positive causal evidence: at least one timestamp's lower bound must provably fall at/after
  // causalFloor (and strictly after the cycle boundary when only second-level precision exists).
  const isProvablyInRound = (range) => {
    if (!range || causalFloor <= 0) return false;
    if (range.lo < causalFloor) return false;
    if (!range.isExact && range.lo <= causalFloor) return false;
    return true;
  };
  const hasTimestampEvidence = Boolean(
    causalFloor > 0 && (isProvablyInRound(prefillRange) || isProvablyInRound(promptRange))
  );
  // Require positive timestamp causality whenever causalFloor > 0 so an untimestamped or
  // same-second-ambiguous prior round on disk can never be attributed to a newer dispatch.
  if (dispatchMode === "manual" || info.keepaliveMode === "manual") {
    return Boolean(hasTimestampEvidence && info.keepaliveRound === null);
  }
  if (info.keepaliveRound !== null && usedCount > 0) {
    if (causalFloor > 0) {
      return Boolean(hasTimestampEvidence && info.keepaliveRound === usedCount);
    }
    return info.keepaliveRound === usedCount;
  }
  return hasTimestampEvidence;
}

export function computeCausalTurnLlmFloorTs(lease, nowMs) {
  if (!lease || typeof lease !== "object") return 0;
  const now = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : Date.now();
  const turnFloorTs = lease.startedTs > 0 && lease.startedTs <= now ? lease.startedTs : 0;
  const maxAgeMs = 30 * 60 * 1000;
  let floor = 0;
  const consider = (ts) => {
    if (
      Number.isFinite(ts) &&
      ts > 0 &&
      ts <= now &&
      (turnFloorTs === 0 || ts >= turnFloorTs - 1_000) &&
      now - ts <= maxAgeMs
    ) {
      floor = Math.max(floor, Math.floor(ts));
    }
  };
  consider(lease.lastLlmStartTs);
  consider(lease.lastCompletedToolTs);
  if (lease.phase === WATCHDOG_PHASES.TOOL_RUNNING || lease.phase === WATCHDOG_PHASES.SUBAGENT_BG) {
    consider(lease.phaseChangedTs);
  }
  return floor;
}

export function readWatchdogTranscriptTail(transcriptPath, maxBytes = 32768) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    return { steps: [], mtimeMs: 0, size: 0 };
  }
  let fd = null;
  try {
    const cleanPath = transcriptPath.trim();
    if (cleanPath.includes("\0") || /^[\\/]{2}/.test(cleanPath) || !fs.existsSync(cleanPath)) {
      return { steps: [], mtimeMs: 0, size: 0 };
    }
    const HARD_CAP_BYTES = 524288;
    const initialCap = Math.min(HARD_CAP_BYTES, Math.max(4096, Math.floor(Number(maxBytes) || 32768)));
    fd = fs.openSync(cleanPath, "r");
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile() || fstat.size <= 0) {
      return { steps: [], mtimeMs: fstat.mtimeMs || 0, size: 0 };
    }

    let windowBytes = Math.min(initialCap, fstat.size);
    while (true) {
      const offset = Math.max(0, fstat.size - windowBytes);
      const buf = Buffer.allocUnsafe(windowBytes);
      const bytesRead = fs.readSync(fd, buf, 0, windowBytes, offset);
      if (bytesRead <= 0) {
        return { steps: [], mtimeMs: fstat.mtimeMs || 0, size: fstat.size };
      }
      let slice = buf.subarray(0, bytesRead).toString("utf8");
      if (offset > 0) {
        const nlIdx = slice.indexOf("\n");
        slice = nlIdx >= 0 ? slice.slice(nlIdx + 1) : "";
      }
      const steps = [];
      let hasPlannerStep = false;
      if (slice) {
        for (const rawLine of slice.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object") {
              steps.push(parsed);
              const tUpper = String(parsed.type || "").toUpperCase();
              const rLower = String(parsed.role || "").toLowerCase();
              if (tUpper === "PLANNER_RESPONSE" || rLower === "assistant" || rLower === "model") {
                hasPlannerStep = true;
              }
            }
          } catch {}
        }
      }
      if ((hasPlannerStep && steps.length >= 2) || offset === 0 || windowBytes >= HARD_CAP_BYTES || windowBytes >= fstat.size) {
        return { steps, mtimeMs: fstat.mtimeMs || 0, size: fstat.size };
      }
      windowBytes = Math.min(fstat.size, Math.min(HARD_CAP_BYTES, windowBytes * 4));
    }
  } catch {
    return { steps: [], mtimeMs: 0, size: 0 };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function isSubagentLeasePayload(payload = {}, env = process.env) {
  const envSub = String(env?.ANTIGRAVITY_SUBAGENT || "").trim().toLowerCase();
  if (envSub === "1" || envSub === "true") return true;
  const envSwarmWorker = String(env?.ANTIGRAVITY_SWARM_WORKER || "").trim().toLowerCase();
  if (envSwarmWorker === "1" || envSwarmWorker === "true") return true;
  if (env?.ANTIGRAVITY_PARENT_CONVERSATION_ID) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const common =
    payload.common && typeof payload.common === "object" && !Array.isArray(payload.common) ? payload.common : null;
  const meta =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : null;

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
    if (workerName && !PRIMARY_HOST_AGENT_NAME_RE.test(workerName.trim())) {
      return true;
    }
    const swarmObj = bag.swarm && typeof bag.swarm === "object" && !Array.isArray(bag.swarm) ? bag.swarm : null;
    if (swarmObj) {
      if (swarmObj.isWorker === true || swarmObj.is_worker === true) return true;
      const swRole = typeof swarmObj.role === "string" ? swarmObj.role.trim() : "";
      if (swRole && !PRIMARY_HOST_AGENT_NAME_RE.test(swRole) && SUBAGENT_ROLE_RE.test(swRole)) return true;
      const swName = [swarmObj.workerName, swarmObj.worker_name, swarmObj.name]
        .find((v) => typeof v === "string" && v.trim());
      if (swName && !PRIMARY_HOST_AGENT_NAME_RE.test(swName.trim()) && swRole.toLowerCase() !== "coordinator") {
        return true;
      }
    }
    const spec = bag.subagentSpec ?? bag.subagent_spec ?? null;
    if (spec && typeof spec === "object" && !Array.isArray(spec) && Object.keys(spec).length > 0) {
      return true;
    }
    const depth = Number(bag.nestingDepth ?? bag.nesting_depth);
    if (Number.isFinite(depth) && depth > 0) return true;
  }

  const convId = sanitizeConversationId(
    payload.conversationId ||
      payload.conversation_id ||
      common?.conversationId ||
      common?.conversation_id ||
      payload.sessionId ||
      payload.session_id ||
      ""
  );
  const directParent = sanitizeConversationId(
    payload.parentConversationId ||
      payload.parent_conversation_id ||
      common?.parentConversationId ||
      common?.parent_conversation_id ||
      meta?.parentConversationId ||
      meta?.parent_conversation_id ||
      payload.parentSessionId ||
      payload.parent_session_id ||
      meta?.parentSessionId ||
      meta?.parent_session_id ||
      ""
  );
  if (directParent && directParent !== convId) return true;

  const isBattle = Boolean(
    payload.isBattleMode ||
      payload.is_battle_mode ||
      common?.isBattleMode ||
      common?.is_battle_mode ||
      meta?.isBattleModeFork ||
      meta?.is_battle_mode_fork
  );
  const rootId = sanitizeConversationId(
    payload.rootConversationId ||
      payload.root_conversation_id ||
      common?.rootConversationId ||
      common?.root_conversation_id ||
      meta?.rootConversationId ||
      meta?.root_conversation_id ||
      env?.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
      ""
  );
  if (!isBattle && convId && rootId && rootId !== convId) return true;

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
    common?.agentName,
    common?.agent_name,
    common?.role,
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
      if (!PRIMARY_HOST_AGENT_NAME_RE.test(clean) && (clean.toLowerCase() === "self" || SUBAGENT_ROLE_RE.test(clean))) {
        return true;
      }
    }
  }
  return false;
}

export function getToolTimeoutTier(toolKind = "", phase = "") {
  if (phase === WATCHDOG_PHASES.SUBAGENT_BG || toolKind === "subagent" || toolKind === "async_cmd") return 4;
  if (toolKind === "sync_cmd" || toolKind === "mcp_long") return 3;
  if (toolKind === "mcp") return 2;
  if (toolKind === "read" || toolKind === "host") return 1;
  return 0;
}

export function sanitizeConversationId(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return "";
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return "";
  if (RESERVED_CONV_IDS.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

export function getWatchdogLeaseKey(conversationId) {
  const safeId = sanitizeConversationId(conversationId);
  return safeId ? `${WATCHDOG_LEASE_PREFIX}${safeId}` : "";
}

export function sanitizeWatchdogText(raw, maxBytes = 200) {
  if (raw === null || raw === undefined) return "";
  const redacted = redactSecrets(String(raw)).text;
  const flat = redacted
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (Buffer.byteLength(flat, "utf8") <= maxBytes) return flat;
  const budget = Math.max(1, maxBytes - 3);
  if (maxBytes <= 3) return truncateUtf8Safe(flat, maxBytes);
  return `${truncateUtf8Safe(flat, budget)}...`;
}

function sanitizeCwd(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || /^[\\/]{2}/.test(trimmed)) return "";
  return trimmed.slice(0, 512);
}

export function isSameWorkspacePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (/^[a-zA-Z]:(?:\/|$)/.test(na) || /^[a-zA-Z]:(?:\/|$)/.test(nb) || process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

const AMBIGUOUS_LEAF_DIR_RE =
  /^(?:\d+|v\d+(?:[._-]\d+)*|src|app|apps|lib|pkg|packages|package|client|server|web|api|core|main|trunk|dev|prod|test|tests|docs|scripts|build|dist)$/i;
const INTERNAL_REPO_DIRS_RE =
  /^(?:src|lib|test|tests|__tests__|spec|specs|docs|doc|scripts|bin|config|configs|public|assets|static|styles|components|views|pages|routes|controllers|models|utils|helpers|hooks|context|fast|sidecars|rules|skills|dist|build|out|target|coverage|node_modules|vendor|tmp|temp)$/i;
const MONOREPO_CONTAINER_DIRS_RE = /^(?:packages|apps|services|modules|crates|plugins|projects)$/i;
const SYSTEM_HOME_PARENT_RE = /^(?:users|home|root|mnt|volumes|var|tmp|opt)$/i;

let lazyDatabaseSync = null;
let localSqliteWarnGuardInstalled = false;

function getLazyDatabaseSync() {
  if (lazyDatabaseSync) return lazyDatabaseSync;
  if (!localSqliteWarnGuardInstalled) {
    localSqliteWarnGuardInstalled = true;
    try {
      const origEmit = process.emitWarning.bind(process);
      process.emitWarning = (warning, ...args) => {
        const msg = typeof warning === "string" ? warning : String(warning?.message || "");
        const type = typeof args[0] === "string" ? args[0] : args[0]?.type || warning?.name || "";
        if (/ExperimentalWarning/i.test(String(type)) && /sqlite/i.test(msg)) return;
        return origEmit(warning, ...args);
      };
    } catch {}
  }
  const req = createRequire(import.meta.url);
  lazyDatabaseSync = req("node:sqlite").DatabaseSync;
  return lazyDatabaseSync;
}

export function decodeFileUriOrPath(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  if (/^file:\/\//i.test(trimmed)) {
    const winDriveMatch = trimmed.match(/^file:\/\/\/([a-zA-Z])(?::|%3[aA])(\/.*)?$/);
    if (winDriveMatch) {
      const drive = winDriveMatch[1];
      let rest = winDriveMatch[2] || "/";
      try {
        rest = decodeURIComponent(rest);
      } catch {}
      const sep = process.platform === "win32" ? "\\" : "/";
      const normalizedRest = rest.replace(/\//g, sep);
      return sanitizeCwd(`${drive}:${normalizedRest}`);
    }
    try {
      return sanitizeCwd(fileURLToPath(trimmed));
    } catch {
      try {
        return sanitizeCwd(fileURLToPath(decodeURIComponent(trimmed)));
      } catch {
        return "";
      }
    }
  }
  return sanitizeCwd(trimmed);
}

export function parseWorkspaceUriToPath(rawWorkspaceUris) {
  if (typeof rawWorkspaceUris !== "string") return "";
  const trimmed = rawWorkspaceUris.trim();
  if (!trimmed) return "";
  const candidates = [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") candidates.push(item);
          else if (item && typeof item === "object") candidates.push(item.uri || item.path || "");
        }
      } else if (typeof parsed === "string") {
        candidates.push(parsed);
      } else if (parsed && typeof parsed === "object") {
        candidates.push(parsed.uri || parsed.path || "");
      }
    } catch {}
  }
  if (candidates.length === 0) {
    const uriMatches = trimmed.match(/file:\/\/[^\s"',;\]]+/gi);
    if (uriMatches && uriMatches.length > 0) {
      candidates.push(...uriMatches);
    } else {
      candidates.push(...trimmed.split(/[\r\n,;]+/));
    }
  }
  for (const cand of candidates) {
    const decoded = decodeFileUriOrPath(cand);
    if (decoded) return decoded;
  }
  return "";
}

export function extractPayloadWorkspaceRoot(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
  const direct = decodeFileUriOrPath(payload.cwd || payload.workspacePath || payload.workspace_path || meta?.cwd || "");
  if (direct) return direct;

  const listSources = [
    payload.workspacePaths,
    payload.workspace_paths,
    payload.workspaceRoots,
    payload.workspace_roots,
    payload.workspaces,
    meta?.workspacePaths,
    meta?.workspace_paths,
    meta?.workspaceRoots,
    meta?.workspace_roots
  ];
  for (const src of listSources) {
    if (typeof src === "string" && src.trim()) {
      const p = parseWorkspaceUriToPath(src) || decodeFileUriOrPath(src);
      if (p) return p;
    } else if (Array.isArray(src)) {
      for (const item of src) {
        const raw = typeof item === "string" ? item : item?.uri || item?.path || "";
        const p = decodeFileUriOrPath(raw);
        if (p) return p;
      }
    }
  }
  return "";
}

/**
 * Pure, 0-fs-I/O smart window/subproject label formatter:
 *   - Disambiguates numeric/version/generic leaf dirs (`e:\故事\1` -> `故事/1`, `d:\proj\v2` -> `proj/v2`)
 *   - Refines umbrella workspaces (`e:\work` + edits/reads inside `e:\work\agy-dart\...` -> `work/agy-dart`)
 */
export function formatWorkspaceWindowLabel(cwd, modifiedOrReadPaths = []) {
  const cleanCwd = decodeFileUriOrPath(cwd);
  if (!cleanCwd) return "";
  const posixCwd = cleanCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!posixCwd) return "";

  const hasWinDrive = /^[a-zA-Z]:(?:\/|$)/.test(posixCwd);
  const bodyAfterRoot = hasWinDrive ? posixCwd.slice(2).replace(/^\/+/, "") : posixCwd.replace(/^\/+/, "");
  const segments = bodyAfterRoot.split("/").filter(Boolean);
  if (segments.length === 0) return "";

  const leaf = segments[segments.length - 1];
  const parent = segments.length >= 2 ? segments[segments.length - 2] : "";
  const isShortAmbiguous =
    leaf.length === 1 || (Buffer.byteLength(leaf, "utf8") <= 2 && /^[a-z0-9._-]+$/i.test(leaf));
  const needsParent =
    Boolean(parent) &&
    !SYSTEM_HOME_PARENT_RE.test(parent) &&
    (AMBIGUOUS_LEAF_DIR_RE.test(leaf) || isShortAmbiguous);
  const baseLabel = needsParent ? `${parent}/${leaf}` : leaf;

  if (Array.isArray(modifiedOrReadPaths) && modifiedOrReadPaths.length > 0) {
    const cwdPrefix = `${posixCwd}/`;
    const cwdPrefixLower = cwdPrefix.toLowerCase();
    const caseInsensitive = hasWinDrive || process.platform === "win32";
    const subprojects = new Set();
    const subprojectDisplay = new Map();
    let sawRootFile = false;
    let sawInternalRepoDir = false;

    for (const entry of modifiedOrReadPaths) {
      const rawPath =
        typeof entry === "string"
          ? entry.trim()
          : entry && typeof entry.path === "string"
            ? entry.path.trim()
            : "";
      if (!rawPath || rawPath.includes("\0")) continue;
      let posixPath = rawPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      if (!posixPath) continue;

      let rel = "";
      const isAbs = posixPath.startsWith("/") || /^[a-zA-Z]:(?:\/|$)/.test(posixPath);
      if (isAbs) {
        const matchesCwd = caseInsensitive
          ? posixPath.toLowerCase().startsWith(cwdPrefixLower)
          : posixPath.startsWith(cwdPrefix);
        if (!matchesCwd) continue;
        rel = posixPath.slice(cwdPrefix.length);
      } else {
        if (posixPath === ".." || posixPath.startsWith("../")) continue;
        rel = posixPath;
      }

      const relParts = rel.split("/").filter(Boolean);
      if (relParts.length === 0) continue;
      if (relParts.length === 1) {
        if (!relParts[0].startsWith(".")) sawRootFile = true;
        continue;
      }

      const dir1 = relParts[0];
      if (MONOREPO_CONTAINER_DIRS_RE.test(dir1) && relParts.length >= 3 && !relParts[1].startsWith(".")) {
        const sub = relParts[1];
        const key = caseInsensitive ? sub.toLowerCase() : sub;
        subprojects.add(key);
        if (!subprojectDisplay.has(key)) subprojectDisplay.set(key, sub);
      } else if (dir1.startsWith(".") || INTERNAL_REPO_DIRS_RE.test(dir1)) {
        if (!/^\.(?:gemini|agy-dart|vscode|idea)$/i.test(dir1)) {
          sawInternalRepoDir = true;
        }
      } else {
        const key = caseInsensitive ? dir1.toLowerCase() : dir1;
        subprojects.add(key);
        if (!subprojectDisplay.has(key)) subprojectDisplay.set(key, dir1);
      }
    }

    if (!sawRootFile && !sawInternalRepoDir && subprojects.size === 1) {
      const [onlyKey] = subprojects;
      const subName = subprojectDisplay.get(onlyKey) || onlyKey;
      if (subName && subName.toLowerCase() !== leaf.toLowerCase()) {
        return sanitizeWatchdogText(`${baseLabel}/${subName}`, 48);
      }
    }
  }

  return sanitizeWatchdogText(baseLabel, 48);
}

function extractInlinePayloadTitle(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
  const candidates = [
    payload.conversationTitle,
    payload.conversation_title,
    payload.title,
    meta?.conversationTitle,
    meta?.conversation_title
  ];
  for (const cand of candidates) {
    if (typeof cand !== "string") continue;
    const trimmed = cand.trim();
    if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) continue;
    if (Buffer.byteLength(trimmed, "utf8") > 160) continue;
    if (HEADLESS_FINISH_PROMPT_RE.test(trimmed)) continue;
    const clean = sanitizeWatchdogText(trimmed, 36);
    if (clean) return clean;
  }
  return "";
}

function resolveCandidateSummaryDbPaths({ transcriptPath = "", summaryDbPath = "", allowDefaultDb = true } = {}) {
  const out = [];
  const seen = new Set();
  const pushUnique = (p) => {
    if (typeof p !== "string" || !p.trim()) return;
    const resolved = path.resolve(p.trim());
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  };

  if (summaryDbPath) pushUnique(summaryDbPath);
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    pushUnique(process.env.AGY_DART_SUMMARY_DB_PATH);
  }

  if (typeof transcriptPath === "string" && transcriptPath.trim()) {
    let cur = path.dirname(path.resolve(transcriptPath.trim()));
    for (let depth = 0; depth < 7 && cur; depth += 1) {
      if (path.basename(cur).toLowerCase() === "brain") {
        const agRoot = path.dirname(cur);
        if (agRoot && agRoot !== cur) {
          pushUnique(path.join(agRoot, "conversation_summaries.db"));
        }
        break;
      }
      const next = path.dirname(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }

  if (allowDefaultDb) {
    const home = os.homedir();
    if (home) {
      pushUnique(path.join(home, ".gemini", "antigravity", "conversation_summaries.db"));
      pushUnique(path.join(home, ".gemini", "antigravity-ide", "conversation_summaries.db"));
      pushUnique(path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"));
    }
  }

  return out;
}

export function resolveCandidateTranscriptPath(
  conversationId,
  { transcriptPath = "", summaryDbPath = "", allowDefaultDb = true } = {}
) {
  const safeId = sanitizeConversationId(conversationId);
  if (typeof transcriptPath === "string" && transcriptPath.trim()) {
    const direct = transcriptPath.trim();
    try {
      if (fs.existsSync(direct)) return direct;
    } catch {}
  }
  if (!safeId) return "";

  const brainRoots = [];
  const seenRoots = new Set();
  const pushBrainRoot = (rootDir) => {
    if (typeof rootDir !== "string" || !rootDir.trim()) return;
    const resolved = path.resolve(rootDir.trim());
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seenRoots.has(key)) {
      seenRoots.add(key);
      brainRoots.push(resolved);
    }
  };

  if (typeof summaryDbPath === "string" && summaryDbPath.trim()) {
    pushBrainRoot(path.join(path.dirname(path.resolve(summaryDbPath.trim())), "brain"));
  }
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    pushBrainRoot(path.join(path.dirname(path.resolve(process.env.AGY_DART_SUMMARY_DB_PATH.trim())), "brain"));
  }
  if (allowDefaultDb !== false) {
    const home = os.homedir();
    if (home) {
      pushBrainRoot(path.join(home, ".gemini", "antigravity", "brain"));
      pushBrainRoot(path.join(home, ".gemini", "antigravity-ide", "brain"));
      pushBrainRoot(path.join(home, ".gemini", "antigravity-cli", "brain"));
    }
  }

  for (const root of brainRoots) {
    const relPaths = [
      path.join(safeId, ".system_generated", "logs", "transcript_full.jsonl"),
      path.join(safeId, ".system_generated", "logs", "transcript.jsonl"),
      path.join(safeId, ".system_generated", "transcript_full.jsonl"),
      path.join(safeId, ".system_generated", "transcript.jsonl")
    ];
    for (const relSub of relPaths) {
      const cand = path.resolve(root, relSub);
      const rel = path.relative(
        process.platform === "win32" ? root.toLowerCase() : root,
        process.platform === "win32" ? cand.toLowerCase() : cand
      );
      if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
        continue;
      }
      try {
        if (fs.existsSync(cand)) return cand;
      } catch {}
    }
  }
  return "";
}

export function readConversationParentId(db, conversationId, summaryParent) {
  const parent = sanitizeConversationId(summaryParent);
  if (parent && parent !== conversationId) return parent;
  try {
    const link = db.prepare(
      "SELECT parent_id FROM conversation_parents WHERE conversation_id = ? AND parent_id <> conversation_id LIMIT 1"
    ).get(conversationId);
    return sanitizeConversationId(link?.parent_id);
  } catch {
    // Older hosts have only the parent column on the summary row.
    return "";
  }
}

const MAX_ANNOTATION_FILE_BYTES = 65536;

/**
 * Parse the top-level `archived` boolean from an Antigravity `.pbtxt` annotation file.
 * Strips quoted string literals, comments, and nested `{...}` / `<...>` blocks first so a
 * conversation title like `title:"archived:true"` or a nested field can never false-trigger.
 * Returns `true`, `false`, or `null` (when unset/unreadable).
 */
export function parseAnnotationArchivedStatus(rawText) {
  if (typeof rawText !== "string" || !rawText) return null;
  let topLevel = "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;
  for (let i = 0; i < rawText.length; i += 1) {
    const ch = rawText[i];
    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
        if (depth === 0) topLevel += " ";
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
        if (depth === 0) topLevel += " ";
      }
      continue;
    }
    if (ch === "#") {
      inComment = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "<") {
      depth += 1;
      if (depth === 1) topLevel += " ";
      continue;
    }
    if (ch === "}" || ch === ">") {
      if (depth > 0) depth -= 1;
      if (depth === 0) topLevel += " ";
      continue;
    }
    if (depth === 0) {
      topLevel += ch;
    }
  }
  const re = /(?:^|[\s;,])archived\s*:\s*(true|false|1|0)(?=$|[\s;,])/gi;
  let result = null;
  let m;
  while ((m = re.exec(topLevel)) !== null) {
    const val = m[1].toLowerCase();
    result = val === "true" || val === "1";
  }
  return result;
}

function readConversationAnnotationArchived(agRoot, conversationId) {
  const safeId = sanitizeConversationId(conversationId);
  if (!agRoot || !safeId) return null;
  const annDir = path.resolve(agRoot, "annotations");
  const annPath = path.resolve(annDir, `${safeId}.pbtxt`);
  const rel = path.relative(
    process.platform === "win32" ? annDir.toLowerCase() : annDir,
    process.platform === "win32" ? annPath.toLowerCase() : annPath
  );
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
    return null;
  }
  let fd = null;
  try {
    if (!fs.existsSync(annPath)) return null;
    fd = fs.openSync(annPath, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size <= 0) return null;
    const toRead = Math.min(MAX_ANNOTATION_FILE_BYTES, st.size);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    if (bytesRead <= 0) return null;
    return parseAnnotationArchivedStatus(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isSqliteMissingColumnError(err) {
  const msg = String(err?.message || err || "");
  return /no such column/i.test(msg);
}

function isSqliteBusyOrLockError(err) {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || err?.errstr || "");
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(`${code} ${msg}`);
}

function readConversationFtsArchived(db, conversationId, errorState = null) {
  if (!db || !conversationId) return null;
  try {
    const archivedRow = db
      .prepare(
        "SELECT 1 AS archived FROM conversations_fts WHERE conversation_id = ? AND (archived = 1 OR archived = '1' OR lower(CAST(archived AS TEXT)) = 'true') LIMIT 1"
      )
      .get(conversationId);
    if (archivedRow) return true;
    const anyRow = db
      .prepare("SELECT archived FROM conversations_fts WHERE conversation_id = ? LIMIT 1")
      .get(conversationId);
    if (!anyRow || anyRow.archived === null || anyRow.archived === undefined) return null;
    return parseSummaryArchivedColumn(anyRow.archived);
  } catch (err) {
    if (errorState && isSqliteBusyOrLockError(err)) {
      errorState.hadError = true;
    }
    return null;
  }
}

function parseSummaryArchivedColumn(val) {
  if (val === null || val === undefined) return null;
  if (val === true) return true;
  if (val === false) return false;
  const rawStr = typeof val === "string" ? val.trim().toLowerCase() : "";
  if (rawStr === "true") return true;
  if (rawStr === "false") return false;
  const n = Number(val);
  if (Number.isFinite(n)) return n > 0;
  return null;
}

const SUMMARY_LOOKUP_CACHE_MAX = 256;
const SUMMARY_LOOKUP_CACHE_TTL_MS = 10_000;
const _summaryLookupCache = new Map();

export function clearConversationSummaryCache() {
  _summaryLookupCache.clear();
}

function statSignatureSafe(filePath) {
  if (!filePath) return "-";
  try {
    const st = fs.statSync(filePath);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "-";
  }
}

function buildSummaryDiskStamp(dbCandidates, safeId) {
  const parts = [];
  for (const dbPath of dbCandidates) {
    const agRoot = path.dirname(dbPath);
    const annPath = path.resolve(agRoot, "annotations", `${safeId}.pbtxt`);
    parts.push(
      `${statSignatureSafe(dbPath)}/${statSignatureSafe(`${dbPath}-wal`)}/${statSignatureSafe(annPath)}`
    );
  }
  return parts.join("|");
}

function rememberSummaryLookupCache(key, entry) {
  if (_summaryLookupCache.size >= SUMMARY_LOOKUP_CACHE_MAX && !_summaryLookupCache.has(key)) {
    const oldest = _summaryLookupCache.keys().next().value;
    if (oldest !== undefined) _summaryLookupCache.delete(oldest);
  }
  _summaryLookupCache.set(key, entry);
}

/**
 * Read-only, fail-open lookup of Antigravity's official short conversation title,
 * archive/killed status, and fallback workspace root from `conversation_summaries.db`
 * and sibling `annotations/<id>.pbtxt` (zero user-prompt leakage).
 */
export function lookupConversationSummary(conversationId, options = {}) {
  const safeId = sanitizeConversationId(conversationId);
  const safeOpts = options && typeof options !== "string" ? options : {};
  const inlineTitle = extractInlinePayloadTitle(safeOpts.payload);
  const inlineCwd = extractPayloadWorkspaceRoot(safeOpts.payload) || decodeFileUriOrPath(safeOpts.cwd || "");
  const inlineParentRaw = sanitizeConversationId(
    safeOpts.payload?.parentConversationId ||
      safeOpts.payload?.parent_conversation_id ||
      safeOpts.payload?.common?.parentConversationId ||
      safeOpts.payload?.common?.parent_conversation_id ||
      safeOpts.payload?.metadata?.parentConversationId ||
      safeOpts.payload?.metadata?.parent_conversation_id ||
      ""
  );
  const inlineParent = inlineParentRaw && inlineParentRaw !== safeId ? inlineParentRaw : "";
  const inlineSubagent = Boolean(
    inlineParent || (safeOpts.payload && isSubagentLeasePayload(safeOpts.payload))
  );
  if (!safeId) {
    return {
      found: false,
      title: inlineTitle,
      cwd: inlineCwd,
      isSubagent: inlineSubagent,
      killed: false,
      archived: false,
      parentConversationId: inlineParent,
      nestingDepth: 0,
      agentName: ""
    };
  }
  if (inlineTitle && inlineCwd && !safeOpts.checkSubagent && !safeOpts.checkArchived) {
    return {
      found: false,
      title: inlineTitle,
      cwd: inlineCwd,
      isSubagent: inlineSubagent,
      killed: false,
      archived: false,
      parentConversationId: inlineParent,
      nestingDepth: 0,
      agentName: ""
    };
  }

  const dbCandidates = resolveCandidateSummaryDbPaths({
    transcriptPath: safeOpts.transcriptPath || "",
    summaryDbPath: safeOpts.summaryDbPath || "",
    allowDefaultDb: safeOpts.allowDefaultDb !== false
  });
  const allowUntitledCustomAgent = safeOpts.allowUntitledCustomAgent !== false;
  const useCache = safeOpts.bypassCache !== true;
  const cacheKey = useCache
    ? `${safeId}\0${allowUntitledCustomAgent ? "1" : "0"}\0${dbCandidates.join("\0")}`
    : "";
  const nowMs = Date.now();
  const diskStamp = useCache ? buildSummaryDiskStamp(dbCandidates, safeId) : "";
  if (useCache) {
    const cached = _summaryLookupCache.get(cacheKey);
    if (cached && nowMs < cached.expiresAt && cached.diskStamp === diskStamp) {
      const r = cached.record;
      return {
        found: r.found,
        title: inlineTitle || r.title,
        cwd: inlineCwd || r.cwd,
        isSubagent: Boolean(inlineSubagent || r.isSubagent),
        killed: r.killed,
        archived: r.archived,
        parentConversationId: inlineParent || r.parentConversationId,
        nestingDepth: r.nestingDepth,
        agentName: r.agentName
      };
    }
  }

  const SUMMARY_SELECT_VARIANTS = [
    "SELECT title, workspace_uris, parent_conversation_id, nesting_depth, agent_name, killed, archived FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    "SELECT title, workspace_uris, parent_conversation_id, nesting_depth, agent_name, killed FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    "SELECT title, workspace_uris, parent_conversation_id, nesting_depth, agent_name FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    "SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ? LIMIT 1"
  ];
  const lookupDeadlineMs =
    Number.isFinite(Number(safeOpts.maxWaitMs)) && Number(safeOpts.maxWaitMs) >= 10
      ? Math.min(5000, Math.floor(Number(safeOpts.maxWaitMs)))
      : 250;
  const lookupStartedAt = Date.now();
  let hadDbError = false;
  let fallbackArchived = false;
  for (const dbPath of dbCandidates) {
    const agRoot = path.dirname(dbPath);
    const annArchived = readConversationAnnotationArchived(agRoot, safeId);
    if (annArchived === true) fallbackArchived = true;
    const remainingMs = lookupDeadlineMs - (Date.now() - lookupStartedAt);
    if (remainingMs <= 0) {
      hadDbError = true;
      break;
    }
    let db = null;
    try {
      if (!fs.existsSync(dbPath)) continue;
      const DatabaseSync = getLazyDatabaseSync();
      const timeoutBudget = Math.max(10, Math.min(remainingMs, 50));
      try {
        db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutBudget });
      } catch {
        db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          db.exec(`PRAGMA busy_timeout = ${timeoutBudget};`);
        } catch {}
      }
      let row = null;
      let lastQueryErr = null;
      for (let i = 0; i < SUMMARY_SELECT_VARIANTS.length; i += 1) {
        const remBeforeQuery = lookupDeadlineMs - (Date.now() - lookupStartedAt);
        if (i > 0 && remBeforeQuery <= 0) {
          hadDbError = true;
          lastQueryErr = new Error("SQLITE_BUSY: lookup deadline exceeded");
          break;
        }
        try {
          row = db.prepare(SUMMARY_SELECT_VARIANTS[i]).get(safeId);
          lastQueryErr = null;
          break;
        } catch (qErr) {
          lastQueryErr = qErr;
          if (!isSqliteMissingColumnError(qErr)) {
            break;
          }
        }
      }
      if (lastQueryErr) {
        throw lastQueryErr;
      }
      const dbParent = readConversationParentId(db, safeId, row?.parent_conversation_id);
      if (row || dbParent) {
        // A delegated conversation may have only a conversation_parents entry.
        row ??= {};
        const dbTitle = typeof row.title === "string" ? sanitizeWatchdogText(row.title, 36) : "";
        const dbCwd = typeof row.workspace_uris === "string" ? parseWorkspaceUriToPath(row.workspace_uris) : "";
        const dbDepth = Number.isFinite(Number(row.nesting_depth))
          ? Math.max(0, Math.floor(Number(row.nesting_depth)))
          : 0;
        const dbAgent = typeof row.agent_name === "string" ? row.agent_name.trim().slice(0, 96) : "";
        const dbKilled = Boolean(row.killed === true || (Number.isFinite(Number(row.killed)) && Number(row.killed) > 0));
        const rowArchived = parseSummaryArchivedColumn(row.archived);
        const ftsErrState = { hadError: false };
        const dbArchived =
          annArchived !== null
            ? annArchived
            : rowArchived !== null
              ? rowArchived
              : readConversationFtsArchived(db, safeId, ftsErrState) === true;
        if (ftsErrState.hadError) hadDbError = true;
        const dbSubagent = isSummaryMetadataSubagent({
          conversationId: safeId,
          parentConversationId: dbParent,
          nestingDepth: dbDepth,
          agentName: dbAgent,
          title: dbTitle,
          allowUntitledCustomAgent
        });
        const record = {
          found: true,
          title: dbTitle,
          cwd: dbCwd,
          isSubagent: dbSubagent,
          killed: dbKilled,
          archived: dbArchived,
          parentConversationId: dbParent,
          nestingDepth: dbDepth,
          agentName: dbAgent
        };
        if (useCache && !hadDbError) {
          rememberSummaryLookupCache(cacheKey, {
            diskStamp,
            expiresAt: nowMs + SUMMARY_LOOKUP_CACHE_TTL_MS,
            record
          });
        }
        return {
          found: true,
          title: inlineTitle || dbTitle,
          cwd: inlineCwd || dbCwd,
          isSubagent: Boolean(inlineSubagent || dbSubagent),
          killed: dbKilled,
          archived: dbArchived,
          parentConversationId: inlineParent || dbParent,
          nestingDepth: dbDepth,
          agentName: dbAgent
        };
      }
      const ftsErrState = { hadError: false };
      if (annArchived === null && readConversationFtsArchived(db, safeId, ftsErrState) === true) {
        fallbackArchived = true;
      }
      if (ftsErrState.hadError) hadDbError = true;
    } catch {
      // Fail-open on locked/corrupt/unreadable summary DB; never negatively cache transient errors
      hadDbError = true;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  const missRecord = {
    found: false,
    title: "",
    cwd: "",
    isSubagent: false,
    killed: false,
    archived: fallbackArchived,
    parentConversationId: "",
    nestingDepth: 0,
    agentName: ""
  };
  if (useCache && !hadDbError) {
    rememberSummaryLookupCache(cacheKey, {
      diskStamp,
      expiresAt: nowMs + SUMMARY_LOOKUP_CACHE_TTL_MS,
      record: missRecord
    });
  }
  return {
    found: false,
    title: inlineTitle,
    cwd: inlineCwd,
    isSubagent: inlineSubagent,
    killed: false,
    archived: fallbackArchived,
    parentConversationId: inlineParent,
    nestingDepth: 0,
    agentName: ""
  };
}

export function lookupConversationTitle(conversationId, options = {}) {
  return lookupConversationSummary(conversationId, options).title;
}

const SUMMARY_RECENT_TIME_COLUMNS = [
  "last_modified_time",
  "updated_at",
  "modified_at",
  "last_updated_ms",
  "updated_ms",
  "last_step_time",
  "created_at"
];

function isSqliteLockError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const code = String(err?.code || err?.errcode || "").toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database is busy") ||
    msg.includes("sqlite_busy") ||
    msg.includes("sqlite_locked") ||
    code.includes("busy") ||
    code.includes("locked")
  );
}

/**
 * Bounded lookup of recently active conversation IDs from a sibling `conversation_summaries.db`
 * alongside a `brain/` directory, honoring a shared wall-clock deadline and reporting
 * lock/budget degradation and ordering precision (`indexed_time` | `small_table_time` | `rowid_heuristic`).
 */
export function queryRecentConversationIdsFromSummaryDb(brainRoot, maxCandidates = 32, options = {}) {
  if (!brainRoot || typeof brainRoot !== "string") {
    return { ids: [], status: "missing", precision: "none" };
  }
  const resolvedRoot = path.resolve(brainRoot);
  if (path.basename(resolvedRoot).toLowerCase() !== "brain") {
    return { ids: [], status: "missing", precision: "none" };
  }
  const agRoot = path.dirname(resolvedRoot);
  if (!agRoot || agRoot === resolvedRoot) {
    return { ids: [], status: "missing", precision: "none" };
  }
  const summaryDbPath = path.join(agRoot, "conversation_summaries.db");
  const limit = Number.isFinite(Number(maxCandidates)) && Number(maxCandidates) >= 1
    ? Math.min(200, Math.floor(Number(maxCandidates)))
    : 32;
  const deadlineMs = Number.isFinite(Number(options?.deadlineMs)) ? Number(options.deadlineMs) : null;
  const remainingMs = () => (deadlineMs === null ? 150 : deadlineMs - Date.now());
  if (deadlineMs !== null && remainingMs() <= 0) {
    return { ids: [], status: "budget_exhausted", precision: "none" };
  }

  let db = null;
  try {
    if (!fs.existsSync(summaryDbPath)) {
      return { ids: [], status: "missing", precision: "none" };
    }
    const remOpen = remainingMs();
    if (deadlineMs !== null && remOpen <= 0) {
      return { ids: [], status: "budget_exhausted", precision: "none" };
    }
    const perOpTimeoutMs = Math.max(1, Math.min(40, Math.floor(remOpen)));
    const DatabaseSync = getLazyDatabaseSync();
    try {
      db = new DatabaseSync(summaryDbPath, { readOnly: true, timeout: perOpTimeoutMs });
    } catch {
      db = new DatabaseSync(summaryDbPath, { readOnly: true });
    }

    const syncBusyTimeout = () => {
      if (deadlineMs === null) return true;
      const rem = remainingMs();
      if (rem <= 0) return false;
      const stepTimeout = Math.max(1, Math.min(35, Math.floor(rem)));
      try {
        db.exec(`PRAGMA busy_timeout = ${stepTimeout}`);
      } catch {}
      return true;
    };

    if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
    const cols = db.prepare("PRAGMA table_info(conversation_summaries)").all();
    const colNames = new Set((cols || []).map((c) => String(c?.name || "").toLowerCase()));
    if (!colNames.has("conversation_id")) {
      return { ids: [], status: "ok", precision: "none" };
    }

    const indexedLeadingCols = new Set();
    if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
    try {
      const idxList = db.prepare("PRAGMA index_list(conversation_summaries)").all();
      for (const idx of idxList || []) {
        if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
        const idxName = typeof idx?.name === "string" ? idx.name : "";
        if (!idxName) continue;
        try {
          const escapedIdx = idxName.replace(/"/g, '""');
          const idxCols = db.prepare(`PRAGMA index_info("${escapedIdx}")`).all();
          const first = (idxCols || []).find((c) => Number(c?.seqno) === 0);
          if (first && typeof first.name === "string") {
            indexedLeadingCols.add(first.name.toLowerCase());
          }
        } catch (idxErr) {
          if (isSqliteLockError(idxErr)) throw idxErr;
        }
      }
    } catch (listErr) {
      if (isSqliteLockError(listErr)) throw listErr;
    }

    const indexedTimeCol = SUMMARY_RECENT_TIME_COLUMNS.find(
      (c) => colNames.has(c) && indexedLeadingCols.has(c)
    );
    let orderCol = indexedTimeCol || "rowid";
    let precision = indexedTimeCol ? "indexed_time" : "rowid_heuristic";
    if (!indexedTimeCol) {
      const plainTimeCol = SUMMARY_RECENT_TIME_COLUMNS.find((c) => colNames.has(c));
      if (plainTimeCol) {
        if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
        // Allow unindexed ORDER BY only on small tables (<= 256 rows); large unindexed tables
        // stay O(log N) via `rowid DESC` without triggering a full-table temp B-tree sort.
        const isLargeTable = Boolean(
          db.prepare("SELECT 1 AS hit FROM conversation_summaries LIMIT 1 OFFSET 256").get()
        );
        if (!isLargeTable) {
          orderCol = plainTimeCol;
          precision = "small_table_time";
        }
      }
    }

    if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
    let rows;
    try {
      rows = db
        .prepare(`SELECT conversation_id FROM conversation_summaries ORDER BY ${orderCol} DESC LIMIT ?`)
        .all(limit);
    } catch (selErr) {
      if (isSqliteLockError(selErr)) throw selErr;
      if (!syncBusyTimeout()) return { ids: [], status: "budget_exhausted", precision: "none" };
      precision = "rowid_heuristic";
      rows = db
        .prepare("SELECT conversation_id FROM conversation_summaries LIMIT ?")
        .all(limit);
    }
    const out = [];
    for (const row of rows || []) {
      const cid = sanitizeConversationId(row?.conversation_id);
      if (cid) out.push(cid);
    }
    return { ids: out, status: "ok", precision };
  } catch (err) {
    if (isSqliteLockError(err)) {
      return { ids: [], status: "locked", precision: "none" };
    }
    return { ids: [], status: "error", precision: "none" };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

/**
 * Bounded O(1) lookup of the most recently active conversation IDs from a sibling
 * `conversation_summaries.db` alongside a `brain/` directory (used to avoid O(N)
 * `brain/` scans under unlimited history while keeping `cache-analyzer.js` SQLite-free).
 */
export function listRecentConversationIdsFromSummaryDb(brainRoot, maxCandidates = 32, options = {}) {
  return queryRecentConversationIdsFromSummaryDb(brainRoot, maxCandidates, options).ids;
}

function firstNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function toFiniteTs(val, fallback = 0) {
  if (val === null || val === undefined || typeof val === "boolean") return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toOptionalNonNegInt(val) {
  if (val === null || val === undefined || val === "" || typeof val === "boolean") return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function parseMaybeJsonObj(val) {
  if (!val) return {};
  if (typeof val === "object" && !Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function unwrapJsonQuotedString(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export function extractBareToolName(rawName) {
  const name = unwrapJsonQuotedString(String(rawName || ""));
  if (!name) return "";
  const colonIdx = name.lastIndexOf(":");
  const afterColon = colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
  const mcpMatch = afterColon.match(/^mcp_+[^_]+_+(.+)$/);
  if (mcpMatch) {
    const tail = mcpMatch[1];
    const known = tail.match(
      /(?:^|_)(ctx_execute|ctx_batch|ctx_index|ctx_search|ctx_resume|ctx_stats|ctx_doctor|ctx_purge|batch_search|apply_edits|read_slices|run_checks)$/
    );
    if (known) return known[1];
    return tail;
  }
  return afterColon;
}

export function isHighReasoningModel(model) {
  if (typeof model !== "string") return false;
  const trimmed = model.trim();
  if (!trimmed) return false;
  if (LOW_OR_MEDIUM_EFFORT_RE.test(trimmed)) return false;
  return HIGH_REASONING_MODEL_RE.test(trimmed);
}

export function deriveLlmSubphase({ contextTokens = 0, mediaCount = 0, isCompactCmd = false, model = "" } = {}) {
  const ctx = Number(contextTokens || 0);
  const media = Number(mediaCount || 0);
  const highReasoning = isHighReasoningModel(model);
  if (ctx >= 500000 || (highReasoning && (ctx >= 250000 || (ctx >= 100000 && media > 0)))) {
    return "reasoning_compound";
  }
  if (highReasoning) return "reasoning";
  if (ctx >= 250000) return "ultra_high_ctx";
  if ((ctx >= 150000 && media > 0) || (ctx >= 100000 && media >= 3)) return "multimodal_high_ctx";
  if (isCompactCmd) return "compact";
  if (ctx >= 120000) return "high_ctx";
  return "normal";
}

export function classifyToolExecutionKind(toolName, rawArgs = {}, options = {}) {
  const args = parseMaybeJsonObj(rawArgs);
  let effectiveName = String(toolName || "").trim();
  let effectiveArgs = args;
  const rawBare = extractBareToolName(effectiveName);
  const wasCallMcpTool = rawBare === "call_mcp_tool";

  if (wasCallMcpTool) {
    const mcpTool = unwrapJsonQuotedString(String(args.ToolName || args.toolName || ""));
    const mcpServer = unwrapJsonQuotedString(String(args.ServerName || args.serverName || ""));
    const mcpArgs = parseMaybeJsonObj(args.Arguments ?? args.arguments);
    effectiveName = mcpTool || (mcpServer ? `mcp:${mcpServer}` : "call_mcp_tool");
    effectiveArgs = mcpArgs;
  }

  const colonIdx = effectiveName.lastIndexOf(":");
  const colonPrefix = colonIdx > 0 ? effectiveName.slice(0, colonIdx).trim() : "";
  const isNamespacedMcp =
    wasCallMcpTool || /^mcp_/i.test(effectiveName) || (colonIdx > 0 && !HOST_NAMESPACE_RE.test(colonPrefix));

  const bare = extractBareToolName(effectiveName);
  const asyncBypassMs = Number.isFinite(Number(options.asyncBypassMs)) ? Number(options.asyncBypassMs) : 2000;

  if (!isNamespacedMcp && bare === "run_command") {
    const cmd = String(
      effectiveArgs.CommandLine ?? effectiveArgs.commandLine ?? effectiveArgs.command ?? ""
    ).trim();
    const isDaemon = Boolean(effectiveArgs.IsDaemon || effectiveArgs.isDaemon);
    const rawWait = effectiveArgs.WaitMsBeforeAsync ?? effectiveArgs.waitMsBeforeAsync;
    const waitMs =
      rawWait !== undefined && rawWait !== null && rawWait !== "" && typeof rawWait !== "boolean"
        ? Number(rawWait)
        : NaN;
    const isAsync = asyncBypassMs > 0 && Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= asyncBypassMs;
    const isBackground = isDaemon || isAsync;
    return {
      activeTool: "run_command",
      activeToolKind: isBackground ? "async_cmd" : "sync_cmd",
      isBackground,
      summary: sanitizeWatchdogText(cmd, 180)
    };
  }

  if (!isNamespacedMcp && (bare === "read_file" || bare === "view_file")) {
    const p = String(
      effectiveArgs.Path ??
        effectiveArgs.path ??
        effectiveArgs.filePath ??
        effectiveArgs.AbsolutePath ??
        effectiveArgs.absolutePath ??
        ""
    ).trim();
    const base = p ? path.basename(p.replace(/[\\/]+$/, "")) : "";
    return {
      activeTool: bare,
      activeToolKind: "read",
      isBackground: false,
      summary: sanitizeWatchdogText(base || p, 120)
    };
  }

  const isSwarmBg =
    bare.toLowerCase() === "swarm" &&
    /^(?:add|wait|spawn|start)$/i.test(String(effectiveArgs.action || effectiveArgs.Action || "").trim());
  if (
    isSwarmBg ||
    SUBAGENT_TOOL_RE.test(bare) ||
    /(?:^|_)(?:subagent|delegate|schedule|manage_task)$/i.test(bare)
  ) {
    const desc =
      effectiveArgs.TaskId ||
      effectiveArgs.taskId ||
      effectiveArgs.Prompt ||
      effectiveArgs.prompt ||
      effectiveArgs.description ||
      effectiveArgs.workflow ||
      effectiveArgs.name ||
      effectiveArgs.code ||
      effectiveArgs.Action ||
      effectiveArgs.action ||
      "";
    return {
      activeTool: bare || effectiveName || "subagent",
      activeToolKind: "subagent",
      isBackground: true,
      summary: sanitizeWatchdogText(desc, 140)
    };
  }

  if (
    bare === "apply_edits" &&
    typeof effectiveArgs.verify === "string" &&
    effectiveArgs.verify.trim() !== ""
  ) {
    return {
      activeTool: "apply_edits",
      activeToolKind: "mcp_long",
      isBackground: false,
      summary: sanitizeWatchdogText(effectiveArgs.verify.trim(), 160)
    };
  }

  if (SLOW_GEN_TOOL_RE.test(bare)) {
    const desc =
      effectiveArgs.ImageName ||
      effectiveArgs.imageName ||
      effectiveArgs.Prompt ||
      effectiveArgs.prompt ||
      "";
    return {
      activeTool: bare,
      activeToolKind: "mcp_long",
      isBackground: false,
      summary: sanitizeWatchdogText(desc, 160)
    };
  }

  if (LONG_MCP_TOOL_RE.test(bare)) {
    const aliasIntent =
      bare === "ctx_execute"
        ? [effectiveArgs.intent, effectiveArgs.summary, effectiveArgs.description].find(
            (v) => typeof v === "string" && v.trim()
          ) || ""
        : effectiveArgs.intent;
    const desc =
      aliasIntent ||
      effectiveArgs.file ||
      (Array.isArray(effectiveArgs.commands)
        ? effectiveArgs.commands
            .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
            .filter(Boolean)
            .slice(0, 3)
            .join(", ")
        : "") ||
      effectiveArgs.language ||
      "";
    return {
      activeTool: bare,
      activeToolKind: "mcp_long",
      isBackground: false,
      summary: sanitizeWatchdogText(desc, 160)
    };
  }

  const fallbackDesc =
    effectiveArgs.Path ||
    effectiveArgs.path ||
    effectiveArgs.TargetFile ||
    effectiveArgs.targetFile ||
    effectiveArgs.SearchPath ||
    effectiveArgs.DirectoryPath ||
    effectiveArgs.query ||
    effectiveArgs.url ||
    effectiveArgs.command ||
    "";
  const isMcpTool = isNamespacedMcp || KNOWN_MCP_TOOL_RE.test(bare);
  return {
    activeTool: bare || effectiveName || "tool",
    activeToolKind: isMcpTool ? "mcp" : "host",
    isBackground: false,
    summary: sanitizeWatchdogText(fallbackDesc, 140)
  };
}

function normalizePendingSlowCalls(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim().slice(0, 80) : "";
    if (!id || seen.has(id)) continue;
    const activeToolKind = typeof item.activeToolKind === "string" ? item.activeToolKind.slice(0, 32) : "";
    if (getToolTimeoutTier(activeToolKind, WATCHDOG_PHASES.TOOL_RUNNING) < 3) continue;
    const activeTool = typeof item.activeTool === "string" ? item.activeTool.slice(0, 80) : "";
    if (!activeTool) continue;
    seen.add(id);
    out.push({
      id,
      activeTool,
      activeToolKind,
      activeToolSummary: sanitizeWatchdogText(item.activeToolSummary || "", 180),
      subphase: typeof item.subphase === "string" && item.subphase ? item.subphase.slice(0, 48) : "sync_cmd",
      phaseChangedTs: toFiniteTs(item.phaseChangedTs, 0)
    });
  }
  return out.slice(-MAX_PENDING_SLOW_CALLS);
}

function extractLivePendingSlowCalls(existing, now, maxAgeMs) {
  if (!existing || existing.phase !== WATCHDOG_PHASES.TOOL_RUNNING) return [];
  const raw = Array.isArray(existing.pendingSlowCalls) ? existing.pendingSlowCalls : [];
  const map = new Map();
  for (const entry of normalizePendingSlowCalls(raw)) {
    if (entry.phaseChangedTs > 0 && now - entry.phaseChangedTs < maxAgeMs) {
      map.set(entry.id, entry);
    }
  }
  if (
    existing.activeToolCallId &&
    getToolTimeoutTier(existing.activeToolKind, existing.phase) >= 3 &&
    existing.phaseChangedTs > 0 &&
    now - existing.phaseChangedTs < maxAgeMs &&
    !map.has(existing.activeToolCallId)
  ) {
    map.set(existing.activeToolCallId, {
      id: existing.activeToolCallId,
      activeTool: existing.activeTool || "run_command",
      activeToolKind: existing.activeToolKind,
      activeToolSummary: existing.activeToolSummary || "",
      subphase: existing.subphase || "sync_cmd",
      phaseChangedTs: existing.phaseChangedTs
    });
  }
  return Array.from(map.values()).slice(-MAX_PENDING_SLOW_CALLS);
}

export function normalizeWatchdogLease(raw, fallbackConvId = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const conversationId = sanitizeConversationId(raw.conversationId || fallbackConvId);
  if (!conversationId) return null;
  const validPhases = new Set(Object.values(WATCHDOG_PHASES));
  const phase = validPhases.has(raw.phase) ? raw.phase : WATCHDOG_PHASES.IDLE;
  const updatedTs = toFiniteTs(raw.updatedTs, 0);
  const startedTs = toFiniteTs(raw.startedTs, updatedTs);
  const phaseChangedTs = toFiniteTs(raw.phaseChangedTs, updatedTs);
  const lastHeartbeatTs = Math.max(toFiniteTs(raw.lastHeartbeatTs, 0), updatedTs);
  return {
    v: 1,
    conversationId,
    rootSessionId: sanitizeConversationId(raw.rootSessionId) || conversationId,
    parentConversationId: sanitizeConversationId(raw.parentConversationId) || "",
    isSubagent: Boolean(raw.isSubagent),
    phase,
    subphase: typeof raw.subphase === "string" ? raw.subphase.slice(0, 48) : "",
    startedTs,
    phaseChangedTs,
    updatedTs,
    lastHeartbeatTs,
    hookEvent: typeof raw.hookEvent === "string" ? raw.hookEvent.slice(0, 32) : "",
    invocationNum: toOptionalNonNegInt(raw.invocationNum),
    initialNumSteps: toOptionalNonNegInt(raw.initialNumSteps),
    lastUserInput: sanitizeWatchdogText(raw.lastUserInput || "", 240),
    isCompactCmd: Boolean(raw.isCompactCmd),
    activeTool: typeof raw.activeTool === "string" ? raw.activeTool.slice(0, 80) : "",
    activeToolKind: typeof raw.activeToolKind === "string" ? raw.activeToolKind.slice(0, 32) : "",
    activeToolSummary: sanitizeWatchdogText(raw.activeToolSummary || "", 180),
    activeToolCallId:
      (phase === WATCHDOG_PHASES.TOOL_RUNNING || phase === WATCHDOG_PHASES.SUBAGENT_BG) &&
      typeof raw.activeToolCallId === "string"
        ? raw.activeToolCallId.trim().slice(0, 80)
        : "",
    pendingSlowCalls:
      phase === WATCHDOG_PHASES.TOOL_RUNNING ? normalizePendingSlowCalls(raw.pendingSlowCalls) : [],
    lastCompletedTool: typeof raw.lastCompletedTool === "string" ? raw.lastCompletedTool.slice(0, 80) : "",
    lastCompletedToolTs: toFiniteTs(raw.lastCompletedToolTs, 0),
    cwd: sanitizeCwd(raw.cwd || ""),
    workspaceLabel: sanitizeWatchdogText(raw.workspaceLabel || "", 48),
    convTitle: sanitizeWatchdogText(raw.convTitle || "", 36),
    transcriptPath:
      typeof raw.transcriptPath === "string" &&
      !raw.transcriptPath.includes("\0") &&
      !/^[\\/]{2}/.test(raw.transcriptPath.trim())
        ? raw.transcriptPath.trim().slice(0, 512)
        : "",
    transcriptMtimeMs:
      Number.isFinite(Number(raw.transcriptMtimeMs)) && Number(raw.transcriptMtimeMs) > 0
        ? Number(raw.transcriptMtimeMs)
        : 0,
    transcriptSize:
      Number.isFinite(Number(raw.transcriptSize)) && Number(raw.transcriptSize) >= 0
        ? Math.floor(Number(raw.transcriptSize))
        : 0,
    contextTokens:
      Number.isFinite(Number(raw.contextTokens)) && Number(raw.contextTokens) >= 0
        ? Math.floor(Number(raw.contextTokens))
        : 0,
    windowTokens:
      Number.isFinite(Number(raw.windowTokens)) && Number(raw.windowTokens) >= 0
        ? Math.floor(Number(raw.windowTokens))
        : 0,
    warnTokens:
      Number.isFinite(Number(raw.warnTokens)) && Number(raw.warnTokens) >= 0
        ? Math.floor(Number(raw.warnTokens))
        : 0,
    criticalTokens:
      Number.isFinite(Number(raw.criticalTokens)) && Number(raw.criticalTokens) >= 0
        ? Math.floor(Number(raw.criticalTokens))
        : 0,
    watermark:
      typeof raw.watermark === "string" &&
      (raw.watermark === "ok" || raw.watermark === "warn" || raw.watermark === "critical")
        ? raw.watermark
        : "",
    mediaCount:
      Number.isFinite(Number(raw.mediaCount)) && Number(raw.mediaCount) >= 0
        ? Math.floor(Number(raw.mediaCount))
        : 0,
    model: typeof raw.model === "string" ? raw.model.slice(0, 96) : "",
    cacheTtlSec:
      Number.isFinite(Number(raw.cacheTtlSec)) && Number(raw.cacheTtlSec) > 0
        ? Math.floor(Number(raw.cacheTtlSec))
        : 0,
    ttlSource:
      typeof raw.ttlSource === "string" &&
      (raw.ttlSource === "explicit" || raw.ttlSource === "empirical" || raw.ttlSource === "profile")
        ? raw.ttlSource
        : "",
    idleAnchorTs: toFiniteTs(raw.idleAnchorTs, 0),
    cacheOriginTs: (() => {
      const rawIdle = toFiniteTs(raw.idleAnchorTs, 0);
      const rawOrigin = toFiniteTs(raw.cacheOriginTs, 0);
      if (phase === WATCHDOG_PHASES.IDLE && rawIdle > 0 && rawOrigin > rawIdle) {
        return rawIdle;
      }
      return rawOrigin;
    })(),
    lastLlmStartTs: toFiniteTs(raw.lastLlmStartTs, 0),
    stopReason: raw.stopReason ? sanitizeWatchdogText(raw.stopReason, 120) : "",
    ackedUntilTs: toFiniteTs(raw.ackedUntilTs, 0)
  };
}

export function readWatchdogLease(store, conversationId) {
  if (!store || typeof store.getMeta !== "function") return null;
  const key = getWatchdogLeaseKey(conversationId);
  if (!key) return null;
  try {
    const raw = store.getMeta(key, null);
    if (!raw || typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    return normalizeWatchdogLease(parsed, conversationId);
  } catch {
    return null;
  }
}

export function writeWatchdogLease(store, lease) {
  if (!store || typeof store.setMeta !== "function" || !lease) return null;
  const normalized = normalizeWatchdogLease(lease, lease.conversationId);
  if (!normalized) return null;
  const key = getWatchdogLeaseKey(normalized.conversationId);
  if (!key) return null;
  store.setMeta(key, JSON.stringify(normalized));
  return normalized;
}

/**
 * Atomic compare-and-swap lease write preventing TOCTOU races between Sidecar
 * background self-healing / startup cleanup and concurrent lifecycle hooks.
 */
export function writeWatchdogLeaseIfUnchanged(store, expectedUpdatedTs, expectedPhase, nextLease) {
  if (!store || !nextLease) return { written: false, current: null };
  const normalized = normalizeWatchdogLease(nextLease, nextLease.conversationId);
  if (!normalized) return { written: false, current: null };
  const key = getWatchdogLeaseKey(normalized.conversationId);
  if (!key) return { written: false, current: null };

  const execCas = () => {
    const current = readWatchdogLease(store, normalized.conversationId);
    if (!current) return { written: false, current: null };
    if (current.updatedTs !== expectedUpdatedTs || current.phase !== expectedPhase) {
      return { written: false, current };
    }
    store.setMeta(key, JSON.stringify(normalized));
    return { written: true, lease: normalized, current: normalized };
  };

  if (typeof store._withWriteTx === "function") {
    if (typeof store.open === "function") store.open();
    return store._withWriteTx(execCas);
  }
  return execCas();
}

/**
 * Atomic compare-and-swap lease deletion preventing TOCTOU races when periodic
 * IDLE lease pruning runs concurrently with hooks resuming the same conversation.
 */
export function deleteWatchdogLeaseIfUnchanged(store, conversationId, expectedUpdatedTs, expectedPhase) {
  if (!store) return { deleted: false, current: null };
  const cleanId = sanitizeConversationId(conversationId);
  const key = getWatchdogLeaseKey(cleanId);
  if (!cleanId || !key) return { deleted: false, current: null };

  const execCas = () => {
    const current = readWatchdogLease(store, cleanId);
    if (!current) return { deleted: true, current: null };
    if (
      current.updatedTs !== expectedUpdatedTs ||
      current.phase !== expectedPhase ||
      current.subphase === "stopped_bg_pending"
    ) {
      return { deleted: false, current };
    }
    store.deleteMeta?.(key);
    return { deleted: true, current: null };
  };

  if (typeof store._withWriteTx === "function") {
    if (typeof store.open === "function") store.open();
    return store._withWriteTx(execCas);
  }
  return execCas();
}

export function listWatchdogLeases(store) {
  if (!store) return [];
  try {
    let rows = [];
    if (typeof store.listMetaByPrefix === "function") {
      rows = store.listMetaByPrefix(WATCHDOG_LEASE_PREFIX);
    } else if (store.db) {
      rows = store.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'watchdog_lease:%' ORDER BY key ASC")
        .all();
    }
    const leases = [];
    for (const row of rows || []) {
      if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
      const convIdFromKey = row.key.slice(WATCHDOG_LEASE_PREFIX.length);
      try {
        const parsed = JSON.parse(row.value);
        const norm = normalizeWatchdogLease(parsed, convIdFromKey);
        if (norm) leases.push(norm);
      } catch {
        // Ignore corrupted lease JSON
      }
    }
    return leases;
  } catch {
    return [];
  }
}

export function recordHookLeaseTransition(store, eventName, payload = {}, options = {}) {
  if (!store) return null;
  const safePayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const safeOptions = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const now = Number.isFinite(safeOptions.nowMs) ? Math.floor(safeOptions.nowMs) : Date.now();
  const directConvId = sanitizeConversationId(
    safeOptions.directConvId ||
      safePayload.conversationId ||
      safePayload.conversation_id ||
      safePayload.sessionId ||
      safePayload.session_id ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      ""
  );
  if (!directConvId) return null;

  const rootSessionId =
    sanitizeConversationId(
      safeOptions.rootSessionId ||
        safePayload.rootConversationId ||
        safePayload.root_conversation_id ||
        safePayload.parentConversationId ||
        safePayload.parent_conversation_id ||
        process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
        process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
        ""
    ) || directConvId;
  let parentConversationId = sanitizeConversationId(
    safeOptions.parentConversationId ||
      safePayload.parentConversationId ||
      safePayload.parent_conversation_id ||
      process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
      ""
  );
  const rawPromptForHeadlessCheck =
    typeof (safePayload.lastUserInput ?? safePayload.last_user_input) === "string"
      ? String(safePayload.lastUserInput ?? safePayload.last_user_input)
      : "";
  let isSubagent = safeOptions.suppressPayloadSubagent
    ? Boolean(safeOptions.isSubagent)
    : Boolean(
        safeOptions.isSubagent ||
          (parentConversationId && parentConversationId !== directConvId) ||
          (rootSessionId && rootSessionId !== directConvId) ||
          isSubagentLeasePayload(safePayload) ||
          isHeadlessWorkerPrompt(rawPromptForHeadlessCheck)
      );

  const existing = readWatchdogLease(store, directConvId);
  const base = existing || {
    v: 1,
    conversationId: directConvId,
    rootSessionId,
    parentConversationId: parentConversationId && parentConversationId !== directConvId ? parentConversationId : "",
    isSubagent,
    phase: WATCHDOG_PHASES.IDLE,
    subphase: "",
    startedTs: now,
    phaseChangedTs: now,
    updatedTs: now,
    lastHeartbeatTs: now,
    hookEvent: eventName,
    invocationNum: null,
    initialNumSteps: null,
    lastUserInput: "",
    isCompactCmd: false,
    activeTool: "",
    activeToolKind: "",
    activeToolSummary: "",
    activeToolCallId: "",
    pendingSlowCalls: [],
    lastCompletedTool: "",
    lastCompletedToolTs: 0,
    cwd: "",
    workspaceLabel: "",
    convTitle: "",
    transcriptPath: "",
    transcriptMtimeMs: 0,
    transcriptSize: 0,
    contextTokens: 0,
    windowTokens: 0,
    warnTokens: 0,
    criticalTokens: 0,
    watermark: "",
    mediaCount: 0,
    model: "",
    cacheTtlSec: 0,
    ttlSource: "",
    idleAnchorTs: 0,
    cacheOriginTs: 0,
    lastLlmStartTs: 0,
    stopReason: "",
    ackedUntilTs: 0
  };

  const resolvedTranscriptPath =
    (typeof safeOptions.transcriptPath === "string" && safeOptions.transcriptPath.trim()) ||
    (typeof safePayload.transcriptPath === "string" && safePayload.transcriptPath.trim()) ||
    (typeof safePayload.transcript_path === "string" && safePayload.transcript_path.trim()) ||
    base.transcriptPath;

  let resolvedCwd =
    sanitizeCwd(safeOptions.cwd || extractPayloadWorkspaceRoot(safePayload) || "") || base.cwd;

  let resolvedTitle = "";
  if (typeof safeOptions.convTitle === "string" && safeOptions.convTitle.trim()) {
    resolvedTitle = sanitizeWatchdogText(safeOptions.convTitle, 36);
  } else {
    resolvedTitle = extractInlinePayloadTitle(safePayload);
  }
  if (
    (!resolvedTitle || !resolvedCwd || (!isSubagent && !base.isSubagent && !base.convTitle)) &&
    (safeOptions.summaryDbPath || safeOptions.lookupSummary === true)
  ) {
    const summary = lookupConversationSummary(directConvId, {
      payload: safePayload,
      cwd: resolvedCwd,
      transcriptPath: resolvedTranscriptPath,
      summaryDbPath: safeOptions.summaryDbPath || "",
      allowDefaultDb: safeOptions.allowDefaultDb !== false,
      checkSubagent: !isSubagent && !base.isSubagent
    });
    if (!resolvedTitle && summary.title) resolvedTitle = summary.title;
    if (!resolvedCwd && summary.cwd) resolvedCwd = summary.cwd;
    if (summary.isSubagent) isSubagent = true;
    if (!parentConversationId && summary.parentConversationId && summary.parentConversationId !== directConvId) {
      parentConversationId = summary.parentConversationId;
    }
  }

  let resolvedWorkspaceLabel = base.workspaceLabel || "";
  if (typeof safeOptions.workspaceLabel === "string" && safeOptions.workspaceLabel.trim()) {
    resolvedWorkspaceLabel = sanitizeWatchdogText(safeOptions.workspaceLabel, 48);
  } else if (resolvedCwd) {
    const computedWs = formatWorkspaceWindowLabel(resolvedCwd, safeOptions.modifiedOrReadPaths || []);
    if (
      base.workspaceLabel &&
      base.cwd &&
      isSameWorkspacePath(base.cwd, resolvedCwd) &&
      computedWs &&
      base.workspaceLabel.toLowerCase().startsWith(`${computedWs.toLowerCase()}/`)
    ) {
      resolvedWorkspaceLabel = base.workspaceLabel;
    } else if (computedWs) {
      resolvedWorkspaceLabel = computedWs;
    }
  }

  const effectiveRootSessionId =
    rootSessionId && rootSessionId !== directConvId
      ? rootSessionId
      : base.rootSessionId && base.rootSessionId !== directConvId
        ? base.rootSessionId
        : parentConversationId && parentConversationId !== directConvId
          ? parentConversationId
          : directConvId;

  const next = {
    ...base,
    conversationId: directConvId,
    rootSessionId: effectiveRootSessionId,
    parentConversationId:
      parentConversationId && parentConversationId !== directConvId
        ? parentConversationId
        : base.parentConversationId || "",
    isSubagent: isSubagent || base.isSubagent,
    cwd: resolvedCwd,
    workspaceLabel: resolvedWorkspaceLabel,
    convTitle: resolvedTitle || base.convTitle || "",
    transcriptPath: resolvedTranscriptPath,
    updatedTs: now,
    lastHeartbeatTs: Math.max(base.lastHeartbeatTs || 0, now),
    hookEvent: eventName,
    ackedUntilTs: 0
  };

  if (Number.isFinite(safeOptions.transcriptSize) && safeOptions.transcriptSize >= 0) {
    next.transcriptSize = Math.floor(safeOptions.transcriptSize);
    if (next.transcriptSize === 0 && !(Number.isFinite(safeOptions.transcriptMtimeMs) && safeOptions.transcriptMtimeMs > 0)) {
      next.transcriptMtimeMs = 0;
    }
  }
  if (Number.isFinite(safeOptions.transcriptMtimeMs) && safeOptions.transcriptMtimeMs > 0) {
    next.transcriptMtimeMs = safeOptions.transcriptMtimeMs;
  }
  if (Number.isFinite(safeOptions.contextTokens) && safeOptions.contextTokens >= 0) {
    next.contextTokens = Math.floor(safeOptions.contextTokens);
  }
  if (Number.isFinite(safeOptions.windowTokens) && safeOptions.windowTokens > 0) {
    next.windowTokens = Math.floor(safeOptions.windowTokens);
  }
  if (Number.isFinite(safeOptions.warnTokens) && safeOptions.warnTokens > 0) {
    next.warnTokens = Math.floor(safeOptions.warnTokens);
  }
  if (Number.isFinite(safeOptions.criticalTokens) && safeOptions.criticalTokens > 0) {
    next.criticalTokens = Math.floor(safeOptions.criticalTokens);
  }
  if (
    typeof safeOptions.watermark === "string" &&
    (safeOptions.watermark === "ok" || safeOptions.watermark === "warn" || safeOptions.watermark === "critical")
  ) {
    next.watermark = safeOptions.watermark;
  }
  if (Number.isFinite(safeOptions.mediaCount) && safeOptions.mediaCount >= 0) {
    next.mediaCount = Math.floor(safeOptions.mediaCount);
  }
  if (typeof safeOptions.model === "string" && safeOptions.model.trim()) {
    next.model = safeOptions.model.trim().slice(0, 96);
  }
  if (Number.isFinite(safeOptions.cacheTtlSec) && safeOptions.cacheTtlSec > 0) {
    next.cacheTtlSec = Math.floor(safeOptions.cacheTtlSec);
  }
  if (
    typeof safeOptions.ttlSource === "string" &&
    (safeOptions.ttlSource === "explicit" ||
      safeOptions.ttlSource === "empirical" ||
      safeOptions.ttlSource === "profile")
  ) {
    next.ttlSource = safeOptions.ttlSource;
  }

  if (eventName === "PreInvocation") {
    const invNum = toOptionalNonNegInt(safePayload.invocationNum ?? safePayload.invocation_num);
    const initSteps = toOptionalNonNegInt(safePayload.initialNumSteps ?? safePayload.initial_num_steps);
    const rawInput =
      typeof (safePayload.lastUserInput ?? safePayload.last_user_input) === "string"
        ? String(safePayload.lastUserInput ?? safePayload.last_user_input)
        : "";
    const isMidTurn = invNum !== null && invNum >= 1;
    const isKeepaliveInput = Boolean(safeOptions.isKeepaliveTurn) || isTtlKeepalivePrompt(rawInput);
    const isSyntheticWake = isKeepaliveInput || Boolean(safeOptions.isBackgroundWakeup);
    if (rawInput.trim() && !isSyntheticWake) {
      next.lastUserInput = sanitizeWatchdogText(rawInput, 240);
      next.isCompactCmd = SLASH_COMPACT_RE.test(rawInput);
    } else if (!isMidTurn || isSyntheticWake) {
      next.isCompactCmd = false;
    }
    if (invNum !== null) next.invocationNum = invNum;
    if (initSteps !== null) next.initialNumSteps = initSteps;

    next.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
    next.subphase = deriveLlmSubphase({
      contextTokens: next.contextTokens,
      mediaCount: next.mediaCount,
      isCompactCmd: next.isCompactCmd,
      model: next.model
    });
    if (!isMidTurn || !existing || existing.phase === WATCHDOG_PHASES.IDLE) {
      next.startedTs = now;
    }
    next.phaseChangedTs = now;
    next.idleAnchorTs = now;
    next.lastLlmStartTs = now;
    next.cacheOriginTs =
      Number.isFinite(safeOptions.cacheOriginTs) && safeOptions.cacheOriginTs > 0
        ? Math.floor(safeOptions.cacheOriginTs)
        : now;
    next.activeTool = "";
    next.activeToolKind = "";
    next.activeToolSummary = "";
    next.activeToolCallId = "";
    next.pendingSlowCalls = [];
    next.stopReason = "";
  } else if (eventName === "PreToolUse") {
    const toolCall = safePayload.toolCall && typeof safePayload.toolCall === "object" ? safePayload.toolCall : {};
    const toolName = safeOptions.toolName || toolCall.name || "";
    const toolArgs = safeOptions.toolArgs || toolCall.args || {};
    const toolCallId = firstNonEmptyString(
      safeOptions.toolCallId,
      toolCall.id,
      toolCall.call_id,
      safePayload.toolCallId,
      safePayload.tool_call_id
    ).slice(0, 80);
    const decision = safeOptions.decision || "allow";
    const cls = classifyToolExecutionKind(toolName, toolArgs, {
      asyncBypassMs: safeOptions.asyncBypassMs
    });
    const incomingPhase = cls.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING;
    const incomingTier = getToolTimeoutTier(cls.activeToolKind, incomingPhase);
    const existingTier = existing ? getToolTimeoutTier(existing.activeToolKind, existing.phase) : 0;
    const recentPendingSlow = extractLivePendingSlowCalls(existing, now, 60_000);
    const existingSlowToolRunning = Boolean(
      existing &&
        existing.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
        existingTier >= 3 &&
        now - (existing.phaseChangedTs || 0) < 60_000
    );
    const preserveLowerTierParallel = Boolean(
      !cls.isBackground &&
        existingSlowToolRunning &&
        incomingTier < existingTier &&
        cls.activeTool !== existing.activeTool
    );
    const otherSlowOnDeny =
      decision === "deny" && toolCallId ? recentPendingSlow.filter((c) => c.id !== toolCallId) : [];

    if (preserveLowerTierParallel) {
      // Parallel fast/lower-tier tool (read_file / edit_file / fast MCP) alongside an in-flight
      // sync_cmd/mcp_long must NOT downgrade the timeout tier to 90s or reset phase to LLM_INFLIGHT on deny.
      next.phase = existing.phase;
      next.subphase = existing.subphase;
      next.activeTool = existing.activeTool;
      next.activeToolKind = existing.activeToolKind;
      next.activeToolSummary = existing.activeToolSummary;
      next.activeToolCallId = existing.activeToolCallId || "";
      next.pendingSlowCalls = recentPendingSlow;
      next.phaseChangedTs = existing.phaseChangedTs;
      next.stopReason = "";
    } else if (otherSlowOnDeny.length > 0) {
      // Denied parallel tool with a distinct toolCall.id must NOT clobber another in-flight slow tool.
      const keep =
        otherSlowOnDeny.find((c) => c.id === existing?.activeToolCallId) ||
        otherSlowOnDeny[otherSlowOnDeny.length - 1];
      next.phase = WATCHDOG_PHASES.TOOL_RUNNING;
      next.subphase = keep.subphase || "sync_cmd";
      next.activeTool = keep.activeTool;
      next.activeToolKind = keep.activeToolKind;
      next.activeToolSummary = keep.activeToolSummary;
      next.activeToolCallId = keep.id;
      next.pendingSlowCalls = otherSlowOnDeny;
      next.phaseChangedTs = keep.phaseChangedTs || existing.phaseChangedTs;
      next.stopReason = "";
    } else if (decision === "deny") {
      next.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
      next.subphase = deriveLlmSubphase({
        contextTokens: next.contextTokens,
        mediaCount: next.mediaCount,
        isCompactCmd: next.isCompactCmd,
        model: next.model
      });
      next.activeTool = "";
      next.activeToolKind = "";
      next.activeToolSummary = "";
      next.activeToolCallId = "";
      next.pendingSlowCalls = [];
      next.phaseChangedTs = now;
      next.lastLlmStartTs = now;
      next.cacheOriginTs = now;
      next.stopReason = "";
    } else {
      if (cls.isBackground) {
        next.phase = WATCHDOG_PHASES.SUBAGENT_BG;
        next.subphase = cls.activeToolKind;
        next.pendingSlowCalls = [];
      } else {
        next.phase = WATCHDOG_PHASES.TOOL_RUNNING;
        next.subphase =
          cls.activeToolKind === "sync_cmd" || cls.activeToolKind === "mcp_long" ? "sync_cmd" : "read_or_mcp";
        if (incomingTier >= 3 && toolCallId) {
          const filtered = recentPendingSlow.filter((c) => c.id !== toolCallId);
          filtered.push({
            id: toolCallId,
            activeTool: cls.activeTool,
            activeToolKind: cls.activeToolKind,
            activeToolSummary: cls.summary,
            subphase: next.subphase,
            phaseChangedTs: now
          });
          next.pendingSlowCalls = filtered.slice(-MAX_PENDING_SLOW_CALLS);
        } else {
          next.pendingSlowCalls = [];
        }
      }
      if (!existing || existing.phase === WATCHDOG_PHASES.IDLE) {
        next.startedTs = now;
      }
      next.activeTool = cls.activeTool;
      next.activeToolKind = cls.activeToolKind;
      next.activeToolSummary = cls.summary;
      next.activeToolCallId = toolCallId;
      next.phaseChangedTs = now;
      next.stopReason = "";
    }
  } else if (eventName === "PostToolUse") {
    const toolCall = safePayload.toolCall && typeof safePayload.toolCall === "object" ? safePayload.toolCall : {};
    const toolName = safeOptions.toolName || toolCall.name || "";
    const toolArgs = safeOptions.toolArgs || toolCall.args || {};
    const toolCallId = firstNonEmptyString(
      safeOptions.toolCallId,
      toolCall.id,
      toolCall.call_id,
      safePayload.toolCallId,
      safePayload.tool_call_id
    ).slice(0, 80);
    const responseText = typeof safeOptions.responseText === "string" ? safeOptions.responseText : "";
    const cls = classifyToolExecutionKind(toolName, toolArgs, {
      asyncBypassMs: safeOptions.asyncBypassMs
    });
    const launchedBg = cls.isBackground || (responseText && BG_RESPONSE_RE.test(responseText));
    const existingTier = existing ? getToolTimeoutTier(existing.activeToolKind, existing.phase) : 0;
    const completedTier = getToolTimeoutTier(cls.activeToolKind, WATCHDOG_PHASES.TOOL_RUNNING);
    const livePendingSlow = extractLivePendingSlowCalls(existing, now, 600_000);
    const remainingPendingSlow = toolCallId
      ? livePendingSlow.filter((c) => c.id !== toolCallId)
      : livePendingSlow;
    const matchedActiveById = Boolean(toolCallId && existing?.activeToolCallId && toolCallId === existing.activeToolCallId);
    const preserveByPendingCallId = Boolean(
      !launchedBg &&
        String(toolName || "").trim() &&
        toolCallId &&
        existing &&
        existing.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
        existingTier >= 3 &&
        remainingPendingSlow.length > 0
    );
    const preserveExistingSlowTool = Boolean(
      !launchedBg &&
        !matchedActiveById &&
        String(toolName || "").trim() &&
        existing &&
        existing.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
        existingTier >= 3 &&
        completedTier < existingTier &&
        cls.activeTool !== existing.activeTool &&
        now - (existing.phaseChangedTs || 0) < 600_000
    );

    next.lastCompletedTool = cls.activeTool || next.activeTool || "";
    next.lastCompletedToolTs = now;
    next.idleAnchorTs = now;
    if (launchedBg) {
      next.phase = WATCHDOG_PHASES.SUBAGENT_BG;
      next.subphase = cls.activeToolKind === "subagent" ? "subagent_bg" : "bg_task";
      next.activeTool = cls.activeTool;
      next.activeToolKind = cls.isBackground ? cls.activeToolKind : "async_cmd";
      next.activeToolSummary = cls.summary || next.activeToolSummary;
      next.activeToolCallId = toolCallId;
      next.pendingSlowCalls = [];
      next.phaseChangedTs = now;
    } else if (preserveByPendingCallId) {
      // Another tracked parallel slow call (same tool or peer tier-3) with a distinct toolCall.id
      // is still in flight; keep or restore its 300s lease instead of dropping to LLM_INFLIGHT.
      const keep =
        remainingPendingSlow.find((c) => c.id === existing.activeToolCallId) ||
        remainingPendingSlow[remainingPendingSlow.length - 1];
      next.phase = WATCHDOG_PHASES.TOOL_RUNNING;
      next.subphase = keep.subphase || existing.subphase || "sync_cmd";
      next.activeTool = keep.activeTool;
      next.activeToolKind = keep.activeToolKind;
      next.activeToolSummary = keep.activeToolSummary;
      next.activeToolCallId = keep.id;
      next.pendingSlowCalls = remainingPendingSlow;
      next.phaseChangedTs = keep.phaseChangedTs || existing.phaseChangedTs;
    } else if (preserveExistingSlowTool) {
      // Parallel fast tool completion (e.g. edit_file / apply_edits / read_file) while a
      // higher-tier blocking tool (sync_cmd / mcp_long, 300s budget) is still running must
      // NOT clobber the active slow tool lease back to LLM_INFLIGHT (120s budget).
      next.phase = existing.phase;
      next.subphase = existing.subphase;
      next.activeTool = existing.activeTool;
      next.activeToolKind = existing.activeToolKind;
      next.activeToolSummary = existing.activeToolSummary;
      next.activeToolCallId = existing.activeToolCallId || "";
      next.pendingSlowCalls = remainingPendingSlow;
      next.phaseChangedTs = existing.phaseChangedTs;
    } else {
      next.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
      next.subphase = deriveLlmSubphase({
        contextTokens: next.contextTokens,
        mediaCount: next.mediaCount,
        isCompactCmd: next.isCompactCmd,
        model: next.model
      });
      next.activeTool = "";
      next.activeToolKind = "";
      next.activeToolSummary = "";
      next.activeToolCallId = "";
      next.pendingSlowCalls = [];
      next.phaseChangedTs = now;
      next.lastLlmStartTs = now;
      next.cacheOriginTs = now;
    }
    if (!existing || existing.phase === WATCHDOG_PHASES.IDLE) {
      next.startedTs = now;
    }
    next.stopReason = "";
  } else if (eventName === "Stop") {
    const explicitReason = firstNonEmptyString(
      safeOptions.stopReason,
      safePayload.terminationReason,
      safePayload.termination_reason,
      safePayload.stopReason,
      safePayload.stop_reason,
      safePayload.endReason,
      safePayload.end_reason,
      safePayload.reason
    );
    const rawErrorSource = safeOptions.error !== undefined ? safeOptions.error : safePayload.error;
    const rawError =
      typeof rawErrorSource === "string"
        ? rawErrorSource.trim()
        : rawErrorSource && typeof rawErrorSource.message === "string"
          ? rawErrorSource.message.trim()
          : "";
    const rawReason = explicitReason || (rawError ? "ERROR" : "stop_hook");
    const normalizedUpperReason = rawReason.toUpperCase().replace(/^EXECUTOR_TERMINATION_REASON_/, "");
    const isAbortOrError =
      normalizedUpperReason === "USER_CANCELED" ||
      normalizedUpperReason === "USER_CANCELLED" ||
      normalizedUpperReason === "ERROR";
    const rawFullyIdle =
      safeOptions.fullyIdle !== undefined
        ? safeOptions.fullyIdle
        : safePayload.fullyIdle !== undefined
          ? safePayload.fullyIdle
          : safePayload.fully_idle;
    const formattedReason =
      normalizedUpperReason === "ERROR" && rawError
        ? `${normalizedUpperReason}: ${rawError}`
        : rawReason;

    const turnFloorTs = base.startedTs > 0 && base.startedTs <= now ? base.startedTs : 0;
    const causalLlmFloorTs = computeCausalTurnLlmFloorTs(base, now);
    const optOriginTs =
      Number.isFinite(safeOptions.cacheOriginTs) && safeOptions.cacheOriginTs > 0
        ? Math.floor(safeOptions.cacheOriginTs)
        : 0;
    let resolvedCacheOriginTs = now;
    if (
      optOriginTs > 0 &&
      optOriginTs <= now + 5_000 &&
      (turnFloorTs === 0 || optOriginTs >= turnFloorTs - 5_000) &&
      (causalLlmFloorTs === 0 || optOriginTs >= causalLlmFloorTs - 5_000) &&
      now - optOriginTs <= 30 * 60 * 1000
    ) {
      resolvedCacheOriginTs = Math.min(now, optOriginTs);
    } else if (causalLlmFloorTs > 0) {
      resolvedCacheOriginTs = causalLlmFloorTs;
    }

    next.phase = WATCHDOG_PHASES.IDLE;
    next.subphase = rawFullyIdle === false && !isAbortOrError ? "stopped_bg_pending" : "stopped";
    next.activeTool = "";
    next.activeToolKind = "";
    next.activeToolSummary = "";
    next.activeToolCallId = "";
    next.pendingSlowCalls = [];
    next.transcriptSize = 0;
    next.transcriptMtimeMs = 0;
    next.phaseChangedTs = now;
    next.idleAnchorTs = now;
    next.cacheOriginTs = resolvedCacheOriginTs;
    next.lastLlmStartTs = 0;
    next.stopReason = sanitizeWatchdogText(formattedReason, 120);
  }

  return writeWatchdogLease(store, next);
}
