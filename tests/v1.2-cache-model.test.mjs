import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  estimateCostSavingsPct,
  extractStepMaxTokenLimit,
  extractStepTokenUsage,
  formatCacheDiagMarkdown,
  MODEL_CACHE_PROFILES,
  resolveModelProfile
} from "../context/lib/cache-analyzer.js";
import { ContextModeStore } from "../context/lib/store.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { fetchDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, scriptRel)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

test("P0-2.1: MODEL_CACHE_PROFILES covers Gemini 4 / Neon / Carbon / Argon / Hydrogen, Flash, Claude 4/4.5/4.6, GPT-5/4.1/o-series, DeepSeek, Qwen with transparent pricing", () => {
  // Every profile entry exposes positive reference input pricing and valid write multipliers
  for (const profile of MODEL_CACHE_PROFILES) {
    assert.ok(profile.inputPer1M > 0, `${profile.id} must define positive inputPer1M`);
    assert.ok(profile.cacheWriteMultiplier >= 1.0, `${profile.id} must define cacheWriteMultiplier >= 1.0`);
    assert.ok(profile.cacheWrite1hMultiplier >= profile.cacheWriteMultiplier, `${profile.id} cacheWrite1hMultiplier >= 5m`);
  }

  // Gemini 4 & Antigravity next-gen codenames: 512k default effective window (Antigravity auto-compaction ceiling),
  // 95% implicit cache read discount, 4,096-token min cacheable threshold, 2,050-token multi-turn delta rule, and per-variant pricing.
  const expectedGemini4Price = (name) => {
    if (/(?:^|[-_/\s.])(?:carbon|argon)(?:$|[-_/\s.\d])/i.test(name)) return 4.00;
    if (/(?:^|[-_/\s.])neon(?:$|[-_/\s.\d])/i.test(name)) return 3.00;
    if (/(?:^|[-_/\s.])hydrogen(?:$|[-_/\s.\d])/i.test(name)) return 1.50;
    return 2.00;
  };
  for (const name of [
    "gemini-4",
    "gemini-4-pro",
    "gemini-4.5-pro",
    "gemini-4-neon",
    "gemini-4-neon-xhigh",
    "neon",
    "antigravity-neon",
    "MODEL_NEON_HIGH",
    "carbon",
    "gemini-4-carbon-high",
    "argon",
    "argon-v2",
    "hydrogen",
    "hydrogen-pro",
    "gemini-4-hydrogen-xhigh"
  ]) {
    const p = resolveModelProfile(name);
    assert.equal(p.id, "gemini-4-512k", `Expected ${name} -> gemini-4-512k, got ${p.id}`);
    assert.equal(p.windowTokens, 512000);
    assert.equal(p.warnTokens, 332800);
    assert.equal(p.criticalTokens, 409600);
    assert.equal(p.coldCompactTokens, 153600);
    assert.equal(p.cacheDiscountRate, 0.95);
    assert.equal(p.minCacheableTokens, 4096);
    assert.equal(p.minTurnDeltaForFullCache, 2050);
    assert.equal(p.cacheWriteMultiplier, 1.0);
    assert.equal(p.cacheWrite1hMultiplier, 1.0);
    assert.equal(p.inputPer1M, expectedGemini4Price(name), `Expected ${name} inputPer1M`);
  }

  // Explicit 1M / 1000k Gemini 4 variants preserve 1M window & per-variant pricing
  for (const g41mName of ["google/carbon-1m", "gemini-4-1m", "gemini-4-pro[1m]", "gemini-4-neon-1000k"]) {
    const p = resolveModelProfile(g41mName);
    assert.equal(p.id, "gemini-4-1m", `Expected ${g41mName} -> gemini-4-1m, got ${p.id}`);
    assert.equal(p.windowTokens, 1000000);
    assert.equal(p.cacheDiscountRate, 0.95);
    assert.equal(p.minCacheableTokens, 4096);
    assert.equal(p.minTurnDeltaForFullCache, 2050);
    assert.equal(p.cacheWriteMultiplier, 1.0);
    assert.equal(p.cacheWrite1hMultiplier, 1.0);
    assert.equal(p.inputPer1M, expectedGemini4Price(g41mName), `Expected ${g41mName} inputPer1M`);
  }

  // Word-boundary safety: unrelated words containing "argon"/"neon" must NOT false-match
  assert.equal(resolveModelProfile("jargon-model").id, "default-200k");
  assert.equal(resolveModelProfile("bicarbonate-v1").id, "default-200k");
  assert.equal(resolveModelProfile("jargon-1m").id, "default-200k");

  // Gemini Flash family: 1M window, 90% discount, lower Flash reference pricing
  for (const flashName of ["gemini-2.5-flash", "gemini-3-flash", "gemini-4-flash", "gemini-flash-latest"]) {
    const p = resolveModelProfile(flashName);
    assert.equal(p.id, "gemini-flash-1m", `Expected ${flashName} -> gemini-flash-1m, got ${p.id}`);
    assert.equal(p.windowTokens, 1000000);
    assert.equal(p.cacheDiscountRate, 0.90);
    assert.equal(p.cacheWriteMultiplier, 1.0);
    assert.ok(p.inputPer1M < 1.0, `Expected Flash inputPer1M < $1.00, got ${p.inputPer1M}`);
  }

  // Gemini 2.5 Pro & 3.1 Pro preserve existing discount rates
  assert.equal(resolveModelProfile("gemini-2.5-pro").cacheDiscountRate, 0.75);
  assert.equal(resolveModelProfile("gemini-3.1-pro").cacheDiscountRate, 0.90);

  // Claude 4 / 4.5 / 4.6 (200k & 1M, 1.25x 5m / 2.0x 1h write surcharge)
  const cSonnet46 = resolveModelProfile("claude-sonnet-4-6");
  assert.equal(cSonnet46.id, "claude-200k");
  assert.equal(cSonnet46.windowTokens, 200000);
  assert.equal(cSonnet46.cacheWriteMultiplier, 1.25);
  assert.equal(cSonnet46.cacheWrite1hMultiplier, 2.0);
  assert.equal(cSonnet46.inputPer1M, 3.00);

  const cOpus46 = resolveModelProfile("claude-opus-4-6");
  assert.equal(cOpus46.id, "claude-200k");
  assert.equal(cOpus46.inputPer1M, 5.00);
  assert.equal(cOpus46.cacheWriteMultiplier, 1.25);
  assert.equal(cOpus46.cacheWrite1hMultiplier, 2.0);

  const cHaiku45 = resolveModelProfile("claude-haiku-4-5");
  assert.equal(cHaiku45.id, "claude-200k");
  assert.equal(cHaiku45.inputPer1M, 1.00);

  for (const c1mName of ["claude-sonnet-4-6-1m", "claude-opus-4-6[1m]", "claude-4.5-1000k"]) {
    const p = resolveModelProfile(c1mName);
    assert.equal(p.id, "claude-1m", `Expected ${c1mName} -> claude-1m`);
    assert.equal(p.windowTokens, 1000000);
    assert.equal(p.cacheWriteMultiplier, 1.25);
    assert.equal(p.cacheWrite1hMultiplier, 2.0);
  }

  // GPT-5 / GPT-4.1 / o1/o3/o4 / DeepSeek / Qwen
  assert.equal(resolveModelProfile("gpt-5.2").id, "gpt-5-400k");
  assert.equal(resolveModelProfile("gpt-4.1").id, "gpt-4.1-1m");
  assert.equal(resolveModelProfile("o4-mini").id, "openai-o-200k");
  assert.equal(resolveModelProfile("o3").id, "openai-o-200k");
  assert.equal(resolveModelProfile("deepseek-chat").ttlSec, 600);
  assert.equal(resolveModelProfile("qwen3-coder").windowTokens, 256000);
});

test("P0-2.2: Per-conversation maxTokenLimit detection from transcript & options with explicit > transcript > profile precedence", () => {
  const nowMs = Date.parse("2026-11-20T15:00:00Z");
  const at = new Date(nowMs - 15 * 1000).toISOString();

  // Direct extractor covers all supported nested fields and ignores junk/tiny values
  assert.equal(extractStepMaxTokenLimit({ max_token_limit: 500000 }), 500000);
  assert.equal(extractStepMaxTokenLimit({ maxTokenLimit: 1000000 }), 1000000);
  assert.equal(extractStepMaxTokenLimit({ model_config: { max_token_limit: 400000 } }), 400000);
  assert.equal(extractStepMaxTokenLimit({ metadata: { maxTokenLimit: 320000 } }), 320000);
  assert.equal(extractStepMaxTokenLimit({ max_token_limit: 0 }), null);
  assert.equal(extractStepMaxTokenLimit({ max_token_limit: -100 }), null);
  assert.equal(extractStepMaxTokenLimit({ max_token_limit: 200 }), null);
  assert.equal(extractStepMaxTokenLimit({ max_token_limit: "invalid" }), null);

  // 1. Transcript step.max_token_limit overrides claude-200k profile to 1M (windowSource: "transcript")
  const steps1 = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: at,
      model: "claude-sonnet-4-6",
      max_token_limit: 1000000,
      input_tokens: 10000,
      cache_read_tokens: 170000,
      output_tokens: 200
    }
  ];
  const d1 = analyzeTranscriptCache(steps1, { nowMs });
  assert.equal(d1.windowSource, "transcript");
  assert.equal(d1.modelProfile.windowSource, "transcript");
  assert.equal(d1.modelProfile.windowTokens, 1000000);
  assert.equal(d1.warnTokens, 650000);
  assert.equal(d1.criticalTokens, 800000);
  assert.equal(d1.watermark, "ok", "180k of 1M transcript maxTokenLimit must NOT falsely trigger 200k critical");

  // 2. Non-planner metadata step carrying model_config.max_token_limit also sets transcript window
  const steps2 = [
    { type: "SYSTEM_MESSAGE", content: "init", model_config: { max_token_limit: 500000 } },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: at,
      model: "claude-sonnet-4-6",
      input_tokens: 20000,
      cache_read_tokens: 390000,
      output_tokens: 200
    }
  ];
  const d2 = analyzeTranscriptCache(steps2, { nowMs });
  assert.equal(d2.windowSource, "transcript");
  assert.equal(d2.modelProfile.windowTokens, 500000);
  assert.equal(d2.warnTokens, 325000);
  assert.equal(d2.criticalTokens, 400000);
  assert.equal(d2.watermark, "critical");

  // 3. step.metadata.maxTokenLimit works as well
  const steps3 = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: at,
      model: "unknown-custom-model",
      metadata: { maxTokenLimit: 256000 },
      input_tokens: 10000,
      cache_read_tokens: 90000
    }
  ];
  const d3 = analyzeTranscriptCache(steps3, { nowMs });
  assert.equal(d3.windowSource, "transcript");
  assert.equal(d3.modelProfile.windowTokens, 256000);

  // 4. options.maxTokenLimit overrides transcript/profile with windowSource: "explicit"
  const d4 = analyzeTranscriptCache(steps1, { nowMs, maxTokenLimit: 300000 });
  assert.equal(d4.windowSource, "explicit");
  assert.equal(d4.modelProfile.windowTokens, 300000);

  // 5. options.windowTokens takes TOP priority over BOTH options.maxTokenLimit and transcript max_token_limit
  const d5 = analyzeTranscriptCache(steps1, { nowMs, maxTokenLimit: 300000, windowTokens: 128000 });
  assert.equal(d5.windowSource, "explicit");
  assert.equal(d5.modelProfile.windowTokens, 128000);

  // 6. Fallback with no explicit/transcript limit uses profile
  const d6 = analyzeTranscriptCache(
    [{ type: "PLANNER_RESPONSE", step_index: 1, created_at: at, model: "neon", input_tokens: 10000, cache_read_tokens: 50000 }],
    { nowMs }
  );
  assert.equal(d6.windowSource, "profile");
  assert.equal(d6.modelProfile.windowTokens, 512000);
  assert.equal(d6.warnTokens, 332800);
  assert.equal(d6.criticalTokens, 409600);
});

test("P0-2.3: Multi-provider usage extraction (Anthropic, Gemini, OpenAI, Antigravity) prevents double-counting and tracks thinking tokens", () => {
  const nowMs = Date.parse("2026-11-20T15:00:00Z");
  const iso = (s) => new Date(nowMs - s * 1000).toISOString();

  // 1. Gemini nested usageMetadata: promptTokenCount INCLUDES cachedContentTokenCount -> NO double counting!
  const gemUsage = extractStepTokenUsage({
    usage: {
      promptTokenCount: 100000,
      cachedContentTokenCount: 80000,
      candidatesTokenCount: 450,
      thoughtsTokenCount: 3200
    }
  });
  assert.equal(gemUsage.contextTokens, 100000);
  assert.equal(gemUsage.cacheReadTokens, 80000);
  assert.equal(gemUsage.inputTokens, 20000);
  assert.equal(gemUsage.outputTokens, 450);
  assert.equal(gemUsage.thinkingTokens, 3200);

  const gemDiag = analyzeTranscriptCache(
    [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(30),
        model: "gemini-4-pro",
        usage: { promptTokenCount: 100000, cachedContentTokenCount: 80000, candidatesTokenCount: 400, thoughtsTokenCount: 2500 }
      }
    ],
    { nowMs }
  );
  assert.equal(gemDiag.currentContextTokens, 100000);
  assert.equal(gemDiag.cachedTokensTotal, 80000);
  assert.equal(gemDiag.uncachedInputTokensTotal, 20000);
  assert.equal(gemDiag.thinkingTokensTotal, 2500);
  assert.equal(gemDiag.weightedHitRate, 0.8);

  // 2. OpenAI nested usage: prompt_tokens INCLUDES prompt_tokens_details.cached_tokens -> NO double counting!
  const oaiDiag = analyzeTranscriptCache(
    [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(25),
        model: "gpt-5",
        usage: {
          prompt_tokens: 60000,
          prompt_tokens_details: { cached_tokens: 45000 },
          completion_tokens: 500,
          completion_tokens_details: { reasoning_tokens: 1800 }
        }
      }
    ],
    { nowMs }
  );
  assert.equal(oaiDiag.currentContextTokens, 60000);
  assert.equal(oaiDiag.cachedTokensTotal, 45000);
  assert.equal(oaiDiag.uncachedInputTokensTotal, 15000);
  assert.equal(oaiDiag.outputTokensTotal, 500);
  assert.equal(oaiDiag.thinkingTokensTotal, 1800);
  assert.equal(oaiDiag.weightedHitRate, 0.75);

  // 3. Anthropic nested usage: input_tokens, cache_creation_input_tokens, cache_read_input_tokens are DISJOINT
  const antDiag = analyzeTranscriptCache(
    [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(40),
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 2000,
          cache_creation_input_tokens: 48000,
          cache_read_input_tokens: 0,
          output_tokens: 300
        }
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(20),
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 50000,
          output_tokens: 250
        }
      }
    ],
    { nowMs }
  );
  assert.equal(antDiag.turnsWithUsage, 2);
  assert.equal(antDiag.bustCount, 0, "Turn 2 reading 50k created in Turn 1 (48k+2k) is a 100% warm hit");
  assert.equal(antDiag.currentContextTokens, 55000);
  assert.equal(antDiag.cacheCreationTokensTotal, 48000);
  assert.equal(antDiag.cachedTokensTotal, 50000);
  assert.equal(antDiag.uncachedInputTokensTotal, 7000);
  assert.equal(antDiag.outputTokensTotal, 550);

  // 4. Hybrid wrapper (top-level input_tokens: 0 alongside Gemini usage.promptTokenCount) does not lose promptTokenCount
  const hybridUsage = extractStepTokenUsage({
    input_tokens: 0,
    usage: { promptTokenCount: 100000, cachedContentTokenCount: 80000 }
  });
  assert.equal(hybridUsage.contextTokens, 100000);
  assert.equal(hybridUsage.inputTokens, 20000);
  assert.equal(hybridUsage.cacheReadTokens, 80000);

  // 5. Malformed / boolean / zero / negative inputs never produce NaN or bogus counts
  const emptyDiag = analyzeTranscriptCache(
    [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        input_tokens: true,
        cache_read_tokens: NaN,
        max_token_limit: true,
        usage: { promptTokenCount: -5 }
      }
    ],
    { nowMs }
  );
  assert.equal(emptyDiag.turnsWithUsage, 0);
  assert.equal(emptyDiag.windowSource, "profile");
  assert.equal(emptyDiag.estimatedInputCostUsd, 0);
  assert.equal(emptyDiag.estimatedSavedUsd, 0);
  assert.equal(emptyDiag.estimatedWastedUsd, 0);
  assert.equal(emptyDiag.estimatedCostSavingsPct, 0);
});

test("P0-2.4: Cache-write surcharge (1.25x / 2.0x) and API-equivalent USD cost, savings, waste & Markdown report", () => {
  // Backward-compatible 3-arg call
  assert.equal(estimateCostSavingsPct(90000, 10000, 0.90), 81.0);

  // Pure cold cache write at 1.25x surcharge -> -25.0% net savings (costs 25% more than uncached!)
  assert.equal(estimateCostSavingsPct(0, 0, 0.90, 100000, 1.25), -25.0);
  // Pure cold cache write at 2.0x (1h TTL) surcharge -> -100.0% net savings
  assert.equal(estimateCostSavingsPct(0, 0, 0.90, 100000, 2.0), -100.0);

  // 100k write (1.25x) + 400k reads (0.1x) + 10k uncached (1.0x) = 175k actual vs 510k baseline -> 65.7%
  assert.equal(estimateCostSavingsPct(400000, 10000, 0.90, 100000, 1.25), 65.7);
  // Same with 2.0x 1h write: 250k actual vs 510k baseline -> 51.0%
  assert.equal(estimateCostSavingsPct(400000, 10000, 0.90, 100000, 2.0), 51.0);

  // Full session USD math on Claude Sonnet 4.6 ($3.00 / 1M input, 90% read discount, 1.25x 5m write)
  const t0 = Date.parse("2026-11-20T14:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();
  const claudeSteps = [
    // Turn 1: 100k cache write + 0 uncached -> cost = 100k * 1.25 * $3/1M = $0.375
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 0, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0, output_tokens: 100 }
    },
    // Turn 2: 100k cache read + 10k uncached -> cost = (100k * 0.1 + 10k) * $3/1M = $0.06
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(20),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 100 }
    },
    // Turn 3: Prefix drift bust -> 100k re-written to cache + 10k uncached (wasted = 110k: 100k rewritten + 10k uncached)
    // Cost = (100k * 1.25 + 10k) * $3/1M = $0.405
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(40),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 0, output_tokens: 100 }
    }
  ];

  const diag = analyzeTranscriptCache(claudeSteps, { nowMs: t0 + 50000 });
  assert.equal(diag.cacheWriteMultiplier, 1.25);
  assert.equal(diag.cacheCreationTokensTotal, 200000);
  assert.equal(diag.cachedTokensTotal, 100000);
  assert.equal(diag.uncachedInputTokensTotal, 20000);
  // Actual input cost = $0.375 + $0.06 + $0.405 = $0.84
  assert.equal(diag.estimatedInputCostUsd, 0.84);
  // Baseline cost = 320k * $3/1M = $0.96 -> Saved = $0.96 - $0.84 = $0.12 (12.5%)
  assert.equal(diag.estimatedSavedUsd, 0.12);
  assert.equal(diag.estimatedCostSavingsPct, 12.5);
  // Wasted on bust: 100k rewritten * (1.25 - 0.10) + 10k uncached * 0.90 = 124k equiv * $3/1M = $0.372
  assert.equal(diag.wastedTokensTotal, 110000);
  assert.equal(diag.estimatedWastedUsd, 0.372);

  // Multi-session aggregation sums USD & cache creation cleanly
  const agg = analyzeMultipleSessionsCache([claudeSteps, claudeSteps], { nowMs: t0 + 50000 });
  assert.equal(agg.cacheCreationTokensTotal, 400000);
  assert.equal(agg.estimatedInputCostUsd, 1.68);
  assert.equal(agg.estimatedSavedUsd, 0.24);
  assert.equal(agg.estimatedWastedUsd, 0.744);
  assert.equal(agg.cacheWriteMultiplier, 1.25);

  // Markdown report renders USD savings/waste, cache write tokens, windowSource & ttlSource
  const md = formatCacheDiagMarkdown(diag);
  assert.ok(md.includes("| Est. input cost savings (at 90% cache discount) | 12.5% ($0.12 saved) |"));
  assert.ok(md.includes("| Est. API-equivalent input cost | $0.84 (wasted: $0.37) |"));
  assert.ok(md.includes("| Cache write (creation) tokens | 200,000 (1.25x write) |"));
  assert.ok(md.includes("profile, TTL 300s [profile]"));
});

test("P0-2.5: Empirical TTL auto-calibration snaps Claude 1h sessions to 3600s, uses observed floor for other models, and suppresses false 5m alerts", () => {
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // 1. Claude 1h-TTL session: Turn 1 -> 600s idle -> Turn 2 warm hit (100% retained!)
  const claude1hSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 80000, cache_read_input_tokens: 0, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(600), // 10 minutes idle -> STILL WARM HIT!
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 82000, output_tokens: 200 }
    }
  ];

  // Evaluate at 900s idle (15 min after Turn 2): would falsely trigger 5m TTL expiry without auto-calibration!
  const diagAt15m = analyzeTranscriptCache(claude1hSteps, { nowMs: t0 + (600 + 900) * 1000 });
  assert.equal(diagAt15m.maxWarmHitGapSec, 600);
  assert.equal(diagAt15m.ttlSource, "empirical");
  assert.equal(diagAt15m.cacheTtlSec, 3600);
  assert.equal(diagAt15m.cacheWriteMultiplier, 2.0, "Calibrated 1h Claude session should switch to 2.0x cache-write multiplier");
  assert.equal(diagAt15m.ttlStatus, "warm");
  assert.equal(diagAt15m.ttlRemainingSec, 2700);
  assert.equal(diagAt15m.cacheTemperature, "warm");

  // evaluateCacheAlerts MUST NOT emit a false 5-minute TTL alert at 15 min idle!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-ttl-cal-"));
  const tmpDb = path.join(tmpDir, "context.db");
  try {
    const store = new ContextModeStore({ dbPath: tmpDb });
    const alerts15m = evaluateCacheAlerts(diagAt15m, { sessionId: "cal-1h-sess", store });
    assert.equal(alerts15m.length, 0, `Expected 0 false TTL alerts at 15m idle, got: ${JSON.stringify(alerts15m)}`);

    // At 3700s idle (> 3600s calibrated TTL), real expiry alert FIRES with "calibrated KV-cache TTL" and USD hint
    const diagAt62m = analyzeTranscriptCache(claude1hSteps, { nowMs: t0 + (600 + 3700) * 1000 });
    assert.equal(diagAt62m.ttlStatus, "expired");
    const alerts62m = evaluateCacheAlerts(diagAt62m, { sessionId: "cal-1h-sess", store });
    assert.equal(alerts62m.length, 1);
    assert.ok(alerts62m[0].includes("calibrated KV-cache TTL"), `Expected calibrated TTL wording: ${alerts62m[0]}`);
    assert.ok(alerts62m[0].includes("cold re-prefill"), `Expected USD cold re-prefill hint: ${alerts62m[0]}`);
    store.close();

    // 2. Mid-session bust AFTER calibrated 1h warm hit (e.g., 450s gap bust) must be prefix_drift, NOT false ttl_idle_expiry
    const bustAfterCalSteps = [
      ...claude1hSteps,
      {
        type: "PLANNER_RESPONSE",
        step_index: 3,
        created_at: iso(1050), // 450s gap < 3600s calibrated TTL, cache dropped to 0
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 90000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 }
      }
    ];
    const bustDiag = analyzeTranscriptCache(bustAfterCalSteps, { nowMs: t0 + 1100 * 1000 });
    assert.equal(bustDiag.bustCount, 1);
    assert.equal(bustDiag.bustsByCause.ttl_idle_expiry, 0, "450s gap on calibrated 1h session must not be blamed on 5m TTL");
    assert.equal(bustDiag.bustsByCause.prefix_drift, 1);

    // 3. Explicit options.ttlSec ALWAYS takes precedence over empirical calibration
    const explicitDiag = analyzeTranscriptCache(claude1hSteps, { ttlSec: 300, nowMs: t0 + (600 + 420) * 1000 });
    assert.equal(explicitDiag.ttlSource, "explicit");
    assert.equal(explicitDiag.cacheTtlSec, 300);
    assert.equal(explicitDiag.maxWarmHitGapSec, 600);
    assert.equal(explicitDiag.ttlStatus, "expired");

    // 4. Non-Claude model (e.g. Gemini 4 / neon) with warm hit after 650s snaps to rounded-up minute floor (660s)
    const neonSteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(0),
        model: "neon",
        input_tokens: 50000,
        cache_read_tokens: 0
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(650),
        model: "neon",
        input_tokens: 5000,
        cache_read_tokens: 50000
      }
    ];
    const neonCal = analyzeTranscriptCache(neonSteps, { nowMs: t0 + (650 + 400) * 1000 });
    assert.equal(neonCal.ttlSource, "empirical");
    assert.equal(neonCal.cacheTtlSec, 660);
    assert.equal(neonCal.ttlStatus, "warm");

    // 5. Gap <= profileTtl * 1.1 (e.g. 320s <= 330s) does NOT trigger empirical calibration
    const borderlineSteps = [
      { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 40000, cache_read_tokens: 0 },
      { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(320), model: "claude-sonnet-4-6", input_tokens: 2000, cache_read_tokens: 40000 }
    ];
    const borderDiag = analyzeTranscriptCache(borderlineSteps, { nowMs: t0 + 350 * 1000 });
    assert.equal(borderDiag.ttlSource, "profile");
    assert.equal(borderDiag.cacheTtlSec, 300);
    assert.equal(borderDiag.maxWarmHitGapSec, 320);

    // 6. Anthropic explicit ephemeral_1h_input_tokens also calibrates to 3600s & 2.0x write multiplier
    const explicit1hWriteDiag = analyzeTranscriptCache(
      [
        {
          type: "PLANNER_RESPONSE",
          step_index: 1,
          created_at: iso(0),
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 50000,
            cache_creation: { ephemeral_1h_input_tokens: 50000, ephemeral_5m_input_tokens: 0 },
            cache_read_input_tokens: 0
          }
        }
      ],
      { nowMs: t0 + 600 * 1000 }
    );
    assert.equal(explicit1hWriteDiag.ttlSource, "empirical");
    assert.equal(explicit1hWriteDiag.cacheTtlSec, 3600);
    assert.equal(explicit1hWriteDiag.cacheWriteMultiplier, 2.0);
    assert.equal(explicit1hWriteDiag.ttlStatus, "warm");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P0-2.6: Live PreInvocation hook, Sidecar dashboard (/api/cache-diag + index.html), and benchmark.mjs (cache & analyze) integration", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-e2e-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const fakeHome = path.join(tmpDir, "fake-home");
  const convId = "v12-claude-1h-conv";
  const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const now = Date.now();
  // Transcript: Claude 4.6 with transcript maxTokenLimit=1M, 10-min warm hit (calibrates 1h TTL),
  // currently 12 min idle -> NO false 5m TTL alert, and 180k context is OK on 1M window!
  const warmCalSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(now - 22 * 60 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      max_token_limit: 1000000,
      usage: { input_tokens: 10000, cache_creation_input_tokens: 160000, cache_read_input_tokens: 0, output_tokens: 300 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: new Date(now - 12 * 60 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      max_token_limit: 1000000,
      usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 170000, output_tokens: 400 }
    }
  ];
  const transcriptPath = path.join(logDir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, warmCalSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

  // Second transcript: expired after 70 min idle on calibrated 1h Claude session -> emits calibrated TTL alert with empty systemMessage
  const expiredSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(now - 82 * 60 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 5000, cache_creation_input_tokens: 95000, cache_read_input_tokens: 0, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: new Date(now - 70 * 60 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 200 }
    }
  ];
  const expiredPath = path.join(tmpDir, "expired_1h.jsonl");
  fs.writeFileSync(expiredPath, expiredSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

  try {
    // 1. Live PreInvocation hook suppresses false 5m TTL & 200k watermark alerts on 1h/1M session
    const hookQuiet = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: convId, transcriptPath },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(hookQuiet.injectSteps, undefined, `Expected zero alerts on warm 1h/1M session, got: ${JSON.stringify(hookQuiet)}`);

    // 2. Live PreInvocation hook emits calibrated TTL + USD alert with strictly empty systemMessage: ""
    const hookExp = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "expired-1h-conv", transcriptPath: expiredPath },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(hookExp.injectSteps?.length, 1);
    assert.equal(hookExp.injectSteps[0].systemMessage.systemMessage, "");
    const mdAlert = hookExp.injectSteps[0].systemMessage.metadata?.user_markdown || "";
    assert.ok(mdAlert.includes("calibrated KV-cache TTL"), `Missing calibrated TTL alert: ${mdAlert}`);
    assert.ok(mdAlert.includes("$"), `Missing USD re-prefill estimate: ${mdAlert}`);

    // 3. benchmark.mjs cache & analyze CLI surface upgraded metrics cleanly
    const benchCacheJson = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", transcriptPath, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(benchCacheJson.status, 0, benchCacheJson.stderr);
    const cacheParsed = JSON.parse(benchCacheJson.stdout);
    assert.equal(cacheParsed.ttlSource, "empirical");
    assert.equal(cacheParsed.windowSource, "transcript");
    assert.equal(cacheParsed.cacheCreationTokensTotal, 160000);
    assert.equal(cacheParsed.cacheWriteMultiplier, 2.0);
    assert.ok(cacheParsed.estimatedInputCostUsd > 0);

    const benchCacheMd = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", transcriptPath],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(benchCacheMd.status, 0, benchCacheMd.stderr);
    assert.ok(benchCacheMd.stdout.includes("Cache write (creation) tokens"));
    assert.ok(benchCacheMd.stdout.includes("Calibration sources"));

    const benchAnalyzeMd = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "analyze", transcriptPath],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(benchAnalyzeMd.status, 0, benchAnalyzeMd.stderr);
    assert.ok(benchAnalyzeMd.stdout.includes("Est. Prompt Cache cost savings"));
    assert.ok(benchAnalyzeMd.stdout.includes("Prompt Cache write (creation) tokens"));

    // 4. Sidecar HTTP server exposes upgraded KV-cache metrics & valid dashboard JS preserving all DOM IDs
    const port = 39100 + Math.floor(Math.random() * 400);
    const serverProc = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        AGY_DART_DB_PATH: tmpDb,
        AGY_DART_DISABLE_COMPILE_CACHE: "1",
        SIDECAR_FORCE_HTTP: "1",
        PORT: String(port)
      }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sidecar startup timed out")), 5000);
        serverProc.stdout.on("data", (d) => {
          if (d.toString("utf8").includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        serverProc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Sidecar exited prematurely: ${code}`));
        });
      });

      // Dashboard HTML parses cleanly and exposes per-process CSRF token
      const html = await fetchDashboardHtml(`http://127.0.0.1:${port}`);
      const token = html.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
      assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");
      const authHeaders = { headers: { "X-Agy-Dart-Token": token } };

      const kvResp = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)).json();
      assert.equal(kvResp.ok, true);
      assert.equal(kvResp.transcriptFound, true);
      assert.equal(kvResp.windowSource, "transcript");
      assert.equal(kvResp.modelProfile.windowTokens, 1000000);
      assert.equal(kvResp.ttlSource, "empirical");
      assert.equal(kvResp.cacheTtlSec, 3600);
      assert.equal(kvResp.maxWarmHitGapSec, 600);
      assert.equal(kvResp.ttlStatus, "warm");
      assert.equal(kvResp.cacheCreationTokensTotal, 160000);
      assert.equal(kvResp.cacheWriteMultiplier, 2.0);
      assert.equal(typeof kvResp.estimatedInputCostUsd, "number");
      assert.equal(typeof kvResp.estimatedSavedUsd, "number");
      assert.equal(typeof kvResp.estimatedWastedUsd, "number");

      // Second request hits parsedDiagCache -> refreshWallClockTtl MUST preserve empirical 3600s TTL!
      const kvCached = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)).json();
      assert.equal(kvCached.cacheTtlSec, 3600);
      assert.equal(kvCached.ttlSource, "empirical");
      assert.equal(kvCached.ttlStatus, "warm");

      // Missing conversation fallback also exposes upgraded schema fields
      const kvMissing = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=missing-v12-conv`, authHeaders)).json();
      assert.equal(kvMissing.transcriptFound, false);
      assert.equal(kvMissing.ttlSource, "profile");
      assert.equal(kvMissing.windowSource, "profile");
      assert.equal(kvMissing.estimatedInputCostUsd, 0);

      // Dashboard HTML parses cleanly and includes upgraded tooltip/USD display while preserving DOM IDs
      for (const domId of [
        "kv-watermark-badge",
        "kv-temp-badge",
        "kv-ttl-badge",
        "kv-model-badge",
        "kv-cost-savings",
        "kv-wasted-tokens",
        "kv-bust-causes"
      ]) {
        assert.ok(html.includes(`id="${domId}"`), `Missing preserved DOM id: ${domId}`);
      }
      assert.ok(html.includes("function fmtUsd("));
      const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      assert.ok(scriptMatches.length >= 1);
      for (const m of scriptMatches) {
        new vm.Script(m[1]);
      }
    } finally {
      serverProc.kill("SIGTERM");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
