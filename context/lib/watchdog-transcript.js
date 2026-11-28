/**
 * Lightweight Watchdog transcript genesis & tail-step inspection helpers.
 * Separated from `watchdog-lease-core.js` so high-frequency hooks (`PreToolUse`,
 * `PostToolUse`) do not parse transcript I/O logic unless explicitly needed.
 */
import fs from "node:fs";
import {
  extractBareToolName,
  HEADLESS_FINISH_PROMPT_RE,
  isHeadlessWorkerPrompt,
  isSummaryMetadataSubagent,
  isTtlKeepalivePrompt,
  sanitizeConversationId,
  SUBAGENT_GENESIS_SYS_MSG_RE
} from "./watchdog-lease-core.js";

const ISO_SUBSECOND_RE = /:\d{2}\.\d+/;
const TTL_KEEPALIVE_ROUND_RE = /\[agy-dart TTL(?:保活| Keepalive)\s+(\d+)\/\d+\]/i;
const TTL_KEEPALIVE_MANUAL_RE = /\[agy-dart TTL(?:保活\s*手动| Keepalive\s+Manual)(?:\s|\])/i;

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

function isEmbeddedSubagentStepLite(step) {
  if (!step || typeof step !== "object") return false;
  if (step.is_subagent === true || step.isSubagent === true) return true;
  if (typeof step.parent_conversation_id === "string" && step.parent_conversation_id.trim()) return true;
  if (typeof step.parentConversationId === "string" && step.parentConversationId.trim()) return true;
  return false;
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
  const isProvablyInRound = (range) => {
    if (!range || causalFloor <= 0) return false;
    if (range.lo < causalFloor) return false;
    if (!range.isExact && range.lo <= causalFloor) return false;
    return true;
  };
  const hasTimestampEvidence = Boolean(
    causalFloor > 0 && (isProvablyInRound(prefillRange) || isProvablyInRound(promptRange))
  );
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
