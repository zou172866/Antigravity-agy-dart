/**
 * agy-dart Sidecar Stall Watchdog Engine (v1.4.0)
 *
 * Dual-source fusion state machine combining:
 *   1. Execution leases written by lifecycle hooks (PreInvocation / PreToolUse / PostToolUse / Stop)
 *      via `context/lib/watchdog-lease.js` into SQLite `meta` under `watchdog_lease:<directConvId>`.
 *   2. Low-frequency Sidecar polling + `transcript.jsonl` stat (`mtimeMs`/`size`) & bounded tail
 *      self-healing (catches missing `Stop` hooks and extends silence timers while transcript grows).
 *
 * Design invariants:
 *   - Strictly zero-dependency, fail-open, zero CDP, never kills host/user processes.
 *   - Zero `fs.statSync` calls when all leases are IDLE.
 *   - Sleep/lid-close drift guard prevents false red alerts after OS suspend/resume.
 *   - Pre-generates redacted Rescue Handoff Brief + 1-2 targeted troubleshooting tips on red `stalled`.
 *   - Desktop OS notifications are opt-in (default OFF) and debounced per incident/cooldown.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { getConfigStatCount, getEffectiveConfig, parseUiLang, withConfigSnapshot } from "./config.js";
import {
  buildDesktopNotificationCommand,
  buildWindowFocusCommand,
  buildWindowNotificationPrefix,
  focusDesktopConversationWindow,
  NOTIFY_CLICK_EXIT_CODE,
  NOTIFY_CLICK_STDOUT_TOKEN,
  sendDesktopNotification,
  WIN32_WINDOW_FOCUS_CSHARP
} from "./watchdog-notify.js";
import {
  buildManualKeepaliveMessage,
  computeEffectiveKeepaliveMinRemainSec,
  computeLeaseTtlTiming,
  INELIGIBLE_KEEPALIVE_STOP_REASON_RE,
  isKeepalivePendingAckActive,
  KEEPALIVE_PENDING_ACK_WINDOW_MS,
  MANUAL_KEEPALIVE_COOLDOWN_MS,
  resolveLeaseCacheOriginTs
} from "./watchdog-keepalive.js";
import {
  getConversationViaApi,
  isConversationApiUnsupportedBackedOff,
  isConversationServiceConfigured,
  markConversationApiUnsupported,
  resolveConversationApiEndpointKey
} from "./conversation-api.js";
import { buildHandoffBrief, inferWorkspaceFromStore, isSafeWorkspaceDir } from "./handoff.js";
import { isSecretRedactionEnabled } from "./security.js";
import {
  DEFAULT_CACHE_TTL_SEC,
  estimateCalibratedTtl,
  extractStepTokenUsage,
  findTranscriptForConversation,
  isSafeConversationId,
  isSlashCompactText,
  isSubagentStep,
  readTranscriptTail,
  resolveModelProfile
} from "./cache-analyzer.js";
import os from "node:os";
import path from "node:path";
import {
  HEADLESS_FINISH_PROMPT_RE,
  WATCHDOG_LEASE_PREFIX,
  WATCHDOG_PHASES,
  KNOWN_MCP_TOOL_RE,
  LONG_MCP_TOOL_RE,
  SLOW_GEN_TOOL_RE,
  classifyToolExecutionKind,
  classifyTranscriptGenesisFile,
  classifyTranscriptGenesisSteps,
  clearConversationSummaryCache,
  decodeFileUriOrPath,
  deleteWatchdogLeaseIfUnchanged,
  deriveLlmSubphase,
  detectSubagentFromTranscriptFile,
  detectSubagentFromTranscriptSteps,
  extractBareToolName,
  formatWorkspaceWindowLabel,
  getToolTimeoutTier,
  getWatchdogLeaseKey,
  hasPendingKeepaliveColdCheck,
  inspectLatestTurnInSteps,
  isHeadlessWorkerPrompt,
  isHighReasoningModel,
  isKeepaliveTurnFlushedForRound,
  isSameWorkspacePath,
  isSubagentLeasePayload,
  isSummaryMetadataSubagent,
  isTrajectoryMetadataSubagent,
  listWatchdogLeases,
  lookupConversationSummary,
  lookupConversationTitle,
  normalizeWatchdogLease,
  parseAnnotationArchivedStatus,
  parseMaybeJsonObj,
  parseStepPrefillTimestampInfo,
  parseStepPrefillTimestampMs,
  readWatchdogLease,
  readWatchdogTranscriptTail,
  recordHookLeaseTransition,
  resolveCandidateTranscriptPath,
  sanitizeConversationId,
  sanitizeWatchdogText,
  truncateUtf8Safe,
  writeWatchdogLease,
  writeWatchdogLeaseIfUnchanged
} from "./watchdog-lease.js";

export {
  HEADLESS_FINISH_PROMPT_RE,
  WATCHDOG_LEASE_PREFIX,
  hasPendingKeepaliveColdCheck,
  inspectLatestTurnInSteps,
  isKeepaliveTurnFlushedForRound,
  parseAnnotationArchivedStatus,
  parseStepPrefillTimestampInfo,
  parseStepPrefillTimestampMs,
  readWatchdogTranscriptTail,
  WATCHDOG_PHASES,
  classifyToolExecutionKind,
  classifyTranscriptGenesisFile,
  classifyTranscriptGenesisSteps,
  clearConversationSummaryCache,
  decodeFileUriOrPath,
  deleteWatchdogLeaseIfUnchanged,
  deriveLlmSubphase,
  detectSubagentFromTranscriptFile,
  detectSubagentFromTranscriptSteps,
  formatWorkspaceWindowLabel,
  getToolTimeoutTier,
  getWatchdogLeaseKey,
  isHeadlessWorkerPrompt,
  isHighReasoningModel,
  isSameWorkspacePath,
  isSubagentLeasePayload,
  isSummaryMetadataSubagent,
  isTrajectoryMetadataSubagent,
  listWatchdogLeases,
  lookupConversationSummary,
  lookupConversationTitle,
  normalizeWatchdogLease,
  readWatchdogLease,
  recordHookLeaseTransition,
  resolveCandidateTranscriptPath,
  sanitizeConversationId,
  sanitizeWatchdogText,
  truncateUtf8Safe,
  writeWatchdogLease,
  writeWatchdogLeaseIfUnchanged,
  NOTIFY_CLICK_EXIT_CODE,
  NOTIFY_CLICK_STDOUT_TOKEN,
  WIN32_WINDOW_FOCUS_CSHARP,
  buildWindowNotificationPrefix,
  buildWindowFocusCommand,
  focusDesktopConversationWindow,
  buildDesktopNotificationCommand,
  sendDesktopNotification,
  MANUAL_KEEPALIVE_COOLDOWN_MS,
  KEEPALIVE_PENDING_ACK_WINDOW_MS,
  INELIGIBLE_KEEPALIVE_STOP_REASON_RE,
  resolveLeaseCacheOriginTs,
  computeLeaseTtlTiming,
  computeEffectiveKeepaliveMinRemainSec,
  isKeepalivePendingAckActive,
  buildManualKeepaliveMessage
};

export const PENDING_JUMP_META_KEY = "watchdog:pending_jump";
export const DEFAULT_PENDING_JUMP_TTL_MS = 20_000;

export const DEFAULT_STALE_LEASE_MS = 2 * 60 * 60 * 1000; // 2 hours

const RESERVED_CHECKPOINT_SESSION_IDS = new Set([
  "default",
  "all",
  "lifetime",
  "app",
  "__unbound__",
  "unknown",
  "none",
  "null",
  "undefined"
]);

/**
 * Single source of truth for resolving a confirmed conversation's trusted checkpoint sessionId
 * across multi-hop grandchild -> child -> root lease chains (up to 12 hops with cycle detection)
 * plus `store.resolveRootSessionId(cursor)`. Rejects unrelated explicit sessionIds and reserved IDs.
 */
export function resolveTrustedCheckpointSessionId(
  store,
  confirmedConversationId,
  explicitRawSid = "",
  { seedLease = null } = {}
) {
  const safeConv = typeof confirmedConversationId === "string" ? confirmedConversationId.trim() : "";
  const isValidTrustedId = (cand) => {
    const s = typeof cand === "string" ? cand.trim() : "";
    return Boolean(s && !RESERVED_CHECKPOINT_SESSION_IDS.has(s.toLowerCase()) && isSafeConversationId(s));
  };
  if (!isValidTrustedId(safeConv)) {
    return "";
  }

  const allowed = new Set([safeConv]);
  const addAllowed = (cand) => {
    const s = typeof cand === "string" ? cand.trim() : "";
    if (isValidTrustedId(s)) {
      allowed.add(s);
    }
  };

  let resolvedRoot = safeConv;
  const readLeaseAt = (id, depth) => {
    if (depth === 0 && seedLease && typeof seedLease === "object") {
      const seedId = typeof seedLease.conversationId === "string" ? seedLease.conversationId.trim() : "";
      if (!seedId || seedId === id) {
        return seedLease;
      }
    }
    if (!store) return null;
    try {
      return readWatchdogLease(store, id);
    } catch {
      return null;
    }
  };

  let cursor = safeConv;
  const visited = new Set([cursor]);
  for (let depth = 0; depth < 12; depth++) {
    const lease = readLeaseAt(cursor, depth);
    if (!lease) break;
    addAllowed(lease.rootSessionId);
    addAllowed(lease.parentConversationId);
    const rawRoot = typeof lease.rootSessionId === "string" ? lease.rootSessionId.trim() : "";
    const rawParent = typeof lease.parentConversationId === "string" ? lease.parentConversationId.trim() : "";
    let next = "";
    if (rawRoot && rawRoot !== cursor && !visited.has(rawRoot) && isValidTrustedId(rawRoot)) {
      next = rawRoot;
    } else if (rawParent && rawParent !== cursor && !visited.has(rawParent) && isValidTrustedId(rawParent)) {
      next = rawParent;
    }
    if (!next) break;
    visited.add(next);
    addAllowed(next);
    cursor = next;
  }

  if (cursor !== safeConv) {
    resolvedRoot = cursor;
  }

  if (store && typeof store.resolveRootSessionId === "function") {
    try {
      const rootFromCursor = store.resolveRootSessionId(cursor);
      const trimmedRoot = typeof rootFromCursor === "string" ? rootFromCursor.trim() : "";
      if (isValidTrustedId(trimmedRoot)) {
        resolvedRoot = trimmedRoot;
        addAllowed(resolvedRoot);
      }
    } catch {}
    if (cursor !== safeConv) {
      try {
        const rootFromStart = store.resolveRootSessionId(safeConv);
        const trimmedStart = typeof rootFromStart === "string" ? rootFromStart.trim() : "";
        if (isValidTrustedId(trimmedStart)) {
          addAllowed(trimmedStart);
        }
      } catch {}
    }
  }

  const trimmedExplicit = typeof explicitRawSid === "string" ? explicitRawSid.trim() : "";
  if (trimmedExplicit && allowed.has(trimmedExplicit)) {
    return trimmedExplicit;
  }
  return resolvedRoot;
}

export const DEFAULT_ORPHAN_TURN0_MS = 15 * 60 * 1000; // 15 minutes
const MAX_IDLE_LEASE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const TERMINAL_STOP_REASON_RE =
  /^(?:end_turn|stop|completed|finish|finished|max_tokens|cancelled|canceled|aborted|interrupted|error|failed)$/i;
const ABORT_REASON_RE = /^(?:cancelled|canceled|aborted|interrupted)$/i;

function isSameOrNestedWorkspacePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  let na = norm(a);
  let nb = norm(b);
  if (!na || !nb) return false;
  if (/^[a-zA-Z]:(?:\/|$)/.test(na) || /^[a-zA-Z]:(?:\/|$)/.test(nb) || process.platform === "win32") {
    na = na.toLowerCase();
    nb = nb.toLowerCase();
  }
  return na === nb || nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`);
}

/**
 * Pure in-memory (0 fs.statSync) parent-child subagent activity aggregator.
 * Propagates child subagent heartbeats up multi-hop parent chains (plus same-CWD fallback
 * for active `SUBAGENT_BG` / `stopped_bg_pending` parents when child lacks parentConversationId).
 */
export function collectChildSubagentActivity(
  leases = [],
  { extraGrowthByConv = null, nowMs = 0, maxAgeMs = DEFAULT_STALE_LEASE_MS } = {}
) {
  const childHeartbeatByParent = new Map();
  const activeChildParents = new Set();
  if (!Array.isArray(leases) || leases.length === 0) {
    return { childHeartbeatByParent, activeChildParents };
  }

  const leaseById = new Map();
  for (const l of leases) {
    if (l && l.conversationId) {
      leaseById.set(l.conversationId, l);
    }
  }

  const isLeaseSubagent = (l) =>
    Boolean(
      l.isSubagent ||
        (l.parentConversationId && l.parentConversationId !== l.conversationId) ||
        (l.rootSessionId && l.rootSessionId !== l.conversationId) ||
        (l.lastUserInput && isHeadlessWorkerPrompt(l.lastUserInput))
    );

  for (const child of leases) {
    if (!child || !child.conversationId || !isLeaseSubagent(child)) continue;
    const growthTs =
      extraGrowthByConv instanceof Map ? Number(extraGrowthByConv.get(child.conversationId) || 0) : 0;
    const hb = Math.max(
      Number(child.lastHeartbeatTs || 0),
      Number(child.updatedTs || 0),
      Number(child.phaseChangedTs || 0),
      growthTs
    );
    const isStaleChild =
      nowMs > 0 && maxAgeMs > 0 && (hb <= 0 || nowMs - hb > maxAgeMs);
    if (isStaleChild) continue;
    const isOrphanPreToolOnlyLease =
      child.invocationNum === null &&
      !(Number(child.contextTokens || 0) > 0) &&
      !child.transcriptPath &&
      !child.lastUserInput;
    const childIsActive =
      !isOrphanPreToolOnlyLease &&
      (child.phase !== WATCHDOG_PHASES.IDLE || child.subphase === "stopped_bg_pending");

    const ancestors = new Set();
    let cursor = child;
    const visited = new Set([child.conversationId]);
    for (let hop = 0; hop < 6 && cursor; hop += 1) {
      const pId =
        cursor.parentConversationId && cursor.parentConversationId !== cursor.conversationId
          ? cursor.parentConversationId
          : "";
      const rId =
        cursor.rootSessionId && cursor.rootSessionId !== cursor.conversationId
          ? cursor.rootSessionId
          : "";
      if (pId && !visited.has(pId)) {
        ancestors.add(pId);
        visited.add(pId);
      }
      if (rId && rId !== pId) {
        ancestors.add(rId);
      }
      const nextId = pId || (rId && !visited.has(rId) ? rId : "");
      if (!nextId) break;
      visited.add(nextId);
      cursor = leaseById.get(nextId) || null;
    }

    if (ancestors.size > 0) {
      for (const ancId of ancestors) {
        if (hb > 0) {
          childHeartbeatByParent.set(ancId, Math.max(childHeartbeatByParent.get(ancId) || 0, hb));
        }
        if (childIsActive) {
          activeChildParents.add(ancId);
        }
      }
    } else if (child.cwd) {
      for (const candParent of leases) {
        if (!candParent || candParent.conversationId === child.conversationId || isLeaseSubagent(candParent)) {
          continue;
        }
        if (
          candParent.phase !== WATCHDOG_PHASES.SUBAGENT_BG &&
          candParent.subphase !== "stopped_bg_pending"
        ) {
          continue;
        }
        if (!candParent.cwd || !isSameOrNestedWorkspacePath(candParent.cwd, child.cwd)) {
          continue;
        }
        const parentAnchor = candParent.phaseChangedTs || candParent.startedTs || 0;
        if (hb > 0 && (childIsActive || hb >= parentAnchor)) {
          childHeartbeatByParent.set(
            candParent.conversationId,
            Math.max(childHeartbeatByParent.get(candParent.conversationId) || 0, hb)
          );
        }
        if (childIsActive) {
          activeChildParents.add(candParent.conversationId);
        }
      }
    }
  }

  return { childHeartbeatByParent, activeChildParents };
}

/**
 * State-aware dynamic timeout matrix (zero false positives).
 * Distinguishes:
 *   - IDLE
 *   - LLM_INFLIGHT:
 *       * non-reasoning: <120k (120s), 120k-250k or /compact (240s), multimodal high-ctx (360s)
 *       * single high-tier: high-reasoning model OR >=250k context (600s)
 *       * compound / ultra: high-reasoning + (>=250k or >=100k+media), or any model >=500k (900s)
 *   - TOOL_RUNNING: sync run_command / long MCP / apply_edits(verify) vs read_file / fast MCP
 *   - SUBAGENT_BG: async background tasks / subagents / run_workflow (1200s default)
 */
export function resolveDynamicThresholds(lease, cfg = getEffectiveConfig()) {
  if (!lease || lease.phase === WATCHDOG_PHASES.IDLE) {
    return {
      phase: WATCHDOG_PHASES.IDLE,
      bucket: "idle",
      suspectSec: 0,
      stalledSec: 0
    };
  }

  const rawRatio = Number(cfg?.watchdogSuspectRatio);
  const ratio = Number.isFinite(rawRatio) ? Math.min(0.95, Math.max(0.25, rawRatio)) : 0.6;

  let stalledSec;
  let bucket;

  if (lease.phase === WATCHDOG_PHASES.SUBAGENT_BG) {
    stalledSec = Number(cfg?.watchdogSubagentSec) || 1200;
    bucket = "subagent_bg";
  } else if (lease.phase === WATCHDOG_PHASES.TOOL_RUNNING) {
    const isSlowCmd =
      lease.activeToolKind === "sync_cmd" ||
      lease.activeToolKind === "mcp_long" ||
      lease.activeTool === "run_command" ||
      LONG_MCP_TOOL_RE.test(lease.activeTool || "") ||
      SLOW_GEN_TOOL_RE.test(lease.activeTool || "");
    if (isSlowCmd) {
      stalledSec = Number(cfg?.watchdogToolCmdSec) || 300;
      bucket = lease.activeToolKind === "mcp_long" ? "tool_mcp_long" : "tool_sync_cmd";
    } else {
      stalledSec = Number(cfg?.watchdogToolFastSec) || 90;
      bucket =
        lease.activeToolKind === "read"
          ? "tool_read"
          : lease.activeToolKind === "host"
            ? "tool_host"
            : "tool_mcp_fast";
    }
  } else {
    const ctx = Number(lease.contextTokens || 0);
    const media = Number(lease.mediaCount || 0);
    const highReasoning =
      isHighReasoningModel(lease.model) ||
      lease.subphase === "reasoning" ||
      lease.subphase === "reasoning_compound";

    if (
      ctx >= 500000 ||
      (highReasoning && (ctx >= 250000 || (ctx >= 100000 && media > 0))) ||
      lease.subphase === "reasoning_compound"
    ) {
      stalledSec = Number(cfg?.watchdogLlmCompoundSec) || 900;
      bucket = "llm_reasoning_compound";
    } else if (highReasoning) {
      stalledSec = Number(cfg?.watchdogLlmReasoningSec) || 600;
      bucket = "llm_reasoning";
    } else if (ctx >= 250000 || lease.subphase === "ultra_high_ctx") {
      stalledSec = Number(cfg?.watchdogLlmReasoningSec) || 600;
      bucket = "llm_ultra_high_ctx";
    } else if (
      (ctx >= 150000 && media > 0) ||
      (ctx >= 100000 && media >= 3) ||
      lease.subphase === "multimodal_high_ctx"
    ) {
      stalledSec = Number(cfg?.watchdogLlmMultimodalSec) || 360;
      bucket = "llm_multimodal_high_ctx";
    } else if (
      ctx >= 120000 ||
      lease.isCompactCmd ||
      lease.subphase === "high_ctx" ||
      lease.subphase === "compact"
    ) {
      stalledSec = Number(cfg?.watchdogLlmHighSec) || 240;
      bucket = lease.isCompactCmd || lease.subphase === "compact" ? "llm_compact" : "llm_high_ctx";
    } else {
      stalledSec = Number(cfg?.watchdogLlmLowSec) || 120;
      bucket = "llm_low_ctx";
    }
    if (lease.isSubagent) {
      const subFloor = Number(cfg?.watchdogSubagentSec) || 1200;
      stalledSec = Math.max(stalledSec, subFloor);
      bucket = "subagent_llm";
    }
  }

  const safeStalled = Math.max(10, Math.round(stalledSec));
  const suspectSec = Math.max(5, Math.min(safeStalled - 1, Math.round(safeStalled * ratio)));
  return {
    phase: lease.phase,
    bucket,
    suspectSec,
    stalledSec: safeStalled
  };
}

function parseStepTimestampMs(step) {
  if (!step || typeof step !== "object") return null;
  for (const field of ["updated_at", "completed_at", "created_at", "timestamp", "ts"]) {
    const v = step[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 1e11) return Math.floor(v);
    if (typeof v === "string" && v.trim()) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  return null;
}

function isNonSubstantiveSystemStep(step) {
  if (!step || typeof step !== "object") return false;
  const sys = step.systemMessage || step.system_message;
  if (sys && typeof sys === "object" && sys.systemMessage === "" && sys.metadata?.user_markdown) {
    return true;
  }
  const t = String(step.type || "").toUpperCase();
  if (t === "SYSTEM_MESSAGE" || t === "SYSTEM_INJECTION") {
    return true;
  }
  return false;
}

function extractStepToolCalls(step) {
  if (!step || typeof step !== "object") return [];
  const calls = [];
  for (const arr of [step.tool_calls, step.toolCalls, step.function_calls, step.functionCalls]) {
    if (Array.isArray(arr)) {
      for (const c of arr) {
        if (c && typeof c === "object") calls.push(c);
      }
    }
  }
  if (Array.isArray(step.content)) {
    for (const part of step.content) {
      if (
        part &&
        typeof part === "object" &&
        (part.type === "tool_use" || part.type === "tool_call" || part.type === "function_call")
      ) {
        calls.push(part);
      }
    }
  }
  for (const single of [step.tool_call, step.toolCall, step.function_call, step.functionCall]) {
    if (single && typeof single === "object") calls.push(single);
  }
  return calls;
}

function extractCallNameAndArgs(call) {
  if (!call || typeof call !== "object") return { name: "", args: {}, id: "" };
  const fn = call.function && typeof call.function === "object" ? call.function : null;
  const name = String(call.name || fn?.name || call.tool || "").trim();
  const args = parseMaybeJsonObj(call.args ?? call.arguments ?? call.input ?? fn?.arguments);
  const id = String(call.id ?? call.call_id ?? call.tool_call_id ?? "").trim();
  return { name, args, id };
}

function extractVisibleText(step) {
  if (!step || typeof step !== "object") return "";
  for (const key of ["content", "text", "response", "output", "message"]) {
    const val = step[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (Array.isArray(val)) {
      const joined = val
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && (p.type === "text" || !p.type) && typeof p.text === "string") {
            return p.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

function countMediaInStep(s) {
  if (!s || typeof s !== "object") return 0;
  let count = 0;
  if (Array.isArray(s.media)) count += s.media.length;
  if (Array.isArray(s.images)) count += s.images.length;
  if (Array.isArray(s.content)) {
    for (const p of s.content) {
      if (p && typeof p === "object" && (p.type === "image" || p.type === "image_url" || p.type === "media")) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Inspect the tail of a conversation's transcript.jsonl to:
 *   1. Self-heal leases when the tail already reached a terminal assistant/aborted step (missing Stop hook).
 *   2. Enrich phase & tool metadata (e.g. pending MCP/subagent calls not covered by PreToolUse).
 *   3. Capture latest contextTokens, mediaCount, model, and user input.
 */
export function inspectTranscriptTailForWatchdog(steps = [], options = {}) {
  const treatAsSubagent = Boolean(options?.isSubagent);
  const genesisSubagent = !treatAsSubagent && detectSubagentFromTranscriptSteps(steps);
  const result = {
    hasSteps: false,
    hasAssistantSteps: false,
    detectedSubagent: Boolean(treatAsSubagent || genesisSubagent),
    lastStepTs: null,
    lastPlannerPrefillTs: 0,
    lastStepType: "",
    isTerminal: false,
    terminalReason: "",
    hasPendingToolCalls: false,
    pendingTool: null,
    inferredPhase: null,
    latestUserInput: "",
    isCompactCmd: false,
    contextTokens: 0,
    mediaCount: 0,
    model: ""
  };
  if (!Array.isArray(steps) || steps.length === 0) return result;

  let lastSubstantiveStep = null;
  let lastSubstantiveIdx = -1;
  let lastSubstantiveIsToolResult = false;
  let lastPlannerIdx = -1;
  let lastPlannerActiveCalls = [];
  let lastPlannerOnlyFinish = false;
  let onlyToolResultsAfterPlanner = false;
  const completedCallIds = new Set();
  let completedResultsAfterPlanner = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || isNonSubstantiveSystemStep(step)) continue;
    // Embedded subagent steps inside a parent transcript must NOT pollute parent contextTokens
    // or falsely self-heal the parent conversation to IDLE.
    if (!treatAsSubagent && isSubagentStep(step)) continue;

    result.mediaCount += countMediaInStep(step);
    lastSubstantiveStep = step;
    lastSubstantiveIdx = i;

    const usage = extractStepTokenUsage(step);
    if (usage && usage.contextTokens > 0) {
      result.contextTokens = usage.contextTokens;
    }
    if (typeof step.model === "string" && step.model.trim()) {
      result.model = step.model.trim().slice(0, 96);
    }

    const typeUpper = String(step.type || "").toUpperCase();
    const roleLower = String(step.role || "").toLowerCase();

    if (
      typeUpper === "USER_INPUT" ||
      roleLower === "user" ||
      (typeof step.user_input === "string" && step.user_input.trim())
    ) {
      const userTxt =
        typeof step.user_input === "string" ? step.user_input : extractVisibleText(step);
      if (userTxt.trim()) {
        if (isHeadlessWorkerPrompt(userTxt)) {
          result.detectedSubagent = true;
        }
        result.latestUserInput = sanitizeWatchdogText(userTxt, 240);
        result.isCompactCmd = isSlashCompactText(userTxt);
      }
      lastSubstantiveIsToolResult = false;
      lastPlannerIdx = -1;
      lastPlannerActiveCalls = [];
      lastPlannerOnlyFinish = false;
      onlyToolResultsAfterPlanner = false;
      completedCallIds.clear();
      completedResultsAfterPlanner = 0;
      continue;
    }

    const isToolResult =
      typeUpper === "GENERIC" ||
      typeUpper === "TOOL_OUTPUT" ||
      typeUpper === "TOOL_RESULT" ||
      roleLower === "tool" ||
      step.tool_result !== undefined ||
      step.tool_call_id !== undefined ||
      step.toolCallId !== undefined ||
      step.call_id !== undefined;
    if (isToolResult) {
      lastSubstantiveIsToolResult = true;
      if (lastPlannerIdx >= 0) {
        completedResultsAfterPlanner += 1;
        const rid = String(step.tool_call_id ?? step.call_id ?? step.toolCallId ?? "").trim();
        if (rid) completedCallIds.add(rid);
      }
      continue;
    }

    const calls = extractStepToolCalls(step);
    const isAssistant =
      typeUpper === "PLANNER_RESPONSE" ||
      typeUpper === "ASSISTANT" ||
      roleLower === "assistant" ||
      roleLower === "model" ||
      calls.length > 0 ||
      Boolean(usage && (usage.contextTokens > 0 || usage.outputTokens > 0));

    if (isAssistant) {
      result.hasAssistantSteps = true;
      lastSubstantiveIsToolResult = false;
      const parsedCalls = calls.map(extractCallNameAndArgs).filter((c) => c.name);
      if (parsedCalls.some((c) => extractBareToolName(c.name) === "finish")) {
        result.detectedSubagent = true;
      }
      const allFinish =
        parsedCalls.length > 0 && parsedCalls.every((c) => extractBareToolName(c.name) === "finish");
      const activeCalls = parsedCalls.filter((c) => extractBareToolName(c.name) !== "finish");
      lastPlannerIdx = i;
      lastPlannerActiveCalls = activeCalls;
      lastPlannerOnlyFinish = allFinish;
      onlyToolResultsAfterPlanner = true;
      const pTs = parseStepPrefillTimestampMs(step);
      if (pTs > 0) result.lastPlannerPrefillTs = pTs;
      completedCallIds.clear();
      completedResultsAfterPlanner = 0;
    } else {
      lastSubstantiveIsToolResult = false;
      onlyToolResultsAfterPlanner = false;
    }
  }

  if (!lastSubstantiveStep) return result;
  result.hasSteps = true;
  result.lastStepTs = parseStepTimestampMs(lastSubstantiveStep);
  result.lastStepType = String(lastSubstantiveStep.type || lastSubstantiveStep.role || "").slice(0, 48);

  const typeUpper = String(lastSubstantiveStep.type || "").toUpperCase();
  const roleLower = String(lastSubstantiveStep.role || "").toLowerCase();
  const stopReason = String(
    lastSubstantiveStep.stop_reason ??
      lastSubstantiveStep.stopReason ??
      lastSubstantiveStep.finish_reason ??
      lastSubstantiveStep.finishReason ??
      lastSubstantiveStep.status ??
      ""
  ).trim();
  const isAborted = Boolean(
    lastSubstantiveStep.aborted === true ||
      lastSubstantiveStep.cancelled === true ||
      lastSubstantiveStep.canceled === true ||
      ABORT_REASON_RE.test(stopReason)
  );
  const isTerminalErrorStep =
    !lastSubstantiveIsToolResult &&
    (/^(?:ERROR_MESSAGE|ERROR|STREAM_ERROR|FATAL_ERROR)$/i.test(typeUpper) ||
      /^error$/i.test(stopReason) ||
      Boolean(lastSubstantiveStep.error));

  if (
    isAborted ||
    isTerminalErrorStep ||
    /^(?:STOP|TURN_END|CANCELLED|CANCELED|ABORTED|TURN_ABORTED|USER_CANCEL|TASK_COMPLETE|FINAL_RESPONSE)$/i.test(typeUpper)
  ) {
    result.isTerminal = true;
    const cleanStop = stopReason && !/^done$/i.test(stopReason) ? stopReason : "";
    result.terminalReason =
      cleanStop || typeUpper.toLowerCase() || (isTerminalErrorStep ? "error_message" : "aborted");
    result.inferredPhase = WATCHDOG_PHASES.IDLE;
    return result;
  }

  if (typeUpper === "USER_INPUT" || roleLower === "user") {
    result.inferredPhase = WATCHDOG_PHASES.LLM_INFLIGHT;
    return result;
  }

  if (
    lastPlannerIdx >= 0 &&
    lastPlannerOnlyFinish &&
    (lastSubstantiveIdx === lastPlannerIdx || onlyToolResultsAfterPlanner)
  ) {
    result.isTerminal = true;
    result.terminalReason = "finish_tool";
    result.inferredPhase = WATCHDOG_PHASES.IDLE;
    return result;
  }

  if (lastPlannerIdx >= 0 && lastPlannerActiveCalls.length > 0) {
    const unmatched = lastPlannerActiveCalls.filter((c, idx) => {
      if (c.id) return !completedCallIds.has(c.id);
      return idx >= completedResultsAfterPlanner;
    });
    if (unmatched.length > 0) {
      // When multiple tool calls run in parallel, pick the highest timeout tier
      // (SUBAGENT_BG > sync_cmd/mcp_long > mcp > read) to prevent premature false alerts.
      let bestCls = null;
      let bestTier = -1;
      for (const call of unmatched) {
        const cls = classifyToolExecutionKind(call.name, call.args);
        const tier = getToolTimeoutTier(
          cls.activeToolKind,
          cls.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING
        );
        if (tier >= bestTier) {
          bestTier = tier;
          bestCls = cls;
        }
      }
      result.hasPendingToolCalls = true;
      result.pendingTool = bestCls;
      result.inferredPhase = bestCls.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING;
      return result;
    }
    result.inferredPhase = WATCHDOG_PHASES.LLM_INFLIGHT;
    return result;
  }

  if (lastSubstantiveIdx === lastPlannerIdx) {
    const visible = extractVisibleText(lastSubstantiveStep);
    const usage = extractStepTokenUsage(lastSubstantiveStep);
    const calls = extractStepToolCalls(lastSubstantiveStep);
    const onlyFinish =
      calls.length > 0 && calls.every((c) => extractBareToolName(extractCallNameAndArgs(c).name) === "finish");
    if (
      onlyFinish ||
      TERMINAL_STOP_REASON_RE.test(stopReason) ||
      visible.length > 0 ||
      (usage && usage.outputTokens > 0)
    ) {
      result.isTerminal = true;
      result.terminalReason = stopReason || (onlyFinish ? "finish_tool" : "assistant_final_turn");
      result.inferredPhase = WATCHDOG_PHASES.IDLE;
      return result;
    }
  }

  return result;
}

/**
 * Attribute a suspect/stalled incident to one of 6 concrete root causes
 * and return 1-2 targeted, jailbreak-free troubleshooting tips (EN + ZH).
 */
export function diagnoseStallCause(lease = {}, options = {}) {
  const safeLease = lease && typeof lease === "object" && !Array.isArray(lease) ? lease : {};
  const safeOpts = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const phase = safeLease.phase || WATCHDOG_PHASES.LLM_INFLIGHT;
  const ctx = Number(safeLease.contextTokens || 0);
  const media = Number(safeLease.mediaCount || 0);
  const isCompact = Boolean(safeLease.isCompactCmd || safeLease.subphase === "compact");
  const activeTool = String(safeLease.activeTool || "");
  const safeTool = sanitizeWatchdogText(activeTool, 64);
  const activeToolKind = String(safeLease.activeToolKind || "");
  const platform = safeOpts.platform || process.platform;

  if (
    phase === WATCHDOG_PHASES.TOOL_RUNNING &&
    (activeToolKind === "sync_cmd" || activeTool === "run_command")
  ) {
    const winTag =
      platform === "win32" ? "Windows PowerShell/CMD EOF or interactive prompt" : "terminal interactive prompt / pager";
    return {
      causeId: "terminal_eof_or_interactive",
      label: platform === "win32" ? "Windows Terminal EOF / Interactive Hang" : "Terminal Interactive / EOF Block",
      labelZh: platform === "win32" ? "Windows 终端 EOF 或交互阻塞" : "终端交互提示或标准输入阻塞",
      tips: [
        `Check the terminal pane for a waiting ${winTag} ([y/N], password, pager) and cancel the step or press Ctrl+C.`,
        "Re-run long/interactive commands with non-interactive flags (--yes, CI=1, GIT_PAGER=cat) or async background mode (WaitMsBeforeAsync <= 2000)."
      ],
      tipsZh: [
        `检查终端面板是否停在 ${platform === "win32" ? "Windows 终端 EOF / [y/N] / 密码 / 分页器" : "交互确认 / 分页器"} 等待输入，手动 Ctrl+C 或在 Antigravity 中取消当前步骤。`,
        "对长耗时或易交互命令改用非交互参数（--yes、CI=1、GIT_PAGER=cat）或后台模式（WaitMsBeforeAsync <= 2000 / IsDaemon: true）。"
      ]
    };
  }

  const bareActiveTool = extractBareToolName(activeTool);
  const isSlowHostGen = SLOW_GEN_TOOL_RE.test(bareActiveTool);
  const isExplicitNonMcp =
    activeToolKind === "read" ||
    activeToolKind === "host" ||
    activeToolKind === "sync_cmd" ||
    isSlowHostGen;
  const colonIdx = activeTool.lastIndexOf(":");
  const colonPrefix = colonIdx > 0 ? activeTool.slice(0, colonIdx).trim() : "";
  const hasMcpName =
    /^(?:call_mcp_tool|mcp_|ctx_)/i.test(activeTool) ||
    (colonIdx > 0 && !/^(?:default_api|builtin|host|antigravity|core|native)$/i.test(colonPrefix)) ||
    KNOWN_MCP_TOOL_RE.test(bareActiveTool);
  if (
    phase === WATCHDOG_PHASES.TOOL_RUNNING &&
    (((activeToolKind === "mcp" || activeToolKind === "mcp_long") && !isSlowHostGen) ||
      (!isExplicitNonMcp && hasMcpName))
  ) {
    return {
      causeId: "mcp_tool_blocked",
      label: "MCP Tool / Server Blocked",
      labelZh: "MCP 工具或服务端阻塞",
      tips: [
        `Cancel the stalled MCP step (${safeTool || "MCP tool"}) in Antigravity and verify MCP server health (run 'npm run doctor' or reload MCP servers).`,
        "Copy the Rescue Handoff Brief first so modified files, last verification result, and FTS5 handles are preserved."
      ],
      tipsZh: [
        `在 Antigravity 中取消卡住的 MCP 步骤（${safeTool || "MCP 工具"}），并检查对应 MCP 服务健康状态（运行 npm run doctor 或在设置中重连 MCP）。`,
        "建议先一键复制下方的抢救版 Handoff Brief，确保已改文件、测试状态与 FTS5 句柄不丢失。"
      ]
    };
  }

  if (phase === WATCHDOG_PHASES.TOOL_RUNNING) {
    const isReadTool = activeToolKind === "read" || /^(?:read_file|view_file)$/i.test(activeTool);
    return {
      causeId: "host_tool_blocked",
      label: isReadTool ? "File Read / Host Tool Blocked" : "Host Tool Execution Blocked",
      labelZh: isReadTool ? "文件读取或宿主工具阻塞" : "宿主工具执行阻塞",
      tips: [
        isReadTool
          ? `Cancel the stalled file-read step (${safeTool || "read_file"}) in Antigravity and check whether the target file is oversized, locked, on a slow network mount, or hanging the host runtime.`
          : `Cancel the stalled tool step (${safeTool || "host tool"}) in Antigravity and check target file access or host tool responsiveness.`,
        "Copy the Rescue Handoff Brief below before stopping or restarting the session so modified files, checkpoints, and FTS5 handles are preserved."
      ],
      tipsZh: [
        isReadTool
          ? `在 Antigravity 中取消卡住的读文件步骤（${safeTool || "read_file"}），并检查目标文件是否过大、被进程占用、位于慢速网络盘或导致宿主工具卡死。`
          : `在 Antigravity 中取消卡住的工具步骤（${safeTool || "宿主工具"}），并检查目标文件权限/占用状态或宿主工具运行是否异常。`,
        "取消或重开会话前请先一键复制下方的抢救版 Handoff Brief，确保已改文件、检查点与 FTS5 句柄零丢失。"
      ]
    };
  }

  if (
    phase === WATCHDOG_PHASES.SUBAGENT_BG ||
    (safeLease.isSubagent && phase === WATCHDOG_PHASES.LLM_INFLIGHT)
  ) {
    const isHeadlessLlm = phase !== WATCHDOG_PHASES.SUBAGENT_BG && Boolean(safeLease.isSubagent);
    return {
      causeId: "subagent_or_bg_stalled",
      label: isHeadlessLlm
        ? "Background Worker / Subagent Unresponsive"
        : "Background Task / Subagent Unresponsive",
      labelZh: isHeadlessLlm ? "后台工作流节点 / 子代理长时间无响应" : "后台任务 / 子代理长时间无响应",
      tips: [
        isHeadlessLlm
          ? "Inspect the parent workflow or subagent status; parallel high-context workers may queue on model capacity, or cancel and retry the stuck worker."
          : `Inspect running background tasks or subagent status${safeTool ? ` (${safeTool})` : ""} and cancel the stuck background job in Antigravity if it is no longer making progress.`,
        "Copy the Rescue Handoff Brief below before stopping or starting a fresh session so workspace edits, checkpoints, and FTS5 handles are preserved."
      ],
      tipsZh: [
        isHeadlessLlm
          ? "检查父级工作流（run_workflow）或子代理状态；多路高上下文 Worker 并发可能正在排队等待配额，若确认无进度可在宿主取消重试。"
          : `检查当前后台任务或子代理状态${safeTool ? `（${safeTool}）` : ""}，若已无进度请在 Antigravity 中取消卡住的后台作业。`,
        "终止或重开会话前请先一键复制下方的抢救版 Handoff Brief，确保工作区变更、检查点与 FTS5 句柄零丢失。"
      ]
    };
  }

  const highReasoning =
    isHighReasoningModel(safeLease.model) ||
    safeLease.subphase === "reasoning" ||
    safeLease.subphase === "reasoning_compound";
  const isCompoundLlm =
    ctx >= 500000 ||
    safeLease.subphase === "reasoning_compound" ||
    (highReasoning && (ctx >= 250000 || (ctx >= 100000 && media > 0)));
  const isUltraHighCtx = ctx >= 250000 || safeLease.subphase === "ultra_high_ctx";

  if (
    phase === WATCHDOG_PHASES.LLM_INFLIGHT &&
    (isCompoundLlm ||
      isUltraHighCtx ||
      isCompact ||
      (!highReasoning &&
        (ctx >= 120000 ||
          safeLease.subphase === "high_ctx" ||
          safeLease.subphase === "multimodal_high_ctx")))
  ) {
    const mediaNote = media > 0 && (ctx >= 150000 || (ctx >= 100000 && (highReasoning || media >= 3)));
    if (isCompoundLlm) {
      return {
        causeId: "auto_compact_deadlock",
        label: "Deep Reasoning + Ultra-Long Context Stall",
        labelZh: "深度推理叠加超长上下文无响应",
        tips: [
          "Copy the Rescue Handoff Brief below, cancel the hung turn, then run /compact or continue in a fresh session with ctx_resume({}).",
          mediaNote
            ? "High-reasoning + >=100k multimodal context amplifies TTFT & stream stalls; delegate screenshot/media steps to a subagent."
            : "Delegate multi-file analysis to subagents or keep heavy outputs in agy-dart sandbox (ctx_execute / read_slices) to avoid >=250k cold re-prefill stalls."
        ],
        tipsZh: [
          "先复制下方的抢救版 Handoff Brief，取消当前超时轮次，执行 /compact 或在新对话粘贴简报并调用 ctx_resume({}) 续接。",
          mediaNote
            ? "深度推理叠加 >=100k 多模态图片会显著放大首字与流式耗时，建议将看图/排查拆给独立子代理。"
            : "建议将大体量改动拆给子代理，或用 ctx_execute / read_slices 控制上下文体积，避开超长窗口冷重填与自动压缩死锁。"
        ]
      };
    }
    if (isUltraHighCtx) {
      return {
        causeId: "auto_compact_deadlock",
        label: "Ultra-Long Context / Compaction Stall",
        labelZh: "超长上下文重填或后台压缩卡死",
        tips: [
          "Copy the Rescue Handoff Brief below, cancel the hung turn, then run /compact (or open a fresh session) and call ctx_resume({}).",
          "Keep large logs/diffs in agy-dart sandbox (ctx_execute / read_slices) so context stays below >=250k re-prefill cliffs."
        ],
        tipsZh: [
          "先复制下方的抢救版 Handoff Brief，取消当前卡死轮次，执行 /compact（或新开会话）并调用 ctx_resume({}) 无缝续接。",
          "大日志与源码优先走 agy-dart 沙盒与切片（ctx_execute / read_slices），避免上下文跨入 >=250k 冷重填高延迟区间。"
        ]
      };
    }
    return {
      causeId: "auto_compact_deadlock",
      label: mediaNote
        ? "High-Context Multimodal / Compaction Stall"
        : "Background Auto-Compaction / High-Context Deadlock",
      labelZh: mediaNote ? "高上下文多模态 / 自动压缩卡死" : "后台自动压缩死锁 / 高上下文无响应",
      tips: [
        "Copy the Rescue Handoff Brief below, cancel the hung turn, then open a fresh session (or run /compact) and paste the brief + call ctx_resume({}).",
        mediaNote
          ? "Avoid keeping screenshots/images in >=150k threads (3-7x TTFT cliff); delegate visual checks to a fresh subagent."
          : "Keep large logs/diffs in agy-dart sandbox (ctx_execute / read_slices) to stay below high-context compaction cliffs."
      ],
      tipsZh: [
        "先复制下方预生成的抢救版 Handoff Brief，点击停止/取消当前卡死轮次，在新对话粘贴该简报并调用 ctx_resume({}) 无缝续接。",
        mediaNote
          ? "当前会话 >=150k 且含多模态图片（TTFT 悬崖风险），建议改由独立文本子代理分流排查，避免主会话继续堆积图片。"
          : "大日志与源码优先走 agy-dart 沙盒与切片（ctx_execute / read_slices），避免上下文再次逼近后台自动压缩死锁区间。"
      ]
    };
  }

  if (phase === WATCHDOG_PHASES.LLM_INFLIGHT && highReasoning) {
    return {
      causeId: "deep_reasoning_stall",
      label: "Deep Reasoning Stream / Upstream Timeout",
      labelZh: "深度推理思维链阻塞或上游超时",
      tips: [
        "High-reasoning turn exceeded its 10m budget with zero disk output; check network/proxy stability or cancel and retry.",
        "Copy the Rescue Handoff Brief below before cancelling or reloading so workspace progress and FTS5 handles are preserved."
      ],
      tipsZh: [
        "高推理模型已超过 10 分钟无落盘输出，请检查代理/上游流式连接是否中断，或在宿主中取消本轮重试。",
        "取消或重开前请先一键复制下方的抢救版 Handoff Brief，确保当前工作区进度与 FTS5 句柄零丢失。"
      ]
    };
  }

  return {
    causeId: "oauth_ghost_or_network",
    label: "OAuth Ghost Session or Network Stall",
    labelZh: "OAuth Ghost Session 或网络断连",
    tips: [
      "Check proxy/VPN connectivity and Antigravity OAuth login state; cancel the silent turn or reload the window to clear a ghost session.",
      "Copy the Rescue Handoff Brief below before opening a new thread so no workspace progress is lost."
    ],
    tipsZh: [
      "检查代理/VPN 网络连通性与 Antigravity OAuth 会话状态；取消当前静默轮次，必要时重载窗口以清除 Ghost Session。",
      "新开会话前请先一键复制下方的抢救版 Handoff Brief，零丢失恢复当前工作区进度。"
    ]
  };
}

function severityRank(sev) {
  if (sev === "stalled") return 4;
  if (sev === "suspect") return 3;
  if (sev === "snoozed") return 2;
  if (sev === "active") return 1;
  return 0;
}

/**
 * Low-frequency Sidecar Stall Watchdog monitor.
 * Purely injectable clocks/fs/notifier so unit tests run deterministically in milliseconds.
 */
export class WatchdogMonitor {
  constructor(options = {}) {
    this.getStore = options.getStore;
    this.getAppStartTime = options.getAppStartTime || (() => 0);
    this._hasCustomConfig = typeof options.getConfig === "function";
    this.getConfig = options.getConfig || (() => getEffectiveConfig());
    this.nowFn = options.nowFn || (() => Date.now());
    this.monoNsFn = options.monoNsFn || (() => process.hrtime.bigint());
    this.statFn = options.statFn || ((p) => fs.statSync(p));
    this._hasCustomReadTail = typeof options.readTailFn === "function";
    this.readTailFn = options.readTailFn || ((p, bytes) => readTranscriptTail(p, bytes, { minUsageSteps: 1 }));
    this._hasCustomFindTranscript = typeof options.findTranscriptFn === "function";
    this.findTranscriptFn =
      options.findTranscriptFn || ((convId) => findTranscriptForConversation(convId, { exactOnly: true }));
    this.lookupTitleFn =
      options.lookupTitleFn ||
      ((convId, { transcriptPath } = {}) =>
        transcriptPath ? lookupConversationTitle(convId, { transcriptPath, allowDefaultDb: false }) : "");
    this._hasCustomLookupSummary = typeof options.lookupSummaryFn === "function";
    this.lookupSummaryFn =
      options.lookupSummaryFn || ((convId, opts = {}) => lookupConversationSummary(convId, opts));
    this._hasCustomFetchConversation = typeof options.fetchConversationFn === "function";
    this.fetchConversationFn =
      typeof options.fetchConversationFn === "function" ? options.fetchConversationFn : null;
    this.notifyFn = options.notifyFn || sendDesktopNotification;
    this.keepaliveSendFn = typeof options.keepaliveSendFn === "function" ? options.keepaliveSendFn : null;
    this.focusWindowFn = options.focusWindowFn || focusDesktopConversationWindow;
    this.buildHandoffFn = options.buildHandoffFn || buildHandoffBrief;
    this.brainRoots = Array.isArray(options.brainRoots) ? options.brainRoots : [];
    this.pendingJumpTtlMs =
      Number.isFinite(options.pendingJumpTtlMs) && options.pendingJumpTtlMs > 0
        ? Math.floor(options.pendingJumpTtlMs)
        : DEFAULT_PENDING_JUMP_TTL_MS;
    this.staleLeaseMs =
      Number.isFinite(options.staleLeaseMs) && options.staleLeaseMs > 0
        ? options.staleLeaseMs
        : DEFAULT_STALE_LEASE_MS;
    this.orphanTurn0Ms =
      Number.isFinite(options.orphanTurn0Ms) && options.orphanTurn0Ms > 0
        ? options.orphanTurn0Ms
        : DEFAULT_ORPHAN_TURN0_MS;
    this.platform = options.platform || process.platform;

    this._timer = null;
    this._startupCleaned = false;
    this._lastTickWallMs = null;
    this._lastTickMonoNs = null;
    this._sleepGuardCount = 0;
    this._lastSleepDriftAt = null;
    this._lastSleepJumpMs = 0;

    this._convState = new Map();
    this._lastEvaluated = new Map();
    this._ttlNotifiedKeys = new Map();
    this._turn0BackfillChecked = new Map();
    this._narrowMarginSkipped = new Map();
    this._keepaliveInFlight = new Map();
    this._subagentIdentityCache = new Map();
    this._convApiCache = new Map();
    this._convApiInFlight = new Set();
    this._convApiUnsupportedUntilTs = 0;
    this._lastIdleLeasePruneTs = 0;
    this._lastTtlNotifyGlobalTs = 0;
    this._fallbackPendingJump = null;
    this._inConfigScope = false;
    this.statSyncCount = 0;
    this.configStatCount = 0;
    this.tailReadCount = 0;
    this.notificationCount = 0;
    this.ttlNotificationCount = 0;
    this.ttlKeepaliveCount = 0;
    this.ttlKeepaliveNarrowSkippedCount = 0;
    this.manualKeepaliveCount = 0;
    this.watermarkNotificationCount = 0;
  }

  start() {
    if (this._timer) return;
    const cfg = this.getConfig() || {};
    const pollMs = Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000));
    try {
      this.cleanupStaleLeasesOnStartup();
    } catch {}
    this._lastTickWallMs = this.nowFn();
    this._lastTickMonoNs = this.monoNsFn();
    this._timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // Fail-open background poller
      }
    }, pollMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  cleanupStaleLeasesOnStartup(nowMs = this.nowFn()) {
    this._startupCleaned = true;
    const store = this.getStore?.();
    if (!store) return { cleaned: 0, deleted: 0 };
    const appStartTs = Number(this.getAppStartTime?.() || 0);
    const leases = listWatchdogLeases(store);
    let cleaned = 0;
    let deleted = 0;

    for (const lease of leases) {
      const ageMs = nowMs - (lease.updatedTs || 0);
      const fromPriorApp = appStartTs > 0 && lease.updatedTs > 0 && lease.updatedTs < appStartTs - 5000;
      const tooOld = ageMs > this.staleLeaseMs;
      if (lease.phase === WATCHDOG_PHASES.IDLE) {
        if (ageMs > MAX_IDLE_LEASE_RETENTION_MS || lease.updatedTs <= 0) {
          try {
            store.deleteMeta(getWatchdogLeaseKey(lease.conversationId));
            deleted += 1;
          } catch {}
        } else if (lease.subphase === "stopped_bg_pending" && (fromPriorApp || tooOld)) {
          try {
            const cas = writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, {
              ...lease,
              subphase: "stale_cleanup",
              stopReason: fromPriorApp ? "stale_prior_app_restart" : "stale_bg_pending_expired",
              phaseChangedTs: nowMs,
              updatedTs: nowMs,
              lastHeartbeatTs: nowMs,
              hookEvent: "SidecarStartupCleanup"
            });
            if (cas.written) cleaned += 1;
          } catch {}
        }
        continue;
      }

      if (fromPriorApp || tooOld || lease.updatedTs <= 0) {
        try {
          const cas = writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, {
            ...lease,
            phase: WATCHDOG_PHASES.IDLE,
            subphase: "stale_cleanup",
            activeTool: "",
            activeToolKind: "",
            activeToolSummary: "",
            activeToolCallId: "",
            pendingSlowCalls: [],
            transcriptSize: 0,
            transcriptMtimeMs: 0,
            stopReason: fromPriorApp ? "stale_prior_app_restart" : "stale_cleanup_on_restart",
            phaseChangedTs: nowMs,
            updatedTs: nowMs,
            lastHeartbeatTs: nowMs,
            hookEvent: "SidecarStartupCleanup",
            ackedUntilTs: 0
          });
          if (cas.written) cleaned += 1;
        } catch {}
      }
    }

    return { cleaned, deleted };
  }

  clearActiveLeasesOnDisable(nowMs = this.nowFn()) {
    const store = this.getStore?.();
    this._convState.clear();
    this._lastEvaluated.clear();
    if (!store) return 0;
    const leases = listWatchdogLeases(store);
    let cleared = 0;
    for (const lease of leases) {
      if (lease.phase === WATCHDOG_PHASES.IDLE && lease.subphase !== "stopped_bg_pending") continue;
      try {
        const cas = writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, {
          ...lease,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "disabled",
          activeTool: "",
          activeToolKind: "",
          activeToolSummary: "",
          activeToolCallId: "",
          pendingSlowCalls: [],
          transcriptSize: 0,
          transcriptMtimeMs: 0,
          stopReason: "watchdog_disabled",
          phaseChangedTs: nowMs,
          updatedTs: nowMs,
          lastHeartbeatTs: nowMs,
          hookEvent: "UserDisable",
          ackedUntilTs: 0
        });
        if (cas.written) cleared += 1;
      } catch {}
    }
    return cleared;
  }

  _checkSleepDrift(nowWallMs, nowMonoNs, pollMs) {
    if (this._lastTickWallMs === null || this._lastTickMonoNs === null) {
      this._lastTickWallMs = nowWallMs;
      this._lastTickMonoNs = nowMonoNs;
      return 0;
    }

    const wallDeltaMs = nowWallMs - this._lastTickWallMs;
    const monoDeltaMs = Number(nowMonoNs - this._lastTickMonoNs) / 1e6;
    this._lastTickWallMs = nowWallMs;
    this._lastTickMonoNs = nowMonoNs;

    const jumpThresholdMs = Math.max(pollMs * 4, 30000);
    const clockDivergenceMs = Math.abs(wallDeltaMs - monoDeltaMs);
    const hasActivePoller = this._timer !== null;

    // Signed drift compensation:
    //   - Positive driftMs (OS suspend/wake or forward clock jump) subtracts skipped wall time.
    //   - Negative driftMs (backward NTP/timezone jump) cancels the wall-clock reduction so
    //     active turns still measure true monotonic elapsed time instead of going blind.
    let driftMs = 0;
    if (wallDeltaMs < -5000) {
      driftMs = wallDeltaMs - Math.max(0, monoDeltaMs);
    } else if (clockDivergenceMs > 15000 && wallDeltaMs > 15000) {
      driftMs = Math.max(30000, wallDeltaMs - Math.max(0, monoDeltaMs));
    } else if (hasActivePoller && wallDeltaMs > jumpThresholdMs) {
      driftMs = Math.max(30000, wallDeltaMs - pollMs);
    }

    if (driftMs !== 0) {
      this._sleepGuardCount += 1;
      this._lastSleepDriftAt = nowWallMs;
      this._lastSleepJumpMs = Math.round(Math.abs(driftMs));
      for (const state of this._convState.values()) {
        state.sleepGraceMs = (state.sleepGraceMs || 0) + driftMs;
      }
    }
    return driftMs;
  }

  _getOrCreateConvState(convId) {
    let st = this._convState.get(convId);
    if (!st) {
      st = {
        transcriptPath: "",
        lastStatMtimeMs: 0,
        lastStatSize: -1,
        lastTranscriptGrowthTs: 0,
        lastInspectedMtimeMs: 0,
        lastInspectedSize: -1,
        lastTailInfo: null,
        lastTailFreshForEnrich: false,
        lastTailFreshForHeal: false,
        sleepGraceMs: 0,
        lastLeaseUpdatedTs: 0,
        rescueBriefKey: "",
        rescueBrief: null,
        lastNotifyKey: "",
        lastNotifyTs: 0
      };
      this._convState.set(convId, st);
    }
    return st;
  }

  _resolveWatchdogEnabled(store, cfg) {
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = store.getMeta("watchdog:enabled", null);
        if (raw !== null) return raw !== "false" && raw !== "0";
      }
      return cfg.stallWatchdog !== false;
    }
    if (store && typeof store.isWatchdogEnabled === "function") {
      return store.isWatchdogEnabled();
    }
    return cfg.stallWatchdog !== false;
  }

  _resolveDesktopNotifyEnabled(store, cfg) {
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = store.getMeta("watchdog:desktop_notify", null);
        if (raw !== null) return raw === "true" || raw === "1";
      }
      return Boolean(cfg.watchdogDesktopNotify);
    }
    if (store && typeof store.isWatchdogDesktopNotifyEnabled === "function") {
      return store.isWatchdogDesktopNotifyEnabled();
    }
    return Boolean(cfg.watchdogDesktopNotify);
  }

  _resolveTtlDesktopNotifyEnabled(store, cfg) {
    const envRaw = process.env.AGY_DART_TTL_DESKTOP_NOTIFY;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const s = envRaw.trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
      if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    }
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = store.getMeta("cache:ttl_desktop_notify", null);
        if (raw !== null) return raw === "true" || raw === "1";
      }
      return Boolean(cfg.ttlDesktopNotify);
    }
    if (store && typeof store.isTtlDesktopNotifyEnabled === "function") {
      return store.isTtlDesktopNotifyEnabled();
    }
    return Boolean(cfg.ttlDesktopNotify);
  }

  _isTtlKeepaliveForcedOffByEnv() {
    const disableRaw = process.env.AGY_DART_DISABLE_TTL_KEEPALIVE;
    if (typeof disableRaw === "string" && disableRaw.trim() !== "") {
      const d = disableRaw.trim().toLowerCase();
      if (d === "1" || d === "true" || d === "yes" || d === "on") return true;
      if (d === "0" || d === "false" || d === "no" || d === "off") return false;
    }
    const envRaw = process.env.AGY_DART_TTL_KEEPALIVE;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const s = envRaw.trim().toLowerCase();
      if (s === "0" || s === "false" || s === "no" || s === "off") return true;
      if (s === "1" || s === "true" || s === "yes" || s === "on") return false;
    }
    return false;
  }

  _rememberSubagentIdentity(conversationId, isSubagent, { definitive = true, nowMs = this.nowFn() } = {}) {
    if (!conversationId) return;
    if (this._subagentIdentityCache.size >= 512 && !this._subagentIdentityCache.has(conversationId)) {
      const oldest = this._subagentIdentityCache.keys().next().value;
      if (oldest !== undefined) this._subagentIdentityCache.delete(oldest);
    }
    const boolVal = Boolean(isSubagent);
    const isDefinitive = boolVal || Boolean(definitive);
    const expiresTs = isDefinitive ? Number.POSITIVE_INFINITY : Number(nowMs || 0) + 15_000;
    this._subagentIdentityCache.set(conversationId, {
      isSubagent: boolVal,
      expiresTs
    });
  }

  _shouldAllowDefaultSummaryDb(store) {
    if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
      return true;
    }
    if (this._hasCustomLookupSummary) return true;
    if (store && typeof store.dbPath === "string" && store.dbPath.trim()) {
      const defaultDbPath = path.join(os.homedir(), ".agy-dart", "context.db");
      return isSameWorkspacePath(store.dbPath, defaultDbPath);
    }
    return false;
  }

  _canUseConversationApi(store) {
    if (this._hasCustomFetchConversation) return true;
    if (this._hasCustomLookupSummary) return false;
    return this._shouldAllowDefaultSummaryDb(store) && isConversationServiceConfigured(process.env);
  }

  _rememberConversationApiRecord(conversationId, record, nowMs = this.nowFn(), ttlMs = 15_000) {
    if (!conversationId) return;
    if (this._convApiCache.size >= 256 && !this._convApiCache.has(conversationId)) {
      const oldest = this._convApiCache.keys().next().value;
      if (oldest !== undefined) this._convApiCache.delete(oldest);
    }
    this._convApiCache.set(conversationId, {
      ts: nowMs,
      expiresAt: nowMs + ttlMs,
      record
    });
  }

  _getCachedConversationApiRecord(conversationId, nowMs = this.nowFn()) {
    const entry = this._convApiCache.get(conversationId);
    if (!entry) return null;
    if (nowMs >= entry.expiresAt) return null;
    return entry.record || null;
  }

  async syncConversationApiStatus(conversationId, { store = null, force = false } = {}) {
    const cleanId = sanitizeConversationId(conversationId);
    if (!cleanId || cleanId === "__unbound__") return null;
    const activeStore = store || this.getStore?.() || null;
    if (!this._canUseConversationApi(activeStore)) return null;
    const nowMs = this.nowFn();
    const sharedEndpointKey = !this.fetchConversationFn
      ? resolveConversationApiEndpointKey({ env: process.env })
      : null;
    if (
      !force &&
      (nowMs < this._convApiUnsupportedUntilTs ||
        (sharedEndpointKey && isConversationApiUnsupportedBackedOff(sharedEndpointKey, nowMs)))
    ) {
      return null;
    }
    if (!force) {
      const cached = this._getCachedConversationApiRecord(cleanId, nowMs);
      if (cached) return cached;
    }
    if (this._convApiInFlight.has(cleanId)) return null;
    this._convApiInFlight.add(cleanId);
    try {
      const res = this.fetchConversationFn
        ? await this.fetchConversationFn(cleanId)
        : await getConversationViaApi(cleanId);
      const doneNow = this.nowFn();
      if (res?.unsupported) {
        this._convApiUnsupportedUntilTs = doneNow + 60_000;
        if (sharedEndpointKey) {
          markConversationApiUnsupported(sharedEndpointKey, { nowMs: doneNow, backoffMs: 60_000 });
        }
        return null;
      }
      if (res && res.ok && res.found) {
        this._rememberConversationApiRecord(cleanId, res, doneNow, 15_000);
        if (res.isSubagent) {
          this._rememberSubagentIdentity(cleanId, true, { definitive: true, nowMs: doneNow });
        }
        return res;
      }
      return null;
    } catch {
      return null;
    } finally {
      this._convApiInFlight.delete(cleanId);
    }
  }

  _scheduleConversationApiRefresh(store, conversationId, nowMs = this.nowFn()) {
    if (!this._canUseConversationApi(store)) return;
    if (nowMs < this._convApiUnsupportedUntilTs) return;
    if (this._getCachedConversationApiRecord(conversationId, nowMs)) return;
    if (this._convApiInFlight.has(conversationId)) return;
    void this.syncConversationApiStatus(conversationId, { store });
  }

  _pruneExpiredIdleLeases(store, leases, nowWallMs) {
    if (!store || !Array.isArray(leases) || leases.length === 0) return leases;
    if (this._lastIdleLeasePruneTs > 0 && nowWallMs - this._lastIdleLeasePruneTs < 5 * 60_000) {
      return leases;
    }
    this._lastIdleLeasePruneTs = nowWallMs;
    const kept = [];
    for (const lease of leases) {
      if (
        lease &&
        lease.phase === WATCHDOG_PHASES.IDLE &&
        lease.subphase !== "stopped_bg_pending" &&
        (lease.updatedTs <= 0 || nowWallMs - lease.updatedTs > MAX_IDLE_LEASE_RETENTION_MS)
      ) {
        try {
          const cas = deleteWatchdogLeaseIfUnchanged(store, lease.conversationId, lease.updatedTs, lease.phase);
          if (cas.deleted) {
            continue;
          }
          if (cas.current) {
            kept.push(cas.current);
            continue;
          }
        } catch {}
      }
      kept.push(lease);
    }
    return kept;
  }

  _isConversationSubagent(store, conversationId, leaseInput = null, { requireDefinitive = false } = {}) {
    const cleanId = sanitizeConversationId(conversationId);
    if (!cleanId || cleanId === "__unbound__") return false;

    const lease =
      leaseInput && leaseInput.conversationId === cleanId
        ? leaseInput
        : store
          ? readWatchdogLease(store, cleanId)
          : null;

    if (lease) {
      if (
        lease.isSubagent ||
        (lease.parentConversationId && lease.parentConversationId !== cleanId) ||
        (lease.rootSessionId && lease.rootSessionId !== cleanId) ||
        (lease.lastUserInput && isHeadlessWorkerPrompt(lease.lastUserInput))
      ) {
        this._rememberSubagentIdentity(cleanId, true, { definitive: true });
        return true;
      }
    }

    const nowMs = this.nowFn();
    const apiRec = this._getCachedConversationApiRecord(cleanId, nowMs);
    if (apiRec && apiRec.found && apiRec.isSubagent) {
      this._rememberSubagentIdentity(cleanId, true, { definitive: true, nowMs });
      return true;
    }
    this._scheduleConversationApiRefresh(store, cleanId, nowMs);

    const cached = this._subagentIdentityCache.get(cleanId);
    // A child can gain its official parent link after its title and transcript exist.
    // Only a positive worker identity may bypass the final pre-send check.
    if (cached && nowMs < cached.expiresTs && (cached.isSubagent || !requireDefinitive)) {
      return Boolean(cached.isSubagent);
    }

    let detected = false;
    let definitive = false;
    let discoveredParent = "";
    const allowDefaultDb = this._shouldAllowDefaultSummaryDb(store);
    let txPath = lease?.transcriptPath || "";
    if (!txPath) {
      txPath = resolveCandidateTranscriptPath(cleanId, { allowDefaultDb });
      if (!txPath && this._hasCustomFindTranscript) {
        try {
          txPath = this.findTranscriptFn(cleanId) || "";
        } catch {}
      }
    }

    let summaryFound = false;
    let summaryAgentName = "";
    if (allowDefaultDb || txPath) {
      try {
        const summary = this.lookupSummaryFn?.(cleanId, {
          transcriptPath: txPath,
          allowDefaultDb,
          checkSubagent: true
        });
        if (summary) {
          summaryFound = Boolean(summary.found);
          summaryAgentName = typeof summary.agentName === "string" ? summary.agentName.trim() : "";
          if (summary.isSubagent) {
            detected = true;
            definitive = true;
          }
          if (summary.parentConversationId && summary.parentConversationId !== cleanId) {
            discoveredParent = summary.parentConversationId;
            detected = true;
            definitive = true;
          }
          if (summary.title) definitive = true;
        }
      } catch {}
    }

    if (!detected && txPath) {
      try {
        const genesisCls = classifyTranscriptGenesisFile(txPath);
        if (genesisCls === "subagent") {
          detected = true;
          definitive = true;
        } else if (genesisCls === "human") {
          definitive = true;
        }
      } catch {}
    }

    if (!detected && !definitive && summaryFound && !summaryAgentName) {
      definitive = true;
    }

    this._rememberSubagentIdentity(cleanId, detected, { definitive, nowMs });

    if (detected && store) {
      if (lease && !lease.isSubagent) {
        try {
          writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, {
            ...lease,
            isSubagent: true,
            parentConversationId: discoveredParent || lease.parentConversationId || "",
            rootSessionId:
              lease.rootSessionId && lease.rootSessionId !== cleanId
                ? lease.rootSessionId
                : discoveredParent || lease.rootSessionId || cleanId,
            ...(txPath && !lease.transcriptPath ? { transcriptPath: txPath } : {})
          });
        } catch {}
      }
      try {
        store.deleteMeta?.(`cache:ttl_keepalive_state:${cleanId}`);
      } catch {}
    }

    return detected;
  }

  _isConversationKilled(store, conversationId, leaseInput = null) {
    const cleanId = sanitizeConversationId(conversationId);
    if (!cleanId || cleanId === "__unbound__") return false;
    const lease =
      leaseInput && leaseInput.conversationId === cleanId
        ? leaseInput
        : store
          ? readWatchdogLease(store, cleanId)
          : null;
    const allowDefaultDb = this._shouldAllowDefaultSummaryDb(store);
    const txPath = lease?.transcriptPath || "";
    if (!allowDefaultDb && !txPath && !this._hasCustomLookupSummary) return false;
    try {
      const summary = this.lookupSummaryFn?.(cleanId, {
        transcriptPath: txPath,
        allowDefaultDb
      });
      if (summary && summary.killed === true) {
        if (store) {
          try {
            const cur = lease || readWatchdogLease(store, cleanId);
            if (cur && cur.stopReason !== "USER_CANCELED") {
              writeWatchdogLeaseIfUnchanged(store, cur.updatedTs, cur.phase, {
                ...cur,
                stopReason: "USER_CANCELED"
              });
            }
            store.deleteMeta?.(`cache:ttl_keepalive_state:${cleanId}`);
          } catch {}
        }
        return true;
      }
    } catch {}
    return false;
  }

  _isConversationArchived(store, conversationId, leaseInput = null) {
    const cleanId = sanitizeConversationId(conversationId);
    if (!cleanId || cleanId === "__unbound__") return false;
    const nowMs = this.nowFn();
    const apiRec = this._getCachedConversationApiRecord(cleanId, nowMs);
    if (apiRec && apiRec.found) {
      return Boolean(apiRec.archived);
    }
    this._scheduleConversationApiRefresh(store, cleanId, nowMs);
    const lease =
      leaseInput && leaseInput.conversationId === cleanId
        ? leaseInput
        : store
          ? readWatchdogLease(store, cleanId)
          : null;
    const allowDefaultDb = this._shouldAllowDefaultSummaryDb(store);
    const txPath = lease?.transcriptPath || "";
    if (!allowDefaultDb && !txPath && !this._hasCustomLookupSummary) return false;
    try {
      const summary = this.lookupSummaryFn?.(cleanId, {
        transcriptPath: txPath,
        allowDefaultDb,
        checkArchived: true
      });
      if (summary && summary.archived === true) {
        return true;
      }
    } catch {}
    return false;
  }

  _resolveGlobalTtlKeepaliveMaxCount(store, cfg) {
    if (this._isTtlKeepaliveForcedOffByEnv()) return 0;
    const clampGlobal = (v) => Math.min(20, Math.max(0, Math.floor(Number(v))));
    const envRaw = process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const n = Number(envRaw.trim());
      if (Number.isFinite(n) && n >= 0) return clampGlobal(n);
    }
    const kaEnvRaw = process.env.AGY_DART_TTL_KEEPALIVE;
    const kaEnvOn =
      typeof kaEnvRaw === "string" &&
      /^(?:1|true|yes|on)$/i.test(kaEnvRaw.trim());
    if (
      store &&
      typeof store.hasExplicitGlobalTtlKeepaliveMaxCount === "function" &&
      store.hasExplicitGlobalTtlKeepaliveMaxCount()
    ) {
      const metaGlobal = store.getGlobalTtlKeepaliveMaxCount();
      return metaGlobal === 0 && kaEnvOn ? this._resolveFallbackTtlKeepaliveMaxCount(store, cfg) : metaGlobal;
    }
    if (!this._hasCustomConfig && store && typeof store.getGlobalTtlKeepaliveMaxCount === "function") {
      return store.getGlobalTtlKeepaliveMaxCount();
    }
    if (cfg.ttlKeepalive === false && !kaEnvOn) return 0;
    const fallbackCount = cfg.ttlKeepalive === true || kaEnvOn ? 1 : 0;
    const configuredCount = Number(cfg.ttlKeepaliveMaxCount ?? fallbackCount);
    const count = Number.isFinite(configuredCount) && configuredCount >= 0
      ? clampGlobal(configuredCount)
      : fallbackCount;
    return count === 0 && kaEnvOn ? this._resolveFallbackTtlKeepaliveMaxCount(store, cfg) : count;
  }

  _resolveFallbackTtlKeepaliveMaxCount(store, cfg) {
    if (store && typeof store.getFallbackNonZeroKeepaliveMaxCount === "function") {
      const fb = store.getFallbackNonZeroKeepaliveMaxCount();
      if (Number.isFinite(fb) && fb >= 1) {
        return Math.min(20, Math.max(1, Math.floor(fb)));
      }
    }
    const rawCfgMax = cfg?.ttlKeepaliveMaxCount;
    if (
      rawCfgMax !== undefined &&
      rawCfgMax !== null &&
      Number.isFinite(Number(rawCfgMax)) &&
      Number(rawCfgMax) >= 1
    ) {
      return Math.min(20, Math.max(1, Math.floor(Number(rawCfgMax))));
    }
    return 1;
  }

  _resolveGlobalTtlKeepaliveMinContextPct(store, cfg) {
    const clampPct = (v) => Math.min(100, Math.max(0, Math.floor(Number(v))));
    const envRaw = process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const n = Number(envRaw.trim());
      if (Number.isFinite(n) && n >= 0) return clampPct(n);
    }
    if (
      store &&
      typeof store.hasExplicitGlobalTtlKeepaliveMinContextPct === "function" &&
      store.hasExplicitGlobalTtlKeepaliveMinContextPct()
    ) {
      return store.getGlobalTtlKeepaliveMinContextPct();
    }
    if (this._hasCustomConfig) {
      const rawCfgPct = cfg?.ttlKeepaliveMinContextPct;
      if (
        rawCfgPct !== undefined &&
        rawCfgPct !== null &&
        Number.isFinite(Number(rawCfgPct)) &&
        Number(rawCfgPct) >= 0
      ) {
        return clampPct(rawCfgPct);
      }
      if (store && typeof store.getGlobalTtlKeepaliveMinContextPct === "function") {
        return store.getGlobalTtlKeepaliveMinContextPct();
      }
      return 15;
    }
    if (store && typeof store.getGlobalTtlKeepaliveMinContextPct === "function") {
      return store.getGlobalTtlKeepaliveMinContextPct();
    }
    return clampPct(cfg?.ttlKeepaliveMinContextPct ?? 15);
  }

  _normalizeKeepaliveIntervalSec(raw) {
    if (raw === null || raw === undefined || typeof raw === "boolean" || typeof raw === "object") return null;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (!s) return null;
      if (s === "0" || s === "auto" || s === "adaptive" || s === "dynamic") return 0;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const floored = Math.floor(n);
    if (floored === 0) return 0;
    if (floored < 60) return null;
    return Math.min(3600, floored);
  }

  _resolveGlobalTtlKeepaliveIntervalSec(store, cfg) {
    const envRaw = process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const parsed = this._normalizeKeepaliveIntervalSec(envRaw);
      if (parsed !== null) return parsed;
    }
    if (
      store &&
      typeof store.hasExplicitGlobalTtlKeepaliveIntervalSec === "function" &&
      store.hasExplicitGlobalTtlKeepaliveIntervalSec()
    ) {
      return store.getGlobalTtlKeepaliveIntervalSec();
    }
    if (this._hasCustomConfig) {
      const cfgParsed = this._normalizeKeepaliveIntervalSec(cfg?.ttlKeepaliveIntervalSec);
      if (cfgParsed !== null) return cfgParsed;
      if (store && typeof store.getGlobalTtlKeepaliveIntervalSec === "function") {
        return store.getGlobalTtlKeepaliveIntervalSec();
      }
      return 0;
    }
    if (store && typeof store.getGlobalTtlKeepaliveIntervalSec === "function") {
      return store.getGlobalTtlKeepaliveIntervalSec();
    }
    return this._normalizeKeepaliveIntervalSec(cfg?.ttlKeepaliveIntervalSec) ?? 0;
  }

  _resolveTtlKeepaliveIntervalSec(store, cfg, conversationId = "") {
    if (conversationId && store && typeof store.getTtlKeepaliveState === "function") {
      try {
        const kaState = store.getTtlKeepaliveState(conversationId);
        if (kaState && kaState.intervalSec !== null && kaState.intervalSec !== undefined) {
          const parsed = this._normalizeKeepaliveIntervalSec(kaState.intervalSec);
          if (parsed !== null) return parsed;
        }
      } catch {}
    }
    return this._resolveGlobalTtlKeepaliveIntervalSec(store, cfg);
  }

  _resolveLeaseKeepaliveMinContext(store, cfg, lease = null, { isCustomOverride = false } = {}) {
    const globalPct = this._resolveGlobalTtlKeepaliveMinContextPct(store, cfg);
    const profile = resolveModelProfile(lease?.model || null);
    const windowTokens =
      Number.isFinite(Number(lease?.windowTokens)) && Number(lease.windowTokens) > 0
        ? Math.floor(Number(lease.windowTokens))
        : profile?.windowTokens || 200_000;
    const effectivePct = isCustomOverride ? 0 : globalPct;
    const pctMinTokens = effectivePct > 0 ? Math.round((windowTokens * effectivePct) / 100) : 0;
    const tailReprocessTokens = profile?.minTurnDeltaForFullCache || 0;
    // Gemini 4 re-processes the trailing 2,050 tokens on small keepalive pings (< 2,050 token delta);
    // require at least 10k cached context before auto-keepalive is ROI-positive.
    const modelRoiMinTokens = !isCustomOverride && tailReprocessTokens > 0 ? 10000 : 0;
    return {
      globalPct,
      effectivePct,
      windowTokens,
      pctMinTokens,
      tailReprocessTokens,
      modelRoiMinTokens
    };
  }

  _resolveTtlKeepaliveEnabled(store, cfg, conversationId = "", lease = null) {
    if (
      conversationId &&
      conversationId !== "__unbound__" &&
      this._isConversationSubagent(store, conversationId, lease)
    ) {
      return false;
    }
    if (this._isTtlKeepaliveForcedOffByEnv()) return false;
    if (conversationId && store && typeof store.getTtlKeepaliveState === "function") {
      try {
        const kaState = store.getTtlKeepaliveState(conversationId);
        if (kaState && typeof kaState.enabled === "boolean") {
          return kaState.enabled;
        }
        if (
          kaState &&
          typeof kaState.maxCount === "number" &&
          Number.isFinite(kaState.maxCount) &&
          kaState.maxCount >= 1
        ) {
          return true;
        }
      } catch {}
    }
    const envMaxRaw = process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
    if (typeof envMaxRaw === "string" && envMaxRaw.trim() !== "") {
      const n = Number(envMaxRaw.trim());
      if (Number.isFinite(n) && n >= 0) {
        return Math.floor(n) >= 1;
      }
    }
    const envRaw = process.env.AGY_DART_TTL_KEEPALIVE;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const s = envRaw.trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
      if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    }
    return this._resolveGlobalTtlKeepaliveMaxCount(store, cfg) >= 1;
  }

  _resolveTtlKeepaliveMaxCount(store, cfg, conversationId = "") {
    const clampMax = (v) => Math.min(20, Math.max(1, Math.floor(Number(v) || 1)));
    if (conversationId && store && typeof store.getTtlKeepaliveState === "function") {
      try {
        const kaState = store.getTtlKeepaliveState(conversationId);
        if (kaState && typeof kaState.maxCount === "number" && Number.isFinite(kaState.maxCount) && kaState.maxCount >= 1) {
          return clampMax(kaState.maxCount);
        }
      } catch {}
    }
    const envRaw = process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const n = Number(envRaw.trim());
      if (Number.isFinite(n) && n >= 0) {
        const floored = Math.floor(n);
        return floored >= 1 ? clampMax(floored) : this._resolveFallbackTtlKeepaliveMaxCount(store, cfg);
      }
    }
    const globalMax = this._resolveGlobalTtlKeepaliveMaxCount(store, cfg);
    if (globalMax >= 1) return clampMax(globalMax);
    return this._resolveFallbackTtlKeepaliveMaxCount(store, cfg);
  }

  _resolveWatermarkDesktopNotifyEnabled(store, cfg, { desktopNotifyEnabled = false, ttlDesktopNotifyEnabled = false } = {}) {
    const envRaw = process.env.AGY_DART_WATERMARK_DESKTOP_NOTIFY;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const s = envRaw.trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
      if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    }
    if (store && typeof store.getMeta === "function") {
      try {
        const raw = store.getMeta("cache:watermark_desktop_notify", null);
        if (raw !== null) {
          if (raw === "true" || raw === "1") return true;
          if (raw === "false" || raw === "0") return false;
        }
      } catch {}
    }
    if (typeof cfg?.watermarkDesktopNotify === "boolean") {
      return cfg.watermarkDesktopNotify;
    }
    return Boolean(ttlDesktopNotifyEnabled || desktopNotifyEnabled);
  }

  _enrichNotificationLeaseIdentity(lease) {
    if (!lease || lease.convTitle) return lease;
    try {
      const fallbackTitle = this.lookupTitleFn?.(lease.conversationId, {
        transcriptPath: lease.transcriptPath || ""
      });
      if (typeof fallbackTitle === "string" && fallbackTitle.trim()) {
        return { ...lease, convTitle: sanitizeWatchdogText(fallbackTitle, 36) };
      }
    } catch {}
    return lease;
  }

  _resolveUiLangInfo(store, cfg) {
    const envParsed = parseUiLang(process.env.AGY_DART_LANG);
    if (envParsed) {
      return { lang: envParsed, source: "env" };
    }
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = parseUiLang(store.getMeta("ui:lang", null));
        if (raw) return { lang: raw, source: "sqlite" };
      }
      const cfgParsed = parseUiLang(cfg.uiLang);
      if (cfgParsed) return { lang: cfgParsed, source: "config" };
      return { lang: "en", source: "default" };
    }
    if (store && typeof store.getUiLangInfo === "function") {
      return store.getUiLangInfo();
    }
    const cfgParsed = parseUiLang(cfg.uiLang);
    return { lang: cfgParsed || "en", source: cfgParsed ? "config" : "default" };
  }

  _resolveLeaseEffectiveTtlSec(store, lease, cfg, nowWallMs) {
    if (Number.isFinite(cfg.cacheTtlSec) && cfg.cacheTtlSec > 0) {
      return Math.floor(cfg.cacheTtlSec);
    }
    const profile = resolveModelProfile(lease?.model || null);
    const profileFloor = profile?.ttlSec || DEFAULT_CACHE_TTL_SEC;
    if (store && typeof store.getModelTtlCalibration === "function") {
      try {
        const hist = store.getModelTtlCalibration(profile.id, nowWallMs);
        if (hist && ((hist.warm && hist.warm.length > 0) || (hist.cold && hist.cold.length > 0) || hist.seen1hWrite)) {
          const cal = estimateCalibratedTtl(profile, { historyRecord: hist, nowMs: nowWallMs });
          if (cal && cal.ttlSec > 0 && (cal.ttlSource === "empirical" || lease?.ttlSource === "empirical")) {
            return Math.max(profileFloor, Math.floor(cal.ttlSec));
          }
        }
      } catch {}
    }
    if (Number.isFinite(lease?.cacheTtlSec) && lease.cacheTtlSec > 0) {
      return lease.ttlSource === "empirical"
        ? Math.max(profileFloor, Math.floor(lease.cacheTtlSec))
        : Math.floor(lease.cacheTtlSec);
    }
    return profileFloor;
  }

  _resolveTtlKeepaliveMinRemainSec(cfg) {
    const raw = cfg?.ttlKeepaliveMinRemainSec;
    if (raw !== undefined && raw !== null && raw !== "" && typeof raw !== "boolean") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) {
        return Math.min(120, Math.max(0, Math.floor(n)));
      }
    }
    return 15;
  }

  _pruneNarrowMarginSkipped(leases) {
    if (!this._narrowMarginSkipped || this._narrowMarginSkipped.size === 0) return;
    const leaseById = new Map();
    for (const l of leases || []) {
      if (l && l.conversationId) leaseById.set(l.conversationId, l);
    }
    for (const [id, entry] of this._narrowMarginSkipped.entries()) {
      const l = leaseById.get(id);
      if (!l || l.phase !== WATCHDOG_PHASES.IDLE) {
        this._narrowMarginSkipped.delete(id);
        continue;
      }
      const anchor = l.idleAnchorTs || l.phaseChangedTs || l.updatedTs || 0;
      if (!anchor || anchor !== entry.idleAnchorTs) {
        this._narrowMarginSkipped.delete(id);
      }
    }
  }

  _runDelayedColdMissCheck(store, convId, lease, kaState, nowWallMs) {
    if (
      !store ||
      !convId ||
      !lease?.transcriptPath ||
      typeof this.readTailFn !== "function" ||
      !hasPendingKeepaliveColdCheck(kaState)
    ) {
      return { checked: false, coldTripped: Boolean(kaState?.coldMissTripped) };
    }
    const expectedDispatchId = kaState.lastDispatchId || "";
    const expectedDispatchMode = kaState.lastDispatchMode || "";
    const expectedPendingId = kaState.pendingColdCheckId || "";
    const expectedLastSentTs = kaState.lastSentTs || 0;
    const expectedUsed = kaState.usedCount || 0;
    let coldTrippedNow = false;
    let verified = false;
    try {
      this.tailReadCount += 1;
      const tailSteps = this._hasCustomReadTail
        ? this.readTailFn(lease.transcriptPath, 32768)
        : readWatchdogTranscriptTail(lease.transcriptPath, 32768).steps;
      const info = inspectLatestTurnInSteps(tailSteps);
      if (isKeepaliveTurnFlushedForRound(info, kaState) && info.cacheReadReported === true) {
        const isCold = info.cacheReadTokens === 0;
        const applyResult = () => {
          const curKa =
            typeof store.getTtlKeepaliveState === "function" ? store.getTtlKeepaliveState(convId) : kaState;
          if (
            curKa.lastDispatchId !== expectedDispatchId ||
            curKa.lastDispatchMode !== expectedDispatchMode ||
            curKa.pendingColdCheckId !== expectedPendingId ||
            curKa.lastSentTs !== expectedLastSentTs ||
            curKa.usedCount !== expectedUsed ||
            curKa.pendingAck ||
            curKa.inKeepaliveTurn
          ) {
            return { applied: false, cold: Boolean(curKa.coldMissTripped) };
          }
          const checkedId = expectedPendingId || expectedDispatchId;
          const nextCold = Boolean(curKa.coldMissTripped || isCold);
          store.setTtlKeepaliveState?.(convId, {
            coldMissTripped: nextCold,
            pendingColdCheckId: "",
            ...(checkedId ? { lastColdCheckedId: checkedId } : {}),
            lastColdCheckUsed: Math.max(curKa.usedCount || 0, curKa.lastColdCheckUsed || 0),
            updatedTs: nowWallMs
          });
          return { applied: true, cold: nextCold };
        };
        const txRes =
          typeof store._withWriteTx === "function"
            ? (store.open?.(), store._withWriteTx(applyResult))
            : applyResult();
        verified = Boolean(txRes?.applied);
        coldTrippedNow = Boolean(txRes?.cold);
      }
    } catch {}
    return { checked: verified, coldTripped: coldTrippedNow };
  }

  _rollbackKeepaliveClaimIfOwned(store, convId, claimMeta, errMsg, { mode = "error" } = {}) {
    const {
      dispatchId,
      isManual,
      prevUsed,
      prevAnchor,
      prevLastSentTs = 0,
      prevDispatchId,
      prevDispatchMode,
      prevPendingColdCheckId = "",
      sentAtMs
    } = claimMeta;
    const execRollback = () => {
      const curKa =
        typeof store.getTtlKeepaliveState === "function" ? store.getTtlKeepaliveState(convId) : null;
      if (
        !curKa ||
        curKa.lastDispatchId !== dispatchId ||
        curKa.pendingAck !== true ||
        curKa.inKeepaliveTurn === true
      ) {
        return false;
      }
      store.setTtlKeepaliveState?.(convId, {
        ...(isManual ? {} : { usedCount: prevUsed }),
        lastIdleAnchorTs: prevAnchor,
        lastSentTs: prevLastSentTs,
        lastAttemptTs: Math.max(curKa.lastAttemptTs || 0, sentAtMs || 0),
        pendingAck: false,
        inKeepaliveTurn: false,
        lastDispatchId: prevDispatchId,
        lastDispatchMode: prevDispatchMode,
        pendingColdCheckId: prevPendingColdCheckId,
        lastError: mode === "archived" ? "" : String(errMsg || "keepalive_send_failed").slice(0, 180),
        updatedTs: this.nowFn()
      });
      return true;
    };
    let rolledBack = false;
    try {
      if (typeof store._withWriteTx === "function") {
        if (typeof store.open === "function") store.open();
        rolledBack = Boolean(store._withWriteTx(execRollback));
      } else {
        rolledBack = Boolean(execRollback());
      }
    } catch {}
    if (rolledBack && mode === "subagent") {
      this._rememberSubagentIdentity(convId, true, { definitive: true });
      try {
        const curLease = readWatchdogLease(store, convId);
        if (curLease && !curLease.isSubagent) {
          writeWatchdogLeaseIfUnchanged(store, curLease.updatedTs, curLease.phase, {
            ...curLease,
            isSubagent: true
          });
        }
      } catch {}
    } else if (rolledBack && mode === "killed") {
      try {
        const curLease = readWatchdogLease(store, convId);
        if (curLease && curLease.stopReason !== "USER_CANCELED") {
          writeWatchdogLeaseIfUnchanged(store, curLease.updatedTs, curLease.phase, {
            ...curLease,
            stopReason: "USER_CANCELED"
          });
        }
      } catch {}
    }
    return rolledBack;
  }

  _evaluateIdleTtlKeepalive(
    store,
    leases,
    { nowWallMs, cfg, uiLang = "en", sleepJumpMs }
  ) {
    const coveredConvIds = new Set();
    const exhaustedConvMap = new Map();
    const updatedLeasesById = new Map();
    if (
      typeof this.keepaliveSendFn !== "function" ||
      this._isTtlKeepaliveForcedOffByEnv() ||
      !store ||
      !Array.isArray(leases) ||
      leases.length === 0
    ) {
      return { coveredConvIds, exhaustedConvMap, updatedLeasesById };
    }

    const rawMinTok = cfg.ttlKeepaliveMinTokens;
    const minTokens =
      rawMinTok !== undefined && rawMinTok !== null && Number.isFinite(Number(rawMinTok))
        ? Math.min(500000, Math.max(0, Math.floor(Number(rawMinTok))))
        : 0;
    const leadSec = Math.min(180, Math.max(10, Math.floor(Number(cfg.ttlKeepaliveLeadSec) || 60)));
    const minRemainSec = this._resolveTtlKeepaliveMinRemainSec(cfg);
    const deliveryMs =
      typeof store.getTtlKeepaliveDeliveryMs === "function" ? store.getTtlKeepaliveDeliveryMs() : 0;
    const deliveryCompSec = deliveryMs > 0 ? Math.min(20, Math.ceil(deliveryMs / 1000)) : 0;

    if (sleepJumpMs !== 0) {
      return { coveredConvIds, exhaustedConvMap, updatedLeasesById };
    }

    for (const lease of leases) {
      if (
        !lease ||
        lease.phase !== WATCHDOG_PHASES.IDLE ||
        this._isConversationSubagent(store, lease.conversationId, lease)
      ) {
        continue;
      }
      if (lease.subphase !== "stopped") continue;
      const stopReason = String(lease.stopReason || "").trim();
      if (INELIGIBLE_KEEPALIVE_STOP_REASON_RE.test(stopReason)) {
        continue;
      }
      if (!this._resolveTtlKeepaliveEnabled(store, cfg, lease.conversationId, lease)) continue;
      const isCustomOverride = Boolean(store.hasCustomTtlKeepaliveOverride?.(lease.conversationId));
      let { pctMinTokens, modelRoiMinTokens } = this._resolveLeaseKeepaliveMinContext(store, cfg, lease, { isCustomOverride });
      let effectiveMinTokens = isCustomOverride ? 0 : Math.max(minTokens, pctMinTokens, modelRoiMinTokens);
      let leaseContextTokens = Number(lease.contextTokens || 0);
      if (effectiveMinTokens > 0 && leaseContextTokens > 0 && leaseContextTokens < effectiveMinTokens) continue;
      if (effectiveMinTokens > 0 && leaseContextTokens === 0 && !lease.transcriptPath) continue;
      const maxCount = this._resolveTtlKeepaliveMaxCount(store, cfg, lease.conversationId);
      const intervalSec = this._resolveTtlKeepaliveIntervalSec(store, cfg, lease.conversationId);
      const isFixedInterval = intervalSec > 0;

      let workingLease = lease;
      let effectiveTtlSec = this._resolveLeaseEffectiveTtlSec(store, workingLease, cfg, nowWallMs);
      let effectiveLeadSec = Math.min(leadSec, Math.max(5, Math.floor(effectiveTtlSec * 0.5)));
      if (!isFixedInterval && !(effectiveTtlSec > effectiveLeadSec)) continue;
      let effectiveTriggerLeadSec = Math.min(
        Math.max(5, Math.floor(effectiveTtlSec * 0.75)),
        effectiveLeadSec + deliveryCompSec
      );
      const fixedTriggerAtSec = isFixedInterval ? Math.max(30, intervalSec - deliveryCompSec) : 0;
      const fixedMaxWindowSec = isFixedInterval
        ? Math.max(Math.round(intervalSec * 1.5), intervalSec + 120)
        : 0;
      let effectiveMinRemainSec = computeEffectiveKeepaliveMinRemainSec(
        minRemainSec,
        deliveryCompSec,
        effectiveTriggerLeadSec
      );

      let timing = computeLeaseTtlTiming(workingLease, { effectiveTtlSec, nowWallMs });
      if (!timing.valid) continue;
      if (isFixedInterval) {
        if (timing.idleSec > fixedMaxWindowSec) continue;
      } else if (timing.remSec <= 0) {
        continue;
      }
      const idleAnchorTs = timing.idleAnchorTs;

      let kaState =
        typeof store.getTtlKeepaliveState === "function"
          ? store.getTtlKeepaliveState(lease.conversationId)
          : {
              usedCount: 0,
              lastIdleAnchorTs: 0,
              lastSentTs: 0,
              lastAttemptTs: 0,
              pendingAck: false,
              coldMissTripped: false,
              inKeepaliveTurn: false,
              lastColdCheckUsed: 0,
              lastDispatchId: "",
              lastDispatchMode: "",
              pendingColdCheckId: "",
              lastColdCheckedId: ""
            };

      if (kaState.coldMissTripped) continue;

      // Lazy Turn-0 post-Stop flush backfill (0 fs.statSync): if Stop ran before the first
      // PLANNER_RESPONSE flushed to disk, inspect the tail once when entering the trigger window.
      const isDueForBackfill = isFixedInterval
        ? timing.idleSec >= fixedTriggerAtSec
        : timing.remSec <= effectiveTriggerLeadSec;
      if (
        effectiveMinTokens > 0 &&
        leaseContextTokens === 0 &&
        workingLease.transcriptPath &&
        kaState.usedCount < maxCount &&
        isDueForBackfill &&
        this._turn0BackfillChecked.get(lease.conversationId) !== idleAnchorTs
      ) {
        this._turn0BackfillChecked.set(lease.conversationId, idleAnchorTs);
        try {
          this.tailReadCount += 1;
          const tailSteps = this._hasCustomReadTail
            ? this.readTailFn(workingLease.transcriptPath, 32768)
            : readWatchdogTranscriptTail(workingLease.transcriptPath, 32768).steps;
          const info = inspectLatestTurnInSteps(tailSteps);
          if (info.hasPlanner && !info.hasPromptAfterLastPlanner && info.contextTokens > 0) {
            leaseContextTokens = info.contextTokens;
            const nextBackfilledOrigin =
              info.prefillTs > 0 &&
              info.prefillTs <= idleAnchorTs &&
              idleAnchorTs - info.prefillTs <= 30 * 60 * 1000
                ? info.prefillTs
                : workingLease.cacheOriginTs || idleAnchorTs;
            const enrichedLease = {
              ...workingLease,
              contextTokens: info.contextTokens,
              ...(info.maxTokens > 0 ? { windowTokens: info.maxTokens } : {}),
              ...(info.model ? { model: info.model } : {}),
              cacheOriginTs: nextBackfilledOrigin
            };
            writeWatchdogLeaseIfUnchanged(store, workingLease.updatedTs, workingLease.phase, enrichedLease);
            workingLease = enrichedLease;
            updatedLeasesById.set(lease.conversationId, enrichedLease);
            ({ pctMinTokens, modelRoiMinTokens } = this._resolveLeaseKeepaliveMinContext(store, cfg, enrichedLease, {
              isCustomOverride
            }));
            effectiveMinTokens = isCustomOverride ? 0 : Math.max(minTokens, pctMinTokens, modelRoiMinTokens);
            effectiveTtlSec = this._resolveLeaseEffectiveTtlSec(store, workingLease, cfg, nowWallMs);
            effectiveLeadSec = Math.min(leadSec, Math.max(5, Math.floor(effectiveTtlSec * 0.5)));
            if (!isFixedInterval && !(effectiveTtlSec > effectiveLeadSec)) continue;
            effectiveTriggerLeadSec = Math.min(
              Math.max(5, Math.floor(effectiveTtlSec * 0.75)),
              effectiveLeadSec + deliveryCompSec
            );
            effectiveMinRemainSec = computeEffectiveKeepaliveMinRemainSec(
              minRemainSec,
              deliveryCompSec,
              effectiveTriggerLeadSec
            );
            timing = computeLeaseTtlTiming(workingLease, { effectiveTtlSec, nowWallMs });
          }
        } catch {}
      }
      if (!timing.valid) continue;
      if (isFixedInterval) {
        if (timing.idleSec > fixedMaxWindowSec) continue;
      } else if (timing.remSec <= 0) {
        continue;
      }
      if (effectiveMinTokens > 0 && leaseContextTokens < effectiveMinTokens) continue;

      const remSec = timing.remSec;
      const sentOnCurrentIdleCycle =
        kaState.lastIdleAnchorTs === idleAnchorTs ||
        this._keepaliveInFlight.has(lease.conversationId) ||
        isKeepalivePendingAckActive(kaState, nowWallMs);

      if (sentOnCurrentIdleCycle) {
        this._narrowMarginSkipped.delete(lease.conversationId);
        coveredConvIds.add(lease.conversationId);
        continue;
      }

      if (kaState.usedCount >= maxCount) {
        if (kaState.lastIdleAnchorTs > 0 && kaState.lastIdleAnchorTs !== idleAnchorTs) {
          exhaustedConvMap.set(lease.conversationId, {
            usedCount: kaState.usedCount,
            maxCount
          });
        }
        continue;
      }

      if (isFixedInterval ? timing.idleSec < fixedTriggerAtSec : remSec > effectiveTriggerLeadSec) {
        coveredConvIds.add(lease.conversationId);
        continue;
      }

      // Layer-3 cold-miss circuit breaker (0 fs.statSync): verify any unverified auto or manual
      // keepalive round whose transcript flushed AFTER Stop hook ran.
      if (hasPendingKeepaliveColdCheck(kaState)) {
        const delayed = this._runDelayedColdMissCheck(store, lease.conversationId, workingLease, kaState, nowWallMs);
        if (delayed.coldTripped) {
          continue;
        }
        if (delayed.checked && typeof store.getTtlKeepaliveState === "function") {
          kaState = store.getTtlKeepaliveState(lease.conversationId);
        }
      }

      const lastAutoCooldownTs = Math.max(kaState.lastSentTs || 0, kaState.lastAttemptTs || 0);
      if (lastAutoCooldownTs > 0 && nowWallMs - lastAutoCooldownTs < 25_000) {
        coveredConvIds.add(lease.conversationId);
        continue;
      }

      if (
        this._isConversationSubagent(store, lease.conversationId, workingLease, { requireDefinitive: true }) ||
        this._isConversationKilled(store, lease.conversationId, workingLease) ||
        this._isConversationArchived(store, lease.conversationId, workingLease)
      ) {
        exhaustedConvMap.delete(lease.conversationId);
        continue;
      }

      coveredConvIds.add(lease.conversationId);

      const convId = lease.conversationId;
      const readAutoNowMs = () => {
        const cur = Number(this.nowFn());
        return Number.isFinite(cur) && cur > 0 ? Math.floor(cur) : nowWallMs;
      };
      const runAtomicClaim = () => {
        const txNowWallMs = readAutoNowMs();
        let freshLeaseForTx = workingLease;
        let freshTiming = timing;
        let freshTtl = effectiveTtlSec;
        let freshTriggerLead = effectiveTriggerLeadSec;
        let freshMinRem = effectiveMinRemainSec;
        if (typeof store.getMeta === "function") {
          const freshLease = readWatchdogLease(store, convId);
          if (!freshLease) {
            return { claimed: false, unCover: false, clearNarrowSkip: true };
          }
          freshLeaseForTx = freshLease;
          const freshStop = String(freshLease.stopReason || "").trim();
          if (
            freshLease.phase !== WATCHDOG_PHASES.IDLE ||
            freshLease.isSubagent ||
            freshLease.subphase !== "stopped" ||
            INELIGIBLE_KEEPALIVE_STOP_REASON_RE.test(freshStop)
          ) {
            return { claimed: false, unCover: false, clearNarrowSkip: true };
          }
          freshTtl = this._resolveLeaseEffectiveTtlSec(store, freshLease, cfg, txNowWallMs);
          freshTiming = computeLeaseTtlTiming(freshLease, { effectiveTtlSec: freshTtl, nowWallMs: txNowWallMs });
          if (freshTiming.idleAnchorTs > 0 && freshTiming.idleAnchorTs !== idleAnchorTs) {
            return { claimed: false, unCover: false, clearNarrowSkip: true };
          }
          const freshEffLead = Math.min(leadSec, Math.max(5, Math.floor(freshTtl * 0.5)));
          freshTriggerLead = Math.min(
            Math.max(5, Math.floor(freshTtl * 0.75)),
            freshEffLead + deliveryCompSec
          );
          freshMinRem = computeEffectiveKeepaliveMinRemainSec(
            minRemainSec,
            deliveryCompSec,
            freshTriggerLead
          );
        }
        // Re-check persisted keepalive enablement, quota, and state BEFORE narrow-margin skip
        // (for both initial <= M and lock-wait drift into <= M) so a concurrent manual/auto
        // claim, toggle-off, quota change, or cooldown never records a spurious narrow skip or
        // reminder, while genuine narrow skip itself writes 0 DB rows.
        if (!this._resolveTtlKeepaliveEnabled(store, cfg, convId, freshLeaseForTx)) {
          return { claimed: false, unCover: false, clearNarrowSkip: true };
        }
        const freshMaxCount = this._resolveTtlKeepaliveMaxCount(store, cfg, convId);
        const freshKa =
          typeof store.getTtlKeepaliveState === "function"
            ? store.getTtlKeepaliveState(convId)
            : kaState;
        const freshCooldownTs = Math.max(freshKa.lastSentTs || 0, freshKa.lastAttemptTs || 0);
        if (freshKa.coldMissTripped) {
          return { claimed: false, unCover: true, clearNarrowSkip: true };
        }
        if (
          freshKa.lastIdleAnchorTs === idleAnchorTs ||
          this._keepaliveInFlight.has(convId) ||
          isKeepalivePendingAckActive(freshKa, txNowWallMs)
        ) {
          return { claimed: false, unCover: false, clearNarrowSkip: true };
        }
        if (freshKa.usedCount >= freshMaxCount) {
          return {
            claimed: false,
            unCover: true,
            clearNarrowSkip: true,
            ...(freshKa.lastIdleAnchorTs > 0 && freshKa.lastIdleAnchorTs !== idleAnchorTs
              ? { exhausted: { usedCount: freshKa.usedCount, maxCount: freshMaxCount } }
              : {})
          };
        }
        if (freshCooldownTs > 0 && txNowWallMs - freshCooldownTs < 25_000) {
          return { claimed: false, unCover: false, clearNarrowSkip: true };
        }
        const freshIntervalSec = this._resolveTtlKeepaliveIntervalSec(store, cfg, convId);
        const freshIsFixed = freshIntervalSec > 0;
        const freshFixedTriggerAt = freshIsFixed ? Math.max(30, freshIntervalSec - deliveryCompSec) : 0;
        const freshFixedMaxWindow = freshIsFixed
          ? Math.max(Math.round(freshIntervalSec * 1.5), freshIntervalSec + 120)
          : 0;
        if (!freshTiming.valid) {
          return { claimed: false, unCover: false, clearNarrowSkip: true };
        }
        if (freshIsFixed) {
          if (freshTiming.idleSec > freshFixedMaxWindow) {
            return { claimed: false, unCover: false, clearNarrowSkip: true };
          }
          if (freshTiming.idleSec < freshFixedTriggerAt) {
            return { claimed: false, unCover: false };
          }
        } else {
          if (freshTiming.remSec <= 0) {
            return { claimed: false, unCover: false, clearNarrowSkip: true };
          }
          if (freshTiming.remSec > freshTriggerLead) {
            return { claimed: false, unCover: false };
          }
          if (freshMinRem > 0 && freshTiming.remSec <= freshMinRem) {
            return {
              claimed: false,
              unCover: true,
              narrowSkipInfo: {
                idleAnchorTs: freshTiming.idleAnchorTs,
                originTs: freshTiming.originTs,
                remSec: freshTiming.remSec,
                minRemainSec: freshMinRem,
                effectiveTtlSec: freshTtl,
                atMs: txNowWallMs
              }
            };
          }
        }
        const claimedNextUsed = freshKa.usedCount + 1;
        const txDispatchId = `ka_${txNowWallMs.toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
        store.setTtlKeepaliveState?.(convId, {
          usedCount: claimedNextUsed,
          lastIdleAnchorTs: idleAnchorTs,
          lastSentTs: txNowWallMs,
          lastAttemptTs: txNowWallMs,
          pendingAck: true,
          inKeepaliveTurn: false,
          lastDispatchId: txDispatchId,
          lastDispatchMode: "auto",
          pendingColdCheckId: "",
          lastError: "",
          updatedTs: txNowWallMs
        });
        return {
          claimed: true,
          dispatchId: txDispatchId,
          sentAtMs: txNowWallMs,
          nextUsed: claimedNextUsed,
          maxCount: freshMaxCount,
          prevUsed: freshKa.usedCount,
          prevAnchor: freshKa.lastIdleAnchorTs,
          prevLastSentTs: freshKa.lastSentTs || 0,
          prevDispatchId: freshKa.lastDispatchId || "",
          prevDispatchMode: freshKa.lastDispatchMode || "",
          prevPendingColdCheckId: freshKa.pendingColdCheckId || ""
        };
      };

      let claimRes = { claimed: false };
      try {
        if (typeof store._withWriteTx === "function") {
          if (typeof store.open === "function") store.open();
          claimRes = store._withWriteTx(runAtomicClaim);
        } else {
          claimRes = runAtomicClaim();
        }
      } catch {
        claimRes = { claimed: false };
      }
      if (!claimRes || !claimRes.claimed) {
        if (claimRes?.clearNarrowSkip) {
          this._narrowMarginSkipped.delete(convId);
        }
        if (claimRes?.exhausted) {
          exhaustedConvMap.set(convId, claimRes.exhausted);
        }
        if (claimRes?.narrowSkipInfo) {
          const prevSkip = this._narrowMarginSkipped.get(convId);
          if (!prevSkip || prevSkip.idleAnchorTs !== claimRes.narrowSkipInfo.idleAnchorTs) {
            this.ttlKeepaliveNarrowSkippedCount += 1;
          }
          this._narrowMarginSkipped.set(convId, claimRes.narrowSkipInfo);
        }
        if (claimRes?.unCover) {
          coveredConvIds.delete(convId);
        }
        continue;
      }

      const dispatchId = claimRes.dispatchId;
      const nextUsed = claimRes.nextUsed;
      const claimedMaxCount = claimRes.maxCount || maxCount;
      const isZh = uiLang === "zh";
      const message = isZh
        ? `[agy-dart TTL保活 ${nextUsed}/${claimedMaxCount}] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。`
        : `[agy-dart TTL Keepalive ${nextUsed}/${claimedMaxCount}] Reply OK only to keep the prompt cache warm. Do not call any tools or modify any files.`;
      const claimMeta = {
        dispatchId,
        isManual: false,
        prevUsed: claimRes.prevUsed,
        prevAnchor: claimRes.prevAnchor,
        prevLastSentTs: claimRes.prevLastSentTs || 0,
        prevDispatchId: claimRes.prevDispatchId,
        prevDispatchMode: claimRes.prevDispatchMode,
        prevPendingColdCheckId: claimRes.prevPendingColdCheckId || "",
        sentAtMs: claimRes.sentAtMs
      };

      this._narrowMarginSkipped.delete(convId);
      this._keepaliveInFlight.set(convId, dispatchId);

      Promise.resolve()
        .then(() =>
          this.keepaliveSendFn({
            conversationId: convId,
            message,
            dispatchId,
            usedCount: nextUsed,
            maxCount: claimedMaxCount,
            cwd: workingLease.cwd || ""
          })
        )
        .then((res) => {
          if (res && res.skippedSubagent === true) {
            this._rollbackKeepaliveClaimIfOwned(
              store,
              convId,
              claimMeta,
              res.error || "subagent_keepalive_suppressed",
              { mode: "subagent" }
            );
            return;
          }
          if (res && res.skippedKilled === true) {
            this._rollbackKeepaliveClaimIfOwned(
              store,
              convId,
              claimMeta,
              res.error || "killed_conversation_keepalive_suppressed",
              { mode: "killed" }
            );
            return;
          }
          if (res && res.skippedArchived === true) {
            this._rollbackKeepaliveClaimIfOwned(
              store,
              convId,
              claimMeta,
              res.error || "archived_conversation_keepalive_suppressed",
              { mode: "archived" }
            );
            return;
          }
          if (res && res.ok === false) {
            throw new Error(res.error || "keepalive_send_failed");
          }
          this.ttlKeepaliveCount += 1;
        })
        .catch((err) => {
          this._rollbackKeepaliveClaimIfOwned(
            store,
            convId,
            claimMeta,
            String(err?.message || err || "keepalive_send_failed")
          );
        })
        .finally(() => {
          if (this._keepaliveInFlight.get(convId) === dispatchId) {
            this._keepaliveInFlight.delete(convId);
          }
        });
    }

    return { coveredConvIds, exhaustedConvMap, updatedLeasesById };
  }

  /**
   * Synchronous entry for manual 1x cache warming (works even when Auto-Keepalive is OFF).
   * Validates eligibility, atomically claims the idle cycle inside a write tx, and dispatches
   * asynchronously via `keepaliveSendFn` without consuming auto `usedCount`.
   */
  triggerManualKeepalive(conversationId, { nowMs, uiLang } = {}) {
    const rawId = typeof conversationId === "string" ? conversationId.trim() : "";
    const lowerId = rawId.toLowerCase();
    const isInvalidOrUnbound =
      !rawId ||
      lowerId === "__unbound__" ||
      RESERVED_CHECKPOINT_SESSION_IDS.has(lowerId) ||
      /^-/.test(rawId) ||
      !isSafeConversationId(rawId);
    if (isInvalidOrUnbound) {
      return { ok: false, status: 400, dispatched: false, error: "Invalid or unbound conversationId" };
    }
    const convId = rawId;
    const store = this.getStore?.();
    if (!store || typeof this.keepaliveSendFn !== "function") {
      return { ok: true, dispatched: false, skippedReason: "unsupported", conversationId: convId };
    }
    const hasExplicitNow = Number.isFinite(Number(nowMs)) && Number(nowMs) > 0;
    const readNowMs = () => {
      if (hasExplicitNow) return Math.floor(Number(nowMs));
      const cur = Number(this.nowFn());
      return Number.isFinite(cur) && cur > 0 ? Math.floor(cur) : Date.now();
    };
    const nowWallMs = readNowMs();
    const cfg = this.getConfig() || {};
    const lease = readWatchdogLease(store, convId);

    if (this._isConversationSubagent(store, convId, lease, { requireDefinitive: true })) {
      return { ok: true, dispatched: false, skippedReason: "subagent", conversationId: convId };
    }
    if (this._isConversationKilled(store, convId, lease)) {
      return { ok: true, dispatched: false, skippedReason: "killed", conversationId: convId };
    }
    if (this._isConversationArchived(store, convId, lease)) {
      return { ok: true, dispatched: false, skippedReason: "archived", conversationId: convId };
    }
    if (!lease) {
      return { ok: true, dispatched: false, skippedReason: "no_lease", conversationId: convId };
    }
    if (lease.phase !== WATCHDOG_PHASES.IDLE || lease.subphase === "stopped_bg_pending") {
      return { ok: true, dispatched: false, skippedReason: "turn_active", conversationId: convId };
    }
    if (lease.subphase !== "stopped") {
      return { ok: true, dispatched: false, skippedReason: "ineligible_stop_state", conversationId: convId };
    }
    const stopReason = String(lease.stopReason || "").trim();
    if (INELIGIBLE_KEEPALIVE_STOP_REASON_RE.test(stopReason)) {
      return { ok: true, dispatched: false, skippedReason: "ineligible_stop_reason", conversationId: convId };
    }

    const effectiveTtlSec = this._resolveLeaseEffectiveTtlSec(store, lease, cfg, nowWallMs);
    const timing = computeLeaseTtlTiming(lease, { effectiveTtlSec, nowWallMs });
    if (!timing.valid) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "no_time_anchor",
        conversationId: convId,
        effectiveTtlSec
      };
    }
    if (timing.remSec <= 0) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "already_expired",
        conversationId: convId,
        remSec: timing.remSec,
        effectiveTtlSec,
        cacheOriginTs: timing.originTs,
        estimatedExpireTs: timing.estimatedExpireTs
      };
    }

    let kaState =
      typeof store.getTtlKeepaliveState === "function"
        ? store.getTtlKeepaliveState(convId)
        : {
            usedCount: 0,
            lastIdleAnchorTs: 0,
            lastSentTs: 0,
            lastAttemptTs: 0,
            pendingAck: false,
            coldMissTripped: false,
            inKeepaliveTurn: false,
            lastColdCheckUsed: 0,
            lastDispatchId: "",
            lastDispatchMode: "",
            pendingColdCheckId: "",
            lastColdCheckedId: "",
            lastError: ""
          };
    if (!kaState.coldMissTripped && hasPendingKeepaliveColdCheck(kaState)) {
      const delayed = this._runDelayedColdMissCheck(store, convId, lease, kaState, nowWallMs);
      if (delayed.coldTripped) {
        kaState =
          typeof store.getTtlKeepaliveState === "function"
            ? store.getTtlKeepaliveState(convId)
            : { ...kaState, coldMissTripped: true };
      }
    }
    if (kaState.coldMissTripped) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "cold_miss_tripped",
        conversationId: convId,
        remSec: timing.remSec,
        effectiveTtlSec,
        cacheOriginTs: timing.originTs,
        estimatedExpireTs: timing.estimatedExpireTs
      };
    }
    if (this._keepaliveInFlight.has(convId)) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "in_flight",
        conversationId: convId,
        remSec: timing.remSec,
        effectiveTtlSec,
        cacheOriginTs: timing.originTs,
        estimatedExpireTs: timing.estimatedExpireTs
      };
    }
    if (isKeepalivePendingAckActive(kaState, nowWallMs)) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "pending_ack",
        conversationId: convId,
        remSec: timing.remSec,
        effectiveTtlSec,
        cacheOriginTs: timing.originTs,
        estimatedExpireTs: timing.estimatedExpireTs
      };
    }
    if (kaState.lastIdleAnchorTs === timing.idleAnchorTs) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "already_dispatched",
        conversationId: convId,
        remSec: timing.remSec,
        effectiveTtlSec,
        cacheOriginTs: timing.originTs,
        estimatedExpireTs: timing.estimatedExpireTs
      };
    }
    const lastManualCooldownTs = Math.max(kaState.lastSentTs || 0, kaState.lastAttemptTs || 0);
    if (lastManualCooldownTs > 0 && nowWallMs - lastManualCooldownTs < MANUAL_KEEPALIVE_COOLDOWN_MS) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: "cooldown",
        conversationId: convId,
        remSec: timing.remSec,
        effectiveTtlSec,
        cacheOriginTs: timing.originTs,
        estimatedExpireTs: timing.estimatedExpireTs
      };
    }

    const deliveryMs =
      typeof store.getTtlKeepaliveDeliveryMs === "function" ? store.getTtlKeepaliveDeliveryMs() : 0;
    const deliveryCompSec = deliveryMs > 0 ? Math.min(20, Math.ceil(deliveryMs / 1000)) : 0;
    const leadSec = Math.min(180, Math.max(10, Math.floor(Number(cfg.ttlKeepaliveLeadSec) || 60)));
    const minRemainSec = this._resolveTtlKeepaliveMinRemainSec(cfg);

    const expectedIdleAnchorTs = timing.idleAnchorTs;
    const expectedStartedTs = Number.isFinite(Number(lease.startedTs)) && lease.startedTs > 0 ? Math.floor(lease.startedTs) : 0;
    const runAtomicManualClaim = () => {
      const txNowWallMs = readNowMs();
      const freshLease = readWatchdogLease(store, convId);
      if (!freshLease) return { claimed: false, skippedReason: "no_lease" };
      if (
        freshLease.isSubagent ||
        (freshLease.parentConversationId && freshLease.parentConversationId !== convId) ||
        (freshLease.rootSessionId && freshLease.rootSessionId !== convId)
      ) {
        return { claimed: false, skippedReason: "subagent" };
      }
      if (freshLease.phase !== WATCHDOG_PHASES.IDLE || freshLease.subphase === "stopped_bg_pending") {
        return { claimed: false, skippedReason: "turn_active" };
      }
      if (freshLease.subphase !== "stopped") {
        return { claimed: false, skippedReason: "ineligible_stop_state" };
      }
      const freshStop = String(freshLease.stopReason || "").trim();
      if (INELIGIBLE_KEEPALIVE_STOP_REASON_RE.test(freshStop)) {
        return { claimed: false, skippedReason: "ineligible_stop_reason" };
      }
      const freshTtlSec = this._resolveLeaseEffectiveTtlSec(store, freshLease, cfg, txNowWallMs);
      const freshTiming = computeLeaseTtlTiming(freshLease, { effectiveTtlSec: freshTtlSec, nowWallMs: txNowWallMs });
      const freshStartedTs =
        Number.isFinite(Number(freshLease.startedTs)) && freshLease.startedTs > 0 ? Math.floor(freshLease.startedTs) : 0;
      if (
        (freshTiming.idleAnchorTs > 0 && freshTiming.idleAnchorTs !== expectedIdleAnchorTs) ||
        (expectedStartedTs > 0 && freshStartedTs > 0 && freshStartedTs !== expectedStartedTs)
      ) {
        return {
          claimed: false,
          skippedReason: "idle_cycle_changed",
          ...(freshTiming.valid
            ? {
                remSec: freshTiming.remSec,
                cacheOriginTs: freshTiming.originTs,
                estimatedExpireTs: freshTiming.estimatedExpireTs
              }
            : {}),
          effectiveTtlSec: freshTtlSec
        };
      }
      if (!freshTiming.valid) {
        return { claimed: false, skippedReason: "no_time_anchor", effectiveTtlSec: freshTtlSec };
      }
      if (freshTiming.remSec <= 0) {
        return {
          claimed: false,
          skippedReason: "already_expired",
          remSec: freshTiming.remSec,
          effectiveTtlSec: freshTtlSec,
          cacheOriginTs: freshTiming.originTs,
          estimatedExpireTs: freshTiming.estimatedExpireTs
        };
      }
      const freshKa =
        typeof store.getTtlKeepaliveState === "function" ? store.getTtlKeepaliveState(convId) : kaState;
      if (freshKa.coldMissTripped) {
        return {
          claimed: false,
          skippedReason: "cold_miss_tripped",
          remSec: freshTiming.remSec,
          effectiveTtlSec: freshTtlSec,
          cacheOriginTs: freshTiming.originTs,
          estimatedExpireTs: freshTiming.estimatedExpireTs
        };
      }
      if (this._keepaliveInFlight.has(convId)) {
        return {
          claimed: false,
          skippedReason: "in_flight",
          remSec: freshTiming.remSec,
          effectiveTtlSec: freshTtlSec
        };
      }
      if (isKeepalivePendingAckActive(freshKa, txNowWallMs)) {
        return {
          claimed: false,
          skippedReason: "pending_ack",
          remSec: freshTiming.remSec,
          effectiveTtlSec: freshTtlSec
        };
      }
      if (freshKa.lastIdleAnchorTs === freshTiming.idleAnchorTs) {
        return {
          claimed: false,
          skippedReason: "already_dispatched",
          remSec: freshTiming.remSec,
          effectiveTtlSec: freshTtlSec
        };
      }
      const freshManualCooldownTs = Math.max(freshKa.lastSentTs || 0, freshKa.lastAttemptTs || 0);
      if (freshManualCooldownTs > 0 && txNowWallMs - freshManualCooldownTs < MANUAL_KEEPALIVE_COOLDOWN_MS) {
        return {
          claimed: false,
          skippedReason: "cooldown",
          remSec: freshTiming.remSec,
          effectiveTtlSec: freshTtlSec
        };
      }
      const txDispatchId = `ka_${txNowWallMs.toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
      store.setTtlKeepaliveState?.(convId, {
        lastIdleAnchorTs: freshTiming.idleAnchorTs,
        lastSentTs: txNowWallMs,
        lastAttemptTs: txNowWallMs,
        pendingAck: true,
        inKeepaliveTurn: false,
        lastDispatchId: txDispatchId,
        lastDispatchMode: "manual",
        pendingColdCheckId: "",
        lastError: "",
        updatedTs: txNowWallMs
      });
      return {
        claimed: true,
        dispatchId: txDispatchId,
        sentAtMs: txNowWallMs,
        lease: freshLease,
        timing: freshTiming,
        effectiveTtlSec: freshTtlSec,
        usedCount: freshKa.usedCount,
        prevAnchor: freshKa.lastIdleAnchorTs,
        prevLastSentTs: freshKa.lastSentTs || 0,
        prevDispatchId: freshKa.lastDispatchId || "",
        prevDispatchMode: freshKa.lastDispatchMode || "",
        prevPendingColdCheckId: freshKa.pendingColdCheckId || ""
      };
    };

    let claimRes = { claimed: false, skippedReason: "tx_failed" };
    try {
      if (typeof store._withWriteTx === "function") {
        if (typeof store.open === "function") store.open();
        claimRes = store._withWriteTx(runAtomicManualClaim);
      } else {
        claimRes = runAtomicManualClaim();
      }
    } catch (err) {
      return {
        ok: false,
        status: 500,
        dispatched: false,
        skippedReason: "tx_failed",
        error: String(err?.message || err || "keepalive_claim_tx_failed").slice(0, 180),
        conversationId: convId
      };
    }

    if (!claimRes || !claimRes.claimed) {
      return {
        ok: true,
        dispatched: false,
        skippedReason: claimRes?.skippedReason || "cooldown",
        conversationId: convId,
        ...(claimRes?.remSec !== undefined ? { remSec: claimRes.remSec } : {}),
        ...(claimRes?.effectiveTtlSec !== undefined ? { effectiveTtlSec: claimRes.effectiveTtlSec } : {}),
        ...(claimRes?.cacheOriginTs !== undefined ? { cacheOriginTs: claimRes.cacheOriginTs } : {}),
        ...(claimRes?.estimatedExpireTs !== undefined ? { estimatedExpireTs: claimRes.estimatedExpireTs } : {})
      };
    }

    const dispatchId = claimRes.dispatchId;
    const claimedTtlSec = claimRes.effectiveTtlSec;
    const claimedTiming = claimRes.timing;
    const effLeadSec = Math.min(leadSec, Math.max(5, Math.floor(claimedTtlSec * 0.5)));
    const effTriggerLeadSec = Math.min(
      Math.max(5, Math.floor(claimedTtlSec * 0.75)),
      effLeadSec + deliveryCompSec
    );
    const effMinRemSec = computeEffectiveKeepaliveMinRemainSec(minRemainSec, deliveryCompSec, effTriggerLeadSec);
    const tightMargin = Boolean(effMinRemSec > 0 && claimedTiming.remSec <= effMinRemSec);

    const resolvedLang =
      uiLang === "zh" || uiLang === "en" ? uiLang : this._resolveUiLangInfo(store, cfg).lang;
    const message = buildManualKeepaliveMessage(resolvedLang);
    const claimMeta = {
      dispatchId,
      isManual: true,
      prevUsed: claimRes.usedCount,
      prevAnchor: claimRes.prevAnchor,
      prevLastSentTs: claimRes.prevLastSentTs || 0,
      prevDispatchId: claimRes.prevDispatchId,
      prevDispatchMode: claimRes.prevDispatchMode,
      prevPendingColdCheckId: claimRes.prevPendingColdCheckId || "",
      sentAtMs: claimRes.sentAtMs
    };

    this._narrowMarginSkipped.delete(convId);
    this._keepaliveInFlight.set(convId, dispatchId);

    Promise.resolve()
      .then(() =>
        this.keepaliveSendFn({
          conversationId: convId,
          message,
          manual: true,
          dispatchId,
          usedCount: claimRes.usedCount,
          maxCount: this._resolveTtlKeepaliveMaxCount(store, cfg, convId),
          cwd: claimRes.lease?.cwd || ""
        })
      )
      .then((res) => {
        if (res && res.skippedSubagent === true) {
          this._rollbackKeepaliveClaimIfOwned(
            store,
            convId,
            claimMeta,
            res.error || "subagent_keepalive_suppressed",
            { mode: "subagent" }
          );
          return;
        }
        if (res && res.skippedKilled === true) {
          this._rollbackKeepaliveClaimIfOwned(
            store,
            convId,
            claimMeta,
            res.error || "killed_conversation_keepalive_suppressed",
            { mode: "killed" }
          );
          return;
        }
        if (res && res.skippedArchived === true) {
          this._rollbackKeepaliveClaimIfOwned(
            store,
            convId,
            claimMeta,
            res.error || "archived_conversation_keepalive_suppressed",
            { mode: "archived" }
          );
          return;
        }
        if (res && res.ok === false) {
          throw new Error(res.error || "keepalive_send_failed");
        }
        this.manualKeepaliveCount += 1;
      })
      .catch((err) => {
        this._rollbackKeepaliveClaimIfOwned(
          store,
          convId,
          claimMeta,
          String(err?.message || err || "keepalive_send_failed")
        );
      })
      .finally(() => {
        if (this._keepaliveInFlight.get(convId) === dispatchId) {
          this._keepaliveInFlight.delete(convId);
        }
      });

    return {
      ok: true,
      dispatched: true,
      skippedReason: "",
      conversationId: convId,
      dispatchId,
      remSec: claimedTiming.remSec,
      effectiveTtlSec: claimedTtlSec,
      cacheOriginTs: claimedTiming.originTs,
      estimatedExpireTs: claimedTiming.estimatedExpireTs,
      effectiveMinRemainSec: effMinRemSec,
      tightMargin
    };
  }

  _evaluateIdleTtlNotifications(
    store,
    leases,
    {
      nowWallMs,
      cfg,
      ttlDesktopNotifyEnabled,
      uiLang = "en",
      sleepJumpMs,
      coveredConvIds = null,
      exhaustedConvMap = null,
      updatedLeasesById = null,
      activeChildParents = null
    }
  ) {
    if (!ttlDesktopNotifyEnabled || !Array.isArray(leases) || leases.length === 0) {
      return;
    }
    const minTokens = Math.min(500000, Math.max(4000, Math.floor(Number(cfg.ttlNotifyMinTokens) || 60000)));
    const leadSec = Math.min(300, Math.max(15, Math.floor(Number(cfg.ttlNotifyLeadSec) || 60)));

    if (sleepJumpMs !== 0) {
      for (const rawLease of leases) {
        const lease = (rawLease && updatedLeasesById?.get(rawLease.conversationId)) || rawLease;
        if (!lease || lease.phase !== WATCHDOG_PHASES.IDLE || lease.isSubagent) continue;
        const idleAnchorTs = lease.idleAnchorTs || lease.phaseChangedTs || lease.updatedTs || 0;
        if (idleAnchorTs > 0) {
          this._ttlNotifiedKeys.set(lease.conversationId, `${lease.conversationId}:${idleAnchorTs}`);
        }
      }
      return;
    }

    const fmtDur = (sec) => {
      if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
      if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
      if (sec >= 60) return `${Math.floor(sec / 60)}m${sec % 60}s`;
      return `${sec}s`;
    };

    for (const rawLease of leases) {
      const lease = (rawLease && updatedLeasesById?.get(rawLease.conversationId)) || rawLease;
      if (
        !lease ||
        lease.phase !== WATCHDOG_PHASES.IDLE ||
        this._isConversationSubagent(store, lease.conversationId, lease)
      ) {
        continue;
      }
      if (coveredConvIds && coveredConvIds.has(lease.conversationId)) continue;
      if (activeChildParents && activeChildParents.has(lease.conversationId)) continue;
      if (lease.subphase !== "stopped") continue;
      const stopReason = String(lease.stopReason || "").trim();
      if (/^(?:EXECUTOR_TERMINATION_REASON_)?(?:USER_CANCELED|USER_CANCELLED|CANCELED|CANCELLED|ABORTED|ERROR)\b/i.test(stopReason)) {
        continue;
      }
      const exhaustedInfo = exhaustedConvMap?.get(lease.conversationId);

      const ctxTokens = Number(lease.contextTokens || 0);
      if (!exhaustedInfo && ctxTokens < minTokens) continue;

      const effectiveTtlSec = this._resolveLeaseEffectiveTtlSec(store, lease, cfg, nowWallMs);
      if (!(effectiveTtlSec > leadSec)) continue;

      const timing = computeLeaseTtlTiming(lease, { effectiveTtlSec, nowWallMs });
      if (!timing.valid) continue;
      const idleAnchorTs = timing.idleAnchorTs;
      const remSec = timing.remSec;
      if (!(remSec > 0 && remSec <= leadSec)) continue;

      const dedupKey = `${lease.conversationId}:${idleAnchorTs}`;
      if (this._ttlNotifiedKeys.get(lease.conversationId) === dedupKey) continue;
      if (this._lastTtlNotifyGlobalTs > 0 && nowWallMs - this._lastTtlNotifyGlobalTs < 60_000) continue;
      if (this._isConversationKilled(store, lease.conversationId, lease)) continue;
      if (this._isConversationArchived(store, lease.conversationId, lease)) continue;

      const ttlAlertMetaKey = `cache_alert:${lease.conversationId}:ttl_desktop`;
      // Resolve per-window overrides before claiming either kind of TTL popup.
      if (!this._resolveTtlKeepaliveEnabled(store, cfg, lease.conversationId, lease)) continue;
      if (store && (typeof store.getTimedMeta === "function" || typeof store.getMeta === "function")) {
        const claimTtlPopup = () => {
          if (typeof store.getMeta === "function") {
            const liveLease = readWatchdogLease(store, lease.conversationId);
            if (
              !liveLease ||
              liveLease.phase !== WATCHDOG_PHASES.IDLE ||
              liveLease.subphase !== "stopped" ||
              (liveLease.idleAnchorTs || liveLease.phaseChangedTs || liveLease.updatedTs || 0) !== idleAnchorTs
            ) {
              return { claimed: false, alreadyNotified: false };
            }
          }
          if (typeof store.getTtlKeepaliveState === "function") {
            const liveKa = store.getTtlKeepaliveState(lease.conversationId);
            if (liveKa && liveKa.lastIdleAnchorTs === idleAnchorTs) {
              return { claimed: false, alreadyNotified: false };
            }
          }
          const prev =
            typeof store.getTimedMeta === "function"
              ? store.getTimedMeta(ttlAlertMetaKey, "")
              : store.getMeta(ttlAlertMetaKey, "");
          if (prev === dedupKey) return { claimed: false, alreadyNotified: true };
          if (typeof store.setTimedMeta === "function") store.setTimedMeta(ttlAlertMetaKey, dedupKey);
          else if (typeof store.setMeta === "function") store.setMeta(ttlAlertMetaKey, dedupKey);
          return { claimed: true, alreadyNotified: false };
        };
        let popupClaim = { claimed: false, alreadyNotified: false };
        try {
          if (typeof store._withWriteTx === "function") {
            if (typeof store.open === "function") store.open();
            popupClaim = store._withWriteTx(claimTtlPopup);
          } else {
            popupClaim = claimTtlPopup();
          }
        } catch { popupClaim = { claimed: false, alreadyNotified: false }; }
        if (!popupClaim?.claimed) {
          if (popupClaim?.alreadyNotified) {
            this._ttlNotifiedKeys.set(lease.conversationId, dedupKey);
          }
          continue;
        }
      }

      const isZh = uiLang === "zh";
      const notifyLease = this._enrichNotificationLeaseIdentity(lease);
      const { titleTag, bodyPrefix } = buildWindowNotificationPrefix(notifyLease, { isZh });
      const ctxLabel = ctxTokens >= 1000 ? `${Math.round(ctxTokens / 1000)}k ` : "";
      const title = exhaustedInfo
        ? isZh
          ? `agy-dart${titleTag}：自动续温已满 (${exhaustedInfo.usedCount}/${exhaustedInfo.maxCount})`
          : `agy-dart${titleTag}: Auto-Keepalive Limit (${exhaustedInfo.usedCount}/${exhaustedInfo.maxCount})`
        : isZh
          ? `agy-dart${titleTag}：缓存即将过期`
          : `agy-dart${titleTag}: KV-Cache Expiring`;
      const body = sanitizeWatchdogText(
        exhaustedInfo
          ? isZh
            ? `${bodyPrefix}已完成 ${exhaustedInfo.usedCount}/${exhaustedInfo.maxCount} 次自动续温，${ctxLabel}热缓存约 ${remSec} 秒后过期（TTL ${fmtDur(effectiveTtlSec)}）。继续发消息可保热，或等过期后执行 /compact。`
            : `${bodyPrefix}Used ${exhaustedInfo.usedCount}/${exhaustedInfo.maxCount} auto-keepalives; ${ctxLabel}warm cache expires in ~${remSec}s (TTL ${fmtDur(effectiveTtlSec)}). Reply to keep warm or /compact after expiry.`
          : isZh
            ? `${bodyPrefix}${Math.round(ctxTokens / 1000)}k 上下文热缓存约 ${remSec} 秒后过期（TTL ${fmtDur(effectiveTtlSec)}）。继续发消息可保热，或等过期后执行 /compact。`
            : `${bodyPrefix}${Math.round(ctxTokens / 1000)}k context warm cache expires in ~${remSec}s (TTL ${fmtDur(effectiveTtlSec)}). Reply to keep warm or /compact after expiry.`,
        220
      );
      this._ttlNotifiedKeys.set(lease.conversationId, dedupKey);
      this._lastTtlNotifyGlobalTs = nowWallMs;
      try {
        const notifyWsLabel =
          notifyLease.workspaceLabel ||
          (notifyLease.cwd ? formatWorkspaceWindowLabel(notifyLease.cwd) : "");
        const res = this.notifyFn({
          title,
          body,
          platform: this.platform,
          kind: "ttl_expiring",
          conversationId: lease.conversationId,
          cwd: notifyLease.cwd || "",
          workspaceLabel: notifyWsLabel,
          convTitle: notifyLease.convTitle || "",
          onClick: () => {
            this.recordPendingConversationJump({
              conversationId: lease.conversationId,
              cwd: notifyLease.cwd || "",
              workspaceLabel: notifyWsLabel,
              convTitle: notifyLease.convTitle || "",
              source: "ttl_desktop_notify"
            });
          }
        });
        if (!res || res.dispatched !== false) {
          this.ttlNotificationCount += 1;
        }
      } catch {}
    }
  }

  _evaluateWatermarkNotifications(
    store,
    leases,
    { nowWallMs, watermarkDesktopNotifyEnabled, uiLang = "en", sleepJumpMs }
  ) {
    if (!store || !Array.isArray(leases) || leases.length === 0) return;

    const getWmMeta = (k) => {
      try {
        if (typeof store.getTimedMeta === "function") return store.getTimedMeta(k, "") || "";
        if (typeof store.getMeta === "function") return store.getMeta(k, "") || "";
      } catch {}
      return "";
    };
    const setWmMeta = (k, v) => {
      try {
        if (typeof store.setTimedMeta === "function") store.setTimedMeta(k, v);
        else if (typeof store.setMeta === "function") store.setMeta(k, v);
      } catch {}
    };
    const deleteWmMeta = (k) => {
      try {
        if (typeof store.deleteMeta === "function") store.deleteMeta(k);
      } catch {}
    };

    for (const lease of leases) {
      if (!lease || this._isConversationSubagent(store, lease.conversationId, lease)) continue;
      const wmKey = `cache_alert:${lease.conversationId}:wm_desktop`;
      if (lease.watermark === "ok") {
        if (getWmMeta(wmKey)) {
          deleteWmMeta(wmKey);
        }
        continue;
      }

      if (!watermarkDesktopNotifyEnabled || sleepJumpMs !== 0) continue;
      if (lease.watermark !== "critical") continue;
      if (lease.subphase === "stale_cleanup" || lease.subphase === "disabled") continue;
      if (lease.updatedTs <= 0 || nowWallMs < lease.updatedTs) continue;
      if (this.staleLeaseMs > 0 && nowWallMs - lease.updatedTs > this.staleLeaseMs) continue;
      const stopReason = String(lease.stopReason || "").trim();
      if (
        lease.phase === WATCHDOG_PHASES.IDLE &&
        /^(?:EXECUTOR_TERMINATION_REASON_)?(?:USER_CANCELED|USER_CANCELLED|CANCELED|CANCELLED|ABORTED|ERROR)\b/i.test(
          stopReason
        )
      ) {
        continue;
      }

      if (getWmMeta(wmKey) === "critical") continue;
      if (this._isConversationKilled(store, lease.conversationId, lease)) continue;
      if (this._isConversationArchived(store, lease.conversationId, lease)) continue;
      setWmMeta(wmKey, "critical");

      const isZh = uiLang === "zh";
      const notifyLease = this._enrichNotificationLeaseIdentity(lease);
      const { titleTag, bodyPrefix } = buildWindowNotificationPrefix(notifyLease, { isZh });
      const ctxTokens = Math.max(0, Number(notifyLease.contextTokens || 0));
      const ctxK = Math.round(ctxTokens / 1000);
      const winTokens = Number(notifyLease.windowTokens || 0);
      const winPart =
        winTokens > 0 && ctxTokens > 0
          ? `/${Math.round(winTokens / 1000)}k (${Math.min(100, Math.round((ctxTokens / winTokens) * 100))}%)`
          : "";

      const title = isZh ? `agy-dart${titleTag}：上下文快满了` : `agy-dart${titleTag}: Context Almost Full`;
      const body = sanitizeWatchdogText(
        isZh
          ? `${bodyPrefix}上下文已达 ${ctxK}k${winPart}，建议阶段收尾后复制面板「交接简报」并执行 /compact。`
          : `${bodyPrefix}Context at ${ctxK}k${winPart}. Copy Sidecar Handoff Brief and /compact at next milestone.`,
        220
      );

      try {
        const notifyWsLabel =
          notifyLease.workspaceLabel ||
          (notifyLease.cwd ? formatWorkspaceWindowLabel(notifyLease.cwd) : "");
        const res = this.notifyFn({
          title,
          body,
          platform: this.platform,
          kind: "watermark_critical",
          conversationId: lease.conversationId,
          cwd: notifyLease.cwd || "",
          workspaceLabel: notifyWsLabel,
          convTitle: notifyLease.convTitle || "",
          onClick: () => {
            this.recordPendingConversationJump({
              conversationId: lease.conversationId,
              cwd: notifyLease.cwd || "",
              workspaceLabel: notifyWsLabel,
              convTitle: notifyLease.convTitle || "",
              source: "watermark_desktop_notify"
            });
          }
        });
        if (!res || res.dispatched !== false) {
          this.watermarkNotificationCount += 1;
        }
      } catch {}
    }
  }

  _runScopedConfig(fn) {
    if (this._inConfigScope) return fn();
    const beforeCfgStats = getConfigStatCount();
    this._inConfigScope = true;
    try {
      return withConfigSnapshot(fn);
    } finally {
      this._inConfigScope = false;
      const delta = getConfigStatCount() - beforeCfgStats;
      if (delta > 0) this.configStatCount += delta;
    }
  }

  tick() {
    return this._runScopedConfig(() => this._tickWithScopedConfig());
  }

  _tickWithScopedConfig() {
    const nowWallMs = this.nowFn();
    const nowMonoNs = this.monoNsFn();
    const cfg = this.getConfig() || {};
    const pollMs = Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000));
    const store = this.getStore?.();

    if (!this._startupCleaned && store) {
      try {
        this.cleanupStaleLeasesOnStartup(nowWallMs);
      } catch {}
    }

    const enabled = this._resolveWatchdogEnabled(store, cfg);
    const desktopNotifyEnabled = this._resolveDesktopNotifyEnabled(store, cfg);
    const ttlDesktopNotifyEnabled = this._resolveTtlDesktopNotifyEnabled(store, cfg);
    const globalTtlKeepaliveMaxCount = this._resolveGlobalTtlKeepaliveMaxCount(store, cfg);
    const fallbackTtlKeepaliveMaxCount = this._resolveFallbackTtlKeepaliveMaxCount(store, cfg);
    const globalTtlKeepaliveMinContextPct = this._resolveGlobalTtlKeepaliveMinContextPct(store, cfg);
    const globalTtlKeepaliveIntervalSec = this._resolveGlobalTtlKeepaliveIntervalSec(store, cfg);
    const ttlKeepaliveEnabled = this._resolveTtlKeepaliveEnabled(store, cfg);
    const ttlKeepaliveMaxCount = this._resolveTtlKeepaliveMaxCount(store, cfg);
    const ttlKeepaliveActive = Boolean(
      typeof this.keepaliveSendFn === "function" &&
        !this._isTtlKeepaliveForcedOffByEnv() &&
        (ttlKeepaliveEnabled || Boolean(store?.hasAnyExplicitTtlKeepaliveEnabled?.({ globalOff: true })))
    );
    const watermarkDesktopNotifyEnabled = this._resolveWatermarkDesktopNotifyEnabled(store, cfg, {
      desktopNotifyEnabled: enabled && desktopNotifyEnabled,
      ttlDesktopNotifyEnabled
    });
    const langInfo = this._resolveUiLangInfo(store, cfg);
    const uiLang = langInfo.lang;
    const sleepJumpMs = this._checkSleepDrift(nowWallMs, nowMonoNs, pollMs);

    if (!store || (!enabled && !ttlDesktopNotifyEnabled && !ttlKeepaliveActive && !watermarkDesktopNotifyEnabled)) {
      this._convState.clear();
      this._lastEvaluated.clear();
      return {
        enabled,
        desktopNotifyEnabled,
        ttlDesktopNotifyEnabled,
        ttlKeepaliveEnabled,
        ttlKeepaliveMaxCount,
        globalTtlKeepaliveMaxCount,
        fallbackTtlKeepaliveMaxCount,
        globalTtlKeepaliveMinContextPct,
        globalTtlKeepaliveIntervalSec,
        watermarkDesktopNotifyEnabled,
        uiLang,
        uiLangSource: langInfo.source,
        serverNowMs: nowWallMs,
        evaluated: []
      };
    }

    const rawLeases = this._pruneExpiredIdleLeases(store, listWatchdogLeases(store), nowWallMs);
    const leases = rawLeases.map((lease) => {
      if (
        lease &&
        lease.phase === WATCHDOG_PHASES.IDLE &&
        lease.subphase === "stopped_bg_pending" &&
        this.staleLeaseMs > 0 &&
        nowWallMs - (lease.updatedTs || 0) >= this.staleLeaseMs
      ) {
        const retiredBg = {
          ...lease,
          subphase: "stale_cleanup",
          stopReason: "stale_bg_pending_expired",
          phaseChangedTs: nowWallMs,
          updatedTs: nowWallMs,
          lastHeartbeatTs: nowWallMs,
          hookEvent: "SidecarHeal"
        };
        try {
          const cas = writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, retiredBg);
          if (cas.written) return retiredBg;
        } catch {}
      }
      return lease;
    });
    const initialChildActivity = collectChildSubagentActivity(leases, {
      nowMs: nowWallMs,
      maxAgeMs: this.staleLeaseMs
    });
    if (!enabled) {
      this._convState.clear();
      this._lastEvaluated.clear();
      const liveIds = new Set(leases.map((l) => l.conversationId));
      for (const id of this._ttlNotifiedKeys.keys()) {
        if (!liveIds.has(id)) this._ttlNotifiedKeys.delete(id);
      }
      for (const id of this._turn0BackfillChecked.keys()) {
        if (!liveIds.has(id)) this._turn0BackfillChecked.delete(id);
      }
      this._pruneNarrowMarginSkipped(leases);
      const { coveredConvIds, exhaustedConvMap, updatedLeasesById } = this._evaluateIdleTtlKeepalive(store, leases, {
        nowWallMs,
        cfg,
        ttlKeepaliveEnabled,
        ttlKeepaliveMaxCount,
        uiLang,
        sleepJumpMs
      });
      this._evaluateIdleTtlNotifications(store, leases, {
        nowWallMs,
        cfg,
        ttlDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs,
        coveredConvIds,
        exhaustedConvMap,
        updatedLeasesById,
        activeChildParents: initialChildActivity.activeChildParents
      });
      this._evaluateWatermarkNotifications(store, leases, {
        nowWallMs,
        watermarkDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs
      });
      return {
        enabled,
        desktopNotifyEnabled,
        ttlDesktopNotifyEnabled,
        ttlKeepaliveEnabled,
        ttlKeepaliveMaxCount,
        globalTtlKeepaliveMaxCount,
        fallbackTtlKeepaliveMaxCount,
        globalTtlKeepaliveMinContextPct,
        globalTtlKeepaliveIntervalSec,
        watermarkDesktopNotifyEnabled,
        uiLang,
        uiLangSource: langInfo.source,
        serverNowMs: nowWallMs,
        evaluated: []
      };
    }

    const activeLeases = leases.filter((l) => l.phase !== WATCHDOG_PHASES.IDLE);

    // Zero statSync fast path when ALL leases are IDLE (or none exist)
    if (activeLeases.length === 0) {
      const evaluated = leases.map((lease) => {
        const effectiveLease =
          !lease.isSubagent && this._isConversationSubagent(store, lease.conversationId, lease)
            ? { ...lease, isSubagent: true }
            : lease;
        return this._buildIdleEvaluation(effectiveLease, nowWallMs);
      });
      this._lastEvaluated.clear();
      for (const item of evaluated) this._lastEvaluated.set(item.conversationId, item);
      const liveIds = new Set(leases.map((l) => l.conversationId));
      for (const [id, st] of this._convState.entries()) {
        if (!liveIds.has(id)) {
          this._convState.delete(id);
        } else {
          st.sleepGraceMs = 0;
          st.lastTranscriptGrowthTs = 0;
          st.lastTailInfo = null;
          st.lastTailFreshForEnrich = false;
          st.lastTailFreshForHeal = false;
          st.rescueBriefKey = "";
          st.rescueBrief = null;
        }
      }
      for (const id of this._ttlNotifiedKeys.keys()) {
        if (!liveIds.has(id)) this._ttlNotifiedKeys.delete(id);
      }
      for (const id of this._turn0BackfillChecked.keys()) {
        if (!liveIds.has(id)) this._turn0BackfillChecked.delete(id);
      }
      this._pruneNarrowMarginSkipped(leases);
      const { coveredConvIds, exhaustedConvMap, updatedLeasesById } = this._evaluateIdleTtlKeepalive(store, leases, {
        nowWallMs,
        cfg,
        ttlKeepaliveEnabled,
        ttlKeepaliveMaxCount,
        uiLang,
        sleepJumpMs
      });
      if (updatedLeasesById.size > 0) {
        for (const [cid, enriched] of updatedLeasesById.entries()) {
          this._lastEvaluated.set(cid, this._buildIdleEvaluation(enriched, nowWallMs));
        }
      }
      this._evaluateIdleTtlNotifications(store, leases, {
        nowWallMs,
        cfg,
        ttlDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs,
        coveredConvIds,
        exhaustedConvMap,
        updatedLeasesById,
        activeChildParents: initialChildActivity.activeChildParents
      });
      this._evaluateWatermarkNotifications(store, leases, {
        nowWallMs,
        watermarkDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs
      });
      return {
        enabled,
        desktopNotifyEnabled,
        ttlDesktopNotifyEnabled,
        ttlKeepaliveEnabled,
        ttlKeepaliveMaxCount,
        globalTtlKeepaliveMaxCount,
        fallbackTtlKeepaliveMaxCount,
        globalTtlKeepaliveMinContextPct,
        globalTtlKeepaliveIntervalSec,
        watermarkDesktopNotifyEnabled,
        uiLang,
        uiLangSource: langInfo.source,
        serverNowMs: nowWallMs,
        evaluated
      };
    }

    const evaluatedById = new Map();
    const seenIds = new Set();
    const subagentPass = [];
    const primaryPass = [];

    for (const lease of leases) {
      seenIds.add(lease.conversationId);
      if (lease.phase === WATCHDOG_PHASES.IDLE) {
        const st = this._convState.get(lease.conversationId);
        if (st) {
          st.sleepGraceMs = 0;
          st.lastTranscriptGrowthTs = 0;
          st.lastTailInfo = null;
          st.lastTailFreshForEnrich = false;
          st.lastTailFreshForHeal = false;
          st.rescueBriefKey = "";
          st.rescueBrief = null;
        }
        const effectiveIdleLease =
          !lease.isSubagent && this._isConversationSubagent(store, lease.conversationId, lease)
            ? { ...lease, isSubagent: true }
            : lease;
        evaluatedById.set(lease.conversationId, this._buildIdleEvaluation(effectiveIdleLease, nowWallMs));
        continue;
      }
      const isSub = Boolean(
        lease.isSubagent ||
          (lease.parentConversationId && lease.parentConversationId !== lease.conversationId) ||
          (lease.rootSessionId && lease.rootSessionId !== lease.conversationId) ||
          (lease.lastUserInput && isHeadlessWorkerPrompt(lease.lastUserInput)) ||
          this._isConversationSubagent(store, lease.conversationId, lease)
      );
      if (isSub) {
        const effectiveSubLease =
          !lease.isSubagent && store
            ? readWatchdogLease(store, lease.conversationId) || { ...lease, isSubagent: true }
            : lease;
        subagentPass.push(effectiveSubLease);
      } else {
        primaryPass.push(lease);
      }
    }

    // Evaluate active subagents first so any live subagent transcript growth & discovered parent links feed parent heartbeat
    for (const lease of subagentPass) {
      evaluatedById.set(
        lease.conversationId,
        this._evaluateActiveLease(store, lease, {
          nowWallMs,
          cfg,
          desktopNotifyEnabled,
          uiLang,
          sleepJumpMs,
          childHeartbeatTs: initialChildActivity.childHeartbeatByParent.get(lease.conversationId) || 0
        })
      );
    }

    const extraGrowthByConv = new Map();
    for (const [cid, st] of this._convState.entries()) {
      if (st?.lastTranscriptGrowthTs > 0) {
        extraGrowthByConv.set(cid, st.lastTranscriptGrowthTs);
      }
    }
    const postSubagentLeases = leases.map((l) => {
      const ev = evaluatedById.get(l.conversationId);
      if (!ev || !ev.isSubagent) return l;
      const refreshed = store ? readWatchdogLease(store, l.conversationId) : null;
      return {
        ...l,
        ...(refreshed || {}),
        isSubagent: true,
        parentConversationId: refreshed?.parentConversationId || ev.parentConversationId || l.parentConversationId || "",
        rootSessionId: refreshed?.rootSessionId || ev.rootSessionId || l.rootSessionId || l.conversationId,
        lastHeartbeatTs: Math.max(l.lastHeartbeatTs || 0, refreshed?.lastHeartbeatTs || 0, ev.lastActivityTs || 0),
        updatedTs: Math.max(l.updatedTs || 0, refreshed?.updatedTs || 0),
        phase: ev.phase || l.phase,
        subphase: ev.subphase || l.subphase
      };
    });
    const mergedChildActivity = collectChildSubagentActivity(postSubagentLeases, {
      extraGrowthByConv,
      nowMs: nowWallMs,
      maxAgeMs: this.staleLeaseMs
    });

    for (const lease of primaryPass) {
      evaluatedById.set(
        lease.conversationId,
        this._evaluateActiveLease(store, lease, {
          nowWallMs,
          cfg,
          desktopNotifyEnabled,
          uiLang,
          sleepJumpMs,
          childHeartbeatTs: mergedChildActivity.childHeartbeatByParent.get(lease.conversationId) || 0
        })
      );
    }

    const evaluated = leases
      .map((l) => evaluatedById.get(l.conversationId))
      .filter(Boolean);

    for (const id of this._convState.keys()) {
      if (!seenIds.has(id)) this._convState.delete(id);
    }
    for (const id of this._ttlNotifiedKeys.keys()) {
      if (!seenIds.has(id)) this._ttlNotifiedKeys.delete(id);
    }
    for (const id of this._turn0BackfillChecked.keys()) {
      if (!seenIds.has(id)) this._turn0BackfillChecked.delete(id);
    }
    this._pruneNarrowMarginSkipped(leases);

    const idleLeases = leases.filter((l) => l.phase === WATCHDOG_PHASES.IDLE);
    const { coveredConvIds, exhaustedConvMap, updatedLeasesById } = this._evaluateIdleTtlKeepalive(store, idleLeases, {
      nowWallMs,
      cfg,
      ttlKeepaliveEnabled,
      ttlKeepaliveMaxCount,
      uiLang,
      sleepJumpMs
    });
    if (updatedLeasesById.size > 0) {
      for (const [cid, enriched] of updatedLeasesById.entries()) {
        evaluatedById.set(cid, this._buildIdleEvaluation(enriched, nowWallMs));
      }
    }
    this._evaluateIdleTtlNotifications(store, idleLeases, {
      nowWallMs,
      cfg,
      ttlDesktopNotifyEnabled,
      uiLang,
      sleepJumpMs,
      coveredConvIds,
      exhaustedConvMap,
      updatedLeasesById,
      activeChildParents: mergedChildActivity.activeChildParents
    });
    this._evaluateWatermarkNotifications(store, leases, {
      nowWallMs,
      watermarkDesktopNotifyEnabled,
      uiLang,
      sleepJumpMs
    });

    this._lastEvaluated.clear();
    for (const item of evaluated) {
      this._lastEvaluated.set(item.conversationId, item);
    }

    return {
      enabled,
      desktopNotifyEnabled,
      ttlDesktopNotifyEnabled,
      ttlKeepaliveEnabled,
      ttlKeepaliveMaxCount,
      globalTtlKeepaliveMaxCount,
      fallbackTtlKeepaliveMaxCount,
      globalTtlKeepaliveMinContextPct,
      globalTtlKeepaliveIntervalSec,
      watermarkDesktopNotifyEnabled,
      uiLang,
      uiLangSource: langInfo.source,
      serverNowMs: nowWallMs,
      evaluated
    };
  }

  _queryRecentStoreActivityTs(store, conversationId, nowWallMs) {
    if (!store || !store.db || typeof store.db.prepare !== "function" || !conversationId) return 0;
    let maxTs = 0;
    try {
      const cpRow = store.db
        .prepare("SELECT updated_ts FROM session_checkpoints WHERE session_id = ? LIMIT 1")
        .get(conversationId);
      if (cpRow && Number.isFinite(Number(cpRow.updated_ts))) {
        maxTs = Math.max(maxTs, Math.floor(Number(cpRow.updated_ts)));
      }
    } catch {}
    try {
      const srcRow = store.db
        .prepare("SELECT MAX(created_ts) AS ts FROM sources WHERE session_id = ?")
        .get(conversationId);
      if (srcRow && Number.isFinite(Number(srcRow.ts))) {
        maxTs = Math.max(maxTs, Math.floor(Number(srcRow.ts)));
      }
    } catch {}
    try {
      const evRow = store.db
        .prepare("SELECT created_at FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
        .get(conversationId);
      if (evRow && typeof evRow.created_at === "string" && evRow.created_at) {
        const parsed = Date.parse(evRow.created_at);
        if (Number.isFinite(parsed) && parsed > maxTs) maxTs = parsed;
      }
    } catch {}
    return maxTs > 0 ? Math.min(maxTs, nowWallMs) : 0;
  }

  _buildIdleEvaluation(lease, nowWallMs) {
    return {
      conversationId: lease.conversationId,
      rootSessionId: lease.rootSessionId,
      parentConversationId: lease.parentConversationId,
      isSubagent: lease.isSubagent,
      phase: WATCHDOG_PHASES.IDLE,
      subphase: lease.subphase || "idle",
      bucket: "idle",
      severity: "idle",
      rawSeverity: "idle",
      silentSec: 0,
      suspectSec: 0,
      stalledSec: 0,
      progressPct: 0,
      lastActivityTs: lease.lastHeartbeatTs || lease.updatedTs || nowWallMs,
      startedTs: lease.startedTs || lease.updatedTs || nowWallMs,
      phaseChangedTs: lease.phaseChangedTs || lease.updatedTs || nowWallMs,
      activeTool: "",
      activeToolKind: "",
      activeToolSummary: "",
      lastCompletedTool: lease.lastCompletedTool || "",
      lastUserInput: lease.lastUserInput || "",
      cwd: lease.cwd || "",
      workspaceLabel: lease.workspaceLabel || "",
      convTitle: lease.convTitle || "",
      contextTokens: lease.contextTokens || 0,
      windowTokens: lease.windowTokens || 0,
      watermark: lease.watermark || "",
      mediaCount: lease.mediaCount || 0,
      model: lease.model || "",
      stopReason: lease.stopReason || "",
      selfHealed: lease.hookEvent === "SidecarHeal",
      transcriptGrowing: false,
      snoozedUntilTs: 0,
      diagnosis: null,
      rescueBrief: null
    };
  }

  _applyTailEnrichment(lease, tailInfo, tailIsFresh) {
    if (!tailInfo) return;
    if (tailInfo.detectedSubagent && !lease.isSubagent) {
      lease.isSubagent = true;
    }
    if (tailInfo.contextTokens > 0 && (tailIsFresh || !lease.contextTokens)) {
      lease.contextTokens = tailInfo.contextTokens;
    }
    if (tailInfo.mediaCount > 0) {
      lease.mediaCount = Math.max(lease.mediaCount || 0, tailInfo.mediaCount);
    }
    if (tailInfo.model && (tailIsFresh || !lease.model)) lease.model = tailInfo.model;
    if (tailInfo.latestUserInput && !lease.lastUserInput) {
      lease.lastUserInput = tailInfo.latestUserInput;
      lease.isCompactCmd = lease.isCompactCmd || tailInfo.isCompactCmd;
    }
    if (!tailIsFresh || tailInfo.isTerminal) return;

    if (tailInfo.hasPendingToolCalls && tailInfo.pendingTool) {
      const pt = tailInfo.pendingTool;
      const curTier = getToolTimeoutTier(lease.activeToolKind, lease.phase);
      const nextPhase = pt.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING;
      const nextTier = getToolTimeoutTier(pt.activeToolKind, nextPhase);

      if (pt.isBackground) {
        lease.phase = WATCHDOG_PHASES.SUBAGENT_BG;
        lease.subphase = pt.activeToolKind || "subagent_bg";
        lease.activeTool = pt.activeTool;
        lease.activeToolKind = pt.activeToolKind;
        lease.activeToolSummary = pt.summary || lease.activeToolSummary;
      } else if (
        lease.phase === WATCHDOG_PHASES.LLM_INFLIGHT ||
        (lease.phase === WATCHDOG_PHASES.TOOL_RUNNING && nextTier > curTier)
      ) {
        lease.phase = WATCHDOG_PHASES.TOOL_RUNNING;
        lease.subphase =
          pt.activeToolKind === "sync_cmd" || pt.activeToolKind === "mcp_long" ? "sync_cmd" : "read_or_mcp";
        lease.activeTool = pt.activeTool;
        lease.activeToolKind = pt.activeToolKind;
        lease.activeToolSummary = pt.summary || lease.activeToolSummary;
      } else if (!lease.activeTool) {
        lease.activeTool = pt.activeTool;
        lease.activeToolKind = pt.activeToolKind;
        lease.activeToolSummary = pt.summary || lease.activeToolSummary;
      }
    } else if (
      tailInfo.inferredPhase === WATCHDOG_PHASES.LLM_INFLIGHT &&
      lease.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
      (lease.activeToolKind === "read" ||
        lease.activeToolKind === "host" ||
        SLOW_GEN_TOOL_RE.test(extractBareToolName(lease.activeTool || "")))
    ) {
      // read_file/view_file and non-PostToolUse native host tools do not register PostToolUse; once
      // the transcript confirms all tool calls have results (GENERIC / TOOL_RESULT), return to LLM_INFLIGHT.
      lease.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
      lease.activeTool = "";
      lease.activeToolKind = "";
      lease.activeToolSummary = "";
      lease.activeToolCallId = "";
      lease.pendingSlowCalls = [];
    }
  }

  _evaluateActiveLease(
    store,
    leaseInput,
    { nowWallMs, cfg, desktopNotifyEnabled, uiLang = "en", sleepJumpMs, childHeartbeatTs = 0, _retryDepth = 0 }
  ) {
    let lease = { ...leaseInput };
    if (!lease.isSubagent && this._isConversationSubagent(store, lease.conversationId, lease)) {
      lease.isSubagent = true;
    }
    const st = this._getOrCreateConvState(lease.conversationId);

    if (lease.updatedTs !== st.lastLeaseUpdatedTs) {
      st.lastLeaseUpdatedTs = lease.updatedTs;
      const pollMs = Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000));
      if (sleepJumpMs > 0 && lease.updatedTs < nowWallMs - pollMs) {
        st.sleepGraceMs = Math.min(sleepJumpMs, Math.max(0, nowWallMs - lease.updatedTs - 1000));
      } else if (sleepJumpMs < 0 && lease.updatedTs > nowWallMs) {
        st.sleepGraceMs = Math.max(sleepJumpMs, nowWallMs - lease.updatedTs);
      } else {
        st.sleepGraceMs = 0;
      }
      st.lastTranscriptGrowthTs = 0;
      st.lastTailFreshForHeal = false;
      st.rescueBriefKey = "";
      st.rescueBrief = null;
      if (lease.hookEvent === "PreInvocation") {
        // Fresh PreInvocation stat baseline (handles /compact transcript shrinkage cleanly)
        st.lastTailInfo = null;
        st.lastTailFreshForEnrich = false;
        st.lastStatSize = lease.transcriptSize > 0 ? lease.transcriptSize : -1;
        st.lastStatMtimeMs = lease.transcriptSize > 0 ? lease.transcriptMtimeMs || 0 : 0;
      } else if (lease.transcriptSize > 0 && st.lastStatSize < 0) {
        st.lastStatSize = lease.transcriptSize;
        st.lastStatMtimeMs = lease.transcriptMtimeMs || 0;
      }
    }

    let txPath = lease.transcriptPath || st.transcriptPath || "";
    if (!txPath) {
      try {
        txPath = this.findTranscriptFn(lease.conversationId) || "";
      } catch {
        txPath = "";
      }
    }
    if (txPath) st.transcriptPath = txPath;

    let transcriptGrowing = false;
    let statOk = false;
    let curMtimeMs = 0;
    let curSize = -1;

    if (txPath) {
      try {
        this.statSyncCount += 1;
        const fstat = this.statFn(txPath);
        if (fstat && (typeof fstat.isFile !== "function" || fstat.isFile())) {
          statOk = true;
          curMtimeMs = Number(fstat.mtimeMs || 0);
          curSize = Number(fstat.size || 0);

          const baselineSize = Math.max(st.lastStatSize >= 0 ? st.lastStatSize : 0, lease.transcriptSize || 0);
          const baselineMtime = Math.max(st.lastStatMtimeMs || 0, lease.transcriptMtimeMs || 0);

          const grewBySize = curSize > baselineSize && (st.lastStatSize >= 0 || lease.transcriptSize > 0);
          const grewByMtime =
            curMtimeMs > baselineMtime + 50 && (st.lastStatMtimeMs > 0 || lease.transcriptMtimeMs > 0);

          if (grewBySize || grewByMtime) {
            transcriptGrowing = true;
            const effectiveGrowthTs =
              curMtimeMs > 0 ? Math.min(nowWallMs, Math.max(curMtimeMs, nowWallMs - 1000)) : nowWallMs;
            st.lastTranscriptGrowthTs = Math.max(st.lastTranscriptGrowthTs || 0, effectiveGrowthTs);
          }

          st.lastStatSize = curSize;
          st.lastStatMtimeMs = curMtimeMs;
        }
      } catch {
        // Transcript missing or temporarily locked -> fail-open to hook heartbeat
      }
    }

    const safeChildHb = Number.isFinite(childHeartbeatTs) && childHeartbeatTs > 0 ? Math.min(nowWallMs, childHeartbeatTs) : 0;
    let preActivityTs = Math.max(
      lease.lastHeartbeatTs || lease.updatedTs || nowWallMs,
      st.lastTranscriptGrowthTs || 0,
      safeChildHb
    );
    const preThresholds = resolveDynamicThresholds(lease, cfg);
    let preSilentSec = Math.max(0, Math.round((nowWallMs - preActivityTs - (st.sleepGraceMs || 0)) / 1000));
    let storeActivityTs = 0;
    if (preSilentSec >= 30) {
      storeActivityTs = this._queryRecentStoreActivityTs(store, lease.conversationId, nowWallMs);
      if (storeActivityTs > preActivityTs) {
        preActivityTs = storeActivityTs;
        preSilentSec = Math.max(0, Math.round((nowWallMs - preActivityTs - (st.sleepGraceMs || 0)) / 1000));
      }
    }

    const transcriptChangedSinceInspect =
      statOk && (curSize !== st.lastInspectedSize || curMtimeMs !== st.lastInspectedMtimeMs);
    const approachingAlert =
      preThresholds.suspectSec > 0 && preSilentSec >= Math.max(5, Math.floor(preThresholds.suspectSec * 0.5));

    if (statOk && txPath && curSize > 0 && (transcriptChangedSinceInspect || (approachingAlert && !st.lastTailInfo))) {
      try {
        this.tailReadCount += 1;
        const steps = this.readTailFn(txPath, 65536);
        const tailInfo = inspectTranscriptTailForWatchdog(steps, { isSubagent: lease.isSubagent });
        st.lastInspectedSize = curSize;
        st.lastInspectedMtimeMs = curMtimeMs;
        st.lastTailInfo = tailInfo;

        const hasLeaseBaseline = lease.transcriptSize > 0 || lease.transcriptMtimeMs > 0;
        const turnAnchorTs =
          lease.startedTs > 0
            ? Math.min(lease.startedTs, lease.updatedTs || lease.startedTs)
            : lease.updatedTs || 0;
        let tailIsFreshForHeal = false;
        let tailIsFreshForEnrich = false;
        if (hasLeaseBaseline) {
          // Hard veto: if the file neither grew nor advanced mtime since the hook snapshotted it,
          // any terminal step at the tail belongs to a PRIOR turn (even if <2s earlier!).
          const fileGrew = lease.transcriptSize > 0 && curSize > lease.transcriptSize;
          const fileMtimeAdvanced = lease.transcriptMtimeMs > 0 && curMtimeMs > lease.transcriptMtimeMs + 50;
          const stepNotOlderForHeal =
            tailInfo.lastStepTs === null || tailInfo.lastStepTs >= (lease.updatedTs || 0) - 2000;
          const stepNotOlderForEnrich =
            tailInfo.lastStepTs === null || tailInfo.lastStepTs >= turnAnchorTs - 2000;
          tailIsFreshForHeal = Boolean((fileGrew || fileMtimeAdvanced) && stepNotOlderForHeal);
          tailIsFreshForEnrich = Boolean((fileGrew || fileMtimeAdvanced) && stepNotOlderForEnrich);
        } else {
          const mtimeAfterLease = curMtimeMs > (lease.updatedTs || 0) + 250;
          const stepStrictlyAfter =
            tailInfo.lastStepTs !== null && tailInfo.lastStepTs >= (lease.updatedTs || 0) + 250;
          const stepNotStale = tailInfo.lastStepTs === null || tailInfo.lastStepTs >= (lease.updatedTs || 0) - 1000;
          tailIsFreshForHeal = Boolean((mtimeAfterLease || stepStrictlyAfter) && stepNotStale);

          const mtimeAfterTurnAnchor = curMtimeMs > turnAnchorTs + 250;
          const stepAfterTurnAnchor =
            tailInfo.lastStepTs !== null && tailInfo.lastStepTs >= turnAnchorTs + 250;
          const stepNotStaleForTurn =
            tailInfo.lastStepTs === null || tailInfo.lastStepTs >= turnAnchorTs - 2000;
          tailIsFreshForEnrich = Boolean((mtimeAfterTurnAnchor || stepAfterTurnAnchor) && stepNotStaleForTurn);
        }
        st.lastTailFreshForHeal = tailIsFreshForHeal;
        st.lastTailFreshForEnrich = tailIsFreshForEnrich;

        this._applyTailEnrichment(lease, tailInfo, tailIsFreshForEnrich);

        if (tailInfo.isTerminal && tailIsFreshForHeal) {
          const healedOriginTs =
            tailInfo.lastPlannerPrefillTs > 0 && tailInfo.lastPlannerPrefillTs <= nowWallMs + 5_000
              ? Math.min(nowWallMs, tailInfo.lastPlannerPrefillTs)
              : lease.lastLlmStartTs > 0 && lease.lastLlmStartTs <= nowWallMs
                ? lease.lastLlmStartTs
                : nowWallMs;
          const healedLease = {
            ...lease,
            phase: WATCHDOG_PHASES.IDLE,
            subphase: "self_healed",
            activeTool: "",
            activeToolKind: "",
            activeToolSummary: "",
            activeToolCallId: "",
            pendingSlowCalls: [],
            stopReason: tailInfo.terminalReason || "transcript_terminal_self_heal",
            transcriptPath: txPath,
            transcriptMtimeMs: curMtimeMs,
            transcriptSize: curSize,
            phaseChangedTs: nowWallMs,
            idleAnchorTs: nowWallMs,
            cacheOriginTs: healedOriginTs,
            lastLlmStartTs: 0,
            updatedTs: nowWallMs,
            lastHeartbeatTs: nowWallMs,
            hookEvent: "SidecarHeal",
            ackedUntilTs: 0
          };
          let cas = { written: true, current: healedLease };
          try {
            cas = writeWatchdogLeaseIfUnchanged(store, leaseInput.updatedTs, leaseInput.phase, healedLease);
          } catch {}
          if (!cas.written && cas.current && cas.current.phase !== WATCHDOG_PHASES.IDLE && _retryDepth < 1) {
            // Concurrent hook started a brand-new turn while we were inspecting disk — DO NOT heal it!
            return this._evaluateActiveLease(store, cas.current, {
              nowWallMs,
              cfg,
              desktopNotifyEnabled,
              uiLang,
              sleepJumpMs: 0,
              childHeartbeatTs,
              _retryDepth: _retryDepth + 1
            });
          }
          if (cas.written) {
            st.lastLeaseUpdatedTs = nowWallMs;
            st.sleepGraceMs = 0;
            st.lastTranscriptGrowthTs = 0;
            st.rescueBriefKey = "";
            st.rescueBrief = null;
            return {
              ...this._buildIdleEvaluation(healedLease, nowWallMs),
              selfHealed: true
            };
          }
        }
      } catch {
        // Fail-open on unreadable transcript
      }
    } else if (st.lastTailInfo) {
      this._applyTailEnrichment(lease, st.lastTailInfo, Boolean(st.lastTailFreshForEnrich));
    }

    if (lease.phase === WATCHDOG_PHASES.LLM_INFLIGHT) {
      lease.subphase = deriveLlmSubphase({
        contextTokens: lease.contextTokens,
        mediaCount: lease.mediaCount,
        isCompactCmd: lease.isCompactCmd,
        model: lease.model
      });
    }
    const thresholds = resolveDynamicThresholds(lease, cfg);
    const lastActivityTs = Math.max(
      lease.lastHeartbeatTs || lease.updatedTs || nowWallMs,
      st.lastTranscriptGrowthTs || 0,
      safeChildHb,
      storeActivityTs
    );
    const activeSilentMs = Math.max(0, nowWallMs - lastActivityTs - (st.sleepGraceMs || 0));
    const silentSec = Math.max(0, Math.round(activeSilentMs / 1000));

    // Auto-retire runtime stale active leases (> staleLeaseMs) and abandoned Turn-0 zero-output
    // orphan leases (>= orphanTurn0Ms with 0 assistant steps / 0 context tokens) via CAS so
    // long-running Sidecars recover the 0-statSync IDLE fast path automatically.
    const isRuntimeStale = this.staleLeaseMs > 0 && activeSilentMs >= this.staleLeaseMs;
    const minOrphanMs = Math.max((thresholds.stalledSec || 120) * 1000 + 60_000, this.orphanTurn0Ms);
    const isAbandonedTurn0Orphan =
      !isRuntimeStale &&
      this.orphanTurn0Ms > 0 &&
      lease.phase === WATCHDOG_PHASES.LLM_INFLIGHT &&
      (lease.invocationNum === 0 || lease.invocationNum === null) &&
      (lease.contextTokens || 0) === 0 &&
      !lease.lastCompletedTool &&
      !lease.activeTool &&
      !transcriptGrowing &&
      (!st.lastTailInfo || !st.lastTailInfo.hasAssistantSteps) &&
      lease.ackedUntilTs <= nowWallMs &&
      activeSilentMs >= minOrphanMs;

    if (isRuntimeStale || isAbandonedTurn0Orphan) {
      const retiredLease = {
        ...lease,
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stale_cleanup",
        activeTool: "",
        activeToolKind: "",
        activeToolSummary: "",
        activeToolCallId: "",
        pendingSlowCalls: [],
        transcriptSize: 0,
        transcriptMtimeMs: 0,
        stopReason: isRuntimeStale ? "stale_lease_expired" : "orphan_turn0_abandoned",
        phaseChangedTs: nowWallMs,
        updatedTs: nowWallMs,
        lastHeartbeatTs: nowWallMs,
        hookEvent: "SidecarHeal",
        ackedUntilTs: 0
      };
      let cas = { written: true, current: retiredLease };
      try {
        cas = writeWatchdogLeaseIfUnchanged(store, leaseInput.updatedTs, leaseInput.phase, retiredLease);
      } catch {}
      if (!cas.written && cas.current && cas.current.phase !== WATCHDOG_PHASES.IDLE && _retryDepth < 1) {
        return this._evaluateActiveLease(store, cas.current, {
          nowWallMs,
          cfg,
          desktopNotifyEnabled,
          uiLang,
          sleepJumpMs: 0,
          childHeartbeatTs,
          _retryDepth: _retryDepth + 1
        });
      }
      if (cas.written) {
        st.lastLeaseUpdatedTs = nowWallMs;
        st.sleepGraceMs = 0;
        st.lastTranscriptGrowthTs = 0;
        st.rescueBriefKey = "";
        st.rescueBrief = null;
        return {
          ...this._buildIdleEvaluation(retiredLease, nowWallMs),
          selfHealed: true
        };
      }
    }

    const progressPct =
      thresholds.stalledSec > 0
        ? Math.min(100, Number(((silentSec / thresholds.stalledSec) * 100).toFixed(1)))
        : 0;

    let rawSeverity = "active";
    if (silentSec >= thresholds.stalledSec) {
      rawSeverity = "stalled";
    } else if (silentSec >= thresholds.suspectSec) {
      rawSeverity = "suspect";
    }

    const isSnoozed = rawSeverity !== "active" && lease.ackedUntilTs > nowWallMs;
    const severity = isSnoozed ? "snoozed" : rawSeverity;

    let diagnosis = null;
    let rescueBrief = null;

    if (rawSeverity === "suspect" || rawSeverity === "stalled") {
      diagnosis = diagnoseStallCause(lease, { platform: this.platform });
    }

    const incidentKey =
      rawSeverity === "suspect" || rawSeverity === "stalled"
        ? `${lease.conversationId}:${lease.phaseChangedTs || lease.updatedTs}:${lease.phase}:${rawSeverity}:${diagnosis?.causeId || "unknown"}`
        : "";

    const secretRedactionEnabled = isSecretRedactionEnabled();
    if (rawSeverity === "stalled") {
      if (
        st.rescueBriefKey === incidentKey &&
        st.rescueBrief &&
        st.rescueBrief.secretRedactionEnabled === secretRedactionEnabled
      ) {
        rescueBrief = st.rescueBrief;
      } else {
        try {
          const checkpointSessionId =
            resolveTrustedCheckpointSessionId(store, lease.conversationId, "", { seedLease: lease }) ||
            lease.conversationId;
          const safeLeaseCwd = isSafeWorkspaceDir(lease.cwd) ? lease.cwd : "";
          const workDir = safeLeaseCwd || inferWorkspaceFromStore(store, checkpointSessionId);
          const stallContext = {
            severity: "stalled",
            phase: lease.phase,
            subphase: lease.subphase,
            silentSec,
            stalledThresholdSec: thresholds.stalledSec,
            activeTool: lease.activeTool,
            activeToolSummary: lease.activeToolSummary,
            lastCompletedTool: lease.lastCompletedTool,
            lastUserInput: lease.lastUserInput,
            contextTokens: lease.contextTokens || 0,
            model: lease.model || "",
            causeId: diagnosis?.causeId || "",
            causeLabel: diagnosis?.label || "",
            tips: diagnosis?.tips || []
          };
          const brief = this.buildHandoffFn({
            store,
            mode: "agent",
            conversationId: lease.conversationId,
            conversationConfirmed: true,
            scope: "conversation",
            sessionId: checkpointSessionId,
            cwd: workDir,
            cacheDiag: null,
            maxBytes: 5800,
            stallContext,
            brainRoots: this.brainRoots,
            nowFn: () => nowWallMs
          });
          rescueBrief = {
            mode: brief.mode || "agent",
            confirmedConversation: brief.confirmedConversation !== false,
            conversationId: lease.conversationId,
            sessionId: checkpointSessionId,
            secretRedactionEnabled:
              typeof brief.secretRedactionEnabled === "boolean"
                ? brief.secretRedactionEnabled
                : secretRedactionEnabled,
            markdown: brief.markdown,
            summary: brief.summary,
            bytes: brief.bytes,
            truncated: brief.truncated,
            anchors: brief.anchors || null,
            resumeCommand: brief.resumeCommand || "",
            sampledAt: brief.sampledAt || brief.anchors?.sampledAt || "",
            generatedAt: nowWallMs,
            incidentKey
          };
          st.rescueBriefKey = incidentKey;
          st.rescueBrief = rescueBrief;
        } catch {
          rescueBrief = null;
        }
      }

      if (desktopNotifyEnabled && !isSnoozed && !lease.isSubagent) {
        const cooldownMs = Math.max(30, Number(cfg.watchdogNotifyCooldownSec) || 300) * 1000;
        const sameIncidentAlreadySent = st.lastNotifyKey === incidentKey;
        const inCooldown = st.lastNotifyTs > 0 && nowWallMs - st.lastNotifyTs < cooldownMs;
        if (!sameIncidentAlreadySent && !inCooldown) {
          st.lastNotifyKey = incidentKey;
          st.lastNotifyTs = nowWallMs;
          this.notificationCount += 1;
          try {
            const isZh = uiLang === "zh";
            const notifyLease = this._enrichNotificationLeaseIdentity(lease);
            const { titleTag, bodyPrefix } = buildWindowNotificationPrefix(notifyLease, { isZh });
            const title = isZh ? `agy-dart${titleTag}：对话疑似卡住` : `agy-dart${titleTag}: Session Stalled`;
            const body = sanitizeWatchdogText(
              isZh
                ? `${bodyPrefix}${diagnosis?.labelZh || diagnosis?.label || lease.phase}（已无响应 ${silentSec} 秒）。请打开右侧 agy-dart 面板复制抢救简报。`
                : `${bodyPrefix}${diagnosis?.label || lease.phase} (silent ${silentSec}s). Open Sidecar to copy Rescue Handoff Brief.`,
              220
            );
            const notifyWsLabel =
              notifyLease.workspaceLabel ||
              (notifyLease.cwd ? formatWorkspaceWindowLabel(notifyLease.cwd) : "");
            this.notifyFn({
              title,
              body,
              conversationId: lease.conversationId,
              cwd: notifyLease.cwd || "",
              workspaceLabel: notifyWsLabel,
              convTitle: notifyLease.convTitle || "",
              causeId: diagnosis?.causeId || "",
              silentSec,
              platform: this.platform,
              onClick: () => {
                this.recordPendingConversationJump({
                  conversationId: lease.conversationId,
                  cwd: notifyLease.cwd || "",
                  workspaceLabel: notifyWsLabel,
                  convTitle: notifyLease.convTitle || "",
                  source: "watchdog_desktop_notify"
                });
              }
            });
          } catch {}
        }
      }
    }

    return {
      conversationId: lease.conversationId,
      rootSessionId: lease.rootSessionId,
      parentConversationId: lease.parentConversationId,
      isSubagent: lease.isSubagent,
      phase: lease.phase,
      subphase: lease.subphase,
      bucket: thresholds.bucket,
      severity,
      rawSeverity,
      silentSec,
      suspectSec: thresholds.suspectSec,
      stalledSec: thresholds.stalledSec,
      progressPct,
      lastActivityTs,
      startedTs: lease.startedTs || lease.updatedTs || nowWallMs,
      phaseChangedTs: lease.phaseChangedTs || lease.updatedTs || nowWallMs,
      activeTool: lease.activeTool || "",
      activeToolKind: lease.activeToolKind || "",
      activeToolSummary: lease.activeToolSummary || "",
      lastCompletedTool: lease.lastCompletedTool || "",
      lastUserInput: lease.lastUserInput || "",
      cwd: lease.cwd || "",
      workspaceLabel: lease.workspaceLabel || "",
      convTitle: lease.convTitle || "",
      contextTokens: lease.contextTokens || 0,
      windowTokens: lease.windowTokens || 0,
      watermark: lease.watermark || "",
      mediaCount: lease.mediaCount || 0,
      model: lease.model || "",
      stopReason: lease.stopReason || "",
      selfHealed: false,
      transcriptGrowing,
      snoozedUntilTs: isSnoozed ? lease.ackedUntilTs : 0,
      incidentKey,
      diagnosis,
      rescueBrief
    };
  }

  getStatus(options = {}) {
    return this._runScopedConfig(() => this._getStatusWithScopedConfig(options));
  }

  _getStatusWithScopedConfig({ conversationId = "", scope = "conversation", refresh = true, includeRichRescue = true } = {}) {
    const tickRes = refresh ? this.tick() : null;
    const nowWallMs = tickRes ? tickRes.serverNowMs : this.nowFn();
    const cfg = this.getConfig() || {};
    const store = this.getStore?.();
    const enabled = tickRes ? tickRes.enabled : this._resolveWatchdogEnabled(store, cfg);
    const desktopNotifyEnabled = tickRes
      ? tickRes.desktopNotifyEnabled
      : this._resolveDesktopNotifyEnabled(store, cfg);
    const ttlDesktopNotifyEnabled = tickRes
      ? tickRes.ttlDesktopNotifyEnabled
      : this._resolveTtlDesktopNotifyEnabled(store, cfg);
    const globalTtlKeepaliveMaxCount = tickRes
      ? tickRes.globalTtlKeepaliveMaxCount
      : this._resolveGlobalTtlKeepaliveMaxCount(store, cfg);
    const fallbackTtlKeepaliveMaxCount = tickRes
      ? tickRes.fallbackTtlKeepaliveMaxCount
      : this._resolveFallbackTtlKeepaliveMaxCount(store, cfg);
    const globalTtlKeepaliveMinContextPct = tickRes
      ? tickRes.globalTtlKeepaliveMinContextPct
      : this._resolveGlobalTtlKeepaliveMinContextPct(store, cfg);
    const globalTtlKeepaliveIntervalSec = tickRes
      ? tickRes.globalTtlKeepaliveIntervalSec
      : this._resolveGlobalTtlKeepaliveIntervalSec(store, cfg);
    const ttlKeepaliveEnabled = tickRes
      ? tickRes.ttlKeepaliveEnabled
      : this._resolveTtlKeepaliveEnabled(store, cfg);
    const ttlKeepaliveMaxCount = tickRes
      ? tickRes.ttlKeepaliveMaxCount
      : this._resolveTtlKeepaliveMaxCount(store, cfg);
    const watermarkDesktopNotifyEnabled = tickRes
      ? tickRes.watermarkDesktopNotifyEnabled
      : this._resolveWatermarkDesktopNotifyEnabled(store, cfg, {
          desktopNotifyEnabled: enabled && desktopNotifyEnabled,
          ttlDesktopNotifyEnabled
        });
    const langInfo = tickRes
      ? { lang: tickRes.uiLang || "en", source: tickRes.uiLangSource || "default" }
      : this._resolveUiLangInfo(store, cfg);
    const ttlNotifyLeadSec = Math.min(300, Math.max(15, Math.floor(Number(cfg.ttlNotifyLeadSec) || 60)));
    const ttlNotifyMinTokens = Math.min(500000, Math.max(4000, Math.floor(Number(cfg.ttlNotifyMinTokens) || 60000)));
    const ttlKeepaliveLeadSec = Math.min(180, Math.max(10, Math.floor(Number(cfg.ttlKeepaliveLeadSec) || 60)));

    const sessions = Array.from(this._lastEvaluated.values()).sort((a, b) => {
      const rankDiff = severityRank(b.severity) - severityRank(a.severity);
      if (rankDiff !== 0) return rankDiff;
      return (b.lastActivityTs || 0) - (a.lastActivityTs || 0);
    });

    const safeConvId = sanitizeConversationId(conversationId);
    let current = null;
    if (safeConvId && scope === "conversation") {
      current = this._lastEvaluated.get(safeConvId) || null;
    } else if (safeConvId) {
      current = this._lastEvaluated.get(safeConvId) || sessions[0] || null;
    } else {
      current = sessions.find((s) => s.phase !== WATCHDOG_PHASES.IDLE) || sessions[0] || null;
    }

    let kaTargetConvId = safeConvId;
    if (!kaTargetConvId) {
      const walkPrimaryAncestor = (seedObj) => {
        if (!seedObj) return null;
        const visited = new Set([seedObj.conversationId]);
        let cursor = seedObj;
        for (let hop = 0; hop < 6 && cursor; hop += 1) {
          const nextParent =
            cursor.parentConversationId ||
            (cursor.rootSessionId && cursor.rootSessionId !== cursor.conversationId ? cursor.rootSessionId : "");
          if (!nextParent || visited.has(nextParent)) break;
          visited.add(nextParent);
          const candEval = this._lastEvaluated.get(nextParent);
          const candObj = candEval || (store ? readWatchdogLease(store, nextParent) : null);
          if (!candObj) break;
          if (!candObj.isSubagent && !this._isConversationSubagent(store, nextParent, candEval ? null : candObj)) {
            return candObj;
          }
          cursor = candObj;
        }
        return null;
      };

      if (
        current &&
        !current.isSubagent &&
        !this._isConversationSubagent(store, current.conversationId)
      ) {
        kaTargetConvId = current.conversationId;
      } else {
        let primaryMatch =
          walkPrimaryAncestor(current) ||
          sessions.find((s) => !s.isSubagent && !this._isConversationSubagent(store, s.conversationId)) ||
          null;
        if (!primaryMatch && store) {
          const persistedLeases = listWatchdogLeases(store).sort(
            (a, b) => (b.updatedTs || 0) - (a.updatedTs || 0)
          );
          if (persistedLeases.length > 0) {
            primaryMatch =
              walkPrimaryAncestor(persistedLeases[0]) ||
              persistedLeases.find(
                (l) => !l.isSubagent && !this._isConversationSubagent(store, l.conversationId, l)
              ) ||
              null;
          }
        }
        kaTargetConvId = primaryMatch?.conversationId || "";
      }
    }

    const isKaTargetSubagent = Boolean(
      kaTargetConvId &&
        kaTargetConvId !== "__unbound__" &&
        this._isConversationSubagent(store, kaTargetConvId)
    );
    const kaState =
      !isKaTargetSubagent && kaTargetConvId && store && typeof store.getTtlKeepaliveState === "function"
        ? store.getTtlKeepaliveState(kaTargetConvId)
        : { usedCount: 0, coldMissTripped: false, lastSentTs: 0, lastError: "" };
    const convKeepaliveEnabled = isKaTargetSubagent
      ? false
      : kaTargetConvId
        ? this._resolveTtlKeepaliveEnabled(store, cfg, kaTargetConvId)
        : ttlKeepaliveEnabled;
    const convKeepaliveMaxCount = kaTargetConvId
      ? this._resolveTtlKeepaliveMaxCount(store, cfg, kaTargetConvId)
      : ttlKeepaliveMaxCount;
    const isCustomOverride = Boolean(
      !isKaTargetSubagent &&
        kaTargetConvId &&
        store &&
        typeof store.hasCustomTtlKeepaliveOverride === "function" &&
        store.hasCustomTtlKeepaliveOverride(kaTargetConvId)
    );
    const persistedTargetLease =
      kaTargetConvId && kaTargetConvId !== "__unbound__" && store
        ? readWatchdogLease(store, kaTargetConvId)
        : null;
    const targetLeaseForCtx =
      persistedTargetLease ||
      (kaTargetConvId && this._lastEvaluated.get(kaTargetConvId)) ||
      current ||
      null;
    const minCtxInfo = this._resolveLeaseKeepaliveMinContext(store, cfg, targetLeaseForCtx, {
      isCustomOverride
    });
    const deliveryLatencyMs =
      store && typeof store.getTtlKeepaliveDeliveryMs === "function"
        ? store.getTtlKeepaliveDeliveryMs()
        : 0;
    const deliveryCompSec = deliveryLatencyMs > 0 ? Math.min(20, Math.ceil(deliveryLatencyMs / 1000)) : 0;
    const minRemainSec = this._resolveTtlKeepaliveMinRemainSec(cfg);
    const effectiveTtlSec = persistedTargetLease
      ? this._resolveLeaseEffectiveTtlSec(store, persistedTargetLease, cfg, nowWallMs)
      : targetLeaseForCtx
        ? this._resolveLeaseEffectiveTtlSec(store, targetLeaseForCtx, cfg, nowWallMs)
        : Number.isFinite(cfg.cacheTtlSec) && cfg.cacheTtlSec > 0
          ? Math.floor(cfg.cacheTtlSec)
          : resolveModelProfile(null).ttlSec;
    const effectiveLeadSec = Math.min(ttlKeepaliveLeadSec, Math.max(5, Math.floor(effectiveTtlSec * 0.5)));
    const effectiveTriggerLeadSec = Math.min(
      Math.max(5, Math.floor(effectiveTtlSec * 0.75)),
      effectiveLeadSec + deliveryCompSec
    );
    const effectiveMinRemainSec = computeEffectiveKeepaliveMinRemainSec(
      minRemainSec,
      deliveryCompSec,
      effectiveTriggerLeadSec
    );

    const hasLease = Boolean(persistedTargetLease);
    const leasePhase = persistedTargetLease?.phase || "";
    const leaseSubphase = persistedTargetLease?.subphase || "";
    const leaseStopReason = persistedTargetLease?.stopReason || "";
    const inFlight = Boolean(
      !isKaTargetSubagent &&
        kaTargetConvId &&
        kaTargetConvId !== "__unbound__" &&
        this._keepaliveInFlight.has(kaTargetConvId)
    );
    const pendingAck = Boolean(!isKaTargetSubagent && isKeepalivePendingAckActive(kaState, nowWallMs));
    let cacheOriginTs = 0;
    let estimatedExpireTs = 0;
    let remainingSec = null;
    let narrowMarginSkipped = false;
    let narrowMarginRemSec = null;
    if (persistedTargetLease) {
      if (persistedTargetLease.phase === WATCHDOG_PHASES.IDLE && persistedTargetLease.subphase === "stopped") {
        const timing = computeLeaseTtlTiming(persistedTargetLease, { effectiveTtlSec, nowWallMs });
        if (timing.valid) {
          cacheOriginTs = timing.originTs;
          estimatedExpireTs = timing.estimatedExpireTs;
          remainingSec = Math.max(0, timing.remSec);
          const skipEntry =
            kaTargetConvId && kaTargetConvId !== "__unbound__"
              ? this._narrowMarginSkipped.get(kaTargetConvId)
              : null;
          if (
            skipEntry &&
            skipEntry.idleAnchorTs === timing.idleAnchorTs &&
            !inFlight &&
            !pendingAck &&
            kaState.lastIdleAnchorTs !== timing.idleAnchorTs
          ) {
            narrowMarginSkipped = true;
            narrowMarginRemSec = skipEntry.remSec;
          }
        } else if (persistedTargetLease.cacheOriginTs > 0) {
          cacheOriginTs = Math.floor(persistedTargetLease.cacheOriginTs);
          estimatedExpireTs = cacheOriginTs + effectiveTtlSec * 1000;
        }
      } else if (persistedTargetLease.phase === WATCHDOG_PHASES.IDLE) {
        if (persistedTargetLease.cacheOriginTs > 0) {
          cacheOriginTs = Math.floor(persistedTargetLease.cacheOriginTs);
          estimatedExpireTs = cacheOriginTs + effectiveTtlSec * 1000;
          if (nowWallMs >= cacheOriginTs) {
            remainingSec = Math.max(0, effectiveTtlSec - Math.floor((nowWallMs - cacheOriginTs) / 1000));
          }
        }
      } else {
        const activeOrigin =
          persistedTargetLease.cacheOriginTs > 0
            ? Math.floor(persistedTargetLease.cacheOriginTs)
            : persistedTargetLease.lastLlmStartTs > 0
              ? Math.floor(persistedTargetLease.lastLlmStartTs)
              : 0;
        if (activeOrigin > 0) {
          cacheOriginTs = activeOrigin;
          estimatedExpireTs = activeOrigin + effectiveTtlSec * 1000;
          if (nowWallMs >= activeOrigin) {
            remainingSec = Math.max(0, effectiveTtlSec - Math.floor((nowWallMs - activeOrigin) / 1000));
          }
        }
      }
    }

    const alertingSessions = sessions.filter((s) => s.severity === "stalled" || s.severity === "suspect");
    const activeCount = sessions.filter((s) => s.phase !== WATCHDOG_PHASES.IDLE).length;
    const suspectCount = sessions.filter((s) => s.severity === "suspect").length;
    const stalledCount = sessions.filter((s) => s.severity === "stalled").length;
    const pendingJump = this.getPendingConversationJump(nowWallMs);

    // Project external views without mutating internal per-conversation rescueBrief cache:
    // - `sessions` and `alertingSessions` expose overview metadata only (no per-window `lastUserInput` or `rescueBrief`).
    // - `current` only exposes `lastUserInput` and `rescueBrief` when scope is `conversation` AND target is a confirmed matching session.
    const projectOverviewEntry = (entry) => (entry ? { ...entry, lastUserInput: "", rescueBrief: null } : null);
    const isReservedRescueTarget =
      !safeConvId ||
      ["default", "all", "lifetime", "app", "__unbound__", "unknown", "none", "null", "undefined"].includes(
        safeConvId.toLowerCase()
      );
    const canIncludeRichRescue = Boolean(
      includeRichRescue !== false &&
        scope === "conversation" &&
        !isReservedRescueTarget &&
        current &&
        current.conversationId === safeConvId
    );
    const projectedCurrent = current
      ? canIncludeRichRescue
        ? { ...current }
        : projectOverviewEntry(current)
      : null;
    const projectedSessions = sessions.slice(0, 20).map(projectOverviewEntry);
    const projectedAlertingSessions = alertingSessions.slice(0, 10).map(projectOverviewEntry);

    const convKeepaliveIntervalSec = isKaTargetSubagent
      ? globalTtlKeepaliveIntervalSec
      : this._resolveTtlKeepaliveIntervalSec(store, cfg, kaTargetConvId);
    return {
      ok: true,
      enabled,
      desktopNotifyEnabled,
      ttlDesktopNotifyEnabled,
      globalTtlKeepaliveMaxCount,
      fallbackTtlKeepaliveMaxCount,
      globalTtlKeepaliveMinContextPct,
      globalTtlKeepaliveIntervalSec,
      ttlKeepalive: {
        conversationId: kaTargetConvId,
        enabled: convKeepaliveEnabled,
        supported: typeof this.keepaliveSendFn === "function" && !isKaTargetSubagent,
        isSubagent: isKaTargetSubagent,
        maxCount: convKeepaliveMaxCount,
        globalMaxCount: globalTtlKeepaliveMaxCount,
        fallbackMaxCount: fallbackTtlKeepaliveMaxCount,
        intervalSec: convKeepaliveIntervalSec,
        globalIntervalSec: globalTtlKeepaliveIntervalSec,
        intervalMode: convKeepaliveIntervalSec > 0 ? "fixed" : "auto",
        minContextPct: globalTtlKeepaliveMinContextPct,
        minContextTokens: Math.max(minCtxInfo.pctMinTokens, minCtxInfo.modelRoiMinTokens || 0),
        tailReprocessTokens: minCtxInfo.tailReprocessTokens || 0,
        windowTokens: minCtxInfo.windowTokens,
        isCustomOverride,
        usedCount: kaState.usedCount,
        coldMissTripped: Boolean(kaState.coldMissTripped),
        deliveryLatencyMs,
        leadSec: ttlKeepaliveLeadSec,
        minRemainSec,
        effectiveMinRemainSec,
        cacheOriginTs,
        effectiveTtlSec,
        estimatedExpireTs,
        remainingSec,
        narrowMarginSkipped,
        narrowMarginRemSec,
        inFlight,
        pendingAck,
        hasLease,
        leasePhase,
        leaseSubphase,
        leaseStopReason,
        narrowSkippedCount: this.ttlKeepaliveNarrowSkippedCount,
        manualKeepaliveCount: this.manualKeepaliveCount,
        lastSentTs: kaState.lastSentTs || 0,
        lastError: kaState.lastError || ""
      },
      watermarkDesktopNotifyEnabled,
      uiLang: langInfo.lang,
      uiLangSource: langInfo.source,
      ttlNotifyLeadSec,
      ttlNotifyMinTokens,
      serverNowMs: nowWallMs,
      pollMs: Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000)),
      thresholds: {
        suspectRatio: cfg.watchdogSuspectRatio ?? 0.6,
        llmLowSec: cfg.watchdogLlmLowSec ?? 120,
        llmHighSec: cfg.watchdogLlmHighSec ?? 240,
        llmMultimodalSec: cfg.watchdogLlmMultimodalSec ?? 360,
        llmReasoningSec: cfg.watchdogLlmReasoningSec ?? 600,
        llmCompoundSec: cfg.watchdogLlmCompoundSec ?? 900,
        toolFastSec: cfg.watchdogToolFastSec ?? 90,
        toolCmdSec: cfg.watchdogToolCmdSec ?? 300,
        subagentSec: cfg.watchdogSubagentSec ?? 1200
      },
      sleepGuard: {
        triggeredCount: this._sleepGuardCount,
        lastDriftAt: this._lastSleepDriftAt,
        lastJumpMs: this._lastSleepJumpMs
      },
      pendingJump,
      current: projectedCurrent,
      sessions: projectedSessions,
      alertingSessions: projectedAlertingSessions,
      stats: {
        totalTracked: sessions.length,
        activeCount,
        suspectCount,
        stalledCount,
        statSyncCount: this.statSyncCount,
        configStatCount: this.configStatCount,
        tailReadCount: this.tailReadCount,
        notificationCount: this.notificationCount,
        ttlNotificationCount: this.ttlNotificationCount,
        ttlKeepaliveCount: this.ttlKeepaliveCount,
        ttlKeepaliveNarrowSkippedCount: this.ttlKeepaliveNarrowSkippedCount,
        manualKeepaliveCount: this.manualKeepaliveCount,
        watermarkNotificationCount: this.watermarkNotificationCount
      }
    };
  }

  recordPendingConversationJump({
    conversationId = "",
    cwd = "",
    workspaceLabel = "",
    convTitle = "",
    source = "desktop_notify",
    ttlMs = this.pendingJumpTtlMs
  } = {}) {
    const safeId = sanitizeConversationId(conversationId);
    if (!safeId) {
      return { ok: false, error: "Valid conversationId is required" };
    }
    const now = this.nowFn();
    const effectiveTtlMs = Math.min(
      120_000,
      Math.max(1000, Math.floor(Number(ttlMs) || this.pendingJumpTtlMs || DEFAULT_PENDING_JUMP_TTL_MS))
    );
    const decodedCwd = decodeFileUriOrPath(cwd);
    const cleanCwd = decodedCwd ? sanitizeWatchdogText(decodedCwd, 260) : "";
    const rawWs =
      (typeof workspaceLabel === "string" && workspaceLabel.trim()) ||
      (decodedCwd ? formatWorkspaceWindowLabel(decodedCwd) : "");
    const cleanWs = rawWs ? sanitizeWatchdogText(rawWs, 48) : "";
    const cleanTitle =
      typeof convTitle === "string" && convTitle.trim() ? sanitizeWatchdogText(convTitle, 36) : "";
    const cleanSource = sanitizeWatchdogText(source, 32) || "desktop_notify";
    const jumpId = `jmp_${now.toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const ticket = {
      jumpId,
      conversationId: safeId,
      cwd: cleanCwd,
      workspaceLabel: cleanWs,
      convTitle: cleanTitle,
      source: cleanSource,
      createdTs: now,
      expiresTs: now + effectiveTtlMs
    };

    const store = this.getStore?.();
    let persisted = false;
    if (store && typeof store.setMeta === "function") {
      try {
        store.setMeta(PENDING_JUMP_META_KEY, JSON.stringify(ticket));
        persisted = true;
      } catch {}
    }
    this._fallbackPendingJump = persisted ? null : ticket;
    return { ok: true, pendingJump: ticket };
  }

  getPendingConversationJump(nowMs = this.nowFn()) {
    const store = this.getStore?.();
    let raw = null;
    const hasStoreMeta = Boolean(store && typeof store.getMeta === "function");
    if (hasStoreMeta) {
      try {
        raw = store.getMeta(PENDING_JUMP_META_KEY, null);
      } catch {}
    } else if (this._fallbackPendingJump) {
      raw = this._fallbackPendingJump;
    }
    if (!raw) return null;

    const clearStored = () => {
      this._fallbackPendingJump = null;
      if (store && typeof store.deleteMeta === "function") {
        try {
          store.deleteMeta(PENDING_JUMP_META_KEY);
        } catch {}
      }
    };

    const parsed = parseMaybeJsonObj(raw);
    const jumpId = typeof parsed.jumpId === "string" ? parsed.jumpId.trim() : "";
    const safeId = sanitizeConversationId(parsed.conversationId);
    const createdTs = Number(parsed.createdTs);
    const expiresTs = Number(parsed.expiresTs);
    if (
      !jumpId ||
      jumpId.length > 96 ||
      !/^[A-Za-z0-9._:-]+$/.test(jumpId) ||
      !safeId ||
      !Number.isFinite(expiresTs) ||
      nowMs >= expiresTs ||
      (Number.isFinite(createdTs) && createdTs > nowMs + 60_000)
    ) {
      clearStored();
      return null;
    }

    const decodedCwd = decodeFileUriOrPath(parsed.cwd || "");
    const cleanCwd = decodedCwd ? sanitizeWatchdogText(decodedCwd, 260) : "";
    const cleanWs =
      typeof parsed.workspaceLabel === "string" && parsed.workspaceLabel.trim()
        ? sanitizeWatchdogText(parsed.workspaceLabel, 48)
        : cleanCwd
          ? formatWorkspaceWindowLabel(cleanCwd)
          : "";
    const cleanTitle =
      typeof parsed.convTitle === "string" && parsed.convTitle.trim()
        ? sanitizeWatchdogText(parsed.convTitle, 36)
        : "";
    const cleanSource = sanitizeWatchdogText(parsed.source || "desktop_notify", 32) || "desktop_notify";

    return {
      jumpId,
      conversationId: safeId,
      cwd: cleanCwd,
      workspaceLabel: cleanWs,
      convTitle: cleanTitle,
      source: cleanSource,
      createdTs: Number.isFinite(createdTs) && createdTs > 0 ? Math.floor(createdTs) : nowMs,
      expiresTs: Math.floor(expiresTs)
    };
  }

  acknowledgePendingJump(jumpId = "") {
    const cleanJumpId = typeof jumpId === "string" ? jumpId.trim() : "";
    if (!cleanJumpId || cleanJumpId.length > 96 || !/^[A-Za-z0-9._:-]+$/.test(cleanJumpId)) {
      return { ok: false, error: "Valid jumpId is required" };
    }
    const cur = this.getPendingConversationJump(this.nowFn());
    if (!cur || cur.jumpId !== cleanJumpId) {
      return { ok: true, acknowledged: false, jumpId: cleanJumpId };
    }
    this._fallbackPendingJump = null;
    const store = this.getStore?.();
    if (store && typeof store.deleteMeta === "function") {
      try {
        store.deleteMeta(PENDING_JUMP_META_KEY);
      } catch {}
    }
    return {
      ok: true,
      acknowledged: true,
      jumpId: cleanJumpId,
      conversationId: cur.conversationId
    };
  }

  focusConversation(conversationId = "", { source = "sidecar_ui", skipOsFocus = false } = {}) {
    const safeId = sanitizeConversationId(conversationId);
    if (!safeId) {
      return { ok: false, error: "Valid conversationId is required" };
    }
    const store = this.getStore?.();
    const lease = store ? readWatchdogLease(store, safeId) : null;
    const evaluated = this._lastEvaluated.get(safeId) || null;
    let cwd = lease?.cwd || evaluated?.cwd || "";
    let workspaceLabel = lease?.workspaceLabel || evaluated?.workspaceLabel || "";
    let convTitle = lease?.convTitle || evaluated?.convTitle || "";
    const transcriptPath = lease?.transcriptPath || "";

    if (!cwd || !convTitle) {
      try {
        const summary = this.lookupSummaryFn?.(safeId, { transcriptPath }) || null;
        if (summary) {
          if (!convTitle && summary.title) convTitle = summary.title;
          if (!cwd && summary.cwd) cwd = summary.cwd;
        }
      } catch {}
    }
    if (!workspaceLabel && cwd) {
      workspaceLabel = formatWorkspaceWindowLabel(cwd);
    }

    const rec = this.recordPendingConversationJump({
      conversationId: safeId,
      cwd,
      workspaceLabel,
      convTitle,
      source
    });

    let focused = false;
    if (!skipOsFocus) {
      try {
        const focusRes = this.focusWindowFn?.({
          conversationId: safeId,
          cwd: rec.pendingJump?.cwd || cwd,
          workspaceLabel: rec.pendingJump?.workspaceLabel || workspaceLabel,
          convTitle: rec.pendingJump?.convTitle || convTitle,
          platform: this.platform
        });
        focused = Boolean(focusRes && focusRes.dispatched);
      } catch {}
    }

    return {
      ok: true,
      conversationId: safeId,
      pendingJump: rec.pendingJump || null,
      focused
    };
  }

  getStallContextForConversation(conversationId, { includeUserInput = true } = {}) {
    const safeId = sanitizeConversationId(conversationId);
    if (!safeId) return null;
    const item = this._lastEvaluated.get(safeId);
    if (!item || (item.rawSeverity !== "stalled" && item.rawSeverity !== "suspect")) {
      return null;
    }
    return {
      conversationId: item.conversationId,
      severity: item.rawSeverity,
      phase: item.phase,
      subphase: item.subphase,
      silentSec: item.silentSec,
      stalledThresholdSec: item.stalledSec,
      activeTool: item.activeTool,
      activeToolSummary: item.activeToolSummary,
      lastCompletedTool: item.lastCompletedTool,
      lastUserInput: includeUserInput ? item.lastUserInput : "",
      contextTokens: item.contextTokens || 0,
      model: item.model || "",
      causeId: item.diagnosis?.causeId || "",
      causeLabel: item.diagnosis?.label || "",
      tips: item.diagnosis?.tips || [],
      incidentKey: item.incidentKey || item.rescueBrief?.incidentKey || ""
    };
  }

  getTopAlertingStallContext() {
    const sessions = Array.from(this._lastEvaluated.values()).sort((a, b) => {
      const rankDiff = severityRank(b.severity) - severityRank(a.severity);
      if (rankDiff !== 0) return rankDiff;
      return (b.lastActivityTs || 0) - (a.lastActivityTs || 0);
    });
    const top = sessions.find((s) => s.rawSeverity === "stalled" || s.rawSeverity === "suspect");
    return top ? this.getStallContextForConversation(top.conversationId, { includeUserInput: false }) : null;
  }

  acknowledge(conversationId, snoozeSec = 300) {
    const store = this.getStore?.();
    const safeId = sanitizeConversationId(conversationId);
    if (!store || !safeId) return { ok: false, error: "Valid conversationId is required" };
    const lease = readWatchdogLease(store, safeId);
    if (!lease) return { ok: false, error: "No watchdog lease found for conversation" };
    const now = this.nowFn();
    const sec = Math.min(3600, Math.max(30, Number(snoozeSec) || 300));
    const updated = writeWatchdogLease(store, {
      ...lease,
      ackedUntilTs: now + sec * 1000
    });
    this.tick();
    return { ok: true, conversationId: safeId, snoozedUntilTs: updated?.ackedUntilTs || 0 };
  }

  markIdle(conversationId, reason = "user_marked_idle") {
    const store = this.getStore?.();
    const safeId = sanitizeConversationId(conversationId);
    if (!store || !safeId) return { ok: false, error: "Valid conversationId is required" };
    const lease = readWatchdogLease(store, safeId);
    if (!lease) return { ok: true, conversationId: safeId, phase: WATCHDOG_PHASES.IDLE };
    const now = this.nowFn();
    writeWatchdogLease(store, {
      ...lease,
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "user_cleared",
      activeTool: "",
      activeToolKind: "",
      activeToolSummary: "",
      activeToolCallId: "",
      pendingSlowCalls: [],
      transcriptSize: 0,
      transcriptMtimeMs: 0,
      stopReason: sanitizeWatchdogText(reason, 64),
      phaseChangedTs: now,
      updatedTs: now,
      lastHeartbeatTs: now,
      hookEvent: "UserAck",
      ackedUntilTs: 0
    });
    const st = this._convState.get(safeId);
    if (st) {
      st.rescueBriefKey = "";
      st.rescueBrief = null;
      st.sleepGraceMs = 0;
      st.lastTranscriptGrowthTs = 0;
    }
    this.tick();
    return { ok: true, conversationId: safeId, phase: WATCHDOG_PHASES.IDLE };
  }
}
