import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  analyzeTranscriptCache,
  estimateCalibratedTtl,
  resolveModelProfile
} from "../context/lib/cache-analyzer.js";
import {
  formatSimulationMarkdown,
  simulateCachePolicies
} from "../context/lib/cache-simulator.js";
import {
  formatEffectiveConfigLines,
  getConfigSnapshot,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  WATCHDOG_PHASES,
  WatchdogMonitor,
  buildDesktopNotificationCommand,
  readWatchdogLease,
  recordHookLeaseTransition
} from "../context/lib/watchdog.js";
import { handleStopPayload } from "../hooks/stop.mjs";
import { closeRuntimeStore, createStandaloneServer } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function assertAllNumbersFinite(val, trail = "root") {
  if (typeof val === "number") {
    assert.ok(Number.isFinite(val), `Non-finite number at ${trail}: ${val}`);
    return;
  }
  if (Array.isArray(val)) {
    val.forEach((item, idx) => assertAllNumbersFinite(item, `${trail}[${idx}]`));
    return;
  }
  if (val && typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      assertAllNumbersFinite(v, `${trail}.${k}`);
    }
  }
}

function runHookRaw(relScript, payload, dbPath, extraEnv = {}) {
  const env = {
    ...process.env,
    AGY_DART_DB_PATH: dbPath,
    AGY_DART_DISABLE_COMPILE_CACHE: "1",
    AGY_DART_CONFIG_PATH: extraEnv.AGY_DART_CONFIG_PATH || path.join(path.dirname(dbPath), "missing-cfg.json"),
    ...extraEnv
  };
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  delete env.ANTIGRAVITY_PARENT_CONVERSATION_ID;
  delete env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
  return spawnSync(process.execPath, [path.join(ROOT, relScript)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env
  });
}

function httpJsonRequest(port, urlPath, { method = "GET", headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : "";
    const reqHeaders = { ...headers };
    if (body !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(payload, "utf8");
    }
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers: reqHeaders }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(payload);
    req.end();
  });
}

test("v1.5-1: Cross-session empirical TTL calibration (gemini-4-512k), interval bounds & downward convergence without SQLite coupling", () => {
  // Pure-module check: cache-analyzer.js and cache-simulator.js must never import SQLite or store
  for (const rel of ["context/lib/cache-analyzer.js", "context/lib/cache-simulator.js"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/node:sqlite|from\s+["']\.\/store/.test(src), false, `${rel} must stay pure without SQLite imports`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-ttl-cal-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    const t0 = Date.parse("2026-11-22T00:00:00Z");
    const iso = (ms) => new Date(ms).toISOString();

    // 1. Session A observes a 14m (840s) warm hit on Gemini 4 Carbon (gemini-4-512k, profile default 300s)
    const sessionASteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(t0),
        model: "Gemini 4 Carbon (High)",
        input_tokens: 70000,
        cache_read_tokens: 0
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(t0 + 840 * 1000), // 14m warm hit!
        model: "Gemini 4 Carbon (High)",
        input_tokens: 4000,
        cache_read_tokens: 68000
      }
    ];

    const diagA = analyzeTranscriptCache(sessionASteps, {
      nowMs: t0 + 900 * 1000,
      conversationId: "conv-sess-a"
    });
    assert.equal(diagA.modelProfile.id, "gemini-4-512k");
    assert.equal(diagA.ttlSource, "empirical");
    assert.equal(diagA.cacheTtlSec, 840);
    assert.equal(diagA.ttlCalibration.origin, "session");
    assert.equal(diagA.ttlCalibration.warmSamples, 1);
    assert.equal(diagA.ttlCalibration.coldSamples, 0);

    // Persist observations; duplicate write must be idempotent (0 updatedProfiles)
    const rec1 = store.recordModelTtlObservations(diagA.ttlObservations, "conv-sess-a", t0 + 900 * 1000);
    assert.equal(rec1.updatedProfiles, 1);
    const recDup = store.recordModelTtlObservations(diagA.ttlObservations, "conv-sess-a", t0 + 905 * 1000);
    assert.equal(recDup.updatedProfiles, 0, "Duplicate (conv, atMs, gapSec) observation must not churn SQLite");

    // 2. Brand-new Session B (single turn, no in-session gaps) immediately inherits calibrated ~14m TTL!
    const sessionBSteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(t0 + 1200 * 1000),
        model: "Gemini 4 Carbon (High)",
        input_tokens: 65000,
        cache_read_tokens: 0
      }
    ];
    const histMap1 = store.getAllModelTtlCalibrations(t0 + 1500 * 1000);
    const diagB = analyzeTranscriptCache(sessionBSteps, {
      nowMs: t0 + (1200 + 600) * 1000, // 10m idle -> still warm under 14m calibrated TTL!
      historicalTtlByProfile: histMap1,
      conversationId: "conv-sess-b"
    });
    assert.equal(diagB.ttlSource, "empirical");
    assert.equal(diagB.cacheTtlSec, 840);
    assert.equal(diagB.ttlStatus, "warm");
    assert.equal(diagB.ttlCalibration.origin, "history");
    assert.equal(diagB.ttlCalibration.warmSamples, 1);

    // 3. Session B later experiences a 16m (960s) pure-idle cold miss -> [840s, 960s] converges to 900s (15m)
    const sessionBWithCold = [
      ...sessionBSteps,
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(t0 + (1200 + 960) * 1000),
        model: "Gemini 4 Carbon (High)",
        input_tokens: 68000,
        cache_read_tokens: 0
      }
    ];
    const diagBCold = analyzeTranscriptCache(sessionBWithCold, {
      nowMs: t0 + (1200 + 1000) * 1000,
      historicalTtlByProfile: histMap1,
      conversationId: "conv-sess-b"
    });
    assert.equal(diagBCold.ttlSource, "empirical");
    assert.equal(diagBCold.cacheTtlSec, 900, "L=840, U=960 should conservatively converge to 900s (15m)");
    assert.equal(diagBCold.ttlCalibration.maxWarmGapSec, 840);
    assert.equal(diagBCold.ttlCalibration.minColdMissGapSec, 960);
    store.recordModelTtlObservations(diagBCold.ttlObservations, "conv-sess-b", t0 + 2200 * 1000);

    // 4. Backend shortens TTL! Newer Session C observes a 9m (540s) pure-idle cold miss -> MUST converge downward!
    const tLater = t0 + 3600 * 1000;
    const sessionCShortCold = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(tLater),
        model: "Gemini 4 Carbon (High)",
        input_tokens: 75000,
        cache_read_tokens: 0
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(tLater + 540 * 1000), // 9m pure cold miss!
        model: "Gemini 4 Carbon (High)",
        input_tokens: 78000,
        cache_read_tokens: 0
      }
    ];
    const histMap2 = store.getAllModelTtlCalibrations(tLater + 600 * 1000);
    const diagC = analyzeTranscriptCache(sessionCShortCold, {
      nowMs: tLater + 600 * 1000,
      historicalTtlByProfile: histMap2,
      conversationId: "conv-sess-c"
    });
    // Must NOT stay locked at 840s/900s! Converges below recent 540s cold miss (480s = 8m)
    assert.ok(
      diagC.cacheTtlSec <= 540 && diagC.cacheTtlSec < 840,
      `Expected downward convergence <=540s after recent 9m cold miss, got ${diagC.cacheTtlSec}s`
    );
    assert.equal(diagC.cacheTtlSec, 480);
    assert.equal(diagC.ttlSource, "empirical");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5-2: 14-day calibration expiry, pruneByTtl cleanup, 20-sample ring buffer cap & explicit TTL override", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-ttl-maint-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    const nowMs = Date.now();
    const staleMs = nowMs - 15 * 24 * 3600 * 1000; // 15 days ago (>14d)

    // Write a stale calibration record directly & verify both reader andpruneByTtl clean/ignore it
    store.setMeta(
      "ttl_calibration:v1:gemini-4-512k",
      JSON.stringify({
        v: 1,
        profileId: "gemini-4-512k",
        warm: [{ gapSec: 900, atMs: staleMs, conv: "old-conv" }],
        cold: [],
        seen1hWrite: false,
        updatedTs: staleMs
      })
    );
    assert.equal(store.getModelTtlCalibration("gemini-4-512k", nowMs), null, ">14d record must be ignored on read");
    assert.deepEqual(store.getAllModelTtlCalibrations(nowMs), {});

    const profile = resolveModelProfile("Gemini 4 Carbon (High)");
    const staleEst = estimateCalibratedTtl(profile, {
      historyRecord: {
        v: 1,
        profileId: "gemini-4-512k",
        warm: [{ gapSec: 900, atMs: staleMs, conv: "old-conv" }],
        cold: [],
        seen1hWrite: false,
        updatedTs: staleMs
      },
      nowMs
    });
    assert.equal(staleEst.ttlSource, "profile");
    assert.equal(staleEst.ttlSec, 300);

    // Also add a fresh record for claude-200k; pruneByTtl(14) must delete stale gemini-4-512k and keep fresh claude-200k
    store.recordModelTtlObservations(
      {
        "claude-200k": {
          profileId: "claude-200k",
          warm: Array.from({ length: 26 }, (_, i) => ({
            gapSec: 600 + i * 10,
            atMs: nowMs - (30 - i) * 1000,
            conv: `c-${i}`
          })),
          cold: []
        }
      },
      "batch-conv",
      nowMs
    );
    const claudeRec = store.getModelTtlCalibration("claude-200k", nowMs);
    assert.equal(claudeRec.warm.length, 20, "Ring buffer must cap warm observations at latest 20 entries");

    store.pruneByTtl({ maxAgeDays: 14 });
    assert.equal(store.getMeta("ttl_calibration:v1:gemini-4-512k", null), null, "pruneByTtl must delete >14d ttl_calibration meta");
    assert.ok(store.getMeta("ttl_calibration:v1:claude-200k", null) !== null, "pruneByTtl must preserve fresh ttl_calibration meta");

    // Explicit TTL ALWAYS overrides cross-session calibration
    const explicitEst = estimateCalibratedTtl(resolveModelProfile("claude-sonnet-4-6"), {
      explicitTtlSec: 420,
      historyRecord: claudeRec,
      nowMs
    });
    assert.equal(explicitEst.ttlSource, "explicit");
    assert.equal(explicitEst.ttlSec, 420);
    assert.equal(explicitEst.ttlCalibration.origin, "explicit");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5-3: Live PreInvocation + Sidecar /api/cache-diag cross-session calibration & parsedDiagCache stamp invalidation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-sidecar-cal-"));
  const dbPath = path.join(tmpDir, "context.db");
  const fakeHome = path.join(tmpDir, "home");
  const convA = "conv-cal-source-a";
  const convB = "conv-cal-target-b";
  const logDirA = path.join(fakeHome, ".gemini", "antigravity", "brain", convA, ".system_generated", "logs");
  const logDirB = path.join(fakeHome, ".gemini", "antigravity", "brain", convB, ".system_generated", "logs");
  fs.mkdirSync(logDirA, { recursive: true });
  fs.mkdirSync(logDirB, { recursive: true });

  const now = Date.now();
  const txPathA = path.join(logDirA, "transcript.jsonl");
  const txPathB = path.join(logDirB, "transcript.jsonl");

  // Conv B has 1 turn on Gemini 4 Carbon (no in-session gap)
  fs.writeFileSync(
    txPathB,
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(now - 420 * 1000).toISOString(), // 7m idle
      model: "Gemini 4 Carbon (High)",
      input_tokens: 165000,
      cache_read_tokens: 0
    }) + "\n",
    "utf8"
  );

  // Conv A has a 14m (840s) warm hit on Gemini 4 Carbon
  fs.writeFileSync(
    txPathA,
    [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: new Date(now - 1000 * 1000).toISOString(),
        model: "Gemini 4 Carbon (High)",
        input_tokens: 72000,
        cache_read_tokens: 0
      },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: new Date(now - 160 * 1000).toISOString(), // 840s warm gap!
        model: "Gemini 4 Carbon (High)",
        input_tokens: 4000,
        cache_read_tokens: 70000
      }
    ]
      .map((s) => JSON.stringify(s))
      .join("\n") + "\n",
    "utf8"
  );

  const prevEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    AGY_DART_DB_PATH: process.env.AGY_DART_DB_PATH,
    AGY_DART_CONFIG_PATH: process.env.AGY_DART_CONFIG_PATH
  };
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-cfg.json");
  closeRuntimeStore();
  resetConfigCache();

  const csrfToken = "c0ffee1234567890abcdef1234567890";
  const srv = createStandaloneServer({ csrfToken });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const authHeaders = { "X-Agy-Dart-Token": csrfToken };

  try {
    // 1. Query Conv B first -> populates parsedDiagCache with profile TTL 300s (7m idle => expired)
    const beforeCal = await httpJsonRequest(
      port,
      `/api/cache-diag?scope=conversation&conversationId=${convB}`,
      { headers: authHeaders }
    );
    assert.equal(beforeCal.status, 200);
    assert.equal(beforeCal.json.cacheTtlSec, 300);
    assert.equal(beforeCal.json.ttlSource, "profile");
    assert.equal(beforeCal.json.ttlStatus, "expired");

    // 2. Run PreInvocation hook on Conv A -> writes cross-session 840s calibration to SQLite
    const hookRes = runHookRaw(
      "hooks/pre-invocation.mjs",
      { conversationId: convA, transcriptPath: txPathA },
      dbPath,
      { USERPROFILE: fakeHome, HOME: fakeHome }
    );
    assert.equal(hookRes.status, 0);
    assert.equal(Buffer.byteLength(hookRes.stderr || "", "utf8"), 0);

    // 3. Re-query Conv B WITHOUT modifying txPathB (mtimeMs & size identical!) ->
    //    parsedDiagCache must detect updated calibration stamp and return 840s warm!
    const afterCal = await httpJsonRequest(
      port,
      `/api/cache-diag?scope=conversation&conversationId=${convB}`,
      { headers: authHeaders }
    );
    assert.equal(afterCal.status, 200);
    assert.equal(afterCal.json.cacheTtlSec, 840, "parsedDiagCache must invalidate when cross-session calibration updates");
    assert.equal(afterCal.json.ttlSource, "empirical");
    assert.equal(afterCal.json.ttlCalibration.origin, "history");
    assert.equal(afterCal.json.ttlStatus, "warm");

    // 4. Explicit AGY_DART_CACHE_TTL_SEC overrides cross-session calibration in PreInvocation
    const explicitHook = runHookRaw(
      "hooks/pre-invocation.mjs",
      { conversationId: convB, transcriptPath: txPathB },
      dbPath,
      { USERPROFILE: fakeHome, HOME: fakeHome, AGY_DART_CACHE_TTL_SEC: "360", AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(explicitHook.status, 0);
    const parsedExplicitOut = JSON.parse(explicitHook.stdout);
    // 420s idle > 360s explicit TTL on 80k context -> emits cold re-prefill alert with empty systemMessage
    assert.equal(parsedExplicitOut.injectSteps?.length, 1);
    assert.equal(parsedExplicitOut.injectSteps[0].systemMessage.systemMessage, "");
    assert.ok(parsedExplicitOut.injectSteps[0].systemMessage.metadata.user_markdown.includes("6m"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5-4: Watchdog IDLE high-context TTL expiry desktop alert — zero statSync, dedup, cooldown, sleep guard & suppression matrix", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-ttl-notify-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_760_000_000_000;
    let monoNs = 10_000_000_000n;
    const advanceSec = (sec) => {
      nowMs += sec * 1000;
      monoNs += BigInt(sec) * 1_000_000_000n;
    };

    let cfgState = {
      stallWatchdog: true,
      watchdogPollMs: 5000,
      ttlDesktopNotify: false,
      ttlNotifyLeadSec: 60,
      ttlNotifyMinTokens: 60000
    };
    const notifications = [];

    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfgState,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      statFn: () => {
        monitor.statSyncCount += 1;
        throw new Error("IDLE path must NEVER call statSync");
      },
      notifyFn: (payload) => {
        notifications.push(payload);
        return { dispatched: true };
      }
    });

    // Seed an 85k context turn that cleanly finishes into IDLE (stopped, 300s TTL)
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-main-85k", lastUserInput: "TOP_SECRET_USER_PROMPT_DO_NOT_LEAK" },
      {
        nowMs,
        contextTokens: 85000,
        model: "Gemini 4 Carbon (High)",
        cacheTtlSec: 300,
        ttlSource: "profile"
      }
    );
    advanceSec(5);
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-main-85k" }, { nowMs });

    // 1. Default OFF: advancing into remSec=45s (255s idle) MUST NOT fire notifyFn
    advanceSec(255);
    monitor.tick();
    assert.equal(notifications.length, 0, "ttlDesktopNotify=false by default must never notify");
    assert.equal(monitor.statSyncCount, 0);

    // 2. Enable ttlDesktopNotify -> fires exactly 1x in (0, 60] window, with <=60B title, <=220B sanitized body & zero user input
    cfgState.ttlDesktopNotify = true;
    monitor.tick();
    assert.equal(notifications.length, 0, "A TTL alert preference alone must not send a popup");
    cfgState.ttlKeepalive = true;
    store.setTtlKeepaliveEnabled(false, "conv-main-85k");
    monitor.tick();
    assert.equal(notifications.length, 0, "Disabling warming in one window overrides the global setting");
    store.clearTtlKeepaliveOverride("conv-main-85k");
    monitor.tick();
    assert.equal(notifications.length, 1);
    assert.equal(monitor.ttlNotificationCount, 1);
    assert.equal(monitor.statSyncCount, 0, "TTL desktop alert MUST maintain 0 statSync");
    assert.equal(monitor.tailReadCount, 0);

    const n1 = notifications[0];
    assert.equal(n1.title, "agy-dart: KV-Cache Expiring");
    assert.ok(Buffer.byteLength(n1.title, "utf8") <= 60, `Windows BalloonTipTitle must be <=60B: ${n1.title}`);
    assert.ok(Buffer.byteLength(n1.body, "utf8") <= 220, `Notification body must be <=220B: ${n1.body}`);
    // PreInvocation at t0 -> Stop at t0+5s -> +255s idle = 260s from cacheOriginTs (~40s left on 300s TTL)
    assert.ok(n1.body.includes("85k") && n1.body.includes("~40s"));
    assert.equal(n1.body.includes("TOP_SECRET_USER_PROMPT_DO_NOT_LEAK"), false, "User input must NEVER appear in notification");

    const winCmd = buildDesktopNotificationCommand({ title: n1.title, body: n1.body, platform: "win32", baseEnv: {} });
    assert.ok(Buffer.byteLength(winCmd.safeTitle, "utf8") <= 60);
    assert.ok(Buffer.byteLength(winCmd.safeBody, "utf8") <= 220);

    // 3. Subsequent tick 10s later (remSec=35s) on the SAME idleAnchorTs MUST NOT re-fire
    advanceSec(10);
    monitor.tick();
    assert.equal(notifications.length, 1, "Same idleAnchorTs must be deduplicated");

    // 4. Suppression matrix: expired (remSec<=0), subagent, low context (<60k), USER_CANCELED, ERROR, stale_cleanup
    advanceSec(70); // >60s past last global notify cooldown

    // 4a. Already expired (idle 305s on 300s TTL -> remSec = -5)
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-expired" }, { nowMs: nowMs - 310_000, contextTokens: 90000, cacheTtlSec: 300 });
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-expired" }, { nowMs: nowMs - 305_000 });

    // 4b. Subagent lease (remSec = 40s, 95k tokens, but isSubagent: true)
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-sub", parentConversationId: "conv-main-85k" },
      { nowMs: nowMs - 265_000, isSubagent: true, contextTokens: 95000, cacheTtlSec: 300 }
    );
    recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-sub", parentConversationId: "conv-main-85k" },
      { nowMs: nowMs - 260_000, isSubagent: true }
    );

    // 4c. Low context (<60k: 42k tokens, remSec = 40s)
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-lowctx" }, { nowMs: nowMs - 265_000, contextTokens: 42000, cacheTtlSec: 300 });
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-lowctx" }, { nowMs: nowMs - 260_000 });

    // 4d. USER_CANCELED & ERROR via handleStopPayload (90k tokens, remSec = 40s)
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-canceled" }, { nowMs: nowMs - 265_000, contextTokens: 90000, cacheTtlSec: 300 });
    await handleStopPayload(
      { conversationId: "conv-canceled", terminationReason: "EXECUTOR_TERMINATION_REASON_USER_CANCELED" },
      { store, effectiveCfg: cfgState }
    );
    // Backdate idleAnchorTs to remSec = 40s so time window matches and ONLY stopReason suppresses it
    const canceledLease = readWatchdogLease(store, "conv-canceled");
    store.setMeta(`watchdog_lease:conv-canceled`, JSON.stringify({ ...canceledLease, idleAnchorTs: nowMs - 260_000 }));

    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-error" }, { nowMs: nowMs - 265_000, contextTokens: 90000, cacheTtlSec: 300 });
    await handleStopPayload(
      { conversationId: "conv-error", terminationReason: "ERROR", error: "network reset" },
      { store, effectiveCfg: cfgState }
    );
    const errLease = readWatchdogLease(store, "conv-error");
    store.setMeta(`watchdog_lease:conv-error`, JSON.stringify({ ...errLease, idleAnchorTs: nowMs - 260_000 }));

    // 4e. stale_cleanup subphase
    store.setMeta(
      "watchdog_lease:conv-stale",
      JSON.stringify({
        ...errLease,
        conversationId: "conv-stale",
        subphase: "stale_cleanup",
        stopReason: "stale_cleanup_on_restart",
        idleAnchorTs: nowMs - 260_000
      })
    );

    monitor.tick();
    assert.equal(
      notifications.length,
      1,
      "Expired, subagent, <60k, USER_CANCELED, ERROR, and stale_cleanup leases must ALL be suppressed"
    );
    assert.equal(monitor.statSyncCount, 0);

    // 5. OS sleep/wake clock jump guard: wall clock jumps +250s while monotonic clock advances 1s -> NO surprise popup!
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-sleep" }, { nowMs, contextTokens: 100000, cacheTtlSec: 300 });
    advanceSec(5);
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-sleep" }, { nowMs });
    monitor.tick(); // baseline tick before lid close
    nowMs += 250 * 1000; // remSec = 50s, but wall clock jumped without monotonic time!
    monoNs += 1_000_000_000n;
    monitor.tick();
    assert.equal(notifications.length, 1, "Sleep wake-up tick must suppress TTL notification");
    advanceSec(5); // remSec = 45s on follow-up tick after wake
    monitor.tick();
    assert.equal(notifications.length, 1, "Pre-sleep idle anchor must remain suppressed after wake");
    assert.equal(monitor.statSyncCount, 0);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5-5: Decoupled stallWatchdog=false + ttlDesktopNotify=true, env precedence over SQLite/API, GET 405 & Sidecar UI toggle", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-decouple-"));
  const dbPath = path.join(tmpDir, "context.db");
  const fakeHome = path.join(tmpDir, "home");
  const convId = "conv-decoupled-ttl";
  const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const txPath = path.join(logDir, "transcript.jsonl");

  const t0 = Date.now() - 30_000;
  fs.writeFileSync(
    txPath,
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(t0).toISOString(),
      model: "Gemini 4 Carbon (High)",
      input_tokens: 92000,
      cache_read_tokens: 0
    }) + "\n",
    "utf8"
  );

  // Verify config.js snapshot & formatEffectiveConfigLines include TTL alert settings
  const snap = getConfigSnapshot({
    env: {
      AGY_DART_TTL_DESKTOP_NOTIFY: "1",
      AGY_DART_TTL_NOTIFY_LEAD_SEC: "45",
      AGY_DART_TTL_NOTIFY_MIN_TOKENS: "75000"
    }
  });
  assert.equal(snap.values.ttlDesktopNotify, true);
  assert.equal(snap.values.ttlNotifyLeadSec, 45);
  assert.equal(snap.values.ttlNotifyMinTokens, 75000);
  assert.ok(formatEffectiveConfigLines(snap).join("\n").includes("TTL alert"));

  // 1. Run PreInvocation & Stop hooks with AGY_DART_DISABLE_STALL_WATCHDOG=1 AND AGY_DART_TTL_DESKTOP_NOTIFY=1
  const decoupledEnv = {
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    AGY_DART_DISABLE_STALL_WATCHDOG: "1",
    AGY_DART_TTL_DESKTOP_NOTIFY: "1"
  };
  const preRes = runHookRaw(
    "hooks/pre-invocation.mjs",
    { conversationId: convId, transcriptPath: txPath },
    dbPath,
    decoupledEnv
  );
  assert.equal(preRes.status, 0);
  const stopRes = runHookRaw("hooks/stop.mjs", { conversationId: convId }, dbPath, decoupledEnv);
  assert.equal(stopRes.status, 0);
  assert.equal(stopRes.stdout, '{"decision":"allow"}\n');

  const store = new ContextModeStore({ dbPath });
  const prevEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    AGY_DART_DB_PATH: process.env.AGY_DART_DB_PATH,
    AGY_DART_CONFIG_PATH: process.env.AGY_DART_CONFIG_PATH,
    AGY_DART_TTL_DESKTOP_NOTIFY: process.env.AGY_DART_TTL_DESKTOP_NOTIFY
  };
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-cfg.json");
  delete process.env.AGY_DART_TTL_DESKTOP_NOTIFY;
  closeRuntimeStore();
  resetConfigCache();

  const csrfToken = "abcdef0123456789abcdef0123456789";
  const srv = createStandaloneServer({ csrfToken });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const authHeaders = { "X-Agy-Dart-Token": csrfToken };

  try {
    const lease = readWatchdogLease(store, convId);
    assert.ok(lease, "Lease must be written when stallWatchdog=false & ttlDesktopNotify=true");
    assert.equal(lease.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(lease.subphase, "stopped");
    assert.equal(lease.contextTokens, 92000);
    assert.ok(lease.idleAnchorTs > 0);

    // WatchdogMonitor with stallWatchdog=false & ttlDesktopNotify=true fires TTL alert with 0 statSync!
    const fired = [];
    const simNow = lease.idleAnchorTs + 255 * 1000; // remSec = 45s on 300s TTL
    const decoupledMonitor = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({
        stallWatchdog: false,
        ttlKeepalive: true,
        ttlDesktopNotify: true,
        ttlNotifyLeadSec: 60,
        ttlNotifyMinTokens: 60000
      }),
      nowFn: () => simNow,
      monoNsFn: () => 50_000_000_000n,
      notifyFn: (p) => {
        fired.push(p);
        return { dispatched: true };
      }
    });
    const status = decoupledMonitor.getStatus({ conversationId: convId });
    assert.equal(status.enabled, false, "Stall watchdog remains disabled");
    assert.equal(status.ttlDesktopNotifyEnabled, true);
    assert.equal(fired.length, 1, "TTL desktop notify MUST work even when stallWatchdog=false");
    assert.equal(decoupledMonitor.statSyncCount, 0);

    // 2. Sidecar HTTP API: GET /api/watchdog/action -> 405; POST setTtlDesktopNotify toggles SQLite; env=0 beats SQLite!
    const get405 = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "GET",
      headers: authHeaders
    });
    assert.equal(get405.status, 405, "GET /api/watchdog/action must return 405");

    const toggleOn = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: { action: "setTtlDesktopNotify", enabled: true, conversationId: convId }
    });
    assert.equal(toggleOn.status, 200);
    assert.equal(toggleOn.json.ttlDesktopNotifyEnabled, true);
    assert.equal(toggleOn.json.status.ttlDesktopNotifyEnabled, true);

    process.env.AGY_DART_TTL_DESKTOP_NOTIFY = "0";
    resetConfigCache();
    const underEnvWd = await httpJsonRequest(port, "/api/watchdog", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convId }
    });
    assert.equal(underEnvWd.json.ttlDesktopNotifyEnabled, false, "AGY_DART_TTL_DESKTOP_NOTIFY=0 must beat SQLite=true");

    const underEnvAct = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: { action: "setTtlDesktopNotify", enabled: true, conversationId: convId }
    });
    assert.equal(underEnvAct.json.ttlDesktopNotifyEnabled, false);
    assert.equal(underEnvAct.json.status.ttlDesktopNotifyEnabled, false);
    delete process.env.AGY_DART_TTL_DESKTOP_NOTIFY;
    resetConfigCache();

    // 3. Verify index.html #kv-ttl-notify-btn & toggleTtlNotify() + cross-session ttlCalibration tooltip in VM
    const html = readDashboardHtml();
    assert.ok(html.includes('id="kv-ttl-notify-btn"'));
    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    const mainScript = scriptMatches[scriptMatches.length - 1][1];

    const makeClassList = (initial = []) => {
      const set = new Set(initial);
      return {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        contains: (x) => set.has(x),
        toggle: (x, force) => (force === undefined ? (set.has(x) ? set.delete(x) : set.add(x)) : force ? set.add(x) : set.delete(x))
      };
    };
    const elements = new Map();
    const getEl = (id) => {
      if (!elements.has(id)) {
        let txt = "";
        elements.set(id, {
          id,
          get innerText() {
            return txt;
          },
          set innerText(v) {
            txt = String(v ?? "");
          },
          get textContent() {
            return txt;
          },
          set textContent(v) {
            txt = String(v ?? "");
          },
          innerHTML: "",
          title: "",
          value: "",
          options: [],
          className: "",
          style: {},
          dataset: { enabled: "0" },
          classList: makeClassList(["hidden"]),
          querySelectorAll: () => [],
          addEventListener: () => {}
        });
      }
      return elements.get(id);
    };
    const postedActions = [];
    const ctx = vm.createContext({
      window: {
        location: { search: `?conversationId=${convId}` },
        addEventListener: () => {}
      },
      document: {
        title: "",
        documentElement: { lang: "en" },
        getElementById: (id) => getEl(id),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
      },
      localStorage: { getItem: () => "zh", setItem: () => {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      URLSearchParams,
      Headers,
      fetch: async (url, init) => {
        if (url === "/api/watchdog/action") {
          const b = JSON.parse(init.body);
          postedActions.push(b);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              ttlDesktopNotifyEnabled: Boolean(b.enabled),
              status: { enabled: true, desktopNotifyEnabled: false, ttlDesktopNotifyEnabled: Boolean(b.enabled), sessions: [] }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      console
    });
    vm.runInContext(mainScript, ctx);
    vm.runInContext(
      `setLanguage('zh'); renderKvCacheCard(${JSON.stringify({
        transcriptFound: true,
        turnsWithUsage: 4,
        ttlDesktopNotifyEnabled: true,
        currentContextTokens: 88000,
        cacheTtlSec: 900,
        idleSeconds: 120,
        ttlRemainingSec: 780,
        ttlStatus: "warm",
        ttlSource: "empirical",
        maxWarmHitGapSec: 840,
        ttlCalibration: {
          origin: "history",
          profileId: "gemini-4-512k",
          warmSamples: 4,
          coldSamples: 2,
          maxWarmGapSec: 840,
          minColdMissGapSec: 960,
          estimatedTtlSec: 900,
          confidence: "high"
        },
        modelProfile: { id: "gemini-4-512k", windowTokens: 512000, windowSource: "profile" }
      })});`,
      ctx
    );
    assert.ok(getEl("kv-ttl-notify-btn").textContent.includes("临期提醒：开"));
    assert.ok(getEl("kv-ttl-badge").title.includes("历史校准"), `Expected localized history calibration in tooltip: ${getEl("kv-ttl-badge").title}`);
    assert.equal(getEl("kv-ttl-badge").title.includes("(history)"), false);
    assert.ok(getEl("kv-ttl-badge").title.includes("4 热 / 2 冷"));

    await vm.runInContext("toggleTtlNotify();", ctx);
    assert.equal(postedActions.length, 1);
    assert.equal(postedActions[0].action, "setTtlDesktopNotify");
    assert.equal(postedActions[0].enabled, false);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    store.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5-6: cache:simulate Keep-Alive replay (keepalive-1x & keepalive-unlimited) — Goodhart cost proof, short-gap win & CLI --keepalive-tail", () => {
  const t0 = Date.parse("2026-11-22T10:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // 1. Long idle gaps + 75% discount (e.g. Gemini 2.5 / explicit 0.75 discount) + 30m walk-away tail:
  //    `keepalive-unlimited` inflates apparent hit rate >95%, yet costs MORE than both `observed` and `cold-boundary-compact`!
  const longIdleSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "gemini-2.5-pro",
      input_tokens: 150000,
      cache_read_tokens: 0
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(2400), // 40m idle -> 9 pings @ 0.25x = 2.25x (> 1.0x cold re-prefill!)
      model: "gemini-2.5-pro",
      input_tokens: 152000,
      cache_read_tokens: 0
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(2520), // 2m warm follow-up
      model: "gemini-2.5-pro",
      input_tokens: 2000,
      cache_read_tokens: 152000
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: iso(4920), // second 40m idle gap
      model: "gemini-2.5-pro",
      input_tokens: 156000,
      cache_read_tokens: 0
    }
  ];

  const repPenalty = simulateCachePolicies([longIdleSession], { cacheDiscountRate: 0.75, windowTokens: 200000 });
  assertAllNumbersFinite(repPenalty);
  assert.equal(repPenalty.policies.length, 9);

  const obs = repPenalty.policies.find((p) => p.id === "observed");
  const compact = repPenalty.policies.find((p) => p.id === "cold-boundary-compact");
  const ka1x = repPenalty.policies.find((p) => p.id === "keepalive-1x");
  const kaUnlim = repPenalty.policies.find((p) => p.id === "keepalive-unlimited");

  assert.equal(ka1x.hypothetical, true);
  assert.equal(kaUnlim.hypothetical, true);
  assert.notEqual(repPenalty.recommendedPolicy, "keepalive-1x");
  assert.notEqual(repPenalty.recommendedPolicy, "keepalive-unlimited");

  assert.ok(
    kaUnlim.projectedHitRate > obs.projectedHitRate && kaUnlim.projectedHitRate > 0.95,
    `Expected inflated apparent hit rate >95%, got ${kaUnlim.projectedHitRate}`
  );
  assert.ok(
    kaUnlim.projectedHitRate > kaUnlim.userTurnHitRate,
    `Apparent hit rate (${kaUnlim.projectedHitRate}) should exceed real-turn hit rate (${kaUnlim.userTurnHitRate})`
  );
  assert.ok(
    kaUnlim.projectedInputCostUsd > obs.projectedInputCostUsd,
    `Expected keepalive-unlimited ($${kaUnlim.projectedInputCostUsd}) > observed ($${obs.projectedInputCostUsd})`
  );
  assert.ok(
    kaUnlim.projectedInputCostUsd > compact.projectedInputCostUsd,
    `Expected keepalive-unlimited ($${kaUnlim.projectedInputCostUsd}) > cold-boundary-compact ($${compact.projectedInputCostUsd})`
  );
  assert.ok(kaUnlim.tailPings >= 1 && kaUnlim.wastedPings >= kaUnlim.tailPings);
  assert.ok(repPenalty.rationale.includes("keepalive-unlimited"), `Expected counterfactual rationale insight: ${repPenalty.rationale}`);

  // 2. Short single-bridgeable pause (420s gap on 300s TTL, 90% discount, keepaliveTailSec: 0):
  //    `keepalive-1x` bridges with 1 ping (0.10x) and beats observed cold re-prefill (1.0x), still never hijacking recommendedPolicy!
  const shortPauseSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "Gemini 4 Carbon (High)",
      input_tokens: 120000,
      cache_read_tokens: 0
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(420), // 7m gap: < 300 + 255 = 555s -> 1 ping bridges it!
      model: "Gemini 4 Carbon (High)",
      input_tokens: 122000,
      cache_read_tokens: 0
    }
  ];
  const repBridge = simulateCachePolicies([shortPauseSession], { keepaliveTailSec: 0 });
  assertAllNumbersFinite(repBridge);
  const bObs = repBridge.policies.find((p) => p.id === "observed");
  const bKa1x = repBridge.policies.find((p) => p.id === "keepalive-1x");
  assert.equal(bKa1x.interTurnPings, 1);
  assert.equal(bKa1x.tailPings, 0);
  assert.equal(bKa1x.wastedPings, 0);
  assert.equal(bKa1x.avoidedIdleBusts, 1);
  assert.ok(
    bKa1x.projectedInputCostUsd < bObs.projectedInputCostUsd,
    `Single bridgeable pause must make keepalive-1x ($${bKa1x.projectedInputCostUsd}) cheaper than cold bust ($${bObs.projectedInputCostUsd})`
  );
  assert.notEqual(repBridge.recommendedPolicy, "keepalive-1x", "Hypothetical policy must never become recommendedPolicy");

  const md = formatSimulationMarkdown(repPenalty);
  assert.ok(md.includes("`keepalive-1x` *(sim-only)*"));
  assert.ok(md.includes("`keepalive-unlimited` *(sim-only)*"));
  assert.ok(md.includes("Host/proxy-only (excl. out/thinking)"));

  // 3. CLI `--keepalive-tail 0` & empty/0-usage safety
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-sim-cli-"));
  const fixturePath = path.join(tmpDir, "short_pause.jsonl");
  fs.writeFileSync(fixturePath, shortPauseSession.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  try {
    const cliZeroTail = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", "simulate", fixturePath, "--keepalive-tail", "0", "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(cliZeroTail.status, 0, cliZeroTail.stderr);
    const cliParsed = JSON.parse(cliZeroTail.stdout);
    assertAllNumbersFinite(cliParsed);
    assert.equal(cliParsed.policies.find((p) => p.id === "keepalive-1x").tailPings, 0);

    const emptyRep = simulateCachePolicies([]);
    assertAllNumbersFinite(emptyRep);
    for (const id of ["keepalive-1x", "keepalive-unlimited"]) {
      const p = emptyRep.policies.find((x) => x.id === id);
      assert.equal(p.projectedHitRate, 0);
      assert.equal(p.userTurnHitRate, 0);
      assert.equal(p.keepalivePings, 0);
      assert.equal(p.projectedInputCostUsd, 0);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5-7: Chinese (uiLang='zh') localization across desktop popups, PreInvocation UI-only banners & Sidecar 中文/EN sync", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v15-zh-i18n-"));
  const dbPath = path.join(tmpDir, "context.db");
  const fakeHome = path.join(tmpDir, "home");
  const convId = "conv-zh-alerts";
  const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const txPath = path.join(logDir, "transcript.jsonl");

  const now = Date.now();
  fs.writeFileSync(
    txPath,
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(now - 600 * 1000).toISOString(), // 10m idle (>5m TTL)
      model: "Gemini 4 Carbon (High)",
      media: [{ tokens: 1200 }],
      input_tokens: 420000, // critical watermark (>=410k on 512k) + multimodal (>=150k) + expired TTL
      cache_read_tokens: 0
    }) + "\n",
    "utf8"
  );

  const store = new ContextModeStore({ dbPath });
  const prevEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    AGY_DART_DB_PATH: process.env.AGY_DART_DB_PATH,
    AGY_DART_CONFIG_PATH: process.env.AGY_DART_CONFIG_PATH,
    AGY_DART_LANG: process.env.AGY_DART_LANG
  };
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-cfg.json");
  delete process.env.AGY_DART_LANG;
  closeRuntimeStore();
  resetConfigCache();

  const csrfToken = "1234567890abcdef1234567890abcdef";
  const srv = createStandaloneServer({ csrfToken });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const authHeaders = { "X-Agy-Dart-Token": csrfToken };

  try {
    // 1. Toggle uiLang to 'zh' via Sidecar /api/watchdog/action -> persists in SQLite; AGY_DART_LANG=en overrides SQLite
    const setZh = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: { action: "setUiLang", lang: "zh", conversationId: convId }
    });
    assert.equal(setZh.status, 200);
    assert.equal(setZh.json.uiLang, "zh");
    assert.equal(setZh.json.uiLangSource, "sqlite");
    assert.equal(store.getUiLang(), "zh");

    process.env.AGY_DART_LANG = "en";
    resetConfigCache();
    assert.equal(store.getUiLang(), "en", "AGY_DART_LANG=en must override SQLite ui:lang=zh");
    delete process.env.AGY_DART_LANG;
    resetConfigCache();
    assert.equal(store.getUiLang(), "zh");

    // 2. Live PreInvocation hook (with opt-in inline alerts) emits localized Chinese banners with strictly empty systemMessage: "" (0 model tokens)
    const hookZh = runHookRaw(
      "hooks/pre-invocation.mjs",
      { conversationId: convId, transcriptPath: txPath },
      dbPath,
      { USERPROFILE: fakeHome, HOME: fakeHome, AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(hookZh.status, 0);
    assert.equal(Buffer.byteLength(hookZh.stderr || "", "utf8"), 0);
    const parsedHook = JSON.parse(hookZh.stdout);
    assert.equal(parsedHook.injectSteps?.length, 1);
    assert.equal(parsedHook.injectSteps[0].systemMessage.systemMessage, "");
    const userMd = parsedHook.injectSteps[0].systemMessage.metadata?.user_markdown || "";
    assert.ok(userMd.includes("[agy-dart 缓存守卫]"), `Expected Chinese badge: ${userMd}`);
    assert.ok(userMd.includes("告急水位") && userMd.includes("交接简报"), `Expected Chinese critical watermark alert: ${userMd}`);
    assert.ok(userMd.includes("已空闲") && userMd.includes("冷重填"), `Expected Chinese TTL expired alert: ${userMd}`);
    assert.ok(userMd.includes("多模态附件"), `Expected Chinese multimodal alert: ${userMd}`);

    // 3. Both TTL Expiring AND Stall Watchdog OS desktop notifications emit UTF-8-safe Chinese (<=60B title, <=220B body)
    const desktopPopups = [];
    let simMs = 1_765_000_000_000;
    let monoNs = 20_000_000_000n;
    const zhMonitor = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({
        stallWatchdog: true,
        watchdogDesktopNotify: true,
        ttlKeepalive: true,
        ttlDesktopNotify: true,
        ttlNotifyLeadSec: 60,
        ttlNotifyMinTokens: 60000
      }),
      nowFn: () => simMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: (p) => {
        desktopPopups.push(p);
        return { dispatched: true };
      }
    });

    // 3a. Idle TTL expiring popup in Chinese
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-zh-ttl", lastUserInput: "SECRET_PROMPT_NEVER_LEAK" },
      { nowMs: simMs - 260_000, contextTokens: 90000, cacheTtlSec: 300 }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-zh-ttl" }, { nowMs: simMs - 255_000 });

    // 3b. Active stalled tool popup in Chinese
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-zh-stall", toolCall: { id: "tc-1", name: "run_command", args: { CommandLine: "npm test" } } },
      { nowMs: simMs - 320_000, contextTokens: 50000 }
    );

    zhMonitor.tick();
    assert.equal(desktopPopups.length, 2);
    const stallPop = desktopPopups.find((p) => p.conversationId === "conv-zh-stall");
    const ttlPop = desktopPopups.find((p) => p.conversationId === "conv-zh-ttl");

    for (const pop of [stallPop, ttlPop]) {
      assert.ok(pop, "Expected both Chinese stall & TTL desktop popups");
      assert.ok(!pop.title.includes("\uFFFD") && !pop.body.includes("\uFFFD"), "Must never split UTF-8 CJK characters");
      assert.ok(Buffer.byteLength(pop.title, "utf8") <= 60, `Title must be <=60B: ${pop.title}`);
      assert.ok(Buffer.byteLength(pop.body, "utf8") <= 220, `Body must be <=220B: ${pop.body}`);
      assert.equal(pop.body.includes("SECRET_PROMPT_NEVER_LEAK"), false);
      const winSpec = buildDesktopNotificationCommand({ title: pop.title, body: pop.body, platform: "win32", baseEnv: {} });
      assert.equal(winSpec.env.AGY_DART_NOTIFY_TITLE, pop.title);
    }
    assert.equal(stallPop.title, "agy-dart：对话疑似卡住");
    assert.ok(stallPop.body.includes("抢救简报"));
    assert.equal(ttlPop.title, "agy-dart：缓存即将过期");
    assert.ok(ttlPop.body.includes("90k 上下文热缓存"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    store.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
