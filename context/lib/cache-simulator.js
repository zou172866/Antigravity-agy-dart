import {
  analyzeMultipleSessionsCache,
  BUST_DROP_RATIO,
  computeKeepalivePingTokenSplit,
  DEFAULT_CACHE_TTL_SEC,
  DEFAULT_INPUT_PRICE_PER_1M,
  extractStepTokenUsage,
  MIN_CACHEABLE_CONTEXT_TOKENS,
  resolveModelProfile,
  scheduleKeepAlivePings
} from "./cache-analyzer.js";

const TTL_5M_SEC = 300;
const TTL_1H_SEC = 3600;
const COLD_COMPACT_WINDOW_RATIO = 0.30;
const COLD_COMPACT_TARGET_RATIO = 0.25;
const COLD_COMPACT_MAX_TOKENS = 25000;
const EMPIRICAL_TTL_TRIGGER_RATIO = 1.1;
const RECOMMEND_MIN_SAVINGS_RATIO = 0.01;
const MAX_INLINE_SUMMARY_BYTES = 8800;
const DEFAULT_KEEPALIVE_MIN_TOKENS = 60000;
const DEFAULT_KEEPALIVE_TAIL_SEC = 1800;
const DEFAULT_PING_OVERHEAD_TOKENS = 16;
const DEFAULT_MAX_PINGS_PER_GAP = 24;

export const CUTOFF_POLICY_SPECS = Object.freeze([
  {
    id: "cutoff-strict-8k",
    label: "Output Cutoff Strict (8 KB)",
    cutoffBytes: 8192,
    summaryCapBytes: 2048
  },
  {
    id: "cutoff-balanced-16k",
    label: "Output Cutoff Balanced (16 KB)",
    cutoffBytes: 16384,
    summaryCapBytes: 4096
  },
  {
    id: "cutoff-relaxed-32k",
    label: "Output Cutoff Relaxed (32 KB)",
    cutoffBytes: 32768,
    summaryCapBytes: 8192
  }
]);

const TIE_PREFERENCE_ORDER = new Map([
  ["ttl-5m", 0],
  ["ttl-1h", 1],
  ["cutoff-balanced-16k", 2],
  ["cutoff-relaxed-32k", 3],
  ["cutoff-strict-8k", 4],
  ["cold-boundary-compact", 5]
]);

function roundUsd(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundRate(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const clamped = Math.min(1, value);
  const rounded = Number(clamped.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundPct(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(1));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatUsd(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function parseTimeMs(iso) {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function toPositiveLimit(val) {
  let n = null;
  if (typeof val === "number") {
    n = Number.isFinite(val) && val >= 0 ? val : null;
  } else if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      n = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  return n !== null && n >= 1024 ? Math.round(n) : null;
}

function readStepMaxTokenLimit(step) {
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
    const parsed = toPositiveLimit(c);
    if (parsed !== null) return parsed;
  }
  return null;
}

function isCjkCodePoint(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let quarterTokens = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      quarterTokens += 1;
    } else if (isCjkCodePoint(cp)) {
      quarterTokens += 5;
    } else if (cp > 0xffff) {
      quarterTokens += 6;
    } else {
      quarterTokens += 4;
    }
  }
  return Math.ceil(quarterTokens / 4);
}

function extractStepTextPayload(step) {
  if (!step || typeof step !== "object") return "";
  if (typeof step.content === "string") return step.content;
  if (typeof step.output === "string") return step.output;
  if (typeof step.result === "string") return step.result;
  if (Array.isArray(step.content)) {
    const parts = [];
    for (const item of step.content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object" && typeof item.text === "string") parts.push(item.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (step.content && typeof step.content === "object") {
    try {
      return JSON.stringify(step.content);
    } catch {
      return "";
    }
  }
  return "";
}

function measureToolResultStep(step) {
  const text = extractStepTextPayload(step);
  if (!text) return null;
  const inlineBytes = Buffer.byteLength(text, "utf8");
  const truncMatch = text.match(/<truncated\s+(\d+)\s+bytes>\s*$/i);
  const extraTruncBytes = truncMatch ? Number(truncMatch[1]) : 0;
  const safeExtra = Number.isFinite(extraTruncBytes) && extraTruncBytes > 0 ? extraTruncBytes : 0;
  const totalBytes = inlineBytes + safeExtra;
  if (totalBytes <= 0) return null;
  const estTokens = estimateTextTokens(text) + Math.ceil(safeExtra / 4);
  return { bytes: totalBytes, estTokens: Math.max(1, estTokens) };
}

function calibrateSessionTtl(profile, maxWarmHitGapSec, hasExplicit1hWrite = false) {
  const profileTtl = profile?.ttlSec || DEFAULT_CACHE_TTL_SEC;
  const isExtended1hTierModel =
    Boolean(profile?.id && /^claude/i.test(profile.id)) ||
    (profile?.cacheWrite1hMultiplier || 1) > (profile?.cacheWriteMultiplier || 1);

  if (hasExplicit1hWrite) {
    const floor =
      maxWarmHitGapSec !== null && maxWarmHitGapSec > TTL_1H_SEC
        ? Math.ceil(maxWarmHitGapSec / 60) * 60
        : TTL_1H_SEC;
    return Math.max(profileTtl, floor);
  }
  if (maxWarmHitGapSec === null || !(maxWarmHitGapSec > profileTtl * EMPIRICAL_TTL_TRIGGER_RATIO)) {
    return null;
  }
  const roundedFloor = Math.ceil(maxWarmHitGapSec / 60) * 60;
  if (isExtended1hTierModel) {
    return maxWarmHitGapSec <= TTL_1H_SEC ? TTL_1H_SEC : roundedFloor;
  }
  return roundedFloor;
}

function parseOptions(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  return {
    explicitTtlSec: Number.isFinite(opts.ttlSec) && opts.ttlSec > 0 ? opts.ttlSec : null,
    explicitWindowTokens: Number.isFinite(opts.windowTokens) && opts.windowTokens > 0 ? opts.windowTokens : null,
    explicitMaxTokenLimit: toPositiveLimit(opts.maxTokenLimit),
    explicitColdCompactTokens:
      Number.isFinite(opts.coldCompactTokens) && opts.coldCompactTokens > 0 ? opts.coldCompactTokens : null,
    explicitDiscountRate:
      Number.isFinite(opts.cacheDiscountRate) && opts.cacheDiscountRate > 0 && opts.cacheDiscountRate <= 1
        ? opts.cacheDiscountRate
        : null,
    explicitWriteMultiplier:
      Number.isFinite(opts.cacheWriteMultiplier) && opts.cacheWriteMultiplier >= 1
        ? opts.cacheWriteMultiplier
        : null,
    explicitWrite1hMultiplier:
      Number.isFinite(opts.cacheWrite1hMultiplier) && opts.cacheWrite1hMultiplier >= 1
        ? opts.cacheWrite1hMultiplier
        : null,
    explicitInputPricePer1M:
      Number.isFinite(opts.inputPricePer1M) && opts.inputPricePer1M > 0 ? opts.inputPricePer1M : null,
    keepaliveMinTokens:
      Number.isFinite(opts.keepaliveMinTokens) && opts.keepaliveMinTokens > 0
        ? Math.max(MIN_CACHEABLE_CONTEXT_TOKENS, Math.floor(opts.keepaliveMinTokens))
        : DEFAULT_KEEPALIVE_MIN_TOKENS,
    keepaliveTailSec:
      opts.keepaliveTailSec !== undefined &&
      opts.keepaliveTailSec !== null &&
      typeof opts.keepaliveTailSec !== "boolean" &&
      Number.isFinite(Number(opts.keepaliveTailSec)) &&
      Number(opts.keepaliveTailSec) >= 0
        ? Math.floor(Number(opts.keepaliveTailSec))
        : DEFAULT_KEEPALIVE_TAIL_SEC,
    pingOverheadTokens:
      opts.pingOverheadTokens !== undefined &&
      opts.pingOverheadTokens !== null &&
      typeof opts.pingOverheadTokens !== "boolean" &&
      Number.isFinite(Number(opts.pingOverheadTokens)) &&
      Number(opts.pingOverheadTokens) >= 0
        ? Math.floor(Number(opts.pingOverheadTokens))
        : DEFAULT_PING_OVERHEAD_TOKENS,
    maxPingsPerGap:
      Number.isFinite(opts.maxPingsPerGap) && opts.maxPingsPerGap >= 1
        ? Math.min(1000, Math.floor(opts.maxPingsPerGap))
        : DEFAULT_MAX_PINGS_PER_GAP
  };
}

/**
 * Extract a read-only turn trace from a single session's step array without mutating inputs.
 */
function extractSessionTrace(steps, parsedOpts) {
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const turns = [];
  let transcriptMaxTokenLimit = null;
  let currentModel = "";
  let prevCtxTokens = 0;
  let prevModel = "";
  let prevPlannerMs = null;
  let mediaLoadedSincePrev = false;
  let systemMsgSincePrev = false;
  let hasSeenPlanner = false;
  let totalCacheCreationTokens = 0;
  let totalCacheCreation1hTokens = 0;
  let pendingToolResults = [];

  const maxWarmGapByProfile = new Map();
  const seen1hWriteByProfile = new Map();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") continue;

    const stepLimit = readStepMaxTokenLimit(step);
    if (stepLimit !== null) {
      transcriptMaxTokenLimit = stepLimit;
    }

    if (Array.isArray(step.media) && step.media.length > 0 && hasSeenPlanner) {
      mediaLoadedSincePrev = true;
    }

    const stepType = typeof step.type === "string" ? step.type.toUpperCase() : "";

    if (stepType === "SYSTEM_MESSAGE") {
      if (hasSeenPlanner) {
        const msgText = typeof step.content === "string" ? step.content.trim() : "";
        if (msgText.length > 0) systemMsgSincePrev = true;
      }
      continue;
    }

    if (stepType === "GENERIC" || stepType === "TOOL_RESULT" || stepType === "TOOL") {
      const measured = measureToolResultStep(step);
      if (measured) pendingToolResults.push(measured);
      continue;
    }

    if (stepType !== "PLANNER_RESPONSE") continue;

    const usage = extractStepTokenUsage(step);
    const tMs = parseTimeMs(step.created_at);
    const model = typeof step.model === "string" ? step.model : "";
    const ctxTokens = usage.contextTokens;

    if (ctxTokens <= 0) {
      if (!hasSeenPlanner && tMs !== null) hasSeenPlanner = true;
      continue;
    }

    if (model) currentModel = model;
    totalCacheCreationTokens += usage.cacheCreationTokens;
    totalCacheCreation1hTokens += usage.cacheCreation1hTokens;

    const activeTurnProfile = resolveModelProfile(model || prevModel || currentModel);
    const activeMinCacheable = activeTurnProfile.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS;
    if (usage.cacheCreation1hTokens > 0) {
      seen1hWriteByProfile.set(activeTurnProfile.id, true);
    }

    const gapSec =
      hasSeenPlanner && tMs !== null && prevPlannerMs !== null && tMs >= prevPlannerMs
        ? Math.round((tMs - prevPlannerMs) / 1000)
        : null;
    const deltaTokens = hasSeenPlanner ? ctxTokens - prevCtxTokens : ctxTokens;

    let obsWasBust = false;
    let obsBustCause = null;

    if (hasSeenPlanner && prevCtxTokens >= activeMinCacheable) {
      const retainedRatio = prevCtxTokens > 0 ? usage.cacheReadTokens / prevCtxTokens : 1;
      const sameModel = !prevModel || !model || prevModel === model;
      // Align with cache-analyzer.js: Gemini 4 implicit caching re-processes the trailing
      // 2,050 tokens when a turn adds < 2,050 tokens; do not misclassify that as a cache bust.
      const tailReprocessThreshold = activeTurnProfile.minTurnDeltaForFullCache || 0;
      const isExpectedSmallDeltaTailReprocess =
        tailReprocessThreshold > 0 &&
        sameModel &&
        !mediaLoadedSincePrev &&
        !systemMsgSincePrev &&
        ctxTokens >= prevCtxTokens &&
        deltaTokens > 0 &&
        deltaTokens < tailReprocessThreshold &&
        usage.cacheReadTokens > 0 &&
        prevCtxTokens - usage.cacheReadTokens <= tailReprocessThreshold + 256;
      const isBust =
        !isExpectedSmallDeltaTailReprocess &&
        (retainedRatio < BUST_DROP_RATIO || (prevCtxTokens >= 10000 && usage.cacheReadTokens === 0));

      if (!isBust) {
        if (retainedRatio >= BUST_DROP_RATIO && usage.cacheReadTokens > 0 && gapSec !== null && sameModel) {
          const prevProfileMax = maxWarmGapByProfile.get(activeTurnProfile.id);
          if (prevProfileMax === undefined || gapSec > prevProfileMax) {
            maxWarmGapByProfile.set(activeTurnProfile.id, gapSec);
          }
        }
      } else {
        obsWasBust = true;
        const calibratedTurnTtl =
          parsedOpts.explicitTtlSec === null
            ? calibrateSessionTtl(
                activeTurnProfile,
                maxWarmGapByProfile.get(activeTurnProfile.id) ?? null,
                Boolean(seen1hWriteByProfile.get(activeTurnProfile.id))
              )
            : null;
        const turnTtlSec = parsedOpts.explicitTtlSec ?? calibratedTurnTtl ?? activeTurnProfile.ttlSec;

        if (prevModel && model && model !== prevModel) {
          obsBustCause = "model_switch";
        } else if (ctxTokens < prevCtxTokens * BUST_DROP_RATIO) {
          obsBustCause = "compaction_or_truncation";
        } else if (gapSec !== null && gapSec >= turnTtlSec) {
          obsBustCause = "ttl_idle_expiry";
        } else if (mediaLoadedSincePrev) {
          obsBustCause = "multimodal_media";
        } else if (systemMsgSincePrev) {
          obsBustCause = "system_injection";
        } else {
          obsBustCause = "prefix_drift";
        }
      }
    }

    turns.push({
      turnIndex: turns.length,
      model: model || prevModel || "",
      prevModel,
      turnProfile: activeTurnProfile,
      minCacheableTokens: activeMinCacheable,
      gapSec,
      ctxTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheCreation1hTokens: usage.cacheCreation1hTokens,
      uncachedTokens: usage.inputTokens,
      prevCtxTokens,
      obsWasBust,
      obsBustCause,
      incomingToolResults: pendingToolResults
    });

    pendingToolResults = [];
    prevCtxTokens = ctxTokens;
    if (model) prevModel = model;
    if (tMs !== null) prevPlannerMs = tMs;
    hasSeenPlanner = true;
    mediaLoadedSincePrev = false;
    systemMsgSincePrev = false;
  }

  if (turns.length === 0) return null;

  const matchedProfile = resolveModelProfile(currentModel);
  const windowTokens =
    parsedOpts.explicitWindowTokens ??
    parsedOpts.explicitMaxTokenLimit ??
    transcriptMaxTokenLimit ??
    matchedProfile.windowTokens;

  const activeMaxWarmGap = maxWarmGapByProfile.get(matchedProfile.id) ?? null;
  const activeHas1hWrite = Boolean(seen1hWriteByProfile.get(matchedProfile.id));
  const calibratedTtl =
    parsedOpts.explicitTtlSec === null
      ? calibrateSessionTtl(matchedProfile, activeMaxWarmGap, activeHas1hWrite)
      : null;
  const effectiveTtlSec = parsedOpts.explicitTtlSec ?? calibratedTtl ?? matchedProfile.ttlSec;

  const cacheDiscountRate = parsedOpts.explicitDiscountRate ?? matchedProfile.cacheDiscountRate;
  const baseWriteMult = matchedProfile.cacheWriteMultiplier ?? 1.0;
  const longWriteMult = matchedProfile.cacheWrite1hMultiplier ?? baseWriteMult;

  let obsWriteMult;
  if (parsedOpts.explicitWriteMultiplier !== null) {
    obsWriteMult = parsedOpts.explicitWriteMultiplier;
  } else if (totalCacheCreation1hTokens > 0 && totalCacheCreationTokens > 0) {
    const tokens1h = Math.min(totalCacheCreation1hTokens, totalCacheCreationTokens);
    const tokens5m = totalCacheCreationTokens - tokens1h;
    obsWriteMult = Number(
      ((tokens5m * baseWriteMult + tokens1h * longWriteMult) / totalCacheCreationTokens).toFixed(4)
    );
  } else if (effectiveTtlSec >= TTL_1H_SEC) {
    obsWriteMult = longWriteMult;
  } else {
    obsWriteMult = baseWriteMult;
  }

  const inputPricePer1M =
    parsedOpts.explicitInputPricePer1M ?? matchedProfile.inputPer1M ?? DEFAULT_INPUT_PRICE_PER_1M;
  const coldCompactTokens =
    parsedOpts.explicitColdCompactTokens ?? Math.round(windowTokens * COLD_COMPACT_WINDOW_RATIO);

  for (const t of turns) {
    const p = t.turnProfile || matchedProfile;
    const pMaxGap = maxWarmGapByProfile.get(p.id) ?? null;
    const pHas1h = Boolean(seen1hWriteByProfile.get(p.id));
    const pCalTtl = parsedOpts.explicitTtlSec === null ? calibrateSessionTtl(p, pMaxGap, pHas1h) : null;
    const pTtlSec = parsedOpts.explicitTtlSec ?? pCalTtl ?? p.ttlSec;
    const pBaseWrite = p.cacheWriteMultiplier ?? 1.0;
    const pLongWrite = p.cacheWrite1hMultiplier ?? pBaseWrite;
    let pObsWrite;
    if (parsedOpts.explicitWriteMultiplier !== null) {
      pObsWrite = parsedOpts.explicitWriteMultiplier;
    } else if (t.cacheCreation1hTokens > 0 && t.cacheCreationTokens > 0) {
      const c1h = Math.min(t.cacheCreation1hTokens, t.cacheCreationTokens);
      const c5m = t.cacheCreationTokens - c1h;
      pObsWrite = (c5m * pBaseWrite + c1h * pLongWrite) / t.cacheCreationTokens;
    } else if (pTtlSec >= TTL_1H_SEC) {
      pObsWrite = pLongWrite;
    } else {
      pObsWrite = pBaseWrite;
    }
    t.discountRate = parsedOpts.explicitDiscountRate ?? p.cacheDiscountRate;
    t.baseWriteMult = pBaseWrite;
    t.longWriteMult = pLongWrite;
    t.obsWriteMult = pObsWrite;
    t.inputPricePer1M = parsedOpts.explicitInputPricePer1M ?? p.inputPer1M ?? DEFAULT_INPUT_PRICE_PER_1M;
  }

  return {
    profile: matchedProfile,
    minCacheableTokens: matchedProfile.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS,
    model: currentModel || null,
    windowTokens,
    effectiveTtlSec,
    cacheDiscountRate,
    baseWriteMult,
    longWriteMult,
    obsWriteMult,
    inputPricePer1M,
    coldCompactTokens,
    hasExplicitCacheCreation: totalCacheCreationTokens > 0,
    turns
  };
}

function splitProportionalNewTokens(newTokens, obsCacheCreation, obsUncached) {
  if (newTokens <= 0) return { simWrite: 0, simUncached: 0 };
  const obsPool = obsCacheCreation + obsUncached;
  if (obsPool <= 0) return { simWrite: 0, simUncached: newTokens };
  const writeRatio = obsCacheCreation / obsPool;
  const simWrite = Math.round(newTokens * writeRatio);
  const simUncached = Math.max(0, newTokens - simWrite);
  return { simWrite, simUncached };
}

function computeTokenCostUsd(cachedTokens, uncachedTokens, writeTokens, discountRate, writeMult, inputPricePer1M) {
  const equiv = uncachedTokens + (1 - discountRate) * cachedTokens + writeMult * writeTokens;
  return equiv * (inputPricePer1M / 1e6);
}

function buildPolicyResult({
  id,
  label,
  cachedTokens,
  totalInputTokens,
  busts,
  wastedTokens,
  costUsd,
  observedCostUsd,
  notes
}) {
  const safeCost = roundUsd(Math.max(0, costUsd));
  const safeObsCost = roundUsd(Math.max(0, observedCostUsd));
  const deltaUsd = id === "observed" ? 0 : roundUsd(safeCost - safeObsCost);
  const deltaPct =
    id === "observed" || safeObsCost <= 0 ? 0 : roundPct(((safeCost - safeObsCost) / safeObsCost) * 100);

  return {
    id,
    label,
    projectedHitRate: totalInputTokens > 0 ? roundRate(cachedTokens / totalInputTokens) : 0,
    projectedBusts: Math.max(0, Math.round(busts)),
    projectedWastedTokens: Math.max(0, Math.round(wastedTokens)),
    projectedInputCostUsd: safeCost,
    deltaUsdVsObserved: deltaUsd,
    deltaPctVsObserved: deltaPct,
    notes
  };
}

/**
 * Simulate strict 5-minute (300s) or extended 1-hour (3600s) TTL with accurate write multipliers.
 */
function replayTtlPolicy(traces, parsedOpts, observedCostUsd, { id, label, ttlSec, tier }) {
  let totalCached = 0;
  let totalInput = 0;
  let totalBusts = 0;
  let totalWasted = 0;
  let totalCostUsd = 0;
  let totalWriteTokens = 0;
  let avoidedIdleBusts = 0;
  let preservedLongWarmHits = 0;
  let inducedIdleBusts = 0;
  let maxWriteMultUsed = 1.0;

  for (const trace of traces) {
    const rawPolicyWriteMult =
      tier === "1h"
        ? (parsedOpts.explicitWrite1hMultiplier ?? trace.longWriteMult)
        : (parsedOpts.explicitWriteMultiplier ?? trace.baseWriteMult);
    // When transcripts omit cache_creation_tokens, observed baseline bills uncached tokens at 1.0x.
    // Measure incremental tier surcharge relative to `obsWriteMult` so replaying the already-calibrated
    // observed TTL (whether 5m or empirically-calibrated 1h) yields 0% phantom cost bias.
    if (rawPolicyWriteMult > maxWriteMultUsed) maxWriteMultUsed = rawPolicyWriteMult;

    const isExplicitWriteModel =
      trace.baseWriteMult > 1.0 || trace.longWriteMult > 1.0 || rawPolicyWriteMult > 1.0;

    let sessCached = 0;
    let sessUncached = 0;
    let sessWrite = 0;
    let sessCostRaw = 0;
    let prevSimCtx = 0;

    for (let idx = 0; idx < trace.turns.length; idx++) {
      const turn = trace.turns[idx];
      const simCtx = turn.ctxTokens;
      const turnMinCacheable = turn.minCacheableTokens ?? trace.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS;
      let simRead = 0;
      let simWrite = 0;
      let simUncached = 0;

      if (idx === 0 || prevSimCtx < turnMinCacheable) {
        const isSmallGapExpired = idx > 0 && turn.gapSec !== null && turn.gapSec >= ttlSec;
        if (turn.cacheReadTokens > 0 && !isSmallGapExpired) {
          // Mid-conversation snippet or small-prefix warm read
          simRead = Math.min(turn.cacheReadTokens, simCtx);
          const newTokens = Math.max(0, simCtx - simRead);
          if (isExplicitWriteModel && trace.hasExplicitCacheCreation) {
            simWrite = Math.min(turn.cacheCreationTokens, newTokens);
            simUncached = Math.max(0, newTokens - simWrite);
          } else if (isExplicitWriteModel && newTokens > 0) {
            simWrite = newTokens;
            simUncached = 0;
          } else {
            simUncached = newTokens;
          }
        } else {
          // Cold start
          simRead = 0;
          const newTokens = simCtx;
          if (isExplicitWriteModel && simCtx >= turnMinCacheable) {
            if (trace.hasExplicitCacheCreation && turn.cacheCreationTokens > 0) {
              const tail = Math.min(turn.uncachedTokens, newTokens);
              simWrite = Math.max(0, newTokens - tail);
              simUncached = tail;
            } else {
              simWrite = newTokens;
              simUncached = 0;
            }
          } else {
            simUncached = newTokens;
          }
        }
      } else {
        const isModelSwitch = Boolean(turn.prevModel && turn.model && turn.model !== turn.prevModel);
        const isCompaction = turn.obsBustCause === "compaction_or_truncation";
        const isTtlExpired = turn.gapSec !== null && turn.gapSec >= ttlSec;
        const isNonTtlObsBust =
          turn.obsWasBust &&
          turn.obsBustCause !== "ttl_idle_expiry" &&
          !isModelSwitch &&
          !isCompaction;

        const simBust = isModelSwitch || isCompaction || isTtlExpired || isNonTtlObsBust;

        if (simBust) {
          totalBusts += 1;
          if (isTtlExpired && !turn.obsWasBust) {
            inducedIdleBusts += 1;
          }

          if (isModelSwitch || isTtlExpired) {
            simRead = 0;
          } else {
            simRead = Math.min(turn.cacheReadTokens, simCtx);
          }

          const expectedReusable = Math.min(prevSimCtx, simCtx);
          totalWasted += Math.max(0, expectedReusable - simRead);

          const newTokens = Math.max(0, simCtx - simRead);
          if (isExplicitWriteModel && simCtx >= turnMinCacheable) {
            if (turn.obsWasBust && turn.cacheCreationTokens > 0) {
              const tail = Math.min(turn.uncachedTokens, newTokens);
              simWrite = Math.max(0, newTokens - tail);
              simUncached = tail;
            } else if (!turn.obsWasBust) {
              const turnDelta = Math.max(0, simCtx - prevSimCtx);
              const tail = Math.min(turn.uncachedTokens, turnDelta);
              simWrite = Math.max(0, newTokens - tail);
              simUncached = tail;
            } else {
              simWrite = newTokens;
              simUncached = 0;
            }
          } else {
            simUncached = newTokens;
          }
        } else {
          // Warm hit under this TTL policy
          if (turn.obsWasBust && turn.obsBustCause === "ttl_idle_expiry") {
            avoidedIdleBusts += 1;
            simRead = Math.min(prevSimCtx, simCtx);
            const newTokens = Math.max(0, simCtx - simRead);
            if (isExplicitWriteModel) {
              if (trace.hasExplicitCacheCreation) {
                const tail = Math.min(turn.uncachedTokens, newTokens);
                simWrite = Math.max(0, newTokens - tail);
                simUncached = tail;
              } else {
                simWrite = newTokens;
                simUncached = 0;
              }
            } else {
              simUncached = newTokens;
            }
          } else {
            if (tier === "1h" && turn.gapSec !== null && turn.gapSec >= TTL_5M_SEC && turn.gapSec < TTL_1H_SEC) {
              preservedLongWarmHits += 1;
            }
            simRead = Math.min(turn.cacheReadTokens, simCtx);
            const newTokens = Math.max(0, simCtx - simRead);
            if (isExplicitWriteModel) {
              if (trace.hasExplicitCacheCreation) {
                simWrite = Math.min(turn.cacheCreationTokens, newTokens);
                simUncached = Math.max(0, newTokens - simWrite);
              } else {
                simWrite = newTokens;
                simUncached = 0;
              }
            } else {
              simUncached = newTokens;
            }
          }
        }
      }

      sessCached += simRead;
      sessWrite += simWrite;
      sessUncached += simUncached;
      const tRawPolicyWrite =
        tier === "1h"
          ? (parsedOpts.explicitWrite1hMultiplier ?? turn.longWriteMult ?? trace.longWriteMult)
          : (parsedOpts.explicitWriteMultiplier ?? turn.baseWriteMult ?? trace.baseWriteMult);
      const tObsWrite = turn.obsWriteMult ?? trace.obsWriteMult;
      const tPolicyWriteMult = trace.hasExplicitCacheCreation
        ? tRawPolicyWrite
        : Math.max(1.0, 1.0 + (tRawPolicyWrite - tObsWrite));
      sessCostRaw += computeTokenCostUsd(
        simRead,
        simUncached,
        simWrite,
        turn.discountRate ?? trace.cacheDiscountRate,
        tPolicyWriteMult,
        turn.inputPricePer1M ?? trace.inputPricePer1M
      );
      prevSimCtx = simCtx;
    }

    totalCached += sessCached;
    totalWriteTokens += sessWrite;
    totalInput += sessCached + sessUncached + sessWrite;
    totalCostUsd += roundUsd(sessCostRaw);
  }

  const writeLabel = maxWriteMultUsed > 1.0 ? `${maxWriteMultUsed.toFixed(2)}x write` : "1.0x implicit write";
  let notes;
  if (traces.length === 0) {
    notes = `No usage turns to replay (${ttlSec}s TTL, ${writeLabel}).`;
  } else if (tier === "1h") {
    let bustPart;
    if (avoidedIdleBusts > 0 && preservedLongWarmHits > 0) {
      bustPart = `avoids ${avoidedIdleBusts} idle bust(s) & preserves ${preservedLongWarmHits} warm hit(s) in 5m-60m gaps`;
    } else if (avoidedIdleBusts > 0) {
      bustPart = `avoids ${avoidedIdleBusts} idle bust(s) in 5m-60m gaps`;
    } else if (preservedLongWarmHits > 0) {
      bustPart = `preserves ${preservedLongWarmHits} warm hit(s) across 5m-60m gaps`;
    } else {
      bustPart = "0 idle busts avoided (no 5m-60m gaps)";
    }
    const writePart =
      maxWriteMultUsed > 1.0 && totalWriteTokens > 0
        ? `; ${writeLabel} on ${totalWriteTokens.toLocaleString("en-US")} written tokens`
        : `; ${writeLabel}`;
    notes = `${bustPart}${writePart}.`;
  } else {
    const bustPart =
      inducedIdleBusts > 0
        ? `triggers ${inducedIdleBusts} extra idle bust(s) on >=300s gaps`
        : `${totalBusts} total bust(s) under strict 300s TTL`;
    notes = `${bustPart}; ${writeLabel}.`;
  }

  return buildPolicyResult({
    id,
    label,
    cachedTokens: totalCached,
    totalInputTokens: totalInput,
    busts: totalBusts,
    wastedTokens: totalWasted,
    costUsd: totalCostUsd,
    observedCostUsd,
    notes
  });
}

/**
 * Simulate compacting context down to min(prevCtx * 25%, 25k) at TTL-expired high-context cold boundaries.
 */
function replayColdBoundaryCompactPolicy(traces, observedCostUsd) {
  let totalCached = 0;
  let totalInput = 0;
  let totalBusts = 0;
  let totalWasted = 0;
  let totalCostUsd = 0;
  let compactionsTriggered = 0;
  let tokensShedAtBoundaries = 0;

  for (const trace of traces) {
    let sessCached = 0;
    let sessUncached = 0;
    let sessWrite = 0;
    let sessCostRaw = 0;
    let episodeReduction = 0;
    let prevSimCtx = 0;

    for (let idx = 0; idx < trace.turns.length; idx++) {
      const turn = trace.turns[idx];
      let simRead = 0;
      let simWrite = 0;
      let simUncached = 0;
      let simCtx = turn.ctxTokens;

      if (idx > 0 && turn.obsBustCause === "compaction_or_truncation") {
        // Observed session already compacted; align episode baseline
        episodeReduction = 0;
      }

      const qualifiesColdCompact =
        idx > 0 &&
        turn.obsWasBust &&
        turn.gapSec !== null &&
        turn.gapSec >= trace.effectiveTtlSec &&
        prevSimCtx >= trace.coldCompactTokens &&
        turn.obsBustCause !== "compaction_or_truncation";

      if (qualifiesColdCompact) {
        const compactedPrefix = Math.round(
          Math.min(prevSimCtx * COLD_COMPACT_TARGET_RATIO, COLD_COMPACT_MAX_TOKENS)
        );
        const shedNow = Math.max(0, prevSimCtx - compactedPrefix);
        episodeReduction = Math.max(0, turn.prevCtxTokens - compactedPrefix);
        const turnDelta = Math.max(0, turn.ctxTokens - turn.prevCtxTokens);
        simCtx = compactedPrefix + turnDelta;

        compactionsTriggered += 1;
        tokensShedAtBoundaries += shedNow;

        // Already a cold boundary due to TTL expiry; only the retained compacted prefix is refilled (not brand-new turnDelta)
        totalBusts += 1;
        simRead = 0;
        totalWasted += Math.min(prevSimCtx, compactedPrefix);

        const split = splitProportionalNewTokens(simCtx, turn.cacheCreationTokens, turn.uncachedTokens);
        simWrite = split.simWrite;
        simUncached = split.simUncached;
      } else if (episodeReduction === 0) {
        // Unmodified observed turn
        simRead = turn.cacheReadTokens;
        simWrite = turn.cacheCreationTokens;
        simUncached = turn.uncachedTokens;
        simCtx = turn.ctxTokens;
        if (turn.obsWasBust) {
          totalBusts += 1;
          totalWasted += Math.max(0, Math.min(turn.prevCtxTokens, turn.ctxTokens) - turn.cacheReadTokens);
        }
      } else {
        // Carry reduced context forward across subsequent turns in this episode
        simCtx = Math.max(0, turn.ctxTokens - episodeReduction);
        const turnMinCacheable = turn.minCacheableTokens ?? trace.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS;
        if (idx > 0 && prevSimCtx >= turnMinCacheable) {
          const retentionRatio =
            turn.prevCtxTokens > 0 ? Math.min(1, turn.cacheReadTokens / turn.prevCtxTokens) : 0;
          if (turn.obsWasBust) {
            totalBusts += 1;
            const coldReset =
              turn.obsBustCause === "ttl_idle_expiry" || turn.obsBustCause === "model_switch";
            simRead = coldReset ? 0 : Math.min(simCtx, Math.round(prevSimCtx * retentionRatio));
            totalWasted += Math.max(0, Math.min(prevSimCtx, simCtx) - simRead);
          } else {
            simRead = Math.min(simCtx, Math.round(prevSimCtx * retentionRatio));
          }
        } else {
          simRead = 0;
        }
        const simNew = Math.max(0, simCtx - simRead);
        const split = splitProportionalNewTokens(simNew, turn.cacheCreationTokens, turn.uncachedTokens);
        simWrite = split.simWrite;
        simUncached = split.simUncached;
      }

      sessCached += simRead;
      sessWrite += simWrite;
      sessUncached += simUncached;
      sessCostRaw += computeTokenCostUsd(
        simRead,
        simUncached,
        simWrite,
        turn.discountRate ?? trace.cacheDiscountRate,
        turn.obsWriteMult ?? trace.obsWriteMult,
        turn.inputPricePer1M ?? trace.inputPricePer1M
      );
      prevSimCtx = simCtx;
    }

    totalCached += sessCached;
    totalInput += sessCached + sessUncached + sessWrite;
    totalCostUsd += roundUsd(sessCostRaw);
  }

  let notes;
  if (traces.length === 0) {
    notes = "No usage turns to evaluate for cold-boundary compaction.";
  } else if (compactionsTriggered > 0) {
    notes = `Triggered ${compactionsTriggered} cold-boundary compaction(s), shedding ${tokensShedAtBoundaries.toLocaleString("en-US")} expired prefix tokens before re-prefill.`;
  } else {
    notes = "No TTL-expired turns exceeded the 30% high-context cold-compaction threshold.";
  }

  return buildPolicyResult({
    id: "cold-boundary-compact",
    label: "Cold-Boundary Compaction",
    cachedTokens: totalCached,
    totalInputTokens: totalInput,
    busts: totalBusts,
    wastedTokens: totalWasted,
    costUsd: totalCostUsd,
    observedCostUsd,
    notes
  });
}

/**
 * Simulate capping oversized single-step tool result payloads (> cutoffBytes) to compact <= 8.8 KB summaries
 * and propagating the avoided context-growth delta across subsequent turns.
 */
function replayCutoffPolicy(traces, observedCostUsd, { id, label, cutoffBytes, summaryCapBytes }) {
  const safeSummaryCap = Math.min(summaryCapBytes, MAX_INLINE_SUMMARY_BYTES);
  let totalCached = 0;
  let totalInput = 0;
  let totalBusts = 0;
  let totalWasted = 0;
  let totalCostUsd = 0;
  let cappedPayloads = 0;
  let avoidedGrowthTokens = 0;

  for (const trace of traces) {
    let sessCached = 0;
    let sessUncached = 0;
    let sessWrite = 0;
    let sessCostRaw = 0;
    let cumulativeAvoided = 0;
    let prevSimCtx = 0;

    for (let idx = 0; idx < trace.turns.length; idx++) {
      const turn = trace.turns[idx];

      if (idx > 0 && turn.obsBustCause === "compaction_or_truncation") {
        // Compaction drops historical raw tool dumps
        cumulativeAvoided = 0;
      }

      let totalIncomingTok = 0;
      let postCutoffTok = 0;
      let rawAvoidedSum = 0;
      for (const payload of turn.incomingToolResults) {
        totalIncomingTok += payload.estTokens;
        if (payload.bytes > cutoffBytes) {
          cappedPayloads += 1;
          const summaryRatio = safeSummaryCap / payload.bytes;
          const summaryEst = Math.min(payload.estTokens, Math.max(1, Math.round(payload.estTokens * summaryRatio)));
          postCutoffTok += summaryEst;
          rawAvoidedSum += Math.max(0, payload.estTokens - summaryEst);
        } else {
          postCutoffTok += payload.estTokens;
        }
      }

      let effectiveStepAvoided = 0;
      if (rawAvoidedSum > 0 && totalIncomingTok > 0) {
        const obsGrowth = idx > 0 ? Math.max(0, turn.ctxTokens - turn.prevCtxTokens) : turn.ctxTokens;
        const savedRatio = (totalIncomingTok - postCutoffTok) / totalIncomingTok;
        effectiveStepAvoided = Math.min(rawAvoidedSum, Math.round(obsGrowth * savedRatio));
      }

      const prevCarry = cumulativeAvoided;
      cumulativeAvoided = prevCarry + effectiveStepAvoided;
      avoidedGrowthTokens += effectiveStepAvoided;

      let simRead;
      let simWrite;
      let simUncached;
      let simCtx;

      if (cumulativeAvoided === 0) {
        simRead = turn.cacheReadTokens;
        simWrite = turn.cacheCreationTokens;
        simUncached = turn.uncachedTokens;
        simCtx = turn.ctxTokens;
        if (turn.obsWasBust) {
          totalBusts += 1;
          totalWasted += Math.max(0, Math.min(turn.prevCtxTokens, turn.ctxTokens) - turn.cacheReadTokens);
        }
      } else {
        simRead = Math.max(0, turn.cacheReadTokens - prevCarry);
        const carryRemainder = Math.max(0, prevCarry - turn.cacheReadTokens);
        const newReduction = effectiveStepAvoided + carryRemainder;
        const obsNewPool = turn.cacheCreationTokens + turn.uncachedTokens;
        const clampedRed = Math.min(newReduction, obsNewPool);
        const remainingNew = Math.max(0, obsNewPool - clampedRed);
        const split = splitProportionalNewTokens(remainingNew, turn.cacheCreationTokens, turn.uncachedTokens);
        simWrite = split.simWrite;
        simUncached = split.simUncached;
        simCtx = simRead + simWrite + simUncached;

        if (turn.obsWasBust) {
          totalBusts += 1;
          totalWasted += Math.max(0, Math.min(prevSimCtx, simCtx) - simRead);
        }
      }

      sessCached += simRead;
      sessWrite += simWrite;
      sessUncached += simUncached;
      sessCostRaw += computeTokenCostUsd(
        simRead,
        simUncached,
        simWrite,
        turn.discountRate ?? trace.cacheDiscountRate,
        turn.obsWriteMult ?? trace.obsWriteMult,
        turn.inputPricePer1M ?? trace.inputPricePer1M
      );
      prevSimCtx = simCtx;
    }

    totalCached += sessCached;
    totalInput += sessCached + sessUncached + sessWrite;
    totalCostUsd += roundUsd(sessCostRaw);
  }

  const cutoffKb = Math.round(cutoffBytes / 1024);
  const summaryKb = (safeSummaryCap / 1024).toFixed(1).replace(/\.0$/, "");
  let notes;
  if (traces.length === 0) {
    notes = `No usage turns to evaluate for ${cutoffKb} KB cutoff.`;
  } else if (cappedPayloads > 0) {
    notes = `Capped ${cappedPayloads} payload(s) >${cutoffKb} KB to <=${summaryKb} KB summary (avoided ${avoidedGrowthTokens.toLocaleString("en-US")} context-growth tokens).`;
  } else {
    notes = `No single-step tool payloads exceeded ${cutoffKb} KB.`;
  }

  return buildPolicyResult({
    id,
    label,
    cachedTokens: totalCached,
    totalInputTokens: totalInput,
    busts: totalBusts,
    wastedTokens: totalWasted,
    costUsd: totalCostUsd,
    observedCostUsd,
    notes
  });
}

/**
 * Counterfactual Host/Proxy-Only Keep-Alive Policy Replay (`keepalive-1x` & `keepalive-unlimited`).
 * Quantifies ping cache-read overhead, end-of-session walk-away waste, and apparent vs real-turn hit rates.
 */
function replayKeepAlivePolicy(traces, parsedOpts, observedCostUsd, { id, label, mode }) {
  let totalCached = 0;
  let totalInput = 0;
  let userCached = 0;
  let userInput = 0;
  let totalBusts = 0;
  let totalWasted = 0;
  let totalCostUsd = 0;
  let interTurnPings = 0;
  let tailPings = 0;
  let wastedPings = 0;
  let avoidedIdleBusts = 0;
  let cappedGapCount = 0;

  for (const trace of traces) {
    const pingIntervalSec = Math.max(60, Math.floor(trace.effectiveTtlSec * 0.85));
    const isExplicitWriteModel = trace.baseWriteMult > 1.0 || trace.longWriteMult > 1.0;

    let sessCached = 0;
    let sessUncached = 0;
    let sessWrite = 0;
    let sessCostRaw = 0;
    let prevSimCtx = 0;
    let prevDiscountRate = trace.cacheDiscountRate;
    let prevInputPricePer1M = trace.inputPricePer1M;
    let prevObsWriteMult = trace.obsWriteMult;
    let prevTailReprocessTokens = trace.profile?.minTurnDeltaForFullCache ?? 0;
    const maxPings = mode === "1x" ? 1 : parsedOpts.maxPingsPerGap;

    for (let idx = 0; idx < trace.turns.length; idx++) {
      const turn = trace.turns[idx];
      const simCtx = turn.ctxTokens;
      const sameModel = !turn.prevModel || !turn.model || turn.model === turn.prevModel;
      const isCompaction = turn.obsBustCause === "compaction_or_truncation";
      const isNonTtlObsBust =
        turn.obsWasBust &&
        turn.obsBustCause !== "ttl_idle_expiry" &&
        sameModel &&
        !isCompaction;

      let bridgedByKeepAlive = false;

      if (
        idx > 0 &&
        prevSimCtx >= parsedOpts.keepaliveMinTokens &&
        turn.gapSec !== null &&
        turn.gapSec >= pingIntervalSec
      ) {
        const schedule = scheduleKeepAlivePings(turn.gapSec, { pingIntervalSec, maxPings });
        if (schedule.pings > 0) {
          if (mode !== "1x" && schedule.capped) {
            cappedGapCount += 1;
          }
          const pingDiscount = prevDiscountRate ?? turn.discountRate ?? trace.cacheDiscountRate;
          const pingPrice = prevInputPricePer1M ?? turn.inputPricePer1M ?? trace.inputPricePer1M;
          const pingWriteMult = prevObsWriteMult ?? turn.obsWriteMult ?? trace.obsWriteMult;
          const split = computeKeepalivePingTokenSplit(prevSimCtx, {
            pingOverheadTokens: parsedOpts.pingOverheadTokens,
            tailReprocessTokens: prevTailReprocessTokens
          });
          interTurnPings += schedule.pings;
          const pingRead = split.cachedReadTokens * schedule.pings;
          const pingUncached = split.uncachedTokens * schedule.pings;
          sessCached += pingRead;
          sessUncached += pingUncached;
          sessCostRaw += computeTokenCostUsd(
            pingRead,
            pingUncached,
            0,
            pingDiscount,
            pingWriteMult,
            pingPrice
          );
          const maxReachableSec = schedule.pings * pingIntervalSec + trace.effectiveTtlSec;
          if (
            sameModel &&
            !isCompaction &&
            turn.gapSec >= trace.effectiveTtlSec &&
            turn.gapSec < maxReachableSec &&
            !isNonTtlObsBust
          ) {
            bridgedByKeepAlive = true;
            if (turn.obsWasBust && turn.obsBustCause === "ttl_idle_expiry") {
              avoidedIdleBusts += 1;
            }
          } else {
            wastedPings += schedule.pings;
          }
        }
      }

      let simRead = 0;
      let simWrite = 0;
      let simUncached = 0;

      if (bridgedByKeepAlive) {
        simRead = Math.min(prevSimCtx, simCtx);
        const newTokens = Math.max(0, simCtx - simRead);
        if (isExplicitWriteModel) {
          if (trace.hasExplicitCacheCreation) {
            const tail = Math.min(turn.uncachedTokens, newTokens);
            simWrite = Math.max(0, newTokens - tail);
            simUncached = tail;
          } else {
            simWrite = newTokens;
            simUncached = 0;
          }
        } else {
          simWrite = 0;
          simUncached = newTokens;
        }
      } else {
        simRead = turn.cacheReadTokens;
        simWrite = turn.cacheCreationTokens;
        simUncached = turn.uncachedTokens;
        if (turn.obsWasBust) {
          totalBusts += 1;
          totalWasted += Math.max(0, Math.min(turn.prevCtxTokens, turn.ctxTokens) - turn.cacheReadTokens);
        }
      }

      userCached += simRead;
      userInput += simRead + simWrite + simUncached;
      sessCached += simRead;
      sessWrite += simWrite;
      sessUncached += simUncached;
      const tDiscount = turn.discountRate ?? trace.cacheDiscountRate;
      const tWriteMult = turn.obsWriteMult ?? trace.obsWriteMult;
      const tPrice = turn.inputPricePer1M ?? trace.inputPricePer1M;
      sessCostRaw += computeTokenCostUsd(simRead, simUncached, simWrite, tDiscount, tWriteMult, tPrice);

      prevSimCtx = simCtx;
      prevDiscountRate = tDiscount;
      prevObsWriteMult = tWriteMult;
      prevInputPricePer1M = tPrice;
      prevTailReprocessTokens = turn.turnProfile?.minTurnDeltaForFullCache ?? trace.profile?.minTurnDeltaForFullCache ?? 0;
    }

    const lastTurn = trace.turns[trace.turns.length - 1];
    if (
      lastTurn &&
      lastTurn.ctxTokens >= parsedOpts.keepaliveMinTokens &&
      parsedOpts.keepaliveTailSec > 0
    ) {
      const tailSchedule = scheduleKeepAlivePings(parsedOpts.keepaliveTailSec, { pingIntervalSec, maxPings });
      const nTail = tailSchedule.pings;
      if (nTail > 0) {
        tailPings += nTail;
        wastedPings += nTail;
        const split = computeKeepalivePingTokenSplit(lastTurn.ctxTokens, {
          pingOverheadTokens: parsedOpts.pingOverheadTokens,
          tailReprocessTokens: prevTailReprocessTokens
        });
        const pingRead = split.cachedReadTokens * nTail;
        const pingUncached = split.uncachedTokens * nTail;
        sessCached += pingRead;
        sessUncached += pingUncached;
        sessCostRaw += computeTokenCostUsd(
          pingRead,
          pingUncached,
          0,
          prevDiscountRate,
          prevObsWriteMult,
          prevInputPricePer1M
        );
      }
    }

    totalCached += sessCached;
    totalInput += sessCached + sessUncached + sessWrite;
    totalCostUsd += roundUsd(sessCostRaw);
  }

  const keepalivePings = interTurnPings + tailPings;
  const userTurnHitRate = userInput > 0 ? roundRate(userCached / userInput) : 0;
  let notes;
  if (traces.length === 0) {
    notes = "Host/proxy-only (excl. out/thinking); no usage turns to replay.";
  } else {
    const capSuffix =
      cappedGapCount > 0 ? `, ${cappedGapCount} gap(s) capped at ${parsedOpts.maxPingsPerGap}x` : "";
    notes = `Host/proxy-only (excl. out/thinking); ${keepalivePings} ping(s) (${wastedPings} wasted), avoids ${avoidedIdleBusts} idle bust(s), real-turn hit ${(userTurnHitRate * 100).toFixed(1)}%${capSuffix}.`;
  }

  return {
    ...buildPolicyResult({
      id,
      label,
      cachedTokens: totalCached,
      totalInputTokens: totalInput,
      busts: totalBusts,
      wastedTokens: totalWasted,
      costUsd: totalCostUsd,
      observedCostUsd,
      notes
    }),
    hypothetical: true,
    userTurnHitRate,
    keepalivePings,
    interTurnPings,
    tailPings,
    wastedPings,
    avoidedIdleBusts
  };
}

function selectRecommendation(policies, observedDiag, traces = []) {
  const obsPolicy = policies.find((p) => p.id === "observed");
  const ttl5m = policies.find((p) => p.id === "ttl-5m");
  const ttl1h = policies.find((p) => p.id === "ttl-1h");
  const coldCompact = policies.find((p) => p.id === "cold-boundary-compact");
  const strict8k = policies.find((p) => p.id === "cutoff-strict-8k");
  const balanced16k = policies.find((p) => p.id === "cutoff-balanced-16k");

  const obsCost = obsPolicy?.projectedInputCostUsd || 0;
  if (!observedDiag || observedDiag.turnsWithUsage === 0 || obsCost <= 0) {
    return {
      recommendedPolicy: "observed",
      rationale: "No turns with token usage found in the provided transcripts; keeping observed baseline."
    };
  }

  const qualifying = policies
    .filter((p) => p.id !== "observed" && !p.hypothetical)
    .filter((p) => (obsCost - p.projectedInputCostUsd) / obsCost >= RECOMMEND_MIN_SAVINGS_RATIO)
    .sort((a, b) => {
      const diff = a.projectedInputCostUsd - b.projectedInputCostUsd;
      if (Math.abs(diff) > 1e-9) return diff;
      const pa = TIE_PREFERENCE_ORDER.get(a.id) ?? 99;
      const pb = TIE_PREFERENCE_ORDER.get(b.id) ?? 99;
      return pa - pb;
    });

  const winner = qualifying.length > 0 ? qualifying[0] : obsPolicy;
  const parts = [];

  if (winner.id === "observed") {
    parts.push(
      `Observed baseline (${formatUsd(obsCost)}) is already within 1% of the best simulated policy; no policy switch is needed.`
    );
  } else {
    const savedUsd = roundUsd(obsCost - winner.projectedInputCostUsd);
    const savedPct = Math.abs(winner.deltaPctVsObserved).toFixed(1);
    parts.push(
      `Recommend \`${winner.id}\` (${winner.label}): projected input cost drops from ${formatUsd(obsCost)} to ${formatUsd(winner.projectedInputCostUsd)} (saves ${formatUsd(savedUsd)} / ${savedPct}%).`
    );
  }

  const hasExtendedWriteSurcharge = traces.some((t) => t.longWriteMult > t.baseWriteMult);
  if (ttl5m && ttl1h) {
    const ttlDiff = roundUsd(ttl1h.projectedInputCostUsd - ttl5m.projectedInputCostUsd);
    if (ttlDiff < -0.0005) {
      parts.push(
        hasExtendedWriteSurcharge
          ? `1h TTL beats 5m TTL by ${formatUsd(Math.abs(ttlDiff))} because avoided idle busts outweigh the 2.0x extended-TTL cache-write surcharge.`
          : `1h TTL beats 5m TTL by ${formatUsd(Math.abs(ttlDiff))} by preserving cache warmth across 5m-60m gaps with 1.0x implicit writes.`
      );
    } else if (ttlDiff > 0.0005) {
      parts.push(
        `5m TTL beats 1h TTL by ${formatUsd(ttlDiff)} because the 2.0x extended write surcharge outweighs avoided idle busts on this cadence.`
      );
    }
  }

  if (coldCompact && winner.id !== "cold-boundary-compact" && coldCompact.deltaPctVsObserved <= -5) {
    parts.push(
      `Cold-boundary compaction alone would save ${formatUsd(Math.abs(coldCompact.deltaUsdVsObserved))} (${Math.abs(coldCompact.deltaPctVsObserved).toFixed(1)}%).`
    );
  }

  if (winner.id === "cutoff-strict-8k" && balanced16k && balanced16k.deltaPctVsObserved <= -1) {
    parts.push(
      `For fewer paged recalls, \`cutoff-balanced-16k\` still saves ${formatUsd(Math.abs(balanced16k.deltaUsdVsObserved))} (${Math.abs(balanced16k.deltaPctVsObserved).toFixed(1)}%).`
    );
  } else if (!winner.id.startsWith("cutoff-")) {
    const bestCutoff =
      balanced16k && balanced16k.deltaPctVsObserved <= -1
        ? balanced16k
        : strict8k && strict8k.deltaPctVsObserved <= -1
          ? strict8k
          : null;
    if (bestCutoff) {
      parts.push(
        `Tighter output cutoff (\`${bestCutoff.id}\`) would trim ${formatUsd(Math.abs(bestCutoff.deltaUsdVsObserved))} (${Math.abs(bestCutoff.deltaPctVsObserved).toFixed(1)}%) from oversized tool payloads.`
      );
    }
  }

  const keepUnlim = policies.find((p) => p.id === "keepalive-unlimited");
  if (keepUnlim && obsPolicy && keepUnlim.projectedHitRate > obsPolicy.projectedHitRate) {
    if (keepUnlim.projectedInputCostUsd > obsCost + 0.0005) {
      const extraUsd = roundUsd(keepUnlim.projectedInputCostUsd - obsCost);
      parts.push(
        `Counterfactual \`keepalive-unlimited\` inflates apparent hit rate to ${(keepUnlim.projectedHitRate * 100).toFixed(1)}% (real-turn ${(keepUnlim.userTurnHitRate * 100).toFixed(1)}%), but ${keepUnlim.keepalivePings} auto-ping(s) (${keepUnlim.wastedPings} wasted) cost +${formatUsd(extraUsd)} over observed baseline.`
      );
    } else if (coldCompact && keepUnlim.projectedInputCostUsd > coldCompact.projectedInputCostUsd + 0.0005) {
      const extraVsCompact = roundUsd(keepUnlim.projectedInputCostUsd - coldCompact.projectedInputCostUsd);
      parts.push(
        `Counterfactual \`keepalive-unlimited\` reaches ${(keepUnlim.projectedHitRate * 100).toFixed(1)}% apparent hit rate via ${keepUnlim.keepalivePings} ping(s) (${keepUnlim.wastedPings} wasted), costing +${formatUsd(extraVsCompact)} more than \`cold-boundary-compact\`.`
      );
    }
  }

  return {
    recommendedPolicy: winner.id,
    rationale: parts.join(" ")
  };
}

/**
 * Offline KV-Cache Policy Replay Simulator.
 * Replays historical transcript step arrays across comparable KV-cache & output-cutoff policies
 * without mutating inputs.
 */
export function simulateCachePolicies(sessions, options = {}) {
  const safeSessions = Array.isArray(sessions)
    ? sessions
        .map((s) => (Array.isArray(s) ? s : Array.isArray(s?.steps) ? s.steps : null))
        .filter((arr) => Array.isArray(arr) && arr.length > 0)
    : [];
  const parsedOpts = parseOptions(options);
  const observedDiag = analyzeMultipleSessionsCache(safeSessions, options);

  const traces = [];
  for (const steps of safeSessions) {
    const trace = extractSessionTrace(steps, parsedOpts);
    if (trace) traces.push(trace);
  }

  const observedCostUsd = roundUsd(observedDiag.estimatedInputCostUsd || 0);
  const observedTotalInput =
    (observedDiag.cachedTokensTotal || 0) +
    (observedDiag.uncachedInputTokensTotal || 0) +
    (observedDiag.cacheCreationTokensTotal || 0);

  const observedNotes =
    observedDiag.turnsWithUsage > 0
      ? `Actual recorded transcript metrics (${observedDiag.bustCount} bust(s), ${(observedDiag.cacheWriteMultiplier || 1).toFixed(2)}x write).`
      : "No turns with token usage recorded.";

  const observedPolicy = buildPolicyResult({
    id: "observed",
    label: "Observed Baseline",
    cachedTokens: observedDiag.cachedTokensTotal || 0,
    totalInputTokens: observedTotalInput,
    busts: observedDiag.bustCount || 0,
    wastedTokens: observedDiag.wastedTokensTotal || 0,
    costUsd: observedCostUsd,
    observedCostUsd,
    notes: observedNotes
  });

  const ttl5mPolicy = replayTtlPolicy(traces, parsedOpts, observedCostUsd, {
    id: "ttl-5m",
    label: "TTL 5m (300s)",
    ttlSec: TTL_5M_SEC,
    tier: "5m"
  });

  const ttl1hPolicy = replayTtlPolicy(traces, parsedOpts, observedCostUsd, {
    id: "ttl-1h",
    label: "TTL 1h (3600s)",
    ttlSec: TTL_1H_SEC,
    tier: "1h"
  });

  const coldCompactPolicy = replayColdBoundaryCompactPolicy(traces, observedCostUsd);

  const cutoffPolicies = CUTOFF_POLICY_SPECS.map((spec) =>
    replayCutoffPolicy(traces, observedCostUsd, spec)
  );

  const keepalive1xPolicy = replayKeepAlivePolicy(traces, parsedOpts, observedCostUsd, {
    id: "keepalive-1x",
    label: "Keep-Alive (1x Capped)",
    mode: "1x"
  });

  const keepaliveUnlimitedPolicy = replayKeepAlivePolicy(traces, parsedOpts, observedCostUsd, {
    id: "keepalive-unlimited",
    label: "Keep-Alive (Unlimited Auto)",
    mode: "unlimited"
  });

  const policies = [
    observedPolicy,
    ttl5mPolicy,
    ttl1hPolicy,
    coldCompactPolicy,
    ...cutoffPolicies,
    keepalive1xPolicy,
    keepaliveUnlimitedPolicy
  ];

  const { recommendedPolicy, rationale } = selectRecommendation(policies, observedDiag, traces);
  const models = Array.from(new Set(traces.map((t) => t.model).filter(Boolean)));

  return {
    sessions: observedDiag.sessions || 0,
    turnsWithUsage: observedDiag.turnsWithUsage || 0,
    warmTurns: observedDiag.warmTurns || 0,
    models,
    observed: {
      weightedHitRate: roundRate(observedDiag.weightedHitRate || 0),
      bustCount: observedDiag.bustCount || 0,
      wastedTokensTotal: observedDiag.wastedTokensTotal || 0,
      estimatedInputCostUsd: observedCostUsd,
      cacheDiscountRate: observedDiag.cacheDiscountRate ?? 0.90,
      cacheWriteMultiplier: observedDiag.cacheWriteMultiplier ?? 1.0,
      peakContextTokens: observedDiag.peakContextTokens || 0
    },
    policies,
    recommendedPolicy,
    rationale
  };
}

/**
 * Format an offline KV-Cache policy simulation report as a clean GitHub-flavored Markdown table.
 */
export function formatSimulationMarkdown(report) {
  const safe = report && typeof report === "object" ? report : {};
  const policies = Array.isArray(safe.policies) ? safe.policies : [];
  const sessions = Number.isFinite(safe.sessions) ? safe.sessions : 0;
  const turnsWithUsage = Number.isFinite(safe.turnsWithUsage) ? safe.turnsWithUsage : 0;
  const models = Array.isArray(safe.models) && safe.models.length > 0 ? safe.models.join(", ") : "unknown";
  const recommendedPolicy = safe.recommendedPolicy || "observed";
  const rationale = safe.rationale || "No simulation data available.";

  const pct = (r) => `${(Number.isFinite(r) ? r * 100 : 0).toFixed(1)}%`;
  const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

  const lines = [
    "# agy-dart Offline KV-Cache Policy Replay Simulation",
    "",
    `- **Sessions replayed**: ${sessions} (turns with usage: ${turnsWithUsage})`,
    `- **Models observed**: ${esc(models)}`,
    `- **Recommended policy**: \`${esc(recommendedPolicy)}\``,
    `- **Rationale**: ${esc(rationale)}`,
    "",
    "| Policy | Hit Rate | Busts | Wasted Tokens | Est. Input Cost | Delta vs Observed | Notes |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | :--- |"
  ];

  for (const p of policies) {
    const marker = p.id === recommendedPolicy ? " **(rec)**" : p.hypothetical ? " *(sim-only)*" : "";
    let deltaCell;
    if (p.id === "observed") {
      deltaCell = "baseline";
    } else {
      const signUsd = p.deltaUsdVsObserved > 0 ? "+" : "";
      const signPct = p.deltaPctVsObserved > 0 ? "+" : "";
      deltaCell = `${signUsd}${formatUsd(p.deltaUsdVsObserved)} (${signPct}${Number(p.deltaPctVsObserved || 0).toFixed(1)}%)`;
    }
    const wastedStr = (Number.isFinite(p.projectedWastedTokens) ? p.projectedWastedTokens : 0).toLocaleString("en-US");
    lines.push(
      `| \`${esc(p.id)}\`${marker} | ${pct(p.projectedHitRate)} | ${Number.isFinite(p.projectedBusts) ? p.projectedBusts : 0} | ${wastedStr} | ${formatUsd(p.projectedInputCostUsd)} | ${deltaCell} | ${esc(p.notes)} |`
    );
  }

  return lines.join("\n");
}
