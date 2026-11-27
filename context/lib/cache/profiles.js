/**
 * Model-aware KV-cache profiles, warmth classification, and write-surcharge cost math.
 */
export const DEFAULT_CACHE_TTL_SEC = 300; // 5 min standard prompt-cache idle TTL
export const CONTEXT_WARN_TOKENS = 130000;
export const CONTEXT_CRITICAL_TOKENS = 160000;
export const MIN_CACHEABLE_CONTEXT_TOKENS = 4000;
export const BUST_DROP_RATIO = 0.70;
export const DEFAULT_CACHE_DISCOUNT_RATE = 0.90;
export const DEFAULT_INPUT_PRICE_PER_1M = 2.50;
export const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.0;
export const DEFAULT_MEDIA_EST_TOKENS = 1600;

const WARN_WINDOW_RATIO = 0.65;
const CRITICAL_WINDOW_RATIO = 0.80;
const COLD_COMPACT_WINDOW_RATIO = 0.30;
const DELAY_HOT_WINDOW_RATIO = 0.15;

/**
 * Lightweight model-aware KV-cache profile table (ordered most-specific first).
 * Derives practical context window, default idle TTL, prompt-cache read discount,
 * API reference input price (USD / 1M tokens), and cache-write multipliers (5m & 1h).
 * Unknown/generic models safely fall back to the 200k / 300s / 90% profile (130k warn / 160k critical).
 */
export const MODEL_CACHE_PROFILES = Object.freeze([
  // Claude 4 / 4.5 / 4.6 (explicit cache write surcharge: 1.25x for 5m TTL, 2.0x for 1h TTL)
  {
    id: "claude-1m",
    pattern: /claude.*(?:^|[-_/\s[(])(?:1m|1000k)\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.90,
    inputPer1M: 3.00,
    cacheWriteMultiplier: 1.25,
    cacheWrite1hMultiplier: 2.0
  },
  {
    id: "claude-200k",
    pattern: /claude/i,
    windowTokens: 200000,
    ttlSec: 300,
    cacheDiscountRate: 0.90,
    inputPer1M: 3.00,
    cacheWriteMultiplier: 1.25,
    cacheWrite1hMultiplier: 2.0
  },
  // Gemini Flash family (matched before generic versioned Gemini profiles for accurate Flash reference pricing)
  {
    id: "gemini-flash-1m",
    pattern: /gemini.*flash/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.90,
    inputPer1M: 0.30,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  // Gemini 4 & Antigravity next-gen codenames (Neon / Carbon / Argon / Hydrogen)
  // Antigravity host enforces auto-compaction at 512k by default; honor explicit 1m/1000k tags first.
  // Gemini 4 uses implicit caching only: 95% cache read discount, 4,096-token minimum, and 2,050-token
  // multi-turn delta threshold (smaller additions re-process the trailing 2,050 tokens at standard rate).
  {
    id: "gemini-4-1m",
    pattern: /(?:gemini[-_/\s]?4(?:\.\d+)?\b|(?:^|[-_/\s.])(?:neon|carbon|argon|hydrogen)(?=$|[-_/\s.\d])).*(?:[-_/\s[(])(?:1m|1000k)\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.95,
    inputPer1M: 2.00,
    minCacheableTokens: 4096,
    minTurnDeltaForFullCache: 2050,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gemini-4-512k",
    pattern: /(?:gemini[-_/\s]?4(?:\.\d+)?\b|(?:^|[-_/\s.])(?:neon|carbon|argon|hydrogen)(?:$|[-_/\s.\d]))/i,
    windowTokens: 512000,
    ttlSec: 300,
    cacheDiscountRate: 0.95,
    inputPer1M: 2.00,
    minCacheableTokens: 4096,
    minTurnDeltaForFullCache: 2050,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gemini-3-1m",
    pattern: /gemini[-_/\s]?3(?:\.\d+)?\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.90,
    inputPer1M: 2.00,
    minCacheableTokens: 4096,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gemini-2.5-1m",
    pattern: /gemini[-_/\s]?2(?:\.\d+)?\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.75,
    inputPer1M: 1.25,
    minCacheableTokens: 2048,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gemini-1.5-1m",
    pattern: /gemini[-_/\s]?1\.5\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.75,
    inputPer1M: 1.25,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gemini-1m",
    pattern: /gemini.*1m\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.90,
    inputPer1M: 2.00,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  // OpenAI GPT-4.1 / GPT-5 / GPT-4o / o1,o3,o4
  {
    id: "gpt-4.1-1m",
    pattern: /gpt[-_]?4\.1\b/i,
    windowTokens: 1000000,
    ttlSec: 300,
    cacheDiscountRate: 0.75,
    inputPer1M: 2.00,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gpt-5-400k",
    pattern: /gpt[-_]?5(?:\.\d+)?\b/i,
    windowTokens: 400000,
    ttlSec: 300,
    cacheDiscountRate: 0.90,
    inputPer1M: 1.25,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "gpt-4o-128k",
    pattern: /gpt[-_]?4o\b/i,
    windowTokens: 128000,
    ttlSec: 300,
    cacheDiscountRate: 0.50,
    inputPer1M: 2.50,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "openai-o-200k",
    pattern: /(?:^|[-_/\s])o[134](?:[-_/\s.]|$)/i,
    windowTokens: 200000,
    ttlSec: 300,
    cacheDiscountRate: 0.75,
    inputPer1M: 2.00,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "deepseek-128k",
    pattern: /deepseek/i,
    windowTokens: 128000,
    ttlSec: 600,
    cacheDiscountRate: 0.90,
    inputPer1M: 0.28,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "qwen-256k",
    pattern: /qwen.*(?:coder|256k|3\b)/i,
    windowTokens: 256000,
    ttlSec: 300,
    cacheDiscountRate: 0.80,
    inputPer1M: 0.80,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  },
  {
    id: "qwen-128k",
    pattern: /qwen/i,
    windowTokens: 128000,
    ttlSec: 300,
    cacheDiscountRate: 0.80,
    inputPer1M: 0.40,
    cacheWriteMultiplier: 1.0,
    cacheWrite1hMultiplier: 1.0
  }
]);

const DEFAULT_MODEL_PROFILE = Object.freeze({
  id: "default-200k",
  windowTokens: 200000,
  ttlSec: DEFAULT_CACHE_TTL_SEC,
  cacheDiscountRate: DEFAULT_CACHE_DISCOUNT_RATE,
  inputPer1M: DEFAULT_INPUT_PRICE_PER_1M,
  minCacheableTokens: MIN_CACHEABLE_CONTEXT_TOKENS,
  minTurnDeltaForFullCache: 0,
  cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
  cacheWrite1hMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER
});

function resolveReferenceInputPrice(matched, rawModelName) {
  if (!rawModelName) return matched.inputPer1M ?? DEFAULT_INPUT_PRICE_PER_1M;
  if (matched.id === "claude-1m" || matched.id === "claude-200k") {
    if (/haiku/i.test(rawModelName)) return 1.00;
    if (/opus/i.test(rawModelName)) {
      if (/(?:^|[^0-9])4[._-][56](?:$|[^0-9])/i.test(rawModelName)) return 5.00;
      return 15.00;
    }
    return matched.inputPer1M;
  }
  if (matched.id === "gemini-4-1m" || matched.id === "gemini-4-512k") {
    if (/(?:^|[-_/\s.])(?:carbon|argon)(?:$|[-_/\s.\d])/i.test(rawModelName)) return 4.00;
    if (/(?:^|[-_/\s.])neon(?:$|[-_/\s.\d])/i.test(rawModelName)) return 3.00;
    if (/(?:^|[-_/\s.])hydrogen(?:$|[-_/\s.\d])/i.test(rawModelName)) return 1.50;
    return matched.inputPer1M;
  }
  return matched.inputPer1M ?? DEFAULT_INPUT_PRICE_PER_1M;
}

function resolveMinCacheableTokens(matched, rawModelName) {
  if (matched.id === "gemini-flash-1m" && rawModelName) {
    if (/gemini[-_/\s]?[34](?:\.\d+)?\b/i.test(rawModelName)) return 4096;
    if (/gemini[-_/\s]?2\.5\b/i.test(rawModelName)) return 2048;
  }
  return matched.minCacheableTokens ?? MIN_CACHEABLE_CONTEXT_TOKENS;
}

/** Match model name against lightweight model profile table and compute proportional watermarks */
export function resolveModelProfile(modelName) {
  const raw = typeof modelName === "string" ? modelName.trim() : "";
  let matched = DEFAULT_MODEL_PROFILE;
  if (raw) {
    for (const p of MODEL_CACHE_PROFILES) {
      if (p.pattern.test(raw)) {
        matched = p;
        break;
      }
    }
  }
  const inputPer1M = resolveReferenceInputPrice(matched, raw);
  const minCacheableTokens = resolveMinCacheableTokens(matched, raw);
  const minTurnDeltaForFullCache = matched.minTurnDeltaForFullCache ?? 0;
  return {
    id: matched.id,
    windowTokens: matched.windowTokens,
    ttlSec: matched.ttlSec,
    cacheDiscountRate: matched.cacheDiscountRate,
    inputPer1M,
    minCacheableTokens,
    minTurnDeltaForFullCache,
    cacheWriteMultiplier: matched.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER,
    cacheWrite1hMultiplier: matched.cacheWrite1hMultiplier ?? matched.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER,
    warnTokens: Math.round(matched.windowTokens * WARN_WINDOW_RATIO),
    criticalTokens: Math.round(matched.windowTokens * CRITICAL_WINDOW_RATIO),
    coldCompactTokens: Math.round(matched.windowTokens * COLD_COMPACT_WINDOW_RATIO),
    delayHotMinTokens: Math.round(matched.windowTokens * DELAY_HOT_WINDOW_RATIO)
  };
}

/** Compute SessionWarmth temperature & compact delay advice from live cache metrics */
export function computeCacheWarmth({
  currentContextTokens = 0,
  idleSeconds = null,
  ttlSec = DEFAULT_CACHE_TTL_SEC,
  weightedHitRate = 0,
  criticalTokens = CONTEXT_CRITICAL_TOKENS,
  coldCompactTokens = 60000,
  delayHotMinTokens = 30000,
  minCacheableTokens = MIN_CACHEABLE_CONTEXT_TOKENS
} = {}) {
  const safeTtl = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : DEFAULT_CACHE_TTL_SEC;
  const safeColdMin = Number.isFinite(coldCompactTokens) && coldCompactTokens > 0 ? coldCompactTokens : 60000;
  const safeDelayMin = Number.isFinite(delayHotMinTokens) && delayHotMinTokens > 0 ? delayHotMinTokens : 30000;
  const safeMinCacheable =
    Number.isFinite(minCacheableTokens) && minCacheableTokens > 0
      ? minCacheableTokens
      : MIN_CACHEABLE_CONTEXT_TOKENS;
  let cacheTemperature = "cold";
  if (currentContextTokens >= safeMinCacheable && Number.isFinite(idleSeconds)) {
    if (idleSeconds < Math.min(60, safeTtl)) cacheTemperature = "hot";
    else if (idleSeconds < safeTtl) cacheTemperature = "warm";
    else cacheTemperature = "cold";
  }

  let compactAdvice = "none";
  if (currentContextTokens >= criticalTokens) {
    compactAdvice = "critical_compact";
  } else if (cacheTemperature === "cold" && currentContextTokens >= safeColdMin) {
    compactAdvice = "opportunistic_cold_compact";
  } else if (cacheTemperature !== "cold" && weightedHitRate >= 0.85 && currentContextTokens >= safeDelayMin) {
    compactAdvice = "delay_hot_cache";
  }

  return { cacheTemperature, compactAdvice };
}

export function roundUsd(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Estimate input-token cost savings percentage using the active model's prompt-cache
 * read discount rate AND optional cache-write surcharge multiplier (e.g. 1.25x for 5m, 2.0x for 1h).
 * Backward compatible with 3-arg calls: estimateCostSavingsPct(cached, uncached, discountRate).
 */
export function estimateCostSavingsPct(
  cachedTokensTotal = 0,
  uncachedInputTokensTotal = 0,
  discountRate = DEFAULT_CACHE_DISCOUNT_RATE,
  cacheCreationTokensTotal = 0,
  writeMultiplier = DEFAULT_CACHE_WRITE_MULTIPLIER
) {
  const safeCached = Number.isFinite(cachedTokensTotal) && cachedTokensTotal > 0 ? cachedTokensTotal : 0;
  const safeUncached = Number.isFinite(uncachedInputTokensTotal) && uncachedInputTokensTotal > 0 ? uncachedInputTokensTotal : 0;
  const safeWrite = Number.isFinite(cacheCreationTokensTotal) && cacheCreationTokensTotal > 0 ? cacheCreationTokensTotal : 0;
  const totalInputAll = safeCached + safeUncached + safeWrite;
  if (totalInputAll <= 0) return 0;
  const rate =
    Number.isFinite(discountRate) && discountRate > 0 && discountRate <= 1
      ? discountRate
      : DEFAULT_CACHE_DISCOUNT_RATE;
  const wMult =
    Number.isFinite(writeMultiplier) && writeMultiplier >= 1
      ? writeMultiplier
      : DEFAULT_CACHE_WRITE_MULTIPLIER;
  const discountedCachedCost = (1 - rate) * safeCached;
  const writeCost = wMult * safeWrite;
  const actualCostEquiv = safeUncached + discountedCachedCost + writeCost;
  const pctVal = Number((((totalInputAll - actualCostEquiv) / totalInputAll) * 100).toFixed(1));
  return Object.is(pctVal, -0) ? 0 : pctVal;
}

/**
 * Event-driven keep-alive ping scheduler shared across 1x and multi-ping policies.
 * A keep-alive timer fires every `pingIntervalSec` seconds of continuous idle time;
 * durations strictly shorter than `pingIntervalSec` never fire a ping (0 pings).
 */
export function scheduleKeepAlivePings(durationSec, { pingIntervalSec = 255, maxPings = 1 } = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { rawPings: 0, pings: 0, capped: false };
  }
  const safeInterval = Number.isFinite(pingIntervalSec) && pingIntervalSec > 0 ? Math.floor(pingIntervalSec) : 255;
  const safeMax = Number.isFinite(maxPings) && maxPings >= 0 ? Math.floor(maxPings) : 1;
  if (safeMax === 0 || durationSec < safeInterval) {
    return { rawPings: 0, pings: 0, capped: false };
  }
  const rawPings = Math.floor(durationSec / safeInterval);
  const pings = Math.min(safeMax, rawPings);
  return {
    rawPings,
    pings,
    capped: rawPings > safeMax
  };
}

/**
 * Split a single keep-alive ping's input tokens into discounted cached-read vs full-price
 * uncached tokens, honoring model-specific trailing-window reprocessing (e.g., Gemini 4's
 * 2,050-token minimum turn delta threshold re-processes the trailing 2,050 tokens at 1.0x
 * whenever `pingOverheadTokens < minTurnDeltaForFullCache`).
 */
export function computeKeepalivePingTokenSplit(
  contextTokens = 0,
  { pingOverheadTokens = 16, tailReprocessTokens = null, profile = null } = {}
) {
  const safeCtx = Number.isFinite(contextTokens) && contextTokens > 0 ? Math.floor(contextTokens) : 0;
  const safeOverhead =
    Number.isFinite(pingOverheadTokens) && pingOverheadTokens >= 0 ? Math.floor(pingOverheadTokens) : 16;
  const rawTail =
    tailReprocessTokens !== null && tailReprocessTokens !== undefined && Number.isFinite(Number(tailReprocessTokens))
      ? Math.max(0, Math.floor(Number(tailReprocessTokens)))
      : Math.max(0, Math.floor(Number(profile?.minTurnDeltaForFullCache) || 0));
  const reprocessedTailTokens =
    safeCtx > 0 && rawTail > 0 && safeOverhead < rawTail ? Math.min(safeCtx, rawTail) : 0;
  const cachedReadTokens = Math.max(0, safeCtx - reprocessedTailTokens);
  const uncachedTokens = safeOverhead + reprocessedTailTokens;
  return {
    cachedReadTokens,
    uncachedTokens,
    reprocessedTailTokens
  };
}
