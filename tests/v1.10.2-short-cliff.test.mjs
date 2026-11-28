import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  createEmptyShortGapColdSummary,
  formatCacheDiagMarkdown,
  resolveModelProfile,
  SHORT_GAP_MIN_SEC,
  SHORT_GAP_RECENT_MS,
  SHORT_GAP_RELEASE_HOT_GAP_SEC,
  SHORT_GAP_WINDOW_TURNS
} from "../context/lib/cache-analyzer.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  WatchdogMonitor,
  WATCHDOG_PHASES,
  writeWatchdogLease
} from "../context/lib/watchdog.js";
import { suppressSqliteExperimentalWarning } from "../hooks/compile-cache.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

suppressSqliteExperimentalWarning();

const BASE_MS = Date.parse("2026-11-28T10:00:00Z");
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 25));

function makeNeonTurn(stepIndex, atMs, ctxTokens, cacheReadTokens, extra = {}) {
  const safeCache =
    typeof cacheReadTokens === "number" && Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0;
  const step = {
    type: "PLANNER_RESPONSE",
    step_index: stepIndex,
    created_at: new Date(atMs).toISOString(),
    model: "gemini-4-neon",
    input_tokens: Math.max(0, ctxTokens - safeCache),
    ...extra
  };
  if (cacheReadTokens !== undefined) {
    step.cache_read_tokens = cacheReadTokens;
  }
  return step;
}

function makeTmpStore(t, prefix = "agy-v1102-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new ContextModeStore({ dbPath: path.join(dir, "context.db") });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

test("T2.5-1 & T2.5-2: Gemini 4 Neon short-gap cliff summary matches spec without mutating bustsByCause or ttlObservations", () => {
  // Initial cold turn -> gap=8s warm hit -> gap=28s zero-read -> gap=35s zero-read
  const t0 = BASE_MS;
  const steps = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 8_000, 93000, 89500),
    makeNeonTurn(3, t0 + 36_000, 96000, 0),
    makeNeonTurn(4, t0 + 71_000, 99000, 0)
  ];
  const nowMs = t0 + 80_000;
  const diag = analyzeTranscriptCache(steps, { nowMs });

  assert.equal(SHORT_GAP_MIN_SEC, 20);
  assert.equal(SHORT_GAP_WINDOW_TURNS, 5);
  assert.equal(SHORT_GAP_RECENT_MS, 30 * 60 * 1000);
  assert.equal(SHORT_GAP_RELEASE_HOT_GAP_SEC, 60);

  assert.equal(diag.shortGapColdSummary.count, 2);
  assert.equal(diag.shortGapColdSummary.under60sCount, 2);
  assert.equal(diag.shortGapColdSummary.minGapSec, 28);
  assert.equal(diag.shortGapColdSummary.maxGapSec, 35);
  assert.equal(diag.shortGapColdSummary.recentQualifyingCount, 2);
  assert.equal(diag.shortGapColdSummary.shortGapHotCount, 1);
  assert.equal(diag.shortGapColdSummary.hotReleaseStreak, 0);
  assert.equal(diag.shortGapColdSummary.recentChurn, true);
  assert.equal(diag.shortGapColdSummary.attribution, "server_cliff_likely");

  // Hard-coded bustsByCause 6-key invariants & zero cold observation pollution
  assert.deepEqual(Object.keys(diag.bustsByCause), [
    "ttl_idle_expiry",
    "model_switch",
    "compaction_or_truncation",
    "system_injection",
    "multimodal_media",
    "prefix_drift"
  ]);
  assert.deepEqual(diag.bustsByCause, {
    ttl_idle_expiry: 0,
    model_switch: 0,
    compaction_or_truncation: 0,
    system_injection: 0,
    multimodal_media: 0,
    prefix_drift: 2
  });
  assert.deepEqual(diag.driftBreakdown, { zeroRead: 2, partialRead: 0, unreportedRead: 0 });
  const profileObs = diag.ttlObservations?.[diag.modelProfile.id];
  assert.equal(profileObs?.cold?.length || 0, 0, "Sub-TTL short-gap misses must not enter ttlObservations cold samples");

  // Markdown output (EN & ZH)
  const mdZh = formatCacheDiagMarkdown(diag, { lang: "zh" });
  assert.ok(mdZh.includes("检测到 2 次短间隔（最短 28s）全零冷未命中；短间隔轮次仍有热命中，疑似服务端缓存悬崖/路由抖动（#1665/#1720）"));
  assert.equal(mdZh.includes("非本地前缀破坏"), false);
  const mdEn = formatCacheDiagMarkdown(diag);
  assert.ok(mdEn.includes("Detected 2 short-gap (min 28s) zero-read cold misses"));
  assert.ok(mdEn.includes("#1665/#1720"));
});

test("T2.5-3 & T2.5-4: 0/99 alternating pattern keeps recentChurn=true and releases after 2 hot hits with gap>=60s", () => {
  const t0 = BASE_MS;
  // Base -> 0 (gap=30s) -> hot (gap=45s) -> 0 (gap=40s) -> hot (gap=50s)
  const altSteps = [
    makeNeonTurn(1, t0, 80000, 0),
    makeNeonTurn(2, t0 + 30_000, 83000, 0),
    makeNeonTurn(3, t0 + 75_000, 86000, 82500),
    makeNeonTurn(4, t0 + 115_000, 89000, 0),
    makeNeonTurn(5, t0 + 165_000, 92000, 88500)
  ];
  const diagAlt = analyzeTranscriptCache(altSteps, { nowMs: t0 + 175_000 });
  assert.equal(diagAlt.shortGapColdSummary.count, 2);
  assert.equal(diagAlt.shortGapColdSummary.recentQualifyingCount, 2);
  assert.equal(diagAlt.shortGapColdSummary.hotReleaseStreak, 0);
  assert.equal(diagAlt.shortGapColdSummary.recentChurn, true);

  // Even when the trailing hot hit has gap=90s (>=60s), hotReleaseStreak=1 < 2 still keeps recentChurn=true
  const altLongTailSteps = [
    makeNeonTurn(1, t0, 80000, 0),
    makeNeonTurn(2, t0 + 30_000, 83000, 0),
    makeNeonTurn(3, t0 + 100_000, 86000, 82500),
    makeNeonTurn(4, t0 + 140_000, 89000, 0),
    makeNeonTurn(5, t0 + 230_000, 92000, 88500)
  ];
  const diagAltLong = analyzeTranscriptCache(altLongTailSteps, { nowMs: t0 + 240_000 });
  assert.equal(diagAltLong.shortGapColdSummary.hotReleaseStreak, 1);
  assert.equal(diagAltLong.shortGapColdSummary.recentChurn, true);

  // Adding 2 consecutive hot hits with gap>=60s after altSteps releases recentChurn
  const releasedSteps = [
    ...altSteps,
    makeNeonTurn(6, t0 + 230_000, 95000, 91500), // gap=65s
    makeNeonTurn(7, t0 + 300_000, 98000, 94500)  // gap=70s
  ];
  const diagReleased = analyzeTranscriptCache(releasedSteps, { nowMs: t0 + 310_000 });
  assert.equal(diagReleased.shortGapColdSummary.hotReleaseStreak, 2);
  assert.equal(diagReleased.shortGapColdSummary.recentChurn, false);
});

test("T2.5-5, T2.5-6, T2.5-7 & T2.5-8: staleness (31m), <20s lower bound, unreported cacheRead, and unknown attribution wording", () => {
  const t0 = BASE_MS;
  // T2.5-5: qualifying samples 31 minutes ago -> recentChurn=false
  const staleSteps = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 25_000, 93000, 0),
    makeNeonTurn(3, t0 + 55_000, 96000, 0)
  ];
  const staleDiag = analyzeTranscriptCache(staleSteps, { nowMs: t0 + 55_000 + 31 * 60 * 1000 });
  assert.equal(staleDiag.shortGapColdSummary.count, 2);
  assert.equal(staleDiag.shortGapColdSummary.recentChurn, false);

  // T2.5-6: gap=5s and gap=10s zero-read busts -> below SHORT_GAP_MIN_SEC (20s), excluded from count
  const subMinSteps = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 5_000, 93000, 0),
    makeNeonTurn(3, t0 + 15_000, 96000, 0)
  ];
  const subMinDiag = analyzeTranscriptCache(subMinSteps, { nowMs: t0 + 20_000 });
  assert.equal(subMinDiag.shortGapColdSummary.count, 0);
  assert.equal(subMinDiag.shortGapColdSummary.attribution, "none");

  // T2.5-7: cacheReadReported=false (cache_read_tokens omitted) -> excluded from count
  const unreportedSteps = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 30_000, 93000, undefined),
    makeNeonTurn(3, t0 + 65_000, 96000, undefined)
  ];
  const unreportedDiag = analyzeTranscriptCache(unreportedSteps, { nowMs: t0 + 70_000 });
  assert.equal(unreportedDiag.shortGapColdSummary.count, 0);
  assert.equal(unreportedDiag.shortGapColdSummary.attribution, "none");

  // T2.5-8: short-gap zero-reads without any <20s warm hit -> attribution="unknown", Markdown omits cliff assertion
  const unknownSteps = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 25_000, 93000, 0),
    makeNeonTurn(3, t0 + 60_000, 96000, 0)
  ];
  const unknownDiag = analyzeTranscriptCache(unknownSteps, { nowMs: t0 + 70_000 });
  assert.equal(unknownDiag.shortGapColdSummary.count, 2);
  assert.equal(unknownDiag.shortGapColdSummary.shortGapHotCount, 0);
  assert.equal(unknownDiag.shortGapColdSummary.attribution, "unknown");
  const mdZh = formatCacheDiagMarkdown(unknownDiag, { lang: "zh" });
  assert.ok(mdZh.includes("原因未定：可能是服务端抖动，也可能是本地开头前缀变化"));
  assert.equal(mdZh.includes("服务端缓存悬崖"), false);
  assert.equal(mdZh.includes("非本地前缀破坏"), false);
  const mdEn = formatCacheDiagMarkdown(unknownDiag);
  assert.equal(mdEn.includes("server-side cache cliff"), false);
});

test("T2.5-9: analyzeMultipleSessionsCache aggregates shortGapColdSummary across sessions", () => {
  const t0 = BASE_MS;
  // Session A: unknown attribution (count=1, under60sCount=0, gap=90s, recentChurn=false)
  const sessA = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 90_000, 93000, 0)
  ];
  // Session B: server_cliff_likely (shortGapHotCount=1, count=2, under60sCount=2, gaps=25s & 40s, recentChurn=true)
  const sessB = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 10_000, 93000, 89500),
    makeNeonTurn(3, t0 + 35_000, 96000, 0),
    makeNeonTurn(4, t0 + 75_000, 99000, 0)
  ];
  const agg = analyzeMultipleSessionsCache([sessA, sessB], { nowMs: t0 + 100_000 });
  assert.equal(agg.shortGapColdSummary.count, 3);
  assert.equal(agg.shortGapColdSummary.under60sCount, 2);
  assert.equal(agg.shortGapColdSummary.shortGapHotCount, 1);
  assert.equal(agg.shortGapColdSummary.minGapSec, 25);
  assert.equal(agg.shortGapColdSummary.maxGapSec, 90);
  assert.equal(agg.shortGapColdSummary.recentChurn, true);
  assert.equal(agg.shortGapColdSummary.attribution, "server_cliff_likely");

  // Two sessions where one is unknown and one is none -> attribution="unknown"
  const sessNone = [
    makeNeonTurn(1, t0, 90000, 0),
    makeNeonTurn(2, t0 + 10_000, 93000, 89500)
  ];
  const aggUnknown = analyzeMultipleSessionsCache([sessA, sessNone], { nowMs: t0 + 100_000 });
  assert.equal(aggUnknown.shortGapColdSummary.attribution, "unknown");
  assert.equal(aggUnknown.shortGapColdSummary.recentChurn, false);
});

test("T2.5-10 to T2.5-16: Watchdog short-cliff pre-emptive guard, cross-session threshold, delayed cold check, manual warning & fail-open", async (t) => {
  const { dir, store } = makeTmpStore(t, "agy-v1102-wd-");
  const now = BASE_MS + 600_000;
  const idleAnchorTs = now - 260_000; // 40s remaining on 300s TTL (inside 60s lead trigger window)

  const writeTx = (name, steps) => {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    return fp;
  };

  const twoQualifyingSteps = [
    makeNeonTurn(1, idleAnchorTs - 80_000, 120000, 0),
    makeNeonTurn(2, idleAnchorTs - 70_000, 123000, 119500),
    makeNeonTurn(3, idleAnchorTs - 40_000, 126000, 0),
    makeNeonTurn(4, idleAnchorTs, 129000, 0)
  ];
  const oneQualifyingSteps = [
    makeNeonTurn(1, idleAnchorTs - 50_000, 120000, 0),
    makeNeonTurn(2, idleAnchorTs - 40_000, 123000, 119500),
    makeNeonTurn(3, idleAnchorTs, 126000, 0)
  ];

  const txTwo = writeTx("two.jsonl", twoQualifyingSteps);
  const txOne = writeTx("one.jsonl", oneQualifyingSteps);

  const setupConv = (convId, transcriptPath, { model = "gemini-4-neon" } = {}) => {
    writeWatchdogLease(store, {
      conversationId: convId,
      rootSessionId: convId,
      convTitle: convId,
      transcriptPath,
      model,
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      contextTokens: 130000,
      cacheTtlSec: 300,
      cacheOriginTs: idleAnchorTs,
      idleAnchorTs,
      updatedTs: idleAnchorTs
    });
    store.setTtlKeepaliveState(convId, { enabled: true, maxCount: 3, usedCount: 0 });
  };

  // T2.5-10: tail meets recentChurn -> auto-keepalive paused, keepaliveSendFn not called, usedCount unchanged
  {
    const sends = [];
    setupConv("conv-churn-2", txTwo);
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 3, ttlKeepaliveLeadSec: 60 }),
      nowFn: () => now,
      keepaliveSendFn: async (p) => { sends.push(p); return { ok: true }; }
    });
    mon.tick();
    await flushMicrotasks();
    assert.equal(sends.length, 0);
    assert.equal(store.getTtlKeepaliveState("conv-churn-2").usedCount, 0);
    assert.equal(store.getTtlKeepaliveState("conv-churn-2").lastSentTs, 0);
    const status = mon.getStatus({ conversationId: "conv-churn-2", scope: "conversation", refresh: false });
    assert.equal(status.ttlKeepalive.shortCliffSkip?.skippedReason, "short_cliff_churn");
    assert.equal(status.ttlKeepalive.shortCliffSkip?.count, 2);
    assert.equal(status.ttlKeepalive.shortCliffSkip?.need, 2);

    // T2.5-15: Manual keepalive on blocked conversation STILL dispatches and returns warning: "short_cliff_churn"
    const manualRes = mon.triggerManualKeepalive("conv-churn-2", { nowMs: now });
    await flushMicrotasks();
    assert.equal(manualRes.ok, true);
    assert.equal(manualRes.dispatched, true);
    assert.equal(manualRes.warning, "short_cliff_churn");
    assert.equal(sends.length, 1);
    const statusAfterManual = mon.getStatus({ conversationId: "conv-churn-2", scope: "conversation", refresh: false });
    assert.equal(statusAfterManual.ttlKeepalive.shortCliffSkip, null, "Successful keepalive clears shortCliffSkip");
  }

  // T2.5-11: only 1 qualifying sample and no cross-session cold trip -> auto-keepalive dispatches normally
  {
    const { dir: d11, store: s11 } = makeTmpStore(t, "agy-v1102-11-");
    const fp11 = path.join(d11, "one.jsonl");
    fs.writeFileSync(fp11, oneQualifyingSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    const sends = [];
    writeWatchdogLease(s11, {
      conversationId: "conv-one-ok",
      rootSessionId: "conv-one-ok",
      transcriptPath: fp11,
      model: "gemini-4-neon",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      contextTokens: 130000,
      cacheTtlSec: 300,
      cacheOriginTs: idleAnchorTs,
      idleAnchorTs,
      updatedTs: idleAnchorTs
    });
    s11.setTtlKeepaliveState("conv-one-ok", { enabled: true, maxCount: 3, usedCount: 0 });
    const mon = new WatchdogMonitor({
      getStore: () => s11,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 3, ttlKeepaliveLeadSec: 60 }),
      nowFn: () => now,
      keepaliveSendFn: async (p) => { sends.push(p); return { ok: true }; }
    });
    mon.tick();
    await flushMicrotasks();
    assert.equal(sends.length, 1);
    assert.equal(s11.getTtlKeepaliveState("conv-one-ok").usedCount, 1);
  }

  // T2.5-12 & T2.5-13: 1 qualifying sample + cross-session cold trip at 14m (blocked, need=1) vs 16m (allowed)
  const profileId = resolveModelProfile("gemini-4-neon").id;
  {
    const { dir: d12, store: s12 } = makeTmpStore(t, "agy-v1102-12-");
    const fp12 = path.join(d12, "one.jsonl");
    fs.writeFileSync(fp12, oneQualifyingSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    // Validate illegal profileId is ignored safely
    s12.recordKeepaliveColdTrip("../bad/id", now - 60_000);
    assert.equal(s12.getRecentKeepaliveColdTrip("../bad/id", now), null);

    // 14 minutes ago -> inside 15m window -> need=1 -> blocked
    s12.recordKeepaliveColdTrip(profileId, now - 14 * 60 * 1000);
    assert.equal(s12.getRecentKeepaliveColdTrip(profileId, now), Math.floor(now - 14 * 60 * 1000));
    const sends14 = [];
    writeWatchdogLease(s12, {
      conversationId: "conv-one-14m",
      rootSessionId: "conv-one-14m",
      transcriptPath: fp12,
      model: "gemini-4-neon",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      contextTokens: 130000,
      cacheTtlSec: 300,
      cacheOriginTs: idleAnchorTs,
      idleAnchorTs,
      updatedTs: idleAnchorTs
    });
    s12.setTtlKeepaliveState("conv-one-14m", { enabled: true, maxCount: 3, usedCount: 0 });
    const mon14 = new WatchdogMonitor({
      getStore: () => s12,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 3, ttlKeepaliveLeadSec: 60 }),
      nowFn: () => now,
      keepaliveSendFn: async (p) => { sends14.push(p); return { ok: true }; }
    });
    mon14.tick();
    await flushMicrotasks();
    assert.equal(sends14.length, 0);
    const st14 = mon14.getStatus({ conversationId: "conv-one-14m", scope: "conversation", refresh: false });
    assert.equal(st14.ttlKeepalive.shortCliffSkip?.skippedReason, "short_cliff_churn");
    assert.equal(st14.ttlKeepalive.shortCliffSkip?.need, 1);

    // 16 minutes ago -> outside 15m window -> need=2 -> not blocked
    s12.recordKeepaliveColdTrip(profileId, now - 16 * 60 * 1000);
    assert.equal(s12.getRecentKeepaliveColdTrip(profileId, now), null);
    const sends16 = [];
    const mon16 = new WatchdogMonitor({
      getStore: () => s12,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 3, ttlKeepaliveLeadSec: 60 }),
      nowFn: () => now,
      keepaliveSendFn: async (p) => { sends16.push(p); return { ok: true }; }
    });
    mon16.tick();
    await flushMicrotasks();
    assert.equal(sends16.length, 1);
  }

  // T2.5-14: _runDelayedColdMissCheck tripping cold calls recordKeepaliveColdTrip(profileId, nowWallMs)
  {
    const { dir: d14, store: s14 } = makeTmpStore(t, "agy-v1102-14-");
    const sentTs = now - 30_000;
    const coldKeepaliveTx = path.join(d14, "cold-ka.jsonl");
    const kaSteps = [
      { type: "USER_INPUT", step_index: 10, created_at: new Date(sentTs + 1000).toISOString(), content: "[agy-dart TTL Keepalive 1/3] Reply OK only" },
      makeNeonTurn(11, sentTs + 3000, 125000, 0)
    ];
    fs.writeFileSync(coldKeepaliveTx, kaSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    const recordedTrips = [];
    const origRecord = s14.recordKeepaliveColdTrip.bind(s14);
    s14.recordKeepaliveColdTrip = (pid, ts) => {
      recordedTrips.push({ pid, ts });
      return origRecord(pid, ts);
    };
    const kaState = {
      usedCount: 1,
      coldMissTripped: false,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_test_1",
      lastDispatchMode: "auto",
      pendingColdCheckId: "ka_test_1",
      lastSentTs: sentTs,
      lastColdCheckUsed: 0
    };
    s14.setTtlKeepaliveState("conv-delayed-cold", kaState);
    const mon = new WatchdogMonitor({
      getStore: () => s14,
      getConfig: () => ({ stallWatchdog: true }),
      nowFn: () => now
    });
    const res = mon._runDelayedColdMissCheck(
      s14,
      "conv-delayed-cold",
      { conversationId: "conv-delayed-cold", model: "gemini-4-neon", transcriptPath: coldKeepaliveTx },
      kaState,
      now
    );
    assert.equal(res.checked, true);
    assert.equal(res.coldTripped, true);
    assert.deepEqual(recordedTrips, [{ pid: profileId, ts: now }]);
    assert.equal(s14.getRecentKeepaliveColdTrip(profileId, now), now);
  }

  // T2.5-16: analyzeTranscriptCache throwing -> fail-open, auto-keepalive proceeds
  {
    const { store: s16 } = makeTmpStore(t, "agy-v1102-16-");
    const sends = [];
    writeWatchdogLease(s16, {
      conversationId: "conv-failopen",
      rootSessionId: "conv-failopen",
      transcriptPath: txTwo,
      model: "gemini-4-neon",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      contextTokens: 130000,
      cacheTtlSec: 300,
      cacheOriginTs: idleAnchorTs,
      idleAnchorTs,
      updatedTs: idleAnchorTs
    });
    s16.setTtlKeepaliveState("conv-failopen", { enabled: true, maxCount: 3, usedCount: 0 });
    const mon = new WatchdogMonitor({
      getStore: () => s16,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 3, ttlKeepaliveLeadSec: 60 }),
      nowFn: () => now,
      analyzeTranscriptCacheFn: () => { throw new Error("boom"); },
      keepaliveSendFn: async (p) => { sends.push(p); return { ok: true }; }
    });
    mon.tick();
    await flushMicrotasks();
    assert.equal(sends.length, 1);
  }
});

test("T2.5-17: Dashboard UI escapes untrusted shortGapColdSummary / minGapSec and renders shortCliffSkip badge in EN & ZH", () => {
  const html = readDashboardHtml();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "Expected combined main script from readDashboardHtml()");
  const mainScript = scriptMatch[1];

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
      disabled: false,
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
    window: { location: { search: "?conversationId=conv-ui-xss" }, addEventListener: () => {} },
    document: {
      documentElement: { lang: "zh" },
      title: "",
      getElementById: (id) => mockElements.get(id) || makeEl(id),
      createElement: () => makeEl("tmp"),
      querySelectorAll: () => [],
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: () => true
    },
    navigator: { language: "zh-CN" },
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

  const nowMs = Date.now();
  const xssPayload = {
    ok: true,
    transcriptFound: true,
    scope: "conversation",
    conversationId: "conv-ui-xss",
    resolvedConversationId: "conv-ui-xss",
    conversationActive: false,
    turnsWithUsage: 4,
    warmTurns: 3,
    weightedHitRate: 0.25,
    avgTurnHitRate: 0.25,
    currentContextTokens: 120000,
    peakContextTokens: 120000,
    bustCount: 2,
    bustsByCause: {
      ttl_idle_expiry: 0,
      model_switch: 0,
      compaction_or_truncation: 0,
      system_injection: 0,
      multimodal_media: 0,
      prefix_drift: 2
    },
    driftBreakdown: { zeroRead: 2, partialRead: 0, unreportedRead: 0 },
    shortGapColdSummary: {
      ...createEmptyShortGapColdSummary(),
      count: 2,
      under60sCount: 2,
      minGapSec: "<img onerror>",
      attribution: "server_cliff_likely"
    },
    cacheTtlSec: 300,
    ttlRemainingSec: 120,
    ttlStatus: "warm",
    cacheTemperature: "warm",
    lastPlannerAt: new Date(nowMs - 180_000).toISOString(),
    serverNowMs: nowMs,
    ttlKeepalive: {
      conversationId: "conv-ui-xss",
      enabled: true,
      supported: true,
      isSubagent: false,
      maxCount: 3,
      usedCount: 0,
      coldMissTripped: false,
      hasLease: true,
      leasePhase: "IDLE",
      leaseSubphase: "stopped",
      leaseStopReason: "NO_TOOL_CALL",
      cacheOriginTs: nowMs - 180_000,
      effectiveTtlSec: 300,
      estimatedExpireTs: nowMs + 120_000,
      remainingSec: 120,
      shortCliffSkip: {
        skippedReason: "short_cliff_churn",
        atMs: nowMs,
        count: 2,
        under60sCount: 2,
        minGapSec: "<img onerror>",
        attribution: "server_cliff_likely",
        need: 2
      }
    },
    recentTurns: [],
    topContextDeltas: [],
    recentBusts: []
  };

  sandbox.setLanguage("zh");
  sandbox.renderKvCacheCard(xssPayload);
  const shortGapZhEl = mockElements.get("kv-short-gap-row");
  const shortGapZh = shortGapZhEl.innerHTML;
  assert.equal(shortGapZhEl.classList.contains("hidden"), false);
  assert.equal(shortGapZh.includes("<img"), false, "Untrusted minGapSec must never inject HTML");
  assert.ok(
    shortGapZh.includes("检测到 2 次短间隔（最短 0s）全零冷未命中；短间隔轮次仍有热命中，疑似服务端缓存悬崖/路由抖动（#1665/#1720）"),
    `Expected numeric fallback 0s and ZH cliff copy, got: ${shortGapZh}`
  );
  const skipBadgeZh = mockElements.get("kv-ttl-auto-skip-badge");
  assert.equal(skipBadgeZh.textContent, "服务端短悬崖/抖动，已暂停自动保活");
  assert.equal(skipBadgeZh.className.includes("hidden"), false);
  assert.equal(skipBadgeZh.title.includes("<img"), false);
  assert.ok(skipBadgeZh.title.includes("最短 0s"));

  sandbox.setLanguage("en");
  sandbox.renderKvCacheCard(xssPayload);
  const shortGapEn = mockElements.get("kv-short-gap-row").innerHTML;
  assert.equal(shortGapEn.includes("<img"), false);
  assert.ok(shortGapEn.includes("Detected 2 short-gap (min 0s) zero-read cold misses"));
  const skipBadgeEn = mockElements.get("kv-ttl-auto-skip-badge");
  assert.equal(skipBadgeEn.textContent, "Server short-cliff/churn, auto-keepalive paused");
});
