import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex, stableStringify } from "./stable-json.js";
import { redactSecrets } from "./security.js";
import { queryRecentConversationIdsFromSummaryDb } from "./watchdog-lease.js";

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
  computeKeepalivePingTokenSplit,
  scheduleKeepAlivePings,
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
  computeKeepalivePingTokenSplit,
  scheduleKeepAlivePings,
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
export const TTL_CALIBRATION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const TTL_CALIBRATION_RECENT_MS = 7 * 24 * 3600 * 1000;
const TTL_WARM_SAMPLE_MIN_SEC = 180;
const TTL_COLD_SAMPLE_MIN_SEC = 120;
const TTL_SAMPLE_MAX_SEC = 14400;
const TTL_PURE_COLD_MAX_CACHE_RATIO = 0.25;
const TTL_IMPLICIT_MAX_CAP_SEC = 3600;
const TTL_KEEPALIVE_STEP_RE = /\[agy-dart TTL(?:保活| Keepalive)(?:\s|\])/i;
const PRIOR_CONTEXT_MATCH_ENABLED_PROFILES = new Set(["gemini-4-512k"]);
const PRIOR_CONTEXT_MATCH_TAIL_SLACK = 2049;
const TAIL_TRUNCATED_STEP_ARRAYS = new WeakSet();
const SUBAGENT_STEP_TYPE_RE = /^SUBAGENT(?:_|$)/i;


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
      cacheReadReported: false,
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

  const hasAnthropicCacheFields =
    toNonNegNum(step.cache_read_input_tokens) !== null ||
    toNonNegNum(usage.cache_read_input_tokens) !== null ||
    toNonNegNum(step.cache_creation_input_tokens) !== null ||
    toNonNegNum(usage.cache_creation_input_tokens) !== null ||
    (usage.cache_creation !== null && typeof usage.cache_creation === "object");

  const hasInclusiveGatewayCacheDetails =
    !hasAnthropicCacheFields &&
    (
      (usage.input_tokens_details !== null &&
        typeof usage.input_tokens_details === "object" &&
        toNonNegNum(usage.input_tokens_details.cached_tokens) !== null) ||
      (usage.prompt_tokens_details !== null &&
        typeof usage.prompt_tokens_details === "object" &&
        toNonNegNum(usage.prompt_tokens_details.cached_tokens) !== null) ||
      toNonNegNum(usage.cachedContentTokenCount) !== null ||
      toNonNegNum(usage.cached_content_token_count) !== null ||
      toNonNegNum(usage.prompt_cache_hit_tokens) !== null
    );

  const rawCacheRead = firstPosOrNonNeg(
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
  const cacheReadTokens = rawCacheRead === null || rawCacheRead === 0 ? 0 : rawCacheRead;

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
  // Note: OpenAI Responses / OpenAI-compatible gateways / Gemini / DeepSeek report usage.input_tokens INCLUSIVE of cached tokens
  const disjointIn = hasInclusiveGatewayCacheDetails
    ? firstPosOrNonNeg(step.input_tokens)
    : firstPosOrNonNeg(step.input_tokens, usage.input_tokens);
  // Inclusive total prompt tokens (OpenAI prompt_tokens / gateway usage.input_tokens / Gemini promptTokenCount)
  const inclusivePrompt = firstPosOrNonNeg(
    step.prompt_tokens,
    step.promptTokenCount,
    usage.prompt_tokens,
    hasInclusiveGatewayCacheDetails ? usage.input_tokens : null,
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
    cacheReadReported,
    cacheCreationTokens,
    cacheCreation1hTokens,
    outputTokens,
    thinkingTokens,
    contextTokens
  };
}

function roundTo60(sec) {
  return Math.max(60, Math.round(sec / 60) * 60);
}

function ceilTo60(sec) {
  return Math.max(60, Math.ceil(sec / 60) * 60);
}

function clampNum(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function isExtended1hTierProfile(profile) {
  return (
    Boolean(profile?.id && /^claude/i.test(profile.id)) ||
    (profile?.cacheWrite1hMultiplier || 1) > (profile?.cacheWriteMultiplier || 1)
  );
}

function normalizeTtlSamples(rawList, minSec, maxSec, { nowMs = null, maxAgeMs = null, defaultConv = "" } = {}) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const gapSec = Number(item.gapSec);
    if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > maxSec) continue;
    const rawAt = item.atMs;
    const atMs = Number.isFinite(rawAt) && rawAt > 0 ? Math.floor(rawAt) : 0;
    if (nowMs !== null && maxAgeMs !== null && atMs > 0 && nowMs - atMs > maxAgeMs) {
      continue;
    }
    const conv = typeof item.conv === "string" && item.conv.trim() ? item.conv.trim() : defaultConv;
    out.push({ gapSec: Math.round(gapSec), atMs, conv });
  }
  return out;
}

function mergeUniqueTtlSamples(sessionSamples, historySamples) {
  const merged = [];
  const seenExact = new Set();
  const seenSessionStamp = new Set();
  for (const s of sessionSamples) {
    const exactKey = `${s.conv || "__session__"}:${s.atMs}:${s.gapSec}`;
    if (seenExact.has(exactKey)) continue;
    seenExact.add(exactKey);
    if (s.atMs > 0) seenSessionStamp.add(`${s.atMs}:${s.gapSec}`);
    merged.push(s);
  }
  for (const h of historySamples) {
    const exactKey = `${h.conv || ""}:${h.atMs}:${h.gapSec}`;
    if (seenExact.has(exactKey)) continue;
    if (h.atMs > 0 && seenSessionStamp.has(`${h.atMs}:${h.gapSec}`)) continue;
    seenExact.add(exactKey);
    merged.push(h);
  }
  return merged;
}

function computeWarmLowerBound(warmList) {
  if (!Array.isArray(warmList) || warmList.length === 0) return null;
  const gaps = warmList.map((s) => s.gapSec).sort((a, b) => a - b);
  const n = gaps.length;
  if (n === 1) return gaps[0];
  if (gaps[n - 2] >= gaps[n - 1] * 0.9) return gaps[n - 1];
  if (n <= 4) return gaps[n - 1];
  const p90Idx = Math.min(n - 1, Math.floor(0.9 * (n - 1)));
  return gaps[p90Idx];
}

function computeColdUpperBound(coldList) {
  if (!Array.isArray(coldList) || coldList.length === 0) return null;
  const gaps = coldList.map((s) => s.gapSec).sort((a, b) => a - b);
  const idx = gaps.length >= 5 ? Math.floor(0.2 * (gaps.length - 1)) : 0;
  return gaps[idx];
}

/**
 * Cross-session & in-session interval-bounded empirical TTL estimator (pure function, zero DB I/O).
 * Preserves backward-compatible `ttlSource` ("explicit" | "empirical" | "profile") while exposing
 * rich provenance and sample bounds via `ttlCalibration`.
 */
export function estimateCalibratedTtl(
  profile,
  {
    explicitTtlSec = null,
    sessionMaxWarmGapSec = null,
    sessionHas1hWrite = false,
    sessionWarmSamples = [],
    sessionColdSamples = [],
    historyRecord = null,
    nowMs = Date.now(),
    convId = ""
  } = {}
) {
  const profileId = profile?.id || "default";
  const profileTtl = profile?.ttlSec || DEFAULT_CACHE_TTL_SEC;
  const isExtended1h = isExtended1hTierProfile(profile);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();

  const sessWarm = normalizeTtlSamples(sessionWarmSamples, TTL_WARM_SAMPLE_MIN_SEC, TTL_SAMPLE_MAX_SEC, {
    defaultConv: convId || "__session__"
  });
  if (
    Number.isFinite(sessionMaxWarmGapSec) &&
    sessionMaxWarmGapSec >= TTL_WARM_SAMPLE_MIN_SEC &&
    sessionMaxWarmGapSec <= TTL_SAMPLE_MAX_SEC &&
    !sessWarm.some((s) => s.gapSec === Math.round(sessionMaxWarmGapSec))
  ) {
    sessWarm.push({ gapSec: Math.round(sessionMaxWarmGapSec), atMs: safeNowMs, conv: convId || "__session__" });
  }
  const sessCold = normalizeTtlSamples(sessionColdSamples, TTL_COLD_SAMPLE_MIN_SEC, TTL_SAMPLE_MAX_SEC, {
    defaultConv: convId || "__session__"
  });

  const histFresh =
    historyRecord &&
    typeof historyRecord === "object" &&
    (!Number.isFinite(historyRecord.updatedTs) ||
      historyRecord.updatedTs <= 0 ||
      safeNowMs - historyRecord.updatedTs <= TTL_CALIBRATION_MAX_AGE_MS)
      ? historyRecord
      : null;

  const histWarm = histFresh
    ? normalizeTtlSamples(histFresh.warm, TTL_WARM_SAMPLE_MIN_SEC, TTL_SAMPLE_MAX_SEC, {
        nowMs: safeNowMs,
        maxAgeMs: TTL_CALIBRATION_MAX_AGE_MS
      })
    : [];
  const histCold = histFresh
    ? normalizeTtlSamples(histFresh.cold, TTL_COLD_SAMPLE_MIN_SEC, TTL_SAMPLE_MAX_SEC, {
        nowMs: safeNowMs,
        maxAgeMs: TTL_CALIBRATION_MAX_AGE_MS
      })
    : [];
  const histHas1hWrite = Boolean(histFresh && histFresh.seen1hWrite);

  const allWarm = mergeUniqueTtlSamples(sessWarm, histWarm);
  const allCold = mergeUniqueTtlSamples(sessCold, histCold);
  const sessColdAboveFloor = sessCold.filter((c) => c.gapSec >= profileTtl);
  const histColdAboveFloor = histCold.filter((c) => c.gapSec >= profileTtl);
  const coldAboveFloor = mergeUniqueTtlSamples(sessColdAboveFloor, histColdAboveFloor);

  const maxWarmGapSec =
    allWarm.length > 0
      ? Math.max(...allWarm.map((s) => s.gapSec))
      : Number.isFinite(sessionMaxWarmGapSec) && sessionMaxWarmGapSec > 0
        ? Math.round(sessionMaxWarmGapSec)
        : null;
  const minColdMissGapSec = allCold.length > 0 ? Math.min(...allCold.map((s) => s.gapSec)) : null;
  const effectiveMinColdGapSec =
    coldAboveFloor.length > 0 ? Math.min(...coldAboveFloor.map((s) => s.gapSec)) : null;

  if (Number.isFinite(explicitTtlSec) && explicitTtlSec > 0) {
    return {
      ttlSec: explicitTtlSec,
      ttlSource: "explicit",
      ttlCalibration: {
        origin: "explicit",
        profileId,
        warmSamples: allWarm.length,
        coldSamples: allCold.length,
        maxWarmGapSec,
        minColdMissGapSec,
        estimatedTtlSec: explicitTtlSec,
        confidence: "high"
      }
    };
  }

  const has1hWrite = Boolean(sessionHas1hWrite || histHas1hWrite);
  if (has1hWrite && isExtended1h) {
    const floor = maxWarmGapSec !== null && maxWarmGapSec > 3600 ? ceilTo60(maxWarmGapSec) : 3600;
    const est = Math.max(profileTtl, floor);
    const origin = sessionHas1hWrite && histWarm.length === 0 && !histHas1hWrite ? "session" : histHas1hWrite ? "history" : "session";
    return {
      ttlSec: est,
      ttlSource: "empirical",
      ttlCalibration: {
        origin,
        profileId,
        warmSamples: allWarm.length,
        coldSamples: coldAboveFloor.length,
        maxWarmGapSec,
        minColdMissGapSec: effectiveMinColdGapSec,
        estimatedTtlSec: est,
        confidence: "high"
      }
    };
  }

  const hasHistoryData = histWarm.length > 0 || histColdAboveFloor.length > 0 || histHas1hWrite;
  const resolveOrigin = (sessionTriggered) => {
    if (hasHistoryData && !sessionTriggered) return "history";
    if (hasHistoryData) return "history";
    return "session";
  };

  const L = computeWarmLowerBound(allWarm);
  const U = computeColdUpperBound(coldAboveFloor);

  // Extended 1h discrete-tier models (e.g. Claude 5m vs 1h) with observed >5.5m warm hit
  // and no explicit history downward shift use the 1h tier floor unless multi-session cold hits prove otherwise.
  if (isExtended1h && L !== null && L > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO) {
    const distinctColdShort = new Set(
      coldAboveFloor.filter((c) => c.gapSec < 3600 && c.conv).map((c) => c.conv)
    );
    if (U === null || distinctColdShort.size < 2) {
      const est = L <= 3600 ? 3600 : ceilTo60(L);
      const sessL = computeWarmLowerBound(sessWarm);
      const origin = hasHistoryData && !(sessL !== null && sessL > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO && histWarm.length === 0)
        ? (histWarm.length > 0 ? "history" : "session")
        : "session";
      return {
        ttlSec: est,
        ttlSource: "empirical",
        ttlCalibration: {
          origin,
          profileId,
          warmSamples: allWarm.length,
          coldSamples: coldAboveFloor.length,
          maxWarmGapSec,
          minColdMissGapSec: effectiveMinColdGapSec,
          estimatedTtlSec: est,
          confidence: allWarm.length >= 2 ? "high" : "medium"
        }
      };
    }
  }

  let estimated = null;
  let confidence = "low";

  if (L !== null && U !== null) {
    if (L < U) {
      if (L > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO) {
        const floorL = Math.max(profileTtl, roundTo60(L));
        const rawTarget = roundTo60(L + 0.35 * (U - L));
        estimated = clampNum(rawTarget, L, Math.max(L, U - 60));
        // Snap clean minute if L itself is a multiple of 60 or ceil slightly, never below profileTtl
        estimated = roundTo60(estimated);
        estimated = clampNum(estimated, floorL, Math.max(floorL, U - 60));
        confidence = allWarm.length >= 2 && coldAboveFloor.length >= 1 ? "high" : "medium";
      }
    } else {
      // U <= L: Backend TTL likely shrank compared to older warm hits (or implicit cache has interleaved misses >= profileTtl)
      const recentCutoff = safeNowMs - TTL_CALIBRATION_RECENT_MS;
      let recentWarm = allWarm.filter((s) => s.atMs <= 0 || s.atMs >= recentCutoff);
      let recentCold = coldAboveFloor.filter((s) => s.atMs <= 0 || s.atMs >= recentCutoff);
      let lRec = computeWarmLowerBound(recentWarm);
      let uRec = computeColdUpperBound(recentCold);

      if (lRec !== null && uRec !== null && uRec <= lRec) {
        // Still inverted inside 7d -> slice latest chronological half of combined observations
        const tagged = [
          ...allWarm.map((s, idx) => ({ ...s, kind: "warm", ord: idx })),
          ...coldAboveFloor.map((s, idx) => ({ ...s, kind: "cold", ord: allWarm.length + idx }))
        ].sort((a, b) => (a.atMs !== b.atMs ? a.atMs - b.atMs : a.ord - b.ord));
        const half = tagged.slice(Math.floor(tagged.length / 2));
        const halfWarm = half.filter((x) => x.kind === "warm");
        const halfCold = half.filter((x) => x.kind === "cold");
        if (halfWarm.length > 0 || halfCold.length > 0) {
          recentWarm = halfWarm;
          recentCold = halfCold;
          lRec = computeWarmLowerBound(recentWarm);
          uRec = computeColdUpperBound(recentCold);
        }
      }

      if (lRec !== null && uRec !== null && lRec < uRec) {
        if (lRec > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO) {
          const floorRec = Math.max(profileTtl, roundTo60(lRec));
          const rawTarget = roundTo60(lRec + 0.35 * (uRec - lRec));
          estimated = clampNum(rawTarget, floorRec, Math.max(floorRec, uRec - 60));
          confidence = "medium";
        }
      } else {
        const capU = uRec ?? U;
        if (capU > profileTtl) {
          estimated = clampNum(roundTo60(capU - 60), profileTtl, capU);
          confidence = estimated > profileTtl ? "medium" : "low";
          if (estimated === profileTtl) {
            // Converged all the way back down to default profile TTL (never shrink below profileTtl)
            return {
              ttlSec: profileTtl,
              ttlSource: "profile",
              ttlCalibration: {
                origin: hasHistoryData ? "history" : "profile",
                profileId,
                warmSamples: allWarm.length,
                coldSamples: coldAboveFloor.length,
                maxWarmGapSec,
                minColdMissGapSec: effectiveMinColdGapSec,
                estimatedTtlSec: profileTtl,
                confidence: "medium"
              }
            };
          }
        }
      }
    }
  } else if (L !== null) {
    if (L > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO) {
      const roundedFloor = ceilTo60(L);
      estimated = isExtended1h ? (L <= 3600 ? 3600 : roundedFloor) : Math.min(TTL_IMPLICIT_MAX_CAP_SEC, roundedFloor);
      confidence = allWarm.length >= 3 ? "high" : "medium";
    }
  }

  if (estimated !== null && estimated !== profileTtl) {
    const sessOnly = !hasHistoryData;
    return {
      ttlSec: estimated,
      ttlSource: "empirical",
      ttlCalibration: {
        origin: sessOnly ? "session" : resolveOrigin(sessWarm.length > 0 || sessColdAboveFloor.length > 0),
        profileId,
        warmSamples: allWarm.length,
        coldSamples: coldAboveFloor.length,
        maxWarmGapSec,
        minColdMissGapSec: effectiveMinColdGapSec,
        estimatedTtlSec: estimated,
        confidence
      }
    };
  }

  return {
    ttlSec: profileTtl,
    ttlSource: "profile",
    ttlCalibration: {
      origin: "profile",
      profileId,
      warmSamples: allWarm.length,
      coldSamples: coldAboveFloor.length,
      maxWarmGapSec,
      minColdMissGapSec: effectiveMinColdGapSec,
      estimatedTtlSec: profileTtl,
      confidence: "low"
    }
  };
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
export function readTranscriptTail(filePath, maxBytes = 131072, options = {}) {
  if (!filePath) return [];
  const HARD_CAP_BYTES = 2 * 1024 * 1024;
  const minUsageSteps =
    Number.isFinite(Number(options?.minUsageSteps)) && Number(options.minUsageSteps) >= 1
      ? Math.floor(Number(options.minUsageSteps))
      : 1;
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
      let primaryCtxSteps = 0;
      let totalUsageSteps = 0;
      for (const s of steps) {
        const u = extractStepTokenUsage(s);
        if (u.contextTokens > 0 || u.outputTokens > 0) {
          totalUsageSteps += 1;
          if (u.contextTokens > 0 && !isSubagentStep(s)) {
            primaryCtxSteps += 1;
          }
        }
      }
      const hasEnoughUsage =
        minUsageSteps <= 1
          ? totalUsageSteps >= 1
          : primaryCtxSteps >= minUsageSteps || (primaryCtxSteps === 0 && totalUsageSteps >= minUsageSteps);
      if (hasEnoughUsage || offset === 0 || windowBytes >= HARD_CAP_BYTES) {
        if (offset > 0) {
          TAIL_TRUNCATED_STEP_ARRAYS.add(steps);
        }
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

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Fixed-window head + tail reader for handoff brief intent extraction.
 * Strictly reads at most `headBytes` (default 64 KiB) from the start and `tailBytes`
 * (default 128 KiB) from the end without ever widening up to 2 MiB.
 * Drops partial boundary lines on raw Buffers before UTF-8 decoding so only complete
 * JSONL records are parsed and split multi-byte characters never corrupt output.
 */
export function readTranscriptHeadTailFixed(filePath, { headBytes = 65536, tailBytes = 131072 } = {}) {
  const empty = {
    headSteps: [],
    tailSteps: [],
    headBytesRead: 0,
    tailBytesRead: 0,
    totalBytesRead: 0,
    fileSize: 0,
    overlapped: true
  };
  if (!filePath || typeof filePath !== "string") return empty;
  const headCap = Number.isFinite(Number(headBytes)) && Number(headBytes) >= 0 ? Math.floor(Number(headBytes)) : 65536;
  const tailCap = Number.isFinite(Number(tailBytes)) && Number(tailBytes) >= 0 ? Math.floor(Number(tailBytes)) : 131072;
  if (headCap === 0 && tailCap === 0) return empty;

  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return empty;

    const readChunkExact = (length, position) => {
      if (length <= 0) return Buffer.alloc(0);
      const buf = Buffer.allocUnsafe(length);
      let total = 0;
      while (total < length) {
        const n = fs.readSync(fd, buf, total, length - total, position + total);
        if (n <= 0) break;
        total += n;
      }
      return total === length ? buf : buf.subarray(0, total);
    };

    const parseStrictUtf8JsonlLine = (lineBuf, { requireBraces = false } = {}) => {
      if (!lineBuf || lineBuf.length === 0) return null;
      let end = lineBuf.length;
      if (end > 0 && lineBuf[end - 1] === 0x0d) {
        end -= 1;
      }
      if (end === 0) return null;
      const slice = end === lineBuf.length ? lineBuf : lineBuf.subarray(0, end);
      if ((slice[0] & 0xc0) === 0x80) return null;
      try {
        const decoded = UTF8_FATAL_DECODER.decode(slice);
        const trimmed = decoded.trim();
        if (!trimmed) return null;
        if (requireBraces && !(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
          return null;
        }
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Invalid UTF-8 bytes or malformed JSON -> drop ONLY this line
      }
      return null;
    };

    const parseStrictUtf8JsonlBuffer = (buf) => {
      if (!buf || buf.length === 0) return [];
      const steps = [];
      let lineStart = 0;
      while (lineStart < buf.length) {
        const nlIdx = buf.indexOf(0x0a, lineStart);
        const lineEnd = nlIdx >= 0 ? nlIdx : buf.length;
        if (lineEnd > lineStart) {
          const parsed = parseStrictUtf8JsonlLine(buf.subarray(lineStart, lineEnd));
          if (parsed) steps.push(parsed);
        }
        if (nlIdx < 0) break;
        lineStart = nlIdx + 1;
      }
      return steps;
    };

    const parseHeadSlice = (buf, reachedEof) => {
      if (!buf || buf.length === 0) return [];
      if (reachedEof) {
        return parseStrictUtf8JsonlBuffer(buf);
      }
      // Drop trailing incomplete line at raw byte boundary before strict per-line UTF-8 decode
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) return [];
      return parseStrictUtf8JsonlBuffer(buf.subarray(0, lastNl + 1));
    };

    const parseTailSliceExact = (buf, offset, prevByte) => {
      if (!buf || buf.length === 0) return [];
      if (offset === 0 || prevByte === 0x0a) {
        return parseStrictUtf8JsonlBuffer(buf);
      }
      // Drop leading incomplete line at raw byte boundary before strict per-line UTF-8 decode
      const firstNl = buf.indexOf(0x0a);
      if (firstNl < 0 || firstNl + 1 >= buf.length) return [];
      return parseStrictUtf8JsonlBuffer(buf.subarray(firstNl + 1));
    };

    const parseTailSliceLarge = (buf, offset) => {
      if (!buf || buf.length === 0) return [];
      if (offset === 0) {
        return parseStrictUtf8JsonlBuffer(buf);
      }
      const firstNl = buf.indexOf(0x0a);
      const firstLineBuf = firstNl >= 0 ? buf.subarray(0, firstNl) : buf;
      const restBuf = firstNl >= 0 && firstNl + 1 < buf.length ? buf.subarray(firstNl + 1) : null;
      const steps = [];
      // Verify whether the tail window begins cleanly on a complete JSONL object line without
      // performing any extra probe read before `tailOffset`. Any strict proper suffix of a valid
      // JSON object carries unmatched outer closing braces and fails `JSON.parse`.
      const parsedFirst = parseStrictUtf8JsonlLine(firstLineBuf, { requireBraces: true });
      if (parsedFirst) {
        steps.push(parsedFirst);
      }
      if (restBuf && restBuf.length > 0) {
        steps.push(...parseStrictUtf8JsonlBuffer(restBuf));
      }
      return steps;
    };

    const fileSize = stat.size;
    // Overlapping fast path: read once without duplicate I/O, but still parse head <= headCap
    // and tail <= tailCap strictly along their raw byte boundaries.
    if (fileSize <= headCap + tailCap) {
      const fullBuf = readChunkExact(fileSize, 0);
      const bytesRead = fullBuf.length;
      const headLen = Math.min(headCap, bytesRead);
      const headSteps = headLen > 0 ? parseHeadSlice(fullBuf.subarray(0, headLen), headLen === bytesRead) : [];

      let tailSteps = [];
      let tailLen = 0;
      if (tailCap > 0) {
        tailLen = Math.min(tailCap, bytesRead);
        const tailOffset = Math.max(0, bytesRead - tailLen);
        const prevByte = tailOffset > 0 ? fullBuf[tailOffset - 1] : 0x0a;
        tailSteps = parseTailSliceExact(fullBuf.subarray(tailOffset, bytesRead), tailOffset, prevByte);
      }

      return {
        headSteps,
        tailSteps,
        headBytesRead: headLen,
        tailBytesRead: tailLen,
        totalBytesRead: bytesRead,
        fileSize,
        overlapped: true
      };
    }

    // Large file path: strictly <= headCap head read + strictly <= tailCap tail read (no extra probe byte)
    let headSteps = [];
    let headBytesRead = 0;
    if (headCap > 0) {
      const headBuf = readChunkExact(Math.min(headCap, fileSize), 0);
      headBytesRead = headBuf.length;
      headSteps = parseHeadSlice(headBuf, headBytesRead === fileSize);
    }

    let tailSteps = [];
    let tailBytesRead = 0;
    if (tailCap > 0) {
      const tailLen = Math.min(tailCap, fileSize);
      const tailOffset = Math.max(0, fileSize - tailLen);
      const tailBuf = readChunkExact(tailLen, tailOffset);
      tailBytesRead = tailBuf.length;
      tailSteps = parseTailSliceLarge(tailBuf, tailOffset);
    }

    return {
      headSteps,
      tailSteps,
      headBytesRead,
      tailBytesRead,
      totalBytesRead: headBytesRead + tailBytesRead,
      fileSize,
      overlapped: false
    };
  } catch {
    return empty;
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

export function shortTargetLabel(rawPath, maxLen = 42) {
  if (!rawPath) return "";
  const cleaned = String(rawPath).trim().replace(/\\/g, "/");
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  const parts = cleaned.split("/").filter(Boolean);
  const looksLikePath =
    parts.length >= 2 &&
    (!/\s/.test(cleaned) || /^(?:[a-zA-Z]:\/|\/|\.\.?\/)/.test(cleaned));
  if (looksLikePath) {
    const tail = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (tail.length <= maxLen) return tail;
    const base = parts[parts.length - 1];
    if (base.length <= maxLen) return base;
    return maxLen > 3 ? `...${base.slice(-(maxLen - 3))}` : base.slice(-Math.max(1, maxLen));
  }
  return maxLen > 3 ? cleaned.slice(0, maxLen - 3) + "..." : cleaned.slice(0, Math.max(1, maxLen));
}

function unwrapQuotedWrapperArg(val) {
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

function unwrapEffectiveTool(call) {
  const rawName = unwrapQuotedWrapperArg(String(call?.name || ""));
  const args = getCallArgs(call) || {};
  if (rawName === "call_mcp_tool") {
    const mcpTool = unwrapQuotedWrapperArg(String(args.ToolName ?? args.toolName ?? ""));
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
  } else if (bareTool === "ctx_execute" || /(?:^|_)ctx_execute$/.test(bareTool)) {
    const intentLabel = [args.intent, args.summary, args.description].find(
      (v) => typeof v === "string" && v.trim()
    );
    target = shortTargetLabel(intentLabel || args.file || args.language || "shell", 36);
  } else if (bareTool === "ctx_index" || /(?:^|_)ctx_index$/.test(bareTool)) {
    target = shortTargetLabel(args.url || args.path || args.label || "text", 36);
  } else if (bareTool === "ctx_search" || /(?:^|_)ctx_search$/.test(bareTool)) {
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

const STEP_CANCELED_TEXT_RE =
  /(?:tool execution was cancel(?:ed|led)|user cancel(?:ed|led)|operation (?:was )?cancel(?:ed|led)|command (?:was )?cancel(?:ed|led)|request (?:was )?(?:cancel(?:ed|led)|aborted)|execution (?:was )?(?:cancel(?:ed|led)|aborted))/i;

const STEP_PURE_TIMEOUT_TEXT_RE =
  /(?:^|\n)\s*(?:(?:error:\s*)?(?:(?:command|execution|operation|process|request|task)\s+)?timed\s*out\b|(?:error:\s*)?(?:context\s+)?deadline\s+exceeded\b|TIMED\s*OUT\b|Status:\s*(?:TIMED_OUT|TIMEOUT)\b|(?:(?:命令|执行|操作|进程|任务|检查)(?:已|在\s*\d+\s*[秒sS]后)?超时|(?:\d+\s*(?:秒|s|ms)\s*)?超时(?:\s*[（(][^)\n]*[）)])?)\s*[.。!！]?\s*(?:\n|$))/i;

const HARNESS_TIMEOUT_LINE_RE =
  /^\s*(?:(?:error:\s*)?(?:(?:command|execution|operation|process|request|task)\s+timed\s*out\b|timed\s*out\s+after\b)|(?:error:\s*)?(?:context\s+)?deadline\s+exceeded\b|TIMED\s*OUT\b|Status:\s*(?:TIMED_OUT|TIMEOUT)\b|(?:命令|执行|操作|进程|任务|检查)(?:已|在\s*\d+\s*[秒sS]后)?超时|\d+\s*(?:秒|s|ms)\s*超时|Verify\s*\[TIMEOUT\b|##\s*\[TIMEOUT\b)/i;

const BG_TASK_ID_FROM_LAUNCH_RE = /\btask\s+id\s*[:=]\s*["']?([^\s"'<>]+)["']?/i;
const BG_TASK_SYSTEM_FINISH_RE = /Task\s+id\s+"([^"]+)"\s+(finished with result|failed with error|was cancel(?:ed|led) with result)\s*:/i;
const BG_TASK_SENDER_RE = /\bsender=([^\s\]]+\/task-[^\s\]]+)/i;

const REAL_CODE_ERROR_TEXT_RE =
  /(?:Encountered error in step execution|Atomic edit aborted|Partial edit applied|Tool error \(|Verify \[FAIL|## \[FAIL|## \[ERROR|(?:^|\n)\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|ImportError|ModuleNotFoundError|ValueError|NameError|AttributeError|KeyError|IndexError|FileNotFoundError|RuntimeError|IndentationError|ZeroDivisionError|ZodError|ValidationError|CompileError|ParseError|✖\s+(?!0\s+problems?\b)|✘\s*\[ERROR\]|not ok\s+\d+|FAIL(?:ED)?\s+\S|E\s+assert\b|Assertion\s+failed\b|Traceback \(most recent call last\):|FATAL ERROR:|Compilation failed\b|Build failed\b|Transform failed\b|error(?:\[E\d{4}\]|\s+(?:TS|CS)\d{4})\s*:|Syntax error\b|ℹ\s+fail\s+[1-9]\d*\b)|(?:^|\n)\s*[^\n]+?(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*[-:]\s*error(?:\s+[A-Z]+\d+)?\s*:|(?:^|\n)\s*Error:\s+(?!.*(?:timed?\s*out\b|deadline\s+exceeded\b|超时)))/m;

const SPECIFIC_ERROR_KIND_RE =
  /\b(ModuleNotFoundError|ImportError|SyntaxError|IndentationError|NameError|AttributeError|TypeError|ValueError|KeyError|IndexError|ReferenceError|RangeError|AssertionError|FileNotFoundError|PermissionError|ZeroDivisionError|RuntimeError|ZodError|ValidationError|TS\d{4}|error\[E\d{4}\])\b/i;

const BUILD_CHECK_KIND_RE =
  /\b(?:build|bundle|compile|tsc|vue-tsc|svelte-check|typecheck|type-check|lint|eslint|oxlint|biome|ruff|flake8|mypy|pyright|basedpyright|pylint|stylelint|shellcheck|clippy|vet|webpack|rollup|tsup|esbuild|vite\s+build|electron-vite\s+build|next\s+build|nuxt\s+build|astro\s+build|cargo\s+(?:build|check|clippy)|go\s+(?:build|vet)|dotnet\s+build|gradle\s+build|mvn\s+(?:compile|package))\b/i;

const FILTER_STAGE_CMD_RE =
  /^(?:&\s+)?(?:(?:[a-z]:)?[\\/][^\s]+?[\\/])?(?:select-string|sls|grep|egrep|fgrep|rg|ripgrep|findstr)(?:\.exe)?(?:\s|$)/i;

const WIN_DRIVE_OR_UNC_PATH_BEFORE_TRAILING_BS_RE =
  /^(?:[a-zA-Z]:(?:[\\/][^"'`<>|;&=()]*)?|(?:\\\\|\.\.?\\)[^"'`<>|;&=()]*)$/;
const WIN_REL_PATH_BEFORE_TRAILING_BS_RE =
  /^(?:[^"'`<>|;&=()\s][^"'`<>|;&=()]*\\[^"'`<>|;&=()]*|[^\s"'`<>|;&=()]+)$/;

const PURE_SETUP_CLAUSE_RE =
  /^(?:(?:cd|chdir|pushd|set-location|push-location|sl)(?:\s|$)|export\s+[a-z_][a-z0-9_]*=|set\s+(?:"[a-z_][a-z0-9_]*=|[a-z_][a-z0-9_]*=)|\$env:[a-z0-9_]+\s*=|[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)(?:\s+[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*$)/i;

const READ_ONLY_STAGE_HEAD_RE =
  /^(?:git(?:\.exe)?\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|-c\s+(?:"[^"]*"|'[^']*'|\S+))\s+)*(?:diff|status|log|show|branch|rev-parse|ls-files|grep|blame|shortlog|describe|tag|reflog|ls-tree|cat-file|check-ignore|for-each-ref)|(?:cat|head|tail|less|more|ls|dir|echo|printf|pwd|which|where|type|rg|ripgrep|grep|egrep|fgrep|select-string|sls|findstr|get-content|get-childitem|get-location|get-item|gc|gci|gl|stat|wc|file|tree|find|write-output|write-host|format-table|select-object|measure-object|sort-object|test-path|resolve-path|true)(?:\.exe)?)(?:\s|$)/i;

const RUNNER_PREFIX_RE =
  /^(?:(?:npx(?:\.cmd)?(?:\s+(?:-y|--yes|--no-install|-p\s+\S+))*|npm(?:\.cmd)?\s+exec(?:\s+--)?|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:exec|dlx)(?:\s+--)?|bunx(?:\.cmd)?|(?:uv|poetry|pipenv|pdm|hatch)(?:\.exe)?\s+run|(?:python3?|py)(?:\.exe)?(?:\s+-[a-zA-Z0-9]+)*\s+-m|dotnet(?:\.exe)?\s+tool\s+run)\s+)+/i;

const STATIC_CHECK_DIRECT_RE =
  /^(?:(?:tsc|vue-tsc|svelte-check|typecheck|type-check|eslint|oxlint|biome|ruff|flake8|mypy|pyright|basedpyright|pylint|stylelint|shellcheck)(?:\.(?:exe|cmd|bat))?(?:\s|$)|prettier(?:\.(?:exe|cmd))?\s+(?:.*\s)?--check(?:\s|$)|cargo(?:\.exe)?\s+(?:clippy|check)(?:\s|$)|go(?:\.exe)?\s+vet(?:\s|$)|deno(?:\.exe)?\s+(?:lint|check)(?:\s|$))/i;

const PM_SCRIPT_CALL_RE =
  /^(?:npm(?:\.cmd)?\s+(?:(?:--(?:prefix|cwd|dir|filter|workspace)(?:=|\s+)\S+|-(?:w|C)\s+\S+)\s+)*run(?:-script)?\s+|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:(?:--(?:prefix|cwd|dir|filter|workspace)(?:=|\s+)\S+|-w|-(?:C|F)\s+\S+)\s+)*(?:run\s+)?)([a-z0-9_.:/-]+)(?:\s|$)/i;

const STATIC_PM_SCRIPT_NAME_RE =
  /^(?:[a-z0-9_.:-]+[:_-])?(?:typecheck|type-check|tsc|lint|eslint|oxlint|biome|ruff|mypy|pyright|stylelint|check:types|check-types|types:check)(?:[:_-][a-z0-9_.:-]+)?$/i;

const NON_STATIC_SCRIPT_TOKEN_RE =
  /(?:^|[:_-])(?:test|tests|spec|e2e|smoke|build|bundle|dist|compile|all)(?:$|[:_-])/i;

const STATIC_CHECK_NAME_RE =
  /^(?:tsc|vue-tsc|svelte-check|typecheck|type-check|eslint|oxlint|biome|ruff|flake8|mypy|pyright|basedpyright|pylint|stylelint|lint)(?:[:_\s-][a-z0-9_.-]*)?$/i;

const STATIC_CHECK_CRASH_RE =
  /(?:Encountered error in step execution|Atomic edit aborted|Partial edit applied|Tool error \(|Verify \[FAIL|## \[FAIL|## \[ERROR|(?:^|\n)\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|ImportError|ModuleNotFoundError|ValueError|NameError|AttributeError|KeyError|IndexError|FileNotFoundError|RuntimeError|IndentationError|ZeroDivisionError|ZodError|RangeError|not ok\s+\d+|FAIL\s+\S)|(?:^|\n)\s*✖\s+(?!\d+\s+problems?\b)|(?:^|\n)\s*at\s+(?:[^\n]+\s+\([^)\n]+:\d+:\d+\)|(?:file:\/\/)?[^\s()]+:\d+:\d+)\s*(?:\n|$))/m;

const STATIC_CHECK_CRASH_BANNER_RE =
  /(?:FATAL ERROR:|Oops!\s+Something went wrong|Traceback \(most recent call last\):|UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|(?:^|\n)\s*Error:\s+(?:Cannot find module|ENOENT\b|Failed to load)|Segmentation fault|thread '[^']+' panicked at|(?:^|\n)\s*panic:)/im;

const TEST_RUNNER_CMD_RE =
  /\b(?:vitest|jest|pytest|mocha|ava|playwright|cypress|unittest|rspec|phpunit|ctest|node\s+--test|cargo\s+test|go\s+test|dotnet\s+test|bun\s+test|npm\s+(?:t|test|run\s+[a-z0-9_.:/-]*test[a-z0-9_.:/-]*)|pnpm\s+(?:run\s+)?[a-z0-9_.:/-]*test[a-z0-9_.:/-]*|yarn\s+(?:run\s+)?[a-z0-9_.:/-]*test[a-z0-9_.:/-]*)\b/i;

const STRONG_VERIFY_STAGE_RE =
  /^(?:(?:vitest|jest|pytest|mocha|ava|playwright|cypress|unittest|rspec|phpunit|ctest|webpack|rollup|tsup|esbuild|gradle|gradlew|mvn|mvnw|make|cmake)(?:\.(?:exe|cmd|bat|ps1|sh))?(?:\s|$)|node(?:\.exe)?\s+(?:--[a-z0-9-]+(?:=\S+)?\s+)*--test(?:\s|$)|deno(?:\.exe)?\s+test(?:\s|$)|(?:cargo|go|dotnet)(?:\.exe)?\s+(?:test|build)(?:\s|$)|(?:electron-)?vite(?:\.(?:exe|cmd))?\s+build(?:\s|$)|(?:next|nuxt|astro|svelte-kit|remix|rsbuild|parcel|turbo|nx)(?:\.(?:exe|cmd))?\s+(?:build|test)(?:\s|$)|npm(?:\.cmd)?\s+(?:(?:--(?:prefix|cwd|dir|filter|workspace)(?:=|\s+)\S+|-(?:w|C)\s+\S+)\s+)*(?:t|test|run(?:-script)?\s+[a-z0-9_.:/-]*(?:test|build|e2e|smoke)[a-z0-9_.:/-]*)(?:\s|$)|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:(?:--(?:prefix|cwd|dir|filter|workspace)(?:=|\s+)\S+|-w|-(?:C|F)\s+\S+)\s+)*(?:t|test|(?:run\s+)?[a-z0-9_.:/-]*(?:test|build|e2e|smoke)[a-z0-9_.:/-]*)(?:\s|$))/i;

const STRONG_VERIFY_NAME_RE =
  /\b(?:vitest|jest|pytest|mocha|ava|playwright|cypress|unit|e2e|smoke|integration|build|test|tests)\b/i;

const EPHEMERAL_BRAIN_PATH_RE =
  /(?:^|\/)(?:\.gemini\/antigravity(?:-[a-z0-9._-]+)?\/brain\/[^/]+\/|brain\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)/i;

const EPHEMERAL_OS_TEMP_PATH_RE =
  /^(?:(?:\/private)?\/tmp\/|\/var\/tmp\/|(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/t\/|[a-z]:\/users\/[^/]+\/appdata\/local\/temp\/|[a-z]:\/windows\/temp\/)/i;

const RUNTIME_OS_TMPDIR_NORM = (() => {
  try {
    const raw = os.tmpdir();
    if (!raw) return "";
    const n = normPath(raw).replace(/\/+$/, "");
    return n ? `${n}/` : "";
  } catch {
    return "";
  }
})();

const DIAG_SOURCE_EXT_RE = /\.(?:[cm]?[tj]sx?|vue|svelte|py|pyi|rs|go|java|kt|cs|rb|php|css|scss|less|html)$/i;
const DIAG_LOCATED_FILE_RE =
  /^(?:"([^"\r\n<>|?*]+)"|'([^'\r\n<>|?*]+)'|((?:[a-zA-Z]:[\\/]|(?:\.\.?[\\/])?|\/)?[^:\r\n<>|?*]+?\.[a-zA-Z0-9]+))\s*(?:\(\d+,\d+\)(?:\s*[-:]|\s*$)|:\d+(?::\d+)?(?:\s*[-:]|\s*$))/;
const DIAG_STANDALONE_FILE_RE =
  /^(?:"([^"\r\n<>|?*]+)"|'([^'\r\n<>|?*]+)'|((?:[a-zA-Z]:[\\/]|(?:\.\.?[\\/])?|\/)?[^:\r\n<>|?*]+?\.[a-zA-Z0-9]+))$/;
const DIAG_PROSE_PREFIX_RE =
  /^(?:error|warning|info|note|help|found|failed|cannot|unable|see|in|at|from|the|type|property|argument|did\s+you)\s+/i;
const DIAG_UNATTRIBUTED_TOP_ERROR_RE =
  /^(?:error\s+TS\d{4}\s*:|[^\s].*?(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*[-:]?\s*error\b)/i;

function isStepCanceledResult(step) {
  if (!step || typeof step !== "object") return false;
  if (step.aborted === true || step.cancelled === true || step.canceled === true) return true;
  if (
    /^(?:cancelled|canceled|aborted|interrupted)$/i.test(
      String(step.status ?? step.stop_reason ?? step.stopReason ?? "")
    )
  ) {
    return true;
  }
  const text = typeof step.content === "string" ? step.content : "";
  return Boolean(text && STEP_CANCELED_TEXT_RE.test(text));
}

const BG_TASK_LAUNCH_LINE_RE =
  /^\s*(?:tool is running as a background task|command is still running in the background|running as a background task|background task with task id)\b/i;

function splitHarnessHeaderAndOutput(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const idxMatch = normalized.match(/(?:^|\n)(?:Log output|Command output):\s*(?:\n|$)/i);
  if (!idxMatch) {
    return { headerPart: normalized, outputPart: normalized, hasOutputSection: false };
  }
  return {
    headerPart: normalized.slice(0, idxMatch.index),
    outputPart: normalized.slice(idxMatch.index + idxMatch[0].length),
    hasOutputSection: true
  };
}

function isStepBackgroundLaunchResult(step, bareTool = "") {
  if (!step || typeof step !== "object") return false;
  if (bareTool !== "run_command") return false;
  if (step.status === "ERROR" || step.is_error === true || step.isError === true) return false;
  const code = step.exit_code ?? step.exitCode;
  if (typeof code === "number") return false;
  const text = typeof step.content === "string" ? step.content : "";
  if (!text) return false;
  const { headerPart } = splitHarnessHeaderAndOutput(text);
  if (extractHarnessExitCode(headerPart) !== null) return false;
  for (const rawLine of headerPart.split("\n").slice(0, 6)) {
    const line = rawLine.trim();
    if (!line || /^(?:Created At|Completed At):\s+/i.test(line)) continue;
    if (BG_TASK_LAUNCH_LINE_RE.test(line)) return true;
  }
  return false;
}

function extractBackgroundTaskIdFromLaunch(step) {
  const text = typeof step?.content === "string" ? step.content : "";
  if (!text) return "";
  const { headerPart } = splitHarnessHeaderAndOutput(text);
  const m = headerPart.match(BG_TASK_ID_FROM_LAUNCH_RE);
  return m && m[1] ? m[1].trim().replace(/[.,;)\]]+$/, "") : "";
}

function hasTruthyArtifactMetadata(callArgs) {
  if (!callArgs || typeof callArgs !== "object") return false;
  const raw = callArgs.ArtifactMetadata ?? callArgs.artifactMetadata;
  if (!raw) return false;
  if (typeof raw === "object") return Object.keys(raw).length > 0;
  if (typeof raw === "string") {
    const unwrapped = unwrapQuotedWrapperArg(raw).trim().toLowerCase();
    return Boolean(unwrapped && unwrapped !== "false" && unwrapped !== "null" && unwrapped !== "undefined" && unwrapped !== "{}");
  }
  return Boolean(raw);
}

function isTruthyBooleanArg(raw) {
  if (raw === true) return true;
  if (typeof raw === "string") {
    return unwrapQuotedWrapperArg(raw).trim().toLowerCase() === "true";
  }
  return false;
}

function isEphemeralNonProjectPath(normFilePath, callArgs = null, options = {}) {
  if (hasTruthyArtifactMetadata(callArgs)) {
    return true;
  }
  if (!normFilePath) return false;
  const p = String(normFilePath).replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  const wsNorm = options?.workspaceCwd ? normPath(options.workspaceCwd).replace(/\/+$/, "") : "";
  if (wsNorm) {
    const stripPrivate = (s) => s.replace(/^\/private(?=\/(?:var|tmp)(?:\/|$))/, "");
    const pCmp = stripPrivate(p);
    const wsCmp = stripPrivate(wsNorm);
    if (p === wsNorm || p.startsWith(`${wsNorm}/`) || pCmp === wsCmp || pCmp.startsWith(`${wsCmp}/`)) {
      return false;
    }
  }
  if (EPHEMERAL_BRAIN_PATH_RE.test(p)) return true;
  if (EPHEMERAL_OS_TEMP_PATH_RE.test(p)) return true;
  if (RUNTIME_OS_TMPDIR_NORM && p.startsWith(RUNTIME_OS_TMPDIR_NORM)) return true;
  return false;
}

function hasEvenRemainingDoubleQuotes(str, startIdx) {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  for (let j = startIdx; j < str.length; j++) {
    const c = str[j];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = true;
      continue;
    }
    if (inDouble) {
      if (c === "`" && j + 1 < str.length && (str[j + 1] === '"' || str[j + 1] === "`")) {
        j++;
        continue;
      }
      if (c === "\\" && j + 1 < str.length) {
        if (str[j + 1] === "\\") {
          j++;
          continue;
        }
        if (str[j + 1] === '"') {
          const after = str[j + 2];
          if (after !== undefined && !/[\s;|&<>)]/.test(after)) {
            j++;
            continue;
          }
        }
      }
    }
    if (c === '"') {
      count += 1;
      inDouble = !inDouble;
    }
  }
  return count % 2 === 0;
}

function splitOutsideQuotesWithOps(str, isSepFn) {
  const parts = [];
  const ops = [];
  let cur = "";
  let quote = "";
  let quoteStartIdx = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (quote === '"') {
        if (ch === "`" && i + 1 < str.length && (str[i + 1] === '"' || str[i + 1] === "`")) {
          cur += ch + str[++i];
          continue;
        }
        if (ch === "\\" && i + 1 < str.length) {
          if (str[i + 1] === "\\") {
            cur += ch + str[++i];
            continue;
          }
          if (str[i + 1] === '"') {
            const quoteContent = str.slice(quoteStartIdx + 1, i);
            const nextAfter = str[i + 2];
            const atTokenEnd = nextAfter === undefined || /[\s;|&<>)]/.test(nextAfter);
            const isWinTrailingBs =
              atTokenEnd &&
              (WIN_DRIVE_OR_UNC_PATH_BEFORE_TRAILING_BS_RE.test(quoteContent) ||
                (WIN_REL_PATH_BEFORE_TRAILING_BS_RE.test(quoteContent) &&
                  hasEvenRemainingDoubleQuotes(str, i + 2)));
            if (!isWinTrailingBs) {
              cur += ch + str[++i];
              continue;
            }
          }
        }
      }
      cur += ch;
      if (ch === quote) {
        quote = "";
        quoteStartIdx = -1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoteStartIdx = i;
      cur += ch;
      continue;
    }
    const sepLen = isSepFn(str, i);
    if (sepLen > 0) {
      if (cur.trim()) {
        parts.push(cur.trim());
        ops.push(str.slice(i, i + sepLen));
      }
      cur = "";
      i += sepLen - 1;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) {
    parts.push(cur.trim());
  } else if (ops.length > 0 && ops.length >= parts.length) {
    ops.pop();
  }
  return { parts, ops };
}

function splitOutsideQuotes(str, isSepFn) {
  return splitOutsideQuotesWithOps(str, isSepFn).parts;
}

const SHELL_WRAPPER_CMD_RE =
  /^(?:(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-(?:NoProfile|NonInteractive|NoLogo|nop|noni)|-ExecutionPolicy\s+\S+)\s+)*(?:-Command|-c)\s+|(?:bash|sh|zsh)(?:\.exe)?\s+(?:-[a-zA-Z]*c)\s+|cmd(?:\.exe)?\s+(?:\/[a-zA-Z]+\s+)*\/c\s+)(.+)$/i;

function unwrapShellPayloadToken(payload) {
  const s = String(payload || "")
    .replace(/\s+2>&1\s*$/g, "")
    .replace(/\s+2>(?:\/dev\/null|\$null|nul)\s*$/gi, "")
    .trim();
  if (!s) return "";
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
    const q = s[0];
    let closedAt = -1;
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (q === '"') {
        if (ch === "`" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "`")) {
          i++;
          continue;
        }
        if (ch === "\\" && i + 1 < s.length && (s[i + 1] === "\\" || s[i + 1] === '"')) {
          if (s[i + 1] === "\\") {
            i++;
            continue;
          }
          const atEnd = i + 2 === s.length;
          if (!atEnd || !WIN_DRIVE_OR_UNC_PATH_BEFORE_TRAILING_BS_RE.test(s.slice(1, i))) {
            i++;
            continue;
          }
        }
      }
      if (ch === q) {
        closedAt = i;
        break;
      }
    }
    if (closedAt === s.length - 1) {
      const inner = s.slice(1, -1);
      if (q === "'") return inner.trim();
      return inner.replace(/\\"/g, '"').replace(/`"/g, '"').trim();
    }
    return "";
  }
  return s;
}

function unwrapSingleShellWrapperClause(clause) {
  const stages = splitOutsideQuotes(String(clause || "").trim(), (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length !== 1) return "";
  const head = normalizeStageCommandHead(stages[0]);
  const m = head.match(SHELL_WRAPPER_CMD_RE);
  if (!m || !m[1]) return "";
  return unwrapShellPayloadToken(m[1]);
}

function splitShellClauses(commandText, depth = 0) {
  if (!commandText || typeof commandText !== "string") return { clauses: [], operators: [] };
  const cleaned = depth === 0 ? unwrapQuotedWrapperArg(commandText).trim() : commandText.trim();
  if (!cleaned) return { clauses: [], operators: [] };
  const { parts, ops } = splitOutsideQuotesWithOps(cleaned, (s, i) => {
    if (s[i] === ";") return 1;
    if ((s[i] === "&" && s[i + 1] === "&") || (s[i] === "|" && s[i + 1] === "|")) return 2;
    return 0;
  });
  if (depth >= 2 || parts.length === 0) {
    return { clauses: parts, operators: ops };
  }
  const expandedClauses = [];
  const expandedOps = [];
  for (let idx = 0; idx < parts.length; idx++) {
    const unwrapped = unwrapSingleShellWrapperClause(parts[idx]);
    if (unwrapped && unwrapped !== parts[idx]) {
      const sub = splitShellClauses(unwrapped, depth + 1);
      if (sub.clauses.length > 0) {
        for (let j = 0; j < sub.clauses.length; j++) {
          expandedClauses.push(sub.clauses[j]);
          if (j < sub.operators.length) expandedOps.push(sub.operators[j]);
        }
        if (idx < ops.length) expandedOps.push(ops[idx]);
        continue;
      }
    }
    expandedClauses.push(parts[idx]);
    if (idx < ops.length) expandedOps.push(ops[idx]);
  }
  return { clauses: expandedClauses, operators: expandedOps };
}

function getTrailingSemicolonSegment(commandText) {
  const { clauses, operators } = splitShellClauses(commandText);
  if (clauses.length === 0) return { clauses: [], operators: [] };
  let lastSemi = -1;
  for (let i = 0; i < operators.length; i++) {
    if (operators[i] === ";") lastSemi = i;
  }
  if (lastSemi < 0) return { clauses, operators };
  return {
    clauses: clauses.slice(lastSemi + 1),
    operators: operators.slice(lastSemi + 1)
  };
}

function isPureSetupClause(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitOutsideQuotes(trimmed, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length !== 1) return false;
  return PURE_SETUP_CLAUSE_RE.test(trimmed);
}

function stripExecPathPrefix(stageStr) {
  const quotedExec = stageStr.match(/^("([^"]+)"|'([^']+)')(?:\s+(.*))?$/);
  if (quotedExec) {
    const rawExec = quotedExec[2] ?? quotedExec[3] ?? "";
    const rest = quotedExec[4] || "";
    if (!/(?:^|[\\/])scripts[\\/]/i.test(rawExec) && /[\\/]/.test(rawExec)) {
      const base = rawExec.replace(/^.*[\\/]/, "");
      return rest ? `${base} ${rest}` : base;
    }
    return stageStr;
  }
  const unquotedExec = stageStr.match(/^([^\s"']+)(?:\s+(.*))?$/);
  if (unquotedExec) {
    const rawExec = unquotedExec[1];
    const rest = unquotedExec[2] || "";
    if (!/(?:^|[\\/])scripts[\\/]/i.test(rawExec) && /[\\/]/.test(rawExec)) {
      const base = rawExec.replace(/^.*[\\/]/, "");
      return rest ? `${base} ${rest}` : base;
    }
  }
  return stageStr;
}

function normalizeStageCommandHead(stage) {
  let s = String(stage || "").trim();
  if (!s) return "";
  s = s.replace(/^&\s+/, "");
  while (true) {
    s = stripExecPathPrefix(s);
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
  return stripExecPathPrefix(s);
}

function stripRunnerPrefix(normalizedHead) {
  return String(normalizedHead || "").replace(RUNNER_PREFIX_RE, "").trim();
}

function isReadOnlyClause(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitOutsideQuotes(trimmed, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length === 0) return false;
  const head = normalizeStageCommandHead(stages[0]);
  return READ_ONLY_STAGE_HEAD_RE.test(head);
}

function clauseHasFilterStage(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitOutsideQuotes(trimmed, (s, i) => (s[i] === "|" ? 1 : 0));
  for (const rawStage of stages) {
    const cleanedStage = rawStage
      .replace(/\b2>&1\b/g, "")
      .replace(/\b2>(?:\/dev\/null|\$null|nul)\b/gi, "")
      .trim();
    const norm = normalizeStageCommandHead(cleanedStage);
    if (norm && FILTER_STAGE_CMD_RE.test(norm)) return true;
  }
  return false;
}

function isNonConvergingPassCommand(commandText) {
  if (!commandText || typeof commandText !== "string" || !commandText.trim()) return false;
  const { clauses, operators } = getTrailingSemicolonSegment(commandText);
  if (clauses.length === 0) return false;
  if (operators.includes("||")) return true;
  const nonSetup = clauses.filter((c) => !isPureSetupClause(c));
  if (nonSetup.length === 0) return true;
  return nonSetup.every((c) => isReadOnlyClause(c) || clauseHasFilterStage(c));
}

function extractFinalPipelineStage(commandText) {
  if (!commandText || typeof commandText !== "string") return "";
  const { clauses } = splitShellClauses(commandText);
  if (clauses.length === 0) return "";
  const lastClause = clauses[clauses.length - 1];
  const stages = splitOutsideQuotes(lastClause, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length === 0) return "";
  const cleanedStage = stages[stages.length - 1]
    .replace(/\b2>&1\b/g, "")
    .replace(/\b2>(?:\/dev\/null|\$null|nul)\b/gi, "")
    .trim();
  return normalizeStageCommandHead(cleanedStage);
}

function isFilterTerminalCommand(commandText) {
  const finalStage = extractFinalPipelineStage(commandText);
  return Boolean(finalStage && FILTER_STAGE_CMD_RE.test(finalStage));
}

function stripZeroMatchOutputMeta(outputText) {
  if (!outputText || typeof outputText !== "string") return "";
  const normalized = outputText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const outLines = [];
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/^<\/?SYSTEM_MESSAGE>\s*/i, "")
      .replace(/\s*<\/?SYSTEM_MESSAGE>$/i, "")
      .trim();
    if (!line) continue;
    if (/^(?:Created At|Completed At):\s+/i.test(line)) continue;
    if (/^A pre-tool hook changed the arguments of this tool call before it ran\.(?:\s+Changed:\s+.+)?$/i.test(line)) {
      continue;
    }
    if (/^\$\s+/.test(line)) continue;
    if (/^(?:Command\s+)?exited with code\s+1\.?$/i.test(line)) continue;
    if (/^(?:Command|Log)\s+output:\s*$/i.test(line)) continue;
    if (/^(?:\(no output\)|No output from the command\.?)$/i.test(line)) continue;
    if (/^Log:\s+(?:file:\/\/\/?\S.*|\[[^\]]+\]\(file:\/\/[^)]+\)|(?:[a-zA-Z]:[\\/]|\/)[^\n]*\.(?:log|txt))$/i.test(line)) {
      continue;
    }
    outLines.push(line);
  }
  return outLines.join("\n").trim();
}

function extractHarnessExitCode(text) {
  if (!text || typeof text !== "string") return null;
  const { headerPart } = splitHarnessHeaderAndOutput(text);
  const m = headerPart.match(/(?:^|\n)\s*(?:Command\s+)?exited with code\s+(\d+)\.?(?:\s*(?:<\/SYSTEM_MESSAGE>)?\s*(?:\n|$))/i);
  if (m && m[1] !== undefined) {
    const code = Number(m[1]);
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

function isZeroMatchFilterExit(commandText, outputText, explicitExitCode = null) {
  const effectiveCode =
    typeof explicitExitCode === "number" ? explicitExitCode : extractHarnessExitCode(outputText);
  if (effectiveCode !== 1) return false;
  const { clauses, operators } = splitShellClauses(commandText);
  if (clauses.length === 0) return false;
  if (operators.includes("||")) return false;
  if (operators.includes("&&")) {
    for (let idx = 0; idx < clauses.length - 1; idx++) {
      if (!isPureSetupClause(clauses[idx])) return false;
    }
  }
  const lastClause = clauses[clauses.length - 1];
  const stages = splitOutsideQuotes(lastClause, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length === 0) return false;
  const finalStage = normalizeStageCommandHead(
    stages[stages.length - 1]
      .replace(/\b2>&1\b/g, "")
      .replace(/\b2>(?:\/dev\/null|\$null|nul)\b/gi, "")
      .trim()
  );
  if (!finalStage || !FILTER_STAGE_CMD_RE.test(finalStage)) return false;
  return stripZeroMatchOutputMeta(outputText) === "";
}

function analyzeDiagnosticFilePaths(bodyText) {
  if (!bodyText || typeof bodyText !== "string") {
    return { paths: [], hasUnattributedDiagnostic: false };
  }
  const out = [];
  const seen = new Set();
  let hasUnattributedDiagnostic = false;
  const lines = bodyText
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^error\s+TS\d{4}\s*:/i.test(trimmed)) {
      hasUnattributedDiagnostic = true;
      continue;
    }
    if (/^(?:https?:\/\/|file:\/\/|\$\s+|error\s+|warning\s+|found\s+\d+|✖|✔|- )/i.test(trimmed)) {
      continue;
    }
    const isIndented = /^\s/.test(rawLine);
    let candidateLine = trimmed;
    const pointerPrefix = candidateLine.match(/^(?:-->|┌─|╭─\[)\s*(.+)$/);
    if (pointerPrefix) {
      candidateLine = pointerPrefix[1].trim();
      if (trimmed.startsWith("╭─[") && candidateLine.endsWith("]")) {
        candidateLine = candidateLine.slice(0, -1).trim();
      }
    }
    let m = candidateLine.match(DIAG_LOCATED_FILE_RE);
    if (!m && !isIndented && !DIAG_PROSE_PREFIX_RE.test(candidateLine)) {
      m = candidateLine.match(DIAG_STANDALONE_FILE_RE);
    }
    const rawCandidate = m ? (m[1] || m[2] || m[3] || "").trim() : "";
    if (!rawCandidate || !DIAG_SOURCE_EXT_RE.test(rawCandidate)) {
      if (!isIndented && DIAG_UNATTRIBUTED_TOP_ERROR_RE.test(trimmed)) {
        hasUnattributedDiagnostic = true;
      }
      continue;
    }
    const rawNorm = normPath(rawCandidate);
    if (!rawNorm) {
      if (!isIndented && DIAG_UNATTRIBUTED_TOP_ERROR_RE.test(trimmed)) {
        hasUnattributedDiagnostic = true;
      }
      continue;
    }
    const norm = path.posix.normalize(rawNorm).replace(/^(?:\.\.?\/)+/, "");
    if (!norm || norm === "." || norm === "..") {
      if (!isIndented && DIAG_UNATTRIBUTED_TOP_ERROR_RE.test(trimmed)) {
        hasUnattributedDiagnostic = true;
      }
      continue;
    }
    if (/(?:^|\/)(?:node_modules|site-packages)\//i.test(norm)) continue;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return { paths: out, hasUnattributedDiagnostic };
}

function normalizedPathsOverlap(diagPath, candidatePath) {
  if (!diagPath || !candidatePath) return false;
  const a = path.posix.normalize(String(diagPath)).replace(/^(?:\.\.?\/)+/, "");
  const b = path.posix.normalize(String(candidatePath)).replace(/^(?:\.\.?\/)+/, "");
  if (!a || !b || a === "." || b === ".") return false;
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  return false;
}

function hasAnyPathOverlap(diagPaths, candidateFilesSet) {
  if (!candidateFilesSet || candidateFilesSet.size === 0) return false;
  for (const dp of diagPaths) {
    for (const cf of candidateFilesSet) {
      if (normalizedPathsOverlap(dp, cf)) return true;
    }
  }
  return false;
}

function isStaticTypeOrLintCheck(name = "", cmd = "") {
  const cleanedCmd = unwrapQuotedWrapperArg(String(cmd || "")).trim();
  if (cleanedCmd) {
    if (isFilterTerminalCommand(cleanedCmd)) return false;
    const { clauses, operators } = splitShellClauses(cleanedCmd);
    if (clauses.length === 0 || operators.includes("||")) return false;
    const nonSetup = clauses.filter((c) => !isPureSetupClause(c));
    if (nonSetup.length !== 1) return false;
    const singleClause = nonSetup[0];
    if (isReadOnlyClause(singleClause) || clauseHasFilterStage(singleClause)) return false;
    const stages = splitOutsideQuotes(singleClause, (s, i) => (s[i] === "|" ? 1 : 0));
    if (stages.length === 0) return false;
    const head = normalizeStageCommandHead(stages[0]);
    const stripped = stripRunnerPrefix(head);
    if (STATIC_CHECK_DIRECT_RE.test(stripped)) return true;
    const pmMatch = stripped.match(PM_SCRIPT_CALL_RE);
    if (pmMatch && pmMatch[1]) {
      const scriptName = pmMatch[1];
      return STATIC_PM_SCRIPT_NAME_RE.test(scriptName) && !NON_STATIC_SCRIPT_TOKEN_RE.test(scriptName);
    }
    return false;
  }
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return false;
  if (TEST_RUNNER_CMD_RE.test(trimmedName) || NON_STATIC_SCRIPT_TOKEN_RE.test(trimmedName)) return false;
  return STATIC_CHECK_NAME_RE.test(trimmedName);
}

function isStrongVerifyPassBlock(block) {
  if (!block) return false;
  const cmd = unwrapQuotedWrapperArg(String(block.cmd || "")).trim();
  if (cmd) {
    if (isNonConvergingPassCommand(cmd)) return false;
    const { clauses } = getTrailingSemicolonSegment(cmd);
    for (const clause of clauses) {
      if (isPureSetupClause(clause) || isReadOnlyClause(clause) || clauseHasFilterStage(clause)) continue;
      const stages = splitOutsideQuotes(clause, (s, i) => (s[i] === "|" ? 1 : 0));
      if (stages.length === 0) continue;
      const stripped = stripRunnerPrefix(normalizeStageCommandHead(stages[0]));
      if (STRONG_VERIFY_STAGE_RE.test(stripped)) return true;
    }
  }
  const isPureStaticCmd = Boolean(cmd && isStaticTypeOrLintCheck("", cmd));
  if (!isPureStaticCmd && block.name && STRONG_VERIFY_NAME_RE.test(String(block.name))) {
    return true;
  }
  if (
    !isPureStaticCmd &&
    block.body &&
    (/\b[1-9]\d*\s+passed\b/i.test(block.body) || /(?:^|\n)\s*(?:ℹ\s+)?pass\s+[1-9]\d*\b/im.test(block.body))
  ) {
    return true;
  }
  return false;
}

function evaluateRunChecksResult(text, activeCandidateFiles = null) {
  if (!text || typeof text !== "string") {
    return { recognized: false, outcome: "pass", profileContent: "" };
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks = [];
  let current = null;
  const headerMatch = normalized.match(/^Checks:\s*(\d+)\/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/m);
  const sawHeader = Boolean(headerMatch);
  const headerPassedCount = headerMatch ? Number(headerMatch[1]) : 0;
  const headerTotalCount = headerMatch ? Number(headerMatch[2]) : 0;
  const headerFailedCount = headerMatch
    ? headerMatch[3] !== undefined
      ? Number(headerMatch[3])
      : Math.max(0, headerTotalCount - headerPassedCount)
    : 0;

  const flush = () => {
    if (!current) return;
    current.body = current.bodyLines.join("\n").trim();
    delete current.bodyLines;
    blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    const compactPass = line.match(/^- \[PASS[^\]]*\]\s+(.+?)(?:\s+\(`(.+?)`\))?:\s*(.*)$/);
    if (compactPass) {
      flush();
      blocks.push({
        kind: "pass",
        name: compactPass[1].trim(),
        cmd: (compactPass[2] || "").trim(),
        body: (compactPass[3] || "").trim(),
        exitCode: 0,
        rawLine: line
      });
      continue;
    }
    const heading = line.match(/^## \[(PASS|FAIL|TIMEOUT|ERROR|SKIPPED)([^\]]*)\]\s*(.*)$/i);
    if (heading) {
      flush();
      const tag = heading[1].toUpperCase();
      const meta = heading[2] || "";
      const name = (heading[3] || "").trim();
      const exitMatch = meta.match(/exit\s+(\d+)/i);
      const exitCode = exitMatch ? Number(exitMatch[1]) : tag === "PASS" ? 0 : null;
      current = {
        kind: tag.toLowerCase(),
        name,
        cmd: "",
        exitCode,
        bodyLines: [],
        sawCmdLine: false,
        rawLine: line
      };
      continue;
    }
    if (current) {
      if (!current.sawCmdLine && /^\$\s+/.test(line.trim())) {
        current.cmd = line.trim().replace(/^\$\s+/, "").trim();
        current.sawCmdLine = true;
      } else {
        current.bodyLines.push(line);
      }
    }
  }
  flush();

  if (!sawHeader && blocks.length === 0) {
    return { recognized: false, outcome: "pass", profileContent: "" };
  }

  const passBlocks = blocks.filter((b) => b.kind === "pass");
  const convergingPassBlocks = passBlocks.filter((b) => !b.cmd || !isNonConvergingPassCommand(b.cmd));
  const timeoutOrSkippedBlocks = [];
  const hasStrongPass = convergingPassBlocks.some((b) => isStrongVerifyPassBlock(b));

  const realFailBlocks = [];
  const benignBlocks = [];
  for (const b of blocks) {
    if (b.kind === "error") {
      realFailBlocks.push(b);
      continue;
    }
    if (b.kind === "timeout") {
      if (hasRealCodeErrorOutput(b.body || "")) {
        realFailBlocks.push(b);
      } else {
        timeoutOrSkippedBlocks.push(b);
      }
      continue;
    }
    if (b.kind === "skipped") {
      timeoutOrSkippedBlocks.push(b);
      continue;
    }
    if (b.kind !== "fail") continue;
    if (isZeroMatchFilterExit(b.cmd, b.body, b.exitCode)) {
      benignBlocks.push({ ...b, benignReason: "zero_match_filter" });
      continue;
    }
    if (
      hasStrongPass &&
      activeCandidateFiles &&
      activeCandidateFiles.size > 0 &&
      isStaticTypeOrLintCheck(b.name, b.cmd) &&
      !STATIC_CHECK_CRASH_RE.test(b.body || "") &&
      !STATIC_CHECK_CRASH_BANNER_RE.test(b.body || "")
    ) {
      const { paths: diagPaths, hasUnattributedDiagnostic } = analyzeDiagnosticFilePaths(b.body);
      if (!hasUnattributedDiagnostic && diagPaths.length > 0 && !hasAnyPathOverlap(diagPaths, activeCandidateFiles)) {
        benignBlocks.push({ ...b, benignReason: "unrelated_static_noise" });
        continue;
      }
    }
    realFailBlocks.push(b);
  }

  const blockResults = [
    ...convergingPassBlocks.map((b) => ({
      name: b.name || formatCheckDisplayName("", b.cmd),
      cmd: b.cmd || "",
      kind: classifyCheckKind(b.name, b.cmd),
      outcome: "pass",
      exitCode: 0,
      body: b.body || ""
    })),
    ...timeoutOrSkippedBlocks
      .filter((b) => b.kind === "timeout")
      .map((b) => ({
        name: b.name || formatCheckDisplayName("", b.cmd),
        cmd: b.cmd || "",
        kind: classifyCheckKind(b.name, b.cmd),
        outcome: "timeout",
        exitCode: b.exitCode === 124 ? 124 : null,
        body: b.body || ""
      })),
    ...realFailBlocks.map((b) => ({
      name: b.name || formatCheckDisplayName("", b.cmd),
      cmd: b.cmd || "",
      kind: classifyCheckKind(b.name, b.cmd),
      outcome: "fail",
      exitCode: typeof b.exitCode === "number" && b.exitCode > 0 ? b.exitCode : 1,
      body: b.body || ""
    }))
  ];

  const accountedNonPass = realFailBlocks.length + timeoutOrSkippedBlocks.length + benignBlocks.length;
  const missingFailureCount =
    headerFailedCount > 0 && accountedNonPass < headerFailedCount
      ? headerFailedCount - accountedNonPass
      : 0;
  if (missingFailureCount > 0) {
    blockResults.push({
      name: "",
      cmd: "",
      kind: "check",
      outcome: "fail",
      exitCode: null,
      body: "",
      missingDetails: true,
      missingFailureCount,
      summaryHeader: headerMatch ? headerMatch[0].trim() : `Checks: ${headerPassedCount}/${headerTotalCount} passed, ${headerFailedCount} failed`
    });
  }
  if (realFailBlocks.length > 0 || missingFailureCount > 0) {
    const profileParts = [
      ...passBlocks.map((b) => `${b.rawLine}\n${b.body || ""}`),
      ...realFailBlocks.map((b) => `${b.rawLine}\n${b.body || ""}`)
    ];
    return {
      recognized: true,
      outcome: "fail",
      profileContent: profileParts.length > 0 ? profileParts.join("\n\n") : normalized,
      blockResults,
      headerTotalCount,
      headerFailedCount,
      missingFailureCount
    };
  }
  if (timeoutOrSkippedBlocks.length > 0) {
    return { recognized: true, outcome: "timeout_only", profileContent: "", blockResults, headerTotalCount, headerFailedCount, missingFailureCount: 0 };
  }
  if (
    convergingPassBlocks.length > 0 ||
    (passBlocks.length === 0 && sawHeader && headerFailedCount === 0 && headerPassedCount > 0)
  ) {
    return { recognized: true, outcome: "pass", profileContent: "", blockResults, headerTotalCount, headerFailedCount, missingFailureCount: 0 };
  }
  if (benignBlocks.length > 0) {
    return { recognized: true, outcome: "neutral", profileContent: "", blockResults, headerTotalCount, headerFailedCount, missingFailureCount: 0 };
  }
  return { recognized: true, outcome: "neutral", profileContent: "", blockResults, headerTotalCount, headerFailedCount, missingFailureCount: 0 };
}

export function classifyCheckKind(name = "", cmd = "") {
  const combined = `${name || ""} ${cmd || ""}`.trim();
  if (!combined) return "check";
  if (TEST_RUNNER_CMD_RE.test(cmd || "")) return "test";
  if (
    BUILD_CHECK_KIND_RE.test(combined) &&
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
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  if (cleanName) return cleanName.slice(0, 80);
  const cleanCmd = String(cmd || "").replace(/\s+/g, " ").trim();
  if (cleanCmd) return cleanCmd.slice(0, 80);
  return "check";
}

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

export function extractCheckIdentity(kind = "check", name = "", command = "", { missingDetails = false, batchKeys = null } = {}) {
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
  const cleanCmd = unwrapQuotedWrapperArg(String(command || "")).trim();
  let primaryStage = "";
  if (cleanCmd) {
    const { clauses } = getTrailingSemicolonSegment(cleanCmd);
    for (let idx = clauses.length - 1; idx >= 0; idx--) {
      const clause = clauses[idx];
      if (isPureSetupClause(clause) || isReadOnlyClause(clause)) continue;
      const stages = splitOutsideQuotes(clause, (s, i) => (s[i] === "|" ? 1 : 0));
      if (stages.length > 0) {
        const stage0 = stages[0]
          .replace(/\b2>&1\b/g, "")
          .replace(/\b[12]>(?:\/dev\/null|\$null|nul|\S+)\b/gi, "")
          .trim();
        primaryStage = stripRunnerPrefix(normalizeStageCommandHead(stage0));
        break;
      }
    }
  }

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

  const cleanName = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
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

export function extractBatchCheckIdentities(commands = [], blockResults = []) {
  const byKey = new Map();
  const batchCommands = [];
  const seenCmdKey = new Set();
  const addEntry = (rawName, rawCmd) => {
    const name = String(rawName || "").replace(/\s+/g, " ").trim();
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

function stripHarnessMetaLinesForErrorScan(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  const lines = rawText
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const kept = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^(?:Created At|Completed At|Task|Status|Task Description):\s+/i.test(trimmed)) continue;
    if (/^\[Message\]\s+(?:timestamp|sender|priority|content)=/i.test(trimmed)) continue;
    if (/^A pre-tool hook changed the arguments of this tool call before it ran\b/i.test(trimmed)) continue;
    if (/^(?:The tool's output was truncated|Here is a preview with the middle of the output truncated)/i.test(trimmed)) {
      continue;
    }
    if (/^(?:Command\s+)?exited with code\s+\d+\.?$/i.test(trimmed)) continue;
    if (/^(?:Command output|Log output):\s*$/i.test(trimmed)) continue;
    if (/^No output from the command\.?$/i.test(trimmed)) continue;
    if (/^Log:\s+(?:file:\/\/\/?\S.*|\[[^\]]+\]\(file:\/\/[^)]+\)|(?:[a-zA-Z]:[\\/]|\/)[^\n]*\.(?:log|txt))$/i.test(trimmed)) {
      continue;
    }
    kept.push(rawLine);
  }
  return kept.join("\n").trim();
}

function splitTrustedHarnessMetadataAndBody(rawText, hasOutputSection, headerPart, outputPart) {
  if (hasOutputSection) {
    return {
      trustedHeader: String(headerPart || ""),
      bodyText: stripHarnessMetaLinesForErrorScan(outputPart || "")
    };
  }
  const lines = String(rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const headerLines = [];
  const bodyLines = [];
  let inHeader = true;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (inHeader) {
      if (!trimmed) continue;
      if (
        /^(?:Created At|Completed At|Task|Status|Task Description):/i.test(trimmed) ||
        /^\[Message\]/i.test(trimmed) ||
        /^A pre-tool hook changed/i.test(trimmed) ||
        /^The tool's output was truncated/i.test(trimmed) ||
        /^Here is a preview/i.test(trimmed) ||
        /^No output from the command\.?$/i.test(trimmed) ||
        /^(?:Command\s+)?exited with code\s+\d+\.?$/i.test(trimmed) ||
        /^Log:\s+(?:file:\/\/\/?\S.*|\[[^\]]+\]\(file:\/\/[^)]+\)|(?:[a-zA-Z]:[\\/]|\/)[^\n]*\.(?:log|txt))$/i.test(trimmed) ||
        HARNESS_TIMEOUT_LINE_RE.test(trimmed) ||
        STEP_CANCELED_TEXT_RE.test(trimmed) ||
        /\b(?:was killed|killed by user|terminated by user)\b/i.test(trimmed)
      ) {
        headerLines.push(trimmed);
        continue;
      }
      inHeader = false;
    }
    bodyLines.push(rawLine);
  }
  return {
    trustedHeader: headerLines.join("\n"),
    bodyText: stripHarnessMetaLinesForErrorScan(bodyLines.join("\n"))
  };
}

function hasRealCodeErrorOutput(rawBody) {
  const cleaned = stripHarnessMetaLinesForErrorScan(rawBody);
  if (!cleaned) return false;
  if (REAL_CODE_ERROR_TEXT_RE.test(cleaned)) return true;
  if (/\b([1-9]\d*)\s+failed\b/i.test(cleaned)) return true;
  return false;
}

function extractCheckErrorDetails(rawBody) {
  const cleaned = stripHarnessMetaLinesForErrorScan(rawBody);
  if (!cleaned) return { firstErrorLine: "", errorExcerpt: "" };
  let redacted = cleaned;
  try {
    redacted = redactSecrets(cleaned).text;
  } catch {}
  const lines = redacted
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { firstErrorLine: "", errorExcerpt: "" };

  let anchorIdx = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (REAL_CODE_ERROR_TEXT_RE.test(lines[idx])) {
      anchorIdx = idx;
      break;
    }
  }
  if (anchorIdx < 0) {
    for (let idx = 0; idx < lines.length; idx++) {
      if (/\b(?:error|fail(?:ed|ure)?|exception|assert|panic|fatal)\b/i.test(lines[idx]) && !/\b0\s+(?:errors?|failed)\b/i.test(lines[idx])) {
        anchorIdx = idx;
        break;
      }
    }
  }
  const firstIdx = anchorIdx >= 0 ? anchorIdx : 0;
  const firstErrorLine = lines[firstIdx].trim().slice(0, 220);

  const startIdx = Math.max(0, firstIdx - 1);
  const selected = [];
  let charBudget = 0;
  for (let idx = startIdx; idx < lines.length && selected.length < 10; idx++) {
    const line = lines[idx].slice(0, 260);
    if (charBudget + line.length + 1 > 1000 && selected.length > 0) break;
    selected.push(line);
    charBudget += line.length + 1;
  }
  return {
    firstErrorLine,
    errorExcerpt: selected.join("\n")
  };
}

function classifyCheckCompletionOutcome({
  verb = "",
  rawText = "",
  headerPart = "",
  outputPart = "",
  hasOutputSection = false,
  explicitExitCode = null
} = {}) {
  const { trustedHeader, bodyText } = splitTrustedHarnessMetadataAndBody(
    rawText,
    hasOutputSection,
    headerPart,
    outputPart
  );
  const lowerVerb = String(verb || "").toLowerCase();
  if (
    lowerVerb.includes("cancel") ||
    STEP_CANCELED_TEXT_RE.test(trustedHeader) ||
    /^\s*Status:\s*(?:CANCELED|CANCELLED|KILLED|ABORTED)\b/im.test(trustedHeader) ||
    /\b(?:was killed|killed by user|terminated by user)\b/i.test(trustedHeader)
  ) {
    return { outcome: "canceled", exitCode: null, body: bodyText };
  }

  const exitCode =
    typeof explicitExitCode === "number" && Number.isFinite(explicitExitCode)
      ? explicitExitCode
      : extractHarnessExitCode(trustedHeader);
  const hasTrustedTimeout = hasOutputSection
    ? STEP_PURE_TIMEOUT_TEXT_RE.test(trustedHeader) || HARNESS_TIMEOUT_LINE_RE.test(trustedHeader)
    : HARNESS_TIMEOUT_LINE_RE.test(trustedHeader);
  const hasRealErr = hasRealCodeErrorOutput(bodyText);

  if (hasTrustedTimeout) {
    if (hasRealErr) {
      return {
        outcome: "fail",
        exitCode: typeof exitCode === "number" && exitCode > 0 ? exitCode : 1,
        body: bodyText
      };
    }
    if (exitCode === null || exitCode === 124) {
      return {
        outcome: "timeout",
        exitCode: exitCode === 124 ? 124 : null,
        body: bodyText
      };
    }
  }

  if (lowerVerb.includes("failed with error")) {
    return {
      outcome: "fail",
      exitCode: typeof exitCode === "number" && exitCode > 0 ? exitCode : 1,
      body: bodyText
    };
  }
  if (exitCode === 0) {
    return { outcome: "pass", exitCode: 0, body: bodyText };
  }
  if (typeof exitCode === "number" && exitCode > 0) {
    return { outcome: "fail", exitCode, body: bodyText };
  }
  return null;
}

function parseSingleBackgroundTaskCompletion(segmentText) {
  if (!segmentText || typeof segmentText !== "string") return null;
  const finishMatch = segmentText.match(BG_TASK_SYSTEM_FINISH_RE);
  let taskId = finishMatch && finishMatch[1] ? finishMatch[1].trim() : "";
  let verb = finishMatch && finishMatch[2] ? finishMatch[2].toLowerCase() : "";
  let afterBanner = finishMatch ? segmentText.slice((finishMatch.index || 0) + finishMatch[0].length) : "";
  if (!taskId) {
    const senderMatch = segmentText.match(BG_TASK_SENDER_RE);
    if (!senderMatch || !senderMatch[1]) return null;
    taskId = senderMatch[1].trim();
    afterBanner = segmentText;
  }
  const { headerPart: harnessHeader, outputPart: rawCmdOutput, hasOutputSection } = splitHarnessHeaderAndOutput(afterBanner);
  const cmdOutput =
    hasOutputSection || finishMatch
      ? rawCmdOutput
      : rawCmdOutput.replace(/^\s*\[Message\][^\n]*(?:\n|$)/i, "");

  const classified = classifyCheckCompletionOutcome({
    verb,
    rawText: afterBanner,
    headerPart: harnessHeader,
    outputPart: cmdOutput,
    hasOutputSection
  });
  if (!classified) return null;
  return {
    taskId,
    outcome: classified.outcome,
    exitCode: classified.exitCode,
    body: classified.body
  };
}

function parseBackgroundTaskCompletions(msgText) {
  if (!msgText || typeof msgText !== "string") return [];
  const stripped = msgText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<\/?SYSTEM_MESSAGE>/gi, "\n");
  const segments = stripped.split(
    /(?=(?:^|\n)\s*(?:\[Message\]\s+(?:timestamp|sender|priority|content)=|Task\s+id\s+"[^"]+"\s+(?:finished|failed|was cancel(?:ed|led))\b))/i
  );
  const out = [];
  for (const seg of segments) {
    const parsed = parseSingleBackgroundTaskCompletion(seg.trim());
    if (parsed) out.push(parsed);
  }
  return out;
}

function isStepTimeoutOnlyResult(step, bareTool = "") {
  if (!step || typeof step !== "object") return false;
  if (isStepBackgroundLaunchResult(step, bareTool)) return false;
  const text = typeof step.content === "string" ? step.content : "";
  // Never mask atomic/edit errors or explicit FAIL/ERROR banners as timeout-only
  if (
    text &&
    (text.includes("Atomic edit aborted") ||
      text.includes("Partial edit applied") ||
      text.includes("Tool error (") ||
      text.includes("Verify [FAIL") ||
      text.includes("## [FAIL") ||
      text.includes("## [ERROR"))
  ) {
    return false;
  }
  if (text && (text.includes("Verify [TIMEOUT") || text.includes("Verify [NOT RUN:"))) {
    const idx = text.indexOf("Verify [TIMEOUT");
    const afterVerify = idx >= 0 ? text.slice(idx).replace(/^Verify \[TIMEOUT[^\]]*\][^\n]*(?:\n|$)/i, "") : "";
    return !hasRealCodeErrorOutput(afterVerify);
  }
  if (text && (text.includes("## [TIMEOUT") || text.includes("## [SKIPPED]"))) {
    return !hasRealCodeErrorOutput(text);
  }
  const rawCode = step.exit_code ?? step.exitCode;
  const explicitCode = typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : null;
  if (step.timed_out === true || step.timedOut === true) {
    return !hasRealCodeErrorOutput(text) && (explicitCode === null || explicitCode === 124);
  }
  if (text && (!bareTool || !READ_ONLY_INSPECT_TOOLS.has(bareTool))) {
    const { headerPart, outputPart, hasOutputSection } = splitHarnessHeaderAndOutput(text);
    const classified = classifyCheckCompletionOutcome({
      rawText: text,
      headerPart,
      outputPart,
      hasOutputSection,
      explicitExitCode: explicitCode
    });
    if (classified && classified.outcome === "timeout") {
      return true;
    }
  }
  return false;
}

function extractFailureProfile(failedResults) {
  let errorKind = "generic";
  let passedCount = null;
  for (const r of failedResults) {
    const text = typeof r?.content === "string" ? r.content : "";
    if (!text) continue;
    const passMatches = [
      ...text.matchAll(/\b(\d+)\s+passed\b/gi),
      ...text.matchAll(/(?:^|\n)\s*pass\s+(\d+)\b/gim)
    ];
    for (const m of passMatches) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0 && (passedCount === null || n > passedCount)) {
        passedCount = n;
      }
    }
    if (errorKind === "generic") {
      if (text.includes("Atomic edit aborted") || text.includes("Partial edit applied")) {
        errorKind = "edit_error";
      } else {
        const m = text.match(SPECIFIC_ERROR_KIND_RE);
        if (m && m[1]) {
          errorKind = m[1].toLowerCase().replace(/^error\[|\]$/g, "");
        } else if (/(?:^|\n)\s*E\s+assert\b/m.test(text) || /\bAssertionError\b/i.test(text)) {
          errorKind = "assertionerror";
        }
      }
    }
  }
  return { errorKind, passedCount };
}

function isStepFailureResult(step, bareTool = "") {
  if (!step || typeof step !== "object") return false;
  if (isStepCanceledResult(step)) return false;
  if (isStepBackgroundLaunchResult(step, bareTool)) return false;
  if (isStepTimeoutOnlyResult(step, bareTool)) return false;
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
    text.includes("## [FAIL") ||
    text.includes("## [ERROR")
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
  if (
    /(?:^|\n)\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|ImportError|ModuleNotFoundError|ValueError|NameError|AttributeError|KeyError|IndexError|FileNotFoundError|RuntimeError|IndentationError|ZeroDivisionError|ZodError|✖\s+|not ok\s+\d+|FAIL\s+\S)/m.test(
      text
    )
  ) {
    return true;
  }
  const failCountMatch = text.match(/\b(\d+)\s+failed\b/i);
  if (failCountMatch && Number(failCountMatch[1]) > 0) {
    return true;
  }
  return false;
}

function extractCallEditPaths(call, options = {}) {
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
    if (p && !isEphemeralNonProjectPath(p, args, options)) paths.push(p);
  } else if ((bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) && !args.dryRun) {
    const baseCwd = args.cwd || "";
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) {
        if (e && e.path) {
          const p = normPath(e.path, baseCwd);
          if (p && !isEphemeralNonProjectPath(p, null, options)) paths.push(p);
        }
      }
    }
  }
  return paths;
}

const REAL_VERIFY_STAGE_RE =
  /^(?:(?:vitest|jest|pytest|mocha|ava|playwright|cypress|unittest|rspec|phpunit|ctest|tsc|vue-tsc|svelte-check|typecheck|type-check|eslint|oxlint|biome|ruff|flake8|mypy|pyright|basedpyright|pylint|stylelint|shellcheck|webpack|rollup|tsup|esbuild|swc|gradle|gradlew|mvn|mvnw|make|cmake|doc-health-check|health-check|healthcheck)(?:\.(?:exe|cmd|bat|ps1|sh))?(?:\s|$)|prettier(?:\.(?:exe|cmd))?\s+(?:.*\s)?--check(?:\s|$)|node(?:\.exe)?\s+(?:--[a-z0-9-]+(?:=\S+)?\s+)*--test(?:\s|$)|deno(?:\.exe)?\s+(?:test|check|lint)(?:\s|$)|cargo(?:\.exe)?\s+(?:test|check|build|clippy)(?:\s|$)|go(?:\.exe)?\s+(?:test|build|vet)(?:\s|$)|dotnet(?:\.exe)?\s+(?:test|build)(?:\s|$)|(?:electron-)?vite(?:\.(?:exe|cmd))?\s+build(?:\s|$)|(?:next|nuxt|astro|svelte-kit|remix|rsbuild|parcel|turbo|nx)(?:\.(?:exe|cmd))?\s+(?:build|typecheck|lint|check|test)(?:\s|$)|npm(?:\.cmd)?\s+(?:(?:--(?:prefix|cwd|dir|filter|workspace)(?:=|\s+)\S+|-(?:w|C)\s+\S+)\s+)*(?:t|test|run(?:-script)?\s+[a-z0-9_.:/-]*(?:build|check|verify|lint|test|typecheck|type-check|validate|audit|smoke|e2e|health|prefix:budget)[a-z0-9_.:/-]*)(?:\s|$)|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:(?:--(?:prefix|cwd|dir|filter|workspace)(?:=|\s+)\S+|-w|-(?:C|F)\s+\S+)\s+)*(?:t|test|(?:run\s+)?[a-z0-9_.:/-]*(?:build|check|verify|lint|test|typecheck|type-check|validate|audit|smoke|e2e|health|prefix:budget)[a-z0-9_.:/-]*)(?:\s|$)|(?:(?:node|tsx|ts-node|bun|deno|python3?|py|bash|sh|zsh|pwsh|powershell|ruby|perl)(?:\.exe)?(?:\s+(?:-ExecutionPolicy\s+\S+|-[a-zA-Z0-9-]+))*\s+)?(?:"[^"]*[\\/]scripts[\\/]|'[^']*[\\/]scripts[\\/]|["']?(?:(?:[a-z]:[\\/][^"'\s]*[\\/]|[\\/][^"'\s]*[\\/]|\.\.?[\\/])?)scripts[\\/])[a-z0-9_.-]*(?:check|verify|lint|test|validate|build|audit)[a-z0-9_.-]*)/i;

function isRealVerifyCommand(cmdStr) {
  const { clauses } = splitShellClauses(cmdStr);
  if (clauses.length === 0) return false;
  for (const clause of clauses) {
    if (isPureSetupClause(clause) || isReadOnlyClause(clause)) continue;
    const stages = splitOutsideQuotes(clause, (s, i) => (s[i] === "|" ? 1 : 0));
    if (stages.length === 0) continue;
    const stripped = stripRunnerPrefix(normalizeStageCommandHead(stages[0]));
    if (REAL_VERIFY_STAGE_RE.test(stripped)) return true;
  }
  return false;
}

function isConvergingVerifyCommand(cmdStr) {
  const { clauses, operators } = getTrailingSemicolonSegment(cmdStr);
  if (clauses.length === 0 || operators.includes("||")) return false;
  for (const clause of clauses) {
    if (isPureSetupClause(clause) || isReadOnlyClause(clause) || clauseHasFilterStage(clause)) continue;
    const stages = splitOutsideQuotes(clause, (s, i) => (s[i] === "|" ? 1 : 0));
    if (stages.length === 0) continue;
    const stripped = stripRunnerPrefix(normalizeStageCommandHead(stages[0]));
    if (REAL_VERIFY_STAGE_RE.test(stripped)) return true;
  }
  return false;
}

function isCheckOrVerifyCall(call) {
  const { bareTool, args } = unwrapEffectiveTool(call);
  if (bareTool === "run_checks" || /(?:^|_)run_checks$/.test(bareTool)) {
    return true;
  }
  if (bareTool === "run_command" && args && typeof args === "object") {
    const cmdStr = unwrapQuotedWrapperArg(String(args.CommandLine ?? args.commandLine ?? args.command ?? ""));
    return isRealVerifyCommand(cmdStr);
  }
  if ((bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) && args && args.verify) {
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

export function extractStepText(val) {
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

/** Return a clean zero-initialized driftBreakdown structure for prefix_drift read states */
export function createEmptyDriftBreakdown() {
  return {
    zeroRead: 0,
    partialRead: 0,
    unreportedRead: 0
  };
}

const MILD_PRUNE_MIN_PREV_TOKENS = 12000;
const MILD_PRUNE_KEEP_RATIO = 0.85;
const MILD_PRUNE_MIN_DROP_TOKENS = 8000;
const SLASH_COMPACT_RE = /^\s*\/compact(?:\s|$)/i;
const EXPLICIT_COMPACT_TYPE_RE = /(?:COMPACT|TRUNCAT|CONTEXT_SUMMARY|CONVERSATION_SUMMARY|CONTEXT_RESET)/i;
const COMPACTION_SUMMARY_SYSTEM_RE =
  /(?:(?:^|\n)\s*(?:conversation\s+(?:was\s+|has\s+been\s+)?compacted|context\s+(?:was\s+|has\s+been\s+)?(?:compacted|summarized|truncated)|summary\s+of\s+(?:the\s+)?(?:previous|earlier)\s+conversation|earlier\s+conversation\s+summary|<conversation_summary>|<context_summary>|\[(?:conversation\s+)?compacted\b|\[conversation\s+summary\b)|this\s+session\s+is\s+being\s+continued\s+from\s+a\s+previous\s+conversation|the\s+conversation\s+history\s+(?:was|has\s+been)\s+(?:compacted|truncated|summarized))/i;

/** Check whether a user input string is an explicit `/compact` command */
export function isSlashCompactText(text) {
  return typeof text === "string" && SLASH_COMPACT_RE.test(text);
}

function parseExplicitStepIndex(step) {
  if (!step || typeof step !== "object") return null;
  const raw = step.step_index ?? step.stepIndex ?? step.step_idx ?? step.stepIdx;
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function detectExplicitCompactionStep(step) {
  if (!step || typeof step !== "object") return false;
  const typeStr = String(step.type || "");
  if (EXPLICIT_COMPACT_TYPE_RE.test(typeStr)) return true;
  if (
    step.compacted === true ||
    step.isCompaction === true ||
    step.is_compaction === true ||
    step.metadata?.compacted === true ||
    step.metadata?.isCompaction === true ||
    step.metadata?.is_compaction === true
  ) {
    return true;
  }
  if (typeStr === "SYSTEM_MESSAGE") {
    const text = extractStepText(step.content ?? step.text);
    if (text && COMPACTION_SUMMARY_SYSTEM_RE.test(text)) return true;
  }
  return false;
}

function detectContextShrink(prevTokens, currTokens) {
  if (!Number.isFinite(prevTokens) || !Number.isFinite(currTokens) || prevTokens <= 0 || currTokens <= 0) {
    return { shrunk: false, severe: false };
  }
  const severe = prevTokens >= MIN_CACHEABLE_CONTEXT_TOKENS && currTokens < prevTokens * BUST_DROP_RATIO;
  const mild =
    prevTokens >= MILD_PRUNE_MIN_PREV_TOKENS &&
    currTokens < prevTokens * MILD_PRUNE_KEEP_RATIO &&
    prevTokens - currTokens >= MILD_PRUNE_MIN_DROP_TOKENS;
  return { shrunk: severe || mild, severe };
}

function buildCompactionEvent({
  kind,
  step,
  index,
  prevCtxTokens = null,
  currCtxTokens = null,
  detailText = ""
}) {
  const explicitStep = parseExplicitStepIndex(step);
  const hasExplicitStepIndex = explicitStep !== null;
  const stepIndex = hasExplicitStepIndex ? explicitStep : index;
  const at = typeof step?.created_at === "string" && step.created_at.trim() ? step.created_at.trim() : null;
  const safePrev = Number.isFinite(prevCtxTokens) && prevCtxTokens > 0 ? Math.round(prevCtxTokens) : null;
  const safeCurr = Number.isFinite(currCtxTokens) && currCtxTokens > 0 ? Math.round(currCtxTokens) : null;
  const detailHash = sha256Hex(`${String(step?.type || "")}:${String(detailText || "").trim().slice(0, 160)}`).slice(0, 10);

  let stamp;
  if (kind === "compaction_bust" || kind === "context_shrink") {
    stamp = at
      ? `at:${at}:${safePrev ?? 0}:${safeCurr ?? 0}`
      : hasExplicitStepIndex
        ? `step:${stepIndex}:${safePrev ?? 0}:${safeCurr ?? 0}`
        : `sig:shrink:${safePrev ?? 0}:${safeCurr ?? 0}`;
  } else {
    const tag = kind === "slash_compact" ? "cmd" : "exp";
    stamp = at
      ? `${tag}:at:${at}:${detailHash}`
      : hasExplicitStepIndex
        ? `${tag}:step:${stepIndex}:${detailHash}`
        : `${tag}:sig:${safePrev ?? 0}:${detailHash}`;
  }

  return {
    stamp,
    kind,
    stepIndex,
    hasExplicitStepIndex,
    at,
    prevCtxTokens: safePrev,
    currCtxTokens: safeCurr
  };
}

/**
 * Lightweight linear scan over transcript steps extracting the latest compaction/pruning event
 * across all 4 signals (compaction bust, decoupled context shrink / mild prune, explicit
 * compaction/summary step, and `/compact` user input). Matches `analyzeTranscriptCache().latestCompactionEvent`.
 */
export function extractLatestCompactionEvent(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  let latest = null;
  let prevPrimaryCtx = 0;
  let prevSubCtx = 0;
  let seenPrimaryTurn = false;
  let prevModel = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") continue;

    const stepIsSubagent = isSubagentStep(step);
    const refPrevCtx = stepIsSubagent
      ? (!seenPrimaryTurn ? prevSubCtx : 0)
      : prevPrimaryCtx;

    if (step.type === "USER_INPUT") {
      const userText = extractStepText(step.content ?? step.text);
      if ((!stepIsSubagent || !seenPrimaryTurn) && isSlashCompactText(userText)) {
        latest = buildCompactionEvent({
          kind: "slash_compact",
          step,
          index: i,
          prevCtxTokens: refPrevCtx,
          detailText: userText
        });
      }
      continue;
    }

    const isExplicitCompact = detectExplicitCompactionStep(step);
    if (isExplicitCompact && (!stepIsSubagent || !seenPrimaryTurn)) {
      const explicitUsage = step.type === "PLANNER_RESPONSE" ? extractStepTokenUsage(step) : null;
      latest = buildCompactionEvent({
        kind: "explicit_compaction_step",
        step,
        index: i,
        prevCtxTokens: refPrevCtx,
        currCtxTokens: explicitUsage && explicitUsage.contextTokens > 0 ? explicitUsage.contextTokens : null,
        detailText: extractStepText(step.content ?? step.text)
      });
    }

    if (step.type !== "PLANNER_RESPONSE") continue;

    const usage = extractStepTokenUsage(step);
    const ctxTok = usage.contextTokens;
    const model = typeof step.model === "string" ? step.model : "";
    if (ctxTok > 0) {
      if (!stepIsSubagent || !seenPrimaryTurn) {
        if (refPrevCtx > 0) {
          const shrink = detectContextShrink(refPrevCtx, ctxTok);
          if (shrink.shrunk) {
            const isModelSwitch = Boolean(prevModel && model && model !== prevModel);
            const retainedRatio = refPrevCtx > 0 ? usage.cacheReadTokens / refPrevCtx : 1;
            const isBust = retainedRatio < BUST_DROP_RATIO || (refPrevCtx >= 10000 && usage.cacheReadTokens === 0);
            const kind = shrink.severe && isBust && !isModelSwitch ? "compaction_bust" : "context_shrink";
            latest = buildCompactionEvent({
              kind,
              step,
              index: i,
              prevCtxTokens: refPrevCtx,
              currCtxTokens: ctxTok
            });
          }
        }
        if (!stepIsSubagent) {
          prevPrimaryCtx = ctxTok;
          seenPrimaryTurn = true;
        } else {
          prevSubCtx = ctxTok;
        }
      }
      if (model && (!stepIsSubagent || !seenPrimaryTurn)) prevModel = model;
    }
  }

  return latest;
}

/**
 * Fast tail-only compaction scanner for transcript.jsonl (shared by PreInvocation & PreToolUse).
 */
export function inspectTranscriptCompaction(transcriptPath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 131072;
  const minUsageSteps =
    Number.isFinite(Number(options.minUsageSteps)) && Number(options.minUsageSteps) >= 1
      ? Math.floor(Number(options.minUsageSteps))
      : 2;
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  const steps = readTranscriptTail(transcriptPath, maxBytes, { minUsageSteps });
  if (steps.length === 0) return null;
  return extractLatestCompactionEvent(steps);
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
  const historicalTtlByProfile =
    options.historicalTtlByProfile && typeof options.historicalTtlByProfile === "object"
      ? options.historicalTtlByProfile
      : null;
  const optionConvId = typeof options.conversationId === "string" ? options.conversationId.trim() : "";

  const bustsByCause = {
    ttl_idle_expiry: 0,
    model_switch: 0,
    compaction_or_truncation: 0,
    system_injection: 0,
    multimodal_media: 0,
    prefix_drift: 0
  };
  const driftBreakdown = createEmptyDriftBreakdown();
  const recentBusts = [];
  const allTurns = [];
  const turnMeta = [];
  const turnBillingItems = [];
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
  const warmObsByProfile = new Map();
  const coldObsByProfile = new Map();

  const pushProfileObservation = (map, profileId, entry) => {
    let arr = map.get(profileId);
    if (!arr) {
      arr = [];
      map.set(profileId, arr);
    }
    arr.push(entry);
  };

  let prevCtxTokens = 0;
  let prevModel = "";
  let prevPlannerMs = null;
  let mediaLoadedSincePrev = false;
  let systemMsgSincePrev = false;
  let subagentSincePrevUsage = false;
  let missingUsagePlannerSincePrev = false;
  let compactionSincePrevUsage = false;
  let hasSeenPlanner = false;
  let inToolLoop = false;
  let prevTurnTools = [];
  let latestCompactionEvent = null;
  let prevCompactPrimaryCtx = 0;
  let prevCompactSubCtx = 0;
  let prevCompactModel = "";
  let seenPrimaryCompactTurn = false;

  const seenReadSignatures = new Set();

  // Doom-loop & edit<->fail oscillation tracking
  const LOOP_WINDOW_SIZE = 12;
  const recentCallWindow = []; // { fingerprint, label }
  let editEpoch = 0;
  const lastPassCheckEpoch = new Map();
  let pendingEditFiles = new Set();
  const sessionEditedFiles = new Set();
  const fileLastEditEpoch = new Map(); // normPath -> editEpoch
  const fileOscState = new Map(); // normPath -> { label, failCycles, oscCount, seenErrorKinds, bestPassedCount, lastFailEditEpoch, lastFailStep }
  const pendingBgChecks = new Map(); // taskId -> { cmdStr, launchEditEpoch, launchStep, canConverge, filesAtLaunch: Set<string> }
  const deferredBgPasses = new Map(); // launchEditEpoch -> max launchStep of passed checks waiting for same-epoch siblings
  const epochBgFailedStep = new Map(); // launchEditEpoch -> max settlement step index of a real check failure in that epoch
  let checkSeq = 0;
  let latestCheck = null;
  const checkSlots = new Map(); // checkKey -> latest confirmed pass/fail record for that specific check identity
  const checkHistory = []; // bounded chronological check settlements (including stale late background notices)
  const MAX_CHECK_HISTORY = 20;

  const pushCheckHistory = (entry) => {
    if (!entry) return;
    checkHistory.push(entry);
    if (checkHistory.length > MAX_CHECK_HISTORY) {
      checkHistory.splice(0, checkHistory.length - MAX_CHECK_HISTORY);
    }
  };

  const resolveMissingRunChecksFailures = (passEpoch, passStepIndex, passBatchIds = [], passTotalCount = 0) => {
    for (const [k, slot] of Array.from(checkSlots.entries())) {
      if (slot && slot.outcome === "fail" && slot.missingDetails) {
        if ((slot.editEpoch ?? 0) > passEpoch) continue;
        if (slot.editEpoch === passEpoch && (slot.stepIndex ?? -1) >= passStepIndex && passStepIndex >= 0) {
          continue;
        }
        if (!doesBatchPassResolveMissingFailure(passBatchIds, slot, { passTotalCount })) {
          continue;
        }
        checkSlots.delete(k);
      }
    }
  };

  const recordCheckOutcome = ({
    outcome,
    kind = "",
    name = "",
    command = "",
    exitCode = null,
    body = "",
    files = [],
    editEpoch: recEpoch = editEpoch,
    stepIndex = -1,
    launchStep = -1,
    at = null,
    missingDetails = false,
    missingFailureCount = 0,
    summaryHeader = "",
    batchKeys = null,
    batchIdentities = null,
    batchCommands = null,
    batchTotalCount = 0,
    batchNames = null
  }) => {
    if (outcome !== "pass" && outcome !== "fail" && outcome !== "timeout") return;
    checkSeq += 1;
    const safeKind = kind || classifyCheckKind(name, command);
    const safeName = missingDetails && !name && !command
      ? (summaryHeader || "run_checks")
      : formatCheckDisplayName(name, command);
    const cleanCmd = String(command || "").trim().slice(0, 140);
    const cleanFiles = Array.from(new Set(files || []))
      .filter(Boolean)
      .map((f) => shortTargetLabel(f, 48))
      .slice(0, 3);
    const effectiveLaunchStep = launchStep >= 0 ? launchStep : stepIndex;
    const identity = extractCheckIdentity(safeKind, name, cleanCmd, { missingDetails, batchKeys });
    const cleanBatchNames = Array.isArray(batchNames)
      ? Array.from(new Set(batchNames.map((n) => String(n || "").replace(/\s+/g, " ").trim()).filter(Boolean))).slice(0, 4)
      : [];

    if (outcome === "timeout") {
      const rec = {
        outcome: "timeout",
        kind: safeKind,
        checkKey: identity.checkKey,
        name: safeName,
        command: cleanCmd,
        exitCode: exitCode === 124 ? 124 : null,
        firstErrorLine: "",
        errorExcerpt: "",
        missingDetails: false,
        missingFailureCount: 0,
        summaryHeader: "",
        files: cleanFiles,
        editEpoch: recEpoch,
        launchStep: effectiveLaunchStep,
        stepIndex,
        seq: checkSeq,
        at: at || null
      };
      latestCheck = rec;
      pushCheckHistory({ ...rec, stale: false, staleReason: null });
      return;
    }
    if (outcome === "fail") {
      const { firstErrorLine, errorExcerpt } = missingDetails
        ? { firstErrorLine: "", errorExcerpt: "" }
        : extractCheckErrorDetails(body);
      const rec = {
        outcome: "fail",
        kind: safeKind,
        checkKey: identity.checkKey,
        _identity: identity,
        ...(missingDetails && Array.isArray(batchIdentities) && batchIdentities.length > 0
          ? { _batchIdentities: batchIdentities }
          : {}),
        name: safeName,
        command: cleanCmd,
        exitCode: missingDetails
          ? null
          : typeof exitCode === "number" && exitCode > 0
            ? exitCode
            : 1,
        firstErrorLine,
        errorExcerpt,
        missingDetails: Boolean(missingDetails),
        missingFailureCount: missingDetails ? Math.max(1, Number(missingFailureCount) || 1) : 0,
        ...(missingDetails && Array.isArray(identity.batchKeys) && identity.batchKeys.length > 0
          ? { batchKeys: identity.batchKeys.slice(0, 12) }
          : {}),
        ...(missingDetails && Array.isArray(batchCommands) && batchCommands.length > 0
          ? { batchCommands: batchCommands.slice(0, 10) }
          : {}),
        ...(missingDetails && Number(batchTotalCount || 0) > 0
          ? { batchTotalCount: Number(batchTotalCount) }
          : {}),
        summaryHeader: typeof summaryHeader === "string" ? summaryHeader.trim().slice(0, 140) : "",
        files: cleanFiles,
        editEpoch: recEpoch,
        launchStep: effectiveLaunchStep,
        stepIndex,
        seq: checkSeq,
        at: at || null
      };
      checkSlots.set(identity.checkKey, rec);
      latestCheck = rec;
      pushCheckHistory({ ...rec, _identity: undefined, _batchIdentities: undefined, stale: false, staleReason: null });
      return;
    }
    // outcome === "pass"
    const prevSameSlot = checkSlots.get(identity.checkKey);
    if (prevSameSlot && prevSameSlot.outcome === "fail") {
      if ((prevSameSlot.editEpoch ?? 0) > recEpoch) return;
      if (prevSameSlot.editEpoch === recEpoch && (prevSameSlot.stepIndex ?? -1) >= stepIndex && stepIndex >= 0) {
        return;
      }
    }
    for (const [slotKey, slot] of Array.from(checkSlots.entries())) {
      if (!slot || slot.outcome !== "fail") continue;
      const failId = slot._identity || extractCheckIdentity(slot.kind, slot.name, slot.command, { missingDetails: slot.missingDetails });
      if (!doesPassResolveFailure(identity, failId)) continue;
      if ((slot.editEpoch ?? 0) > recEpoch) continue;
      if (slot.editEpoch === recEpoch && (slot.stepIndex ?? -1) >= stepIndex && stepIndex >= 0) {
        continue;
      }
      checkSlots.delete(slotKey);
    }
    const rec = {
      outcome: "pass",
      kind: safeKind,
      checkKey: identity.checkKey,
      _identity: identity,
      name: safeName,
      command: cleanCmd,
      ...(cleanBatchNames.length > 1 ? { batchNames: cleanBatchNames } : {}),
      exitCode: 0,
      firstErrorLine: "",
      errorExcerpt: "",
      missingDetails: false,
      missingFailureCount: 0,
      summaryHeader: "",
      files: cleanFiles,
      editEpoch: recEpoch,
      launchStep: effectiveLaunchStep,
      stepIndex,
      seq: checkSeq,
      at: at || null
    };
    checkSlots.set(identity.checkKey, rec);
    if (
      !(latestCheck && latestCheck.outcome === "fail" && latestCheck.stepIndex === stepIndex && stepIndex >= 0) &&
      !(latestCheck && (latestCheck.editEpoch ?? 0) > recEpoch)
    ) {
      latestCheck = rec;
    }
    pushCheckHistory({ ...rec, _identity: undefined, _batchIdentities: undefined, stale: false, staleReason: null });
  };

  const recordFileFailureCycle = (filesIterable, failedResults, failEditEpoch = editEpoch, failStep = -1) => {
    const uniqueFiles = Array.from(new Set(filesIterable)).filter(Boolean);
    if (uniqueFiles.length === 0) return;
    if (failStep >= 0) {
      epochBgFailedStep.set(failEditEpoch, Math.max(epochBgFailedStep.get(failEditEpoch) ?? -1, failStep));
      deferredBgPasses.delete(failEditEpoch);
    }
    const { errorKind, passedCount } = extractFailureProfile(failedResults);
    for (const f of uniqueFiles) {
      let st = fileOscState.get(f);
      if (!st) {
        st = {
          label: shortTargetLabel(f, 36),
          failCycles: 1,
          oscCount: 1,
          seenErrorKinds: new Set(errorKind !== "generic" ? [errorKind] : []),
          bestPassedCount: passedCount !== null ? passedCount : 0,
          lastFailEditEpoch: failEditEpoch,
          lastFailStep: failStep
        };
        fileOscState.set(f, st);
        continue;
      }
      st.failCycles += 1;
      st.lastFailEditEpoch = Math.max(st.lastFailEditEpoch ?? 0, failEditEpoch);
      st.lastFailStep = Math.max(st.lastFailStep ?? -1, failStep);
      const passedImproved = passedCount !== null && passedCount > st.bestPassedCount;
      const isNewSpecificError = errorKind !== "generic" && !st.seenErrorKinds.has(errorKind);
      if (passedCount !== null && passedCount > st.bestPassedCount) {
        st.bestPassedCount = passedCount;
      }
      if (errorKind !== "generic") {
        st.seenErrorKinds.add(errorKind);
      }
      if (passedImproved) {
        // Test pass count strictly improved -> forward convergence
      } else if (isNewSpecificError && st.failCycles < 4) {
        // Progressed past prior error class into a distinct new failure stage
      } else {
        st.oscCount += 1;
      }
    }
  };

  const hasSiblingBgCheckForEpoch = (epoch) => {
    const failMark = epochBgFailedStep.get(epoch) ?? -1;
    for (const other of pendingBgChecks.values()) {
      if (other.canConverge && other.launchEditEpoch === epoch && other.launchStep > failMark) {
        return true;
      }
    }
    return false;
  };

  const applyBgPassToState = (launchEditEpoch, launchStep) => {
    if (launchStep <= (epochBgFailedStep.get(launchEditEpoch) ?? -1)) return;
    for (const [f, st] of Array.from(fileOscState.entries())) {
      if (
        (st.lastFailEditEpoch ?? 0) <= launchEditEpoch &&
        (st.lastFailStep ?? -1) < launchStep
      ) {
        fileOscState.delete(f);
      }
    }
    for (const f of Array.from(pendingEditFiles)) {
      if ((fileLastEditEpoch.get(f) ?? 0) <= launchEditEpoch) {
        pendingEditFiles.delete(f);
      }
    }
  };

  const flushDeferredBgPassIfReady = (epoch) => {
    if (hasSiblingBgCheckForEpoch(epoch)) return;
    if (!deferredBgPasses.has(epoch)) return;
    const passLaunchStep = deferredBgPasses.get(epoch);
    deferredBgPasses.delete(epoch);
    applyBgPassToState(epoch, passLaunchStep);
  };

  const findCoveringNewerSlot = (taskIdentity, launchEditEpoch, launchStep) => {
    let broaderReason = null;
    for (const slot of checkSlots.values()) {
      if (!slot) continue;
      const slotEpoch = slot.editEpoch ?? 0;
      const slotLaunchStep = slot.launchStep ?? slot.stepIndex ?? -1;
      const isNewer =
        slotEpoch > launchEditEpoch ||
        (slotEpoch === launchEditEpoch && slotLaunchStep > launchStep);
      if (!isNewer) continue;
      if (slot.checkKey === taskIdentity.checkKey) {
        return "superseded_same_check";
      }
      if (slot.outcome === "pass") {
        const slotId =
          slot._identity ||
          extractCheckIdentity(slot.kind, slot.name, slot.command, { missingDetails: slot.missingDetails });
        if (doesPassResolveFailure(slotId, taskIdentity)) {
          broaderReason = "superseded_by_newer_check";
        }
      }
    }
    return broaderReason;
  };

  const settleBackgroundCheck = (taskId, outcome, exitCode, bodyText, currentStepIdx = -1, stepAt = null) => {
    if (!taskId || !pendingBgChecks.has(taskId)) return;
    const task = pendingBgChecks.get(taskId);
    pendingBgChecks.delete(taskId);
    const taskKind = classifyCheckKind("", task.cmdStr);
    const taskName = formatCheckDisplayName("", task.cmdStr);
    const taskIdentity = extractCheckIdentity(taskKind, taskName, task.cmdStr);
    const cleanTaskFiles = Array.from(new Set(task.filesAtLaunch || []))
      .filter(Boolean)
      .map((f) => shortTargetLabel(f, 48))
      .slice(0, 3);
    const settleStepMark = currentStepIdx >= 0 ? currentStepIdx : task.launchStep;

    const coveringStaleReason = findCoveringNewerSlot(taskIdentity, task.launchEditEpoch, task.launchStep);
    const isOlderEpochThanLatestCheck = Boolean(
      latestCheck && task.launchEditEpoch < (latestCheck.editEpoch ?? 0)
    );
    const timeoutStaleReason =
      coveringStaleReason ||
      (isOlderEpochThanLatestCheck && latestCheck?.outcome === "fail" ? "superseded_by_newer_check" : null);

    if (outcome === "canceled") {
      if (task.canConverge) {
        flushDeferredBgPassIfReady(task.launchEditEpoch);
      }
      return;
    }
    if (outcome === "timeout") {
      if (timeoutStaleReason) {
        checkSeq += 1;
        pushCheckHistory({
          outcome: "timeout",
          kind: taskKind,
          checkKey: taskIdentity.checkKey,
          name: taskName,
          command: String(task.cmdStr || "").trim().slice(0, 140),
          exitCode: exitCode === 124 ? 124 : null,
          firstErrorLine: "",
          errorExcerpt: "",
          missingDetails: false,
          missingFailureCount: 0,
          summaryHeader: "",
          files: cleanTaskFiles,
          editEpoch: task.launchEditEpoch,
          launchStep: task.launchStep,
          stepIndex: settleStepMark,
          seq: checkSeq,
          at: stepAt || null,
          stale: true,
          staleReason: timeoutStaleReason
        });
        if (task.canConverge) {
          flushDeferredBgPassIfReady(task.launchEditEpoch);
        }
        return;
      }
      recordCheckOutcome({
        outcome: "timeout",
        kind: taskKind,
        name: taskName,
        command: task.cmdStr,
        exitCode,
        body: bodyText,
        files: task.filesAtLaunch,
        editEpoch: task.launchEditEpoch,
        launchStep: task.launchStep,
        stepIndex: settleStepMark,
        at: stepAt
      });
      return;
    }
    if (outcome === "pass") {
      if (!task.canConverge) return;
      if (coveringStaleReason) {
        checkSeq += 1;
        pushCheckHistory({
          outcome: "pass",
          kind: taskKind,
          checkKey: taskIdentity.checkKey,
          name: taskName,
          command: String(task.cmdStr || "").trim().slice(0, 140),
          exitCode: 0,
          firstErrorLine: "",
          errorExcerpt: "",
          missingDetails: false,
          missingFailureCount: 0,
          summaryHeader: "",
          files: cleanTaskFiles,
          editEpoch: task.launchEditEpoch,
          launchStep: task.launchStep,
          stepIndex: settleStepMark,
          seq: checkSeq,
          at: stepAt || null,
          stale: true,
          staleReason: coveringStaleReason
        });
        return;
      }
      recordCheckOutcome({
        outcome: "pass",
        kind: taskKind,
        name: taskName,
        command: task.cmdStr,
        exitCode: 0,
        body: bodyText,
        files: task.filesAtLaunch,
        editEpoch: task.launchEditEpoch,
        launchStep: task.launchStep,
        stepIndex: task.launchStep,
        at: stepAt
      });
      if (task.launchStep <= (epochBgFailedStep.get(task.launchEditEpoch) ?? -1)) {
        flushDeferredBgPassIfReady(task.launchEditEpoch);
        return;
      }
      if (hasSiblingBgCheckForEpoch(task.launchEditEpoch)) {
        const prev = deferredBgPasses.get(task.launchEditEpoch) ?? -1;
        deferredBgPasses.set(task.launchEditEpoch, Math.max(prev, task.launchStep));
        return;
      }
      const prevDeferred = deferredBgPasses.get(task.launchEditEpoch) ?? -1;
      deferredBgPasses.delete(task.launchEditEpoch);
      applyBgPassToState(task.launchEditEpoch, Math.max(task.launchStep, prevDeferred));
      return;
    }
    if (outcome === "fail") {
      if (isZeroMatchFilterExit(task.cmdStr, bodyText, exitCode)) {
        if (task.canConverge) {
          flushDeferredBgPassIfReady(task.launchEditEpoch);
        }
        return;
      }
      // A real failure for this snapshot poisons any concurrent sibling pass for the same editEpoch
      const failStepMark = settleStepMark;
      if (coveringStaleReason) {
        const { firstErrorLine, errorExcerpt } = extractCheckErrorDetails(bodyText);
        checkSeq += 1;
        pushCheckHistory({
          outcome: "fail",
          kind: taskKind,
          checkKey: taskIdentity.checkKey,
          name: taskName,
          command: String(task.cmdStr || "").trim().slice(0, 140),
          exitCode: typeof exitCode === "number" && exitCode > 0 ? exitCode : 1,
          firstErrorLine,
          errorExcerpt,
          missingDetails: false,
          missingFailureCount: 0,
          summaryHeader: "",
          files: cleanTaskFiles,
          editEpoch: task.launchEditEpoch,
          launchStep: task.launchStep,
          stepIndex: failStepMark,
          seq: checkSeq,
          at: stepAt || null,
          stale: true,
          staleReason: coveringStaleReason
        });
      } else {
        recordCheckOutcome({
          outcome: "fail",
          kind: taskKind,
          name: taskName,
          command: task.cmdStr,
          exitCode,
          body: bodyText,
          files: task.filesAtLaunch,
          editEpoch: task.launchEditEpoch,
          launchStep: task.launchStep,
          stepIndex: failStepMark,
          at: stepAt
        });
      }
      epochBgFailedStep.set(
        task.launchEditEpoch,
        Math.max(epochBgFailedStep.get(task.launchEditEpoch) ?? -1, failStepMark)
      );
      deferredBgPasses.delete(task.launchEditEpoch);
      const stillTracked = Array.from(task.filesAtLaunch).filter(
        (f) => pendingEditFiles.has(f) && (fileLastEditEpoch.get(f) ?? 0) <= task.launchEditEpoch
      );
      if (stillTracked.length > 0) {
        recordFileFailureCycle(
          stillTracked,
          [{ content: bodyText || "", exit_code: exitCode ?? 1, status: "ERROR" }],
          task.launchEditEpoch,
          failStepMark
        );
        for (const f of stillTracked) {
          if ((fileLastEditEpoch.get(f) ?? 0) <= task.launchEditEpoch) {
            pendingEditFiles.delete(f);
          }
        }
      }
    }
  };

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
    const stepIsSubagentType = SUBAGENT_STEP_TYPE_RE.test(String(step.type || ""));
    if ((stepIsSubagent || stepIsSubagentType) && turnMeta.length > 0 && step.type !== "PLANNER_RESPONSE") {
      subagentSincePrevUsage = true;
    }

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
      const userText = extractStepText(step.content ?? step.text);
      const userMeasure = estimateTextTokens(userText);
      compRaw.user.bytes += userMeasure.bytes;
      compRaw.user.estTokens += userMeasure.estTokens;
      if (stepIsSubagent) {
        subRaw.subagentResultBytes += userMeasure.bytes;
        subRaw.subagentResultEstTokens += userMeasure.estTokens;
        subRaw.subagentTrafficEstTokens += userMeasure.estTokens;
      }
      // New user turn starts: clear previous turn's tool attribution so user prompt growth isn't misattributed
      if (!stepIsSubagent) {
        inToolLoop = false;
      }
      if (turnMeta.length > 0 && isSlashCompactText(userText)) {
        compactionSincePrevUsage = true;
      }
      if ((!stepIsSubagent || !seenPrimaryCompactTurn) && isSlashCompactText(userText)) {
        const refPrevUserCompact = stepIsSubagent ? prevCompactSubCtx : prevCompactPrimaryCtx;
        seenReadSignatures.clear();
        latestCompactionEvent = buildCompactionEvent({
          kind: "slash_compact",
          step,
          index: i,
          prevCtxTokens: refPrevUserCompact,
          detailText: userText
        });
      }
      prevTurnTools = [];
      pendingToolCalls = [];
      pendingCallCursor = 0;
      pendingCallsById.clear();
      continue;
    }

    const isExplicitCompactStep = detectExplicitCompactionStep(step);
    if (turnMeta.length > 0 && isExplicitCompactStep) {
      compactionSincePrevUsage = true;
    }
    if (isExplicitCompactStep && (!stepIsSubagent || !seenPrimaryCompactTurn)) {
      const refPrevCompactCtx = stepIsSubagent ? prevCompactSubCtx : prevCompactPrimaryCtx;
      const explicitUsage = step.type === "PLANNER_RESPONSE" ? extractStepTokenUsage(step) : null;
      seenReadSignatures.clear();
      latestCompactionEvent = buildCompactionEvent({
        kind: "explicit_compaction_step",
        step,
        index: i,
        prevCtxTokens: refPrevCompactCtx,
        currCtxTokens: explicitUsage && explicitUsage.contextTokens > 0 ? explicitUsage.contextTokens : null,
        detailText: extractStepText(step.content ?? step.text)
      });
    }

    if (step.type === "SYSTEM_MESSAGE") {
      const msgText = extractStepText(step.content ?? step.text).trim();
      if (hasSeenPlanner) {
        if (msgText.length > 0 && !TTL_KEEPALIVE_STEP_RE.test(msgText)) {
          systemMsgSincePrev = true;
        }
      }
      if (!stepIsSubagent && msgText.length > 0 && pendingBgChecks.size > 0) {
        const bgCompletions = parseBackgroundTaskCompletions(msgText);
        for (const bgDone of bgCompletions) {
          if (bgDone && pendingBgChecks.has(bgDone.taskId)) {
            settleBackgroundCheck(bgDone.taskId, bgDone.outcome, bgDone.exitCode, bgDone.body, i, step.created_at || null);
          }
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
      if (
        !stepIsSubagent &&
        (step.aborted === true ||
          step.cancelled === true ||
          step.canceled === true ||
          /^(?:CANCELLED|CANCELED|ABORTED|TURN_ABORTED|TURN_END|USER_CANCEL)$/i.test(String(step.type || "")))
      ) {
        inToolLoop = false;
      }
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
    const turnUsage = extractStepTokenUsage(step);
    const refPrevCompactCtx = stepIsSubagent
      ? (!seenPrimaryCompactTurn ? prevCompactSubCtx : 0)
      : prevCompactPrimaryCtx;
    const turnShrink =
      (!stepIsSubagent || !seenPrimaryCompactTurn) && refPrevCompactCtx > 0 && turnUsage.contextTokens > 0
        ? detectContextShrink(refPrevCompactCtx, turnUsage.contextTokens)
        : { shrunk: false, severe: false };
    if (turnShrink.shrunk) {
      seenReadSignatures.clear();
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
    let turnRanSyncCheck = false;
    const callBareTools = [];
    const callInfoList = [];
    const callInfoById = new Map();
    const turnLaunchedBgChecks = [];
    const resultByCallId = new Map();
    const bareToolByCallId = new Map();
    for (const r of followingResults) {
      const rid = r?.tool_call_id ?? r?.call_id ?? r?.toolCallId ?? null;
      if (rid !== null && rid !== undefined && String(rid).trim() !== "") {
        resultByCallId.set(String(rid), r);
      }
    }
    const isStepLevelAborted =
      step.aborted === true ||
      step.cancelled === true ||
      step.canceled === true ||
      /^(?:cancelled|canceled|aborted|interrupted)$/i.test(
        String(step.stop_reason ?? step.stopReason ?? step.status ?? "")
      );
    const allFollowingCanceled =
      followingResults.length > 0 && followingResults.every((r) => isStepCanceledResult(r));
    const isTurnAborted = isStepLevelAborted || allFollowingCanceled;

    // Pre-collect non-canceled edited project paths & metadata for this turn so parallel tool_calls
    // (e.g. run_checks ordered before edit_file) share one consistent candidate set and editEpoch.
    const preparedCalls = [];
    if (Array.isArray(step.tool_calls)) {
      for (let callIdx = 0; callIdx < step.tool_calls.length; callIdx++) {
        const call = step.tool_calls[callIdx];
        const name = call?.name || "";
        const args = getCallArgs(call);
        const eff = unwrapEffectiveTool(call);
        const desc = describeToolCall(call);
        const callId = call?.id ?? call?.tool_call_id ?? call?.call_id ?? null;
        const callIdKey = callId !== null && callId !== undefined && String(callId).trim() !== "" ? String(callId) : null;
        const isCheckCall = isCheckOrVerifyCall(call);
        const isRunChecks = desc.bareTool === "run_checks" || /(?:^|_)run_checks$/.test(desc.bareTool);
        const isManageTask = desc.bareTool === "manage_task" || /(?:^|_)manage_task$/.test(desc.bareTool);
        const cmdStr =
          desc.bareTool === "run_command"
            ? unwrapQuotedWrapperArg(String(eff.args?.CommandLine ?? eff.args?.commandLine ?? eff.args?.command ?? ""))
            : "";
        const verifyCmdStr =
          desc.bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(desc.bareTool)
            ? unwrapQuotedWrapperArg(
                typeof eff.args?.verify === "string"
                  ? eff.args.verify
                  : String(eff.args?.verify?.command ?? "")
              )
            : "";
        const isDaemon = isTruthyBooleanArg(eff.args?.IsDaemon ?? eff.args?.isDaemon);
        const matchedResult = (callIdKey && resultByCallId.get(callIdKey)) || followingResults[callIdx];
        const callCanceled = matchedResult ? isStepCanceledResult(matchedResult) : false;
        const callIsBgLaunch = matchedResult ? isStepBackgroundLaunchResult(matchedResult, desc.bareTool) : false;
        const callIsZeroMatchFilter =
          !callIsBgLaunch &&
          desc.bareTool === "run_command" &&
          Boolean(matchedResult) &&
          isZeroMatchFilterExit(
            cmdStr,
            typeof matchedResult.content === "string" ? matchedResult.content : "",
            matchedResult.exit_code ?? matchedResult.exitCode
          );
        const edited = extractCallEditPaths(call, options);
        if (!stepIsSubagent && !isTurnAborted && !callCanceled && edited.length > 0) {
          for (const ep of edited) {
            turnEditedFiles.push(ep);
            sessionEditedFiles.add(ep);
          }
          const editCallFailed =
            !matchedResult || callIsBgLaunch ? false : isStepFailureResult(matchedResult, desc.bareTool);
          if (!editCallFailed) editEpoch += 1;
        }
        preparedCalls.push({
          call,
          name,
          args,
          eff,
          desc,
          callIdKey,
          isCheckCall,
          isRunChecks,
          isManageTask,
          cmdStr,
          verifyCmdStr,
          isDaemon,
          matchedResult,
          callCanceled,
          callIsBgLaunch,
          callIsZeroMatchFilter,
          edited
        });
      }
      if (!stepIsSubagent && !isTurnAborted && turnEditedFiles.length > 0) {
        for (const ep of turnEditedFiles) {
          fileLastEditEpoch.set(ep, editEpoch);
        }
      }
    }

    const staticCandidateFiles = !stepIsSubagent && !isTurnAborted
      ? new Set([...turnEditedFiles, ...pendingEditFiles, ...fileOscState.keys(), ...sessionEditedFiles])
      : null;

    // Track duplicate read_file / view_file calls, edit invalidations, loop fingerprints & edit<->fail oscillations
    if (preparedCalls.length > 0) {
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
        subRaw.subagentToolCalls += preparedCalls.length;
      } else {
        subRaw.primaryToolCalls += preparedCalls.length;
      }

      for (let callIdx = 0; callIdx < preparedCalls.length; callIdx++) {
        const {
          call,
          name,
          args,
          eff,
          desc,
          callIdKey,
          isCheckCall,
          isRunChecks,
          isManageTask,
          cmdStr,
          verifyCmdStr,
          isDaemon,
          matchedResult,
          callCanceled,
          callIsBgLaunch,
          callIsZeroMatchFilter
        } = preparedCalls[callIdx];
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
        const runChecksEval =
          isRunChecks && matchedResult && !callCanceled && !callIsBgLaunch
            ? evaluateRunChecksResult(
                typeof matchedResult.content === "string" ? matchedResult.content : "",
                staticCandidateFiles
              )
            : null;
        const callInfo = {
          bareTool: desc.bareTool,
          args: eff.args,
          cmdStr,
          verifyCmdStr,
          isDaemon,
          isCheckCall,
          isRunChecks,
          isManageTask,
          matchedResult,
          runChecksEval
        };
        callInfoList.push(callInfo);
        if (callIdKey) {
          pendingCallsById.set(callIdKey, callMeta);
          bareToolByCallId.set(callIdKey, desc.bareTool);
          callInfoById.set(callIdKey, callInfo);
        }
        const callFailed =
          !matchedResult || callCanceled || callIsBgLaunch || callIsZeroMatchFilter
            ? false
            : runChecksEval && runChecksEval.recognized
              ? runChecksEval.outcome === "fail"
              : isStepFailureResult(matchedResult, desc.bareTool);
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

        if (!stepIsSubagent && !isTurnAborted && !callCanceled) {
          if (isCheckCall) {
            if (callIsBgLaunch) {
              if (!isDaemon) {
                const bgTaskId = extractBackgroundTaskIdFromLaunch(matchedResult);
                if (bgTaskId) {
                  turnLaunchedBgChecks.push({ taskId: bgTaskId, cmdStr });
                }
              }
            } else if (!callIsZeroMatchFilter && !(runChecksEval && runChecksEval.recognized && runChecksEval.outcome === "neutral")) {
              turnRanSyncCheck = true;
            }
          }
          if (isManageTask && matchedResult) {
            const mtAction = unwrapQuotedWrapperArg(String(eff.args?.Action ?? eff.args?.action ?? "")).toLowerCase();
            const mtTaskId = unwrapQuotedWrapperArg(String(eff.args?.TaskId ?? eff.args?.taskId ?? ""));
            if (mtAction === "kill" && mtTaskId) {
              settleBackgroundCheck(mtTaskId, "canceled", null, "", i, step.created_at || null);
            } else if (mtAction === "status" && mtTaskId && pendingBgChecks.has(mtTaskId)) {
              const mtText = typeof matchedResult.content === "string" ? matchedResult.content : "";
              const { headerPart: mtHeader, outputPart: mtRawBody, hasOutputSection } = splitHarnessHeaderAndOutput(mtText);
              const mtClassified = classifyCheckCompletionOutcome({
                rawText: mtText,
                headerPart: mtHeader,
                outputPart: mtRawBody,
                hasOutputSection
              });
              if (mtClassified) {
                settleBackgroundCheck(
                  mtTaskId,
                  mtClassified.outcome,
                  mtClassified.exitCode,
                  mtClassified.body,
                  i,
                  step.created_at || null
                );
              }
            }
          }
        }

        if (!stepIsSubagent && !isTurnAborted && !callCanceled && !IGNORED_LOOP_TOOLS.has(desc.bareTool)) {
          let effectiveFp = desc.fingerprint;
          // Passing verification (or benign 0-match filter check) after a fresh edit is healthy TDD progress, not a doom loop
          if (
            isCheckCall &&
            Boolean(matchedResult) &&
            !callFailed &&
            !callIsBgLaunch &&
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
          const mcpTool = unwrapQuotedWrapperArg(String(args.ToolName ?? args.toolName ?? ""));
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

    // Update edit<->fail oscillation state and active tool-loop state from primary conversation turns only
    if (!stepIsSubagent) {
      const hasActiveToolCalls = callBareTools.some((t) => t && t !== "finish");
      inToolLoop = !isTurnAborted && (hasActiveToolCalls || followingResults.length > 0);
      if (!isTurnAborted) {
        const failedResults = [];
        const turnCheckEvents = [];
        let turnTimedOutOnly = false;
        let turnHasConvergingPass = false;
        for (let rIdx = 0; rIdx < followingResults.length; rIdx++) {
          const r = followingResults[rIdx];
          const rid = r?.tool_call_id ?? r?.call_id ?? r?.toolCallId ?? null;
          const info =
            (rid !== null && rid !== undefined && callInfoById.get(String(rid))) || callInfoList[rIdx] || null;
          const bareTool =
            (rid !== null && rid !== undefined && bareToolByCallId.get(String(rid))) ||
            info?.bareTool ||
            callBareTools[rIdx] ||
            "";
          if (isStepCanceledResult(r) || isStepBackgroundLaunchResult(r, bareTool)) {
            continue;
          }
          const rText = typeof r?.content === "string" ? r.content : "";
          if (info?.isRunChecks) {
            const rc =
              info.runChecksEval && info.matchedResult === r
                ? info.runChecksEval
                : evaluateRunChecksResult(rText, staticCandidateFiles);
            if (rc.recognized) {
              const batchMeta = extractBatchCheckIdentities(info.args?.commands, rc.blockResults || []);
              const batchTotalCount = Number(rc.headerTotalCount || batchMeta.identities.length || 0);
              const passedBatchNames =
                rc.outcome === "pass" && Array.isArray(rc.blockResults)
                  ? rc.blockResults
                      .filter((b) => b && b.outcome === "pass")
                      .map((b) => b.name || formatCheckDisplayName("", b.cmd))
                      .filter(Boolean)
                  : [];
              if (Array.isArray(rc.blockResults)) {
                for (let bIdx = 0; bIdx < rc.blockResults.length; bIdx++) {
                  const blk = rc.blockResults[bIdx];
                  const isLastCleanPass =
                    rc.outcome === "pass" &&
                    blk.outcome === "pass" &&
                    passedBatchNames.length > 1 &&
                    bIdx === rc.blockResults.length - 1;
                  turnCheckEvents.push({
                    outcome: blk.outcome,
                    kind: blk.kind,
                    name: blk.name,
                    command: blk.cmd,
                    exitCode: blk.exitCode,
                    body: blk.body,
                    missingDetails: Boolean(blk.missingDetails),
                    missingFailureCount: Number(blk.missingFailureCount || 0),
                    summaryHeader: blk.summaryHeader || "",
                    ...(blk.missingDetails
                      ? {
                          batchKeys: batchMeta.batchKeys,
                          batchIdentities: batchMeta.identities,
                          batchCommands: batchMeta.batchCommands,
                          batchTotalCount
                        }
                      : {}),
                    ...(isLastCleanPass ? { batchNames: passedBatchNames } : {})
                  });
                }
              }
              if (rc.outcome === "fail") {
                failedResults.push({ ...r, content: rc.profileContent || rText });
              } else if (rc.outcome === "timeout_only") {
                turnTimedOutOnly = true;
              } else if (rc.outcome === "pass") {
                turnHasConvergingPass = true;
                if ((rc.headerFailedCount ?? 0) === 0) {
                  resolveMissingRunChecksFailures(editEpoch, i, batchMeta.identities, batchTotalCount);
                }
              }
              continue;
            }
          }
          if (bareTool === "run_command" && info?.cmdStr) {
            if (isZeroMatchFilterExit(info.cmdStr, rText, r?.exit_code ?? r?.exitCode)) {
              continue;
            }
          }
          const isApplyEditsCall = bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool);
          const checkCmdForEvent =
            bareTool === "run_command"
              ? info?.cmdStr || ""
              : isApplyEditsCall
                ? info?.verifyCmdStr || ""
                : "";
          const checkCode =
            typeof (r?.exit_code ?? r?.exitCode) === "number"
              ? (r?.exit_code ?? r?.exitCode)
              : extractHarnessExitCode(rText);
          if (isStepFailureResult(r, bareTool)) {
            failedResults.push(r);
            if (info?.isCheckCall) {
              turnCheckEvents.push({
                outcome: "fail",
                kind: classifyCheckKind("", checkCmdForEvent),
                name: formatCheckDisplayName("", checkCmdForEvent),
                command: checkCmdForEvent,
                exitCode: typeof checkCode === "number" && checkCode > 0 ? checkCode : 1,
                body: rText
              });
            }
          } else if (isStepTimeoutOnlyResult(r, bareTool)) {
            turnTimedOutOnly = true;
            if (info?.isCheckCall) {
              turnCheckEvents.push({
                outcome: "timeout",
                kind: classifyCheckKind("", checkCmdForEvent),
                name: formatCheckDisplayName("", checkCmdForEvent),
                command: checkCmdForEvent,
                exitCode: checkCode === 124 ? 124 : null,
                body: rText
              });
            }
          } else if (info?.isCheckCall) {
            if (bareTool === "run_command") {
              if (isConvergingVerifyCommand(info.cmdStr)) {
                turnHasConvergingPass = true;
                turnCheckEvents.push({
                  outcome: "pass",
                  kind: classifyCheckKind("", info.cmdStr),
                  name: formatCheckDisplayName("", info.cmdStr),
                  command: info.cmdStr,
                  exitCode: 0,
                  body: rText
                });
              }
            } else if (isApplyEditsCall) {
              if (!info.verifyCmdStr || !isNonConvergingPassCommand(info.verifyCmdStr)) {
                turnHasConvergingPass = true;
                if (info.verifyCmdStr) {
                  turnCheckEvents.push({
                    outcome: "pass",
                    kind: classifyCheckKind("", info.verifyCmdStr),
                    name: formatCheckDisplayName("", info.verifyCmdStr),
                    command: info.verifyCmdStr,
                    exitCode: 0,
                    body: rText
                  });
                }
              }
            } else {
              turnHasConvergingPass = true;
            }
          }
        }
        if (turnCheckEvents.length > 0) {
          const eventOrder = { pass: 0, timeout: 1, fail: 2 };
          turnCheckEvents.sort((a, b) => (eventOrder[a.outcome] ?? 0) - (eventOrder[b.outcome] ?? 0));
          const eventFiles = turnEditedFiles.length > 0 ? turnEditedFiles : Array.from(pendingEditFiles);
          for (const ev of turnCheckEvents) {
            recordCheckOutcome({
              outcome: ev.outcome,
              kind: ev.kind,
              name: ev.name,
              command: ev.command,
              exitCode: ev.exitCode,
              body: ev.body,
              files: eventFiles,
              editEpoch,
              launchStep: i,
              stepIndex: i,
              at: step.created_at || null,
              missingDetails: Boolean(ev.missingDetails),
              missingFailureCount: Number(ev.missingFailureCount || 0),
              summaryHeader: ev.summaryHeader || "",
              batchKeys: ev.batchKeys || null,
              batchIdentities: ev.batchIdentities || null,
              batchCommands: ev.batchCommands || null,
              batchTotalCount: Number(ev.batchTotalCount || 0),
              batchNames: ev.batchNames || null
            });
          }
        }
        const turnFailed = failedResults.length > 0;
        const turnPassLeavesSameKindFailure =
          turnHasConvergingPass &&
          !turnFailed &&
          !turnTimedOutOnly &&
          turnCheckEvents.length > 0 &&
          turnCheckEvents.every((ev) => ev.outcome === "pass") &&
          Array.from(checkSlots.values()).some((slot) => {
            if (!slot || slot.outcome !== "fail") return false;
            const failId =
              slot._identity ||
              extractCheckIdentity(slot.kind, slot.name, slot.command, { missingDetails: slot.missingDetails });
            if (failId.isBroad) return false;
            return turnCheckEvents.some((ev) => {
              const passId = extractCheckIdentity(ev.kind, ev.name, ev.command);
              return (
                !passId.isBroad &&
                passId.kind === slot.kind &&
                (passId.tool !== "pkg-test" || (Array.isArray(passId.filters) && passId.filters.length > 0))
              );
            });
          });
        if (turnLaunchedBgChecks.length > 0) {
          const filesAtLaunch = new Set([...pendingEditFiles, ...turnEditedFiles]);
          for (const bg of turnLaunchedBgChecks) {
            pendingBgChecks.set(bg.taskId, {
              cmdStr: bg.cmdStr,
              launchEditEpoch: editEpoch,
              launchStep: i,
              canConverge: isConvergingVerifyCommand(bg.cmdStr),
              filesAtLaunch: new Set(filesAtLaunch)
            });
          }
        }
        if (turnEditedFiles.length > 0 && turnFailed) {
          recordFileFailureCycle(turnEditedFiles, failedResults, editEpoch, i);
          pendingEditFiles.clear();
        } else if (
          turnEditedFiles.length > 0 &&
          turnHasConvergingPass &&
          !turnFailed &&
          !turnTimedOutOnly &&
          !turnPassLeavesSameKindFailure &&
          followingResults.length > 0
        ) {
          if (hasSiblingBgCheckForEpoch(editEpoch)) {
            for (const f of turnEditedFiles) {
              pendingEditFiles.add(f);
              fileLastEditEpoch.set(f, editEpoch);
            }
            deferredBgPasses.set(editEpoch, Math.max(deferredBgPasses.get(editEpoch) ?? -1, i));
          } else {
            fileOscState.clear();
            pendingEditFiles.clear();
            deferredBgPasses.clear();
          }
        } else if (turnEditedFiles.length > 0) {
          for (const f of turnEditedFiles) {
            pendingEditFiles.add(f);
            fileLastEditEpoch.set(f, editEpoch);
          }
        } else if (turnRanSyncCheck && turnFailed) {
          epochBgFailedStep.set(editEpoch, Math.max(epochBgFailedStep.get(editEpoch) ?? -1, i));
          deferredBgPasses.delete(editEpoch);
          if (pendingEditFiles.size > 0) {
            recordFileFailureCycle(pendingEditFiles, failedResults, editEpoch, i);
            pendingEditFiles.clear();
          }
        } else if (
          turnHasConvergingPass &&
          !turnFailed &&
          !turnTimedOutOnly &&
          !turnPassLeavesSameKindFailure &&
          followingResults.length > 0
        ) {
          if (hasSiblingBgCheckForEpoch(editEpoch)) {
            deferredBgPasses.set(editEpoch, Math.max(deferredBgPasses.get(editEpoch) ?? -1, i));
          } else {
            fileOscState.clear();
            pendingEditFiles.clear();
            deferredBgPasses.clear();
          }
        }
      }
    }

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
      const activeMinCacheable = activeTurnProfile.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS;
      if (safeCacheCreate1h > 0) {
        seen1hWriteByProfile.set(activeTurnProfile.id, true);
      }

      if (totalMediaCount > 0 && ctxTok >= 150000) {
        multimodalHighCtxTurns += 1;
      }

      const turnHitRate = Number((safeCache / ctxTok).toFixed(4));
      if (ctxTok >= activeMinCacheable) {
        hitRateSum += safeCache / ctxTok;
        hitRateCount += 1;
      }

      const deltaTokens = hasSeenPlanner ? ctxTok - prevCtxTokens : 0;
      let dominantTrigger = null;
      let triggerDisplayLabel = null;
      if (prevTurnTools.length > 0) {
        dominantTrigger = prevTurnTools[0];
        let totalTurnResultBytes = 0;
        for (const item of prevTurnTools) {
          totalTurnResultBytes += item.resultBytes || 0;
          if (item.resultBytes > dominantTrigger.resultBytes) {
            dominantTrigger = item;
          }
        }
        const toolCount = prevTurnTools.length;
        triggerDisplayLabel =
          toolCount > 1 ? `${dominantTrigger.label} +${toolCount - 1}` : dominantTrigger.label;
        if (deltaTokens > 0) {
          const entry = {
            stepIndex: step.step_index ?? i,
            turn: turnsWithUsage,
            deltaTokens,
            ctxTokens: ctxTok,
            tool: dominantTrigger.tool,
            target: dominantTrigger.target,
            label: triggerDisplayLabel,
            toolCount
          };
          if (toolCount > 1) {
            entry.parallelTools = prevTurnTools
              .slice()
              .sort((a, b) => (b.resultBytes || 0) - (a.resultBytes || 0))
              .slice(0, 6)
              .map((item) => ({
                tool: item.tool,
                target: item.target,
                label: item.label,
                resultBytes: item.resultBytes || 0,
                sharePct:
                  totalTurnResultBytes > 0
                    ? Math.round(((item.resultBytes || 0) / totalTurnResultBytes) * 100)
                    : Math.round(100 / toolCount)
              }));
          }
          deltaAttributions.push(entry);
        }
      }

      let turnWasBust = false;
      let turnBustCause = null;
      let turnBustReadState = null;
      let turnBustEntry = null;
      let turnWasWarmHit = false;
      let turnWastedTokens = 0;
      let turnWastedRewritten = 0;

      // Check for cache bust relative to previous warm turn's prefix size
      if (hasSeenPlanner && prevCtxTokens >= activeMinCacheable) {
        warmTurns += 1;
        const retainedRatio = prevCtxTokens > 0 ? safeCache / prevCtxTokens : 1;
        const gapSec =
          tMs !== null && prevPlannerMs !== null && tMs >= prevPlannerMs
            ? Math.round((tMs - prevPlannerMs) / 1000)
            : null;
        const sameModel = !prevModel || !model || prevModel === model;
        // Gemini 4 implicit caching only caches the full previous request when the new turn adds
        // >= 2,050 tokens; for smaller turns it re-processes the trailing 2,050 tokens at standard rate.
        const tailReprocessThreshold = activeTurnProfile.minTurnDeltaForFullCache || 0;
        const isExpectedSmallDeltaTailReprocess =
          tailReprocessThreshold > 0 &&
          sameModel &&
          !mediaLoadedSincePrev &&
          !systemMsgSincePrev &&
          ctxTok >= prevCtxTokens &&
          deltaTokens > 0 &&
          deltaTokens < tailReprocessThreshold &&
          safeCache > 0 &&
          prevCtxTokens - safeCache <= tailReprocessThreshold + 256;
        const isBust =
          !isExpectedSmallDeltaTailReprocess &&
          (retainedRatio < BUST_DROP_RATIO || (prevCtxTokens >= 10000 && safeCache === 0));

        if (!isBust) {
          if (safeCache > 0) turnWasWarmHit = true;
          if (retainedRatio >= BUST_DROP_RATIO && safeCache > 0 && gapSec !== null && sameModel) {
            if (maxWarmHitGapSec === null || gapSec > maxWarmHitGapSec) {
              maxWarmHitGapSec = gapSec;
            }
            const prevProfileMax = maxWarmGapByProfile.get(activeTurnProfile.id);
            if (prevProfileMax === undefined || gapSec > prevProfileMax) {
              maxWarmGapByProfile.set(activeTurnProfile.id, gapSec);
            }
            if (gapSec >= TTL_WARM_SAMPLE_MIN_SEC && gapSec <= TTL_SAMPLE_MAX_SEC) {
              pushProfileObservation(warmObsByProfile, activeTurnProfile.id, {
                gapSec,
                atMs: tMs ?? nowMs
              });
            }
          }
        } else {
          turnWasBust = true;
          const turnCal = estimateCalibratedTtl(activeTurnProfile, {
            explicitTtlSec,
            sessionMaxWarmGapSec: maxWarmGapByProfile.get(activeTurnProfile.id) ?? null,
            sessionHas1hWrite: Boolean(seen1hWriteByProfile.get(activeTurnProfile.id)),
            sessionWarmSamples: warmObsByProfile.get(activeTurnProfile.id) || [],
            sessionColdSamples: coldObsByProfile.get(activeTurnProfile.id) || [],
            historyRecord: historicalTtlByProfile ? historicalTtlByProfile[activeTurnProfile.id] : null,
            nowMs: tMs ?? nowMs,
            convId: optionConvId
          });
          const turnTtlSec = turnCal.ttlSec;

          // Record pure-idle cold miss candidate INDEPENDENT of `turnTtlSec` / `cause === "ttl_idle_expiry"`
          // to prevent upward-only calibration lock-in when server TTL shrinks, while filtering out sub-baseline
          // (< profile.ttlSec) replica-routing/prefix-drift misses so they never evict genuine >= profile.ttlSec cold samples.
          const minColdSampleSec =
            explicitTtlSec !== null && explicitTtlSec > 0
              ? Math.max(60, Math.min(TTL_COLD_SAMPLE_MIN_SEC, explicitTtlSec))
              : Math.max(TTL_COLD_SAMPLE_MIN_SEC, activeTurnProfile.ttlSec || DEFAULT_CACHE_TTL_SEC);
          if (
            sameModel &&
            ctxTok >= prevCtxTokens * BUST_DROP_RATIO &&
            !mediaLoadedSincePrev &&
            !systemMsgSincePrev &&
            safeCache / prevCtxTokens < TTL_PURE_COLD_MAX_CACHE_RATIO &&
            gapSec !== null &&
            gapSec >= minColdSampleSec &&
            gapSec <= TTL_SAMPLE_MAX_SEC
          ) {
            pushProfileObservation(coldObsByProfile, activeTurnProfile.id, {
              gapSec,
              atMs: tMs ?? nowMs
            });
          }

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
          if (cause === "prefix_drift") {
            if (!turnUsage.cacheReadReported) {
              turnBustReadState = "unreported";
              driftBreakdown.unreportedRead += 1;
            } else if (safeCache === 0) {
              turnBustReadState = "zero";
              driftBreakdown.zeroRead += 1;
            } else {
              turnBustReadState = "partial";
              driftBreakdown.partialRead += 1;
            }
          }
          const expectedReusable = Math.min(prevCtxTokens, ctxTok);
          const wastedTokens = Math.max(0, expectedReusable - safeCache);
          turnWastedTokens = wastedTokens;
          turnWastedRewritten = Math.min(wastedTokens, safeCacheCreate);
          bustsByCause[cause] += 1;
          wastedTokensTotal += wastedTokens;
          wastedRewrittenTokens += turnWastedRewritten;

          turnBustEntry = {
            stepIndex: step.step_index ?? i,
            hasExplicitStepIndex: step.step_index !== undefined && step.step_index !== null,
            at: step.created_at || null,
            cause,
            bustReadState: turnBustReadState,
            prevCtxTokens,
            currCtxTokens: ctxTok,
            cacheReadTokens: safeCache,
            wastedTokens,
            gapSec,
            model: model || prevModel || null
          };
          recentBusts.push(turnBustEntry);
        }
      }

      turnBillingItems.push({
        profile: activeTurnProfile,
        safeIn,
        safeCache,
        safeCacheCreate,
        safeCacheCreate1h,
        turnWastedTokens,
        turnWastedRewritten
      });

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
        bustReadState: turnBustReadState,
        triggerTool: triggerDisplayLabel
      });

      const hadCompactionOrShrink =
        compactionSincePrevUsage ||
        turnShrink.shrunk ||
        (hasSeenPlanner && prevCtxTokens > 0 && ctxTok < prevCtxTokens * BUST_DROP_RATIO);
      turnMeta.push({
        turnIndex: allTurns.length - 1,
        stepIndex: step.step_index ?? i,
        rawModel: model.trim(),
        ctxTokens: ctxTok,
        cacheReadTokens: safeCache,
        cacheReadReported: turnUsage.cacheReadReported,
        isBust: turnWasBust,
        bustCause: turnBustCause,
        wasWarmHit: turnWasWarmHit,
        isSubagent: stepIsSubagent,
        subagentSincePrev: subagentSincePrevUsage,
        missingUsagePlannerSincePrev,
        compactionInSegment: hadCompactionOrShrink,
        mediaInSegment: mediaLoadedSincePrev,
        systemMsgInSegment: systemMsgSincePrev,
        bustEntry: turnBustEntry
      });

      if (turnShrink.shrunk) {
        seenReadSignatures.clear();
        const isCompactModelSwitch = Boolean(prevCompactModel && model && model !== prevCompactModel);
        const compactRetainedRatio = refPrevCompactCtx > 0 ? safeCache / refPrevCompactCtx : 1;
        const isCompactBust = compactRetainedRatio < BUST_DROP_RATIO || (refPrevCompactCtx >= 10000 && safeCache === 0);
        const compactKind =
          turnShrink.severe && isCompactBust && !isCompactModelSwitch ? "compaction_bust" : "context_shrink";
        latestCompactionEvent = buildCompactionEvent({
          kind: compactKind,
          step,
          index: i,
          prevCtxTokens: refPrevCompactCtx,
          currCtxTokens: ctxTok
        });
      }

      if (!stepIsSubagent) {
        prevCompactPrimaryCtx = ctxTok;
        seenPrimaryCompactTurn = true;
      } else if (!seenPrimaryCompactTurn) {
        prevCompactSubCtx = ctxTok;
      }
      if (model && (!stepIsSubagent || !seenPrimaryCompactTurn)) {
        prevCompactModel = model;
      }

      prevCtxTokens = ctxTok;
      if (model) prevModel = model;
      if (tMs !== null) prevPlannerMs = tMs;
      hasSeenPlanner = true;
      mediaLoadedSincePrev = false;
      systemMsgSincePrev = false;
      subagentSincePrevUsage = false;
      missingUsagePlannerSincePrev = false;
      compactionSincePrevUsage = false;
    } else {
      if (turnMeta.length > 0) {
        missingUsagePlannerSincePrev = true;
        if (stepIsSubagent) subagentSincePrevUsage = true;
      }
      if (tMs !== null) {
        lastPlannerMs = tMs;
        if (!hasSeenPlanner) hasSeenPlanner = true;
      }
    }

    prevTurnTools = currTurnTools;
  }

  // Optional cross-turn observation (display-only; never alters primary causes, waste, or TTL calibration).
  // Enabled only on validated gemini-4-512k profile in v1; basic read-state breakdown applies to all backends.
  const isTailTruncated =
    Boolean(options.isTailSlice) || (Array.isArray(steps) && TAIL_TRUNCATED_STEP_ARRAYS.has(steps));
  const isEligiblePriorMatchCold = (m) =>
    Boolean(
      m &&
      !m.isSubagent &&
      m.isBust &&
      m.cacheReadReported &&
      m.cacheReadTokens === 0 &&
      (m.bustCause === "prefix_drift" || m.bustCause === "ttl_idle_expiry")
    );
  const isPriorMatchSegmentClean = (m) =>
    Boolean(
      m &&
      !m.isSubagent &&
      !m.subagentSincePrev &&
      !m.missingUsagePlannerSincePrev &&
      !m.compactionInSegment &&
      !m.mediaInSegment &&
      !m.systemMsgInSegment
    );
  for (let idx = 0; idx < turnMeta.length; ) {
    if (!isEligiblePriorMatchCold(turnMeta[idx])) {
      idx += 1;
      continue;
    }
    let runEnd = idx;
    while (runEnd + 1 < turnMeta.length && isEligiblePriorMatchCold(turnMeta[runEnd + 1])) {
      runEnd += 1;
    }
    const runLen = runEnd - idx + 1;
    const refIdx = idx - 1;
    const recIdx = runEnd + 1;
    if (runLen >= 1 && runLen <= 2 && refIdx >= 0 && recIdx < turnMeta.length) {
      const ref = turnMeta[refIdx];
      const colds = runLen === 1 ? [turnMeta[idx]] : [turnMeta[idx], turnMeta[idx + 1]];
      const rec = turnMeta[recIdx];
      const refModel = ref.rawModel;
      const isEnabledProfile =
        Boolean(refModel) && PRIOR_CONTEXT_MATCH_ENABLED_PROFILES.has(resolveModelProfile(refModel).id);
      const refIsValid =
        !ref.isSubagent &&
        !(ref.isBust && !ref.cacheReadReported) &&
        !(isTailTruncated && refIdx === 0 && ref.cacheReadTokens === 0);
      if (
        isEnabledProfile &&
        refIsValid &&
        colds.every((c) => isPriorMatchSegmentClean(c) && c.rawModel === refModel) &&
        isPriorMatchSegmentClean(rec) &&
        rec.rawModel === refModel &&
        rec.cacheReadReported &&
        rec.cacheReadTokens > 0 &&
        rec.wasWarmHit
      ) {
        const P = ref.ctxTokens;
        const R = rec.cacheReadTokens;
        if (
          (R === P || R === P + 1) &&
          colds.every((c) => R < c.ctxTokens - PRIOR_CONTEXT_MATCH_TAIL_SLACK)
        ) {
          const match = {
            referenceStepIndex: ref.stepIndex,
            recoveryStepIndex: rec.stepIndex
          };
          const firstCold = turnMeta[idx];
          allTurns[firstCold.turnIndex].priorContextMatch = match;
          if (firstCold.bustEntry) {
            firstCold.bustEntry.priorContextMatch = { ...match };
          }
        }
      }
    }
    idx = runEnd + 1;
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

  const activeProfileMaxWarmGap = maxWarmGapByProfile.get(matchedProfile.id) ?? null;
  const activeHas1hWrite = Boolean(seen1hWriteByProfile.get(matchedProfile.id));
  const ttlEstResult = estimateCalibratedTtl(matchedProfile, {
    explicitTtlSec,
    sessionMaxWarmGapSec: activeProfileMaxWarmGap,
    sessionHas1hWrite: activeHas1hWrite,
    sessionWarmSamples: warmObsByProfile.get(matchedProfile.id) || [],
    sessionColdSamples: coldObsByProfile.get(matchedProfile.id) || [],
    historyRecord: historicalTtlByProfile ? historicalTtlByProfile[matchedProfile.id] : null,
    nowMs,
    convId: optionConvId
  });
  const ttlSec = ttlEstResult.ttlSec;
  const ttlSource = ttlEstResult.ttlSource;
  const ttlCalibration = ttlEstResult.ttlCalibration;

  const ttlObservations = {};
  const observedProfileIds = new Set([
    ...warmObsByProfile.keys(),
    ...coldObsByProfile.keys(),
    ...seen1hWriteByProfile.keys()
  ]);
  for (const pid of observedProfileIds) {
    const w = warmObsByProfile.get(pid) || [];
    const c = coldObsByProfile.get(pid) || [];
    const s1h = Boolean(seen1hWriteByProfile.get(pid));
    if (w.length > 0 || c.length > 0 || s1h) {
      ttlObservations[pid] = {
        profileId: pid,
        warm: w.slice(-20),
        cold: c.slice(-20),
        seen1hWrite: s1h
      };
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

  const matchedMinCacheable = matchedProfile.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS;
  const modelProfile = {
    id: matchedProfile.id,
    windowTokens,
    windowSource,
    defaultTtlSec: matchedProfile.ttlSec,
    cacheDiscountRate,
    inputPer1M: inputPricePer1M,
    minCacheableTokens: matchedMinCacheable,
    minTurnDeltaForFullCache: matchedProfile.minTurnDeltaForFullCache ?? 0,
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
  if (currentContextTokens >= matchedMinCacheable && idleSeconds !== null) {
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
    delayHotMinTokens,
    minCacheableTokens: matchedMinCacheable
  });
  // Sum USD costs per-turn using each turn's active model profile (prevents 10x-50x skew across model_switch)
  let actualUsdRaw = 0;
  let baselineUncachedUsdRaw = 0;
  let wastedUsdRaw = 0;
  for (const item of turnBillingItems) {
    const p = item.profile;
    const tDiscount = explicitDiscountRate ?? p.cacheDiscountRate;
    const tBaseWrite = p.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER;
    const tLongWrite = p.cacheWrite1hMultiplier ?? tBaseWrite;
    const pMaxGap = maxWarmGapByProfile.get(p.id) ?? null;
    const pHas1h = Boolean(seen1hWriteByProfile.get(p.id));
    const pCal = estimateCalibratedTtl(p, {
      explicitTtlSec,
      sessionMaxWarmGapSec: pMaxGap,
      sessionHas1hWrite: pHas1h,
      sessionWarmSamples: warmObsByProfile.get(p.id) || [],
      sessionColdSamples: coldObsByProfile.get(p.id) || [],
      historyRecord: historicalTtlByProfile ? historicalTtlByProfile[p.id] : null,
      nowMs,
      convId: optionConvId
    });
    const pTtlSec = pCal.ttlSec;
    let tWriteMult;
    if (explicitWriteMultiplier !== null) {
      tWriteMult = explicitWriteMultiplier;
    } else if (item.safeCacheCreate1h > 0 && item.safeCacheCreate > 0) {
      const c1h = Math.min(item.safeCacheCreate1h, item.safeCacheCreate);
      const c5m = item.safeCacheCreate - c1h;
      tWriteMult = (c5m * tBaseWrite + c1h * tLongWrite) / item.safeCacheCreate;
    } else if (pTtlSec >= 3600) {
      tWriteMult = tLongWrite;
    } else {
      tWriteMult = tBaseWrite;
    }
    const tPricePerToken = (explicitInputPricePer1M ?? p.inputPer1M ?? DEFAULT_INPUT_PRICE_PER_1M) / 1e6;
    const tAll = item.safeIn + item.safeCache + item.safeCacheCreate;
    const tEquiv = item.safeIn + (1 - tDiscount) * item.safeCache + tWriteMult * item.safeCacheCreate;
    actualUsdRaw += tEquiv * tPricePerToken;
    baselineUncachedUsdRaw += tAll * tPricePerToken;
    if (item.turnWastedTokens > 0) {
      const tUncachedWaste = Math.max(0, item.turnWastedTokens - item.turnWastedRewritten);
      wastedUsdRaw +=
        (tUncachedWaste * tDiscount + item.turnWastedRewritten * (tWriteMult - (1 - tDiscount))) * tPricePerToken;
    }
  }

  const estimatedCostSavingsPct =
    baselineUncachedUsdRaw > 0
      ? Number((((baselineUncachedUsdRaw - actualUsdRaw) / baselineUncachedUsdRaw) * 100).toFixed(1))
      : estimateCostSavingsPct(
          cachedTokensTotal,
          uncachedInputTokensTotal,
          cacheDiscountRate,
          cacheCreationTokensTotal,
          cacheWriteMultiplier
        );

  const estimatedInputCostUsd = roundUsd(actualUsdRaw);
  const estimatedSavedUsd = roundUsd(baselineUncachedUsdRaw - actualUsdRaw);
  const estimatedWastedUsd = roundUsd(wastedUsdRaw);

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
  let editFailOscillations = 0;
  for (const st of fileOscState.values()) {
    if (st.oscCount > editFailOscillations) editFailOscillations = st.oscCount;
  }
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
  const oscillatingFiles = Array.from(fileOscState.values())
    .filter((st) => st.oscCount >= 2)
    .sort((a, b) => b.oscCount - a.oscCount || b.failCycles - a.failCycles)
    .slice(0, 3)
    .map((st) => st.label);

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

  const stripInternalCheckFields = (rec) => {
    if (!rec || typeof rec !== "object") return null;
    const { _identity, _batchIdentities, ...clean } = rec;
    return clean;
  };
  const unresolvedFailures = Array.from(checkSlots.values())
    .filter((r) => r && r.outcome === "fail")
    .sort((a, b) => (b.seq || 0) - (a.seq || 0))
    .map((r) => stripInternalCheckFields(r));
  const latestRealFailure = unresolvedFailures[0] || null;
  const checksByKind = {};
  for (const rec of checkSlots.values()) {
    if (!rec) continue;
    const k = rec.kind || "check";
    const cur = checksByKind[k];
    if (!cur) {
      checksByKind[k] = stripInternalCheckFields(rec);
    } else if (rec.outcome === "fail" && cur.outcome !== "fail") {
      checksByKind[k] = stripInternalCheckFields(rec);
    } else if (rec.outcome === cur.outcome && (rec.seq || 0) > (cur.seq || 0)) {
      checksByKind[k] = stripInternalCheckFields(rec);
    }
  }
  const checkStatus = {
    latestCheck: stripInternalCheckFields(latestCheck),
    latestRealFailure: latestRealFailure ? { ...latestRealFailure } : null,
    unresolvedFailures,
    checksByKind,
    history: checkHistory.map((h) => stripInternalCheckFields(h)).filter(Boolean),
    hasConfirmedResult: Boolean(latestCheck)
  };
  const hasActiveCheckIssue = Boolean(
    checkStatus.latestCheck?.outcome === "timeout" ||
      checkStatus.latestCheck?.outcome === "fail" ||
      checkStatus.unresolvedFailures.length > 0 ||
      editFailOscillations >= 2
  );
  const effectiveCompactAdvice =
    compactAdvice === "delay_hot_cache" && hasActiveCheckIssue ? "none" : compactAdvice;

  const recentTurns = allTurns.slice(-15);
  const topContextDeltas = deltaAttributions
    .sort((a, b) => b.deltaTokens - a.deltaTokens || a.stepIndex - b.stepIndex)
    .slice(0, 3);
  const contextComposition = finalizeContextComposition(compRaw);
  const subagentBreakdown = finalizeSubagentBreakdown(subRaw, contextComposition.totalEstTokens);

  return {
    turnsWithUsage,
    inToolLoop,
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
    ttlCalibration,
    ttlObservations,
    maxWarmHitGapSec,
    ttlRemainingSec,
    ttlStatus,
    cacheTemperature,
    compactAdvice: effectiveCompactAdvice,
    estimatedCostSavingsPct,
    estimatedInputCostUsd,
    estimatedSavedUsd,
    estimatedWastedUsd,
    bustCount,
    bustsByCause,
    driftBreakdown,
    wastedTokensTotal,
    totalMediaCount,
    multimodalHighCtxTurns,
    duplicateReadCount,
    loopWatch,
    checkStatus,
    contextComposition,
    subagentBreakdown,
    recentTurns,
    topContextDeltas,
    recentBusts: recentBusts.slice(-10),
    latestCompactionEvent
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
  const driftBreakdown = createEmptyDriftBreakdown();
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

  for (const rawSess of sessions || []) {
    const steps = Array.isArray(rawSess) ? rawSess : Array.isArray(rawSess?.steps) ? rawSess.steps : null;
    if (!steps || steps.length === 0) continue;
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
    if (res.driftBreakdown) {
      driftBreakdown.zeroRead += res.driftBreakdown.zeroRead || 0;
      driftBreakdown.partialRead += res.driftBreakdown.partialRead || 0;
      driftBreakdown.unreportedRead += res.driftBreakdown.unreportedRead || 0;
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
    driftBreakdown,
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

const RESERVED_BRAIN_CONV_IDS = new Set([
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

function isUncPathLocal(p) {
  if (!p || typeof p !== "string") return false;
  return /^[\\/]{2}/.test(p.trim());
}

function resolveCanonicalPathLocal(p) {
  const real =
    typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(p) : fs.realpathSync(p);
  if (process.platform === "win32") {
    const driveMatch = real.match(/^\\\\\?\\([a-zA-Z]:\\.*)$/);
    if (driveMatch) return driveMatch[1];
  }
  return real;
}

function isStrictPathInside(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const nc = process.platform === "win32" ? childPath.toLowerCase() : childPath;
  const np = process.platform === "win32" ? parentPath.toLowerCase() : parentPath;
  const rel = path.relative(np, nc);
  return Boolean(
    rel &&
      rel !== "." &&
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith("../") &&
      !path.isAbsolute(rel)
  );
}

/**
 * Return allowed Antigravity brain root directories (extra roots first, then default user roots).
 */
export function getAntigravityBrainRoots(extraRoots = []) {
  const home = os.homedir();
  const rawList = [
    ...(Array.isArray(extraRoots) ? extraRoots : []),
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain")
  ];
  const seen = new Set();
  const out = [];
  for (const r of rawList) {
    if (typeof r !== "string") continue;
    const trimmed = r.trim();
    if (!trimmed || trimmed.includes("\0") || isUncPathLocal(trimmed) || !path.isAbsolute(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    if (isUncPathLocal(resolved)) continue;
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

const PREFERRED_TRANSCRIPT_REL_PATHS = Object.freeze([
  [".system_generated", "logs", "transcript.jsonl"],
  [".system_generated", "transcript.jsonl"],
  ["transcript.jsonl"],
  [".system_generated", "logs", "transcript_full.jsonl"],
  [".system_generated", "transcript_full.jsonl"],
  ["transcript_full.jsonl"]
]);
const CONVERSATION_ARTIFACT_REL_PATHS = Object.freeze([
  ["task.md"],
  ["implementation_plan.md"],
  ["walkthrough.md"]
]);

function inspectConversationDirOwnership(convDirInfo) {
  let hasOwnedFile = false;
  let hasSuspiciousEscape = false;
  const allCandidates = [...PREFERRED_TRANSCRIPT_REL_PATHS, ...CONVERSATION_ARTIFACT_REL_PATHS];

  for (const segs of allCandidates) {
    if (resolveConversationOwnedFile(convDirInfo, segs)) {
      hasOwnedFile = true;
      break;
    }
    const candPath = path.join(convDirInfo.dir, ...segs);
    try {
      fs.lstatSync(candPath);
      // Candidate entry exists on disk in a supported slot yet failed strict ownership validation
      // (e.g. symlink/junction escaping the conversation dir). Lock onto this root instead of hopping.
      hasSuspiciousEscape = true;
    } catch {
      // Missing slot -> normal
    }
  }

  if (!hasOwnedFile && !hasSuspiciousEscape) {
    // Also detect escaping `.system_generated` or `.system_generated/logs` junctions
    for (const dirSegs of [[".system_generated"], [".system_generated", "logs"]]) {
      const dirCand = path.join(convDirInfo.dir, ...dirSegs);
      try {
        const st = fs.lstatSync(dirCand);
        if (st.isSymbolicLink()) {
          hasSuspiciousEscape = true;
          break;
        }
        const realSub = resolveCanonicalPathLocal(dirCand);
        if (isUncPathLocal(realSub) || !isStrictPathInside(realSub, convDirInfo.dir)) {
          hasSuspiciousEscape = true;
          break;
        }
      } catch {
        // Missing subdir -> normal
      }
    }
  }

  return { hasOwnedFile, hasSuspiciousEscape };
}

/**
 * Resolve and canonically validate a single conversation's owned brain directory.
 * Blocks `..`, UNC paths, symlinks/Windows junctions escaping the brain root, and
 * junctions redirecting a conversation directory to a sibling conversation.
 * Across multiple brain roots (`extraRoots` > `antigravity` > `antigravity-ide` > `antigravity-cli`),
 * locks onto the first root containing any valid owned transcript/artifact (or suspicious escape),
 * skipping empty placeholder directories so they do not shadow a real session in a later root.
 */
export function resolveConversationBrainDir(conversationId, extraRoots = []) {
  if (typeof conversationId !== "string") return null;
  const safeId = conversationId.trim();
  if (!safeId || RESERVED_BRAIN_CONV_IDS.has(safeId.toLowerCase()) || !isSafeConversationId(safeId)) {
    return null;
  }
  const roots = getAntigravityBrainRoots(extraRoots);
  let firstEmptyValid = null;
  for (const resolvedRoot of roots) {
    let realRoot;
    try {
      const rootStat = fs.statSync(resolvedRoot);
      if (!rootStat.isDirectory()) continue;
      realRoot = resolveCanonicalPathLocal(resolvedRoot);
      if (isUncPathLocal(realRoot)) continue;
    } catch {
      continue;
    }
    const expectedDir = path.join(realRoot, safeId);
    try {
      const lstat = fs.lstatSync(expectedDir);
      // Reject symlink or Windows junction at conversation root (prevents sibling-session redirection)
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) continue;
      const realCand = resolveCanonicalPathLocal(expectedDir);
      if (isUncPathLocal(realCand)) continue;
      const cmpCand = process.platform === "win32" ? realCand.toLowerCase() : realCand;
      const cmpExpected = process.platform === "win32" ? expectedDir.toLowerCase() : expectedDir;
      if (cmpCand !== cmpExpected || !isStrictPathInside(realCand, realRoot)) continue;
      const info = {
        root: resolvedRoot,
        realRoot,
        dir: realCand,
        conversationId: safeId
      };
      const ownership = inspectConversationDirOwnership(info);
      if (ownership.hasOwnedFile || ownership.hasSuspiciousEscape) {
        return info;
      }
      if (!firstEmptyValid) {
        firstEmptyValid = info;
      }
    } catch {
      // Missing or inaccessible in this brain root -> try next root
    }
  }
  return firstEmptyValid;
}

/**
 * Independently verify that a candidate regular file inside a validated conversation brain dir
 * remains canonically owned by that exact conversation (blocks sibling-session links, junctions, UNC).
 */
export function resolveConversationOwnedFile(convDirInfo, relativeSegments = []) {
  if (!convDirInfo || typeof convDirInfo.dir !== "string" || !convDirInfo.dir) return null;
  if (!Array.isArray(relativeSegments) || relativeSegments.length === 0) return null;
  for (const seg of relativeSegments) {
    if (
      typeof seg !== "string" ||
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("\0") ||
      seg.includes("/") ||
      seg.includes("\\")
    ) {
      return null;
    }
  }
  const candPath = path.join(convDirInfo.dir, ...relativeSegments);
  if (isUncPathLocal(candPath) || !isStrictPathInside(candPath, convDirInfo.dir)) {
    return null;
  }
  try {
    // Must exist on disk
    fs.lstatSync(candPath);
    const realFile = resolveCanonicalPathLocal(candPath);
    if (isUncPathLocal(realFile)) return null;
    if (!isStrictPathInside(realFile, convDirInfo.dir)) return null;
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) return null;
    return { path: realFile, stat };
  } catch {
    return null;
  }
}

/**
 * Strictly locate the preferred transcript for a confirmed conversationId inside its own
 * verified brain directory: prefers `transcript.jsonl` and falls back to the SAME session's
 * `transcript_full.jsonl`. Never falls back across sessions.
 */
export function findPreferredTranscriptForConversation(
  conversationId,
  { extraRoots = [], convDirInfo = null } = {}
) {
  const dirInfo = convDirInfo || resolveConversationBrainDir(conversationId, extraRoots);
  if (!dirInfo) return null;
  for (const segs of PREFERRED_TRANSCRIPT_REL_PATHS) {
    const owned = resolveConversationOwnedFile(dirInfo, segs);
    if (owned) return owned.path;
  }
  return null;
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

const DEFAULT_BRAIN_SCAN_MAX_ENTRIES = 500;
const DEFAULT_BRAIN_SCAN_MAX_MS = 150;
const LATEST_TRANSCRIPT_SCAN_CACHE_MAX = 16;
const LATEST_TRANSCRIPT_SCAN_CACHE_TTL_MS = 10_000;
const _latestTranscriptScanCache = new Map();

export function clearTranscriptScanCache() {
  _latestTranscriptScanCache.clear();
}

function probeConversationTranscriptInRoot(resolvedRoot, safeId) {
  const candidates = [
    path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript_full.jsonl"),
    path.join(resolvedRoot, safeId, ".system_generated", "logs", "transcript.jsonl"),
    path.join(resolvedRoot, safeId, ".system_generated", "transcript_full.jsonl"),
    path.join(resolvedRoot, safeId, ".system_generated", "transcript.jsonl")
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return { path: c, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return null;
}

function findNewestTranscriptViaSummaryDb(brainRoot, maxCandidates = 32, { deadlineMs = null } = {}) {
  if (!brainRoot || typeof brainRoot !== "string") {
    return { hit: null, status: "missing", precision: "none" };
  }
  const resolvedRoot = path.resolve(brainRoot);
  const query = queryRecentConversationIdsFromSummaryDb(resolvedRoot, maxCandidates, { deadlineMs });
  if (query.status !== "ok" || !Array.isArray(query.ids) || query.ids.length === 0) {
    return { hit: null, status: query.status, precision: query.precision };
  }
  let best = null;
  for (const cid of query.ids) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      return { hit: best, status: "budget_exhausted", precision: query.precision };
    }
    if (!isSafeConversationId(cid)) continue;
    const hit = probeConversationTranscriptInRoot(resolvedRoot, cid);
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) {
      best = hit;
    }
  }
  return { hit: best, status: "ok", precision: query.precision };
}

/**
 * Locate Antigravity transcript_full.jsonl / transcript.jsonl for a conversationId.
 * When exactOnly=false (default), falls back to the most recently modified local transcript
 * if conversationId is omitted, "all", "app", "default", or not found (using sibling
 * `conversation_summaries.db` recent-ID fast path + bounded `brain/` directory scan).
 */
export function findTranscriptForConversation(conversationId = null, optionsOrExtraRoots = {}) {
  const opts = Array.isArray(optionsOrExtraRoots)
    ? { extraRoots: optionsOrExtraRoots, exactOnly: false }
    : optionsOrExtraRoots || {};
  const extraRoots = Array.isArray(opts.extraRoots) ? opts.extraRoots : [];
  const exactOnly = Boolean(opts.exactOnly);
  const maxEntries =
    Number.isFinite(Number(opts.maxEntries)) && Number(opts.maxEntries) >= 1
      ? Math.floor(Number(opts.maxEntries))
      : DEFAULT_BRAIN_SCAN_MAX_ENTRIES;
  const maxScanMs =
    Number.isFinite(Number(opts.maxScanMs)) && Number(opts.maxScanMs) >= 1
      ? Math.floor(Number(opts.maxScanMs))
      : DEFAULT_BRAIN_SCAN_MAX_MS;
  const noCache = Boolean(opts.noCache);
  const includeDefaultRoots = opts.includeDefaultRoots !== false;

  const home = os.homedir();
  const roots = includeDefaultRoots
    ? [
        ...extraRoots,
        path.join(home, ".gemini", "antigravity", "brain"),
        path.join(home, ".gemini", "antigravity-ide", "brain"),
        path.join(home, ".gemini", "antigravity-cli", "brain")
      ]
    : [...extraRoots];

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

  // Bounded cache keyed by root directory mtime + sibling summary DB & WAL signatures
  const nowMs = Date.now();
  const rootStampParts = [];
  for (const root of roots) {
    if (!root || typeof root !== "string") continue;
    let rMtime = 0;
    try {
      rMtime = Math.round(fs.statSync(root).mtimeMs);
    } catch {}
    let dbSig = "-";
    let walSig = "-";
    try {
      const resolvedRoot = path.resolve(root);
      if (path.basename(resolvedRoot).toLowerCase() === "brain") {
        const dbPath = path.join(path.dirname(resolvedRoot), "conversation_summaries.db");
        try {
          const st = fs.statSync(dbPath);
          dbSig = `${Math.round(st.mtimeMs)}:${st.size}`;
        } catch {}
        try {
          const wst = fs.statSync(`${dbPath}-wal`);
          walSig = `${Math.round(wst.mtimeMs)}:${wst.size}`;
        } catch {}
      }
    } catch {}
    rootStampParts.push(`${root}:${rMtime}:${dbSig}:${walSig}`);
  }
  const cacheKey = `${maxEntries}:${maxScanMs}:${roots.join("\0")}`;
  const rootStamp = rootStampParts.join("|");
  if (!noCache) {
    const cached = _latestTranscriptScanCache.get(cacheKey);
    if (cached && nowMs < cached.expiresAt && cached.rootStamp === rootStamp) {
      if (!cached.path || fs.existsSync(cached.path)) {
        return cached.path;
      }
    }
  }

  // Single shared wall-clock deadline across ALL roots, summary-DB probes, and Tier-2 directory scans.
  const deadlineMs = Date.now() + maxScanMs;
  let bestPath = null;
  let bestMtime = 0;
  let degraded = false;
  let hadHeuristicOnly = false;
  const rootsNeedingDirScan = [];

  // Tier 1: Per-root O(1) recent-ID lookup via sibling conversation_summaries.db
  for (const root of roots) {
    if (Date.now() >= deadlineMs) {
      degraded = true;
      break;
    }
    const summaryRes = findNewestTranscriptViaSummaryDb(root, 32, { deadlineMs });
    if (summaryRes.status === "locked" || summaryRes.status === "budget_exhausted" || summaryRes.status === "error") {
      degraded = true;
    }
    if (summaryRes.hit && summaryRes.hit.mtimeMs > bestMtime) {
      bestMtime = summaryRes.hit.mtimeMs;
      bestPath = summaryRes.hit.path;
    }
    if (!summaryRes.hit) {
      rootsNeedingDirScan.push(root);
    } else if (summaryRes.precision === "rowid_heuristic") {
      // Large unindexed summary DB only samples recently inserted rowids; cross-check against
      // bounded filesystem mtimes within the remaining shared deadline so recently updated older
      // conversations are not masked by newer-rowid inserts.
      hadHeuristicOnly = true;
      rootsNeedingDirScan.push(root);
    }
  }

  // Tier 2: Streaming bounded brain directory scan fallback sharing the SAME absolute deadline
  let budgetHit = false;
  if (rootsNeedingDirScan.length > 0) {
    let scannedEntries = 0;
    for (const root of rootsNeedingDirScan) {
      if (budgetHit || Date.now() >= deadlineMs) {
        budgetHit = true;
        break;
      }
      let dir = null;
      try {
        dir = fs.opendirSync(root);
      } catch {
        continue;
      }
      try {
        while (true) {
          if (scannedEntries >= maxEntries || Date.now() >= deadlineMs) {
            budgetHit = true;
            break;
          }
          const entry = dir.readSync();
          if (!entry) break;
          scannedEntries += 1;
          if (!entry.isDirectory()) continue;
          const hit = probeConversationTranscriptInRoot(root, entry.name);
          if (hit && hit.mtimeMs > bestMtime) {
            bestMtime = hit.mtimeMs;
            bestPath = hit.path;
          }
        }
      } finally {
        try {
          dir.closeSync();
        } catch {}
      }
    }
  }
  if (budgetHit) degraded = true;

  // Never poison the negative cache after lock contention, I/O errors, or deadline/entry exhaustion.
  const canCacheResult = !noCache && !(bestPath === null && degraded) && !(hadHeuristicOnly && degraded);
  if (canCacheResult) {
    if (_latestTranscriptScanCache.size >= LATEST_TRANSCRIPT_SCAN_CACHE_MAX && !_latestTranscriptScanCache.has(cacheKey)) {
      const oldest = _latestTranscriptScanCache.keys().next().value;
      if (oldest !== undefined) _latestTranscriptScanCache.delete(oldest);
    }
    _latestTranscriptScanCache.set(cacheKey, {
      rootStamp,
      expiresAt: nowMs + LATEST_TRANSCRIPT_SCAN_CACHE_TTL_MS,
      path: bestPath
    });
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
  const driftCount = c.prefix_drift || 0;
  const db = diag.driftBreakdown && typeof diag.driftBreakdown === "object" ? diag.driftBreakdown : null;
  const isNonNegFinite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const hasDriftBreakdown = Boolean(
    db &&
    isNonNegFinite(db.zeroRead) &&
    isNonNegFinite(db.partialRead) &&
    isNonNegFinite(db.unreportedRead) &&
    db.zeroRead + db.partialRead + db.unreportedRead === driftCount
  );
  const driftDetailVal =
    driftCount > 0 && hasDriftBreakdown
      ? `${driftCount} (zero-read: ${db.zeroRead}, partial hit: ${db.partialRead}, unreported: ${db.unreportedRead})`
      : `${driftCount}`;
  lines.push(
    `| Total cache busts detected | ${diag.bustCount} |`,
    `| Wasted re-prefill tokens | ${wastedTokensStr} |`,
    `| Bust cause: Idle TTL expiry | ${c.ttl_idle_expiry || 0} |`,
    `| Bust cause: Compaction / truncation | ${c.compaction_or_truncation || 0} |`,
    `| Bust cause: Model switch | ${c.model_switch || 0} |`,
    `| Bust cause: System injection | ${c.system_injection || 0} |`,
    `| Bust cause: Multimodal media | ${c.multimodal_media || 0} |`,
    `| Bust cause: Unattributed | ${driftDetailVal} |`,
    `| Duplicate identical read_file calls | ${diag.duplicateReadCount || 0} |`
  );
  const isValidPriorMatchItem = (b) =>
    Boolean(
      b?.priorContextMatch &&
      typeof b.priorContextMatch === "object" &&
      isNonNegFinite(b.priorContextMatch.referenceStepIndex) &&
      isNonNegFinite(b.priorContextMatch.recoveryStepIndex)
    );
  const priorKeyOf = (b) =>
    `${b.at ?? ""}|${isNonNegFinite(b.stepIndex) ? b.stepIndex : "?"}|${b.priorContextMatch.referenceStepIndex}|${b.priorContextMatch.recoveryStepIndex}`;
  const bustPriors = Array.isArray(diag.recentBusts) ? diag.recentBusts.filter(isValidPriorMatchItem) : [];
  const bustPriorCounts = new Map();
  for (const b of bustPriors) {
    const k = priorKeyOf(b);
    bustPriorCounts.set(k, (bustPriorCounts.get(k) || 0) + 1);
  }
  const extraTurnPriors = [];
  if (Array.isArray(diag.recentTurns)) {
    for (const t of diag.recentTurns) {
      if (!isValidPriorMatchItem(t)) continue;
      const k = priorKeyOf(t);
      const rem = bustPriorCounts.get(k) || 0;
      if (rem > 0) {
        bustPriorCounts.set(k, rem - 1);
      } else {
        extraTurnPriors.push(t);
      }
    }
  }
  const priorMatches = [...extraTurnPriors, ...bustPriors];
  if (priorMatches.length > 0) {
    const notes = priorMatches.map(
      (b) =>
        `step ${isNonNegFinite(b.stepIndex) ? b.stepIndex : "?"}: subsequent cache read near step ${b.priorContextMatch.referenceStepIndex} (recovered at step ${b.priorContextMatch.recoveryStepIndex})`
    );
    lines.push(`| Prior-context read match (observation) | ${priorMatches.length} (${notes.join("; ")}) |`);
  }
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
