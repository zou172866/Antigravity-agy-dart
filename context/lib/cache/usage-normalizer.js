/**
 * Multi-vendor LLM token-usage normalization, empirical cross-session TTL calibration,
 * and JSONL transcript line parsing extracted from `context/lib/cache-analyzer.js`.
 *
 * Strictly zero SQLite / store / filesystem I/O (pure functions only).
 */
import { DEFAULT_CACHE_TTL_SEC } from "./profiles.js";

const EMPIRICAL_TTL_TRIGGER_RATIO = 1.1;
export const TTL_CALIBRATION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const TTL_CALIBRATION_RECENT_MS = 7 * 24 * 3600 * 1000;
export const TTL_WARM_SAMPLE_MIN_SEC = 180;
export const TTL_COLD_SAMPLE_MIN_SEC = 120;
export const TTL_SAMPLE_MAX_SEC = 14400;
const TTL_IMPLICIT_MAX_CAP_SEC = 3600;

export function toNonNegNum(val) {
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

export function firstNonNeg(...vals) {
  for (const v of vals) {
    const n = toNonNegNum(v);
    if (n !== null) return n;
  }
  return null;
}

export function firstPosOrNonNeg(...vals) {
  let zeroCandidate = null;
  for (const v of vals) {
    const n = toNonNegNum(v);
    if (n === null) continue;
    if (n > 0) return n;
    if (zeroCandidate === null) zeroCandidate = n;
  }
  return zeroCandidate;
}

export function parsePositiveTokenLimit(val) {
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

  const disjointIn = hasInclusiveGatewayCacheDetails
    ? firstPosOrNonNeg(step.input_tokens)
    : firstPosOrNonNeg(step.input_tokens, usage.input_tokens);
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
        estimated = roundTo60(estimated);
        estimated = clampNum(estimated, floorL, Math.max(floorL, U - 60));
        confidence = allWarm.length >= 2 && coldAboveFloor.length >= 1 ? "high" : "medium";
      }
    } else {
      const recentCutoff = safeNowMs - TTL_CALIBRATION_RECENT_MS;
      let recentWarm = allWarm.filter((s) => s.atMs <= 0 || s.atMs >= recentCutoff);
      let recentCold = coldAboveFloor.filter((s) => s.atMs <= 0 || s.atMs >= recentCutoff);
      let lRec = computeWarmLowerBound(recentWarm);
      let uRec = computeColdUpperBound(recentCold);

      if (lRec !== null && uRec !== null && uRec <= lRec) {
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

export function parseTimeMs(iso) {
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
