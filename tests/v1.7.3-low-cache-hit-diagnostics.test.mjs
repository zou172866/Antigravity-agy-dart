import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  createEmptyDriftBreakdown,
  extractStepTokenUsage,
  formatCacheDiagMarkdown,
  parseTranscriptLines,
  readTranscriptTail
} from "../context/lib/cache-analyzer.js";
import { fetchDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const T0_MS = Date.parse("2026-11-24T14:00:00Z");
const isoAt = (sec) => new Date(T0_MS + sec * 1000).toISOString();

function makeTurn(stepIndex, sec, ctxTokens, cacheReadTokens, extra = {}) {
  const safeCache = typeof cacheReadTokens === "number" && Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0;
  const step = {
    type: "PLANNER_RESPONSE",
    step_index: stepIndex,
    created_at: isoAt(sec),
    model: "gemini-4-carbon-high",
    input_tokens: Math.max(0, ctxTokens - safeCache),
    ...extra
  };
  if (cacheReadTokens !== undefined) {
    step.cache_read_tokens = cacheReadTokens;
  }
  return step;
}

function assertDriftInvariant(diag, label = "diag") {
  assert.ok(diag.driftBreakdown && typeof diag.driftBreakdown === "object", `${label}: driftBreakdown missing`);
  const { zeroRead, partialRead, unreportedRead } = diag.driftBreakdown;
  for (const [k, v] of Object.entries({ zeroRead, partialRead, unreportedRead })) {
    assert.equal(typeof v, "number", `${label}.${k} must be number`);
    assert.ok(Number.isFinite(v) && v >= 0, `${label}.${k} must be non-negative finite`);
  }
  assert.equal(
    zeroRead + partialRead + unreportedRead,
    diag.bustsByCause.prefix_drift,
    `${label}: zeroRead + partialRead + unreportedRead must equal bustsByCause.prefix_drift`
  );
}

test("v1.7.3-1: T10-T13 priorContextMatch with T13 non-duplication and T14->T15, T18->T19 negative cases", () => {
  // Minimal 4-turn T10-T13 fixture
  const t10ToT13 = [
    makeTurn(75, 0, 274244, 262015),
    makeTurn(78, 90, 280049, 0),
    makeTurn(80, 145, 283151, 274245),
    makeTurn(82, 227, 286416, 274245)
  ];
  const diagShort = analyzeTranscriptCache(t10ToT13, { nowMs: T0_MS + 230_000 });
  assert.equal(diagShort.bustsByCause.prefix_drift, 1);
  assert.deepEqual(diagShort.driftBreakdown, { zeroRead: 1, partialRead: 0, unreportedRead: 0 });
  assertDriftInvariant(diagShort, "t10ToT13");

  const t11Turn = diagShort.recentTurns.find((t) => t.stepIndex === 78);
  assert.ok(t11Turn);
  assert.equal(t11Turn.bustCause, "prefix_drift");
  assert.equal(t11Turn.bustReadState, "zero");
  assert.deepEqual(t11Turn.priorContextMatch, { referenceStepIndex: 75, recoveryStepIndex: 80 });
  assert.equal(
    diagShort.recentTurns.filter((t) => t.priorContextMatch).length,
    1,
    "T13 must not duplicate priorContextMatch"
  );
  assert.equal(diagShort.recentBusts.length, 1);
  assert.equal(diagShort.recentBusts[0].bustReadState, "zero");
  assert.deepEqual(diagShort.recentBusts[0].priorContextMatch, { referenceStepIndex: 75, recoveryStepIndex: 80 });

  // Extended T10-T19 fixture including T14->T15 and T18->T19 negative cases
  const t10ToT19 = [
    ...t10ToT13,
    makeTurn(84, 282, 287169, 0),      // T14: zero-read bust
    makeTurn(87, 326, 289809, 286864), // T15: warm hit near T14, NOT T13 (286416)
    makeTurn(89, 353, 292072, 289810), // T16
    makeTurn(91, 401, 293766, 290616), // T17
    makeTurn(94, 636, 311644, 0),      // T18: +235s zero-read bust
    makeTurn(96, 833, 313251, 309595)  // T19: +197s warm hit (311644 - 2049), NOT T17 (293766)
  ];
  const diagExt = analyzeTranscriptCache(t10ToT19, { nowMs: T0_MS + 840_000 });
  assert.equal(diagExt.bustsByCause.prefix_drift, 3);
  assert.deepEqual(diagExt.driftBreakdown, { zeroRead: 3, partialRead: 0, unreportedRead: 0 });
  assertDriftInvariant(diagExt, "t10ToT19");

  const matchedTurns = diagExt.recentTurns.filter((t) => t.priorContextMatch);
  assert.equal(matchedTurns.length, 1, "Only T11 should receive priorContextMatch across T10-T19");
  assert.equal(matchedTurns[0].stepIndex, 78);
  assert.deepEqual(matchedTurns[0].priorContextMatch, { referenceStepIndex: 75, recoveryStepIndex: 80 });

  const t14 = diagExt.recentTurns.find((t) => t.stepIndex === 84);
  const t18 = diagExt.recentTurns.find((t) => t.stepIndex === 94);
  assert.equal(t14.bustReadState, "zero");
  assert.equal(t14.priorContextMatch, undefined, "T14->T15 must NOT receive priorContextMatch");
  assert.equal(t18.bustReadState, "zero");
  assert.equal(t18.priorContextMatch, undefined, "T18->T19 must NOT receive priorContextMatch");
});

test("v1.7.3-2: Tail-slack boundary R < coldCtx - 2049 rejects R === coldCtx - 2049", () => {
  // Ref 100000, cold 102049, next reads 100000 (= coldCtx - 2049) -> MUST NOT mark
  const boundaryTrace = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 102049, 0),
    makeTurn(14, 60, 105000, 100000)
  ];
  const diagBoundary = analyzeTranscriptCache(boundaryTrace, { nowMs: T0_MS + 70_000 });
  assert.equal(diagBoundary.bustsByCause.prefix_drift, 1);
  assert.deepEqual(diagBoundary.driftBreakdown, { zeroRead: 1, partialRead: 0, unreportedRead: 0 });
  assert.equal(diagBoundary.recentTurns[1].bustReadState, "zero");
  assert.equal(diagBoundary.recentTurns[1].priorContextMatch, undefined, "R === coldCtx - 2049 must NOT match");
  assert.equal(diagBoundary.recentBusts[0].priorContextMatch, undefined);

  // Strict inequality: cold 102050 -> coldCtx - 2049 = 100001 > 100000 -> MUST mark
  const strictTrace = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 102050, 0),
    makeTurn(14, 60, 105000, 100000)
  ];
  const diagStrict = analyzeTranscriptCache(strictTrace, { nowMs: T0_MS + 70_000 });
  assert.deepEqual(diagStrict.recentTurns[1].priorContextMatch, { referenceStepIndex: 10, recoveryStepIndex: 14 });

  // Double-cold where ONLY the first cold violates R < coldCtx - 2049 -> MUST NOT mark
  const doubleBoundary = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 102049, 0),
    makeTurn(14, 60, 112000, 0),
    makeTurn(16, 90, 115000, 100000)
  ];
  const diagDoubleBoundary = analyzeTranscriptCache(doubleBoundary, { nowMs: T0_MS + 100_000 });
  assert.equal(
    diagDoubleBoundary.recentTurns.some((t) => t.priorContextMatch),
    false,
    "Every cold turn in window must satisfy R < coldCtx - 2049"
  );
});

test("v1.7.3-3: bustReadState (zero / unreported / partial) across aliases and multiple backends", () => {
  // Unit checks on extractStepTokenUsage.cacheReadReported
  assert.equal(extractStepTokenUsage(null).cacheReadReported, false);
  assert.equal(extractStepTokenUsage({ input_tokens: 100000, cache_read_tokens: 0 }).cacheReadReported, true);
  assert.equal(extractStepTokenUsage({ input_tokens: 100000 }).cacheReadReported, false);
  assert.equal(extractStepTokenUsage({ input_tokens: 100000, cache_read_tokens: null }).cacheReadReported, false);
  assert.equal(
    extractStepTokenUsage({
      input_tokens: 100000,
      cache_read_tokens: "invalid",
      usage: { cachedContentTokenCount: -10, prompt_tokens_details: { cached_tokens: NaN } }
    }).cacheReadReported,
    false
  );
  const negZeroUsage = extractStepTokenUsage({ input_tokens: 100000, cache_read_tokens: -0 });
  assert.equal(negZeroUsage.cacheReadReported, true);
  assert.equal(Object.is(negZeroUsage.cacheReadTokens, 0), true, "-0 must normalize to +0");
  const aliasUsage = extractStepTokenUsage({
    input_tokens: 60000,
    cache_read_tokens: "bad",
    usage: { cachedContentTokenCount: 40000 }
  });
  assert.equal(aliasUsage.cacheReadReported, true);
  assert.equal(aliasUsage.cacheReadTokens, 40000);

  // 4 cases from previous 100000 turn on gemini-4-carbon-high, each followed by recovery read 100000
  const runCase = (bustStep) =>
    analyzeTranscriptCache(
      [
        makeTurn(1, 0, 100000, 90000),
        bustStep,
        makeTurn(3, 60, 110000, 100000)
      ],
      { nowMs: T0_MS + 70_000 }
    );

  // (a) Explicit 0 -> zero + eligible for priorContextMatch
  const dZero = runCase(makeTurn(2, 30, 106000, 0));
  assert.equal(dZero.recentTurns[1].bustReadState, "zero");
  assert.deepEqual(dZero.driftBreakdown, { zeroRead: 1, partialRead: 0, unreportedRead: 0 });
  assert.deepEqual(dZero.recentTurns[1].priorContextMatch, { referenceStepIndex: 1, recoveryStepIndex: 3 });

  // (b) Omitted read field -> unreported + NOT a recovery candidate
  const dOmitted = runCase({
    type: "PLANNER_RESPONSE",
    step_index: 2,
    created_at: isoAt(30),
    model: "gemini-4-carbon-high",
    input_tokens: 106000
  });
  assert.equal(dOmitted.recentTurns[1].bustReadState, "unreported");
  assert.deepEqual(dOmitted.driftBreakdown, { zeroRead: 0, partialRead: 0, unreportedRead: 1 });
  assert.equal(dOmitted.recentTurns[1].priorContextMatch, undefined, "Unreported zero must NOT be a recovery candidate");

  // (c) Only invalid values -> unreported + NOT a recovery candidate
  const dInvalid = runCase({
    type: "PLANNER_RESPONSE",
    step_index: 2,
    created_at: isoAt(30),
    model: "gemini-4-carbon-high",
    input_tokens: 106000,
    cache_read_tokens: "not-a-number",
    cache_read_input_tokens: -1,
    usage: {
      cachedContentTokenCount: null,
      prompt_tokens_details: { cached_tokens: "" },
      prompt_cache_hit_tokens: false
    }
  });
  assert.equal(dInvalid.recentTurns[1].bustReadState, "unreported");
  assert.deepEqual(dInvalid.driftBreakdown, { zeroRead: 0, partialRead: 0, unreportedRead: 1 });
  assert.equal(dInvalid.recentTurns[1].priorContextMatch, undefined, "Invalid-only read field must NOT be a recovery candidate");

  // (d) Fallback alias reporting 40000 -> partial + NOT a recovery candidate
  const dPartial = runCase({
    type: "PLANNER_RESPONSE",
    step_index: 2,
    created_at: isoAt(30),
    model: "gemini-4-carbon-high",
    input_tokens: 66000,
    cache_read_tokens: null,
    usage: { cachedContentTokenCount: 40000 }
  });
  assert.equal(dPartial.recentTurns[1].bustReadState, "partial");
  assert.deepEqual(dPartial.driftBreakdown, { zeroRead: 0, partialRead: 1, unreportedRead: 0 });
  assert.equal(dPartial.recentTurns[1].priorContextMatch, undefined, "Partial read must NOT be a recovery candidate");

  // Other backends cover all 3 read states AND never emit priorContextMatch (v1 enabled only on gemini-4-512k)
  const backendCases = [
    {
      name: "claude-sonnet-4-6",
      steps: [
        { type: "PLANNER_RESPONSE", step_index: 1, created_at: isoAt(0), model: "claude-sonnet-4-6", usage: { input_tokens: 100000, cache_read_input_tokens: 0 } },
        { type: "PLANNER_RESPONSE", step_index: 2, created_at: isoAt(20), model: "claude-sonnet-4-6", usage: { input_tokens: 106000, cache_read_input_tokens: 0 } },
        { type: "PLANNER_RESPONSE", step_index: 3, created_at: isoAt(40), model: "claude-sonnet-4-6", usage: { input_tokens: 10000, cache_read_input_tokens: 100000 } },
        { type: "PLANNER_RESPONSE", step_index: 4, created_at: isoAt(60), model: "claude-sonnet-4-6", usage: { input_tokens: 112000 } },
        { type: "PLANNER_RESPONSE", step_index: 5, created_at: isoAt(80), model: "claude-sonnet-4-6", usage: { input_tokens: 74000, cache_read_input_tokens: 40000 } }
      ]
    },
    {
      name: "gpt-5",
      steps: [
        { type: "PLANNER_RESPONSE", step_index: 1, created_at: isoAt(0), model: "gpt-5", usage: { prompt_tokens: 100000, prompt_tokens_details: { cached_tokens: 0 } } },
        { type: "PLANNER_RESPONSE", step_index: 2, created_at: isoAt(20), model: "gpt-5", usage: { prompt_tokens: 106000, prompt_tokens_details: { cached_tokens: 0 } } },
        { type: "PLANNER_RESPONSE", step_index: 3, created_at: isoAt(40), model: "gpt-5", usage: { prompt_tokens: 110000, prompt_tokens_details: { cached_tokens: 100000 } } },
        { type: "PLANNER_RESPONSE", step_index: 4, created_at: isoAt(60), model: "gpt-5", usage: { prompt_tokens: 112000 } },
        { type: "PLANNER_RESPONSE", step_index: 5, created_at: isoAt(80), model: "gpt-5", usage: { prompt_tokens: 114000, prompt_tokens_details: { cached_tokens: 40000 } } }
      ]
    },
    {
      name: "deepseek-chat",
      steps: [
        { type: "PLANNER_RESPONSE", step_index: 1, created_at: isoAt(0), model: "deepseek-chat", usage: { prompt_tokens: 100000, prompt_cache_hit_tokens: 0 } },
        { type: "PLANNER_RESPONSE", step_index: 2, created_at: isoAt(20), model: "deepseek-chat", usage: { prompt_tokens: 106000, prompt_cache_hit_tokens: 0 } },
        { type: "PLANNER_RESPONSE", step_index: 3, created_at: isoAt(40), model: "deepseek-chat", usage: { prompt_tokens: 110000, prompt_cache_hit_tokens: 100000 } },
        { type: "PLANNER_RESPONSE", step_index: 4, created_at: isoAt(60), model: "deepseek-chat", usage: { prompt_tokens: 112000 } },
        { type: "PLANNER_RESPONSE", step_index: 5, created_at: isoAt(80), model: "deepseek-chat", usage: { prompt_tokens: 114000, prompt_cache_hit_tokens: 40000 } }
      ]
    }
  ];

  for (const bc of backendCases) {
    const d = analyzeTranscriptCache(bc.steps, { nowMs: T0_MS + 90_000 });
    assert.equal(d.bustsByCause.prefix_drift, 3, `${bc.name}: expected 3 prefix_drift busts`);
    assert.deepEqual(d.driftBreakdown, { zeroRead: 1, partialRead: 1, unreportedRead: 1 }, `${bc.name}: expected 1/1/1 breakdown`);
    assertDriftInvariant(d, bc.name);
    assert.equal(d.recentTurns[1].bustReadState, "zero", `${bc.name} turn 2`);
    assert.equal(d.recentTurns[3].bustReadState, "unreported", `${bc.name} turn 4`);
    assert.equal(d.recentTurns[4].bustReadState, "partial", `${bc.name} turn 5`);
    assert.equal(
      d.recentTurns.some((t) => t.priorContextMatch),
      false,
      `${bc.name} must NOT emit priorContextMatch in v1`
    );
  }
});

test("v1.7.3-4: Double-cold match, triple-cold suppression, boundary events, tail-read skip, and session ending cold", () => {
  // 1. Clean double-cold: Ref 100000 -> 106000(0) -> 112000(0) -> 115000(100001)
  const doubleCold = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    makeTurn(14, 60, 112000, 0),
    makeTurn(16, 90, 115000, 100001)
  ];
  const dDouble = analyzeTranscriptCache(doubleCold, { nowMs: T0_MS + 100_000 });
  assert.equal(dDouble.bustsByCause.prefix_drift, 2);
  assert.deepEqual(dDouble.driftBreakdown, { zeroRead: 2, partialRead: 0, unreportedRead: 0 });
  assert.deepEqual(dDouble.recentTurns[1].priorContextMatch, { referenceStepIndex: 10, recoveryStepIndex: 16 });
  assert.equal(dDouble.recentTurns[2].priorContextMatch, undefined, "Second cold turn must NOT also be marked");
  assert.equal(dDouble.recentBusts.filter((b) => b.priorContextMatch).length, 1);

  // 2. Triple cold: never starts midway (neither reading P+1 nor reading C1+1)
  for (const recRead of [100001, 106001]) {
    const tripleCold = [
      makeTurn(10, 0, 100000, 90000),
      makeTurn(12, 20, 106000, 0),
      makeTurn(14, 40, 112000, 0),
      makeTurn(16, 60, 118000, 0),
      makeTurn(18, 80, 122000, recRead)
    ];
    const dTriple = analyzeTranscriptCache(tripleCold, { nowMs: T0_MS + 90_000 });
    assert.equal(dTriple.bustsByCause.prefix_drift, 3);
    assert.equal(
      dTriple.recentTurns.some((t) => t.priorContextMatch),
      false,
      `Triple cold (recRead=${recRead}) must NOT emit priorContextMatch`
    );
  }

  // 3. Mid-window model switch (even within gemini-4-512k variants, or missing model)
  const modelSwitchMid = [
    makeTurn(10, 0, 100000, 90000, { model: "gemini-4-carbon-high" }),
    makeTurn(12, 30, 106000, 0, { model: "gemini-4-carbon-high" }),
    makeTurn(14, 60, 110000, 100001, { model: "gemini-4-carbon-low" })
  ];
  assert.equal(
    analyzeTranscriptCache(modelSwitchMid, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Different actual model ID on recovery turn must suppress priorContextMatch"
  );

  const missingModelMid = [
    makeTurn(10, 0, 100000, 90000, { model: "gemini-4-carbon-high" }),
    makeTurn(12, 30, 106000, 0, { model: "" }),
    makeTurn(14, 60, 110000, 100001, { model: "gemini-4-carbon-high" })
  ];
  assert.equal(
    analyzeTranscriptCache(missingModelMid, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Unknown/missing model on cold turn must suppress priorContextMatch"
  );

  // 4. Inserted subagent step (with/without explicit subagent:true, usage subagent PLANNER_RESPONSE, and subagent ref)
  const withSubagent = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    { type: "SUBAGENT_RESPONSE", step_index: 13, created_at: isoAt(45), subagent: true, content: "subagent output" },
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withSubagent, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Inserted subagent step must suppress priorContextMatch"
  );

  const withUntaggedSubagentType = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    { type: "SUBAGENT_RESPONSE", step_index: 13, created_at: isoAt(45), content: "subagent output without boolean" },
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withUntaggedSubagentType, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "SUBAGENT_RESPONSE step type must suppress priorContextMatch even without subagent:true"
  );

  const withSubagentUsageTurn = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    makeTurn(13, 45, 108000, 0, { subagent: true }),
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withSubagentUsageTurn, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Subagent usage turn in between must suppress priorContextMatch"
  );

  const withSubagentRef = [
    makeTurn(10, 0, 100000, 90000, { subagent: true }),
    makeTurn(12, 30, 106000, 0),
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withSubagentRef, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Subagent reference turn must suppress priorContextMatch"
  );

  // 5. Usage-missing PLANNER_RESPONSE in between
  const withMissingUsagePlanner = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    { type: "PLANNER_RESPONSE", step_index: 13, created_at: isoAt(45), model: "gemini-4-carbon-high", content: "no usage" },
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withMissingUsagePlanner, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Usage-missing planner turn in between must suppress priorContextMatch"
  );

  // 6. Compaction (/compact user input and explicit compaction step)
  const withSlashCompact = [
    makeTurn(10, 0, 100000, 90000),
    { type: "USER_INPUT", step_index: 11, created_at: isoAt(15), content: "/compact" },
    makeTurn(12, 30, 106000, 0),
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withSlashCompact, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "/compact in window must suppress priorContextMatch"
  );

  const withExplicitCompact = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    { type: "COMPACTION", step_index: 13, created_at: isoAt(45), content: "compacted" },
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(withExplicitCompact, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Explicit compaction step in window must suppress priorContextMatch"
  );

  // 7. TTL bust with concurrent SYSTEM_MESSAGE or media (TTL precedence hides cause, event check must still suppress!)
  const ttlWithSysMsg = [
    makeTurn(10, 0, 100000, 90000),
    { type: "SYSTEM_MESSAGE", step_index: 11, created_at: isoAt(350), content: "Host injected policy update" },
    makeTurn(12, 360, 106000, 0),
    makeTurn(14, 390, 110000, 100001)
  ];
  const dTtlSys = analyzeTranscriptCache(ttlWithSysMsg, { nowMs: T0_MS + 400_000 });
  assert.equal(dTtlSys.bustsByCause.ttl_idle_expiry, 1, "TTL still takes primary-cause precedence");
  assert.equal(
    dTtlSys.recentTurns.some((t) => t.priorContextMatch),
    false,
    "Concurrent SYSTEM_MESSAGE during TTL bust must suppress priorContextMatch"
  );

  const ttlWithMedia = [
    makeTurn(10, 0, 100000, 90000),
    { type: "USER_INPUT", step_index: 11, created_at: isoAt(350), content: "See screenshot", media: [{ mime: "image/png", bytes: 4096 }] },
    makeTurn(12, 360, 106000, 0),
    makeTurn(14, 390, 110000, 100001)
  ];
  const dTtlMedia = analyzeTranscriptCache(ttlWithMedia, { nowMs: T0_MS + 400_000 });
  assert.equal(dTtlMedia.bustsByCause.ttl_idle_expiry, 1, "TTL still takes primary-cause precedence");
  assert.equal(
    dTtlMedia.recentTurns.some((t) => t.priorContextMatch),
    false,
    "Concurrent media during TTL bust must suppress priorContextMatch"
  );

  // 7b. Media or SYSTEM_MESSAGE in the cold -> recovery segment also suppresses priorContextMatch
  const mediaBeforeRecovery = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    { type: "USER_INPUT", step_index: 13, created_at: isoAt(45), content: "img", media: [{ mime: "image/png", bytes: 1024 }] },
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(mediaBeforeRecovery, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Media between cold turn and recovery turn must suppress priorContextMatch"
  );

  const sysMsgBeforeRecovery = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0),
    { type: "SYSTEM_MESSAGE", step_index: 13, created_at: isoAt(45), content: "Policy notice" },
    makeTurn(14, 60, 110000, 100001)
  ];
  assert.equal(
    analyzeTranscriptCache(sysMsgBeforeRecovery, { nowMs: T0_MS + 70_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "SYSTEM_MESSAGE between cold turn and recovery turn must suppress priorContextMatch"
  );

  // 8. Tail-read starting mid-window (missing reference turn) & step_index 0 handling
  const stepZeroMatch = [
    makeTurn(0, 0, 100000, 90000),
    makeTurn(1, 30, 106000, 0),
    makeTurn(2, 60, 110000, 100000)
  ];
  assert.deepEqual(
    analyzeTranscriptCache(stepZeroMatch, { nowMs: T0_MS + 70_000 }).recentTurns[1].priorContextMatch,
    { referenceStepIndex: 0, recoveryStepIndex: 2 },
    "step_index 0 must be preserved as a valid referenceStepIndex"
  );

  const tailOnly = [
    makeTurn(78, 90, 280049, 0),
    makeTurn(80, 145, 283151, 274245),
    makeTurn(82, 227, 286416, 274245)
  ];
  assert.equal(
    analyzeTranscriptCache(tailOnly, { nowMs: T0_MS + 240_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Tail sample missing reference turn must skip priorContextMatch"
  );

  // 8b. Unreported bust must NOT act as a reference turn P for a following explicit zero-read bust
  const unreportedAsRef = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, undefined), // unreported bust
    makeTurn(14, 60, 112000, 0),         // explicit zero-read bust
    makeTurn(16, 90, 115000, 106000)
  ];
  assert.equal(
    analyzeTranscriptCache(unreportedAsRef, { nowMs: T0_MS + 100_000 }).recentTurns.some((t) => t.priorContextMatch),
    false,
    "Unreported bust must not serve as reference turn P"
  );

  // 8c. Real readTranscriptTail truncation starting mid-window on Cold #1 must NOT emit false-positive priorContextMatch,
  // while a tail slice starting on a confirmed warm reference turn still matches cleanly.
  const tailTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-tail-"));
  try {
    const midWindowPath = path.join(tailTmp, "mid-window.jsonl");
    const midLines = [];
    for (let k = 0; k < 20; k++) {
      midLines.push(JSON.stringify({ type: "TOOL_RESULT", step_index: k, created_at: isoAt(k), content: "a".repeat(4000) }));
    }
    midLines.push(JSON.stringify(makeTurn(200, 100, 270000, 260000)));
    for (let k = 0; k < 8; k++) {
      midLines.push(JSON.stringify({ type: "TOOL_RESULT", step_index: 201, created_at: isoAt(101), content: "b".repeat(4000) }));
    }
    midLines.push(JSON.stringify(makeTurn(203, 130, 276000, 0)));
    midLines.push(JSON.stringify(makeTurn(206, 160, 282000, 0)));
    midLines.push(JSON.stringify(makeTurn(209, 190, 288000, 276000)));
    fs.writeFileSync(midWindowPath, midLines.join("\n") + "\n", "utf8");
    const fullMid = parseTranscriptLines(fs.readFileSync(midWindowPath, "utf8"));
    const tailMid = readTranscriptTail(midWindowPath, 16384);
    assert.equal(analyzeTranscriptCache(fullMid, { nowMs: T0_MS + 200_000 }).recentTurns.some((t) => t.priorContextMatch), false);
    assert.equal(
      analyzeTranscriptCache(tailMid, { nowMs: T0_MS + 200_000 }).recentTurns.some((t) => t.priorContextMatch),
      false,
      "Tail-read starting mid-window at a zero-read cold turn must skip priorContextMatch"
    );

    const warmHeadPath = path.join(tailTmp, "warm-head.jsonl");
    const warmLines = [];
    for (let k = 0; k < 20; k++) {
      warmLines.push(JSON.stringify({ type: "TOOL_RESULT", step_index: k, created_at: isoAt(k), content: "c".repeat(4000) }));
    }
    warmLines.push(JSON.stringify(makeTurn(75, 100, 274244, 262015)));
    warmLines.push(JSON.stringify(makeTurn(78, 190, 280049, 0)));
    warmLines.push(JSON.stringify(makeTurn(80, 245, 283151, 274245)));
    fs.writeFileSync(warmHeadPath, warmLines.join("\n") + "\n", "utf8");
    const tailWarm = readTranscriptTail(warmHeadPath, 16384);
    const dTailWarm = analyzeTranscriptCache(tailWarm, { nowMs: T0_MS + 250_000 });
    assert.deepEqual(
      dTailWarm.recentTurns.find((t) => t.stepIndex === 78)?.priorContextMatch,
      { referenceStepIndex: 75, recoveryStepIndex: 80 },
      "Tail-read starting on a confirmed warm reference turn must still detect priorContextMatch"
    );
  } finally {
    fs.rmSync(tailTmp, { recursive: true, force: true });
  }

  // 9. Session truly ending on a cold turn still preserves primary counts & read state
  const endingCold = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 30, 106000, 0)
  ];
  const dEndCold = analyzeTranscriptCache(endingCold, { nowMs: T0_MS + 40_000 });
  assert.equal(dEndCold.bustCount, 1);
  assert.equal(dEndCold.bustsByCause.prefix_drift, 1);
  assert.deepEqual(dEndCold.driftBreakdown, { zeroRead: 1, partialRead: 0, unreportedRead: 0 });
  assert.equal(dEndCold.recentTurns[1].bustReadState, "zero");
  assert.equal(dEndCold.recentTurns[1].priorContextMatch, undefined);
});

test("v1.7.3-5: >15 turns & >10 busts single-session fullness + multi-session aggregation & no cross-session observation", () => {
  // Single session with 20 usage turns and 12 prefix_drift busts (4 zero, 4 partial, 4 unreported)
  const longSteps = [makeTurn(1, 0, 50000, 0)];
  let ctx = 50000;
  for (let t = 2; t <= 20; t++) {
    ctx += 3000;
    const sec = (t - 1) * 20;
    if (t <= 13) {
      // 12 busts: t = 2..13 -> 4 zero, 4 partial, 4 unreported (earlier busts fall outside recentTurns & recentBusts)
      const mod = (t - 2) % 3;
      if (mod === 0) {
        longSteps.push(makeTurn(t, sec, ctx, 0)); // zero
      } else if (mod === 1) {
        longSteps.push(makeTurn(t, sec, ctx, 10000)); // partial (< 70% of >=50k)
      } else {
        longSteps.push({
          type: "PLANNER_RESPONSE",
          step_index: t,
          created_at: isoAt(sec),
          model: "gemini-4-carbon-high",
          input_tokens: ctx
        }); // unreported
      }
    } else {
      // Warm hits for t = 14..20
      longSteps.push(makeTurn(t, sec, ctx, ctx - 3000));
    }
  }

  const dLong = analyzeTranscriptCache(longSteps, { nowMs: T0_MS + 450_000 });
  assert.equal(dLong.turnsWithUsage, 20);
  assert.equal(dLong.recentTurns.length, 15);
  assert.equal(dLong.recentBusts.length, 10);
  assert.equal(dLong.bustsByCause.prefix_drift, 12);
  assert.deepEqual(dLong.driftBreakdown, { zeroRead: 4, partialRead: 4, unreportedRead: 4 });
  assertDriftInvariant(dLong, "longSession");

  // Session A ends on a cold turn (100000 -> 106000 zero), Session B starts with a turn reading 100000
  const sessA = [
    makeTurn(10, 500, 100000, 90000),
    makeTurn(12, 530, 106000, 0)
  ];
  const sessB = [
    makeTurn(14, 560, 110000, 100000),
    makeTurn(16, 590, 115000, 40000) // partial
  ];
  const dA = analyzeTranscriptCache(sessA, { nowMs: T0_MS + 700_000 });
  const dB = analyzeTranscriptCache(sessB, { nowMs: T0_MS + 700_000 });
  const agg = analyzeMultipleSessionsCache([longSteps, sessA, sessB], { nowMs: T0_MS + 700_000 });

  assert.equal(agg.sessions, 3);
  assert.equal(agg.bustsByCause.prefix_drift, 14);
  assert.deepEqual(agg.driftBreakdown, {
    zeroRead: dLong.driftBreakdown.zeroRead + dA.driftBreakdown.zeroRead + dB.driftBreakdown.zeroRead,
    partialRead: dLong.driftBreakdown.partialRead + dA.driftBreakdown.partialRead + dB.driftBreakdown.partialRead,
    unreportedRead: dLong.driftBreakdown.unreportedRead + dA.driftBreakdown.unreportedRead + dB.driftBreakdown.unreportedRead
  });
  assert.deepEqual(agg.driftBreakdown, { zeroRead: 5, partialRead: 5, unreportedRead: 4 });
  assertDriftInvariant(agg, "multiSession");
  assert.equal(
    agg.recentBusts.some((b) => b.priorContextMatch),
    false,
    "Observation window must NEVER cross sessions"
  );
  assert.equal(
    agg.recentTurns.some((t) => t.priorContextMatch),
    false,
    "Observation window must NEVER cross sessions in recentTurns"
  );

  // 11 busts within 13 turns: bust #1 ages out of recentBusts (cap 10) while remaining visible in recentTurns (cap 15);
  // Markdown report must still surface it consistently without dropping it.
  const elevenBustsSteps = [
    makeTurn(1, 0, 100000, 90000),
    makeTurn(2, 20, 106000, 0),
    makeTurn(3, 40, 110000, 100000)
  ];
  let bCtx = 110000;
  for (let k = 4; k <= 13; k++) {
    bCtx += 3000;
    elevenBustsSteps.push(makeTurn(k, (k - 1) * 20, bCtx, 0));
  }
  const dEleven = analyzeTranscriptCache(elevenBustsSteps, { nowMs: T0_MS + 300_000 });
  assert.equal(dEleven.recentTurns.filter((t) => t.priorContextMatch).length, 1);
  assert.equal(dEleven.recentBusts.filter((b) => b.priorContextMatch).length, 0);
  const mdEleven = formatCacheDiagMarkdown(dEleven);
  assert.ok(
    mdEleven.includes("| Prior-context read match (observation) | 1 (step 2: subsequent cache read near step 1 (recovered at step 3)) |"),
    `Markdown must include visible recentTurns priorContextMatch even when recentBusts(10) overflowed:\n${mdEleven}`
  );
});

test("v1.7.3-6: TTL calibration, primary counts, and waste remain identical to baseline at 360s cold and post-recovery checkpoints", () => {
  // Checkpoint 1: up to 360s cold turn
  const toCold360 = [
    makeTurn(10, 0, 100000, 90000),
    makeTurn(12, 360, 106000, 0)
  ];
  const dAt360 = analyzeTranscriptCache(toCold360, { nowMs: T0_MS + 360_000 });
  assert.deepEqual(dAt360.bustsByCause, {
    ttl_idle_expiry: 1,
    model_switch: 0,
    compaction_or_truncation: 0,
    system_injection: 0,
    multimodal_media: 0,
    prefix_drift: 0
  });
  assert.deepEqual(dAt360.driftBreakdown, { zeroRead: 0, partialRead: 0, unreportedRead: 0 });
  assert.equal(dAt360.wastedTokensTotal, 100000);
  assert.equal(dAt360.cacheTtlSec, 300);
  assert.deepEqual(dAt360.ttlObservations["gemini-4-512k"], {
    profileId: "gemini-4-512k",
    warm: [],
    cold: [{ gapSec: 360, atMs: T0_MS + 360_000 }],
    seen1hWrite: false
  });
  assert.equal(dAt360.recentTurns[1].priorContextMatch, undefined);

  // Checkpoint 2: append recovery turn reading P=100000 vs baseline-equivalent control reading 105000
  const withRecoveryMatch = [
    ...toCold360,
    makeTurn(14, 390, 109000, 100000)
  ];
  const withRecoveryControl = [
    ...toCold360,
    makeTurn(14, 390, 109000, 105000)
  ];
  const dMatch = analyzeTranscriptCache(withRecoveryMatch, { nowMs: T0_MS + 390_000 });
  const dControl = analyzeTranscriptCache(withRecoveryControl, { nowMs: T0_MS + 390_000 });

  // Prior-context observation fires ONLY on the match trace, independent of primary TTL cause
  assert.deepEqual(dMatch.recentTurns[1].priorContextMatch, { referenceStepIndex: 10, recoveryStepIndex: 14 });
  assert.equal(dMatch.recentTurns[1].bustReadState, null, "TTL bust must not populate prefix_drift bustReadState");
  assert.equal(dControl.recentTurns[1].priorContextMatch, undefined);

  // Primary counts, waste, ttlObservations, and cacheTtlSec MUST equal baseline/control identically
  assert.deepEqual(dMatch.bustsByCause, dControl.bustsByCause);
  assert.equal(dMatch.wastedTokensTotal, dControl.wastedTokensTotal);
  assert.deepEqual(dMatch.ttlObservations, dControl.ttlObservations);
  assert.equal(dMatch.cacheTtlSec, dControl.cacheTtlSec);
  assert.deepEqual(dMatch.ttlObservations["gemini-4-512k"].cold, [{ gapSec: 360, atMs: T0_MS + 360_000 }]);
});

test("v1.7.3-7: Sidecar /api/cache-diag (normal, missing, legacy), EN/ZH UI rendering, XSS safety, and Markdown alignment", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-sidecar-"));
  const fakeHome = path.join(tmpDir, "fake-home");
  const tmpDb = path.join(tmpDir, "context.db");
  const convId = "v173-diag-conv";
  const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const now = Date.now();
  const relIso = (offsetSec) => new Date(now + offsetSec * 1000).toISOString();
  const transcriptSteps = [
    { type: "PLANNER_RESPONSE", step_index: 75, created_at: relIso(-240), model: "gemini-4-carbon-high", input_tokens: 12229, cache_read_tokens: 262015 },
    { type: "PLANNER_RESPONSE", step_index: 78, created_at: relIso(-180), model: "gemini-4-carbon-high", input_tokens: 280049, cache_read_tokens: 0 },
    { type: "PLANNER_RESPONSE", step_index: 80, created_at: relIso(-120), model: "gemini-4-carbon-high", input_tokens: 8906, cache_read_tokens: 274245 },
    { type: "PLANNER_RESPONSE", step_index: 82, created_at: relIso(-80), model: "gemini-4-carbon-high", input_tokens: 245000, cache_read_tokens: 40000 },
    { type: "PLANNER_RESPONSE", step_index: 84, created_at: relIso(-40), model: "gemini-4-carbon-high", input_tokens: 290000 }
  ];
  fs.writeFileSync(
    path.join(logDir, "transcript.jsonl"),
    transcriptSteps.map((s) => JSON.stringify(s)).join("\n") + "\n",
    "utf8"
  );

  const port = 40700 + Math.floor(Math.random() * 400);
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

    const html = await fetchDashboardHtml(`http://127.0.0.1:${port}`);
    const token = html.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");
    const postJson = async (body) =>
      (
        await fetch(`http://127.0.0.1:${port}/api/cache-diag`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agy-Dart-Token": token
          },
          body: JSON.stringify(body)
        })
      ).json();

    // 1. Live POST /api/cache-diag response
    const kvLive = await postJson({ scope: "conversation", conversationId: convId });
    assert.equal(kvLive.ok, true);
    assert.equal(kvLive.transcriptFound, true);
    assert.equal(kvLive.bustsByCause.prefix_drift, 3);
    assert.deepEqual(kvLive.driftBreakdown, { zeroRead: 1, partialRead: 1, unreportedRead: 1 });
    assert.deepEqual(kvLive.recentTurns[1].priorContextMatch, { referenceStepIndex: 75, recoveryStepIndex: 80 });
    assert.equal(kvLive.recentTurns[1].bustReadState, "zero");
    assert.equal(kvLive.recentTurns[3].bustReadState, "partial");
    assert.equal(kvLive.recentTurns[4].bustReadState, "unreported");

    // 2. Missing transcript POST /api/cache-diag fallback includes default driftBreakdown
    const kvMissing = await postJson({ scope: "conversation", conversationId: "missing-v173-conv" });
    assert.equal(kvMissing.ok, true);
    assert.equal(kvMissing.transcriptFound, false);
    assert.deepEqual(kvMissing.driftBreakdown, createEmptyDriftBreakdown());

    // 3. Markdown report aligns with summary & tooltip vocabulary (both normal and legacy)
    const mdLive = formatCacheDiagMarkdown(kvLive);
    assert.ok(
      mdLive.includes("| Bust cause: Unattributed | 3 (zero-read: 1, partial hit: 1, unreported: 1) |"),
      `Expected Unattributed breakdown row in Markdown, got:\n${mdLive}`
    );
    assert.ok(
      mdLive.includes("| Prior-context read match (observation) | 1 (step 78: subsequent cache read near step 75 (recovered at step 80)) |"),
      `Expected prior-context observation row in Markdown, got:\n${mdLive}`
    );
    const legacyDiag = {
      ...kvLive,
      driftBreakdown: undefined,
      recentBusts: kvLive.recentBusts.map(({ bustReadState: _r, priorContextMatch: _p, ...rest }) => rest),
      recentTurns: kvLive.recentTurns.map(({ bustReadState: _r, priorContextMatch: _p, ...rest }) => rest)
    };
    const mdLegacy = formatCacheDiagMarkdown(legacyDiag);
    assert.ok(mdLegacy.includes("| Bust cause: Unattributed | 3 |"), `Legacy Markdown must show plain count:\n${mdLegacy}`);
    assert.equal(mdLegacy.includes("zero-read:"), false);
    assert.equal(mdLegacy.includes("Prior-context read match"), false);

    // 4. VM DOM rendering in EN & ZH for normal, missing, legacy, scrolled-off step label, and XSS safety
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "Expected inline script in index.html");
    const mainScript = scriptMatch[1];
    new Function(mainScript);
    new vm.Script(mainScript);

    const mockElements = new Map();
    const makeEl = (id) => {
      const classes = new Set();
      const el = {
        id,
        className: "",
        textContent: "",
        innerText: "",
        innerHTML: "",
        title: "",
        value: "",
        options: [],
        dataset: {},
        style: {},
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c)
        }
      };
      mockElements.set(id, el);
      return el;
    };
    const sandbox = {
      window: { location: { search: "" }, addEventListener: () => {} },
      document: {
        documentElement: { lang: "en" },
        title: "",
        getElementById: (id) => mockElements.get(id) || makeEl(id),
        createElement: () => makeEl("tmp"),
        querySelectorAll: () => [],
        body: { appendChild: () => {}, removeChild: () => {} },
        execCommand: () => true
      },
      navigator: { language: "en-US" },
      URLSearchParams,
      Headers: class { set() {} has() { return false; } },
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      console: { error: () => {}, log: () => {} },
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {}
    };
    vm.runInNewContext(mainScript, sandbox);

    // 4a. Live payload in English
    sandbox.setLanguage("en");
    sandbox.renderKvCacheCard(kvLive);
    const causesEn = mockElements.get("kv-bust-causes").innerHTML;
    const barsEn = mockElements.get("kv-turns-bars").innerHTML;
    assert.ok(causesEn.includes("Unattributed"), `EN summary must show Unattributed: ${causesEn}`);
    assert.ok(causesEn.includes("Zero-read 1 / Partial hit 1 / Unreported 1"), `EN summary must list breakdown: ${causesEn}`);
    assert.ok(causesEn.includes("Prior-ctx read"), `EN summary must show prior-context chip: ${causesEn}`);
    assert.ok(barsEn.includes("BUST: Unattributed (Zero-read; subsequent cache read near T1)"), `EN turn tip: ${barsEn}`);
    assert.ok(barsEn.includes("BUST: Unattributed (Partial hit)"), `EN partial tip: ${barsEn}`);
    assert.ok(barsEn.includes("BUST: Unattributed (Unreported)"), `EN unreported tip: ${barsEn}`);

    // 4b. Live payload in Chinese
    sandbox.setLanguage("zh");
    const causesZh = mockElements.get("kv-bust-causes").innerHTML;
    const barsZh = mockElements.get("kv-turns-bars").innerHTML;
    assert.ok(causesZh.includes("原因未定"), `ZH summary must show 原因未定: ${causesZh}`);
    assert.ok(causesZh.includes("全零 1 / 部分命中 1 / 未上报 1"), `ZH summary must list breakdown: ${causesZh}`);
    assert.equal(causesZh.includes("前缀漂移"), false, "ZH UI must not regress to 前缀漂移");
    assert.ok(barsZh.includes("失效：原因未定（全零；后续缓存读取量接近 T1）"), `ZH turn tip: ${barsZh}`);
    assert.ok(barsZh.includes("失效：原因未定（部分命中）"), `ZH partial tip: ${barsZh}`);
    assert.ok(barsZh.includes("失效：原因未定（未上报）"), `ZH unreported tip: ${barsZh}`);

    // 4c. Scrolled-off reference turn uses explicit 'step N' label (never an unlabeled step index)
    const scrolledPayload = {
      ...kvLive,
      recentTurns: kvLive.recentTurns.slice(1) // drops T1 (step 75), so step 78 is now first item in recentTurns
    };
    sandbox.renderKvCacheCard(scrolledPayload);
    const barsScrolledZh = mockElements.get("kv-turns-bars").innerHTML;
    assert.ok(
      barsScrolledZh.includes("后续缓存读取量接近 step 75"),
      `When ref turn is outside recentTurns, UI must explicitly label step: ${barsScrolledZh}`
    );

    // 4d. Missing transcript fallback in EN & ZH
    sandbox.renderKvCacheCard(kvMissing);
    assert.ok(mockElements.get("kv-bust-causes").innerHTML.includes("暂未记录到会话 Token 用量。"));
    sandbox.setLanguage("en");
    assert.ok(mockElements.get("kv-bust-causes").innerHTML.includes("No transcript token usage recorded yet."));

    // 4e. Legacy response lacking driftBreakdown / bustReadState / priorContextMatch -> primary counts only
    sandbox.setLanguage("en");
    sandbox.renderKvCacheCard(legacyDiag);
    const legacyCausesEn = mockElements.get("kv-bust-causes").innerHTML;
    const legacyBarsEn = mockElements.get("kv-turns-bars").innerHTML;
    assert.ok(legacyCausesEn.includes("<span>Unattributed <strong>3</strong></span>"), `EN legacy summary: ${legacyCausesEn}`);
    assert.equal(legacyCausesEn.includes("Zero-read"), false);
    assert.equal(legacyCausesEn.includes("NaN"), false);
    assert.equal(legacyCausesEn.includes("undefined"), false);
    assert.ok(legacyBarsEn.includes("BUST: Unattributed\""), `EN legacy bar tip must omit sub-state: ${legacyBarsEn}`);

    sandbox.setLanguage("zh");
    const legacyCausesZh = mockElements.get("kv-bust-causes").innerHTML;
    const legacyBarsZh = mockElements.get("kv-turns-bars").innerHTML;
    assert.ok(legacyCausesZh.includes("<span>原因未定 <strong>3</strong></span>"), `ZH legacy summary: ${legacyCausesZh}`);
    assert.equal(legacyCausesZh.includes("全零"), false);
    assert.equal(legacyCausesZh.includes("部分命中"), false);
    assert.equal(legacyCausesZh.includes("未上报"), false);
    assert.ok(legacyBarsZh.includes("失效：原因未定\""), `ZH legacy bar tip must omit sub-state: ${legacyBarsZh}`);

    // 4f. XSS escaping / allowlist hardening on untrusted fields
    sandbox.renderKvCacheCard({
      ...kvLive,
      recentTurns: [
        {
          turn: 2,
          stepIndex: 4,
          hitRate: 0,
          ctxTokens: 50000,
          deltaTokens: 1000,
          isBust: true,
          bustCause: "prefix_drift",
          bustReadState: '<img src=x onerror="alert(1)">',
          triggerTool: '<script>evil()</script>'
        }
      ]
    });
    const xssBars = mockElements.get("kv-turns-bars").innerHTML;
    assert.equal(xssBars.includes("<img"), false, "Untrusted bustReadState must not be injected");
    assert.equal(xssBars.includes("<script>"), false, "Untrusted triggerTool must be HTML-escaped");

    // 4g. Edge consistency checks: malformed partial PM, inconsistent driftBreakdown, TTL+PM, 11-bust union, multi-session dup stepIndex
    sandbox.setLanguage("en");
    sandbox.renderKvCacheCard({
      ...kvLive,
      bustsByCause: { ...kvLive.bustsByCause, prefix_drift: 5 },
      driftBreakdown: { zeroRead: 0, partialRead: 0, unreportedRead: 0 },
      recentTurns: [
        { turn: 1, stepIndex: 10, hitRate: 0.9, ctxTokens: 100000, deltaTokens: 0, isBust: false },
        { turn: 2, stepIndex: 12, hitRate: 0, ctxTokens: 106000, deltaTokens: 6000, isBust: true, bustCause: "prefix_drift", bustReadState: "zero", priorContextMatch: { referenceStepIndex: 10 } }
      ],
      recentBusts: [
        { stepIndex: 12, cause: "prefix_drift", bustReadState: "zero", priorContextMatch: { referenceStepIndex: 10 } }
      ]
    });
    assert.equal(
      mockElements.get("kv-turns-bars").innerHTML.includes("subsequent cache read"),
      false,
      "Partial priorContextMatch missing recoveryStepIndex must be rejected in bar tooltip"
    );
    assert.equal(
      mockElements.get("kv-bust-causes").innerHTML.includes("Prior-ctx read"),
      false,
      "Partial priorContextMatch missing recoveryStepIndex must be rejected in summary chip"
    );
    assert.ok(
      mockElements.get("kv-bust-causes").innerHTML.includes("<span>Unattributed <strong>5</strong></span>"),
      "Inconsistent driftBreakdown (0+0+0 !== 5) must fall back to primary count only"
    );
    const mdInconsistent = formatCacheDiagMarkdown({
      ...kvLive,
      bustsByCause: { ...kvLive.bustsByCause, prefix_drift: 5 },
      driftBreakdown: { zeroRead: 0, partialRead: 0, unreportedRead: 0 }
    });
    assert.ok(mdInconsistent.includes("| Bust cause: Unattributed | 5 |"), `Inconsistent breakdown in Markdown must fall back:\n${mdInconsistent}`);

    // TTL bust with priorContextMatch renders cleanly in EN & ZH without prefix_drift bustReadState
    const dTtlPm = analyzeTranscriptCache(
      [makeTurn(10, 0, 100000, 90000), makeTurn(12, 360, 106000, 0), makeTurn(14, 390, 109000, 100000)],
      { nowMs: T0_MS + 400_000 }
    );
    sandbox.setLanguage("zh");
    sandbox.renderKvCacheCard({ ok: true, transcriptFound: true, ...dTtlPm });
    assert.ok(
      mockElements.get("kv-turns-bars").innerHTML.includes("失效：TTL过期（后续缓存读取量接近 T1）"),
      `TTL+PM ZH bar tip: ${mockElements.get("kv-turns-bars").innerHTML}`
    );
    assert.ok(
      mockElements.get("kv-bust-causes").innerHTML.includes("前序回读观察"),
      `TTL+PM ZH summary chip: ${mockElements.get("kv-bust-causes").innerHTML}`
    );

    // 11 busts in 13 turns: summary chip stays consistent with visible recentTurns bar tooltip
    const steps11Ui = [makeTurn(1, 0, 100000, 90000), makeTurn(2, 20, 106000, 0), makeTurn(3, 40, 110000, 100000)];
    let uiCtx = 110000;
    for (let k = 4; k <= 13; k++) {
      uiCtx += 3000;
      steps11Ui.push(makeTurn(k, (k - 1) * 20, uiCtx, 0));
    }
    const d11Ui = analyzeTranscriptCache(steps11Ui, { nowMs: T0_MS + 300_000 });
    sandbox.setLanguage("en");
    sandbox.renderKvCacheCard({ ok: true, transcriptFound: true, ...d11Ui });
    assert.ok(mockElements.get("kv-turns-bars").innerHTML.includes("subsequent cache read near T1"));
    assert.ok(
      mockElements.get("kv-bust-causes").innerHTML.includes("Prior-ctx read <strong>1</strong>"),
      `Summary chip must include recentTurns match when recentBusts(10) overflowed: ${mockElements.get("kv-bust-causes").innerHTML}`
    );

    // Multi-session duplicate stepIndex uses explicit 'step N' instead of another session's T{turn}
    const msA = [makeTurn(10, 0, 100000, 90000), makeTurn(12, 30, 106000, 0), makeTurn(14, 60, 110000, 100000)];
    const msB = [
      makeTurn(10, 200, 80000, 70000),
      makeTurn(11, 220, 82000, 80000),
      makeTurn(12, 240, 85000, 82000),
      makeTurn(13, 260, 88000, 85000),
      makeTurn(14, 280, 90000, 88000)
    ];
    const aggMs = analyzeMultipleSessionsCache([msA, msB], { nowMs: T0_MS + 300_000 });
    sandbox.setLanguage("en");
    sandbox.renderKvCacheCard({ ok: true, transcriptFound: true, ...aggMs });
    const msCauses = mockElements.get("kv-bust-causes").innerHTML;
    assert.ok(
      msCauses.includes("step 12: subsequent cache read near step 10 (recovered at step 14)"),
      `Multi-session payload must label explicit step numbers, got: ${msCauses}`
    );
  } finally {
    try { serverProc.kill(); } catch {}
    await new Promise((resolve) => serverProc.once("close", resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
