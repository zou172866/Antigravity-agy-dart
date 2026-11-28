import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONFIG_DEFAULTS,
  formatEffectiveConfigLines,
  getConfigSnapshot,
  getEffectiveConfig,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  TTL_KEEPALIVE_PROMPT_RE,
  hasPendingKeepaliveColdCheck,
  inspectLatestTurnInSteps,
  isKeepaliveTurnFlushedForRound,
  isTtlKeepalivePrompt,
  parseStepPrefillTimestampInfo,
  readWatchdogLease,
  recordHookLeaseTransition,
  WATCHDOG_PHASES,
  writeWatchdogLease
} from "../context/lib/watchdog-lease.js";
import {
  WatchdogMonitor,
  buildManualKeepaliveMessage,
  computeEffectiveKeepaliveMinRemainSec,
  computeLeaseTtlTiming,
  isKeepalivePendingAckActive,
  resolveLeaseCacheOriginTs
} from "../context/lib/watchdog.js";
import { handleStopPayload } from "../hooks/stop.mjs";
import {
  closeRuntimeStore,
  createStandaloneServer,
  getWatchdogMonitor,
  registerSidecarRoutes,
  stopWatchdogMonitor
} from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function flushMicrotasks(rounds = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

function makeControlledClock(startMs = 1_820_000_000_000) {
  let wallMs = startMs;
  let monoNs = 10_000_000_000n;
  return {
    now: () => wallMs,
    mono: () => monoNs,
    set(nextMs) {
      const delta = Math.max(0, nextMs - wallMs);
      wallMs = nextMs;
      monoNs += BigInt(delta) * 1_000_000n;
    },
    advanceSec(sec) {
      wallMs += sec * 1000;
      monoNs += BigInt(Math.max(0, sec)) * 1_000_000_000n;
    }
  };
}

function httpJsonRequest(port, reqPath, { method = "POST", headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(payload !== null ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function makeTempEnv(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");
  return { tmpDir, dbPath, cfgPath };
}

function seedStoppedLease(store, convId, {
  cacheOriginTs,
  idleAnchorTs,
  contextTokens = 90_000,
  windowTokens = 200_000,
  cacheTtlSec = 300,
  model = "claude-opus-4-6-thinking",
  subphase = "stopped",
  stopReason = "NO_TOOL_CALL",
  transcriptPath = "",
  isSubagent = false
}) {
  return writeWatchdogLease(store, {
    conversationId: convId,
    rootSessionId: convId,
    convTitle: `Title ${convId}`,
    phase: WATCHDOG_PHASES.IDLE,
    subphase,
    stopReason,
    contextTokens,
    windowTokens,
    cacheTtlSec,
    ttlSource: "profile",
    model,
    isSubagent,
    transcriptPath,
    startedTs: cacheOriginTs > 0 ? cacheOriginTs : idleAnchorTs,
    lastLlmStartTs: cacheOriginTs > 0 ? cacheOriginTs : idleAnchorTs,
    cacheOriginTs: cacheOriginTs ?? 0,
    idleAnchorTs,
    phaseChangedTs: idleAnchorTs,
    updatedTs: idleAnchorTs
  });
}

// ---------------------------------------------------------------------------
// Row 1: 配置优先级和边界
// ---------------------------------------------------------------------------
test("v1.7.4-1: ttlKeepaliveMinRemainSec defaults, env > config precedence, explicit 0, bounds & diagnostics", () => {
  const { tmpDir, cfgPath } = makeTempEnv("agy-v174-cfg-");
  try {
    resetConfigCache();
    assert.equal(CONFIG_DEFAULTS.ttlKeepaliveMinRemainSec, 15);

    const defSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(defSnap.values.ttlKeepaliveMinRemainSec, 15);
    assert.equal(defSnap.sources.ttlKeepaliveMinRemainSec, "default");
    assert.equal(getEffectiveConfig({ configPath: cfgPath, env: {} }).ttlKeepaliveMinRemainSec, 15);
    const defLines = formatEffectiveConfigLines(defSnap).join("\n");
    assert.ok(defLines.includes("minRem=15s"), `Expected minRem=15s in diagnostic lines:\n${defLines}`);

    // config.json sets 25
    fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepaliveMinRemainSec: 25 }), "utf8");
    resetConfigCache();
    const fileSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(fileSnap.values.ttlKeepaliveMinRemainSec, 25);
    assert.equal(fileSnap.sources.ttlKeepaliveMinRemainSec, "config");
    assert.ok(formatEffectiveConfigLines(fileSnap).join("\n").includes("minRem=25s"));
    assert.ok(formatEffectiveConfigLines(fileSnap).join("\n").includes("ttlKeepaliveMinRemainSec=25 (config)"));

    // env overrides config.json (including explicit 0 to disable narrow-margin protection)
    const envZeroSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_MIN_REMAIN_SEC: "0" }
    });
    assert.equal(envZeroSnap.values.ttlKeepaliveMinRemainSec, 0);
    assert.equal(envZeroSnap.sources.ttlKeepaliveMinRemainSec, "env");
    assert.ok(formatEffectiveConfigLines(envZeroSnap).join("\n").includes("minRem=0s"));

    // Explicit 0 in config.json also takes effect
    fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepaliveMinRemainSec: 0 }), "utf8");
    resetConfigCache();
    const cfgZeroSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(cfgZeroSnap.values.ttlKeepaliveMinRemainSec, 0);
    assert.equal(cfgZeroSnap.sources.ttlKeepaliveMinRemainSec, "config");

    // Out-of-bounds: >120 clamps to 120; negative / non-numeric ignored per config contract
    const clampHighSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_MIN_REMAIN_SEC: "999" }
    });
    assert.equal(clampHighSnap.values.ttlKeepaliveMinRemainSec, 120);
    assert.equal(clampHighSnap.sources.ttlKeepaliveMinRemainSec, "env");

    fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepaliveMinRemainSec: 22 }), "utf8");
    resetConfigCache();
    const negEnvSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_MIN_REMAIN_SEC: "-5" }
    });
    assert.equal(negEnvSnap.values.ttlKeepaliveMinRemainSec, 22, "Negative env must fall back to config");
    assert.equal(negEnvSnap.sources.ttlKeepaliveMinRemainSec, "config");

    const invalidEnvSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_MIN_REMAIN_SEC: "not-a-number" }
    });
    assert.equal(invalidEnvSnap.values.ttlKeepaliveMinRemainSec, 22);
    assert.equal(invalidEnvSnap.sources.ttlKeepaliveMinRemainSec, "config");

    fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepaliveMinRemainSec: -10 }), "utf8");
    resetConfigCache();
    const negFileSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(negFileSnap.values.ttlKeepaliveMinRemainSec, 15, "Negative config must fall back to default 15");
    assert.equal(negFileSnap.sources.ttlKeepaliveMinRemainSec, "default");
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Row 2: 默认 60 秒提前量 + 投递延迟叠加 + 同周期内存去重 & 零 statSync / 零写盘
// ---------------------------------------------------------------------------
test("v1.7.4-2: Default 60s lead narrow-margin guard (D=0 & D=8), per-cycle skip dedup, zero statSync & cycle cleanup", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-60s-");
  const store = new ContextModeStore({ dbPath });
  store.open();
  store.setGlobalTtlKeepaliveMaxCount(2);

  try {
    const clock = makeControlledClock();
    const sent = [];
    let statCalls = 0;
    const cfg = {
      stallWatchdog: true,
      ttlKeepalive: true,
      ttlKeepaliveMaxCount: 2,
      ttlKeepaliveLeadSec: 60,
      ttlKeepaliveMinRemainSec: 15,
      ttlKeepaliveMinContextPct: 15
    };
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      statFn: () => {
        statCalls += 1;
        throw new Error("Pure IDLE polling must perform 0 statSync");
      },
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // D=0: rem=15 skips, rem=16 sends
    const t0 = clock.now();
    seedStoppedLease(store, "conv-d0-skip", { cacheOriginTs: t0, idleAnchorTs: t0 + 20_000 });
    seedStoppedLease(store, "conv-d0-send", { cacheOriginTs: t0 + 1_000, idleAnchorTs: t0 + 21_000 });

    // At t0 + 285s: conv-d0-skip rem=15s (skip), conv-d0-send rem=16s (send)
    clock.set(t0 + 285_000);
    const metaBefore = store.getMeta("cache:ttl_keepalive_state:conv-d0-skip", null);
    mon.tick();
    await flushMicrotasks();

    assert.equal(statCalls, 0, "IDLE polling must have 0 statSync");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].conversationId, "conv-d0-send");
    assert.equal(mon.ttlKeepaliveNarrowSkippedCount, 1);
    assert.equal(store.getMeta("cache:ttl_keepalive_state:conv-d0-skip", null), metaBefore, "Narrow skip must not write SQLite");

    const stSkip = mon.getStatus({ conversationId: "conv-d0-skip", refresh: false });
    assert.equal(stSkip.ttlKeepalive.narrowMarginSkipped, true);
    assert.equal(stSkip.ttlKeepalive.narrowMarginRemSec, 15);
    assert.equal(stSkip.ttlKeepalive.minRemainSec, 15);
    assert.equal(stSkip.ttlKeepalive.effectiveMinRemainSec, 15);
    assert.equal(stSkip.stats.ttlKeepaliveNarrowSkippedCount, 1);

    // Repeated polling within the SAME idle cycle (rem=14s, rem=10s) must keep count === 1
    clock.set(t0 + 286_000);
    mon.tick();
    clock.set(t0 + 290_000);
    mon.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 1);
    assert.equal(mon.ttlKeepaliveNarrowSkippedCount, 1, "Same idle cycle must deduplicate skip count");
    assert.equal(statCalls, 0);

    // New idle cycle clears prior narrowMarginSkipped entry
    const tNew = clock.now() + 10_000;
    clock.set(tNew);
    seedStoppedLease(store, "conv-d0-skip", { cacheOriginTs: tNew - 5_000, idleAnchorTs: tNew });
    mon.tick();
    const stCleared = mon.getStatus({ conversationId: "conv-d0-skip", refresh: false });
    assert.equal(stCleared.ttlKeepalive.narrowMarginSkipped, false);
    assert.equal(stCleared.ttlKeepalive.narrowMarginRemSec, null);
    store.deleteMeta("watchdog_lease:conv-d0-skip");

    // D=8 (deliveryMs = 7500ms -> ceil(7.5) = 8s): M = max(8, min(floor(68/2)=34, 15+8=23)) = 23
    store.setMeta("cache:ttl_keepalive_delivery_ms", "7500");
    const t1 = clock.now() + 5_000;
    seedStoppedLease(store, "conv-d8-skip", { cacheOriginTs: t1, idleAnchorTs: t1 + 10_000 });
    seedStoppedLease(store, "conv-d8-send", { cacheOriginTs: t1 + 1_000, idleAnchorTs: t1 + 11_000 });
    sent.length = 0;

    // At t1 + 277s: conv-d8-skip rem=23s (skip), conv-d8-send rem=24s (send)
    clock.set(t1 + 277_000);
    mon.tick();
    await flushMicrotasks();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].conversationId, "conv-d8-send");
    assert.equal(mon.ttlKeepaliveNarrowSkippedCount, 2);
    const stD8 = mon.getStatus({ conversationId: "conv-d8-skip", refresh: false });
    assert.equal(stD8.ttlKeepalive.narrowMarginSkipped, true);
    assert.equal(stD8.ttlKeepalive.effectiveMinRemainSec, 23);
    assert.equal(statCalls, 0);

    // Lease disappearance cleans up memory entry
    store.deleteMeta("watchdog_lease:conv-d8-skip");
    mon.tick();
    assert.equal(mon.getStatus({ conversationId: "conv-d8-skip", refresh: false }).ttlKeepalive.narrowMarginSkipped, false);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Row 3: 短提前量和显式关闭 + 原 30s 提前量 20/25s 兼容
// ---------------------------------------------------------------------------
test("v1.7.4-3: Short lead formula (lead=10 D=20 / D=0), explicit B=0 disable, and legacy lead=30 rem=20/25 compatibility", async () => {
  // Pure formula unit assertions matching M = B == 0 ? 0 : max(D, min(floor(L / 2), B + D))
  assert.equal(computeEffectiveKeepaliveMinRemainSec(15, 20, 30), 20); // lead=10, D=20 -> L=30 -> max(20, min(15, 35))=20
  assert.equal(computeEffectiveKeepaliveMinRemainSec(15, 0, 10), 5);   // lead=10, D=0 -> L=10 -> max(0, min(5, 15))=5
  assert.equal(computeEffectiveKeepaliveMinRemainSec(0, 20, 80), 0);   // B=0 -> 0
  assert.equal(computeEffectiveKeepaliveMinRemainSec(15, 0, 30), 15);  // lead=30, D=0 -> L=30 -> 15

  const { tmpDir, dbPath } = makeTempEnv("agy-v174-short-");
  const store = new ContextModeStore({ dbPath });
  store.open();
  store.setGlobalTtlKeepaliveMaxCount(2);

  try {
    const clock = makeControlledClock();
    const sent = [];
    let cfg = {
      stallWatchdog: true,
      ttlKeepalive: true,
      ttlKeepaliveMaxCount: 2,
      ttlKeepaliveLeadSec: 10,
      ttlKeepaliveMinRemainSec: 15,
      ttlKeepaliveMinContextPct: 15
    };
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // 3a. lead=10, D=20 (deliveryMs=20000): L=30, M=20 -> rem=16 skips, rem=21 sends
    store.setMeta("cache:ttl_keepalive_delivery_ms", "20000");
    const tA = clock.now();
    seedStoppedLease(store, "conv-l10-d20-skip", { cacheOriginTs: tA, idleAnchorTs: tA + 10_000 });
    seedStoppedLease(store, "conv-l10-d20-send", { cacheOriginTs: tA + 5_000, idleAnchorTs: tA + 15_000 });
    clock.set(tA + 284_000); // rem=16 and rem=21
    mon.tick();
    await flushMicrotasks();
    assert.deepEqual(sent.map((s) => s.conversationId), ["conv-l10-d20-send"]);
    assert.equal(mon.getStatus({ conversationId: "conv-l10-d20-skip", refresh: false }).ttlKeepalive.narrowMarginSkipped, true);

    // 3b. lead=10, D=0: L=10, M=5 -> rem=5 skips, rem=6 sends
    store.setMeta("cache:ttl_keepalive_delivery_ms", "0");
    sent.length = 0;
    const tB = clock.now() + 10_000;
    seedStoppedLease(store, "conv-l10-d0-skip", { cacheOriginTs: tB, idleAnchorTs: tB + 10_000 });
    seedStoppedLease(store, "conv-l10-d0-send", { cacheOriginTs: tB + 1_000, idleAnchorTs: tB + 11_000 });
    clock.set(tB + 295_000); // rem=5 and rem=6
    mon.tick();
    await flushMicrotasks();
    assert.deepEqual(sent.map((s) => s.conversationId), ["conv-l10-d0-send"]);

    // 3c. Explicit B=0: only blocks expired (rem <= 0); rem=1 sends, rem=0 skips
    cfg = { ...cfg, ttlKeepaliveLeadSec: 60, ttlKeepaliveMinRemainSec: 0 };
    sent.length = 0;
    const tC = clock.now() + 10_000;
    seedStoppedLease(store, "conv-b0-expired", { cacheOriginTs: tC, idleAnchorTs: tC + 10_000 });
    seedStoppedLease(store, "conv-b0-rem1", { cacheOriginTs: tC + 1_000, idleAnchorTs: tC + 11_000 });
    clock.set(tC + 300_000); // rem=0 (expired) and rem=1 (sends)
    mon.tick();
    await flushMicrotasks();
    assert.deepEqual(sent.map((s) => s.conversationId), ["conv-b0-rem1"]);

    // 3d. Legacy lead=30, D=0, default B=15: rem=20 and rem=25 both send
    cfg = { ...cfg, ttlKeepaliveLeadSec: 30, ttlKeepaliveMinRemainSec: 15 };
    sent.length = 0;
    const tD = clock.now() + 10_000;
    seedStoppedLease(store, "conv-l30-r20", { cacheOriginTs: tD, idleAnchorTs: tD + 10_000 });
    seedStoppedLease(store, "conv-l30-r25", { cacheOriginTs: tD + 5_000, idleAnchorTs: tD + 15_000 });
    clock.set(tD + 280_000); // rem=20 and rem=25
    mon.tick();
    await flushMicrotasks();
    assert.deepEqual(sent.map((s) => s.conversationId).sort(), ["conv-l30-r20", "conv-l30-r25"]);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Row 4: 锚点、回填和提醒
// ---------------------------------------------------------------------------
test("v1.7.4-4: Shared origin anchor (TTL=300 Stop=t0+90 -> rem=55 at t0+245), legacy fallback, backfill->skip->notify, already-sent suppression & global-off silence", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-notify-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const clock = makeControlledClock();
    const notifications = [];
    const sent = [];
    let statCalls = 0;
    let cfg = {
      stallWatchdog: true,
      ttlDesktopNotify: true,
      ttlNotifyLeadSec: 60,
      ttlNotifyMinTokens: 60_000,
      ttlKeepalive: false,
      ttlKeepaliveMaxCount: 1,
      ttlKeepaliveLeadSec: 60,
      ttlKeepaliveMinRemainSec: 15,
      ttlKeepaliveMinContextPct: 15
    };
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      statFn: () => {
        statCalls += 1;
        throw new Error("IDLE path must never call statSync");
      },
      notifyFn: (p) => {
        notifications.push(p);
        return { dispatched: true };
      },
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // 4a. Global OFF (maxCount=0, no per-window override) -> desktop reminder stays silent
    const t0 = clock.now();
    seedStoppedLease(store, "conv-origin-90s", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 90_000,
      contextTokens: 90_000
    });
    clock.set(t0 + 245_000); // Stop was 155s ago, but origin was 245s ago -> rem=55s
    mon.tick();
    assert.equal(notifications.length, 0, "Global OFF must silence TTL reminder");
    assert.equal(sent.length, 0);

    // Enable per-window keepalive with no sender to verify pure reminder at t0+245s (rem=55s), firing ONCE
    const monNotifyOnly = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ...cfg, ttlKeepalive: true }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      statFn: () => {
        statCalls += 1;
        throw new Error("IDLE path must never call statSync");
      },
      notifyFn: (p) => {
        notifications.push(p);
        return { dispatched: true };
      }
    });
    monNotifyOnly.tick();
    assert.equal(notifications.length, 1, "Must notify once at t0+245s (55s left from cacheOriginTs)");
    assert.ok(notifications[0].body.includes("~55s"), `Expected ~55s in body, got: ${notifications[0].body}`);
    // Second tick in same idle cycle must NOT duplicate
    clock.set(t0 + 250_000);
    monNotifyOnly.tick();
    assert.equal(notifications.length, 1, "Same idle cycle must only remind once");

    // 4b. Legacy lease missing cacheOriginTs falls back to idleAnchorTs
    clock.advanceSec(70); // pass 60s global notify throttle
    const tLegacy = clock.now();
    store.setMeta(
      "watchdog_lease:conv-legacy-no-origin",
      JSON.stringify({
        conversationId: "conv-legacy-no-origin",
        rootSessionId: "conv-legacy-no-origin",
        phase: "IDLE",
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: 85_000,
        windowTokens: 200_000,
        cacheTtlSec: 300,
        idleAnchorTs: tLegacy - 250_000,
        phaseChangedTs: tLegacy - 250_000,
        updatedTs: tLegacy - 250_000
      })
    );
    const legacyLease = readWatchdogLease(store, "conv-legacy-no-origin");
    assert.equal(resolveLeaseCacheOriginTs(legacyLease, legacyLease.idleAnchorTs), legacyLease.idleAnchorTs);
    monNotifyOnly.tick();
    assert.equal(notifications.length, 2, "Legacy lease without cacheOriginTs must fall back to idleAnchorTs");
    assert.ok(notifications[1].body.includes("~50s"), `Expected ~50s, got: ${notifications[1].body}`);

    // 4c. Turn-0 backfill moves remSec into narrow-margin skip zone -> auto skips & desktop reminder fires in SAME tick!
    clock.advanceSec(70); // clear 60s global throttle
    store.setGlobalTtlKeepaliveMaxCount(1);
    cfg = { ...cfg, ttlKeepalive: true };
    const tBf = clock.now();
    const txBf = path.join(tmpDir, "tx-backfill-skip.jsonl");
    fs.writeFileSync(
      txBf,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tBf).toISOString(), content: "大上下文任务" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: new Date(tBf).toISOString(),
          model: "claude-opus-4-6-thinking",
          max_token_limit: 200_000,
          input_tokens: 95_000,
          cache_read_tokens: 0,
          output_tokens: 200
        }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    // Lease at Stop had contextTokens=0 and missing cacheOriginTs (idleAnchorTs=tBf+40s)
    // At tBf+286s: pre-backfill remSec = 300 - 246 = 54s (enters trigger window <=60s),
    // post-backfill origin=tBf -> remSec = 300 - 286 = 14s <= 15s (drops into narrow-margin skip zone!)
    seedStoppedLease(store, "conv-backfill-skip", {
      cacheOriginTs: 0,
      idleAnchorTs: tBf + 40_000,
      contextTokens: 0,
      transcriptPath: txBf
    });
    // Also seed a session that ALREADY sent keepalive on this idle cycle -> must NOT popup and must NOT record narrow skip
    seedStoppedLease(store, "conv-already-sent", {
      cacheOriginTs: tBf,
      idleAnchorTs: tBf + 40_000,
      contextTokens: 90_000
    });
    store.setTtlKeepaliveState("conv-already-sent", {
      usedCount: 1,
      lastIdleAnchorTs: tBf + 40_000,
      lastSentTs: tBf + 240_000,
      pendingAck: false
    });

    clock.set(tBf + 286_000);
    notifications.length = 0;
    sent.length = 0;
    mon.tick();
    await flushMicrotasks();

    assert.equal(sent.length, 0, "Backfill pushing remSec=14s <= 15s must skip auto keepalive");
    assert.equal(mon.ttlKeepaliveNarrowSkippedCount, 1);
    assert.equal(mon.getStatus({ conversationId: "conv-backfill-skip", refresh: false }).ttlKeepalive.narrowMarginSkipped, true);
    assert.equal(mon.getStatus({ conversationId: "conv-already-sent", refresh: false }).ttlKeepalive.narrowMarginSkipped, false);
    assert.equal(notifications.length, 1, "Uncovered narrow-skipped session must still trigger desktop reminder in same tick");
    assert.equal(notifications[0].conversationId, "conv-backfill-skip");
    assert.ok(notifications[0].body.includes("~14s"), `Expected backfilled ~14s in popup body, got: ${notifications[0].body}`);
    assert.equal(statCalls, 0);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Row 5: 手动资格、逐项拦截分支与多端/自动/事务竞态
// ---------------------------------------------------------------------------
test("v1.7.4-5: Manual keepalive eligibility matrix (auto OFF, all rejection reasons) & concurrency/tx races", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-manual-");
  const store = new ContextModeStore({ dbPath });
  store.open();
  // Auto-keepalive explicitly OFF (default)
  assert.equal(store.getGlobalTtlKeepaliveMaxCount(), 0);

  try {
    const clock = makeControlledClock();
    const sent = [];
    let killedIds = new Set(["conv-killed"]);
    const makeMonitor = (overrides = {}) =>
      new WatchdogMonitor({
        getStore: () => store,
        getConfig: () => ({
          stallWatchdog: true,
          ttlKeepalive: false,
          ttlKeepaliveMaxCount: 1,
          ttlKeepaliveLeadSec: 60,
          ttlKeepaliveMinRemainSec: 15
        }),
        nowFn: clock.now,
        monoNsFn: clock.mono,
        lookupSummaryFn: (cid) => ({
          found: true,
          killed: killedIds.has(cid),
          isSubagent: cid === "conv-sub-summary",
          title: `Summary ${cid}`
        }),
        keepaliveSendFn: async (p) => {
          sent.push(p);
          return { ok: true };
        },
        ...overrides
      });

    const mon = makeMonitor();
    const t0 = clock.now();

    // Verify EN & ZH manual messages match TTL_KEEPALIVE_PROMPT_RE and instruct OK-only + no tools
    const msgEn = buildManualKeepaliveMessage("en");
    const msgZh = buildManualKeepaliveMessage("zh");
    assert.ok(TTL_KEEPALIVE_PROMPT_RE.test(msgEn) && isTtlKeepalivePrompt(msgEn));
    assert.ok(TTL_KEEPALIVE_PROMPT_RE.test(msgZh) && isTtlKeepalivePrompt(msgZh));
    assert.match(msgEn, /Reply OK only/i);
    assert.match(msgEn, /Do not call any tools/i);
    assert.match(msgZh, /仅回复 OK/);
    assert.match(msgZh, /勿调用任何工具/);

    // 5a. Invalid / unbound IDs -> 400
    for (const badId of ["", "   ", "__unbound__", "default", "all", "../escape", "-bad", "a/b"]) {
      const r = mon.triggerManualKeepalive(badId);
      assert.equal(r.ok, false, `Expected ok=false for badId=${JSON.stringify(badId)}`);
      assert.equal(r.status, 400);
      assert.equal(r.dispatched, false);
    }

    // 5b. No sender -> unsupported
    const monNoSender = makeMonitor({ keepaliveSendFn: null });
    assert.equal(monNoSender.triggerManualKeepalive("conv-valid").skippedReason, "unsupported");

    // 5c. No lease -> no_lease (4B)
    const noLeaseRes = mon.triggerManualKeepalive("conv-never-seen");
    assert.equal(noLeaseRes.ok, true);
    assert.equal(noLeaseRes.dispatched, false);
    assert.equal(noLeaseRes.skippedReason, "no_lease");

    // 5d. Subagent & Killed
    seedStoppedLease(store, "conv-sub-lease", { cacheOriginTs: t0, idleAnchorTs: t0 + 5_000, isSubagent: true });
    assert.equal(mon.triggerManualKeepalive("conv-sub-lease").skippedReason, "subagent");
    assert.equal(mon.triggerManualKeepalive("conv-sub-summary").skippedReason, "subagent");
    seedStoppedLease(store, "conv-killed", { cacheOriginTs: t0, idleAnchorTs: t0 + 5_000 });
    assert.equal(mon.triggerManualKeepalive("conv-killed").skippedReason, "killed");

    // 5e. Active turns (LLM_INFLIGHT, TOOL_RUNNING, SUBAGENT_BG, stopped_bg_pending)
    for (const [cid, phase, subphase] of [
      ["conv-act-llm", WATCHDOG_PHASES.LLM_INFLIGHT, "high_ctx"],
      ["conv-act-tool", WATCHDOG_PHASES.TOOL_RUNNING, "tool_cmd"],
      ["conv-act-bg", WATCHDOG_PHASES.SUBAGENT_BG, "subagent"],
      ["conv-act-bgpend", WATCHDOG_PHASES.IDLE, "stopped_bg_pending"]
    ]) {
      writeWatchdogLease(store, {
        conversationId: cid,
        rootSessionId: cid,
        phase,
        subphase,
        startedTs: t0,
        updatedTs: t0,
        idleAnchorTs: phase === WATCHDOG_PHASES.IDLE ? t0 : 0
      });
      const r = mon.triggerManualKeepalive(cid);
      assert.equal(r.dispatched, false);
      assert.equal(r.skippedReason, "turn_active", `${cid} must be blocked as turn_active`);
    }

    // 5f. Non-normal stopped subphases (including stale_cleanup, idle, user_marked_idle) & ineligible stopReason
    for (const [cid, subphase, stopReason, expectedReason] of [
      ["conv-stale", "stale_cleanup", "stale_cleanup_on_restart", "ineligible_stop_state"],
      ["conv-idle-plain", "idle", "", "ineligible_stop_state"],
      ["conv-user-idle", "user_marked_idle", "user_marked_idle", "ineligible_stop_state"],
      ["conv-canceled", "stopped", "EXECUTOR_TERMINATION_REASON_USER_CANCELED", "ineligible_stop_reason"],
      ["conv-error", "stopped", "ERROR", "ineligible_stop_reason"],
      ["conv-orphan", "stopped", "orphan_turn0_timeout", "ineligible_stop_reason"]
    ]) {
      seedStoppedLease(store, cid, {
        cacheOriginTs: t0,
        idleAnchorTs: t0 + 5_000,
        subphase,
        stopReason
      });
      const r = mon.triggerManualKeepalive(cid, { nowMs: t0 + 10_000 });
      assert.equal(r.dispatched, false);
      assert.equal(r.skippedReason, expectedReason, `${cid} expected ${expectedReason}, got ${r.skippedReason}`);
    }

    // 5g. Missing time anchor & already expired & cold_miss_tripped
    store.setMeta(
      "watchdog_lease:conv-no-anchor",
      JSON.stringify({
        conversationId: "conv-no-anchor",
        rootSessionId: "conv-no-anchor",
        phase: "IDLE",
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        idleAnchorTs: 0,
        phaseChangedTs: 0,
        updatedTs: 0
      })
    );
    assert.equal(mon.triggerManualKeepalive("conv-no-anchor", { nowMs: t0 + 10_000 }).skippedReason, "no_time_anchor");

    seedStoppedLease(store, "conv-expired", { cacheOriginTs: t0, idleAnchorTs: t0 + 10_000 });
    assert.equal(mon.triggerManualKeepalive("conv-expired", { nowMs: t0 + 305_000 }).skippedReason, "already_expired");

    seedStoppedLease(store, "conv-cold", { cacheOriginTs: t0, idleAnchorTs: t0 + 10_000 });
    store.setTtlKeepaliveState("conv-cold", { coldMissTripped: true });
    assert.equal(mon.triggerManualKeepalive("conv-cold", { nowMs: t0 + 50_000 }).skippedReason, "cold_miss_tripped");

    // 5h. Happy path with Auto-Keepalive OFF: dispatches 1x, preserves usedCount=0, records dispatch state & cooldown
    seedStoppedLease(store, "conv-manual-ok", { cacheOriginTs: t0, idleAnchorTs: t0 + 10_000 });
    clock.set(t0 + 100_000);
    const okRes = mon.triggerManualKeepalive("conv-manual-ok", { uiLang: "zh" });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.dispatched, true);
    assert.ok(okRes.dispatchId);
    assert.equal(okRes.remSec, 200);
    const claimedState = store.getTtlKeepaliveState("conv-manual-ok");
    assert.equal(claimedState.usedCount, 0, "Manual keepalive must preserve usedCount=0");
    assert.equal(claimedState.pendingAck, true);
    assert.equal(claimedState.lastDispatchId, okRes.dispatchId);
    assert.equal(claimedState.lastDispatchMode, "manual");
    assert.equal(claimedState.lastIdleAnchorTs, t0 + 10_000);
    assert.equal(claimedState.lastSentTs, t0 + 100_000);

    // Immediate second click while in-flight is blocked
    assert.equal(mon.triggerManualKeepalive("conv-manual-ok").skippedReason, "in_flight");
    await flushMicrotasks();
    assert.equal(sent.length, 1);
    assert.equal(mon.manualKeepaliveCount, 1);
    assert.ok(TTL_KEEPALIVE_PROMPT_RE.test(sent[0].message));

    // After send resolves but still pendingAck -> pending_ack
    assert.equal(mon.triggerManualKeepalive("conv-manual-ok").skippedReason, "pending_ack");
    // Even if pendingAck cleared, same idle cycle is blocked as already_dispatched
    store.setTtlKeepaliveState("conv-manual-ok", { pendingAck: false });
    assert.equal(mon.triggerManualKeepalive("conv-manual-ok").skippedReason, "already_dispatched");
    // Even on a brand-new idle cycle within 15s of lastSentTs -> 15s manual cooldown
    seedStoppedLease(store, "conv-manual-ok", { cacheOriginTs: t0 + 105_000, idleAnchorTs: t0 + 108_000 });
    clock.set(t0 + 110_000); // only 10s since lastSentTs (t0+100s)
    assert.equal(mon.triggerManualKeepalive("conv-manual-ok").skippedReason, "cooldown");
    // At +16s -> allowed again
    clock.set(t0 + 116_000);
    const okRes2 = mon.triggerManualKeepalive("conv-manual-ok", { uiLang: "en" });
    assert.equal(okRes2.dispatched, true);
    await flushMicrotasks();
    assert.equal(sent.length, 2);
    assert.equal(mon.manualKeepaliveCount, 2);

    // 5i. Race: Two Sidecar WatchdogMonitor instances sharing same SQLite DB click simultaneously -> at most 1 send
    const tRace = clock.now() + 30_000;
    clock.set(tRace + 50_000);
    seedStoppedLease(store, "conv-two-sidecars", { cacheOriginTs: tRace, idleAnchorTs: tRace + 5_000 });
    const sharedSent = [];
    const monA = makeMonitor({
      keepaliveSendFn: async (p) => {
        sharedSent.push({ from: "A", ...p });
        return { ok: true };
      }
    });
    const monB = makeMonitor({
      keepaliveSendFn: async (p) => {
        sharedSent.push({ from: "B", ...p });
        return { ok: true };
      }
    });
    const resA = monA.triggerManualKeepalive("conv-two-sidecars");
    const resB = monB.triggerManualKeepalive("conv-two-sidecars");
    await flushMicrotasks();
    assert.equal(Number(resA.dispatched) + Number(resB.dispatched), 1, "Two Sidecars on same cycle must produce at most 1 dispatch");
    assert.equal(sharedSent.length, 1);

    // 5j. Race: Auto keepalive & manual keepalive on same idle cycle -> at most 1 send
    const tAutoRace = clock.now() + 30_000;
    seedStoppedLease(store, "conv-auto-vs-manual", { cacheOriginTs: tAutoRace, idleAnchorTs: tAutoRace + 10_000 });
    store.setTtlKeepaliveEnabled(true, "conv-auto-vs-manual");
    clock.set(tAutoRace + 250_000); // rem=50s (inside auto trigger window)
    const raceSent = [];
    const monAuto = makeMonitor({
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 2, ttlKeepaliveLeadSec: 60, ttlKeepaliveMinRemainSec: 15 }),
      keepaliveSendFn: async (p) => {
        raceSent.push(p);
        return { ok: true };
      }
    });
    const mRes = monAuto.triggerManualKeepalive("conv-auto-vs-manual");
    monAuto.tick();
    await flushMicrotasks();
    assert.equal(mRes.dispatched, true);
    assert.equal(raceSent.length, 1, "Auto tick after manual claim in same idle cycle must NOT double-send");

    // 5k. Race: Click races with a new turn starting right before write tx commits
    const tTurnRace = clock.now() + 30_000;
    clock.set(tTurnRace + 20_000);
    seedStoppedLease(store, "conv-turn-race", { cacheOriginTs: tTurnRace, idleAnchorTs: tTurnRace + 5_000 });
    const origWriteTx = store._withWriteTx.bind(store);
    let injectedTurn = false;
    store._withWriteTx = (fn) => {
      if (!injectedTurn) {
        injectedTurn = true;
        // Simulate PreInvocation flipping lease to LLM_INFLIGHT right before tx reads it
        recordHookLeaseTransition(
          store,
          "PreInvocation",
          { conversationId: "conv-turn-race", lastUserInput: "新问题" },
          { nowMs: clock.now() }
        );
      }
      return origWriteTx(fn);
    };
    const turnRaceSent = [];
    const monTurnRace = makeMonitor({
      keepaliveSendFn: async (p) => {
        turnRaceSent.push(p);
        return { ok: true };
      }
    });
    const turnRaceRes = monTurnRace.triggerManualKeepalive("conv-turn-race");
    store._withWriteTx = origWriteTx;
    await flushMicrotasks();
    assert.equal(turnRaceRes.ok, true);
    assert.equal(turnRaceRes.dispatched, false);
    assert.equal(turnRaceRes.skippedReason, "turn_active");
    assert.equal(turnRaceSent.length, 0);

    // 5l. Write transaction failure -> returns ok:false, dispatched:false, sender call count === 0
    const tTxFail = clock.now() + 30_000;
    clock.set(tTxFail + 20_000);
    seedStoppedLease(store, "conv-tx-fail", { cacheOriginTs: tTxFail, idleAnchorTs: tTxFail + 5_000 });
    store._withWriteTx = () => {
      throw new Error("SQLITE_BUSY_SIMULATED");
    };
    const txFailSent = [];
    const monTxFail = makeMonitor({
      keepaliveSendFn: async (p) => {
        txFailSent.push(p);
        return { ok: true };
      }
    });
    const txFailRes = monTxFail.triggerManualKeepalive("conv-tx-fail");
    store._withWriteTx = origWriteTx;
    await flushMicrotasks();
    assert.equal(txFailRes.ok, false);
    assert.equal(txFailRes.dispatched, false);
    assert.equal(txFailRes.skippedReason, "tx_failed");
    assert.equal(txFailSent.length, 0, "Sender must NEVER be called when claim tx fails");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Row 6: 回滚、Hook 确认、延迟落盘冷读核验与防误熔断
// ---------------------------------------------------------------------------
test("v1.7.4-6: Rollback ownership (ACK-before-fail, stale callback after new dispatch), Stop & delayed cold-read check (incl. dashboard closed), missing cache_read & stale result safety", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-hooks-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();

  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const clock = makeControlledClock();

    // 6a. Backward compatibility: legacy keepalive JSON missing new dispatch fields reads cleanly
    store.setMeta(
      "cache:ttl_keepalive_state:conv-legacy-ka",
      JSON.stringify({ usedCount: 1, lastSentTs: 12345, pendingAck: false, coldMissTripped: false })
    );
    const legacyKa = store.getTtlKeepaliveState("conv-legacy-ka");
    assert.equal(legacyKa.usedCount, 1);
    assert.equal(legacyKa.lastDispatchId, "");
    assert.equal(legacyKa.lastDispatchMode, "");
    assert.equal(legacyKa.pendingColdCheckId, "");
    assert.equal(legacyKa.lastColdCheckedId, "");

    // 6b. ACK arrives BEFORE async failure callback -> late failure MUST NOT rollback or record lastError
    const tAck = clock.now();
    seedStoppedLease(store, "conv-ack-before-fail", { cacheOriginTs: tAck, idleAnchorTs: tAck + 10_000 });
    let rejectLateSend;
    const monAckRace = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: () =>
        new Promise((_resolve, reject) => {
          rejectLateSend = reject;
        })
    });
    clock.set(tAck + 60_000);
    const ackDispatched = monAckRace.triggerManualKeepalive("conv-ack-before-fail", { uiLang: "en" });
    assert.equal(ackDispatched.dispatched, true);
    assert.equal(store.getTtlKeepaliveState("conv-ack-before-fail").pendingAck, true);
    await flushMicrotasks();

    // PreInvocation arrives while send-message RPC is still hanging
    const preAckRun = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-ack-before-fail",
        invocationNum: 0,
        lastUserInput: buildManualKeepaliveMessage("en")
      }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });
    assert.equal(preAckRun.status, 0);
    assert.equal(preAckRun.stderr, "");
    const afterAck = store.getTtlKeepaliveState("conv-ack-before-fail");
    assert.equal(afterAck.pendingAck, false, "PreInvocation must confirm pendingAck -> false");
    assert.equal(afterAck.inKeepaliveTurn, true, "PreInvocation must mark inKeepaliveTurn -> true");
    assert.equal(afterAck.lastDispatchId, ackDispatched.dispatchId);

    // NOW the hanging send promise rejects!
    rejectLateSend(new Error("late_rpc_timeout"));
    await flushMicrotasks();
    const afterLateFail = store.getTtlKeepaliveState("conv-ack-before-fail");
    assert.equal(afterLateFail.inKeepaliveTurn, true, "Late failure after ACK must NOT clear inKeepaliveTurn");
    assert.equal(afterLateFail.lastDispatchId, ackDispatched.dispatchId, "Late failure must NOT clobber dispatchId");
    assert.equal(afterLateFail.lastError, "", "Late failure after ACK must NOT overwrite lastError");

    // 6c. Stale callback settles AFTER a newer dispatch -> must NOT wipe newer in-flight or state
    const tStale = clock.now() + 30_000;
    seedStoppedLease(store, "conv-stale-cb", { cacheOriginTs: tStale, idleAnchorTs: tStale + 5_000 });
    const pendingResolvers = [];
    const monStale = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: () =>
        new Promise((resolve, reject) => {
          pendingResolvers.push({ resolve, reject });
        })
    });
    clock.set(tStale + 20_000);
    const d1 = monStale.triggerManualKeepalive("conv-stale-cb", { uiLang: "zh" });
    assert.equal(d1.dispatched, true);
    await flushMicrotasks();
    // Simulate ACK + Stop + new idle cycle + Dispatch #2 while Dispatch #1's promise is STILL pending
    store.setTtlKeepaliveState("conv-stale-cb", { pendingAck: false, inKeepaliveTurn: false });
    monStale._keepaliveInFlight.delete("conv-stale-cb"); // suppose another path or completed cycle allowed d2
    seedStoppedLease(store, "conv-stale-cb", { cacheOriginTs: tStale + 40_000, idleAnchorTs: tStale + 45_000 });
    clock.set(tStale + 50_000);
    const d2 = monStale.triggerManualKeepalive("conv-stale-cb", { uiLang: "zh" });
    assert.equal(d2.dispatched, true);
    assert.notEqual(d2.dispatchId, d1.dispatchId);
    assert.equal(monStale._keepaliveInFlight.get("conv-stale-cb"), d2.dispatchId);
    await flushMicrotasks();

    // Old Dispatch #1 now fails (and runs .finally) -> MUST NOT touch Dispatch #2!
    pendingResolvers[0].reject(new Error("old_callback_error"));
    await flushMicrotasks();
    assert.equal(monStale._keepaliveInFlight.get("conv-stale-cb"), d2.dispatchId, "Stale .finally must NOT delete newer in-flight entry");
    const stAfterD1Fail = store.getTtlKeepaliveState("conv-stale-cb");
    assert.equal(stAfterD1Fail.lastDispatchId, d2.dispatchId);
    assert.equal(stAfterD1Fail.pendingAck, true);
    assert.equal(stAfterD1Fail.lastError, "");

    // Cleanly settle Dispatch #2 as skippedKilled -> rolls back Dispatch #2 properly
    pendingResolvers[1].resolve({ ok: false, skippedKilled: true, error: "killed_conversation_keepalive_suppressed" });
    await flushMicrotasks();
    const stAfterD2Killed = store.getTtlKeepaliveState("conv-stale-cb");
    assert.equal(stAfterD2Killed.pendingAck, false);
    assert.equal(stAfterD2Killed.lastError, "killed_conversation_keepalive_suppressed");
    assert.equal(monStale._keepaliveInFlight.has("conv-stale-cb"), false);

    // 6d. Stop catches manual cold read (cache_read_tokens === 0) IMMEDIATELY even with usedCount === 0
    const tStopCold = clock.now() + 60_000;
    const txStopCold = path.join(tmpDir, "tx-manual-stop-cold.jsonl");
    fs.writeFileSync(
      txStopCold,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tStopCold - 200_000).toISOString(), content: "初始问题" },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tStopCold - 199_000).toISOString(), input_tokens: 80_000, cache_read_tokens: 70_000, output_tokens: 50 },
        { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(tStopCold - 2_000).toISOString(), content: buildManualKeepaliveMessage("zh") },
        { step_index: 4, type: "PLANNER_RESPONSE", created_at: new Date(tStopCold - 1_000).toISOString(), input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    writeWatchdogLease(store, {
      conversationId: "conv-manual-stop-cold",
      rootSessionId: "conv-manual-stop-cold",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: tStopCold - 2_000,
      lastLlmStartTs: tStopCold - 2_000,
      updatedTs: tStopCold - 2_000,
      transcriptPath: txStopCold,
      contextTokens: 80_000
    });
    store.setTtlKeepaliveState("conv-manual-stop-cold", {
      usedCount: 0,
      lastSentTs: tStopCold - 2_500,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_manual_cold_1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-manual-stop-cold", transcriptPath: txStopCold, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: tStopCold }
    );
    const kaAfterStopCold = store.getTtlKeepaliveState("conv-manual-stop-cold");
    assert.equal(kaAfterStopCold.usedCount, 0);
    assert.equal(kaAfterStopCold.inKeepaliveTurn, false);
    assert.equal(kaAfterStopCold.coldMissTripped, true, "Manual cold read (usedCount=0) MUST trip coldMissTripped at Stop");
    assert.equal(kaAfterStopCold.pendingColdCheckId, "");
    assert.equal(kaAfterStopCold.lastColdCheckedId, "ka_manual_cold_1");

    // 6e. Missing cache_read field (unreported) MUST NOT false-trip at Stop, Layer-2, or Layer-3
    const tUnrep = tStopCold + 30_000;
    const txUnrep = path.join(tmpDir, "tx-unreported.jsonl");
    fs.writeFileSync(
      txUnrep,
      [
        { step_index: 1, type: "SYSTEM_MESSAGE", created_at: new Date(tUnrep - 2_000).toISOString(), content: buildManualKeepaliveMessage("en") },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tUnrep - 1_000).toISOString(), input_tokens: 90_000, output_tokens: 4, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    const unrepInfo = inspectLatestTurnInSteps(
      fs.readFileSync(txUnrep, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    );
    assert.equal(unrepInfo.cacheReadReported, false, "Omitted cache_read field must report cacheReadReported=false");
    writeWatchdogLease(store, {
      conversationId: "conv-unreported",
      rootSessionId: "conv-unreported",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: tUnrep - 2_000,
      lastLlmStartTs: tUnrep - 2_000,
      updatedTs: tUnrep - 2_000,
      transcriptPath: txUnrep,
      contextTokens: 90_000
    });
    store.setTtlKeepaliveState("conv-unreported", {
      usedCount: 0,
      lastSentTs: tUnrep - 2_500,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_unrep_1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-unreported", transcriptPath: txUnrep, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: tUnrep }
    );
    const kaUnrep = store.getTtlKeepaliveState("conv-unreported");
    assert.equal(kaUnrep.coldMissTripped, false, "Missing cache_read field must NEVER false-trip coldMissTripped");
    assert.equal(kaUnrep.pendingColdCheckId, "ka_unrep_1", "Keep pendingColdCheckId while cache_read field is unreported");
    // Also explicitly verify Layer-3 does NOT false-trip when cache_read field is unreported
    const monUnrepL3 = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
      nowFn: () => tUnrep + 10_000,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true })
    });
    const unrepL3 = monUnrepL3._runDelayedColdMissCheck(
      store,
      "conv-unreported",
      readWatchdogLease(store, "conv-unreported"),
      kaUnrep,
      tUnrep + 10_000
    );
    assert.equal(unrepL3.coldTripped, false, "Layer-3 must NOT false-trip when cache_read field is unreported");
    assert.equal(store.getTtlKeepaliveState("conv-unreported").coldMissTripped, false);
    store.deleteMeta("watchdog_lease:conv-unreported");

    // 6f. Stop with missing/un-flushed transcript -> retains pendingColdCheckId -> caught by headless Watchdog (Layer-3, dashboard closed!) BEFORE next auto keepalive (even though usedCount=0!)
    const tDelay = tUnrep + 30_000;
    const txDelay = path.join(tmpDir, "tx-delayed-manual.jsonl");
    // Transcript does NOT exist yet when Stop runs!
    writeWatchdogLease(store, {
      conversationId: "conv-delayed-manual",
      rootSessionId: "conv-delayed-manual",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: tDelay,
      lastLlmStartTs: tDelay,
      updatedTs: tDelay,
      transcriptPath: txDelay,
      contextTokens: 95_000,
      windowTokens: 200_000
    });
    store.setTtlKeepaliveState("conv-delayed-manual", {
      enabled: true,
      maxCount: 2,
      usedCount: 0,
      lastSentTs: tDelay - 500,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_manual_delayed_1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-delayed-manual", transcriptPath: txDelay, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: tDelay + 2_000 }
    );
    const kaAfterDelayedStop = store.getTtlKeepaliveState("conv-delayed-manual");
    assert.equal(kaAfterDelayedStop.inKeepaliveTurn, false);
    assert.equal(kaAfterDelayedStop.coldMissTripped, false);
    assert.equal(kaAfterDelayedStop.pendingColdCheckId, "ka_manual_delayed_1");
    assert.equal(hasPendingKeepaliveColdCheck(kaAfterDelayedStop), true);

    // Later, transcript flushes with explicit cache_read_tokens === 0 (dashboard is NOT open!)
    fs.writeFileSync(
      txDelay,
      [
        { step_index: 1, type: "SYSTEM_MESSAGE", created_at: new Date(tDelay).toISOString(), content: buildManualKeepaliveMessage("zh") },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tDelay + 500).toISOString(), input_tokens: 95_000, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    let statCountDelay = 0;
    const sentDelay = [];
    clock.set(tDelay + 250_000); // enters auto keepalive trigger window (rem=50s)
    const monHeadless = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 2, ttlKeepaliveLeadSec: 60, ttlKeepaliveMinRemainSec: 15 }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      statFn: () => {
        statCountDelay += 1;
        throw new Error("Layer-3 headless check must perform 0 statSync");
      },
      keepaliveSendFn: async (p) => {
        sentDelay.push(p);
        return { ok: true };
      }
    });
    monHeadless.tick();
    await flushMicrotasks();
    assert.equal(statCountDelay, 0, "Headless Layer-3 check must perform 0 fs.statSync");
    assert.equal(sentDelay.length, 0, "Headless Layer-3 must abort auto keepalive after catching delayed manual cold read");
    const kaTrippedByL3 = store.getTtlKeepaliveState("conv-delayed-manual");
    assert.equal(kaTrippedByL3.coldMissTripped, true);
    assert.equal(kaTrippedByL3.pendingColdCheckId, "");
    assert.equal(kaTrippedByL3.lastColdCheckedId, "ka_manual_delayed_1");

    // 6g. Real user new turn resets state cleanly AND stale old keepalive cold result NEVER trips new turn!
    const resetRun = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-delayed-manual",
        invocationNum: 0,
        lastUserInput: "继续下一步真实任务"
      }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });
    assert.equal(resetRun.status, 0);
    assert.equal(resetRun.stderr, "");
    const kaReset = store.getTtlKeepaliveState("conv-delayed-manual");
    assert.equal(kaReset.coldMissTripped, false);
    assert.equal(kaReset.lastDispatchId, "");
    assert.equal(kaReset.pendingColdCheckId, "");
    assert.equal(kaReset.usedCount, 0);

    // Even if Stop runs immediately while txDelay still ends with the OLD cold keepalive step -> MUST NOT trip!
    await handleStopPayload(
      { conversationId: "conv-delayed-manual", transcriptPath: txDelay, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: Date.now() + 2_000 }
    );
    assert.equal(
      store.getTtlKeepaliveState("conv-delayed-manual").coldMissTripped,
      false,
      "Old keepalive cold-read in transcript must NEVER trip breaker on a new human turn"
    );

    // Also verify isKeepaliveTurnFlushedForRound rejects mismatched mode & older timestamps
    assert.equal(
      isKeepaliveTurnFlushedForRound(
        {
          hasPlanner: true,
          prefillTs: tDelay - 20_000,
          contextTokens: 80_000,
          cacheReadReported: true,
          cacheReadTokens: 0,
          hasPromptAfterLastPlanner: false,
          hasToolContinuationAfterLastPlanner: false,
          precededByKeepalivePrompt: true,
          precededByGenuineUser: false,
          keepaliveRound: null,
          keepaliveMode: "manual"
        },
        { lastSentTs: tDelay, lastDispatchMode: "manual", usedCount: 0 }
      ),
      false,
      "Old prefillTs before lastSentTs - 5s must be rejected"
    );
    assert.equal(
      isKeepaliveTurnFlushedForRound(
        {
          hasPlanner: true,
          prefillTs: tDelay + 1_000,
          contextTokens: 80_000,
          cacheReadReported: true,
          cacheReadTokens: 0,
          hasPromptAfterLastPlanner: false,
          hasToolContinuationAfterLastPlanner: false,
          precededByKeepalivePrompt: true,
          precededByGenuineUser: false,
          keepaliveRound: 1,
          keepaliveMode: "auto"
        },
        { lastSentTs: tDelay, lastDispatchMode: "manual", usedCount: 0 }
      ),
      false,
      "Auto round 1/N result must not match a manual dispatch"
    );
  } finally {
    store.close();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Row 7: 双模式 Sidecar 接口 (/api/watchdog/action, /api/watchdog, /api/cache-diag) + Dashboard VM DOM
// ---------------------------------------------------------------------------
test("v1.7.4-7: Sidecar Standalone HTTP & SidecarApp API parity, auth/400/structured skip reasons & Dashboard VM DOM (ZH/EN, 2A, auto-skip, dedup, timeout, switch, XSS)", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-sidecar-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();
  closeRuntimeStore();

  let srv = null;
  try {
    const clock = makeControlledClock(Date.now());
    const sent = [];
    // Configure runtime WatchdogMonitor before starting servers so both modes use controllable clock & fake sender
    const mon = getWatchdogMonitor({
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });
    const store = mon.getStore();

    // Seed a real transcript + stopped lease for conv-api-target
    const t0 = clock.now() - 285_000; // rem=15s -> triggers narrow-margin auto skip on tick when enabled
    const txApi = path.join(tmpDir, "tx-api-target.jsonl");
    fs.writeFileSync(
      txApi,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(t0).toISOString(), content: "接口联调" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: new Date(t0).toISOString(),
          model: "claude-opus-4-6-thinking",
          max_token_limit: 200_000,
          input_tokens: 10_000,
          cache_read_tokens: 80_000,
          output_tokens: 50
        }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    seedStoppedLease(store, "conv-api-target", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 20_000,
      contextTokens: 90_000,
      transcriptPath: txApi
    });
    // Trigger an actual narrow-margin skip so narrowMarginSkipped=true & count=1
    store.setTtlKeepaliveEnabled(true, "conv-api-target");
    mon.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 0);
    assert.equal(mon.ttlKeepaliveNarrowSkippedCount, 1);

    // 7a. Standalone HTTP server: auth, method, 400 validation, structured skip, dispatch & dual-endpoint parity
    srv = createStandaloneServer({ port: 0 });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const htmlRes = await httpJsonRequest(port, "/", { method: "GET" });
    assert.equal(htmlRes.status, 200);
    const csrfMatch = htmlRes.raw.match(/name="agy-dart-token"\s+content="([a-f0-9]+)"/i);
    assert.ok(csrfMatch && csrfMatch[1], "Must expose CSRF meta token");
    const csrfToken = csrfMatch[1];
    const authHeaders = {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin"
    };

    // Method & Auth guards
    const getAct = await httpJsonRequest(port, "/api/watchdog/action", { method: "GET", headers: { "X-Agy-Dart-Token": csrfToken } });
    assert.equal(getAct.status, 405);
    const noTok = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { action: "manualTtlKeepalive", conversationId: "conv-api-target" }
    });
    assert.equal(noTok.status, 403);

    // Missing / unbound / invalid ID -> 400
    for (const badBody of [
      { action: "manualTtlKeepalive" },
      { action: "manualTtlKeepalive", conversationId: "" },
      { action: "manualTtlKeepalive", conversationId: "__unbound__" },
      { action: "manualTtlKeepalive", conversationId: "../bad" }
    ]) {
      const rBad = await httpJsonRequest(port, "/api/watchdog/action", { method: "POST", headers: authHeaders, body: badBody });
      assert.equal(rBad.status, 400, `Expected 400 for ${JSON.stringify(badBody)}`);
    }

    // Valid target without lease -> HTTP 200 structured { ok: true, dispatched: false, skippedReason: "no_lease", status }
    const rNoLease = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: { action: "manualTtlKeepalive", conversationId: "conv-no-lease-http" }
    });
    assert.equal(rNoLease.status, 200);
    assert.equal(rNoLease.json.ok, true);
    assert.equal(rNoLease.json.dispatched, false);
    assert.equal(rNoLease.json.skippedReason, "no_lease");
    assert.ok(rNoLease.json.status?.ttlKeepalive);

    // Dual-endpoint parity: /api/watchdog and /api/cache-diag MUST return identical timing, thresholds, skip & ack states
    const wdBefore = await httpJsonRequest(port, "/api/watchdog", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: "conv-api-target" }
    });
    const cdBefore = await httpJsonRequest(port, "/api/cache-diag", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: "conv-api-target" }
    });
    assert.equal(wdBefore.status, 200);
    assert.equal(cdBefore.status, 200);
    for (const field of [
      "cacheOriginTs",
      "effectiveTtlSec",
      "estimatedExpireTs",
      "remainingSec",
      "minRemainSec",
      "effectiveMinRemainSec",
      "narrowMarginSkipped",
      "narrowMarginRemSec",
      "inFlight",
      "pendingAck",
      "hasLease",
      "narrowSkippedCount",
      "manualKeepaliveCount"
    ]) {
      assert.equal(
        cdBefore.json.ttlKeepalive[field],
        wdBefore.json.ttlKeepalive[field],
        `Parity mismatch on ttlKeepalive.${field}: cache-diag=${cdBefore.json.ttlKeepalive[field]} vs watchdog=${wdBefore.json.ttlKeepalive[field]}`
      );
    }
    assert.equal(wdBefore.json.ttlKeepalive.narrowMarginSkipped, true);
    assert.equal(wdBefore.json.stats.ttlKeepaliveNarrowSkippedCount, 1);

    // Valid narrow-margin target dispatched via Standalone HTTP (2A allows manual warm!)
    const rManualHttp = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: { action: "manualTtlKeepalive", conversationId: "conv-api-target" }
    });
    assert.equal(rManualHttp.status, 200);
    assert.equal(rManualHttp.json.ok, true);
    assert.equal(rManualHttp.json.dispatched, true);
    assert.equal(rManualHttp.json.tightMargin, true);
    assert.equal(rManualHttp.json.status.ttlKeepalive.pendingAck, true);
    await flushMicrotasks();
    assert.equal(sent.length, 1);
    assert.equal(mon.manualKeepaliveCount, 1);

    // Verify /api/cache-diag Layer-2 catches delayed cold read on manual turn (usedCount=0)!
    const tL2 = clock.now() + 20_000;
    const txL2 = path.join(tmpDir, "tx-manual-l2.jsonl");
    fs.writeFileSync(
      txL2,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tL2 - 10_000).toISOString(), content: "L2测试" },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tL2 - 9_000).toISOString(), input_tokens: 70_000, cache_read_tokens: 65_000, output_tokens: 20 },
        { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(tL2 - 2_000).toISOString(), content: buildManualKeepaliveMessage("en") },
        { step_index: 4, type: "PLANNER_RESPONSE", created_at: new Date(tL2 - 1_000).toISOString(), input_tokens: 70_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    seedStoppedLease(store, "conv-manual-l2", {
      cacheOriginTs: tL2 - 1_000,
      idleAnchorTs: tL2,
      contextTokens: 70_100,
      transcriptPath: txL2
    });
    store.setTtlKeepaliveState("conv-manual-l2", {
      usedCount: 0,
      lastSentTs: tL2 - 2_500,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_manual_l2",
      lastDispatchMode: "manual",
      pendingColdCheckId: "ka_manual_l2",
      coldMissTripped: false
    });
    const cdL2 = await httpJsonRequest(port, "/api/cache-diag", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: "conv-manual-l2" }
    });
    assert.equal(cdL2.status, 200);
    assert.equal(cdL2.json.ttlKeepalive.coldMissTripped, true, "Layer-2 /api/cache-diag must catch delayed manual cold read even at usedCount=0");

    // 7b. SidecarApp mode (`registerSidecarRoutes`) parity, POST-only registration, 400 & structured skip reason
    const routes = new Map();
    const methods = new Map();
    registerSidecarRoutes({
      config: { conversationId: "conv-sidecar-app" },
      api(routePath, handler, method) {
        routes.set(routePath, handler);
        methods.set(routePath, method);
      }
    });
    assert.equal(methods.get("/api/watchdog/action"), "POST");
    assert.equal(routes.get("/api/watchdog/action")({ action: "manualTtlKeepalive" }).status, 400);
    assert.equal(routes.get("/api/watchdog/action")({ action: "manualTtlKeepalive", conversationId: "__unbound__" }).status, 400);
    const scNoLease = routes.get("/api/watchdog/action")({
      action: "manualTtlKeepalive",
      conversationId: "conv-sidecar-nolease"
    });
    assert.equal(scNoLease.ok, true);
    assert.equal(scNoLease.dispatched, false);
    assert.equal(scNoLease.skippedReason, "no_lease");
    assert.ok(scNoLease.status?.ttlKeepalive);

    seedStoppedLease(store, "conv-sidecar-ok", {
      cacheOriginTs: clock.now() - 100_000,
      idleAnchorTs: clock.now() - 90_000
    });
    const scOk = routes.get("/api/watchdog/action")({
      action: "manualTtlKeepalive",
      conversationId: "conv-sidecar-ok"
    });
    assert.equal(scOk.ok, true);
    assert.equal(scOk.dispatched, true);
    assert.equal(scOk.status.ttlKeepalive.pendingAck, true);
    await flushMicrotasks();
    assert.equal(mon.manualKeepaliveCount, 2);

    // 7c. Dashboard VM DOM tests: ZH/EN, 2A narrow-margin clickable, actual auto-skip badge, 1h expiry tier,
    //     double-click sends once, wait timeout re-fetches, session switch discards stale response, XSS-safe error
    const htmlSrc = readDashboardHtml();
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "1",
      disabled: false,
      className: "",
      style: {},
      dataset: { enabled: "0", used: "0", max: "1" },
      options: [],
      classList: {
        _set: new Set(),
        add(...cls) { cls.forEach((c) => this._set.add(c)); },
        remove(...cls) { cls.forEach((c) => this._set.delete(c)); },
        contains(c) { return this._set.has(c); },
        toggle(c, f) { const on = f === undefined ? !this._set.has(c) : Boolean(f); if (on) this._set.add(c); else this._set.delete(c); return on; }
      },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getAttribute() { return ""; },
      setAttribute() {}
    });
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const vmApiCalls = [];
    const scheduledTimeouts = new Map();
    let nextTimerId = 1;
    let deferredManualResolver = null;
    let activeHostConvId = "conv-vm-1";
    let langPref = "zh";
    const baseNow = Date.now();

    const makeKvPayload = (convId, overrides = {}) => ({
      ok: true,
      transcriptFound: true,
      turnsWithUsage: 2,
      currentContextTokens: 90_000,
      cacheTtlSec: 300,
      lastPlannerAt: new Date(baseNow - 100_000).toISOString(),
      serverNowMs: baseNow,
      conversationActive: false,
      ttlSource: "profile",
      ...overrides,
      ttlKeepalive: {
        conversationId: convId,
        enabled: false,
        supported: true,
        isSubagent: false,
        maxCount: 1,
        globalMaxCount: 0,
        fallbackMaxCount: 1,
        minContextPct: 15,
        usedCount: 0,
        coldMissTripped: false,
        deliveryLatencyMs: 4000,
        leadSec: 60,
        minRemainSec: 15,
        effectiveMinRemainSec: 19,
        cacheOriginTs: baseNow - 100_000,
        effectiveTtlSec: 300,
        estimatedExpireTs: baseNow + 200_000,
        remainingSec: 200,
        narrowMarginSkipped: false,
        narrowMarginRemSec: null,
        inFlight: false,
        pendingAck: false,
        hasLease: true,
        leasePhase: "IDLE",
        leaseSubphase: "stopped",
        leaseStopReason: "NO_TOOL_CALL",
        lastSentTs: 0,
        lastError: "",
        ...(overrides.ttlKeepalive || {})
      }
    });

    const handleVmFetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      vmApiCalls.push({ url, body });
      if (url === "/api/watchdog/action" && body.action === "manualTtlKeepalive") {
        if (deferredManualResolver === "HOLD") {
          return new Promise((resolve) => {
            deferredManualResolver = resolve;
          });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            dispatched: true,
            skippedReason: "",
            conversationId: body.conversationId,
            status: {
              ok: true,
              enabled: true,
              uiLang: langPref,
              uiLangSource: "sqlite",
              serverNowMs: baseNow,
              ttlKeepalive: {
                ...makeKvPayload(body.conversationId).ttlKeepalive,
                pendingAck: true,
                inFlight: true
              },
              current: { conversationId: body.conversationId, phase: "IDLE", subphase: "stopped" },
              sessions: [],
              alertingSessions: []
            }
          })
        };
      }
      if (url === "/api/cache-diag") {
        return { ok: true, status: 200, json: async () => makeKvPayload(activeHostConvId) };
      }
      if (url === "/api/watchdog") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            enabled: true,
            uiLang: langPref,
            uiLangSource: "sqlite",
            serverNowMs: baseNow,
            ttlKeepalive: makeKvPayload(activeHostConvId).ttlKeepalive,
            current: { conversationId: activeHostConvId, phase: "IDLE", subphase: "stopped" },
            sessions: [],
            alertingSessions: []
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const vmCtx = vm.createContext({
      window: {
        location: { search: "", href: "http://127.0.0.1:4321/" },
        sidecar: {
          get conversationId() {
            return activeHostConvId;
          }
        },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-vm" }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      localStorage: { getItem: () => langPref, setItem: (_k, v) => { langPref = v; } },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: handleVmFetch,
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: (fn, ms) => {
        const id = nextTimerId++;
        scheduledTimeouts.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => {
        scheduledTimeouts.delete(id);
      },
      Date,
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      Promise,
      Error,
      RegExp,
      parseInt,
      parseFloat,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      console: { error() {}, log() {}, warn() {} }
    });

    vm.runInContext(scriptMatch[1], vmCtx);
    await flushMicrotasks();

    const warmBtn = getEl("kv-warm-now-btn");
    const skipBadge = getEl("kv-ttl-auto-skip-badge");
    const warmNote = getEl("kv-warm-now-note");

    // Normal idle ZH & EN
    assert.equal(warmBtn.disabled, false);
    assert.equal(warmBtn.textContent, "续温 1×");
    assert.ok(skipBadge.className.includes("hidden"), "Auto-skipped badge must stay hidden until actual skip occurs");

    vmCtx.setLanguage("en", false);
    assert.equal(warmBtn.textContent, "Warm 1×");
    vmCtx.setLanguage("zh", false);
    assert.equal(warmBtn.textContent, "续温 1×");

    // Narrow margin WITHOUT actual auto-skip: 2A clickable warning, NO "自动已跳过" badge
    vmCtx.renderKvCacheCard(
      makeKvPayload("conv-vm-1", {
        ttlKeepalive: {
          cacheOriginTs: baseNow - 285_000,
          effectiveTtlSec: 300,
          remainingSec: 15,
          effectiveMinRemainSec: 19,
          narrowMarginSkipped: false
        }
      })
    );
    assert.equal(warmBtn.disabled, false, "2A narrow-margin button MUST remain clickable");
    assert.equal(warmBtn.textContent, "可能冷读，仍要续温");
    assert.ok(skipBadge.className.includes("hidden"), "Without actual auto-skip, badge must remain hidden");

    // Narrow margin WITH actual auto-skip: shows "自动已跳过" / "Auto skipped"
    vmCtx.renderKvCacheCard(
      makeKvPayload("conv-vm-1", {
        ttlKeepalive: {
          cacheOriginTs: baseNow - 285_000,
          effectiveTtlSec: 300,
          remainingSec: 15,
          effectiveMinRemainSec: 19,
          narrowMarginSkipped: true,
          narrowMarginRemSec: 15
        }
      })
    );
    assert.equal(warmBtn.disabled, false);
    assert.equal(skipBadge.textContent, "自动已跳过");
    assert.equal(skipBadge.className.includes("hidden"), false);
    vmCtx.setLanguage("en", false);
    assert.equal(warmBtn.textContent, "May cold-read · Warm anyway");
    assert.equal(skipBadge.textContent, "Auto skipped");
    vmCtx.setLanguage("zh", false);

    // Countdown zero with 1h TTL tier -> displays "预计缓存窗口已过" and actual "1h" tier (not hardcoded 5m!)
    vmCtx.renderKvCacheCard(
      makeKvPayload("conv-vm-1", {
        cacheTtlSec: 3600,
        lastPlannerAt: new Date(baseNow - 3700_000).toISOString(),
        ttlKeepalive: {
          cacheOriginTs: baseNow - 3700_000,
          effectiveTtlSec: 3600,
          remainingSec: 0
        }
      })
    );
    assert.equal(warmBtn.disabled, true);
    assert.equal(warmBtn.textContent, "预计缓存窗口已过");
    assert.ok(warmBtn.title.includes("1h"), `Expired tooltip must use session actual 1h tier, got: ${warmBtn.title}`);
    assert.equal(warmBtn.title.includes("5m"), false);

    // Blocked states: active, coldMissTripped, noLease
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { conversationActive: true }));
    assert.equal(warmBtn.disabled, true);
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { ttlKeepalive: { coldMissTripped: true } }));
    assert.equal(warmBtn.disabled, true);
    assert.equal(warmBtn.textContent, "已冷断");
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { ttlKeepalive: { hasLease: false } }));
    assert.equal(warmBtn.disabled, true);
    assert.equal(warmBtn.textContent, "无租约");

    // Hidden states: subagent, unsupported, unbound
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { ttlKeepalive: { isSubagent: true } }));
    assert.ok(warmBtn.className.includes("hidden"));
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { ttlKeepalive: { supported: false } }));
    assert.ok(warmBtn.className.includes("hidden"));
    activeHostConvId = "";
    vmCtx.syncNativeHostConversation();
    vmCtx.renderKvCacheCard(makeKvPayload("__unbound__", { ttlKeepalive: { conversationId: "__unbound__" } }));
    assert.ok(warmBtn.className.includes("hidden"));

    // Restore normal idle state on conv-vm-1 -> XSS-safe lastError rendering (no innerHTML injection)
    activeHostConvId = "conv-vm-1";
    vmCtx.syncNativeHostConversation();
    const xssPayload = "<img src=x onerror=alert(1)><script>evil()</script>";
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { ttlKeepalive: { lastError: xssPayload } }));
    assert.ok(warmNote.textContent.includes(xssPayload), "Error text rendered safely via textContent");
    assert.equal(warmNote.innerHTML, "", "Must NEVER inject error via innerHTML");

    // Same click dedup (double-click sends EXACTLY ONE POST) + wait timeout re-fetches backend state
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1", { ttlKeepalive: { lastError: "" } }));
    vmApiCalls.length = 0;
    const pClick1 = vmCtx.triggerManualTtlKeepalive();
    const pClick2 = vmCtx.triggerManualTtlKeepalive();
    await Promise.all([pClick1, pClick2]);
    const manualPosts = vmApiCalls.filter((c) => c.url === "/api/watchdog/action" && c.body.action === "manualTtlKeepalive");
    assert.equal(manualPosts.length, 1, "Double-click must send exactly ONE manualTtlKeepalive request");
    assert.equal(warmBtn.disabled, true);
    assert.equal(warmBtn.textContent, "续温中...");

    // Trigger the 60s wait-confirmation timeout callback -> must re-fetch backend status!
    const waitEntry = Array.from(scheduledTimeouts.values()).find((t) => t.ms === 60000);
    assert.ok(waitEntry, "Must schedule 60s confirmation timeout timer");
    vmApiCalls.length = 0;
    waitEntry.fn();
    await flushMicrotasks();
    assert.ok(
      vmApiCalls.some((c) => c.url === "/api/watchdog" || c.url === "/api/cache-diag"),
      "Wait confirmation timeout must trigger backend state refresh"
    );

    // Session switch discards stale in-flight response without corrupting new session UI
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-1"));
    deferredManualResolver = "HOLD";
    const staleClickPromise = vmCtx.triggerManualTtlKeepalive();
    assert.equal(typeof deferredManualResolver, "function");
    // Switch host conversation to conv-vm-2 BEFORE conv-vm-1's response arrives
    activeHostConvId = "conv-vm-2";
    vmCtx.syncNativeHostConversation();
    vmCtx.renderKvCacheCard(makeKvPayload("conv-vm-2"));
    assert.equal(warmBtn.disabled, false);
    assert.equal(warmBtn.textContent, "续温 1×");

    // Now stale response for conv-vm-1 resolves with an error/block -> MUST BE DISCARDED!
    deferredManualResolver({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        dispatched: false,
        skippedReason: "cold_miss_tripped",
        conversationId: "conv-vm-1"
      })
    });
    await staleClickPromise;
    await flushMicrotasks();
    assert.equal(warmBtn.disabled, false, "Stale response after session switch must NOT disable new session button");
    assert.equal(warmBtn.textContent, "续温 1×");
    assert.equal(warmNote.textContent, "", "Stale skip reason from conv-vm-1 must NOT pollute conv-vm-2");
  } finally {
    if (srv) {
      await new Promise((r) => srv.close(r));
    }
    stopWatchdogMonitor();
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review Hardening Tests (P1 #1 - #5)
// ---------------------------------------------------------------------------
test("v1.7.4-8 (P1-1): triggerManualKeepalive re-reads clock and compares idle anchor inside write tx (lock-wait expiry & new-turn cycle change -> 0 sends)", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-lockwait-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const clock = makeControlledClock();
    const sent = [];
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({
        stallWatchdog: true,
        ttlKeepalive: false,
        ttlKeepaliveLeadSec: 60,
        ttlKeepaliveMinRemainSec: 15
      }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // 8a. Lock-wait expiry: 1s remaining at click time, clock advances 2s while waiting for write tx -> already_expired, 0 sends
    const t0 = clock.now();
    seedStoppedLease(store, "conv-lock-expire", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 10_000,
      cacheTtlSec: 300
    });
    clock.set(t0 + 299_000); // remSec === 1 at click time
    const origWriteTx = store._withWriteTx.bind(store);
    let advancedOnLock = false;
    store._withWriteTx = (fn) => {
      if (!advancedOnLock) {
        advancedOnLock = true;
        clock.advanceSec(2); // now t0 + 301s -> remSec === -1 (expired!)
      }
      return origWriteTx(fn);
    };
    const expRes = mon.triggerManualKeepalive("conv-lock-expire", { uiLang: "zh" });
    store._withWriteTx = origWriteTx;
    await flushMicrotasks();

    assert.equal(expRes.ok, true);
    assert.equal(expRes.dispatched, false);
    assert.equal(expRes.skippedReason, "already_expired");
    assert.ok(expRes.remSec <= 0, `Expected remSec <= 0 after lock wait, got ${expRes.remSec}`);
    assert.equal(sent.length, 0, "Sender must NOT be called when cache expires while waiting for write tx");
    const kaExp = store.getTtlKeepaliveState("conv-lock-expire");
    assert.equal(kaExp.pendingAck, false);
    assert.equal(kaExp.lastDispatchId, "");

    // 8b. Lock-wait new turn started AND completed (new idle cycle): idleAnchorTs changed before tx -> idle_cycle_changed, 0 sends
    const t1 = clock.now() + 30_000;
    seedStoppedLease(store, "conv-lock-new-cycle", {
      cacheOriginTs: t1,
      idleAnchorTs: t1 + 10_000,
      cacheTtlSec: 300
    });
    clock.set(t1 + 120_000); // remSec === 180 on idle cycle #1
    let replacedCycle = false;
    store._withWriteTx = (fn) => {
      if (!replacedCycle) {
        replacedCycle = true;
        clock.advanceSec(5);
        // Simulate another turn starting and finishing cleanly while waiting for the DB write lock
        recordHookLeaseTransition(
          store,
          "PreInvocation",
          { conversationId: "conv-lock-new-cycle", lastUserInput: "另一轮真实消息" },
          { nowMs: clock.now() - 2_000 }
        );
        recordHookLeaseTransition(
          store,
          "Stop",
          { conversationId: "conv-lock-new-cycle", terminationReason: "NO_TOOL_CALL" },
          { nowMs: clock.now(), cacheOriginTs: clock.now() - 1_000 }
        );
      }
      return origWriteTx(fn);
    };
    const cycleRes = mon.triggerManualKeepalive("conv-lock-new-cycle", { uiLang: "en" });
    store._withWriteTx = origWriteTx;
    await flushMicrotasks();

    assert.equal(cycleRes.ok, true);
    assert.equal(cycleRes.dispatched, false);
    assert.equal(cycleRes.skippedReason, "idle_cycle_changed");
    assert.equal(sent.length, 0, "Sender must NOT be called when another turn completed during write lock wait");
    const kaCycle = store.getTtlKeepaliveState("conv-lock-new-cycle");
    assert.equal(kaCycle.pendingAck, false);
    assert.equal(kaCycle.lastDispatchId, "");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-9 (P1-2): Standalone dashboard with inferred ID hides/blocks manual warm until explicit user selection; server rejects conversationConfirmed=false", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-unconfirmed-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();
  closeRuntimeStore();

  let srv = null;
  try {
    const clock = makeControlledClock(Date.now());
    const sent = [];
    const mon = getWatchdogMonitor({
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });
    const store = mon.getStore();
    seedStoppedLease(store, "conv-inferred-target", {
      cacheOriginTs: clock.now() - 100_000,
      idleAnchorTs: clock.now() - 90_000,
      contextTokens: 90_000
    });

    // 9a. Backend Standalone HTTP & SidecarApp reject conversationConfirmed: false (and non-conversation scope) with 400 & 0 sends
    srv = createStandaloneServer({ port: 0 });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const htmlRes = await httpJsonRequest(port, "/", { method: "GET" });
    const csrfToken = htmlRes.raw.match(/name="agy-dart-token"\s+content="([a-f0-9]+)"/i)[1];
    const authHeaders = {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin"
    };

    const httpUnconfirmed = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: {
        action: "manualTtlKeepalive",
        conversationId: "conv-inferred-target",
        conversationConfirmed: false
      }
    });
    assert.equal(httpUnconfirmed.status, 400);
    assert.match(String(httpUnconfirmed.json?.error || ""), /unconfirmed/i);

    const httpWrongScope = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: {
        action: "manualTtlKeepalive",
        conversationId: "conv-inferred-target",
        scope: "app"
      }
    });
    assert.equal(httpWrongScope.status, 400);
    assert.match(String(httpWrongScope.json?.error || ""), /unconfirmed|invalid/i);

    const routes = new Map();
    registerSidecarRoutes({
      config: { conversationId: "conv-inferred-target" },
      api(routePath, handler) {
        routes.set(routePath, handler);
      }
    });
    const scUnconfirmed = routes.get("/api/watchdog/action")({
      action: "manualTtlKeepalive",
      conversationId: "conv-inferred-target",
      conversationConfirmed: false
    });
    assert.equal(scUnconfirmed.ok, false);
    assert.equal(scUnconfirmed.status, 400);
    await flushMicrotasks();
    assert.equal(sent.length, 0, "Unconfirmed manualTtlKeepalive must NEVER invoke sender");

    // 9b. Standalone Dashboard VM (NO window.sidecar) with inferred fallback ID before user selects a session
    const htmlSrc = readDashboardHtml();
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "1",
      disabled: false,
      className: "",
      style: {},
      dataset: { enabled: "0", used: "0", max: "1" },
      options: [],
      classList: {
        _set: new Set(),
        add(...cls) { cls.forEach((c) => this._set.add(c)); },
        remove(...cls) { cls.forEach((c) => this._set.delete(c)); },
        contains(c) { return this._set.has(c); },
        toggle(c, f) { const on = f === undefined ? !this._set.has(c) : Boolean(f); if (on) this._set.add(c); else this._set.delete(c); return on; }
      },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getAttribute() { return ""; },
      setAttribute() {}
    });
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const baseNow = Date.now();
    const vmCalls = [];
    const inferredKa = {
      conversationId: "conv-inferred-target",
      enabled: false,
      supported: true,
      isSubagent: false,
      maxCount: 1,
      globalMaxCount: 0,
      fallbackMaxCount: 1,
      minContextPct: 15,
      usedCount: 0,
      coldMissTripped: false,
      deliveryLatencyMs: 0,
      leadSec: 60,
      minRemainSec: 15,
      effectiveMinRemainSec: 15,
      cacheOriginTs: baseNow - 100_000,
      effectiveTtlSec: 300,
      estimatedExpireTs: baseNow + 200_000,
      remainingSec: 200,
      narrowMarginSkipped: false,
      narrowMarginRemSec: null,
      inFlight: false,
      pendingAck: false,
      hasLease: true,
      leasePhase: "IDLE",
      leaseSubphase: "stopped",
      leaseStopReason: "NO_TOOL_CALL",
      lastSentTs: 0,
      lastError: ""
    };

    const vmCtx = vm.createContext({
      window: {
        location: { search: "", href: "http://127.0.0.1:8765/" },
        // Standalone dashboard: NO window.sidecar!
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-standalone" }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : {};
        vmCalls.push({ url, body });
        if (url === "/api/cache-diag") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              transcriptFound: true,
              turnsWithUsage: 2,
              currentContextTokens: 90_000,
              cacheTtlSec: 300,
              lastPlannerAt: new Date(baseNow - 100_000).toISOString(),
              serverNowMs: baseNow,
              conversationActive: false,
              resolvedConversationId: "conv-inferred-target",
              ttlSource: "profile",
              ttlKeepalive: inferredKa
            })
          };
        }
        if (url === "/api/watchdog") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              enabled: true,
              uiLang: "zh",
              uiLangSource: "sqlite",
              serverNowMs: baseNow,
              ttlKeepalive: inferredKa,
              current: { conversationId: "conv-inferred-target", phase: "IDLE", subphase: "stopped" },
              sessions: [{ conversationId: "conv-inferred-target", phase: "IDLE", subphase: "stopped", isSubagent: false }],
              alertingSessions: []
            })
          };
        }
        if (url === "/api/watchdog/action" && body.action === "manualTtlKeepalive") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              dispatched: true,
              skippedReason: "",
              conversationId: body.conversationId,
              status: { ok: true, enabled: true, serverNowMs: baseNow, ttlKeepalive: { ...inferredKa, pendingAck: true } }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      queueMicrotask,
      Date,
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      Promise,
      Error,
      RegExp,
      parseInt,
      parseFloat,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      console: { error() {}, log() {}, warn() {} }
    });

    vm.runInContext(scriptMatch[1], vmCtx);
    await flushMicrotasks();

    // Panel has inferred fallback ID from /api/cache-diag, but user has NOT selected a conversation yet!
    assert.equal(vmCtx.getActiveConversationId(), "conv-inferred-target", "Standalone panel should have inferred ID");
    assert.equal(vmCtx.getConfirmedConversationId(), "", "User has not explicitly selected any session");
    const warmBtn = getEl("kv-warm-now-btn");
    assert.ok(warmBtn.className.includes("hidden"), "Manual warm button must stay hidden for unconfirmed inferred ID");
    assert.equal(warmBtn.disabled, true);

    vmCalls.length = 0;
    const blockedRes = await vmCtx.triggerManualTtlKeepalive();
    assert.equal(blockedRes, null);
    assert.equal(
      vmCalls.filter((c) => c.url === "/api/watchdog/action" && c.body.action === "manualTtlKeepalive").length,
      0,
      "Unconfirmed standalone panel must NEVER dispatch manualTtlKeepalive"
    );

    // Once the user explicitly selects the conversation, the button appears and sends conversationConfirmed: true
    await vmCtx.jumpToConversation("conv-inferred-target");
    await flushMicrotasks();
    assert.equal(vmCtx.getConfirmedConversationId(), "conv-inferred-target");
    assert.equal(warmBtn.className.includes("hidden"), false, "Explicitly selected session should show manual warm button");
    assert.equal(warmBtn.disabled, false);

    // Scope switching (conversation -> app -> lifetime -> conversation) hides on non-conversation and re-appears cleanly
    vmCtx.setScope("app");
    await flushMicrotasks();
    assert.ok(warmBtn.className.includes("hidden"), "Manual warm button must hide on app scope");
    assert.equal(warmBtn.disabled, true);
    vmCtx.setScope("lifetime");
    await flushMicrotasks();
    assert.ok(warmBtn.className.includes("hidden"), "Manual warm button must hide on lifetime scope");
    vmCtx.setScope("conversation");
    await flushMicrotasks();
    assert.equal(warmBtn.className.includes("hidden"), false, "Manual warm button must re-appear on return to conversation scope");
    assert.equal(warmBtn.disabled, false);

    vmCalls.length = 0;
    await vmCtx.triggerManualTtlKeepalive();
    const sentManual = vmCalls.filter((c) => c.url === "/api/watchdog/action" && c.body.action === "manualTtlKeepalive");
    assert.equal(sentManual.length, 1);
    assert.equal(sentManual[0].body.conversationId, "conv-inferred-target");
    assert.equal(sentManual[0].body.conversationConfirmed, true);
  } finally {
    if (srv) {
      await new Promise((r) => srv.close(r));
    }
    stopWatchdogMonitor();
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-10 (P1-3): Consecutive manual warm-ups with only previous untimestamped cold-read on disk stay pending (no false trip across Stop, Layer-2 & Layer-3)", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-manual-untimestamped-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();
  closeRuntimeStore();

  let srv = null;
  const store = new ContextModeStore({ dbPath });
  store.open();
  try {
    const t2 = Date.now() - 10_000;
    const txPath = path.join(tmpDir, "tx-manual-consecutive.jsonl");
    // Disk currently ONLY has Manual Warm #1's untimestamped cold-read PLANNER_RESPONSE (missing created_at/timestamp!)
    const round1Steps = [
      { step_index: 1, type: "USER_INPUT", created_at: new Date(t2 - 200_000).toISOString(), content: "初始问题" },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(t2 - 199_000).toISOString(), input_tokens: 80_000, cache_read_tokens: 70_000, output_tokens: 50 },
      { step_index: 3, type: "SYSTEM_MESSAGE", content: buildManualKeepaliveMessage("zh") },
      { step_index: 4, type: "PLANNER_RESPONSE", input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
    ];
    fs.writeFileSync(txPath, round1Steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    // Direct parser verification
    const parsedInfo = inspectLatestTurnInSteps(round1Steps);
    assert.equal(parsedInfo.prefillTs, 0);
    assert.equal(parsedInfo.precededByKeepalivePrompt, true);
    assert.equal(parsedInfo.keepaliveMode, "manual");
    assert.equal(parsedInfo.cacheReadReported, true);
    assert.equal(parsedInfo.cacheReadTokens, 0);
    assert.equal(
      isKeepaliveTurnFlushedForRound(parsedInfo, {
        usedCount: 0,
        lastSentTs: t2,
        lastDispatchId: "ka_manual_round2",
        lastDispatchMode: "manual",
        pendingColdCheckId: "ka_manual_round2"
      }),
      false,
      "Untimestamped prior manual PLANNER_RESPONSE must NOT match newer manual dispatch"
    );

    // Layer-1 (Stop) for Manual Warm #2 while disk only has Manual #1's untimestamped cold-read
    writeWatchdogLease(store, {
      conversationId: "conv-manual-2x",
      rootSessionId: "conv-manual-2x",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t2,
      lastLlmStartTs: t2,
      updatedTs: t2,
      transcriptPath: txPath,
      contextTokens: 80_000
    });
    store.setTtlKeepaliveState("conv-manual-2x", {
      usedCount: 0,
      lastSentTs: t2 - 500,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_manual_round2",
      lastDispatchMode: "manual",
      pendingColdCheckId: "",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-manual-2x", transcriptPath: txPath, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t2 + 2_000 }
    );
    const afterStop = store.getTtlKeepaliveState("conv-manual-2x");
    assert.equal(afterStop.inKeepaliveTurn, false);
    assert.equal(afterStop.coldMissTripped, false, "Layer-1 Stop must NOT false-trip on previous untimestamped manual cold read");
    assert.equal(afterStop.pendingColdCheckId, "ka_manual_round2", "Must stay pending verification");

    // Layer-3 (Watchdog delayed check) while disk still only has Manual #1's untimestamped cold-read
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
      nowFn: () => t2 + 5_000,
      keepaliveSendFn: async () => ({ ok: true })
    });
    const l3Res = mon._runDelayedColdMissCheck(
      store,
      "conv-manual-2x",
      readWatchdogLease(store, "conv-manual-2x"),
      store.getTtlKeepaliveState("conv-manual-2x"),
      t2 + 5_000
    );
    assert.equal(l3Res.checked, false);
    assert.equal(l3Res.coldTripped, false);
    assert.equal(store.getTtlKeepaliveState("conv-manual-2x").pendingColdCheckId, "ka_manual_round2");
    assert.equal(store.getTtlKeepaliveState("conv-manual-2x").coldMissTripped, false);

    // Layer-2 (/api/cache-diag) while disk still only has Manual #1's untimestamped cold-read
    closeRuntimeStore();
    srv = createStandaloneServer({ port: 0 });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const htmlRes = await httpJsonRequest(port, "/", { method: "GET" });
    const csrfToken = htmlRes.raw.match(/name="agy-dart-token"\s+content="([a-f0-9]+)"/i)[1];
    const authHeaders = {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin"
    };
    const l2Before = await httpJsonRequest(port, "/api/cache-diag", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: "conv-manual-2x" }
    });
    assert.equal(l2Before.status, 200);
    assert.equal(l2Before.json.ttlKeepalive.coldMissTripped, false, "Layer-2 must NOT false-trip on previous untimestamped manual cold read");
    assert.equal(store.getTtlKeepaliveState("conv-manual-2x").pendingColdCheckId, "ka_manual_round2");

    // Once Manual Warm #2's actual timestamped warm response flushes -> clears pendingColdCheckId without tripping!
    fs.appendFileSync(
      txPath,
      [
        { step_index: 5, type: "SYSTEM_MESSAGE", created_at: new Date(t2).toISOString(), content: buildManualKeepaliveMessage("zh") },
        { step_index: 6, type: "PLANNER_RESPONSE", created_at: new Date(t2 + 1_000).toISOString(), input_tokens: 1_000, cache_read_tokens: 79_200, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    const l3After = mon._runDelayedColdMissCheck(
      store,
      "conv-manual-2x",
      readWatchdogLease(store, "conv-manual-2x"),
      store.getTtlKeepaliveState("conv-manual-2x"),
      t2 + 6_000
    );
    assert.equal(l3After.checked, true);
    assert.equal(l3After.coldTripped, false);
    const finalKa = store.getTtlKeepaliveState("conv-manual-2x");
    assert.equal(finalKa.pendingColdCheckId, "");
    assert.equal(finalKa.lastColdCheckedId, "ka_manual_round2");
    assert.equal(finalKa.coldMissTripped, false);
  } finally {
    if (srv) {
      await new Promise((r) => srv.close(r));
    }
    store.close();
    stopWatchdogMonitor();
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-11 (P2-4): Legacy lease without explicit cacheOriginTs straddling expiry boundary stays consistent across backend and both panel refresh paths", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-legacy-parity-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();
  closeRuntimeStore();

  try {
    const nowMs = Date.now();
    const mon = getWatchdogMonitor({
      nowFn: () => nowMs,
      keepaliveSendFn: async () => ({ ok: true })
    });
    const store = mon.getStore();

    // Transcript lastPlannerAt is 320s ago (expired on 300s TTL), while legacy lease (no cacheOriginTs!) has idleAnchorTs 200s ago (100s remaining)
    const txLegacy = path.join(tmpDir, "tx-legacy-boundary.jsonl");
    fs.writeFileSync(
      txLegacy,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(nowMs - 325_000).toISOString(), content: "旧租约测试" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: new Date(nowMs - 320_000).toISOString(),
          model: "claude-opus-4-6-thinking",
          max_token_limit: 200_000,
          input_tokens: 10_000,
          cache_read_tokens: 80_000,
          output_tokens: 50
        }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    store.setMeta(
      "watchdog_lease:conv-legacy-straddle",
      JSON.stringify({
        conversationId: "conv-legacy-straddle",
        rootSessionId: "conv-legacy-straddle",
        phase: "IDLE",
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: 90_000,
        windowTokens: 200_000,
        cacheTtlSec: 300,
        model: "claude-opus-4-6-thinking",
        transcriptPath: txLegacy,
        idleAnchorTs: nowMs - 200_000,
        phaseChangedTs: nowMs - 200_000,
        updatedTs: nowMs - 200_000
      })
    );

    const routes = new Map();
    registerSidecarRoutes({
      config: { conversationId: "conv-legacy-straddle" },
      api(routePath, handler) {
        routes.set(routePath, handler);
      }
    });
    const wdPayload = routes.get("/api/watchdog")({
      scope: "conversation",
      conversationId: "conv-legacy-straddle",
      fromSidecarHost: true
    });
    const kvPayload = routes.get("/api/cache-diag")({
      scope: "conversation",
      conversationId: "conv-legacy-straddle",
      fromSidecarHost: true
    });
    assert.equal(wdPayload.ttlKeepalive.cacheOriginTs, nowMs - 200_000);
    assert.equal(wdPayload.ttlKeepalive.remainingSec, 100);
    assert.equal(kvPayload.ttlKeepalive.cacheOriginTs, nowMs - 200_000);
    assert.equal(kvPayload.ttlKeepalive.remainingSec, 100);

    // Verify BOTH dashboard refresh paths (renderKvCacheCard/syncKvTtlState AND renderWatchdogCard) agree with backend (100s left, button enabled)
    const htmlSrc = readDashboardHtml();
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "1",
      disabled: false,
      className: "",
      style: {},
      dataset: { enabled: "0", used: "0", max: "1" },
      options: [],
      classList: {
        _set: new Set(),
        add(...cls) { cls.forEach((c) => this._set.add(c)); },
        remove(...cls) { cls.forEach((c) => this._set.delete(c)); },
        contains(c) { return this._set.has(c); },
        toggle(c, f) { const on = f === undefined ? !this._set.has(c) : Boolean(f); if (on) this._set.add(c); else this._set.delete(c); return on; }
      },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getAttribute() { return ""; },
      setAttribute() {}
    });
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const vmCtx = vm.createContext({
      window: {
        location: { search: "", href: "http://127.0.0.1:4321/" },
        sidecar: { conversationId: "conv-legacy-straddle" },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-legacy" }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: async (url) => {
        if (url === "/api/cache-diag") return { ok: true, status: 200, json: async () => structuredClone(kvPayload) };
        if (url === "/api/watchdog") return { ok: true, status: 200, json: async () => structuredClone(wdPayload) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      queueMicrotask,
      Date,
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      Promise,
      Error,
      RegExp,
      parseInt,
      parseFloat,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      console: { error() {}, log() {}, warn() {} }
    });

    vm.runInContext(scriptMatch[1], vmCtx);
    await flushMicrotasks();

    const warmBtn = getEl("kv-warm-now-btn");
    const ttlText = getEl("kv-ttl-bar-text");

    // Path 1: renderKvCacheCard -> syncKvTtlState
    vmCtx.renderKvCacheCard(structuredClone(kvPayload));
    assert.equal(warmBtn.disabled, false, "Path 1 (syncKvTtlState) must keep button enabled for legacy lease with 100s left");
    assert.equal(warmBtn.dataset.mode, "ready");
    assert.equal(warmBtn.textContent, "续温 1×");
    assert.equal(ttlText.textContent.includes("已过期"), false, `Path 1 must NOT show expired, got: ${ttlText.textContent}`);

    // Path 2: renderWatchdogCard reconciling after an earlier expired kv payload without lease alignment
    const unalignedKv = structuredClone(kvPayload);
    unalignedKv.ttlKeepalive = { ...unalignedKv.ttlKeepalive, hasLease: false, cacheOriginTs: 0 };
    vmCtx.renderKvCacheCard(unalignedKv);
    assert.equal(warmBtn.disabled, true, "Without lease alignment, expired lastPlannerAt disables button");
    vmCtx.renderWatchdogCard(structuredClone(wdPayload));
    assert.equal(warmBtn.disabled, false, "Path 2 (renderWatchdogCard) must reconcile legacy lease timing and re-enable button");
    assert.equal(warmBtn.dataset.mode, "ready");
    assert.equal(warmBtn.textContent, "续温 1×");
    assert.equal(ttlText.textContent.includes("已过期"), false, `Path 2 must NOT show expired, got: ${ttlText.textContent}`);
  } finally {
    stopWatchdogMonitor();
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-12 (P1-5): Stop verifies dispatch ownership inside write tx before writing coldMissTripped, pendingAck, or pendingColdCheckId", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-stop-ownership-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const t0 = 1_820_000_000_000;
    const origWriteTx = store._withWriteTx.bind(store);

    // 12a. Cold-read writeback vs concurrent PreInvocation reset -> must NOT trip coldMissTripped on new human turn!
    const txCold = path.join(tmpDir, "tx-stop-race-cold.jsonl");
    fs.writeFileSync(
      txCold,
      [
        { step_index: 1, type: "SYSTEM_MESSAGE", created_at: new Date(t0 - 2_000).toISOString(), content: buildManualKeepaliveMessage("zh") },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(t0 - 1_000).toISOString(), input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    writeWatchdogLease(store, {
      conversationId: "conv-stop-race-reset",
      rootSessionId: "conv-stop-race-reset",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0 - 2_000,
      lastLlmStartTs: t0 - 2_000,
      updatedTs: t0 - 2_000,
      transcriptPath: txCold,
      contextTokens: 80_000
    });
    store.setTtlKeepaliveState("conv-stop-race-reset", {
      usedCount: 0,
      lastSentTs: t0 - 2_500,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_old_cold_1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    let injectedReset = false;
    store._withWriteTx = (fn) => {
      if (!injectedReset) {
        injectedReset = true;
        // Another process ran PreInvocation for a genuine new user turn and reset keepalive state!
        store.resetTtlKeepaliveState("conv-stop-race-reset", t0 + 100);
      }
      return origWriteTx(fn);
    };
    await handleStopPayload(
      { conversationId: "conv-stop-race-reset", transcriptPath: txCold, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedReset, true, "Stop must use _withWriteTx for keepalive writeback");
    const kaAfterResetRace = store.getTtlKeepaliveState("conv-stop-race-reset");
    assert.equal(kaAfterResetRace.coldMissTripped, false, "Stale Stop must NOT trip coldMissTripped after PreInvocation reset");
    assert.equal(kaAfterResetRace.pendingColdCheckId, "");
    assert.equal(kaAfterResetRace.lastColdCheckedId, "");

    // 12b. Un-flushed markPendingColdCheckOnExit vs concurrent PreInvocation reset -> must NOT write stale pendingColdCheckId!
    const txMissing = path.join(tmpDir, "tx-stop-race-missing.jsonl");
    writeWatchdogLease(store, {
      conversationId: "conv-stop-race-pending",
      rootSessionId: "conv-stop-race-pending",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0 - 2_000,
      lastLlmStartTs: t0 - 2_000,
      updatedTs: t0 - 2_000,
      transcriptPath: txMissing,
      contextTokens: 80_000
    });
    store.setTtlKeepaliveState("conv-stop-race-pending", {
      usedCount: 0,
      lastSentTs: t0 - 2_500,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_old_pending_1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    let injectedPendingReset = false;
    store._withWriteTx = (fn) => {
      if (!injectedPendingReset) {
        injectedPendingReset = true;
        store.resetTtlKeepaliveState("conv-stop-race-pending", t0 + 100);
      }
      return origWriteTx(fn);
    };
    await handleStopPayload(
      { conversationId: "conv-stop-race-pending", transcriptPath: txMissing, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedPendingReset, true);
    const kaAfterPendingRace = store.getTtlKeepaliveState("conv-stop-race-pending");
    assert.equal(kaAfterPendingRace.pendingColdCheckId, "", "Stale Stop must NOT write pendingColdCheckId after PreInvocation reset");

    // 12c. Cold-read writeback vs newer dispatch pendingAck=true -> must NOT clear newer pendingAck or trip newer dispatch!
    writeWatchdogLease(store, {
      conversationId: "conv-stop-race-new-dispatch",
      rootSessionId: "conv-stop-race-new-dispatch",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0 - 2_000,
      lastLlmStartTs: t0 - 2_000,
      updatedTs: t0 - 2_000,
      transcriptPath: txCold,
      contextTokens: 80_000
    });
    store.setTtlKeepaliveState("conv-stop-race-new-dispatch", {
      usedCount: 0,
      lastSentTs: t0 - 2_500,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_old_dispatch_1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    let injectedNewDispatch = false;
    store._withWriteTx = (fn) => {
      if (!injectedNewDispatch) {
        injectedNewDispatch = true;
        store.setTtlKeepaliveState("conv-stop-race-new-dispatch", {
          lastDispatchId: "ka_newer_dispatch_2",
          lastDispatchMode: "manual",
          lastSentTs: t0 + 20_000,
          pendingAck: true,
          inKeepaliveTurn: false,
          pendingColdCheckId: "",
          coldMissTripped: false,
          updatedTs: t0 + 20_000
        });
      }
      return origWriteTx(fn);
    };
    await handleStopPayload(
      { conversationId: "conv-stop-race-new-dispatch", transcriptPath: txCold, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedNewDispatch, true);
    const kaAfterNewDispatchRace = store.getTtlKeepaliveState("conv-stop-race-new-dispatch");
    assert.equal(kaAfterNewDispatchRace.lastDispatchId, "ka_newer_dispatch_2");
    assert.equal(kaAfterNewDispatchRace.pendingAck, true, "Stale Stop must NOT clear newer dispatch's pendingAck");
    assert.equal(kaAfterNewDispatchRace.coldMissTripped, false, "Stale Stop must NOT trip coldMissTripped on newer dispatch");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-13: Deep adversarial hardening — multi-tool human turn attribution, slow manual #1 vs #2 window, post-reset auto 1/N, real PreInvocation race & real SQLite busy lock-wait expiry", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-deep-hardening-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const t0 = 1_820_000_000_000;

    // 13a. Multi-tool human turn followed 3s later by manual keepalive -> MUST NOT attribute human cold read to manual warm!
    const multiToolHumanSteps = [
      { step_index: 1, type: "USER_INPUT", created_at: new Date(t0 - 10_000).toISOString(), content: "Inspect app.js" },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(t0 - 8_000).toISOString(), input_tokens: 80_000, cache_read_tokens: 0, output_tokens: 40, tool_calls: [{ id: "tc1", name: "read_file" }] },
      { step_index: 3, type: "TOOL_RESULT", created_at: new Date(t0 - 7_000).toISOString(), tool_call_id: "tc1", content: "file content" },
      { step_index: 4, type: "PLANNER_RESPONSE", created_at: new Date(t0).toISOString(), input_tokens: 82_000, cache_read_tokens: 0, output_tokens: 60, content: "Done." }
    ];
    const humanInfo = inspectLatestTurnInSteps(multiToolHumanSteps);
    assert.equal(humanInfo.precededByGenuineUser, true, "Multi-tool human turn must trace back to USER_INPUT");
    assert.equal(humanInfo.precededByKeepalivePrompt, false);
    assert.equal(
      isKeepaliveTurnFlushedForRound(humanInfo, {
        usedCount: 0,
        lastSentTs: t0 + 3_000,
        lastIdleAnchorTs: t0 + 1_000,
        lastDispatchId: "ka_m1",
        lastDispatchMode: "manual",
        pendingColdCheckId: "ka_m1"
      }),
      false,
      "Human multi-tool turn must NEVER match a subsequent manual keepalive"
    );

    const txHuman = path.join(tmpDir, "tx-human-multitool.jsonl");
    fs.writeFileSync(txHuman, multiToolHumanSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    writeWatchdogLease(store, {
      conversationId: "conv-human-multitool",
      rootSessionId: "conv-human-multitool",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0 + 3_200,
      lastLlmStartTs: t0 + 3_200,
      updatedTs: t0 + 3_200,
      transcriptPath: txHuman,
      contextTokens: 82_000
    });
    store.setTtlKeepaliveState("conv-human-multitool", {
      usedCount: 0,
      lastSentTs: t0 + 3_000,
      lastIdleAnchorTs: t0 + 1_000,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_m1",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-human-multitool", transcriptPath: txHuman, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 4_000 }
    );
    const kaHumanAfterStop = store.getTtlKeepaliveState("conv-human-multitool");
    assert.equal(kaHumanAfterStop.coldMissTripped, false, "Stop must NOT false-trip on prior human multi-tool cold read");
    assert.equal(kaHumanAfterStop.pendingColdCheckId, "ka_m1");

    // 13b. Slow Manual #1 (12s, stopped at t0+13s) vs Manual #2 at t0+15s + Post-reset untimestamped Auto 1/3
    const slowManual1Steps = [
      { step_index: 1, type: "USER_INPUT", created_at: new Date(t0 - 200_000).toISOString(), content: "hi" },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(t0 - 199_000).toISOString(), input_tokens: 80_000, cache_read_tokens: 70_000, output_tokens: 30 },
      { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(t0).toISOString(), content: buildManualKeepaliveMessage("zh") },
      { step_index: 4, type: "PLANNER_RESPONSE", created_at: new Date(t0 + 12_000).toISOString(), input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
    ];
    assert.equal(
      isKeepaliveTurnFlushedForRound(inspectLatestTurnInSteps(slowManual1Steps), {
        usedCount: 0,
        lastSentTs: t0 + 15_000,
        lastIdleAnchorTs: t0 + 13_000,
        lastDispatchId: "ka_m2",
        lastDispatchMode: "manual",
        pendingColdCheckId: "ka_m2"
      }),
      false,
      "Prior slow manual round within 5s of next manual dispatch must NOT match newer dispatch"
    );

    const untimestampedAuto1 = [
      { step_index: 1, type: "SYSTEM_MESSAGE", content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
      { step_index: 2, type: "PLANNER_RESPONSE", input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
    ];
    assert.equal(
      isKeepaliveTurnFlushedForRound(inspectLatestTurnInSteps(untimestampedAuto1), {
        usedCount: 1,
        lastSentTs: t0 + 60_000,
        lastDispatchMode: "auto",
        lastDispatchId: "ka_auto_r1_after_reset"
      }),
      false,
      "Post-reset auto 1/3 with lastSentTs > 0 must NOT match untimestamped prior 1/3 cold read"
    );

    // 13c. Real spawned PreInvocation child process racing with Stop -> Stop preserves BOTH reset kaState AND new LLM_INFLIGHT lease!
    const tRace = Date.now() - 10_000;
    const txColdRace = path.join(tmpDir, "tx-real-preinv-race.jsonl");
    fs.writeFileSync(
      txColdRace,
      [
        { step_index: 1, type: "SYSTEM_MESSAGE", created_at: new Date(tRace).toISOString(), content: buildManualKeepaliveMessage("zh") },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tRace + 500).toISOString(), input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    writeWatchdogLease(store, {
      conversationId: "conv-real-preinv-race",
      rootSessionId: "conv-real-preinv-race",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: tRace,
      lastLlmStartTs: tRace,
      updatedTs: tRace,
      transcriptPath: txColdRace,
      contextTokens: 80_000
    });
    store.setTtlKeepaliveState("conv-real-preinv-race", {
      usedCount: 0,
      lastSentTs: tRace - 200,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_old_race",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    const origWriteTx = store._withWriteTx.bind(store);
    let spawnedPreInv = false;
    store._withWriteTx = (fn) => {
      if (!spawnedPreInv) {
        spawnedPreInv = true;
        const r = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
          input: JSON.stringify({
            conversationId: "conv-real-preinv-race",
            invocationNum: 0,
            lastUserInput: "真实新轮次消息"
          }),
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
        });
        assert.equal(r.status, 0, `Spawned pre-invocation.mjs failed: ${r.stderr}`);
      }
      return origWriteTx(fn);
    };
    const stopRaceRes = await handleStopPayload(
      { conversationId: "conv-real-preinv-race", transcriptPath: txColdRace, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: tRace + 1_500 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(spawnedPreInv, true);
    assert.equal(stopRaceRes.updated, false);
    assert.equal(stopRaceRes.reason, "superseded_by_newer_turn");
    const kaAfterRealRace = store.getTtlKeepaliveState("conv-real-preinv-race");
    assert.equal(kaAfterRealRace.coldMissTripped, false, "Stale Stop must NOT trip coldMissTripped after real PreInvocation");
    assert.equal(kaAfterRealRace.lastDispatchId, "");
    const leaseAfterRealRace = readWatchdogLease(store, "conv-real-preinv-race");
    assert.equal(leaseAfterRealRace.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Stale Stop must NOT overwrite real PreInvocation LLM_INFLIGHT lease to IDLE");
    assert.ok(leaseAfterRealRace.startedTs > tRace, "New PreInvocation startedTs must be preserved");

    // 13d. Rollback with stale inKeepaliveTurn=true + existing pendingColdCheckId cleans up and restores cleanly
    const monRollback = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false, ttlKeepaliveLeadSec: 60, ttlKeepaliveMinRemainSec: 15 }),
      nowFn: () => t0 + 100_000,
      keepaliveSendFn: async () => ({ ok: false, error: "rpc_down" })
    });
    seedStoppedLease(store, "conv-rollback-stale", { cacheOriginTs: t0, idleAnchorTs: t0 + 10_000 });
    store.setTtlKeepaliveState("conv-rollback-stale", {
      usedCount: 0,
      inKeepaliveTurn: true,
      pendingAck: false,
      lastIdleAnchorTs: t0 - 50_000,
      lastSentTs: t0 - 40_000,
      lastDispatchId: "ka_prev_unverified",
      lastDispatchMode: "manual",
      pendingColdCheckId: "ka_prev_unverified"
    });
    const rbClaim = monRollback.triggerManualKeepalive("conv-rollback-stale");
    assert.equal(rbClaim.dispatched, true);
    await flushMicrotasks();
    const rbAfter = store.getTtlKeepaliveState("conv-rollback-stale");
    assert.equal(rbAfter.pendingAck, false, "Rollback must clear pendingAck even if prior inKeepaliveTurn was stale");
    assert.equal(rbAfter.inKeepaliveTurn, false);
    assert.equal(rbAfter.lastDispatchId, "ka_prev_unverified");
    assert.equal(rbAfter.pendingColdCheckId, "ka_prev_unverified", "Rollback must preserve prior pendingColdCheckId");
    assert.equal(rbAfter.lastError, "rpc_down");

    // 13e. Real OS-level multi-process SQLite BEGIN IMMEDIATE lock wait causing cache expiry -> already_expired, 0 sends
    const lockerScript = `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000");
      process.stdout.write("READY\\n");
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        if (chunk.includes("LOCK")) {
          db.exec("BEGIN IMMEDIATE");
          process.stdout.write("LOCKED\\n");
          const sab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sab, 0, 0, 2100);
          db.exec("COMMIT");
          db.close();
          process.exit(0);
        }
      });
    `;
    const lockerChild = spawn(process.execPath, ["--input-type=module", "-e", lockerScript, dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const waitForLine = (token) =>
      new Promise((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${token}`)), 10_000);
        const onData = (d) => {
          buf += d.toString("utf8");
          if (buf.includes(token)) {
            clearTimeout(timer);
            lockerChild.stdout.off("data", onData);
            resolve();
          }
        };
        lockerChild.stdout.on("data", onData);
        lockerChild.once("exit", (code) => {
          clearTimeout(timer);
          if (!buf.includes(token)) reject(new Error(`Locker exited early with code ${code}`));
        });
      });

    try {
      await waitForLine("READY");
      const realStart = Date.now();
      seedStoppedLease(store, "conv-real-sqlite-busy", {
        cacheOriginTs: realStart - 298_400, // ~1.6s remaining (remSec === 1..2 at click time, expires during 2.1s lock wait)
        idleAnchorTs: realStart - 290_000,
        cacheTtlSec: 300
      });
      lockerChild.stdin.write("LOCK\n");
      await waitForLine("LOCKED");

      const busySent = [];
      const monRealBusy = new WatchdogMonitor({
        getStore: () => store,
        getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false, ttlKeepaliveLeadSec: 60, ttlKeepaliveMinRemainSec: 15 }),
        keepaliveSendFn: async (p) => {
          busySent.push(p);
          return { ok: true };
        }
      });
      const callStartMs = Date.now();
      const busyRes = monRealBusy.triggerManualKeepalive("conv-real-sqlite-busy");
      const waitedMs = Date.now() - callStartMs;
      await flushMicrotasks();
      assert.ok(waitedMs >= 1000, `Expected real SQLite BEGIN IMMEDIATE lock wait >= 1000ms, got ${waitedMs}ms`);
      assert.equal(busyRes.ok, true);
      assert.equal(busyRes.dispatched, false);
      assert.equal(busyRes.skippedReason, "already_expired", "Real SQLite lock wait past expiry must return already_expired");
      assert.ok(busyRes.remSec <= 0, `Expected remSec <= 0 after real SQLite lock wait, got ${busyRes.remSec}`);
      assert.equal(busySent.length, 0, "Real SQLite lock-wait expiry must produce 0 sends");
    } finally {
      try {
        lockerChild.kill();
      } catch {}
    }
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-14 (R2 P1-1): Stop lease ownership guards newer stopped_bg_pending, newer IDLE/stopped, newly-appeared lease, deleted lease & markIdle user_cleared while preserving normal first Stop", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-r2-stop-lease-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const t0 = 1_825_000_000_000;
    const origWriteTx = store._withWriteTx.bind(store);

    // 14a. Newer turn already entered IDLE/stopped_bg_pending -> stale Stop must skip and preserve stopped_bg_pending
    writeWatchdogLease(store, {
      conversationId: "conv-r2-bg-pending",
      rootSessionId: "conv-r2-bg-pending",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0,
      idleAnchorTs: t0,
      updatedTs: t0,
      contextTokens: 80_000
    });
    let injectedBgPending = false;
    store._withWriteTx = (fn) => {
      if (!injectedBgPending) {
        injectedBgPending = true;
        writeWatchdogLease(store, {
          conversationId: "conv-r2-bg-pending",
          rootSessionId: "conv-r2-bg-pending",
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped_bg_pending",
          stopReason: "subagent_running",
          startedTs: t0 + 5_000,
          idleAnchorTs: t0 + 6_000,
          updatedTs: t0 + 6_000,
          contextTokens: 82_000
        });
      }
      return origWriteTx(fn);
    };
    const resBg = await handleStopPayload(
      { conversationId: "conv-r2-bg-pending", terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 7_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedBgPending, true);
    assert.equal(resBg.updated, false);
    assert.equal(resBg.reason, "superseded_by_newer_turn");
    const leaseBg = readWatchdogLease(store, "conv-r2-bg-pending");
    assert.equal(leaseBg.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(leaseBg.subphase, "stopped_bg_pending", "Stale Stop must NOT downgrade stopped_bg_pending to stopped");
    assert.equal(leaseBg.startedTs, t0 + 5_000);
    assert.equal(leaseBg.stopReason, "subagent_running");

    // 14b. Newer turn already completed into IDLE/stopped -> stale Stop must skip and preserve newer cycle
    writeWatchdogLease(store, {
      conversationId: "conv-r2-newer-idle",
      rootSessionId: "conv-r2-newer-idle",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0,
      idleAnchorTs: t0,
      updatedTs: t0,
      contextTokens: 80_000
    });
    let injectedNewerIdle = false;
    store._withWriteTx = (fn) => {
      if (!injectedNewerIdle) {
        injectedNewerIdle = true;
        writeWatchdogLease(store, {
          conversationId: "conv-r2-newer-idle",
          rootSessionId: "conv-r2-newer-idle",
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          stopReason: "NEWER_TURN_DONE",
          startedTs: t0 + 5_000,
          idleAnchorTs: t0 + 7_000,
          updatedTs: t0 + 7_000,
          contextTokens: 90_000
        });
      }
      return origWriteTx(fn);
    };
    const resNewerIdle = await handleStopPayload(
      { conversationId: "conv-r2-newer-idle", terminationReason: "STALE_STOP" },
      { store, nowMs: t0 + 8_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedNewerIdle, true);
    assert.equal(resNewerIdle.updated, false);
    assert.equal(resNewerIdle.reason, "superseded_by_newer_turn");
    const leaseNewerIdle = readWatchdogLease(store, "conv-r2-newer-idle");
    assert.equal(leaseNewerIdle.startedTs, t0 + 5_000);
    assert.equal(leaseNewerIdle.idleAnchorTs, t0 + 7_000);
    assert.equal(leaseNewerIdle.stopReason, "NEWER_TURN_DONE");

    // 14c. Initial read had NO lease (existing === null), new lease appeared before tx -> must skip
    let injectedAppeared = false;
    store._withWriteTx = (fn) => {
      if (!injectedAppeared) {
        injectedAppeared = true;
        writeWatchdogLease(store, {
          conversationId: "conv-r2-appeared",
          rootSessionId: "conv-r2-appeared",
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          startedTs: t0 + 1_000,
          idleAnchorTs: t0 + 1_000,
          updatedTs: t0 + 1_000,
          contextTokens: 60_000
        });
      }
      return origWriteTx(fn);
    };
    const resAppeared = await handleStopPayload(
      { conversationId: "conv-r2-appeared", terminationReason: "STALE_FIRST_STOP" },
      { store, nowMs: t0 + 2_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedAppeared, true);
    assert.equal(resAppeared.updated, false);
    assert.equal(resAppeared.reason, "superseded_by_newer_turn");
    const leaseAppeared = readWatchdogLease(store, "conv-r2-appeared");
    assert.equal(leaseAppeared.phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.equal(leaseAppeared.startedTs, t0 + 1_000);

    // 14d. Amendment 1: Initial read had a lease, deleted before tx -> must skip and NOT recreate deleted lease
    writeWatchdogLease(store, {
      conversationId: "conv-r2-deleted",
      rootSessionId: "conv-r2-deleted",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0,
      idleAnchorTs: t0,
      updatedTs: t0,
      contextTokens: 70_000
    });
    let injectedDelete = false;
    store._withWriteTx = (fn) => {
      if (!injectedDelete) {
        injectedDelete = true;
        store.deleteMeta("watchdog_lease:conv-r2-deleted");
      }
      return origWriteTx(fn);
    };
    const resDeleted = await handleStopPayload(
      { conversationId: "conv-r2-deleted", terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 3_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(injectedDelete, true);
    assert.equal(resDeleted.updated, false);
    assert.equal(resDeleted.reason, "lease_deleted");
    assert.equal(resDeleted.lease, null);
    assert.equal(
      readWatchdogLease(store, "conv-r2-deleted"),
      null,
      "Stale Stop must NOT recreate a lease deleted before acquiring tx lock"
    );

    // 14e. Amendment 2: Initial read was active turn, user clicked markIdle() before tx -> preserves user_cleared + custom stopReason
    //      even though markIdle() keeps original startedTs and idleAnchorTs (and even with same-ms updatedTs).
    for (const [cid, markTs, customReason] of [
      ["conv-r2-markidle-later", t0 + 1_500, "user_manual_clear_custom"],
      ["conv-r2-markidle-samems", t0, "user_same_ms_reason"]
    ]) {
      writeWatchdogLease(store, {
        conversationId: cid,
        rootSessionId: cid,
        phase: WATCHDOG_PHASES.LLM_INFLIGHT,
        subphase: "high_ctx",
        startedTs: t0,
        idleAnchorTs: t0,
        updatedTs: t0,
        contextTokens: 75_000
      });
      const monMark = new WatchdogMonitor({
        getStore: () => store,
        getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
        nowFn: () => markTs
      });
      let injectedMarkIdle = false;
      store._withWriteTx = (fn) => {
        if (!injectedMarkIdle) {
          injectedMarkIdle = true;
          monMark.markIdle(cid, customReason);
        }
        return origWriteTx(fn);
      };
      const resMark = await handleStopPayload(
        { conversationId: cid, terminationReason: "NO_TOOL_CALL" },
        { store, nowMs: t0 + 3_000 }
      );
      store._withWriteTx = origWriteTx;
      assert.equal(injectedMarkIdle, true);
      assert.equal(resMark.updated, false, `${cid}: Stale Stop must skip after markIdle`);
      assert.equal(resMark.reason, "superseded_by_newer_turn");
      const leaseAfterMark = readWatchdogLease(store, cid);
      assert.equal(leaseAfterMark.phase, WATCHDOG_PHASES.IDLE);
      assert.equal(leaseAfterMark.subphase, "user_cleared", `${cid}: user_cleared subphase must be preserved`);
      assert.equal(leaseAfterMark.stopReason, customReason, `${cid}: user-set stopReason must be preserved`);
      assert.equal(leaseAfterMark.startedTs, t0);
      assert.equal(leaseAfterMark.idleAnchorTs, t0);
    }

    // 14f. Positive control: normal first Stop (null initially AND null in tx) still writes IDLE/stopped lease
    assert.equal(readWatchdogLease(store, "conv-r2-first-stop"), null);
    const resFirst = await handleStopPayload(
      { conversationId: "conv-r2-first-stop", terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 4_000 }
    );
    assert.equal(resFirst.updated, true, "Normal first Stop with no prior lease must succeed");
    const leaseFirst = readWatchdogLease(store, "conv-r2-first-stop");
    assert.ok(leaseFirst);
    assert.equal(leaseFirst.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(leaseFirst.subphase, "stopped");
    assert.equal(leaseFirst.stopReason, "NO_TOOL_CALL");

    // 14g. Edge hardening: same-ms IDLE->stale_cleanup, clock-skewed IDLE->markIdle, and same-ms active new turn
    writeWatchdogLease(store, {
      conversationId: "conv-r2-samems-stale",
      rootSessionId: "conv-r2-samems-stale",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      startedTs: t0,
      idleAnchorTs: t0 + 1_000,
      updatedTs: t0 + 1_000
    });
    let injSameMsStale = false;
    store._withWriteTx = (fn) => {
      if (!injSameMsStale) {
        injSameMsStale = true;
        writeWatchdogLease(store, {
          conversationId: "conv-r2-samems-stale",
          rootSessionId: "conv-r2-samems-stale",
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stale_cleanup",
          stopReason: "stale",
          startedTs: t0,
          idleAnchorTs: t0 + 1_000,
          updatedTs: t0 + 1_000
        });
      }
      return origWriteTx(fn);
    };
    const resSameMsStale = await handleStopPayload(
      { conversationId: "conv-r2-samems-stale", terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 2_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(resSameMsStale.updated, false);
    assert.equal(resSameMsStale.reason, "superseded_by_newer_turn");
    assert.equal(readWatchdogLease(store, "conv-r2-samems-stale").subphase, "stale_cleanup");

    writeWatchdogLease(store, {
      conversationId: "conv-r2-skew-markidle",
      rootSessionId: "conv-r2-skew-markidle",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      startedTs: t0,
      idleAnchorTs: t0 + 1_000,
      updatedTs: t0 + 1_000
    });
    const monSkew = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
      nowFn: () => t0 + 999 // 1ms clock skew behind existing.updatedTs
    });
    let injSkewMark = false;
    store._withWriteTx = (fn) => {
      if (!injSkewMark) {
        injSkewMark = true;
        monSkew.markIdle("conv-r2-skew-markidle", "user_skew_preserved");
      }
      return origWriteTx(fn);
    };
    const resSkewMark = await handleStopPayload(
      { conversationId: "conv-r2-skew-markidle", terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 2_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(resSkewMark.updated, false);
    assert.equal(resSkewMark.reason, "superseded_by_newer_turn");
    const leaseSkew = readWatchdogLease(store, "conv-r2-skew-markidle");
    assert.equal(leaseSkew.subphase, "user_cleared");
    assert.equal(leaseSkew.stopReason, "user_skew_preserved");

    writeWatchdogLease(store, {
      conversationId: "conv-r2-samems-active-new",
      rootSessionId: "conv-r2-samems-active-new",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: t0,
      idleAnchorTs: t0,
      updatedTs: t0,
      lastUserInput: "turn 1 prompt"
    });
    let injSameMsActive = false;
    store._withWriteTx = (fn) => {
      if (!injSameMsActive) {
        injSameMsActive = true;
        writeWatchdogLease(store, {
          conversationId: "conv-r2-samems-active-new",
          rootSessionId: "conv-r2-samems-active-new",
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          startedTs: t0,
          idleAnchorTs: t0,
          updatedTs: t0,
          lastUserInput: "turn 2 prompt"
        });
      }
      return origWriteTx(fn);
    };
    const resSameMsActive = await handleStopPayload(
      { conversationId: "conv-r2-samems-active-new", terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: t0 + 1_000 }
    );
    store._withWriteTx = origWriteTx;
    assert.equal(resSameMsActive.updated, false);
    assert.equal(resSameMsActive.reason, "superseded_by_newer_turn");
    assert.equal(readWatchdogLease(store, "conv-r2-samems-active-new").phase, WATCHDOG_PHASES.LLM_INFLIGHT);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-15 (R2 P1-2): Interval-based trajectory timestamp causality — excludes exact .350 < .550/.800, keeps same-second prompt pending, allows mixed-precision 12:00:00Z prompt + 12:00:01.200Z response", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-r2-ts-precision-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const store = new ContextModeStore({ dbPath });
  store.open();
  let srv = null;

  try {
    // Precision parser checks
    assert.equal(parseStepPrefillTimestampInfo({ created_at: "2026-11-25T12:00:00.800Z" }).subSecond, true);
    assert.equal(parseStepPrefillTimestampInfo({ created_at: "2026-11-25T12:00:00.000Z" }).subSecond, true);
    assert.equal(parseStepPrefillTimestampInfo({ created_at: "2026-11-25T12:00:00Z" }).subSecond, false);
    assert.equal(parseStepPrefillTimestampInfo({ created_at: "2026-11-25T12:00:00+08:00" }).subSecond, false);
    assert.equal(parseStepPrefillTimestampInfo({ ts: Date.parse("2026-11-25T12:00:00.800Z") }).subSecond, true);

    const anchorMs = Date.parse("2026-11-25T12:00:00.550Z");
    const sentMs = Date.parse("2026-11-25T12:00:00.800Z");

    // 15a. Anti-case (Round-2 P1): old prompt lacks timestamp, old exact response at .350 < anchor .550 < dispatch .800 -> MUST exclude
    const exactEarlierSteps = [
      { step_index: 1, type: "SYSTEM_MESSAGE", content: buildManualKeepaliveMessage("zh") },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:00.350Z",
        input_tokens: 80_100,
        cache_read_tokens: 0,
        output_tokens: 3,
        content: "OK"
      }
    ];
    const exactEarlierInfo = inspectLatestTurnInSteps(exactEarlierSteps);
    assert.equal(exactEarlierInfo.prefillSubSecond, true);
    assert.equal(exactEarlierInfo.keepalivePromptTs, 0);
    assert.equal(
      isKeepaliveTurnFlushedForRound(exactEarlierInfo, {
        usedCount: 0,
        lastIdleAnchorTs: anchorMs,
        lastSentTs: sentMs,
        lastDispatchId: "ka_r2_manual_new",
        lastDispatchMode: "manual",
        pendingColdCheckId: "ka_r2_manual_new"
      }),
      false,
      "Exact response at .350 before anchor .550 / dispatch .800 must be rejected"
    );

    // End-to-end Layer-3 verification for 15a: must NOT false-trip coldMissTripped
    const txEarlier = path.join(tmpDir, "tx-exact-earlier.jsonl");
    fs.writeFileSync(txEarlier, exactEarlierSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    seedStoppedLease(store, "conv-r2-exact-earlier", {
      cacheOriginTs: anchorMs - 10_000,
      idleAnchorTs: anchorMs,
      transcriptPath: txEarlier
    });
    store.setTtlKeepaliveState("conv-r2-exact-earlier", {
      usedCount: 0,
      lastIdleAnchorTs: anchorMs,
      lastSentTs: sentMs,
      lastAttemptTs: sentMs,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_r2_manual_new",
      lastDispatchMode: "manual",
      pendingColdCheckId: "ka_r2_manual_new",
      coldMissTripped: false
    });
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true, ttlKeepalive: false }),
      nowFn: () => sentMs + 5_000,
      keepaliveSendFn: async () => ({ ok: true })
    });
    const l3Earlier = mon._runDelayedColdMissCheck(
      store,
      "conv-r2-exact-earlier",
      readWatchdogLease(store, "conv-r2-exact-earlier"),
      store.getTtlKeepaliveState("conv-r2-exact-earlier"),
      sentMs + 5_000
    );
    assert.equal(l3Earlier.checked, false);
    assert.equal(l3Earlier.coldTripped, false);
    assert.equal(store.getTtlKeepaliveState("conv-r2-exact-earlier").coldMissTripped, false);
    assert.equal(store.getTtlKeepaliveState("conv-r2-exact-earlier").pendingColdCheckId, "ka_r2_manual_new");

    // 15b. Second-only prompt at 12:00:00Z alone (response untimestamped OR also 12:00:00Z) when dispatched at 12:00:00.800Z -> stays pending
    for (const respTs of [undefined, "2026-11-25T12:00:00Z"]) {
      const sameSecSteps = [
        { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T12:00:00Z", content: buildManualKeepaliveMessage("zh") },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          ...(respTs ? { created_at: respTs } : {}),
          input_tokens: 80_100,
          cache_read_tokens: 0,
          output_tokens: 3,
          content: "OK"
        }
      ];
      const sameSecInfo = inspectLatestTurnInSteps(sameSecSteps);
      assert.equal(sameSecInfo.keepalivePromptSubSecond, false);
      assert.equal(
        isKeepaliveTurnFlushedForRound(sameSecInfo, {
          usedCount: 0,
          lastIdleAnchorTs: anchorMs,
          lastSentTs: sentMs,
          lastDispatchId: "ka_r2_same_sec",
          lastDispatchMode: "manual",
          pendingColdCheckId: "ka_r2_same_sec"
        }),
        false,
        `Second-only same-second evidence (respTs=${respTs || "none"}) must stay pending`
      );
    }

    // 15c. Amendment 2 — Mixed-precision POSITIVE case:
    //      dispatched at 12:00:00.800Z, prompt has second-only 12:00:00Z, same-turn response has exact 12:00:01.200Z -> MUST verify!
    const mixedManualSteps = [
      { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T12:00:00Z", content: buildManualKeepaliveMessage("zh") },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:01.200Z",
        input_tokens: 80_100,
        cache_read_tokens: 0,
        output_tokens: 3,
        content: "OK"
      }
    ];
    const mixedManualInfo = inspectLatestTurnInSteps(mixedManualSteps);
    assert.equal(mixedManualInfo.keepalivePromptSubSecond, false);
    assert.equal(mixedManualInfo.prefillSubSecond, true);
    assert.equal(
      isKeepaliveTurnFlushedForRound(mixedManualInfo, {
        usedCount: 0,
        lastIdleAnchorTs: anchorMs,
        lastSentTs: sentMs,
        lastDispatchId: "ka_r2_mixed_manual",
        lastDispatchMode: "manual",
        pendingColdCheckId: "ka_r2_mixed_manual"
      }),
      true,
      "Mixed-precision (12:00:00Z prompt + exact 12:00:01.200Z response) must match manual dispatch at 12:00:00.800Z"
    );

    // Same mixed-precision positive case for Auto round 1/3 + end-to-end Layer-3 cold-miss trip!
    const mixedAutoSteps = [
      { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T12:00:00Z", content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:01.200Z",
        input_tokens: 80_100,
        cache_read_tokens: 0,
        output_tokens: 3,
        content: "OK"
      }
    ];
    const txMixedAuto = path.join(tmpDir, "tx-mixed-auto.jsonl");
    fs.writeFileSync(txMixedAuto, mixedAutoSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    seedStoppedLease(store, "conv-r2-mixed-auto", {
      cacheOriginTs: anchorMs - 10_000,
      idleAnchorTs: anchorMs,
      transcriptPath: txMixedAuto
    });
    store.setTtlKeepaliveState("conv-r2-mixed-auto", {
      usedCount: 1,
      lastIdleAnchorTs: anchorMs,
      lastSentTs: sentMs,
      lastAttemptTs: sentMs,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_r2_mixed_auto",
      lastDispatchMode: "auto",
      pendingColdCheckId: "ka_r2_mixed_auto",
      lastColdCheckUsed: 0,
      coldMissTripped: false
    });
    const l3Mixed = mon._runDelayedColdMissCheck(
      store,
      "conv-r2-mixed-auto",
      readWatchdogLease(store, "conv-r2-mixed-auto"),
      store.getTtlKeepaliveState("conv-r2-mixed-auto"),
      sentMs + 5_000
    );
    assert.equal(l3Mixed.checked, true, "Mixed-precision real cold read must be verified by Layer-3");
    assert.equal(l3Mixed.coldTripped, true, "Mixed-precision real cold read must trip coldMissTripped");
    assert.equal(store.getTtlKeepaliveState("conv-r2-mixed-auto").coldMissTripped, true);
    assert.equal(store.getTtlKeepaliveState("conv-r2-mixed-auto").pendingColdCheckId, "");

    // 15d. Prior second-only prompt (11:59:59Z -> [11:59:59.000, 11:59:59.999] < 12:00:00.800) with later response -> MUST reject
    const priorSecPromptSteps = [
      { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T11:59:59Z", content: buildManualKeepaliveMessage("zh") },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:01.200Z",
        input_tokens: 80_100,
        cache_read_tokens: 0,
        output_tokens: 3,
        content: "OK"
      }
    ];
    assert.equal(
      isKeepaliveTurnFlushedForRound(inspectLatestTurnInSteps(priorSecPromptSteps), {
        usedCount: 0,
        lastIdleAnchorTs: anchorMs,
        lastSentTs: sentMs,
        lastDispatchId: "ka_r2_prior_sec",
        lastDispatchMode: "manual"
      }),
      false,
      "Second-only prompt strictly before dispatch second (hi=11:59:59.999 < 12:00:00.800) must be excluded"
    );

    // 15e. Second-only response in strictly later second (12:00:01Z -> lo=12:00:01.000 >= 12:00:00.800) -> MUST allow
    const nextSecSteps = [
      { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T12:00:00Z", content: buildManualKeepaliveMessage("zh") },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:01Z",
        input_tokens: 80_100,
        cache_read_tokens: 0,
        output_tokens: 3,
        content: "OK"
      }
    ];
    assert.equal(
      isKeepaliveTurnFlushedForRound(inspectLatestTurnInSteps(nextSecSteps), {
        usedCount: 0,
        lastIdleAnchorTs: anchorMs,
        lastSentTs: sentMs,
        lastDispatchId: "ka_r2_next_sec",
        lastDispatchMode: "manual"
      }),
      true,
      "Second-only response at 12:00:01Z is provably after 12:00:00.800Z and must verify"
    );

    // 15f. Exact .000 lastSentTs boundary symmetry: second-only 12:00:00Z stays pending whether lastIdleAnchorTs is 0 or earlier
    const sentExact000 = Date.parse("2026-11-25T12:00:00.000Z");
    const anchorEarlier = Date.parse("2026-11-25T11:55:00.000Z");
    const secOnlyAt000Info = inspectLatestTurnInSteps([
      { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T12:00:00Z", content: buildManualKeepaliveMessage("zh") },
      { step_index: 2, type: "PLANNER_RESPONSE", input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
    ]);
    assert.equal(
      isKeepaliveTurnFlushedForRound(secOnlyAt000Info, {
        usedCount: 0,
        lastIdleAnchorTs: 0,
        lastSentTs: sentExact000,
        lastDispatchMode: "manual"
      }),
      false,
      "Second-only 12:00:00Z at exact .000 lastSentTs with lastIdleAnchorTs=0 must stay pending"
    );
    assert.equal(
      isKeepaliveTurnFlushedForRound(secOnlyAt000Info, {
        usedCount: 0,
        lastIdleAnchorTs: anchorEarlier,
        lastSentTs: sentExact000,
        lastDispatchMode: "manual"
      }),
      false,
      "Second-only 12:00:00Z at exact .000 lastSentTs with earlier lastIdleAnchorTs must also stay pending"
    );

    // 15g. Abandoned earlier auto 1/3 prompt before nearest manual mixed-precision turn must NOT poison manual mode/round
    const abandonedAutoBeforeManual = inspectLatestTurnInSteps([
      { step_index: 1, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T11:55:00.000Z", content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
      { step_index: 2, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T12:00:00Z", content: buildManualKeepaliveMessage("zh") },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:01.200Z",
        input_tokens: 80_100,
        cache_read_tokens: 0,
        output_tokens: 3,
        content: "OK"
      }
    ]);
    assert.equal(abandonedAutoBeforeManual.keepaliveMode, "manual");
    assert.equal(abandonedAutoBeforeManual.keepaliveRound, null);
    assert.equal(
      isKeepaliveTurnFlushedForRound(abandonedAutoBeforeManual, {
        usedCount: 0,
        lastIdleAnchorTs: anchorMs,
        lastSentTs: sentMs,
        lastDispatchId: "ka_r2_manual_after_abandoned",
        lastDispatchMode: "manual"
      }),
      true,
      "Nearest manual mixed-precision turn must verify despite an earlier unanswered auto 1/3 prompt"
    );

    // 15h. End-to-end Layer-1 (Stop) AND Layer-2 (/api/cache-diag) for BOTH mixed-precision positive case and .350 anti-case
    const txL1Mixed = path.join(tmpDir, "tx-l1-mixed.jsonl");
    fs.writeFileSync(txL1Mixed, mixedManualSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    writeWatchdogLease(store, {
      conversationId: "conv-r2-l1-mixed",
      rootSessionId: "conv-r2-l1-mixed",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: sentMs + 50,
      lastLlmStartTs: sentMs + 50,
      updatedTs: sentMs + 50,
      transcriptPath: txL1Mixed,
      contextTokens: 80_100
    });
    store.setTtlKeepaliveState("conv-r2-l1-mixed", {
      usedCount: 0,
      lastIdleAnchorTs: anchorMs,
      lastSentTs: sentMs,
      lastAttemptTs: sentMs,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_r2_l1_mixed",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-r2-l1-mixed", transcriptPath: txL1Mixed, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: sentMs + 1_500 }
    );
    const kaL1Mixed = store.getTtlKeepaliveState("conv-r2-l1-mixed");
    assert.equal(kaL1Mixed.coldMissTripped, true, "Layer-1 Stop must trip breaker on mixed-precision 12:00:00Z + 12:00:01.200Z cold read");
    assert.equal(kaL1Mixed.pendingColdCheckId, "");

    writeWatchdogLease(store, {
      conversationId: "conv-r2-l1-earlier",
      rootSessionId: "conv-r2-l1-earlier",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      startedTs: sentMs + 50,
      lastLlmStartTs: sentMs + 50,
      updatedTs: sentMs + 50,
      transcriptPath: txEarlier,
      contextTokens: 80_100
    });
    store.setTtlKeepaliveState("conv-r2-l1-earlier", {
      usedCount: 0,
      lastIdleAnchorTs: anchorMs,
      lastSentTs: sentMs,
      lastAttemptTs: sentMs,
      pendingAck: false,
      inKeepaliveTurn: true,
      lastDispatchId: "ka_r2_l1_earlier",
      lastDispatchMode: "manual",
      coldMissTripped: false
    });
    await handleStopPayload(
      { conversationId: "conv-r2-l1-earlier", transcriptPath: txEarlier, terminationReason: "NO_TOOL_CALL" },
      { store, nowMs: sentMs + 1_500 }
    );
    const kaL1Earlier = store.getTtlKeepaliveState("conv-r2-l1-earlier");
    assert.equal(kaL1Earlier.coldMissTripped, false, "Layer-1 Stop must NOT trip breaker on exact .350 < .550/.800 cold read");
    assert.equal(kaL1Earlier.pendingColdCheckId, "ka_r2_l1_earlier");

    // Layer-2 (/api/cache-diag) for both mixed-precision positive case and .350 anti-case
    const convL2Mixed = "conv-r2-l2-mixed";
    const convL2Earlier = "conv-r2-l2-earlier";
    const txL2Mixed = path.join(tmpDir, `${convL2Mixed}.jsonl`);
    const txL2Earlier = path.join(tmpDir, `${convL2Earlier}.jsonl`);
    fs.writeFileSync(txL2Mixed, mixedManualSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    fs.writeFileSync(txL2Earlier, exactEarlierSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    seedStoppedLease(store, convL2Mixed, { cacheOriginTs: anchorMs - 10_000, idleAnchorTs: anchorMs, transcriptPath: txL2Mixed });
    seedStoppedLease(store, convL2Earlier, { cacheOriginTs: anchorMs - 10_000, idleAnchorTs: anchorMs, transcriptPath: txL2Earlier });
    store.setTtlKeepaliveState(convL2Mixed, {
      usedCount: 0,
      lastIdleAnchorTs: anchorMs,
      lastSentTs: sentMs,
      lastAttemptTs: sentMs,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_r2_l2_mixed",
      lastDispatchMode: "manual",
      pendingColdCheckId: "ka_r2_l2_mixed",
      coldMissTripped: false
    });
    store.setTtlKeepaliveState(convL2Earlier, {
      usedCount: 0,
      lastIdleAnchorTs: anchorMs,
      lastSentTs: sentMs,
      lastAttemptTs: sentMs,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_r2_l2_earlier",
      lastDispatchMode: "manual",
      pendingColdCheckId: "ka_r2_l2_earlier",
      coldMissTripped: false
    });
    process.env.AGY_DART_DB_PATH = dbPath;
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    resetConfigCache();
    closeRuntimeStore();
    srv = createStandaloneServer({
      watchdogOptions: {
        nowFn: () => sentMs + 5_000,
        getAppStartTime: () => 0
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const htmlRes = await httpJsonRequest(port, "/", { method: "GET" });
    const csrfToken = htmlRes.raw.match(/name="agy-dart-token"\s+content="([a-f0-9]+)"/i)[1];
    const authHeaders = {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin"
    };
    const l2EarlierRes = await httpJsonRequest(port, "/api/cache-diag", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convL2Earlier }
    });
    assert.equal(l2EarlierRes.status, 200);
    assert.equal(l2EarlierRes.json.transcriptFound, true, "Layer-2 must load convL2Earlier transcript");
    assert.equal(l2EarlierRes.json.ttlKeepalive.coldMissTripped, false, "Layer-2 must NOT trip on exact .350 < .550/.800");
    assert.equal(store.getTtlKeepaliveState(convL2Earlier).pendingColdCheckId, "ka_r2_l2_earlier");

    const l2MixedRes = await httpJsonRequest(port, "/api/cache-diag", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convL2Mixed }
    });
    assert.equal(l2MixedRes.status, 200);
    assert.equal(l2MixedRes.json.transcriptFound, true, "Layer-2 must load convL2Mixed transcript");
    assert.equal(l2MixedRes.json.ttlKeepalive.coldMissTripped, true, "Layer-2 MUST trip on mixed-precision 12:00:00Z + 12:00:01.200Z cold read");
    assert.equal(store.getTtlKeepaliveState(convL2Mixed).pendingColdCheckId, "");
  } finally {
    if (srv) {
      await new Promise((r) => srv.close(r));
    }
    store.close();
    stopWatchdogMonitor();
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-16 (R2 P1-3): Rollback splits lastSentTs and lastAttemptTs — immediate retry hits cooldown, prior round late cache_read=0 still trips breaker, and cleanup semantics preserve/zero lastAttemptTs", async () => {
  const { tmpDir, dbPath, cfgPath } = makeTempEnv("agy-v174-r2-rollback-cooldown-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const clock = makeControlledClock(1_826_000_000_000);
    const t1 = clock.now();
    const t2 = t1 + 30_000;
    const convId = "conv-r2-rollback-split";
    const txPath = path.join(tmpDir, "tx-r2-rollback-split.jsonl");

    // Initially disk only has Turn 0 (Round 1 keepalive response has NOT flushed yet!)
    fs.writeFileSync(
      txPath,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(t1 - 60_000).toISOString(), content: "初始任务" },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(t1 - 59_000).toISOString(), input_tokens: 80_000, cache_read_tokens: 70_000, output_tokens: 30 }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );

    // Seed idle lease for Round 2 trigger at t2 (still 100s left on TTL=300)
    seedStoppedLease(store, convId, {
      cacheOriginTs: t2 - 200_000,
      idleAnchorTs: t2 - 5_000,
      transcriptPath: txPath
    });
    // Round 1 was previously dispatched at t1 and is still pending delayed cold check
    store.setTtlKeepaliveState(convId, {
      enabled: true,
      maxCount: 3,
      usedCount: 0,
      lastIdleAnchorTs: t1 - 1_000,
      lastSentTs: t1,
      lastAttemptTs: t1,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_r1_pending_cold",
      lastDispatchMode: "manual",
      pendingColdCheckId: "ka_r1_pending_cold",
      coldMissTripped: false,
      updatedTs: t1
    });

    const sent = [];
    let shouldFail = true;
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({
        stallWatchdog: true,
        ttlKeepalive: true,
        ttlKeepaliveMaxCount: 3,
        ttlKeepaliveLeadSec: 60,
        ttlKeepaliveMinRemainSec: 15
      }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        if (shouldFail) return { ok: false, error: "rpc_dispatch_failed" };
        return { ok: true };
      }
    });

    // Step 1: Round 2 manual dispatch at t2 FAILS and rolls back
    clock.set(t2);
    const r2Claim = mon.triggerManualKeepalive(convId);
    assert.equal(r2Claim.dispatched, true);
    await flushMicrotasks();
    assert.equal(sent.length, 1);

    const afterRollback = store.getTtlKeepaliveState(convId);
    assert.equal(afterRollback.pendingAck, false);
    assert.equal(afterRollback.lastDispatchId, "ka_r1_pending_cold");
    assert.equal(afterRollback.pendingColdCheckId, "ka_r1_pending_cold");
    assert.equal(afterRollback.lastSentTs, t1, "Rollback MUST restore prior unverified round's lastSentTs");
    assert.equal(afterRollback.lastAttemptTs, t2, "Rollback MUST preserve failed attempt timestamp in lastAttemptTs");
    assert.equal(afterRollback.lastError, "rpc_dispatch_failed");

    // Step 2: Immediate retry at t2 + 2s (before Round 1 flushes) MUST be blocked by cooldown (manual AND auto)
    clock.set(t2 + 2_000);
    const immediateRetry = mon.triggerManualKeepalive(convId);
    assert.equal(immediateRetry.dispatched, false);
    assert.equal(immediateRetry.skippedReason, "cooldown", "Immediate manual retry after rollback must hit cooldown");
    assert.equal(sent.length, 1);

    // Also verify auto keepalive tick respects lastAttemptTs cooldown (set cacheOriginTs so remSec=40s inside trigger window)
    seedStoppedLease(store, convId, {
      cacheOriginTs: t2 + 2_000 - 260_000,
      idleAnchorTs: t2 - 5_000,
      transcriptPath: txPath
    });
    mon.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 1, "Auto keepalive tick must also respect lastAttemptTs 25s cooldown");

    // Step 3: Round 1's late cache_read=0 flushes to disk with timestamp t1 + 1.2s (< t2!) -> MUST trigger coldMissTripped!
    fs.appendFileSync(
      txPath,
      [
        { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(t1 + 200).toISOString(), content: buildManualKeepaliveMessage("zh") },
        {
          step_index: 4,
          type: "PLANNER_RESPONSE",
          created_at: new Date(t1 + 1_200).toISOString(),
          input_tokens: 80_100,
          cache_read_tokens: 0,
          output_tokens: 3,
          content: "OK"
        }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    clock.set(t2 + 3_000);
    const delayedRes = mon._runDelayedColdMissCheck(
      store,
      convId,
      readWatchdogLease(store, convId),
      store.getTtlKeepaliveState(convId),
      clock.now()
    );
    assert.equal(delayedRes.checked, true, "Delayed check must verify prior round using restored lastSentTs");
    assert.equal(delayedRes.coldTripped, true, "Prior round's late cache_read=0 must trip coldMissTripped");

    const trippedState = store.getTtlKeepaliveState(convId);
    assert.equal(trippedState.coldMissTripped, true);
    assert.equal(trippedState.pendingColdCheckId, "");
    assert.equal(trippedState.lastColdCheckedId, "ka_r1_pending_cold");

    // Even after cooldown expires, cold_miss_tripped keeps blocking further sends
    shouldFail = false;
    clock.set(t2 + 30_000);
    const afterCooldown = mon.triggerManualKeepalive(convId);
    assert.equal(afterCooldown.dispatched, false);
    assert.equal(afterCooldown.skippedReason, "cold_miss_tripped");
    assert.equal(sent.length, 1);

    // Step 3b: Auto-keepalive claim failure rollback ALSO restores prevLastSentTs & sets lastAttemptTs
    const convAutoRb = "conv-r2-auto-rollback-split";
    const txAutoRb = path.join(tmpDir, "tx-r2-auto-rollback-split.jsonl");
    const tA1 = clock.now() + 100_000;
    const tA2 = tA1 + 30_000;
    fs.writeFileSync(
      txAutoRb,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tA1 - 60_000).toISOString(), content: "自动续温回滚" },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tA1 - 59_000).toISOString(), input_tokens: 80_000, cache_read_tokens: 70_000, output_tokens: 30 }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    seedStoppedLease(store, convAutoRb, {
      cacheOriginTs: tA2 - 260_000, // remSec = 40s (inside 60s trigger window, > 15s minRemain)
      idleAnchorTs: tA2 - 5_000,
      transcriptPath: txAutoRb
    });
    store.setTtlKeepaliveState(convAutoRb, {
      enabled: true,
      maxCount: 3,
      usedCount: 1,
      lastIdleAnchorTs: tA1 - 1_000,
      lastSentTs: tA1,
      lastAttemptTs: tA1,
      pendingAck: false,
      inKeepaliveTurn: false,
      lastDispatchId: "ka_auto_r1_unverified",
      lastDispatchMode: "auto",
      pendingColdCheckId: "ka_auto_r1_unverified",
      lastColdCheckUsed: 0,
      coldMissTripped: false,
      updatedTs: tA1
    });
    shouldFail = true;
    const sentBeforeAutoRb = sent.length;
    clock.set(tA2);
    mon.tick();
    await flushMicrotasks();
    assert.equal(sent.length, sentBeforeAutoRb + 1);
    const autoAfterRb = store.getTtlKeepaliveState(convAutoRb);
    assert.equal(autoAfterRb.usedCount, 1, "Auto rollback must restore usedCount");
    assert.equal(autoAfterRb.lastSentTs, tA1, "Auto rollback must restore prior round's lastSentTs");
    assert.equal(autoAfterRb.lastAttemptTs, tA2, "Auto rollback must preserve failed attempt timestamp in lastAttemptTs");
    assert.equal(autoAfterRb.pendingColdCheckId, "ka_auto_r1_unverified");

    // Immediate auto retry at tA2 + 2s is blocked by lastAttemptTs 25s cooldown
    clock.set(tA2 + 2_000);
    mon.tick();
    await flushMicrotasks();
    assert.equal(sent.length, sentBeforeAutoRb + 1, "Immediate auto retry after rollback must be blocked by cooldown");

    // Prior auto round 1/3 late cache_read=0 flushes -> next tick trips coldMissTripped even during cooldown!
    fs.appendFileSync(
      txAutoRb,
      [
        { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(tA1 + 100).toISOString(), content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
        { step_index: 4, type: "PLANNER_RESPONSE", created_at: new Date(tA1 + 900).toISOString(), input_tokens: 80_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    clock.set(tA2 + 3_000);
    mon.tick();
    await flushMicrotasks();
    assert.equal(
      store.getTtlKeepaliveState(convAutoRb).coldMissTripped,
      true,
      "Auto round 1 late cache_read=0 must trip coldMissTripped after round 2 rollback"
    );
    assert.equal(sent.length, sentBeforeAutoRb + 1);

    // Step 4: Cleanup semantics for lastAttemptTs (clearTtlKeepaliveOverride & pruneByTtl)
    const nowReal = Date.now();
    // 4a. Valid active state with ONLY lastAttemptTs > 0 must be preserved on clearTtlKeepaliveOverride and fresh pruneByTtl
    store.setTtlKeepaliveState("conv-r2-active-attempt", {
      enabled: true,
      maxCount: 2,
      usedCount: 0,
      lastIdleAnchorTs: 0,
      lastSentTs: 0,
      lastAttemptTs: nowReal - 2_000,
      updatedTs: nowReal - 2_000
    });
    const afterClearOverride = store.clearTtlKeepaliveOverride("conv-r2-active-attempt", nowReal);
    assert.equal(afterClearOverride.enabled, null);
    assert.equal(afterClearOverride.maxCount, null);
    assert.equal(
      afterClearOverride.lastAttemptTs,
      nowReal - 2_000,
      "clearTtlKeepaliveOverride must retain valid lastAttemptTs state"
    );
    assert.ok(store.getMeta("cache:ttl_keepalive_state:conv-r2-active-attempt", null));

    store.pruneByTtl({ maxAgeDays: 14, vacuum: false });
    assert.equal(
      store.getTtlKeepaliveState("conv-r2-active-attempt").lastAttemptTs,
      nowReal - 2_000,
      "pruneByTtl must preserve non-expired lastAttemptTs"
    );

    // 4b. Expired runtime state (> 14d) with explicit override (even if ONLY lastAttemptTs > 0) must zero lastAttemptTs while keeping override
    const staleTs = nowReal - 15 * 24 * 3600 * 1000;
    store.setTtlKeepaliveState("conv-r2-stale-override", {
      enabled: true,
      maxCount: 4,
      usedCount: 0,
      lastIdleAnchorTs: 0,
      lastSentTs: 0,
      lastAttemptTs: staleTs,
      updatedTs: staleTs
    });
    store.setTtlKeepaliveState("conv-r2-stale-no-override", {
      enabled: null,
      maxCount: null,
      usedCount: 0,
      lastIdleAnchorTs: 0,
      lastSentTs: 0,
      lastAttemptTs: staleTs,
      updatedTs: staleTs
    });
    store.pruneByTtl({ maxAgeDays: 14, vacuum: false });
    const prunedOverride = store.getTtlKeepaliveState("conv-r2-stale-override");
    assert.equal(prunedOverride.enabled, true, "pruneByTtl must keep explicit enabled override");
    assert.equal(prunedOverride.maxCount, 4, "pruneByTtl must keep explicit maxCount override");
    assert.equal(prunedOverride.lastAttemptTs, 0, "pruneByTtl must zero expired lastAttemptTs when resetting runtime state");
    const rawPruned = JSON.parse(store.getMeta("cache:ttl_keepalive_state:conv-r2-stale-override", "{}"));
    assert.equal(rawPruned.lastAttemptTs, 0, "Persisted JSON after pruneByTtl must explicitly store lastAttemptTs: 0");
    assert.equal(
      store.getMeta("cache:ttl_keepalive_state:conv-r2-stale-no-override", null),
      null,
      "Expired row without explicit override must be deleted by pruneByTtl"
    );

    // Step 5: Real spawned PreInvocation on genuine user turn resets rollback-only lastAttemptTs > 0 & lastError
    const convPreReset = "conv-r2-preinv-attempt-reset";
    seedStoppedLease(store, convPreReset, { cacheOriginTs: nowReal - 20_000, idleAnchorTs: nowReal - 5_000 });
    store.setTtlKeepaliveState(convPreReset, {
      enabled: true,
      maxCount: 2,
      usedCount: 0,
      lastIdleAnchorTs: 0,
      lastSentTs: 0,
      lastAttemptTs: nowReal - 2_000,
      lastError: "rpc_first_attempt_failed",
      updatedTs: nowReal - 2_000
    });
    const preRun = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: convPreReset,
        invocationNum: 0,
        lastUserInput: "继续修复并跑回归测试"
      }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });
    assert.equal(preRun.status, 0, `Spawned pre-invocation.mjs failed: ${preRun.stderr}`);
    const afterPreReset = store.getTtlKeepaliveState(convPreReset);
    assert.equal(afterPreReset.enabled, true, "PreInvocation reset must preserve explicit enabled override");
    assert.equal(afterPreReset.maxCount, 2, "PreInvocation reset must preserve explicit maxCount override");
    assert.equal(afterPreReset.lastAttemptTs, 0, "Real PreInvocation genuine user turn must reset lastAttemptTs to 0");
    assert.equal(afterPreReset.lastError, "", "Real PreInvocation genuine user turn must clear lastError");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-17 (R2 P2-4): Narrow-margin skip vs concurrent manual claim on BOTH paths (16s->15s lock wait AND initial 15s read) yields 0 auto sends, 0 narrow skips, 0 reminders & 0 narrow-skip DB writes", async () => {
  const { tmpDir, dbPath } = makeTempEnv("agy-v174-r2-narrow-race-");
  const store = new ContextModeStore({ dbPath });
  store.open();

  try {
    const clock = makeControlledClock(1_827_000_000_000);
    const t0 = clock.now();
    const cfg = {
      stallWatchdog: true,
      ttlDesktopNotify: true,
      ttlNotifyLeadSec: 60,
      ttlNotifyMinTokens: 20_000,
      ttlKeepalive: true,
      ttlKeepaliveMaxCount: 2,
      ttlKeepaliveLeadSec: 60,
      ttlKeepaliveMinRemainSec: 15,
      ttlKeepaliveMinContextPct: 15
    };
    const origWriteTx = store._withWriteTx.bind(store);
    const origGetKa = store.getTtlKeepaliveState.bind(store);

    // 17a. Path A: Auto tick reads remSec=16s, waits on write lock while Window B claims manual keepalive & clock ticks 16s -> 15s
    const convA = "conv-r2-race-16to15";
    seedStoppedLease(store, convA, { cacheOriginTs: t0, idleAnchorTs: t0 + 20_000, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convA);

    const autoSentA = [];
    const manualSentA = [];
    const notificationsA = [];
    const monManualA = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        manualSentA.push(p);
        return { ok: true };
      }
    });
    const monAutoA = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        autoSentA.push(p);
        return { ok: true };
      },
      notifyFn: (n) => {
        notificationsA.push(n);
        return { ok: true };
      }
    });

    clock.set(t0 + 284_000); // remSec = 16s (> 15s)
    let injectedA = false;
    store._withWriteTx = (fn) => {
      if (!injectedA) {
        injectedA = true;
        store._withWriteTx = origWriteTx;
        clock.set(t0 + 285_000); // remSec ticks 16s -> 15s during lock wait!
        const mRes = monManualA.triggerManualKeepalive(convA);
        assert.equal(mRes.dispatched, true, "Window B manual claim must succeed during lock wait");
      }
      return origWriteTx(fn);
    };
    monAutoA.tick();
    await flushMicrotasks();
    store._withWriteTx = origWriteTx;

    assert.equal(injectedA, true);
    assert.equal(manualSentA.length, 1);
    assert.equal(autoSentA.length, 0, "16s->15s race: must have 0 auto sends");
    assert.equal(monAutoA.ttlKeepaliveNarrowSkippedCount, 0, "16s->15s race: must have 0 narrow skips");
    assert.equal(
      monAutoA.getStatus({ conversationId: convA, refresh: false }).ttlKeepalive.narrowMarginSkipped,
      false
    );
    assert.equal(notificationsA.length, 0, "16s->15s race: must have 0 desktop reminders");
    assert.equal(store.getMeta(`cache_alert:${convA}:ttl_desktop`, null), null);
    store.deleteMeta(`watchdog_lease:${convA}`);

    // 17b. Path B (Amendment 4): Initial read ALREADY has remSec=15s; Window B completes manual claim right after initial read
    const tB = t0 + 500_000;
    const convB = "conv-r2-race-init15";
    seedStoppedLease(store, convB, { cacheOriginTs: tB, idleAnchorTs: tB + 20_000, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convB);

    const autoSentB = [];
    const manualSentB = [];
    const notificationsB = [];
    const monManualB = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        manualSentB.push(p);
        return { ok: true };
      }
    });
    const monAutoB = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        autoSentB.push(p);
        return { ok: true };
      },
      notifyFn: (n) => {
        notificationsB.push(n);
        return { ok: true };
      }
    });

    clock.set(tB + 285_000); // Initial read ALREADY sees remSec = 15s <= 15s!
    let injectedB = false;
    store.getTtlKeepaliveState = (cid, ...rest) => {
      const res = origGetKa(cid, ...rest);
      if (!injectedB && cid === convB) {
        injectedB = true;
        store.getTtlKeepaliveState = origGetKa;
        // Another window completes manual claim immediately after auto's initial read!
        const mRes = monManualB.triggerManualKeepalive(convB);
        assert.equal(mRes.dispatched, true, "Window B manual claim must succeed right after initial 15s read");
      }
      return res;
    };
    monAutoB.tick();
    await flushMicrotasks();
    store.getTtlKeepaliveState = origGetKa;

    assert.equal(injectedB, true);
    assert.equal(manualSentB.length, 1);
    assert.equal(autoSentB.length, 0, "Initial-15s race: must have 0 auto sends");
    assert.equal(monAutoB.ttlKeepaliveNarrowSkippedCount, 0, "Initial-15s race: must have 0 narrow skips");
    assert.equal(
      monAutoB.getStatus({ conversationId: convB, refresh: false }).ttlKeepalive.narrowMarginSkipped,
      false
    );
    assert.equal(notificationsB.length, 0, "Initial-15s race: must have 0 desktop reminders");
    assert.equal(store.getMeta(`cache_alert:${convB}:ttl_desktop`, null), null);
    store.deleteMeta(`watchdog_lease:${convB}`);

    // 17c. Zero-write-to-disk verification: genuine narrow-margin skip at initial remSec=15s writes 0 DB rows & 0 WAL bytes
    const tC = tB + 500_000;
    const convC = "conv-r2-narrow-zero-disk";
    seedStoppedLease(store, convC, { cacheOriginTs: tC, idleAnchorTs: tC + 20_000, contextTokens: 90_000 });
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

    const walPath = `${dbPath}-wal`;
    const walBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const dvBefore = store.db.prepare("PRAGMA data_version").get().data_version;
    const metaBefore = store.getMeta(`cache:ttl_keepalive_state:${convC}`, null);
    let setKaCalls = 0;
    let setMetaCalls = 0;
    const origSetKa = store.setTtlKeepaliveState.bind(store);
    const origSetMeta = store.setMeta.bind(store);
    store.setTtlKeepaliveState = (...args) => {
      setKaCalls += 1;
      return origSetKa(...args);
    };
    store.setMeta = (...args) => {
      setMetaCalls += 1;
      return origSetMeta(...args);
    };

    const autoSentC = [];
    const monAutoC = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ...cfg, ttlDesktopNotify: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        autoSentC.push(p);
        return { ok: true };
      }
    });
    clock.set(tC + 285_000); // remSec = 15s, no concurrent manual claim
    monAutoC.tick();
    await flushMicrotasks();

    store.setTtlKeepaliveState = origSetKa;
    store.setMeta = origSetMeta;

    const walAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const dvAfter = store.db.prepare("PRAGMA data_version").get().data_version;
    assert.equal(autoSentC.length, 0);
    assert.equal(monAutoC.ttlKeepaliveNarrowSkippedCount, 1);
    assert.equal(
      monAutoC.getStatus({ conversationId: convC, refresh: false }).ttlKeepalive.narrowMarginSkipped,
      true
    );
    assert.equal(setKaCalls, 0, "Genuine narrow-margin skip must make 0 setTtlKeepaliveState writes");
    assert.equal(setMetaCalls, 0, "Genuine narrow-margin skip must make 0 setMeta writes");
    assert.equal(store.getMeta(`cache:ttl_keepalive_state:${convC}`, null), metaBefore);
    assert.equal(walAfter, walBefore, "Genuine narrow-margin skip must write 0 bytes to SQLite WAL");
    assert.equal(dvAfter, dvBefore, "Genuine narrow-margin skip must not advance SQLite data_version");
    store.deleteMeta(`watchdog_lease:${convC}`);

    // 17d. Concurrent toggle-off AND concurrent maxCount downgrade during remSec=15s lock wait -> 0 narrow skips, 0 sends
    const tD = tC + 500_000;
    const convD1 = "conv-r2-disable-during-lock";
    const convD2 = "conv-r2-maxcount-during-lock";
    seedStoppedLease(store, convD1, { cacheOriginTs: tD, idleAnchorTs: tD + 20_000, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convD1);
    clock.set(tD + 285_000); // remSec = 15s
    const monD1 = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ...cfg, ttlDesktopNotify: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true })
    });
    let injD1 = false;
    store._withWriteTx = (fn) => {
      if (!injD1) {
        injD1 = true;
        store._withWriteTx = origWriteTx;
        store.setTtlKeepaliveEnabled(false, convD1);
      }
      return origWriteTx(fn);
    };
    monD1.tick();
    store._withWriteTx = origWriteTx;
    assert.equal(injD1, true);
    assert.equal(monD1.ttlKeepaliveNarrowSkippedCount, 0, "Disabling keepalive during 15s lock wait must produce 0 narrow skips");
    assert.equal(monD1.getStatus({ conversationId: convD1, refresh: false }).ttlKeepalive.narrowMarginSkipped, false);
    store.deleteMeta(`watchdog_lease:${convD1}`);

    seedStoppedLease(store, convD2, { cacheOriginTs: tD, idleAnchorTs: tD + 20_000, contextTokens: 90_000 });
    store.setTtlKeepaliveState(convD2, {
      enabled: true,
      maxCount: 2,
      usedCount: 1,
      lastIdleAnchorTs: tD - 100_000,
      lastSentTs: tD - 100_000,
      lastColdCheckUsed: 1
    });
    const monD2 = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ...cfg, ttlDesktopNotify: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true })
    });
    let injD2 = false;
    store._withWriteTx = (fn) => {
      if (!injD2) {
        injD2 = true;
        store._withWriteTx = origWriteTx;
        store.setTtlKeepaliveMaxCount(1, convD2);
      }
      return origWriteTx(fn);
    };
    monD2.tick();
    store._withWriteTx = origWriteTx;
    assert.equal(injD2, true);
    assert.equal(monD2.ttlKeepaliveNarrowSkippedCount, 0, "Lowering maxCount to usedCount during 15s lock wait must produce 0 narrow skips");
    store.deleteMeta(`watchdog_lease:${convD2}`);

    // 17e. Genuine narrow-skip immediately clears on manual warm (same & cross-monitor getStatus),
    //      and manual claim right before claimTtlPopup suppresses desktop reminder & alert DB write
    const tE = tD + 500_000;
    const convE1 = "conv-r2-skip-then-manual";
    seedStoppedLease(store, convE1, { cacheOriginTs: tE, idleAnchorTs: tE + 20_000, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convE1);
    clock.set(tE + 285_000);
    const monE1 = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ...cfg, ttlDesktopNotify: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true })
    });
    const monE1Peer = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ...cfg, ttlDesktopNotify: false }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true })
    });
    monE1.tick();
    monE1Peer.tick();
    assert.equal(monE1.getStatus({ conversationId: convE1, refresh: false }).ttlKeepalive.narrowMarginSkipped, true);
    assert.equal(monE1Peer.getStatus({ conversationId: convE1, refresh: false }).ttlKeepalive.narrowMarginSkipped, true);
    clock.set(tE + 288_000);
    const mE1 = monE1.triggerManualKeepalive(convE1);
    assert.equal(mE1.dispatched, true);
    assert.equal(monE1.getStatus({ conversationId: convE1, refresh: false }).ttlKeepalive.narrowMarginSkipped, false);
    assert.equal(
      monE1Peer.getStatus({ conversationId: convE1, refresh: false }).ttlKeepalive.narrowMarginSkipped,
      false,
      "Cross-monitor getStatus({refresh:false}) must immediately suppress stale narrowMarginSkipped once manual claim is persisted"
    );
    await flushMicrotasks();
    store.deleteMeta(`watchdog_lease:${convE1}`);

    const convE2 = "conv-r2-manual-before-popup-tx";
    seedStoppedLease(store, convE2, { cacheOriginTs: tE, idleAnchorTs: tE + 20_000, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convE2);
    clock.set(tE + 285_000);
    const notifsE2 = [];
    const monManualE2 = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true })
    });
    const monAutoE2 = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true }),
      notifyFn: (n) => {
        notifsE2.push(n);
        return { ok: true };
      }
    });
    let txStepE2 = 0;
    store._withWriteTx = (fn) => {
      txStepE2 += 1;
      if (txStepE2 === 2) {
        store._withWriteTx = origWriteTx;
        const mRes = monManualE2.triggerManualKeepalive(convE2);
        assert.equal(mRes.dispatched, true);
      }
      return origWriteTx(fn);
    };
    monAutoE2.tick();
    await flushMicrotasks();
    store._withWriteTx = origWriteTx;
    assert.equal(txStepE2, 2);
    assert.equal(notifsE2.length, 0, "Manual claim right before claimTtlPopup must suppress desktop reminder");
    assert.equal(store.getMeta(`cache_alert:${convE2}:ttl_desktop`, null), null);
    store.deleteMeta(`watchdog_lease:${convE2}`);

    // 17f. REAL two-process OS SQLite BEGIN IMMEDIATE lock contention for BOTH initial 15s AND 16s->15s drift
    const peerClaimScript = `
      import { DatabaseSync } from "node:sqlite";
      const [dbPath, convId, anchorStr, holdMsStr] = process.argv.slice(1);
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000");
      process.stdout.write("READY\\n");
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        if (chunk.includes("CLAIM")) {
          db.exec("BEGIN IMMEDIATE");
          process.stdout.write("LOCKED\\n");
          const holdMs = Number(holdMsStr) || 400;
          const sab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sab, 0, 0, holdMs);
          const nowMs = Date.now();
          const payload = JSON.stringify({
            enabled: true,
            maxCount: 2,
            usedCount: 0,
            lastIdleAnchorTs: Number(anchorStr),
            lastSentTs: nowMs,
            lastAttemptTs: nowMs,
            pendingAck: true,
            coldMissTripped: false,
            inKeepaliveTurn: false,
            lastColdCheckUsed: 0,
            lastDispatchId: "ka_peer_proc_manual",
            lastDispatchMode: "manual",
            pendingColdCheckId: "",
            lastColdCheckedId: "",
            lastError: "",
            updatedTs: nowMs
          });
          db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run("cache:ttl_keepalive_state:" + convId, payload);
          db.exec("COMMIT");
          db.close();
          process.exit(0);
        }
      });
    `;
    const runRealTwoProcRace = async (convId, initialRemMs, holdMs) => {
      const realNow = Date.now();
      const cacheOrigin = realNow - (300_000 - initialRemMs);
      const idleAnchor = cacheOrigin + 20_000;
      seedStoppedLease(store, convId, { cacheOriginTs: cacheOrigin, idleAnchorTs: idleAnchor, contextTokens: 90_000 });
      store.setTtlKeepaliveEnabled(true, convId);
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", peerClaimScript, dbPath, convId, String(idleAnchor), String(holdMs)],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
      const waitTok = (tok) =>
        new Promise((resolve, reject) => {
          let buf = "";
          const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${tok}`)), 10_000);
          const onData = (d) => {
            buf += d.toString("utf8");
            if (buf.includes(tok)) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve();
            }
          };
          child.stdout.on("data", onData);
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (!buf.includes(tok)) reject(new Error(`Peer process exited early (${code})`));
          });
        });
      try {
        await waitTok("READY");
        child.stdin.write("CLAIM\n");
        await waitTok("LOCKED");
        const procAutoSent = [];
        const procNotifs = [];
        const monProc = new WatchdogMonitor({
          getStore: () => store,
          getConfig: () => cfg,
          keepaliveSendFn: async (p) => {
            procAutoSent.push(p);
            return { ok: true };
          },
          notifyFn: (n) => {
            procNotifs.push(n);
            return { ok: true };
          }
        });
        const tickStart = Date.now();
        monProc.tick();
        const elapsedMs = Date.now() - tickStart;
        await flushMicrotasks();
        assert.ok(elapsedMs >= Math.floor(holdMs * 0.5), `${convId}: expected real SQLite lock wait, got ${elapsedMs}ms`);
        assert.equal(procAutoSent.length, 0, `${convId}: 2-process race must produce 0 auto sends`);
        assert.equal(monProc.ttlKeepaliveNarrowSkippedCount, 0, `${convId}: 2-process race must produce 0 narrow skips`);
        assert.equal(procNotifs.length, 0, `${convId}: 2-process race must produce 0 desktop reminders`);
        assert.equal(store.getMeta(`cache_alert:${convId}:ttl_desktop`, null), null);
        assert.equal(store.getTtlKeepaliveState(convId).lastDispatchId, "ka_peer_proc_manual");
      } finally {
        try {
          child.kill();
        } catch {}
        store.deleteMeta(`watchdog_lease:${convId}`);
      }
    };
    await runRealTwoProcRace("conv-r2-2proc-init15", 14_800, 450); // initial remSec <= 15s
    await runRealTwoProcRace("conv-r2-2proc-16to15", 16_300, 1_450); // ticks 16s -> <=15s during real SQLite lock wait

    // 17g. R3 P2: Two real SQLite connections — manual keepalive claims cycle & claimTtlPopup hits real `database is locked`
    //      -> 0 auto sends, 0 desktop notifications, 0 persisted alert rows, and next tick after unlock still stays 0.
    const tG = tD + 1_000_000;
    const convG = "conv-r3-popup-locked-manual";
    const idleAnchorG = tG + 20_000;
    seedStoppedLease(store, convG, { cacheOriginTs: tG, idleAnchorTs: idleAnchorG, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convG);

    const storeLockedG = new ContextModeStore({ dbPath, maxBusyRetries: 0, maxRetryDeadlineMs: 1 });
    const storeLockerG = new ContextModeStore({ dbPath });
    storeLockedG.open();
    storeLockerG.open();
    storeLockedG.db.exec("PRAGMA busy_timeout = 0;");
    try {
      const autoSentG = [];
      const manualSentG = [];
      const notifsG = [];
      const monManualG = new WatchdogMonitor({
        getStore: () => storeLockerG,
        getConfig: () => cfg,
        nowFn: clock.now,
        monoNsFn: clock.mono,
        keepaliveSendFn: async (p) => {
          manualSentG.push(p);
          return { ok: true };
        }
      });
      const monAutoG = new WatchdogMonitor({
        getStore: () => storeLockedG,
        getConfig: () => cfg,
        nowFn: clock.now,
        monoNsFn: clock.mono,
        keepaliveSendFn: async (p) => {
          autoSentG.push(p);
          return { ok: true };
        },
        notifyFn: (n) => {
          notifsG.push(n);
          return { ok: true };
        }
      });

      clock.set(tG + 285_000); // remSec = 15s (narrow-margin skip in tx #1)
      const origLockedTxG = storeLockedG._withWriteTx.bind(storeLockedG);
      let txCountG = 0;
      let sawDbLockedG = false;
      let holdingLockG = false;
      storeLockedG._withWriteTx = (fn) => {
        txCountG += 1;
        if (txCountG === 2) {
          // Right before claimTtlPopup: Window B commits manual keepalive AND holds BEGIN IMMEDIATE so claimTtlPopup hits real SQLite lock
          const mRes = monManualG.triggerManualKeepalive(convG);
          assert.equal(mRes.dispatched, true, "Window B manual claim must succeed before claimTtlPopup");
          storeLockerG.db.exec("BEGIN IMMEDIATE;");
          holdingLockG = true;
          try {
            return origLockedTxG(fn);
          } catch (err) {
            if (/database is locked|SQLITE_BUSY/i.test(String(err?.message || err))) {
              sawDbLockedG = true;
            }
            throw err;
          } finally {
            if (holdingLockG) {
              storeLockerG.db.exec("COMMIT;");
              holdingLockG = false;
            }
          }
        }
        return origLockedTxG(fn);
      };
      monAutoG.tick();
      await flushMicrotasks();
      storeLockedG._withWriteTx = origLockedTxG;

      assert.equal(txCountG, 2, "Expected runAtomicClaim (tx #1) then claimTtlPopup (tx #2)");
      assert.equal(sawDbLockedG, true, "claimTtlPopup must encounter real SQLite `database is locked`");
      assert.equal(manualSentG.length, 1);
      assert.equal(autoSentG.length, 0, "Popup lock error after manual claim: 0 auto sends");
      assert.equal(notifsG.length, 0, "Popup lock error must NOT fail-open and fire a desktop notification");
      assert.equal(store.getMeta(`cache_alert:${convG}:ttl_desktop`, null), null);
      assert.equal(monAutoG._ttlNotifiedKeys.has(convG), false, "Failed popup tx must NOT poison _ttlNotifiedKeys");
      assert.equal(monAutoG._lastTtlNotifyGlobalTs, 0, "Failed popup tx must NOT poison _lastTtlNotifyGlobalTs");

      // Next tick after lock clears: manual claim already owns cycle -> still 0 notifications & 0 persisted alerts
      clock.set(tG + 287_000);
      monAutoG.tick();
      await flushMicrotasks();
      assert.equal(autoSentG.length, 0);
      assert.equal(notifsG.length, 0, "Next tick with committed manual claim must still emit 0 notifications");
      assert.equal(store.getMeta(`cache_alert:${convG}:ttl_desktop`, null), null);
    } finally {
      storeLockedG.close();
      storeLockerG.close();
      store.deleteMeta(`watchdog_lease:${convG}`);
    }

    // 17h. R3 P2 retry: Transient real SQLite `database is locked` on claimTtlPopup (no manual claim)
    //      -> 0 notifications on locked tick, clean retry state, then succeeds with 1 notification & persisted dedup on next tick!
    const tH = tG + 500_000;
    const convH = "conv-r3-popup-locked-retry";
    const idleAnchorH = tH + 20_000;
    seedStoppedLease(store, convH, { cacheOriginTs: tH, idleAnchorTs: idleAnchorH, contextTokens: 90_000 });
    store.setTtlKeepaliveEnabled(true, convH);

    const storeLockedH = new ContextModeStore({ dbPath, maxBusyRetries: 0, maxRetryDeadlineMs: 1 });
    const storeLockerH = new ContextModeStore({ dbPath });
    storeLockedH.open();
    storeLockerH.open();
    storeLockedH.db.exec("PRAGMA busy_timeout = 0;");
    try {
      const autoSentH = [];
      const notifsH = [];
      const monAutoH = new WatchdogMonitor({
        getStore: () => storeLockedH,
        getConfig: () => cfg,
        nowFn: clock.now,
        monoNsFn: clock.mono,
        keepaliveSendFn: async (p) => {
          autoSentH.push(p);
          return { ok: true };
        },
        notifyFn: (n) => {
          notifsH.push(n);
          return { ok: true };
        }
      });

      clock.set(tH + 285_000); // remSec = 15s (narrow-margin skip)
      const origLockedTxH = storeLockedH._withWriteTx.bind(storeLockedH);
      let txCountH = 0;
      let sawDbLockedH = false;
      storeLockedH._withWriteTx = (fn) => {
        txCountH += 1;
        if (txCountH === 2) {
          storeLockerH.db.exec("BEGIN IMMEDIATE;");
          try {
            return origLockedTxH(fn);
          } catch (err) {
            if (/database is locked|SQLITE_BUSY/i.test(String(err?.message || err))) {
              sawDbLockedH = true;
            }
            throw err;
          } finally {
            storeLockerH.db.exec("COMMIT;");
          }
        }
        return origLockedTxH(fn);
      };
      monAutoH.tick();
      await flushMicrotasks();
      storeLockedH._withWriteTx = origLockedTxH;

      assert.equal(txCountH, 2);
      assert.equal(sawDbLockedH, true);
      assert.equal(autoSentH.length, 0);
      assert.equal(notifsH.length, 0, "Transient popup lock error must emit 0 notifications");
      assert.equal(store.getMeta(`cache_alert:${convH}:ttl_desktop`, null), null);
      assert.equal(monAutoH._ttlNotifiedKeys.has(convH), false, "Cycle must remain eligible for retry on next tick");
      assert.equal(monAutoH._lastTtlNotifyGlobalTs, 0);

      // Tick #2 (lock cleared, remSec = 13s): retries claimTtlPopup cleanly and emits exactly 1 persisted notification
      clock.set(tH + 287_000);
      monAutoH.tick();
      await flushMicrotasks();
      assert.equal(autoSentH.length, 0);
      assert.equal(notifsH.length, 1, "Same idle cycle must retry and succeed once lock clears");
      assert.equal(
        store.getTimedMeta(`cache_alert:${convH}:ttl_desktop`, ""),
        `${convH}:${idleAnchorH}`,
        "Retry must persist ttl_desktop dedup row"
      );
      assert.equal(monAutoH.ttlKeepaliveNarrowSkippedCount, 1, "Narrow-margin skip count remains deduped at 1");

      // Tick #3 (remSec = 11s): deduped, stays at 1 notification
      clock.set(tH + 289_000);
      monAutoH.tick();
      await flushMicrotasks();
      assert.equal(notifsH.length, 1, "Subsequent ticks after successful retry must stay deduped");
    } finally {
      storeLockedH.close();
      storeLockerH.close();
      store.deleteMeta(`watchdog_lease:${convH}`);
    }

    // 17i. Mock/in-memory store WITHOUT _withWriteTx: throwing during claimTtlPopup fails closed and retries cleanly next tick
    const tI = tH + 500_000;
    const convI = "conv-r3-mock-no-tx";
    const idleAnchorI = tI + 20_000;
    const mockMeta = new Map();
    const mockLease = {
      conversationId: convI,
      rootSessionId: convI,
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      contextTokens: 90_000,
      windowTokens: 200_000,
      cacheTtlSec: 300,
      cacheOriginTs: tI,
      idleAnchorTs: idleAnchorI,
      phaseChangedTs: idleAnchorI,
      updatedTs: idleAnchorI,
      isSubagent: false
    };
    mockMeta.set(`watchdog_lease:${convI}`, JSON.stringify(mockLease));
    let failMockSetTimed = true;
    const mockNoTxStore = {
      listMetaByPrefix(prefix) {
        const out = [];
        for (const [key, value] of mockMeta.entries()) {
          if (key.startsWith(prefix)) out.push({ key, value });
        }
        return out;
      },
      getMeta(key, fallback = null) {
        return mockMeta.has(key) ? mockMeta.get(key) : fallback;
      },
      setMeta(key, value) {
        mockMeta.set(key, String(value));
      },
      getTimedMeta(key, fallback = "") {
        return mockMeta.has(key) ? mockMeta.get(key) : fallback;
      },
      setTimedMeta(key, value) {
        if (failMockSetTimed) throw new Error("database is locked");
        mockMeta.set(key, String(value));
      },
      isTtlKeepaliveEnabled() {
        return true;
      },
      getTtlKeepaliveMaxCount() {
        return 2;
      },
      getTtlKeepaliveState() {
        return {
          enabled: true,
          maxCount: 2,
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
      }
    };
    const mockNotifs = [];
    const monMockI = new WatchdogMonitor({
      getStore: () => mockNoTxStore,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async () => ({ ok: true }),
      notifyFn: (n) => {
        mockNotifs.push(n);
        return { ok: true };
      }
    });
    clock.set(tI + 285_000);
    monMockI.tick();
    await flushMicrotasks();
    assert.equal(mockNotifs.length, 0, "Mock store without _withWriteTx throwing must emit 0 notifications");
    assert.equal(monMockI._ttlNotifiedKeys.has(convI), false);

    failMockSetTimed = false;
    clock.set(tI + 287_000);
    monMockI.tick();
    await flushMicrotasks();
    assert.equal(mockNotifs.length, 1, "Mock store without _withWriteTx must retry and succeed on next tick");
    assert.equal(mockMeta.get(`cache_alert:${convI}:ttl_desktop`), `${convI}:${idleAnchorI}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
