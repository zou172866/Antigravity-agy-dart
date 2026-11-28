import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { WatchdogMonitor, readWatchdogLease, writeWatchdogLease, WATCHDOG_PHASES } from "../context/lib/watchdog.js";
import {
  classifyTranscriptGenesisFile,
  detectSubagentFromTranscriptFile,
  detectSubagentFromTranscriptSteps,
  isSubagentLeasePayload,
  isSummaryMetadataSubagent,
  isTrajectoryMetadataSubagent,
  isTtlKeepalivePrompt,
  lookupConversationSummary
} from "../context/lib/watchdog-lease.js";
import { isSubagentPayload as isSessionStartSubagentPayload } from "../hooks/session-start.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  closeRuntimeStore,
  createStandaloneServer,
  registerSidecarRoutes,
  sendSidecarKeepaliveMessage
} from "../sidecars/dashboard/server.mjs";
import vm from "node:vm";
import { suppressSqliteExperimentalWarning } from "../hooks/compile-cache.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

suppressSqliteExperimentalWarning();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 25));

test("keepalive checks late parent links even for titled leases without a summary row", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-parent-link-"));
  const summaryPath = path.join(dir, "conversation_summaries.db");
  const previous = process.env.AGY_DART_SUMMARY_DB_PATH;
  process.env.AGY_DART_SUMMARY_DB_PATH = summaryPath;
  const db = new DatabaseSync(summaryPath);
  const store = new ContextModeStore({ dbPath: path.join(dir, "context.db") });
  t.after(() => {
    db.close();
    store.close();
    if (previous === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`
    CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT);
    CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT);
    INSERT INTO conversation_summaries VALUES ('parent-chat', 'Main', '[]');
    INSERT INTO conversation_parents VALUES ('parent-chat', 'parent-chat');
  `);
  const now = Date.now();
  const sends = [];
  const parentTranscript = path.join(dir, "parent.jsonl");
  fs.writeFileSync(parentTranscript, [
    { step_index: 0, type: "USER_INPUT", content: "Review the changes" },
    { step_index: 1, type: "PLANNER_RESPONSE", is_subagent: true, tool_calls: [{ name: "finish" }] }
  ].map(step => JSON.stringify(step)).join("\n"));
  const monitor = new WatchdogMonitor({
    getStore: () => store,
    getConfig: () => ({ stallWatchdog: true, ttlKeepalive: true, ttlKeepaliveMaxCount: 3, ttlKeepaliveLeadSec: 30 }),
    nowFn: () => now,
    keepaliveSendFn: async ({ conversationId }) => { sends.push(conversationId); return { ok: true }; }
  });
  for (const id of ["child-chat", "parent-chat"]) {
    writeWatchdogLease(store, {
      conversationId: id, rootSessionId: id, convTitle: "Cached title",
      transcriptPath: id === "parent-chat" ? parentTranscript : "",
      phase: WATCHDOG_PHASES.IDLE, subphase: "stopped", stopReason: "NO_TOOL_CALL",
      contextTokens: 150000, cacheTtlSec: 300, idleAnchorTs: now - 275000, updatedTs: now - 275000
    });
    store.setTtlKeepaliveState(id, { enabled: true });
    assert.equal(monitor._isConversationSubagent(store, id), false);
  }
  db.exec("INSERT INTO conversation_parents VALUES ('child-chat', 'parent-chat')");
  monitor.tick();
  await flushMicrotasks();
  assert.deepEqual(sends, ["parent-chat"]);
  assert.equal(readWatchdogLease(store, "child-chat").parentConversationId, "parent-chat");
  assert.equal(store.getMeta("cache:ttl_keepalive_state:child-chat", null), null);

  const calls = [];
  const result = await sendSidecarKeepaliveMessage("child-chat", "OK", {
    execFn: async ([cmd]) => { calls.push(cmd); return {}; }
  });
  assert.equal(result.skippedSubagent, true);
  assert.ok(!calls.includes("send-message"));

  calls.length = 0;
  const fallback = await sendSidecarKeepaliveMessage("parent-chat", "OK", {
    allowDefaultSummaryDb: true,
    execFn: async ([cmd]) => {
      calls.push(cmd);
      if (cmd === "get-conversation-metadata") throw new Error("offline");
      return { ok: true };
    }
  });
  assert.equal(fallback.ok, true);
  assert.deepEqual(calls, ["get-conversation-metadata", "send-message"]);
});

function httpJsonRequest(port, reqPath, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload, "utf8") } : {})
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
    if (payload) req.write(payload);
    req.end();
  });
}

test("v1.5.4-ka-1: Opt-in TTL auto-keepalive, per-session isolation, failure rollback & desktop notify coordination", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-unit-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  store.open();
  store.setUiLang("zh");

  let nowMs = 1_700_000_000_000;
  let monoNs = 1_000_000_000n;
  const sentKeepalives = [];
  const sentNotifications = [];
  let failNextSend = false;

  const monitor = new WatchdogMonitor({
    getStore: () => store,
    getConfig: () => ({ ttlKeepaliveLeadSec: 30 }),
    nowFn: () => nowMs,
    monoNsFn: () => monoNs,
    keepaliveSendFn: async (payload) => {
      if (failNextSend) {
        failNextSend = false;
        return { ok: false, error: "simulated_rpc_failure" };
      }
      sentKeepalives.push(payload);
      return { ok: true };
    },
    notifyFn: (payload) => {
      sentNotifications.push(payload);
      return { dispatched: true };
    }
  });

  try {
    assert.equal(store.isTtlKeepaliveEnabled(), false, "Auto-keepalive defaults to OFF");
    assert.equal(store.getTtlKeepaliveMaxCount(), 1, "Default max keepalive count is 1");
    assert.equal(store.getGlobalTtlKeepaliveMinContextPct(), 15, "Default min context % is 15%");
    store.setGlobalTtlKeepaliveMaxCount(3);
    store.setGlobalTtlKeepaliveMinContextPct(0);

    const seedStoppedLease = (convId, anchorTs, ctxTokens = 8500, extra = {}) => {
      writeWatchdogLease(store, {
        conversationId: convId,
        rootSessionId: convId,
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: ctxTokens,
        cacheTtlSec: 240,
        idleAnchorTs: anchorTs,
        phaseChangedTs: anchorTs,
        updatedTs: anchorTs,
        lastHeartbeatTs: anchorTs,
        lastUserInput: "继续推进清洗",
        ...extra
      });
    };

    // With alerts enabled, small contexts stay quiet until the final renewed cache is expiring.
    store.setTtlDesktopNotifyEnabled(true);
    for (let round = 1; round <= 4; round++) {
      const anchor = nowMs;
      seedStoppedLease("conv-small-ctx", anchor, 8500);
      // At 190s idle (50s left <= 60s notify lead, > 30s keepalive lead): must NOT pop up while rounds 1..3 are still ahead!
      if (round <= 3) {
        nowMs = anchor + 190_000;
        monoNs += 190_000_000_000n;
        monitor.tick();
        await flushMicrotasks();
        assert.equal(sentNotifications.length, 0, `Round ${round} at 50s left must suppress popup before keepalive`);
        nowMs = anchor + 215_000;
        monoNs += 25_000_000_000n;
      } else {
        nowMs = anchor + 215_000;
        monoNs += 215_000_000_000n;
      }
      monitor.tick();
      await flushMicrotasks();

      if (round <= 3) {
        assert.equal(sentKeepalives.length, round, `Round ${round} must fire keepalive`);
        assert.ok(isTtlKeepalivePrompt(sentKeepalives[round - 1].message));
        assert.ok(sentKeepalives[round - 1].message.includes(`${round}/3`));
        assert.equal(store.getTtlKeepaliveState("conv-small-ctx").usedCount, round);
        assert.equal(sentNotifications.length, 0, `Round ${round} must NOT pop up`);

        // Simulate a 2nd Watchdog tick 5s later (20s left) on the SAME idleAnchorTs while keepalive #round is still in-flight!
        nowMs += 5_000;
        monoNs += 5_000_000_000n;
        monitor.tick();
        await flushMicrotasks();
        assert.equal(sentNotifications.length, 0, `In-flight tick right after keepalive ${round}/3 must NOT pop up early`);
      } else {
        assert.equal(sentKeepalives.length, 3, "4th idle cycle must NOT exceed maxCount=3");
        assert.equal(store.getTtlKeepaliveState("conv-small-ctx").usedCount, 3);
        assert.equal(sentNotifications.length, 1, "4th cycle (after 3rd auto-warming) MUST pop up desktop alert");
        assert.ok(sentNotifications[0].title.includes("3/3"));
        assert.ok(sentNotifications[0].body.includes("3/3"));
      }
      nowMs += 30_000;
      monoNs += 30_000_000_000n;
    }

    // 2. High-context conversation B has its OWN independent 0/3 budget, suppresses desktop alert throughout 1..3, and alerts after 3/3!
    const notifBeforeB = sentNotifications.length;
    for (let round = 1; round <= 3; round++) {
      const anchor = nowMs;
      seedStoppedLease("conv-high-ctx", anchor, 95_000);
      nowMs = anchor + 215_000;
      monoNs += 215_000_000_000n;
      monitor.tick();
      await flushMicrotasks();
      assert.equal(sentNotifications.length, notifBeforeB, `Desktop TTL alert suppressed while keepalive ${round}/3 is active`);
      // Also check 5s in-flight tick on round 3!
      nowMs += 5_000;
      monoNs += 5_000_000_000n;
      monitor.tick();
      await flushMicrotasks();
      assert.equal(sentNotifications.length, notifBeforeB, `No premature popup while keepalive ${round}/3 is in transit`);
      nowMs += 30_000;
      monoNs += 30_000_000_000n;
    }
    assert.equal(store.getTtlKeepaliveState("conv-high-ctx").usedCount, 3);

    // On 4th cycle of conv-high-ctx (keepalive exhausted 3/3), desktop TTL alert fires!
    seedStoppedLease("conv-high-ctx", nowMs, 95_000);
    nowMs += 215_000;
    monoNs += 215_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sentNotifications.length, notifBeforeB + 1, "Desktop TTL alert fires once 3/3 keepalives are exhausted");
    assert.ok(sentNotifications[sentNotifications.length - 1].title.includes("3/3"));

    // 3. Background pending subphase & subagent leases are strictly skipped
    const beforeCount = sentKeepalives.length;
    seedStoppedLease("conv-bg-workflow", nowMs, 80_000, { subphase: "stopped_bg_pending" });
    seedStoppedLease("conv-worker-sub", nowMs, 80_000, { isSubagent: true });
    nowMs += 215_000;
    monoNs += 215_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sentKeepalives.length, beforeCount, "Background workflow pending & subagents must never auto-keepalive");

    // 4. Failed send rolls back usedCount so quota is not lost
    failNextSend = true;
    seedStoppedLease("conv-rollback", nowMs, 50_000);
    nowMs += 215_000;
    monoNs += 215_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    const rbState = store.getTtlKeepaliveState("conv-rollback");
    assert.equal(rbState.usedCount, 0, "Failed send must roll back usedCount to 0");
    assert.ok(rbState.lastError.includes("simulated_rpc_failure"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.5.4-ka-2: PreInvocation preserves lastUserInput on keepalive turn, resets counter to 0 on genuine user message, and UI/Server actions adjust maxCount", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-hook-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevProjEnv = process.env.ANTIGRAVITY_PROJECT_ID;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();

  const runPreHook = (payload) =>
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });

  let srv = null;
  try {
    // Seed initial user turn + keepalive state = 2/3
    const store = new ContextModeStore({ dbPath });
    store.open();
    writeWatchdogLease(store, {
      conversationId: "conv-ka-reset",
      rootSessionId: "conv-ka-reset",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      lastUserInput: "请清洗第 10 组文稿",
      updatedTs: Date.now()
    });
    store.setTtlKeepaliveState("conv-ka-reset", {
      usedCount: 2,
      lastIdleAnchorTs: Date.now() - 220_000,
      lastSentTs: Date.now() - 2_000,
      pendingAck: true
    });
    const seqBeforeKa = store.getConversationTurnSeq("conv-ka-reset");
    store.close();

    // 1. Keepalive turn in PreInvocation MUST NOT reset usedCount, MUST NOT clobber lastUserInput, and MUST NOT bump conv_turn_seq!
    const rKa = runPreHook({
      conversationId: "conv-ka-reset",
      invocationNum: 0,
      lastUserInput: "[agy-dart TTL保活 2/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。"
    });
    assert.equal(rKa.status, 0);
    assert.equal(rKa.stdout.trim(), "{}");

    const verifyStore1 = new ContextModeStore({ dbPath });
    try {
      assert.equal(verifyStore1.getTtlKeepaliveState("conv-ka-reset").usedCount, 2, "Keepalive turn must keep usedCount=2");
      assert.equal(verifyStore1.getTtlKeepaliveState("conv-ka-reset").pendingAck, false);
      assert.equal(readWatchdogLease(verifyStore1, "conv-ka-reset").lastUserInput, "请清洗第 10 组文稿");
      assert.equal(verifyStore1.getConversationTurnSeq("conv-ka-reset"), seqBeforeKa, "Keepalive turn must not age conv_turn_seq");
    } finally {
      verifyStore1.close();
    }

    // 2. Genuine user message resets usedCount -> 0, updates lastUserInput, and bumps conv_turn_seq!
    const rUser = runPreHook({
      conversationId: "conv-ka-reset",
      invocationNum: 0,
      lastUserInput: "继续推进第 11 组"
    });
    assert.equal(rUser.status, 0);

    const verifyStore2 = new ContextModeStore({ dbPath });
    try {
      assert.equal(verifyStore2.getTtlKeepaliveState("conv-ka-reset").usedCount, 0, "Real user turn resets usedCount -> 0");
      assert.equal(readWatchdogLease(verifyStore2, "conv-ka-reset").lastUserInput, "继续推进第 11 组");
      assert.equal(verifyStore2.getConversationTurnSeq("conv-ka-reset"), seqBeforeKa + 1);
      verifyStore2.setTtlKeepaliveState("conv-ka-reset", { usedCount: 2, updatedTs: Date.now() });
    } finally {
      verifyStore2.close();
    }

    // 3. Server API setTtlKeepalive (toggle + maxCount 1..20 validation + app-scope parity + resetTtlKeepalive) & multi-window sendSidecarKeepaliveMessage
    const token = "test-v154-csrf-0123456789abcdef";
    srv = createStandaloneServer({ csrfToken: token });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const headers = {
      Host: `127.0.0.1:${port}`,
      Connection: "close",
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": token
    };

    for (const invalidMax of [99, 0, -1, 2.5, true, [5], "", null]) {
      const badMax = await httpJsonRequest(port, "/api/watchdog/action", {
        headers,
        body: { action: "setTtlKeepalive", maxCount: invalidMax, conversationId: "conv-ka-reset" }
      });
      assert.equal(badMax.status, 400, `maxCount=${JSON.stringify(invalidMax)} must be rejected with 400`);
    }

    // Verify /api/cache-diag and /api/watchdog agree on usedCount even when scope="app"
    const appCacheDiag = await httpJsonRequest(port, "/api/cache-diag", {
      headers,
      body: { scope: "app", conversationId: "conv-ka-reset" }
    });
    const appWatchdog = await httpJsonRequest(port, "/api/watchdog", {
      headers,
      body: { scope: "app", conversationId: "conv-ka-reset" }
    });
    assert.equal(appCacheDiag.status, 200);
    assert.equal(appWatchdog.status, 200);
    assert.equal(appCacheDiag.json.ttlKeepalive.usedCount, 2);
    assert.equal(appWatchdog.json.ttlKeepalive.usedCount, 2);

    const setFive = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: true, maxCount: 5, conversationId: "conv-ka-reset" }
    });
    assert.equal(setFive.status, 200);
    assert.equal(setFive.json.ttlKeepaliveEnabled, true);
    assert.equal(setFive.json.ttlKeepaliveMaxCount, 5);
    assert.equal(setFive.json.status.ttlKeepalive.maxCount, 5);

    const resetRes = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "resetTtlKeepalive", scope: "app", conversationId: "conv-ka-reset" }
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.status.ttlKeepalive.usedCount, 0);

    const setOff = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: false, conversationId: "conv-ka-reset" }
    });
    assert.equal(setOff.status, 200);
    assert.equal(setOff.json.ttlKeepaliveEnabled, false);

    // Verify sendSidecarKeepaliveMessage resolves per-conversation projectId EVEN when ANTIGRAVITY_PROJECT_ID is set to another window's project
    process.env.ANTIGRAVITY_PROJECT_ID = "proj-ambient-window-a";
    const badSend = await sendSidecarKeepaliveMessage("--evil-flag", "OK", { execFn: async () => ({}) });
    assert.equal(badSend.ok, false);

    const calls = [];
    const okSend = await sendSidecarKeepaliveMessage("41eec010-b5dd-4b19-9ac5-b7e9b0b951c9", "[agy-dart TTL保活 1/3] OK", {
      execFn: async (args, opts) => {
        calls.push({ args, projectId: opts.projectId });
        if (args[0] === "get-conversation-metadata") {
          return { response: { conversationMetadata: { metadata: { projectId: "proj-test-123" } } } };
        }
        return { ok: true };
      }
    });
    assert.equal(okSend.ok, true);
    assert.equal(calls.length, 2, "Must query get-conversation-metadata first even when ANTIGRAVITY_PROJECT_ID exists");
    assert.equal(calls[1].projectId, "proj-test-123");

    // An ambient project identifies the window, but cannot establish conversation identity.
    const fallbackCalls = [];
    const fbSend = await sendSidecarKeepaliveMessage("552f7955-908a-476e-aaf2-bcdba7254f92", "[agy-dart TTL保活 1/3] OK", {
      execFn: async (args, opts) => {
        fallbackCalls.push({ args, projectId: opts.projectId });
        if (args[0] === "get-conversation-metadata") {
          throw new Error("metadata_rpc_offline");
        }
        return { ok: true };
      }
    });
    assert.equal(fbSend.error, "conversation_identity_unavailable");
    assert.deepEqual(fallbackCalls.map(c => c.args[0]), ["get-conversation-metadata"]);
  } finally {
    if (srv) await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevProjEnv === undefined) delete process.env.ANTIGRAVITY_PROJECT_ID;
    else process.env.ANTIGRAVITY_PROJECT_ID = prevProjEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-3: Edge cases — un-flushed transcript PLANNER_RESPONSE boundary, array content + SYSTEM_MESSAGE shadowing, and opt-in keepalive with stallWatchdog disabled", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-edge-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const txPath = path.join(tmpDir, "transcript_full.jsonl");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const runHook = (relHook, payload, extraEnv = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, relHook)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath, ...extraEnv }
    });

  try {
    // Write a realistic transcript ending at previous turn's PLANNER_RESPONSE (new USER_INPUT not yet flushed)
    const baseSteps = [
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-22T13:50:00.000Z",
        content: "<USER_REQUEST>\n请清洗第 10 组文稿\n</USER_REQUEST>"
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T13:50:10.000Z",
        model: "claude-sonnet-4-5",
        input_tokens: 4000,
        cache_read_tokens: 68000,
        output_tokens: 300,
        content: "已完成第 10 组清洗。"
      }
    ];
    fs.writeFileSync(txPath, baseSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const store = new ContextModeStore({ dbPath });
    store.open();
    writeWatchdogLease(store, {
      conversationId: "conv-unflushed",
      rootSessionId: "conv-unflushed",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      lastUserInput: "请清洗第 10 组文稿",
      updatedTs: Date.now()
    });
    store.setTtlKeepaliveState("conv-unflushed", {
      usedCount: 1,
      lastIdleAnchorTs: Date.now() - 230_000,
      lastSentTs: Date.now() - 1_500,
      pendingAck: true
    });
    store.close();

    // 1. No lastUserInput + un-flushed transcript: MUST stop at PLANNER_RESPONSE and acknowledge pendingAck without resetting usedCount!
    const rUnflushed = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-unflushed",
      transcriptPath: txPath,
      invocationNum: 0
    });
    assert.equal(rUnflushed.status, 0);
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").usedCount, 1, "Must NOT scan past PLANNER_RESPONSE and reset usedCount");
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").pendingAck, false);
        assert.equal(readWatchdogLease(st, "conv-unflushed").lastUserInput, "请清洗第 10 组文稿");
      } finally {
        st.close();
      }
    }

    // 2. Array content block USER_INPUT + trailing SYSTEM_MESSAGE without payload.lastUserInput -> still recognized as keepalive!
    const arraySteps = [
      ...baseSteps,
      {
        step_index: 3,
        type: "USER_INPUT",
        created_at: "2026-11-22T13:54:00.000Z",
        content: [{ type: "text", text: "[agy-dart TTL保活 2/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。" }]
      },
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-22T13:54:01.000Z",
        content: "Injected runtime reminder after USER_INPUT"
      }
    ];
    fs.writeFileSync(txPath, arraySteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    {
      const st = new ContextModeStore({ dbPath });
      st.setTtlKeepaliveState("conv-unflushed", {
        usedCount: 2,
        lastSentTs: Date.now() - 1_000,
        pendingAck: true
      });
      st.close();
    }
    const rArray = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-unflushed",
      transcriptPath: txPath,
      invocationNum: 0
    });
    assert.equal(rArray.status, 0);
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").usedCount, 2, "Array content + trailing SYSTEM_MESSAGE must preserve usedCount=2");
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").pendingAck, false);
      } finally {
        st.close();
      }
    }

    // 3. Decoupled Auto-Keepalive when AGY_DART_DISABLE_STALL_WATCHDOG=1 + AGY_DART_TTL_KEEPALIVE=1
    const decoupledEnv = { AGY_DART_DISABLE_STALL_WATCHDOG: "1", AGY_DART_TTL_KEEPALIVE: "1" };
    const rDecPre = runHook(
      "hooks/pre-invocation.mjs",
      {
        conversationId: "conv-decoupled-ka",
        transcriptPath: txPath,
        invocationNum: 0,
        lastUserInput: "测试关闭看门狗后手动开启续温"
      },
      decoupledEnv
    );
    assert.equal(rDecPre.status, 0);
    const rDecStop = runHook(
      "hooks/stop.mjs",
      { conversationId: "conv-decoupled-ka", terminationReason: "NO_TOOL_CALL" },
      decoupledEnv
    );
    assert.equal(rDecStop.status, 0);
    assert.equal(rDecStop.stdout, '{"decision":"allow"}\n');

    const stDec = new ContextModeStore({ dbPath });
    try {
      const decLease = readWatchdogLease(stDec, "conv-decoupled-ka");
      assert.ok(decLease, "Explicit keepalive must still record a lease when stallWatchdog is disabled");
      assert.equal(decLease.phase, WATCHDOG_PHASES.IDLE);
      assert.equal(decLease.subphase, "stopped");
      assert.ok(decLease.idleAnchorTs > 0);

      const sent = [];
      const simNow = decLease.idleAnchorTs + 280_000; // 20s left on 300s Claude TTL (<= 30s lead)
      const mon = new WatchdogMonitor({
        getStore: () => stDec,
        getConfig: () => ({ stallWatchdog: false, ttlDesktopNotify: false, ttlKeepalive: true }),
        nowFn: () => simNow,
        monoNsFn: () => 10_000_000_000n,
        keepaliveSendFn: async (p) => {
          sent.push(p);
          return { ok: true };
        }
      });
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.length, 1, "Explicit keepalive must still fire with stallWatchdog=false");
      assert.equal(sent[0].conversationId, "conv-decoupled-ka");
    } finally {
      stDec.close();
    }
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-4: Sidecar index.html VM test — renderKeepaliveControls (ZH/EN), toggle, maxCount clamping & multi-window reset target", async () => {
  const htmlSrc = readDashboardHtml();
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  const elements = new Map();
  const apiCalls = [];
  let langPref = "zh";
  let watchdogState = {
    ok: true,
    enabled: true,
    desktopNotifyEnabled: false,
    ttlDesktopNotifyEnabled: false,
    ttlKeepalive: { enabled: true, supported: true, maxCount: 3, usedCount: 2, leadSec: 30, lastSentTs: 1000, lastError: "" },
    uiLang: "zh",
    uiLangSource: "sqlite",
    pendingJump: null,
    current: { conversationId: "conv-other-window", phase: "LLM_INFLIGHT", severity: "suspect", cwd: "e:\\other" },
    sessions: [],
    alertingSessions: []
  };

  const makeEl = (id) => ({
    id,
    textContent: "",
    innerText: "",
    innerHTML: "",
    title: "",
    value: "3",
    className: "",
    style: {},
    dataset: { enabled: "1", used: "0", max: "3" },
    options: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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

  const handleFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    apiCalls.push({ url, body });
    if (url === "/api/watchdog/action") {
      if (body.action === "setTtlKeepalive") {
        const nextEnabled = body.enabled !== undefined ? Boolean(body.enabled) : watchdogState.ttlKeepalive.enabled;
        const nextMax = body.maxCount !== undefined ? body.maxCount : watchdogState.ttlKeepalive.maxCount;
        watchdogState = {
          ...watchdogState,
          ttlKeepalive: { ...watchdogState.ttlKeepalive, enabled: nextEnabled, maxCount: nextMax }
        };
      } else if (body.action === "resetTtlKeepalive") {
        watchdogState = {
          ...watchdogState,
          ttlKeepalive: { ...watchdogState.ttlKeepalive, usedCount: 0 }
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, status: watchdogState }) };
    }
    if (url === "/api/watchdog") {
      return { ok: true, status: 200, json: async () => watchdogState };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const ctx = vm.createContext({
    window: {
      location: { search: "?conversationId=conv-active-tab", href: "http://127.0.0.1:4321/?conversationId=conv-active-tab" },
      addEventListener() {}
    },
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { lang: "zh-CN" },
      getElementById: getEl,
      querySelector: () => ({ getAttribute: () => "csrf-tok" }),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    localStorage: { getItem: () => langPref, setItem: (_k, v) => { langPref = v; } },
    navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
    fetch: handleFetch,
    Headers,
    URLSearchParams,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
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

  vm.runInContext(scriptMatch[1], ctx);
  await flushMicrotasks();

  const btn = getEl("kv-keepalive-btn");
  const resetBtn = getEl("kv-keepalive-reset-btn");
  const maxInput = getEl("kv-keepalive-max");

  assert.equal(btn.innerText, "自动续温：2/3");
  assert.equal(resetBtn.className, "keepalive-reset-btn", "Reset button visible when usedCount > 0");

  // Error tooltip surfaces lastError cleanly
  ctx.renderKeepaliveControls({ enabled: true, maxCount: 3, usedCount: 1, lastError: "rpc_timeout" });
  assert.ok(btn.title.includes("rpc_timeout"));

  // Clamp maxCount input (99 -> 20)
  await ctx.changeTtlKeepaliveMax("99");
  assert.equal(maxInput.value, "20");
  assert.equal(btn.innerText, "自动续温：2/20");

  // Reset targets active tab conversationId ('conv-active-tab'), NOT another window's suspect session ('conv-other-window')!
  apiCalls.length = 0;
  await ctx.resetTtlKeepalive();
  const resetCall = apiCalls.find((c) => c.url === "/api/watchdog/action" && c.body.action === "resetTtlKeepalive");
  assert.ok(resetCall);
  assert.equal(resetCall.body.conversationId, "conv-active-tab");
  assert.equal(btn.innerText, "自动续温：0/20");
  assert.ok(resetBtn.className.includes("hidden"), "Reset button hides once usedCount returns to 0");

  // Toggle OFF in Chinese & switch to English
  await ctx.toggleTtlKeepalive();
  assert.equal(btn.innerText, "自动续温：关");
  ctx.setLanguage("en", true);
  assert.equal(btn.innerText, "Auto-Keepalive: OFF");
});

test("v1.5.4-ka-5: Empirical TTL floor (>= profileTtl) prevents premature ~90s keepalive & SYSTEM_MESSAGE keepalive with stale lastUserInput preserves 1/3 -> 2/3 -> 3/3", async () => {
  const { estimateCalibratedTtl, resolveModelProfile } = await import("../context/lib/cache-analyzer.js");
  const geminiProfile = resolveModelProfile("gemini-4-carbon-high");
  assert.equal(geminiProfile.id, "gemini-4-512k");
  assert.equal(geminiProfile.ttlSec, 300);

  // 1. Reproduce production `ttl_calibration:v1:gemini-4-512k` with sub-300s replica/drift misses (147s..281s)
  //    interleaved alongside 308s..393s misses and long warm hits up to 1741s -> MUST NEVER shrink below 300s!
  const nowMs = 1_795_358_400_000;
  const prodHistory = {
    v: 1,
    profileId: "gemini-4-512k",
    warm: [
      { gapSec: 438, atMs: nowMs - 6_760_000, conv: "c1" },
      { gapSec: 207, atMs: nowMs - 6_252_000, conv: "c2" },
      { gapSec: 1730, atMs: nowMs - 4_819_000, conv: "c3" },
      { gapSec: 607, atMs: nowMs - 2_179_000, conv: "c4" },
      { gapSec: 1597, atMs: nowMs - 553_000, conv: "c4" },
      { gapSec: 1741, atMs: nowMs - 328_000, conv: "c2" }
    ],
    cold: [
      { gapSec: 248, atMs: nowMs - 13_851_000, conv: "m1" },
      { gapSec: 191, atMs: nowMs - 13_502_000, conv: "m2" },
      { gapSec: 181, atMs: nowMs - 3_695_000, conv: "m3" },
      { gapSec: 323, atMs: nowMs - 3_500_000, conv: "m4" },
      { gapSec: 308, atMs: nowMs - 2_885_000, conv: "m5" },
      { gapSec: 260, atMs: nowMs - 1_086_000, conv: "m6" },
      { gapSec: 169, atMs: nowMs - 945_000, conv: "m7" },
      { gapSec: 147, atMs: nowMs - 92_000, conv: "m8" }
    ],
    seen1hWrite: false,
    updatedTs: nowMs - 18_000
  };
  const cal = estimateCalibratedTtl(geminiProfile, { historyRecord: prodHistory, nowMs });
  assert.ok(cal.ttlSec >= 300, `Empirical TTL must never drop below 300s profile floor, got ${cal.ttlSec}s`);
  assert.equal(cal.ttlSec, 300);

  // Pure sub-300s cold misses alone across multiple conversations also stay at 300s profile floor
  const subFloorOnly = estimateCalibratedTtl(geminiProfile, {
    historyRecord: {
      v: 1,
      profileId: "gemini-4-512k",
      warm: [],
      cold: [
        { gapSec: 147, atMs: nowMs - 50_000, conv: "x1" },
        { gapSec: 169, atMs: nowMs - 40_000, conv: "x2" },
        { gapSec: 185, atMs: nowMs - 30_000, conv: "x3" }
      ],
      updatedTs: nowMs
    },
    nowMs
  });
  assert.equal(subFloorOnly.ttlSec, 300);
  assert.equal(subFloorOnly.ttlSource, "profile");

  // Explicit user override (<300s) is still respected
  const explicitShort = estimateCalibratedTtl(geminiProfile, {
    explicitTtlSec: 180,
    historyRecord: prodHistory,
    nowMs
  });
  assert.equal(explicitShort.ttlSec, 180);
  assert.equal(explicitShort.ttlSource, "explicit");

  // 2. Watchdog clamps legacy stale lease `{ cacheTtlSec: 120, ttlSource: "empirical" }` to >=300s (no 90s trigger!)
  //    AND PreInvocation preserves 1/3 -> 2/3 -> 3/3 when `agentapi send-message` injects SYSTEM_MESSAGE with stale `lastUserInput`!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-sysmsg-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const txPath = path.join(tmpDir, "transcript_full.jsonl");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const runHook = (relHook, payload) =>
    spawnSync(process.execPath, [path.join(ROOT, relHook)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });

  try {
    const store = new ContextModeStore({ dbPath });
    store.open();
    store.setUiLang("zh");
    store.setGlobalTtlKeepaliveMaxCount(3);
    store.setMeta("ttl_calibration:v1:gemini-4-512k", JSON.stringify(prodHistory));

    let simNow = nowMs;
    let simMono = 1_000_000_000n;
    const sent = [];
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      nowFn: () => simNow,
      monoNsFn: () => simMono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // Seed stale empirical 120s lease like live `f7b3aa5c` before fix
    writeWatchdogLease(store, {
      conversationId: "conv-gemini-live",
      rootSessionId: "conv-gemini-live",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      model: "gemini-4-carbon-high",
      contextTokens: 420_000,
      cacheTtlSec: 120,
      ttlSource: "empirical",
      idleAnchorTs: simNow,
      phaseChangedTs: simNow,
      updatedTs: simNow,
      lastHeartbeatTs: simNow,
      lastUserInput: "/compact"
    });

    // At 110s idle (1m50s, when old bug fired!): MUST NOT fire keepalive because effective TTL is 300s (remSec=190s > 30s)
    simNow += 110_000;
    simMono += 110_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 0, "Must NOT trigger keepalive after 1m50s on 5m Gemini profile");

    // At 272s idle (4m32s, 28s left <= 30s lead): fires keepalive 1/3!
    simNow += 162_000;
    simMono += 162_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 1, "Must trigger keepalive 1/3 at 4m32s (28s before 5m TTL)");
    assert.ok(sent[0].message.includes("1/3"));
    assert.equal(store.getTtlKeepaliveState("conv-gemini-live").usedCount, 1);

    store.close();

    // First complete the `/compact` turn so `compact_invalidated:<conv>` is stamped, then record a post-compact file read
    const priorCompactSteps = [
      { step_index: 1, type: "USER_INPUT", created_at: "2026-11-22T14:40:00Z", content: "/compact" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T14:40:07Z",
        model: "gemini-4-carbon-high",
        input_tokens: 2406,
        cache_read_tokens: 389955,
        output_tokens: 120,
        content: "已完成。"
      }
    ];
    fs.writeFileSync(txPath, priorCompactSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 1,
      lastUserInput: "/compact"
    });

    const sampleFile = path.join(tmpDir, "sample.txt");
    fs.writeFileSync(sampleFile, "hello", "utf8");
    const fstat = fs.statSync(sampleFile);
    let seqBefore = 0;
    {
      const stSeed = new ContextModeStore({ dbPath });
      stSeed.open();
      stSeed.recordFileRead({
        sessionId: "conv-gemini-live",
        filePath: sampleFile,
        mtimeMs: fstat.mtimeMs,
        fileSize: fstat.size,
        stepIdx: 2
      });
      stSeed.setTtlKeepaliveState("conv-gemini-live", {
        usedCount: 1,
        lastIdleAnchorTs: Date.now() - 275_000,
        lastSentTs: Date.now() - 2_000,
        pendingAck: true
      });
      seqBefore = stSeed.getConversationTurnSeq("conv-gemini-live");
      stSeed.close();
    }

    // Case A: Flushed SYSTEM_MESSAGE keepalive 1/3 in transcript WHILE `payload.lastUserInput` STILL carries prior user's `"/compact"` (with advanced initialNumSteps=3)!
    const stepsRound1 = [
      ...priorCompactSteps,
      {
        step_index: 3,
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM",
        created_at: "2026-11-22T14:44:39Z",
        content:
          "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T14:44:39Z sender=system priority=MESSAGE_PRIORITY_HIGH content=" +
          sent[0].message +
          "\n</SYSTEM_MESSAGE>"
      }
    ];
    fs.writeFileSync(txPath, stepsRound1.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const rPre1 = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 3,
      lastUserInput: "/compact"
    });
    assert.equal(rPre1.status, 0);

    {
      const st = new ContextModeStore({ dbPath });
      st.open();
      try {
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").usedCount, 1, "Flushed SYSTEM_MESSAGE keepalive must keep usedCount=1 despite non-empty stale lastUserInput");
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").pendingAck, false);
        const remainingReads = st.db.prepare("SELECT COUNT(*) AS cnt FROM file_reads WHERE session_id = ?").get("conv-gemini-live")?.cnt || 0;
        assert.equal(remainingReads, 1, "Stale `/compact` in lastUserInput during keepalive turn must NOT wipe post-compact file_reads");
        assert.equal(st.getConversationTurnSeq("conv-gemini-live"), seqBefore, "Keepalive turn must not bump conv_turn_seq");

        // Now simulate round 2/3 UN-FLUSHED (transcript ends at PLANNER_RESPONSE "OK", pendingAck=true, lastUserInput still unchanged)
        st.setTtlKeepaliveState("conv-gemini-live", {
          usedCount: 2,
          lastIdleAnchorTs: Date.now() - 275_000,
          lastSentTs: Date.now() - 2_000,
          pendingAck: true
        });
      } finally {
        st.close();
      }
    }

    const stepsRound2Unflushed = [
      ...stepsRound1,
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T14:44:40Z",
        model: "gemini-4-carbon-high",
        input_tokens: 2200,
        cache_read_tokens: 390312,
        output_tokens: 2,
        content: "OK"
      }
    ];
    fs.writeFileSync(txPath, stepsRound2Unflushed.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const rPre2 = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 5,
      lastUserInput: "/compact"
    });
    assert.equal(rPre2.status, 0);

    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").usedCount, 2, "Un-flushed pendingAck keepalive with unchanged lastUserInput must keep usedCount=2");
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").pendingAck, false);
      } finally {
        st.close();
      }
    }

    // Finally, genuine new user message resets usedCount -> 0!
    const stepsUserReply = [
      ...stepsRound2Unflushed,
      {
        step_index: 5,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        created_at: "2026-11-22T14:46:00Z",
        content: "<USER_REQUEST>\n继续推进下一批\n</USER_REQUEST>"
      }
    ];
    fs.writeFileSync(txPath, stepsUserReply.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const rPreUser = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 6,
      lastUserInput: "继续推进下一批"
    });
    assert.equal(rPreUser.status, 0);

    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").usedCount, 0, "Genuine user prompt after SYSTEM_MESSAGE keepalive resets usedCount to 0");
      } finally {
        st.close();
      }
    }
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-6: Sidecar index.html — hidden scope bar (conversation-only), Band 1 framed Current Context spotlight with distinct background & synthesized metrics", async () => {
  const htmlSrc = readDashboardHtml();

  // 1. Scope bar & telemetry scope banner are hidden; Band 1 is #kv-cache-card with #ctx-overview-box & #ctx-spotlight-box
  assert.match(htmlSrc, /<div id="scope-switcher-row"[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*\bhidden\b/);
  assert.match(htmlSrc, /<div id="telemetry-banner"[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*\bhidden\b/);
  assert.match(htmlSrc, /<div id="exempt-scope-explain"[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*\bhidden\b/);

  const idxKvCard = htmlSrc.indexOf('id="kv-cache-card"');
  const idxWatchdogCard = htmlSrc.indexOf('id="watchdog-card"');
  const idxSavingsCard = htmlSrc.indexOf('id="savings-breakdown-card"');
  const idxSearchCard = htmlSrc.indexOf('id="search-inspector-card"');
  assert.ok(idxKvCard > 0 && idxWatchdogCard > 0 && idxSavingsCard > 0 && idxSearchCard > 0);
  assert.ok(idxKvCard < idxWatchdogCard, "#kv-cache-card (Current Context) must be placed in Band 1 above #watchdog-card");
  assert.ok(idxKvCard < idxSavingsCard, "#kv-cache-card (Current Context) must be placed in Band 1 above #savings-breakdown-card");
  assert.ok(htmlSrc.includes('id="ctx-overview-box"'));
  assert.ok(htmlSrc.includes('id="ctx-spotlight-box"'));
  assert.ok(htmlSrc.includes(".ctx-overview-box {") && htmlSrc.includes("linear-gradient("), "Context box must have distinct non-white background");

  // 2. VM execution verifying synthesized Band 1 rendering & watermark color state transitions in ZH/EN
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  const elements = new Map();
  const makeEl = (id) => ({
    id,
    textContent: "",
    innerText: "",
    innerHTML: "",
    title: "",
    value: "46080",
    className: "",
    style: {},
    dataset: { enabled: "1", used: "0", max: "3" },
    options: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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

  let nativeConvId = "conv-first";
  const apiScopes = [];
  const ctx = vm.createContext({
    window: {
      sidecar: {
        get conversationId() {
          return nativeConvId;
        },
        ui: { toggleConversation() {} }
      },
      location: { search: "", href: "http://127.0.0.1:4321/" },
      addEventListener() {}
    },
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { lang: "zh-CN" },
      getElementById: getEl,
      querySelector: () => ({ getAttribute: () => "csrf-tok" }),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    localStorage: { getItem: () => "zh", setItem() {} },
    navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.scope) apiScopes.push({ url, scope: body.scope, conversationId: body.conversationId });
      if (url === "/api/stats") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalRawBytes: 100_000,
            totalReturnedBytes: 20_000,
            keptOutBytes: 80_000,
            tokensKeptOut: 20_000,
            savingsPercent: 80,
            chunksCount: 12,
            sourcesCount: 2
          })
        };
      }
      if (url === "/api/cache-diag") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transcriptFound: true,
            turnsWithUsage: 6,
            weightedHitRate: 0.94,
            currentContextTokens: 420_000,
            watermark: "critical",
            warnTokens: 332_800,
            criticalTokens: 409_600,
            modelProfile: { id: "gemini-4-512k", windowTokens: 512_000 },
            cacheTtlSec: 300,
            idleSeconds: 20,
            ttlRemainingSec: 280,
            ttlStatus: "warm",
            ttlSource: "profile",
            cacheTemperature: "hot",
            lastPlannerAt: new Date(Date.now() - 20_000).toISOString(),
            serverNowMs: Date.now()
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

  vm.runInContext(scriptMatch[1], ctx);
  await flushMicrotasks();

  // Only conversation scope is queried by default ("只统计本次对话")
  assert.ok(apiScopes.length >= 2);
  assert.ok(apiScopes.every((s) => s.scope === "conversation"));

  assert.equal(getEl("kv-ctx-tokens").innerText, "420k / 512k");
  assert.equal(getEl("kv-ctx-pct").textContent, "82.0%");
  assert.equal(getEl("kv-ctx-bar-fill").style.width, "82.0%");
  assert.equal(getEl("ctx-overview-box").className, "ctx-overview-box is-critical");
  assert.equal(getEl("kv-saved-summary").innerText, "~20,000 tok");
  assert.equal(getEl("kv-saved-sub").innerText, "已省 80.0%");
  assert.ok(getEl("kv-ctx-synth-note").textContent.includes("窗口已用 82.0%"));
  assert.ok(getEl("kv-ctx-synth-note").textContent.includes("20,000"));

  // Switch to warn & ok watermarks + English localization
  ctx.renderKvCacheCard({
    transcriptFound: true,
    turnsWithUsage: 3,
    weightedHitRate: 0.9,
    currentContextTokens: 350_000,
    watermark: "warn",
    warnTokens: 332_800,
    criticalTokens: 409_600,
    modelProfile: { id: "gemini-4-512k", windowTokens: 512_000 }
  });
  assert.equal(getEl("ctx-overview-box").className, "ctx-overview-box is-warn");

  ctx.setLanguage("en", false);
  assert.ok(getEl("kv-ctx-synth-note").textContent.includes("Window 68.4% used"));
  assert.equal(getEl("kv-saved-sub").innerText, "80.0% filtered");

  // Native host conversation switch clears any prior jump override so stats always track the active conversation
  await ctx.jumpToConversation("conv-jumped-temp", { fromPendingJump: true, jumpId: "j1" });
  assert.equal(ctx.getActiveConversationId(), "conv-jumped-temp");
  nativeConvId = "conv-second-native";
  assert.equal(ctx.getActiveConversationId(), "conv-second-native");
});

test("v1.5.4-ka-7: Review hardening — cold ring-buffer eviction guard, SYSTEM_MESSAGE keepalive cold-miss convergence, USER_INPUT+keepalive collision, empty-lease fallback & Band 1 dark-host/standalone parity", async () => {
  const { analyzeTranscriptCache, estimateCalibratedTtl, resolveModelProfile } = await import(
    "../context/lib/cache-analyzer.js"
  );
  const geminiProfile = resolveModelProfile("gemini-4-carbon-high");
  const t0 = Date.parse("2026-11-22T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();

  // 1. Ring-buffer eviction guard: 25 sub-300s replica/drift misses MUST NOT evict a genuine 540s (9m) cold miss
  //    or corrupt minColdMissGapSec / origin!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-review-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  try {
    const store = new ContextModeStore({ dbPath });
    store.open();

    // Seed an 840s warm hit + a 540s genuine cold miss (downward convergence -> 480s)
    store.recordModelTtlObservations(
      {
        "gemini-4-512k": {
          profileId: "gemini-4-512k",
          warm: [{ gapSec: 840, atMs: t0, conv: "c-warm" }],
          cold: [{ gapSec: 540, atMs: t0 + 100_000, conv: "c-real-cold" }]
        }
      },
      "c-real-cold",
      t0 + 100_000
    );

    // Flood 25 sub-300s replica/drift misses across 25 sessions via analyzeTranscriptCache + recordModelTtlObservations
    for (let i = 0; i < 25; i++) {
      const baseT = t0 + (200 + i * 200) * 1000;
      const gap = 130 + (i % 150); // 130s..279s (< 300s floor)
      const steps = [
        { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(baseT), model: "gemini-4-carbon-high", input_tokens: 60000, cache_read_tokens: 0 },
        { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(baseT + gap * 1000), model: "gemini-4-carbon-high", input_tokens: 62000, cache_read_tokens: 0 }
      ];
      const d = analyzeTranscriptCache(steps, { nowMs: baseT + (gap + 5) * 1000, conversationId: `c-noise-${i}` });
      store.recordModelTtlObservations(d.ttlObservations, `c-noise-${i}`, baseT + (gap + 5) * 1000);
    }

    const histAfterNoise = store.getModelTtlCalibration("gemini-4-512k", t0 + 6_000_000);
    assert.equal(histAfterNoise.cold.length, 1, "Sub-300s replica misses must NOT enter or evict >=300s cold ring buffer");
    assert.equal(histAfterNoise.cold[0].gapSec, 540);
    const calAfterNoise = estimateCalibratedTtl(geminiProfile, { historyRecord: histAfterNoise, nowMs: t0 + 6_000_000 });
    assert.equal(calAfterNoise.ttlSec, 480, "Downward convergence to 480s must survive 25 sub-300s replica misses");
    assert.equal(calAfterNoise.ttlCalibration.minColdMissGapSec, 540);
    assert.equal(calAfterNoise.ttlCalibration.coldSamples, 1);

    // Origin check when history has ONLY legacy sub-floor cold noise while current session has an 840s warm hit
    const sessOnlyOrigin = estimateCalibratedTtl(geminiProfile, {
      sessionWarmSamples: [{ gapSec: 840, atMs: t0 + 7_000_000, conv: "c-sess" }],
      historyRecord: {
        v: 1,
        profileId: "gemini-4-512k",
        warm: [],
        cold: [{ gapSec: 147, atMs: t0 + 6_500_000, conv: "c-old-noise" }],
        updatedTs: t0 + 6_500_000
      },
      nowMs: t0 + 7_000_000
    });
    assert.equal(sessOnlyOrigin.ttlSec, 840);
    assert.equal(sessOnlyOrigin.ttlCalibration.origin, "session", "Filtered-out sub-floor history noise must not misattribute session warm hit as history");
    assert.equal(sessOnlyOrigin.ttlCalibration.minColdMissGapSec, null);

    // 2. SYSTEM_MESSAGE keepalive experiencing a genuine >=300s cold miss (e.g. 540s after server shrank 14m TTL)
    //    must NOT be blocked by `systemMsgSincePrev` -> records cold miss & converges 840s -> 480s!
    const kaColdSteps = [
      { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(t0), model: "gemini-4-carbon-high", input_tokens: 70000, cache_read_tokens: 0 },
      { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(t0 + 840_000), model: "gemini-4-carbon-high", input_tokens: 2000, cache_read_tokens: 69000 },
      {
        type: "SYSTEM_MESSAGE",
        step_index: 3,
        created_at: iso(t0 + 1_380_000),
        content: "<SYSTEM_MESSAGE>\n[Message] content=[agy-dart TTL保活 1/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。\n</SYSTEM_MESSAGE>"
      },
      { type: "PLANNER_RESPONSE", step_index: 4, created_at: iso(t0 + 1_380_000), model: "gemini-4-carbon-high", input_tokens: 72000, cache_read_tokens: 0 }
    ];
    const diagKaCold = analyzeTranscriptCache(kaColdSteps, { nowMs: t0 + 1_390_000, conversationId: "c-ka-cold" });
    assert.equal(diagKaCold.cacheTtlSec, 480, "Genuine 540s cold miss on SYSTEM_MESSAGE keepalive must converge 840s -> 480s");
    assert.equal(diagKaCold.bustsByCause.system_injection, 0, "Tail keepalive SYSTEM_MESSAGE must not misattribute bust to system_injection");

    // 3. sanitizeModelTtlState() scrubs legacy polluted SQLite records & empirical <300s leases in-place
    store.setMeta(
      "ttl_calibration:v1:gemini-4-512k",
      JSON.stringify({
        v: 1,
        profileId: "gemini-4-512k",
        warm: [{ gapSec: 600, atMs: t0, conv: "c1" }],
        cold: [
          { gapSec: 147, atMs: t0, conv: "c2" },
          { gapSec: 360, atMs: t0, conv: "c3" }
        ],
        seen1hWrite: false,
        updatedTs: t0
      })
    );
    writeWatchdogLease(store, {
      conversationId: "conv-legacy-120",
      rootSessionId: "conv-legacy-120",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      model: "gemini-4-carbon-high",
      cacheTtlSec: 120,
      ttlSource: "empirical",
      updatedTs: t0
    });
    const sanRes = store.sanitizeModelTtlState();
    assert.equal(sanRes.scrubbedCalibrations, 1);
    assert.equal(sanRes.clampedLeases, 1);
    assert.deepEqual(JSON.parse(store.getMeta("ttl_calibration:v1:gemini-4-512k")).cold.map((c) => c.gapSec), [360]);
    assert.equal(readWatchdogLease(store, "conv-legacy-120").cacheTtlSec, 300);

    // 4. PreInvocation edge cases:
    //    (4a) Empty existingLease.lastUserInput (Stop-created lease) + un-flushed keepalive turn preserves usedCount=1 via prior <USER_REQUEST>
    //    (4b) Real USER_INPUT + SYSTEM_MESSAGE keepalive in same trailing batch resets usedCount -> 0 and bumps turnSeq!
    const txPath = path.join(tmpDir, "transcript_edge.jsonl");
    const runHook = (payload) =>
      spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
      });

    writeWatchdogLease(store, {
      conversationId: "conv-stop-only",
      rootSessionId: "conv-stop-only",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      lastUserInput: "",
      updatedTs: Date.now()
    });
    store.setTtlKeepaliveState("conv-stop-only", {
      usedCount: 1,
      lastSentTs: Date.now() - 2_000,
      pendingAck: true
    });
    const seq0 = store.getConversationTurnSeq("conv-stop-only");
    store.close();

    const stopOnlySteps = [
      { step_index: 1, type: "USER_INPUT", created_at: iso(t0), content: "<USER_REQUEST>\n分析这段日志\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>" },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: iso(t0 + 5_000), model: "gemini-4-carbon-high", input_tokens: 8000, cache_read_tokens: 0, content: "好的" }
    ];
    fs.writeFileSync(txPath, stopOnlySteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    // (4a) Un-flushed keepalive with empty lease.lastUserInput + stale payload.lastUserInput matching step 1
    assert.equal(
      runHook({ conversationId: "conv-stop-only", transcriptPath: txPath, invocationNum: 0, lastUserInput: "分析这段日志" }).status,
      0
    );
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-stop-only").usedCount, 1, "Must preserve usedCount=1 via prior <USER_REQUEST> match");
        assert.equal(st.getConversationTurnSeq("conv-stop-only"), seq0);
        st.setTtlKeepaliveState("conv-stop-only", { usedCount: 2, lastSentTs: Date.now() - 1_000, pendingAck: true });
      } finally {
        st.close();
      }
    }

    // (4b) Trailing USER_INPUT followed by SYSTEM_MESSAGE keepalive -> real user turn MUST win and reset usedCount -> 0!
    const collidedSteps = [
      ...stopOnlySteps,
      { step_index: 3, type: "USER_INPUT", created_at: iso(t0 + 275_000), content: "<USER_REQUEST>\n继续下一步\n</USER_REQUEST>" },
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        created_at: iso(t0 + 275_100),
        content: "<SYSTEM_MESSAGE>\n[Message] content=[agy-dart TTL保活 2/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。\n</SYSTEM_MESSAGE>"
      }
    ];
    fs.writeFileSync(txPath, collidedSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    assert.equal(
      runHook({ conversationId: "conv-stop-only", transcriptPath: txPath, invocationNum: 0, lastUserInput: "继续下一步" }).status,
      0
    );
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-stop-only").usedCount, 0, "Real USER_INPUT alongside SYSTEM_MESSAGE keepalive must reset usedCount -> 0");
        assert.equal(st.getConversationTurnSeq("conv-stop-only"), seq0 + 1, "Real USER_INPUT alongside SYSTEM_MESSAGE keepalive must bump turnSeq");
        assert.equal(readWatchdogLease(st, "conv-stop-only").lastUserInput, "继续下一步");
      } finally {
        st.close();
      }
    }

    // 5. Band 1 strict position above #star-milestone-banner & Dark-Host CSS color inheritance guard
    const htmlSrc = readDashboardHtml();
    assert.ok(
      htmlSrc.indexOf('id="kv-cache-card"') < htmlSrc.indexOf('id="star-milestone-banner"'),
      "#kv-cache-card must appear strictly above #star-milestone-banner as Band 1"
    );
    assert.match(htmlSrc, /\.shell\s*\{[^}]*color:\s*var\(--text-primary\)/, ".shell must explicitly guard text color against dark-host body inline styles");
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-8: Sticky topbar keepalive capsule & strict per-conversation window isolation (legacy global DB scrub, multi-window Watchdog/Hooks/API, and Sidecar tab switching)", async () => {
  const htmlSrc = readDashboardHtml();

  // 1. Sticky Topbar placement: #kv-keepalive-group lives inside <header class="topbar"> side-by-side with #toggle-active-btn inside .topbar-pills
  const headerStart = htmlSrc.indexOf('<header class="topbar">');
  const headerEnd = htmlSrc.indexOf("</header>", headerStart);
  const idxActiveBtn = htmlSrc.indexOf('id="toggle-active-btn"');
  const idxKeepaliveGrp = htmlSrc.indexOf('id="kv-keepalive-group"');
  const idxKvCard = htmlSrc.indexOf('id="kv-cache-card"');
  assert.ok(headerStart > 0 && headerEnd > headerStart, "Sticky <header class=\"topbar\"> must exist");
  assert.ok(
    idxActiveBtn > headerStart && idxKeepaliveGrp > idxActiveBtn && idxKeepaliveGrp < headerEnd,
    "#kv-keepalive-group must be inside sticky .topbar right beside #toggle-active-btn"
  );
  assert.ok(idxKeepaliveGrp < idxKvCard, "#kv-keepalive-group must be pinned above Band 1 (#kv-cache-card)");
  assert.equal((htmlSrc.match(/id="kv-keepalive-group"/g) || []).length, 1, "No duplicate #kv-keepalive-group");
  assert.equal((htmlSrc.match(/id="kv-keepalive-btn"/g) || []).length, 1, "No duplicate #kv-keepalive-btn");
  assert.match(htmlSrc, /\.keepalive-group\s*\{[^}]*border-radius:\s*999px/, "Keepalive group must be styled as a capsule pill");
  assert.match(htmlSrc, /\.keepalive-group\.is-on\.is-exhausted\s*\{/, "Exhausted capsule state must have dedicated visual styling");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-perconv-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();

  let srv = null;
  let openStore = null;
  try {
    // 2. Legacy global keys (`cache:ttl_keepalive_enabled = "true"` & `cache:ttl_keepalive_max_count = "9"`)
    //    must NEVER poison new conversations, and sanitizeModelTtlState() scrubs them cleanly!
    const store = new ContextModeStore({ dbPath });
    openStore = store;
    store.open();
    store.setUiLang("zh");
    store.setMeta("cache:ttl_keepalive_enabled", "true");
    store.setMeta("cache:ttl_keepalive_max_count", "9");

    assert.equal(store.isTtlKeepaliveEnabled("conv-fresh-window"), false, "Obsolete global keys must not enable new conversations");
    assert.equal(store.getTtlKeepaliveMaxCount("conv-fresh-window"), 1, "Stale global maxCount in meta must NOT override default 1");

    const scrubRes = store.sanitizeModelTtlState();
    assert.equal(scrubRes.removedLegacyGlobalKeepalive, 2, "sanitizeModelTtlState must remove both legacy global keepalive keys");
    assert.equal(store.getMeta("cache:ttl_keepalive_enabled", null), null);
    assert.equal(store.getMeta("cache:ttl_keepalive_max_count", null), null);

    // 3. Per-conversation isolation across 3 simultaneous windows in WatchdogMonitor:
    //    - conv-win-a: toggled OFF (enabled=false) -> 0 keepalives, 0 exhausted popups
    //    - conv-win-b: custom maxCount=2 (enabled=true) -> 2 keepalives, exhausted popup on cycle 3
    //    - conv-win-c: untouched global=3 -> 3 keepalives, exhausted popup on cycle 4
    store.setGlobalTtlKeepaliveMaxCount(3);
    store.setTtlKeepaliveEnabled(false, "conv-win-a");
    store.setTtlKeepaliveMaxCount(2, "conv-win-b");

    assert.equal(store.isTtlKeepaliveEnabled("conv-win-a"), false);
    assert.equal(store.isTtlKeepaliveEnabled("conv-win-b"), true);
    assert.equal(store.getTtlKeepaliveMaxCount("conv-win-b"), 2);
    assert.equal(store.isTtlKeepaliveEnabled("conv-win-c"), true);
    assert.equal(store.getTtlKeepaliveMaxCount("conv-win-c"), 3);

    let nowMs = 1_795_500_000_000;
    let monoNs = 1_000_000_000n;
    const sentKeepalives = [];
    const sentNotifications = [];
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ ttlKeepaliveLeadSec: 30, ttlDesktopNotify: true }),
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      keepaliveSendFn: async (p) => {
        sentKeepalives.push(p);
        return { ok: true };
      },
      notifyFn: (p) => {
        sentNotifications.push(p);
        return { dispatched: true };
      }
    });

    const seedIdle = (convId, anchor) => {
      writeWatchdogLease(store, {
        conversationId: convId,
        rootSessionId: convId,
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: 50_000,
        cacheTtlSec: 240,
        idleAnchorTs: anchor,
        phaseChangedTs: anchor,
        updatedTs: anchor,
        lastHeartbeatTs: anchor
      });
    };

    for (let cycle = 1; cycle <= 4; cycle++) {
      const anchor = nowMs;
      seedIdle("conv-win-a", anchor);
      if (cycle <= 3) {
        // conv-win-b only renews its idleAnchorTs through its 2 keepalive turns (cycles 1->2->3)
        seedIdle("conv-win-b", anchor);
      }
      seedIdle("conv-win-c", anchor);
      nowMs = anchor + 215_000; // 25s left <= 30s lead
      monoNs += 215_000_000_000n;
      monitor.tick();
      await flushMicrotasks();
      // Advance >60s between cycles so global desktop notify cooldown does not throttle independent cycle checks
      nowMs += 70_000;
      monoNs += 70_000_000_000n;
    }

    assert.deepEqual(
      sentKeepalives.filter((k) => k.conversationId === "conv-win-a"),
      [],
      "Disabled conv-win-a must NEVER send keepalive"
    );
    const kaB = sentKeepalives.filter((k) => k.conversationId === "conv-win-b");
    const kaC = sentKeepalives.filter((k) => k.conversationId === "conv-win-c");
    assert.equal(kaB.length, 2, "conv-win-b must stop at its custom maxCount=2");
    assert.ok(kaB[0].message.includes("1/2") && kaB[1].message.includes("2/2"));
    assert.equal(kaC.length, 3, "conv-win-c must run default maxCount=3 unaffected by A or B");
    assert.ok(kaC[2].message.includes("3/3"));

    assert.equal(
      sentNotifications.filter((n) => n.conversationId === "conv-win-a").length,
      0,
      "Disabled conv-win-a must NOT emit keepalive-exhausted alert"
    );
    const notifB = sentNotifications.find((n) => n.conversationId === "conv-win-b");
    const notifC = sentNotifications.find((n) => n.conversationId === "conv-win-c");
    assert.ok(notifB && notifB.title.includes("2/2"), "conv-win-b exhausted popup must reflect 2/2");
    assert.ok(notifC && notifC.title.includes("3/3"), "conv-win-c exhausted popup must reflect 3/3");

    // Genuine user message on conv-win-b resets usedCount -> 0 while preserving conv-win-b's custom maxCount=2!
    store.close();
    openStore = null;
    const rUserB = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: "conv-win-b", invocationNum: 0, lastUserInput: "继续修改窗口 B" }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });
    assert.equal(rUserB.status, 0);

    {
      const stCheck = new ContextModeStore({ dbPath });
      try {
        assert.equal(stCheck.getTtlKeepaliveState("conv-win-b").usedCount, 0);
        assert.equal(stCheck.getTtlKeepaliveMaxCount("conv-win-b"), 2, "Resetting usedCount on user turn must preserve custom maxCount=2");
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-win-b"), true);
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-win-a"), false, "conv-win-a remains OFF");
      } finally {
        stCheck.close();
      }
    }

    // 4. Sidecar HTTP API per-conversation isolation + invalid conversationId / maxCount / fromSidecarHost guards
    const token = "test-perconv-csrf-0123456789abcdef";
    srv = createStandaloneServer({ csrfToken: token });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const headers = {
      Host: `127.0.0.1:${port}`,
      Connection: "close",
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": token
    };

    const badConvRes = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: false, conversationId: "../evil" }
    });
    assert.equal(badConvRes.status, 400);

    const badHostFlag = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: false, conversationId: "conv-win-c", fromSidecarHost: "yes" }
    });
    assert.equal(badHostFlag.status, 400);

    // Querying /api/watchdog and /api/cache-diag for each window returns its own isolated state
    const wdA = await httpJsonRequest(port, "/api/watchdog", { headers, body: { scope: "conversation", conversationId: "conv-win-a" } });
    const wdB = await httpJsonRequest(port, "/api/watchdog", { headers, body: { scope: "conversation", conversationId: "conv-win-b" } });
    const cdA = await httpJsonRequest(port, "/api/cache-diag", { headers, body: { scope: "conversation", conversationId: "conv-win-a" } });
    const cdB = await httpJsonRequest(port, "/api/cache-diag", { headers, body: { scope: "conversation", conversationId: "conv-win-b" } });
    assert.equal(wdA.json.ttlKeepalive.enabled, false);
    assert.equal(cdA.json.ttlKeepalive.enabled, false);
    assert.equal(wdB.json.ttlKeepalive.enabled, true);
    assert.equal(wdB.json.ttlKeepalive.maxCount, 2);
    assert.equal(cdB.json.ttlKeepalive.maxCount, 2);

    // Empty Sidecar host tab (`conversationId: ""`, `fromSidecarHost: true`) writes ONLY to `__unbound__`, never touching conv-win-b!
    const unboundOff = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: false, conversationId: "", fromSidecarHost: true }
    });
    assert.equal(unboundOff.status, 200);
    assert.equal(unboundOff.json.conversationId, "__unbound__");
    assert.equal(unboundOff.json.ttlKeepaliveEnabled, false);

    const wdBAfterUnbound = await httpJsonRequest(port, "/api/watchdog", {
      headers,
      body: { scope: "conversation", conversationId: "conv-win-b" }
    });
    assert.equal(wdBAfterUnbound.json.ttlKeepalive.enabled, true, "Unbound empty-tab toggle must never affect conv-win-b");

    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
    srv = null;
    closeRuntimeStore();

    // 5. Decoupled per-conversation explicit ON when BOTH stallWatchdog=false AND config.json ttlKeepalive=false
    fs.writeFileSync(cfgPath, JSON.stringify({ stallWatchdog: false, ttlKeepalive: false }), "utf8");
    resetConfigCache();
    {
      const stExplicit = new ContextModeStore({ dbPath });
      stExplicit.setTtlKeepaliveEnabled(true, "conv-optin-only");
      stExplicit.close();
    }
    for (const cid of ["conv-optin-only", "conv-default-off"]) {
      spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
        input: JSON.stringify({ conversationId: cid, invocationNum: 0, lastUserInput: "测试单对话显式开启" }),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
      });
      spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
        input: JSON.stringify({ conversationId: cid, terminationReason: "NO_TOOL_CALL" }),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
      });
    }
    {
      const stVerify = new ContextModeStore({ dbPath });
      try {
        const optInLease = readWatchdogLease(stVerify, "conv-optin-only");
        assert.ok(optInLease, "Explicitly enabled conversation must record lease even when stallWatchdog & config ttlKeepalive are false");
        assert.equal(readWatchdogLease(stVerify, "conv-default-off"), null, "Other conversations stay disabled without lease overhead");
        const sentOptIn = [];
        const monOptIn = new WatchdogMonitor({
          getStore: () => stVerify,
          getConfig: () => ({ stallWatchdog: false, ttlKeepalive: false, ttlDesktopNotify: false }),
          nowFn: () => optInLease.idleAnchorTs + 280_000,
          monoNsFn: () => 50_000_000_000n,
          keepaliveSendFn: async (p) => {
            sentOptIn.push(p);
            return { ok: true };
          }
        });
        monOptIn.tick();
        await flushMicrotasks();
        assert.equal(sentOptIn.length, 1);
        assert.equal(sentOptIn[0].conversationId, "conv-optin-only");
      } finally {
        stVerify.close();
      }
    }

    // 6. Sidecar Frontend VM: multi-window targeting, exhausted capsule class, clamping `0`->`1`, & tab-switch isolation
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "3",
      className: "",
      style: {},
      dataset: { enabled: "1", used: "0", max: "3" },
      options: [],
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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

    let hostConvId = "conv-tab-a";
    const perConvServer = {
      "conv-tab-a": { enabled: true, maxCount: 3, usedCount: 3, lastError: "" },
      "conv-tab-b": { enabled: true, maxCount: 5, usedCount: 1, lastError: "" },
      "conv-other-window": { enabled: false, maxCount: 10, usedCount: 0, lastError: "" },
      __unbound__: { enabled: true, maxCount: 3, usedCount: 0, lastError: "" }
    };
    const actionBodies = [];

    const vmFetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      const reqConv = body.conversationId || "";
      if (url === "/api/watchdog/action") {
        actionBodies.push(body);
        const key = reqConv || "__unbound__";
        const cur = perConvServer[key] || { enabled: true, maxCount: 3, usedCount: 0, lastError: "" };
        if (body.action === "setTtlKeepalive") {
          if (body.enabled !== undefined) cur.enabled = Boolean(body.enabled);
          if (body.maxCount !== undefined) cur.maxCount = body.maxCount;
        } else if (body.action === "resetTtlKeepalive") {
          cur.usedCount = 0;
        }
        perConvServer[key] = cur;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            conversationId: key,
            status: {
              ok: true,
              enabled: true,
              ttlKeepalive: { conversationId: key, supported: true, leadSec: 30, ...cur },
              current: { conversationId: "conv-other-window", phase: "LLM_INFLIGHT", severity: "suspect" },
              sessions: [],
              alertingSessions: []
            }
          })
        };
      }
      if (url === "/api/watchdog") {
        const key = reqConv || "conv-other-window";
        const cur = perConvServer[key] || { enabled: true, maxCount: 3, usedCount: 0, lastError: "" };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            enabled: true,
            ttlKeepalive: { conversationId: key, supported: true, leadSec: 30, ...cur },
            current: { conversationId: "conv-other-window", phase: "LLM_INFLIGHT", severity: "suspect" },
            sessions: [],
            alertingSessions: []
          })
        };
      }
      if (url === "/api/cache-diag") {
        const key = reqConv || "conv-other-window";
        const cur = perConvServer[key] || { enabled: true, maxCount: 3, usedCount: 0, lastError: "" };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            transcriptFound: false,
            ttlKeepalive: { conversationId: key, leadSec: 30, ...cur }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const vmCtx = vm.createContext({
      window: {
        sidecar: {
          get conversationId() {
            return hostConvId;
          },
          fetch: vmFetch,
          ui: { toggleConversation() {} }
        },
        location: { search: "", href: "http://127.0.0.1:4321/" },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-tok" }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: vmFetch,
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
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

    const kaBtn = getEl("kv-keepalive-btn");
    const kaGrp = getEl("kv-keepalive-group");
    assert.equal(kaBtn.innerText, "自动续温：3/3");
    assert.equal(kaGrp.className, "keepalive-group is-on is-exhausted", "3/3 quota must apply is-exhausted capsule styling");

    // Toggle OFF and clamp "0" -> 1 on conv-tab-a: MUST target conv-tab-a, NEVER cachedWatchdog.current ("conv-other-window")!
    await vmCtx.changeTtlKeepaliveMax("0");
    assert.equal(actionBodies[actionBodies.length - 1].conversationId, "conv-tab-a");
    assert.equal(actionBodies[actionBodies.length - 1].maxCount, 1);

    await vmCtx.toggleTtlKeepalive();
    assert.equal(actionBodies[actionBodies.length - 1].conversationId, "conv-tab-a");
    assert.equal(kaBtn.innerText, "自动续温：关");
    assert.equal(kaGrp.className, "keepalive-group");
    assert.equal(perConvServer["conv-tab-b"].enabled, true, "conv-tab-b must remain ON");

    // Switch host tab to conv-tab-b -> sticky capsule immediately reflects conv-tab-b ("自动续温：1/5")!
    hostConvId = "conv-tab-b";
    await vmCtx.refreshData(true);
    assert.equal(kaBtn.innerText, "自动续温：1/5");
    assert.equal(kaGrp.className, "keepalive-group is-on");

    // Open brand-new empty tab (`hostConvId = ""`) while another window ("conv-other-window") is OFF:
    // The new tab follows the factory default without a custom window override.
    hostConvId = "";
    await vmCtx.refreshData(true);
    assert.equal(kaBtn.innerText, "自动续温：关");
    assert.equal(kaBtn.dataset.custom, "0");
    assert.equal(kaGrp.className, "keepalive-group");
  } finally {
    if (openStore) {
      try {
        openStore.close();
      } catch {}
    }
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise((resolve) => srv.close(resolve));
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("v1.5.4-ka-9: Review hardening — SidecarApp app.config.conversationId isolation, Turn-0 __unbound__ migration, pruneByTtl override preservation, out-of-order action race & setLanguage guard", async () => {
  const htmlSrc = readDashboardHtml();

  // 1. Responsive sticky .topbar layout: .topbar-pills is a direct sibling between .brand-group and .header-actions (no 3-row nesting)
  const headerStart = htmlSrc.indexOf('<header class="topbar">');
  const brandEnd = htmlSrc.indexOf("</div>", htmlSrc.indexOf('<div class="brand-group">', headerStart));
  const pillsStart = htmlSrc.indexOf('<div class="topbar-pills">', headerStart);
  const actionsStart = htmlSrc.indexOf('<div class="header-actions">', headerStart);
  assert.ok(
    brandEnd > headerStart && pillsStart > brandEnd && actionsStart > pillsStart,
    ".topbar-pills must be a sibling flex group between .brand-group and .header-actions"
  );
  assert.match(htmlSrc, /@media\s*\(max-width:\s*659px\)\s*\{[\s\S]*?\.topbar-pills\s*\{[\s\S]*?flex:\s*1\s+1\s+100%/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-hardening9-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();

  try {
    // 2. Real SidecarApp mode (`registerSidecarRoutes` with `app.config.conversationId = "conv-boot-window"`):
    //    empty Sidecar host tab (`conversationId: ""`, `fromSidecarHost: true`) MUST isolate to `__unbound__`
    //    and NEVER mutate or leak `conv-boot-window`!
    const routes = new Map();
    registerSidecarRoutes({
      config: { conversationId: "conv-boot-window" },
      api(routePath, handler) {
        routes.set(routePath, handler);
      }
    });

    assert.equal(routes.get("/api/cache-diag")({ fromSidecarHost: "bad" }).status, 400);
    assert.equal(routes.get("/api/watchdog")({ fromSidecarHost: 123 }).status, 400);
    assert.equal(routes.get("/api/watchdog/action")({ action: "setTtlKeepalive", fromSidecarHost: "bad" }).status, 400);

    const actUnbound = routes.get("/api/watchdog/action")({
      action: "setTtlKeepalive",
      enabled: false,
      maxCount: 7,
      conversationId: "",
      fromSidecarHost: true
    });
    assert.equal(actUnbound.ok, true);
    assert.equal(actUnbound.conversationId, "__unbound__", "Empty SidecarApp tab must NOT fall back to app.config.conversationId");
    assert.equal(actUnbound.ttlKeepaliveEnabled, false);
    assert.equal(actUnbound.ttlKeepaliveMaxCount, 7);

    const wdUnbound = routes.get("/api/watchdog")({
      scope: "conversation",
      conversationId: "",
      fromSidecarHost: true
    });
    const cdUnbound = routes.get("/api/cache-diag")({
      scope: "conversation",
      conversationId: "",
      fromSidecarHost: true
    });
    assert.equal(wdUnbound.ttlKeepalive.conversationId, "__unbound__");
    assert.equal(wdUnbound.ttlKeepalive.enabled, false);
    assert.equal(wdUnbound.ttlKeepalive.maxCount, 7);
    assert.equal(cdUnbound.transcriptFound, false, "Empty Sidecar tab must not load another window's transcript");
    assert.equal(cdUnbound.ttlKeepalive.conversationId, "__unbound__");
    assert.equal(cdUnbound.ttlKeepalive.enabled, false);
    assert.equal(cdUnbound.ttlKeepalive.maxCount, 7);

    const wdBoot = routes.get("/api/watchdog")({
      scope: "conversation",
      conversationId: "conv-boot-window",
      fromSidecarHost: true
    });
    assert.equal(wdBoot.ttlKeepalive.enabled, false, "conv-boot-window must follow the default OFF setting");
    assert.equal(wdBoot.ttlKeepalive.maxCount, 1, "conv-boot-window must stay untouched at default maxCount=1");

    closeRuntimeStore();

    // 3. Turn-0 atomic `__unbound__` claim:
    //    - Subagent and existing conversations NEVER steal `__unbound__`
    //    - Brand-new Turn-0 primary conversation inherits `{ enabled: false, maxCount: 7 }` and clears `__unbound__`
    {
      const stSeed = new ContextModeStore({ dbPath });
      writeWatchdogLease(stSeed, {
        conversationId: "conv-existing-win",
        rootSessionId: "conv-existing-win",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        updatedTs: Date.now()
      });
      assert.equal(
        stSeed.claimPendingUnboundTtlKeepalive("conv-existing-win"),
        null,
        "Existing conversation with lease must NEVER claim __unbound__"
      );
      stSeed.close();
    }

    const cleanHookEnv = { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath };
    delete cleanHookEnv.ANTIGRAVITY_SUBAGENT;
    delete cleanHookEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
    delete cleanHookEnv.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    delete cleanHookEnv.ANTIGRAVITY_CONVERSATION_ID;

    // Subagent invocation must NOT steal `__unbound__`
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-subagent-1",
        rootConversationId: "conv-boot-window",
        invocationNum: 0,
        lastUserInput: "run subagent check"
      }),
      encoding: "utf8",
      windowsHide: true,
      env: cleanHookEnv
    });

    // Brand-new Turn-0 primary conversation claims `__unbound__`!
    const rTurn0 = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-new-chat-1",
        invocationNum: 0,
        lastUserInput: "这是新窗口的第一条消息"
      }),
      encoding: "utf8",
      windowsHide: true,
      env: cleanHookEnv
    });
    assert.equal(rTurn0.status, 0);

    // 4. Stale `__unbound__` (>30m) expiry & `pruneByTtl()` preservation of explicit per-conversation overrides
    {
      const stCheck = new ContextModeStore({ dbPath });
      try {
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-new-chat-1"), false, "New chat Turn 0 must inherit pre-message OFF toggle");
        assert.equal(stCheck.getTtlKeepaliveMaxCount("conv-new-chat-1"), 7, "New chat Turn 0 must inherit pre-message maxCount=7");
        assert.equal(stCheck.getMeta("cache:ttl_keepalive_state:__unbound__", null), null, "__unbound__ must be cleared after Turn-0 claim");
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-subagent-1"), false);
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-next-chat-2"), false, "Subsequent new chat follows the default OFF setting");

        // Stale >30m `__unbound__` auto-expires on read
        const staleUnboundTs = Date.now() - 35 * 60 * 1000;
        stCheck.setTtlKeepaliveState("__unbound__", { enabled: false, maxCount: 9, updatedTs: staleUnboundTs });
        const expiredUnbound = stCheck.getTtlKeepaliveState("__unbound__");
        assert.equal(expiredUnbound.enabled, null, ">30m stale __unbound__ must expire cleanly");
        assert.equal(stCheck.getMeta("cache:ttl_keepalive_state:__unbound__", null), null);

        // `pruneByTtl` preserves explicit `enabled: false` / `maxCount: 8` while scrubbing stale `usedCount` & deleting default-only rows
        const oldTs = Date.now() - 20 * 24 * 3600 * 1000;
        stCheck.setTtlKeepaliveState("conv-custom-long", {
          enabled: false,
          maxCount: 8,
          usedCount: 2,
          lastError: "transient_err",
          updatedTs: oldTs
        });
        stCheck.setTtlKeepaliveState("conv-default-stale", {
          usedCount: 3,
          updatedTs: oldTs
        });

        stCheck.pruneByTtl({ maxAgeDays: 14 });
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-custom-long"), false, "pruneByTtl(14) must preserve explicit enabled=false");
        assert.equal(stCheck.getTtlKeepaliveMaxCount("conv-custom-long"), 8, "pruneByTtl(14) must preserve explicit maxCount=8");
        assert.equal(stCheck.getTtlKeepaliveState("conv-custom-long").usedCount, 0, "pruneByTtl(14) must scrub stale usedCount on preserved override");
        assert.equal(stCheck.getMeta("cache:ttl_keepalive_state:conv-default-stale", null), null, "pruneByTtl(14) must delete stale default-only counter row");

        stCheck.pruneByTtl({ maxAgeDays: 0 });
        assert.equal(stCheck.isTtlKeepaliveEnabled("conv-custom-long"), false, "pruneByTtl(0) must also preserve explicit per-window override");
        assert.equal(stCheck.getTtlKeepaliveMaxCount("conv-custom-long"), 8);
      } finally {
        stCheck.close();
      }
    }

    // 5. Frontend VM: out-of-order cross-window action race, optimistic toggle + HTTP 500 rollback, & setLanguage stale-cache guard
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "3",
      className: "",
      style: {},
      dataset: { enabled: "1", used: "0", max: "3" },
      options: [],
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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

    let hostConvId = "conv-race-a";
    let resolveDelayedActionA = null;
    let failNextAction = false;
    const serverKa = {
      "conv-race-a": { enabled: true, maxCount: 3, usedCount: 0, lastError: "" },
      "conv-race-b": { enabled: true, maxCount: 6, usedCount: 2, lastError: "" }
    };

    const vmFetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      const cid = body.conversationId || "";
      if (url === "/api/watchdog/action" && body.action === "setTtlKeepalive") {
        if (failNextAction) {
          failNextAction = false;
          return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        }
        if (cid === "conv-race-a" && !resolveDelayedActionA) {
          await new Promise((r) => {
            resolveDelayedActionA = r;
          });
        }
        const nextCur = { ...(serverKa[cid] || { enabled: true, maxCount: 3, usedCount: 0 }), enabled: Boolean(body.enabled) };
        serverKa[cid] = nextCur;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            conversationId: cid,
            status: {
              ok: true,
              enabled: true,
              ttlKeepalive: { conversationId: cid, supported: true, leadSec: 30, ...nextCur },
              current: { conversationId: cid, phase: "IDLE", severity: "idle" },
              sessions: [],
              alertingSessions: []
            }
          })
        };
      }
      if (url === "/api/watchdog") {
        const cur = serverKa[cid] || { enabled: false, maxCount: 4, usedCount: 0 };
        const respCid = serverKa[cid] ? cid : "conv-foreign";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            enabled: true,
            ttlKeepalive: { conversationId: respCid, supported: true, leadSec: 30, ...cur },
            current: { conversationId: respCid, phase: "IDLE", severity: "idle" },
            sessions: [],
            alertingSessions: []
          })
        };
      }
      if (url === "/api/cache-diag") {
        const cur = serverKa[cid] || { enabled: false, maxCount: 4, usedCount: 0 };
        const respCid = serverKa[cid] ? cid : "conv-foreign";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            transcriptFound: false,
            ttlKeepalive: { conversationId: respCid, leadSec: 30, ...cur }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const vmCtx = vm.createContext({
      window: {
        sidecar: {
          get conversationId() {
            return hostConvId;
          },
          fetch: vmFetch,
          ui: { toggleConversation() {} }
        },
        location: { search: "", href: "http://127.0.0.1:4321/" },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-tok" }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: vmFetch,
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
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

    const kaBtn = getEl("kv-keepalive-btn");
    assert.equal(kaBtn.innerText, "自动续温：0/3");

    // Start slow toggle OFF on conv-race-a -> optimistic UI updates immediately before fetch resolves!
    const pendingToggleA = vmCtx.toggleTtlKeepalive();
    assert.equal(kaBtn.innerText, "本窗续温：关", "Optimistic UI must update immediately on click with custom-override label");

    // Switch host tab to conv-race-b BEFORE conv-race-a's action resolves
    hostConvId = "conv-race-b";
    await vmCtx.refreshData(true);
    assert.equal(kaBtn.innerText, "自动续温：2/6");

    // Now let conv-race-a's stale action response resolve -> MUST NOT clobber conv-race-b's UI or cachedWatchdog!
    resolveDelayedActionA();
    await pendingToggleA;
    assert.equal(kaBtn.innerText, "自动续温：2/6", "Late response from conv-race-a must NEVER overwrite conv-race-b");

    // HTTP 500 failure rolls back optimistic toggle cleanly
    failNextAction = true;
    await vmCtx.toggleTtlKeepalive();
    assert.equal(kaBtn.innerText, "自动续温：2/6", "Failed toggle must roll back cleanly to 2/6");

    // Switch to unmapped tab where cachedWatchdog holds foreign conversationId, then switch language -> button updates to EN!
    hostConvId = "conv-unmapped-en";
    await vmCtx.refreshData(true);
    vmCtx.setLanguage("en", false);
    assert.equal(kaBtn.innerText, "Auto-Keepalive: 2/6", "setLanguage('en') must update button label even when cachedWatchdog belongs to another conversation");
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("v1.5.4-ka-10: Multi-layer subagent keepalive suppression — summary DB, transcript genesis, legacy lease self-heal, sendSidecarKeepaliveMessage firewall & Sidecar UI isolation", async () => {
  const htmlSrc = readDashboardHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-subagent-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const agRoot = path.join(tmpDir, "ag-host");
  const brainDir = path.join(agRoot, "brain");
  const sumDbPath = path.join(agRoot, "conversation_summaries.db");
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevSumDbEnv = process.env.AGY_DART_SUMMARY_DB_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  process.env.AGY_DART_SUMMARY_DB_PATH = sumDbPath;
  resetConfigCache();

  const writeTranscript = (cid, lines) => {
    const logDir = path.join(brainDir, cid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const txFile = path.join(logDir, "transcript_full.jsonl");
    fs.writeFileSync(txFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return txFile;
  };

  try {
    // 1. Unit checks: summary metadata, payload role variants (CamelCase DeepCoder*), & transcript genesis invariants
    assert.equal(isSubagentLeasePayload({ agentName: "DeepCoderWorkerL0" }), true);
    assert.equal(isSubagentLeasePayload({ agent_name: "DeepCoderImprovementWorker" }), true);
    assert.equal(isSubagentLeasePayload({ agentName: "self" }), true);
    assert.equal(isSubagentLeasePayload({ nestingDepth: 1 }), true);
    assert.equal(isSubagentLeasePayload({ agentName: "Antigravity" }), false);

    assert.equal(
      isSummaryMetadataSubagent({
        conversationId: "conv-human-1",
        parentConversationId: "",
        nestingDepth: 0,
        agentName: "",
        title: "正常主会话"
      }),
      false
    );
    assert.equal(
      isSummaryMetadataSubagent({
        conversationId: "conv-human-untitled",
        parentConversationId: "",
        nestingDepth: 0,
        agentName: "",
        title: ""
      }),
      false,
      "Untitled human CLI/GUI chat with empty agentName must NEVER be misclassified as subagent"
    );
    assert.equal(
      isSummaryMetadataSubagent({
        conversationId: "conv-host-titled",
        parentConversationId: "",
        nestingDepth: 0,
        agentName: "Antigravity",
        title: "宿主主对话"
      }),
      false
    );
    assert.equal(
      isSummaryMetadataSubagent({
        conversationId: "conv-sub-wf",
        parentConversationId: "",
        nestingDepth: 0,
        agentName: "self",
        title: ""
      }),
      true
    );
    assert.equal(
      isSummaryMetadataSubagent({
        conversationId: "conv-sub-custom",
        parentConversationId: "conv-human-1",
        nestingDepth: 1,
        agentName: "yoko_writer",
        title: ""
      }),
      true
    );

    // Transcript genesis: subagent vs parent receiving subagent reply vs minimalist 1-line test transcript
    const txGenesisSub = writeTranscript("conv-genesis-only-sub", [
      { step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", content: "[agy-dart startup snapshot]" },
      {
        step_index: 1,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: "[Message] timestamp=2026-11-22T16:43:53Z sender=0da20a24-a892-490e-a917-b5bde35f0278 content=<original_task>work</original_task>"
      },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 90000, cache_read_tokens: 80000, output_tokens: 50 }
    ]);
    assert.equal(detectSubagentFromTranscriptFile(txGenesisSub), true);

    // Oversized >256KB truncated Step-1 SYSTEM_MESSAGE genesis line
    const hugeDir = path.join(brainDir, "conv-genesis-oversized", ".system_generated", "logs");
    fs.mkdirSync(hugeDir, { recursive: true });
    const txOversizedSub = path.join(hugeDir, "transcript_full.jsonl");
    fs.writeFileSync(
      txOversizedSub,
      JSON.stringify({ step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", content: "boot" }) +
        "\n" +
        JSON.stringify({
          step_index: 1,
          source: "SYSTEM",
          type: "SYSTEM_MESSAGE",
          content: "<original_task>" + "x".repeat(320_000) + "</original_task>"
        }) +
        "\n",
      "utf8"
    );
    assert.equal(detectSubagentFromTranscriptFile(txOversizedSub), true, "Oversized >256KB subagent genesis line must still be detected");

    // Parent human conversation that later receives a `[Message] sender=...` from its subagent MUST stay false!
    const txHumanWithSubReply = writeTranscript("conv-human-with-sub-reply", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>/boost 继续</USER_REQUEST>" },
      { step_index: 1, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", content: "snapshot" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 120000, cache_read_tokens: 100000, output_tokens: 80 },
      {
        step_index: 3,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: "[Message] timestamp=2026-11-22T17:00:00Z sender=364af7c1-2f0b-46c3-974d-da72ad9a408a content=Subagent report"
      }
    ]);
    assert.equal(detectSubagentFromTranscriptFile(txHumanWithSubReply), false, "Primary human chat receiving subagent message later must NOT be flagged as subagent");

    const txMinimalMock = writeTranscript("conv-minimal-mock", [
      { type: "PLANNER_RESPONSE", input_tokens: 80000, cache_read_tokens: 70000, output_tokens: 40 }
    ]);
    assert.equal(detectSubagentFromTranscriptFile(txMinimalMock), false);
    assert.equal(
      detectSubagentFromTranscriptSteps([{ type: "PLANNER_RESPONSE", input_tokens: 80000 }], { isFromStart: true }),
      false
    );

    // 2. Populate realistic Antigravity `conversation_summaries.db` (plus legacy 3-column schema fallback check)
    {
      const legacyDbPath = path.join(tmpDir, "legacy_summaries.db");
      const legDb = new DatabaseSync(legacyDbPath);
      legDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT);");
      legDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run("conv-legacy-3col", "旧表结构", '["file:///e%3A/work"]');
      legDb.close();
      const legSum = lookupConversationSummary("conv-legacy-3col", { summaryDbPath: legacyDbPath, allowDefaultDb: false, checkSubagent: true });
      assert.equal(legSum.title, "旧表结构");
      assert.equal(legSum.isSubagent, false);
    }

    const sumDb = new DatabaseSync(sumDbPath);
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_uris TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL
      );
    `);
    const insSum = sumDb.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insSum.run("conv-primary-main", "主窗口会话", JSON.stringify(["file:///e%3A/work"]), "", "", 0);
    insSum.run("conv-primary-fresh", "新开主窗口", JSON.stringify(["file:///e%3A/work"]), "", "", 0);
    insSum.run("conv-sub-deepcoder", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoder", "conv-primary-main", 1);
    insSum.run("conv-sub-worker-l0", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoderWorkerL0", "conv-sub-deepcoder", 2);
    insSum.run("conv-sub-workflow-self", "", JSON.stringify(["file:///e%3A/work"]), "self", "", 0);
    insSum.run("conv-sub-legacy-idle", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoderImprovementWorker", "conv-primary-main", 2);
    sumDb.close();

    const txPrimaryMain = writeTranscript("conv-primary-main", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>继续优化</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 150000, cache_read_tokens: 140000, output_tokens: 120 }
    ]);
    const txSubWorker = writeTranscript("conv-sub-worker-l0", [
      { step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", content: "boot" },
      { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-11-22T16:43:53Z sender=conv-sub-deepcoder content=<original_task>fix</original_task>" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 180000, cache_read_tokens: 170000, output_tokens: 90 }
    ]);

    // 3. Turn-0 real `/boost` subagent (NO isSubagent / rootConversationId / finish prompt in stdin JSON!)
    //    MUST NOT steal `__unbound__`, MUST record `isSubagent: true`, and MUST NEVER be auto-kept-warm!
    {
      const stInit = new ContextModeStore({ dbPath });
      stInit.setTtlKeepaliveState("__unbound__", { enabled: false, maxCount: 9, updatedTs: Date.now() });
      stInit.close();
    }

    const hookEnv = {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_SUMMARY_DB_PATH: sumDbPath
    };
    delete hookEnv.ANTIGRAVITY_SUBAGENT;
    delete hookEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
    delete hookEnv.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    delete hookEnv.ANTIGRAVITY_CONVERSATION_ID;

    // Run PreInvocation + Stop on subagent `conv-sub-deepcoder` (realistic payload: empty lastUserInput, no parent field)
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: "conv-sub-deepcoder", invocationNum: 0, lastUserInput: "", cwd: "e:\\work\\agy-dart" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-sub-deepcoder", terminationReason: "NO_TOOL_CALL", cwd: "e:\\work\\agy-dart" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // Run Stop-only on `conv-sub-workflow-self` and genesis-only subagent `conv-genesis-only-sub`
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-sub-workflow-self", terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-genesis-only-sub", transcriptPath: txGenesisSub, terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // Now Turn-0 real human conversation `conv-primary-fresh` arrives -> `__unbound__` is STILL intact for it to claim!
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: "conv-primary-fresh", invocationNum: 0, lastUserInput: "你好，这是真实新主窗口" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // Run PreInvocation + Stop on `conv-primary-main` so it is IDLE in its keepalive window
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-primary-main",
        invocationNum: 0,
        lastUserInput: "继续优化",
        transcriptPath: txPrimaryMain,
        cwd: "e:\\work\\agy-dart"
      }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-primary-main", terminationReason: "NO_TOOL_CALL", cwd: "e:\\work\\agy-dart" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // 4. Seed a legacy mislabeled subagent lease (`isSubagent: false` already persisted in SQLite before upgrade!)
    //    + polluted `cache:ttl_keepalive_state:conv-sub-legacy-idle` (`enabled: true`), then verify both
    //    `WatchdogMonitor.tick()` AND `sanitizeModelTtlState()` block keepalive and heal `isSubagent -> true`!
    const baseNow = Date.now();
    {
      const stVerify = new ContextModeStore({ dbPath });
      try {
        assert.equal(
          stVerify.isTtlKeepaliveEnabled("conv-primary-fresh"),
          false,
          "Real primary Turn-0 chat must claim __unbound__ after subagent skipped it"
        );
        assert.equal(stVerify.getTtlKeepaliveMaxCount("conv-primary-fresh"), 9);

        const dcLease = readWatchdogLease(stVerify, "conv-sub-deepcoder");
        const wfLease = readWatchdogLease(stVerify, "conv-sub-workflow-self");
        const genLease = readWatchdogLease(stVerify, "conv-genesis-only-sub");
        assert.equal(dcLease?.isSubagent, true, "DeepCoder subagent lease must be marked isSubagent=true");
        assert.equal(dcLease?.parentConversationId, "conv-primary-main");
        assert.equal(wfLease?.isSubagent, true, "agent_name='self' workflow subagent lease must be marked isSubagent=true");
        assert.equal(genLease?.isSubagent, true, "Transcript-genesis subagent lease must be marked isSubagent=true");

        // Place all leases 280s in the past (20s remaining before 300s TTL -> inside 30s keepalive lead window!)
        const anchorPast = baseNow - 280_000;
        for (const cid of ["conv-primary-main", "conv-sub-deepcoder", "conv-sub-workflow-self", "conv-genesis-only-sub"]) {
          const cur = readWatchdogLease(stVerify, cid);
          writeWatchdogLease(stVerify, {
            ...cur,
            contextTokens: 160_000,
            cacheTtlSec: 300,
            idleAnchorTs: anchorPast,
            phaseChangedTs: anchorPast,
            updatedTs: anchorPast
          });
        }

        // Write a pre-existing legacy mislabeled subagent lease (`isSubagent: false`!) + explicit keepalive override
        writeWatchdogLease(stVerify, {
          conversationId: "conv-sub-legacy-idle",
          rootSessionId: "conv-sub-legacy-idle",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          stopReason: "NO_TOOL_CALL",
          contextTokens: 210_000,
          watermark: "critical",
          cacheTtlSec: 300,
          idleAnchorTs: anchorPast,
          phaseChangedTs: anchorPast,
          updatedTs: anchorPast
        });
        stVerify.setTtlKeepaliveState("conv-sub-legacy-idle", { enabled: true, usedCount: 1, updatedTs: anchorPast });

        const sentKeepalives = [];
        const desktopPopups = [];
        const mon = new WatchdogMonitor({
          getStore: () => stVerify,
          getConfig: () => ({
            stallWatchdog: true,
            ttlKeepalive: true,
            ttlKeepaliveMaxCount: 3,
            ttlKeepaliveLeadSec: 30,
            ttlDesktopNotify: true,
            watermarkDesktopNotify: true
          }),
          nowFn: () => baseNow,
          monoNsFn: () => 90_000_000_000n,
          notifyFn: (n) => {
            desktopPopups.push(n);
            return { dispatched: true };
          },
          keepaliveSendFn: async (p) => {
            sentKeepalives.push(p);
            return { ok: true };
          }
        });

        mon.tick();
        await flushMicrotasks();

        assert.equal(mon.statSyncCount, 0, "0 fs.statSync invariant when all leases are IDLE must hold");
        assert.equal(sentKeepalives.length, 1, "ONLY conv-primary-main may receive auto-keepalive; ALL 4 subagents must be suppressed");
        assert.equal(sentKeepalives[0].conversationId, "conv-primary-main");
        assert.equal(
          desktopPopups.some((n) => n.conversationId !== "conv-primary-main"),
          false,
          "Zero TTL/Watermark desktop notifications may fire for any subagent"
        );

        // Legacy mislabeled subagent lease was healed to `isSubagent: true` and its keepalive state row scrubbed!
        assert.equal(readWatchdogLease(stVerify, "conv-sub-legacy-idle")?.isSubagent, true);
        assert.equal(stVerify.getMeta("cache:ttl_keepalive_state:conv-sub-legacy-idle", null), null);

        // Also test `sanitizeModelTtlState()` directly on another mislabeled subagent lease
        writeWatchdogLease(stVerify, {
          conversationId: "conv-sub-worker-l0",
          rootSessionId: "conv-sub-worker-l0",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          transcriptPath: txSubWorker,
          updatedTs: anchorPast
        });
        stVerify.setTtlKeepaliveState("conv-sub-worker-l0", { enabled: true, maxCount: 5, updatedTs: anchorPast });
        const san = stVerify.sanitizeModelTtlState();
        assert.ok(san.healedSubagentLeases >= 1, "sanitizeModelTtlState must heal mislabeled subagent leases");
        const healedWorker = readWatchdogLease(stVerify, "conv-sub-worker-l0");
        assert.equal(healedWorker?.isSubagent, true);
        assert.equal(healedWorker?.parentConversationId, "conv-sub-deepcoder");
        assert.equal(stVerify.getMeta("cache:ttl_keepalive_state:conv-sub-worker-l0", null), null);
        assert.equal(stVerify.hasAnyExplicitTtlKeepaliveEnabled(), false);
      } finally {
        stVerify.close();
      }
    }

    // 5. `sendSidecarKeepaliveMessage` outbound firewall: blocks subagents via metadata RPC even without summary DB
    const rpcCalls = [];
    const mockExecFn = async (args) => {
      rpcCalls.push(args);
      if (args[0] === "get-conversation-metadata") {
        if (args[1] === "conv-rpc-sub-1") {
          return {
            response: {
              conversationMetadata: {
                metadata: {
                  projectId: "proj-sub",
                  agentName: "DeepCoderWorkerL0",
                  parentConversationId: "conv-primary-main",
                  nestingDepth: 2
                }
              }
            }
          };
        }
        return {
          response: {
            conversationMetadata: {
              metadata: {
                projectId: "proj-main",
                agentName: "",
                title: "正常主对话"
              }
            }
          }
        };
      }
      return { ok: true };
    };

    const resUnbound = await sendSidecarKeepaliveMessage("__unbound__", "OK", { execFn: mockExecFn, allowDefaultSummaryDb: false });
    assert.equal(resUnbound.ok, false);

    const resRpcSub = await sendSidecarKeepaliveMessage("conv-rpc-sub-1", "OK", { execFn: mockExecFn, allowDefaultSummaryDb: false });
    assert.equal(resRpcSub.ok, false);
    assert.equal(resRpcSub.skippedSubagent, true);
    assert.equal(
      rpcCalls.some((c) => c[0] === "send-message" && c[1] === "conv-rpc-sub-1"),
      false,
      "sendSidecarKeepaliveMessage must NEVER invoke agentapi send-message for a subagent"
    );

    const resRpcMain = await sendSidecarKeepaliveMessage("conv-rpc-main-1", "OK", { execFn: mockExecFn, allowDefaultSummaryDb: false });
    assert.equal(resRpcMain.ok, true);
    assert.equal(rpcCalls.some((c) => c[0] === "send-message" && c[1] === "conv-rpc-main-1"), true);

    // 6. Sidecar routes & Frontend VM: active subagent never hijacks app-scope keepalive target,
    //    and viewing a subagent tab shows `自动续温：已跳过` / `Auto-Keepalive: Skipped` with controls locked
    {
      const stActive = new ContextModeStore({ dbPath });
      const nowActive = Date.now();
      writeWatchdogLease(stActive, {
        conversationId: "conv-sub-worker-l0",
        rootSessionId: "conv-sub-deepcoder",
        parentConversationId: "conv-sub-deepcoder",
        isSubagent: true,
        phase: WATCHDOG_PHASES.LLM_INFLIGHT,
        subphase: "high_ctx",
        transcriptPath: txSubWorker,
        updatedTs: nowActive
      });
      stActive.close();
    }

    const routes = new Map();
    registerSidecarRoutes({
      config: { conversationId: "conv-primary-main" },
      api(routePath, handler) {
        routes.set(routePath, handler);
      }
    });

    const wdApp = routes.get("/api/watchdog")({ scope: "app", conversationId: "default" });
    assert.equal(wdApp.current?.conversationId, "conv-sub-worker-l0", "Active subagent is visible in watchdog current");
    assert.equal(
      wdApp.ttlKeepalive.conversationId,
      "conv-primary-main",
      "App-scope ttlKeepalive must target primary conversation, NEVER active subagent"
    );

    const wdSubExplicit = routes.get("/api/watchdog")({
      scope: "conversation",
      conversationId: "conv-sub-worker-l0",
      fromSidecarHost: true
    });
    const cdSubExplicit = routes.get("/api/cache-diag")({
      scope: "conversation",
      conversationId: "conv-sub-worker-l0",
      fromSidecarHost: true
    });
    assert.equal(wdSubExplicit.ttlKeepalive.isSubagent, true);
    assert.equal(wdSubExplicit.ttlKeepalive.enabled, false);
    assert.equal(wdSubExplicit.ttlKeepalive.supported, false);
    assert.equal(cdSubExplicit.ttlKeepalive.isSubagent, true);
    assert.equal(cdSubExplicit.ttlKeepalive.enabled, false);

    const actSub = routes.get("/api/watchdog/action")({
      action: "setTtlKeepalive",
      enabled: true,
      maxCount: 10,
      conversationId: "conv-sub-worker-l0",
      fromSidecarHost: true
    });
    assert.equal(actSub.isSubagent, true);
    assert.equal(actSub.ttlKeepaliveEnabled, false);

    // Frontend VM check for subagent tab -> primary tab transition & EN/ZH localization
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);
    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "3",
      disabled: false,
      className: "",
      style: {},
      dataset: { enabled: "1", used: "0", max: "3", subagent: "0" },
      options: [],
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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

    let hostConv = "conv-sub-worker-l0";
    let actionCalls = 0;
    const vmFetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (url === "/api/watchdog/action") {
        actionCalls += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const isSub = body.conversationId === "conv-sub-worker-l0";
      const kaPayload = isSub
        ? { conversationId: "conv-sub-worker-l0", enabled: false, supported: false, isSubagent: true, maxCount: 3, usedCount: 0, leadSec: 30 }
        : { conversationId: "conv-primary-main", enabled: true, supported: true, isSubagent: false, maxCount: 5, usedCount: 1, leadSec: 30 };
      if (url === "/api/watchdog") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            enabled: true,
            ttlKeepalive: kaPayload,
            current: { conversationId: body.conversationId, phase: "IDLE", severity: "idle" },
            sessions: [],
            alertingSessions: []
          })
        };
      }
      if (url === "/api/cache-diag") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, transcriptFound: false, ttlKeepalive: kaPayload })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const vmCtx = vm.createContext({
      window: {
        sidecar: {
          get conversationId() {
            return hostConv;
          },
          fetch: vmFetch,
          ui: { toggleConversation() {} }
        },
        location: { search: "", href: "http://127.0.0.1:4321/" },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-tok" }),
        querySelectorAll() { return []; },
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: vmFetch,
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
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

    const kaBtn = getEl("kv-keepalive-btn");
    const kaMax = getEl("kv-keepalive-max");
    assert.equal(kaBtn.innerText, "自动续温：已跳过");
    assert.equal(kaMax.disabled, true);
    assert.ok(kaBtn.title.includes("子智能体"), `Expected zh subagent tooltip, got: ${kaBtn.title}`);

    // Clicking toggle/max/reset on subagent tab is a strict no-op (0 action RPCs)
    await vmCtx.toggleTtlKeepalive();
    await vmCtx.changeTtlKeepaliveMax("8");
    await vmCtx.resetTtlKeepalive();
    assert.equal(actionCalls, 0, "Subagent tab must ignore keepalive mutations");

    vmCtx.setLanguage("en", false);
    assert.equal(kaBtn.innerText, "Auto-Keepalive: Skipped");

    // Switching back to primary conversation immediately re-enables capsule controls!
    vmCtx.setLanguage("zh", false);
    hostConv = "conv-primary-main";
    await vmCtx.refreshData(true);
    assert.equal(kaBtn.innerText, "自动续温：1/5");
    assert.equal(kaMax.disabled, false);
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevSumDbEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevSumDbEnv;
    resetConfigCache();
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("v1.5.4-ka-11: Review hardening — real CortexTrajectoryMetadata workflow firewall, zero negative-cache poisoning, Stop auto-txPath, custom-profile Turn-0 human safety, orphan keepalive scrub & standalone active-subagent UI guard", async () => {
  const htmlSrc = readDashboardHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-review-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const agRoot = path.join(tmpDir, "ag-host");
  const brainDir = path.join(agRoot, "brain");
  const sumDbPath = path.join(agRoot, "conversation_summaries.db");
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevSumDbEnv = process.env.AGY_DART_SUMMARY_DB_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  process.env.AGY_DART_SUMMARY_DB_PATH = sumDbPath;
  resetConfigCache();

  const writeTranscript = (cid, lines) => {
    const logDir = path.join(brainDir, cid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const txFile = path.join(logDir, "transcript_full.jsonl");
    fs.writeFileSync(txFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return txFile;
  };

  try {
    // 1. Role & HookArgsCommon (`payload.common`) coverage across lease + SessionStart
    assert.equal(isSubagentLeasePayload({ agentName: "browser" }), true);
    assert.equal(isSubagentLeasePayload({ agentName: "image-generator" }), true);
    assert.equal(isSubagentLeasePayload({ common: { agentName: "DeepCoder" } }), true);
    assert.equal(isSubagentLeasePayload({ common: { conversationId: "sub-c", rootConversationId: "root-p" } }), true);
    assert.equal(isSubagentLeasePayload({ common: { conversationId: "fork-1", rootConversationId: "root-p", isBattleMode: true } }), false);
    assert.equal(isSubagentLeasePayload({ subagentSpec: { name: "self" } }), true);
    assert.equal(isSessionStartSubagentPayload({ agentName: "DeepCoderWorkerL0" }), true);
    assert.equal(isSessionStartSubagentPayload({ agentName: "browser" }), true);
    assert.equal(isSessionStartSubagentPayload({ agentName: "self" }), true);
    assert.equal(isSessionStartSubagentPayload({ common: { nestingDepth: 2 } }), true);
    assert.equal(isSessionStartSubagentPayload({ agentName: "Antigravity" }), false);

    // Oversized >256KB step-0 SYSTEM_MESSAGE (parsedSteps.length === 0) must still classify as "subagent"
    const step0HugeDir = path.join(brainDir, "conv-step0-huge-sub", ".system_generated", "logs");
    fs.mkdirSync(step0HugeDir, { recursive: true });
    const txStep0Huge = path.join(step0HugeDir, "transcript_full.jsonl");
    fs.writeFileSync(
      txStep0Huge,
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: "<original_task>" + "z".repeat(320_000) + "</original_task>"
      }) + "\n",
      "utf8"
    );
    assert.equal(classifyTranscriptGenesisFile(txStep0Huge), "subagent");
    assert.equal(detectSubagentFromTranscriptFile(txStep0Huge), true);

    // 2. Real `exa.cortex_pb.CortexTrajectoryMetadata` outbound firewall (`agentapi get-conversation-metadata`)
    //    `/run-workflow` `agent(name="self")` omits parentConversationId, nestingDepth, and flat agentName —
    //    populating ONLY `subagentSpec` + `rootConversationId !== conversationId` + `agentScript` + `projectId`!
    const rpcLog = [];
    const realProtoExecFn = async (args) => {
      rpcLog.push(args);
      if (args[0] === "get-conversation-metadata") {
        const cid = args[1];
        if (cid === "a9ae0b3c-e78c-4d20-b4b1-2f8110bd8e60") {
          return {
            response: {
              conversationMetadata: {
                metadata: {
                  subagentSpec: { name: "self" },
                  rootConversationId: "683bb468-02c6-45c3-9947-dc93232de894",
                  agentScript: { item: 1 },
                  projectId: "proj-wf"
                }
              }
            }
          };
        }
        if (cid === "conv-root-only-sub") {
          return {
            response: {
              conversationMetadata: {
                metadata: {
                  rootConversationId: "683bb468-02c6-45c3-9947-dc93232de894",
                  projectId: "proj-root-only"
                }
              }
            }
          };
        }
        if (cid === "conv-battle-fork-human") {
          return {
            response: {
              conversationMetadata: {
                metadata: {
                  rootConversationId: "conv-battle-root",
                  isBattleModeFork: true,
                  projectId: "proj-battle"
                }
              }
            }
          };
        }
        return {
          response: {
            conversationMetadata: {
              metadata: {
                rootConversationId: cid,
                projectId: "proj-primary"
              }
            }
          }
        };
      }
      return { ok: true };
    };

    assert.equal(
      isTrajectoryMetadataSubagent("a9ae0b3c-e78c-4d20-b4b1-2f8110bd8e60", {
        metadata: {
          subagentSpec: { name: "self" },
          rootConversationId: "683bb468-02c6-45c3-9947-dc93232de894",
          projectId: "proj-wf"
        }
      }),
      true
    );

    const wfFirewallRes = await sendSidecarKeepaliveMessage("a9ae0b3c-e78c-4d20-b4b1-2f8110bd8e60", "OK", {
      execFn: realProtoExecFn,
      allowDefaultSummaryDb: false
    });
    assert.equal(wfFirewallRes.ok, false);
    assert.equal(wfFirewallRes.skippedSubagent, true, "/run-workflow subagentSpec/rootConversationId must be blocked by outbound firewall");
    assert.equal(
      rpcLog.some((c) => c[0] === "send-message" && c[1] === "a9ae0b3c-e78c-4d20-b4b1-2f8110bd8e60"),
      false
    );

    const rootOnlyRes = await sendSidecarKeepaliveMessage("conv-root-only-sub", "OK", {
      execFn: realProtoExecFn,
      allowDefaultSummaryDb: false
    });
    assert.equal(rootOnlyRes.skippedSubagent, true, "rootConversationId !== conversationId must block subagent keepalive");

    const battleRes = await sendSidecarKeepaliveMessage("conv-battle-fork-human", "OK", {
      execFn: realProtoExecFn,
      allowDefaultSummaryDb: false
    });
    assert.equal(battleRes.ok, true, "Battle-mode fork without subagentSpec must NOT be falsely blocked");

    // 3. Standalone `Stop` without `payload.transcriptPath` + Deferred Subagent Detection (zero negative-cache poisoning!)
    writeTranscript("conv-stop-auto-tx-sub", [
      { step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", content: "boot" },
      { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-11-22T18:00:00Z sender=0da20a24-a892-490e-a917-b5bde35f0278 content=<original_task>go</original_task>" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 90000, cache_read_tokens: 80000, output_tokens: 40 }
    ]);

    const sumDb = new DatabaseSync(sumDbPath);
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_uris TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL
      );
    `);
    const insSum = sumDb.prepare(
      "INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)"
    );
    // Custom-profile interactive human chat on Turn 0 BEFORE title generation (`title: ""`)
    insSum.run("conv-custom-profile-human", "", JSON.stringify(["file:///e%3A/work"]), "my-coding-buddy", "", 0);
    // Custom headless subagent (`title: ""`, `agent_name: "yoko_writer"`)
    insSum.run("conv-custom-headless-sub", "", JSON.stringify(["file:///e%3A/work"]), "yoko_writer", "", 0);
    // Orphan subagent keepalive row (no watchdog_lease)
    insSum.run("conv-orphan-sub-ka", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoderWorkerL0", "conv-custom-profile-human", 2);
    // Active subagent initially written by PreToolUse before summary check
    insSum.run("conv-active-sub-150s", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoder", "conv-custom-profile-human", 1);
    sumDb.close();

    {
      const stSeed = new ContextModeStore({ dbPath });
      stSeed.setTtlKeepaliveState("__unbound__", { enabled: true, maxCount: 7, updatedTs: Date.now() });
      stSeed.close();
    }

    const hookEnv = {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_SUMMARY_DB_PATH: sumDbPath
    };
    delete hookEnv.ANTIGRAVITY_SUBAGENT;
    delete hookEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
    delete hookEnv.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    delete hookEnv.ANTIGRAVITY_CONVERSATION_ID;

    // Stop WITHOUT `transcriptPath` in stdin JSON -> must auto-discover `<agRoot>/brain/conv-stop-auto-tx-sub/...`!
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-stop-auto-tx-sub", terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // Turn-0 human chat with custom `agent_name: "my-coding-buddy"` and `title: ""` + genuine `lastUserInput`
    writeTranscript("conv-custom-profile-human", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>帮我实现新的登录接口</USER_REQUEST>" }
    ]);
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-custom-profile-human",
        invocationNum: 0,
        lastUserInput: "帮我实现新的登录接口"
      }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // Now title generation completes for `conv-custom-profile-human`, and `Stop` runs on both it and `conv-custom-headless-sub`
    {
      const sdbUpdate = new DatabaseSync(sumDbPath);
      sdbUpdate.prepare("UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?").run(
        "实现新的登录接口",
        "conv-custom-profile-human"
      );
      sdbUpdate.close();
    }
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-custom-profile-human", terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-custom-headless-sub", terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    // Deferred subagent: Stop runs BEFORE summary row OR transcript exists on disk!
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-deferred-sub", terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });

    const t0 = Date.now();
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(
          readWatchdogLease(st, "conv-stop-auto-tx-sub")?.isSubagent,
          true,
          "Stop without payload.transcriptPath must still auto-resolve brain transcript and detect subagent"
        );
        assert.equal(
          readWatchdogLease(st, "conv-custom-profile-human")?.isSubagent,
          false,
          "Interactive Turn-0 human chat with custom agent_name must NOT be falsely branded isSubagent"
        );
        assert.equal(
          st.getTtlKeepaliveMaxCount("conv-custom-profile-human"),
          7,
          "Custom-profile human Turn-0 chat must claim __unbound__ maxCount=7"
        );
        assert.equal(
          readWatchdogLease(st, "conv-custom-headless-sub")?.isSubagent,
          true,
          "Headless custom subagent with empty title at Stop must be marked isSubagent=true"
        );

        // At t0, `conv-deferred-sub` has `isSubagent: false`, `transcriptPath: ""`, no summary row, no transcript file!
        assert.equal(readWatchdogLease(st, "conv-deferred-sub")?.isSubagent, false);

        // Seed orphan `cache:ttl_keepalive_state:conv-orphan-sub-ka` with NO `watchdog_lease:conv-orphan-sub-ka`
        st.setTtlKeepaliveState("conv-orphan-sub-ka", { enabled: true, maxCount: 6, updatedTs: t0 });
        assert.equal(
          st.hasAnyExplicitTtlKeepaliveEnabled(),
          true,
          "Primary human chat conv-custom-profile-human has explicit enabled=true"
        );
      } finally {
        st.close();
      }
    }

    // Clear `conv-custom-profile-human` explicit flag so ONLY `conv-orphan-sub-ka` has `enabled: true`,
    // proving `hasAnyExplicitTtlKeepaliveEnabled()` ignores orphan subagent rows and `sanitizeModelTtlState()` scrubs them!
    {
      const stOrphan = new ContextModeStore({ dbPath });
      try {
        stOrphan.clearTtlKeepaliveOverride("conv-custom-profile-human");
        assert.equal(
          stOrphan.hasAnyExplicitTtlKeepaliveEnabled(),
          false,
          "hasAnyExplicitTtlKeepaliveEnabled must return false when ONLY an orphan subagent has enabled=true"
        );
        stOrphan.sanitizeModelTtlState();
        assert.equal(
          stOrphan.getMeta("cache:ttl_keepalive_state:conv-orphan-sub-ka", null),
          null,
          "sanitizeModelTtlState must scrub orphan subagent keepalive state even without a watchdog_lease row"
        );
      } finally {
        stOrphan.close();
      }
    }

    // Now test negative-cache non-poisoning + active subagent 600s threshold upgrade + `stallWatchdog=false` primary fallback!
    {
      const stMon = new ContextModeStore({ dbPath });
      try {
        let clockMs = t0;
        let monoNs = 10_000_000_000n;
        const sentKeepalives = [];
        const popups = [];

        // Place `conv-deferred-sub` & `conv-custom-profile-human` at `t0` (just stopped)
        for (const cid of ["conv-deferred-sub", "conv-custom-profile-human"]) {
          const cur = readWatchdogLease(stMon, cid);
          writeWatchdogLease(stMon, {
            ...cur,
            contextTokens: 150_000,
            cacheTtlSec: 300,
            idleAnchorTs: t0,
            phaseChangedTs: t0,
            updatedTs: t0
          });
        }

        // Tick #1 at t0 + 5s BEFORE `conv-deferred-sub`'s summary row or transcript exists on disk!
        // Previously this permanently poisoned `_subagentIdentityCache.set("conv-deferred-sub", false)`!
        let wdEnabled = true;
        const mon = new WatchdogMonitor({
          getStore: () => stMon,
          getConfig: () => ({
            stallWatchdog: wdEnabled,
            watchdogDesktopNotify: true,
            ttlKeepalive: true,
            ttlKeepaliveMaxCount: 7,
            ttlKeepaliveLeadSec: 30,
            ttlDesktopNotify: true,
            watermarkDesktopNotify: true
          }),
          nowFn: () => clockMs,
          monoNsFn: () => monoNs,
          notifyFn: (n) => {
            popups.push(n);
            return { dispatched: true };
          },
          keepaliveSendFn: async (p) => {
            sentKeepalives.push(p);
            return { ok: true };
          }
        });

        clockMs = t0 + 5_000;
        monoNs += 5_000_000_000n;
        mon.tick();
        mon.getStatus({ conversationId: "conv-deferred-sub", scope: "conversation", refresh: false });

        // Now flush `conv-deferred-sub`'s transcript on disk (still NO `lease.transcriptPath` and NO summary row!)
        writeTranscript("conv-deferred-sub", [
          { step_index: 0, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", content: "boot" },
          { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-11-22T18:01:00Z sender=conv-custom-profile-human content=<original_task>deferred</original_task>" },
          { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 140000, cache_read_tokens: 130000, output_tokens: 50 }
        ]);

        // Advance to t0 + 280s (20s remaining <= 30s keepalive lead!) -> ONLY `conv-custom-profile-human` may fire!
        clockMs = t0 + 280_000;
        monoNs += 275_000_000_000n;
        mon.tick();
        await flushMicrotasks();

        assert.equal(mon.statSyncCount, 0, "0 fs.statSync invariant when all leases are IDLE must hold");
        assert.equal(sentKeepalives.length, 1, "Deferred subagent MUST NOT fire keepalive despite early inconclusive tick");
        assert.equal(sentKeepalives[0].conversationId, "conv-custom-profile-human");
        assert.equal(
          readWatchdogLease(stMon, "conv-deferred-sub")?.isSubagent,
          true,
          "Deferred subagent lease must self-heal to isSubagent=true once transcript flushes"
        );

        // Active subagent lease written with `isSubagent: false` (e.g., PreToolUse race) silent for 150s (>120s human, <600s subagent)
        writeWatchdogLease(stMon, {
          conversationId: "conv-active-sub-150s",
          rootSessionId: "conv-active-sub-150s",
          isSubagent: false,
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          subphase: "low_ctx",
          contextTokens: 40_000,
          startedTs: clockMs - 150_000,
          phaseChangedTs: clockMs - 150_000,
          updatedTs: clockMs - 150_000,
          lastHeartbeatTs: clockMs - 150_000
        });
        const popupsBeforeActive = popups.length;
        clockMs += 5_000;
        monoNs += 5_000_000_000n;
        const activeTick = mon.tick();
        const activeEval = activeTick.evaluated.find((e) => e.conversationId === "conv-active-sub-150s");
        assert.equal(activeEval?.isSubagent, true, "Active subagent lease must upgrade to isSubagent=true");
        assert.equal(activeEval?.bucket, "subagent_llm", "Active subagent must receive 600s subagent_llm threshold");
        assert.equal(activeEval?.severity, "active", "155s < 360s suspectSec on 600s subagent budget");
        assert.equal(popups.length, popupsBeforeActive, "Active subagent must NEVER fire 120s stalled desktop popup");

        // Disable stallWatchdog (`wdEnabled = false` clears `_lastEvaluated`) -> `getStatus({ scope: 'app' })` must STILL target primary!
        wdEnabled = false;
        clockMs += 5_000;
        monoNs += 5_000_000_000n;
        const disabledStatus = mon.getStatus({ scope: "app", refresh: true });
        assert.equal(
          disabledStatus.ttlKeepalive.conversationId,
          "conv-custom-profile-human",
          "getStatus(scope='app') with stallWatchdog=false must still resolve primary conversation from persisted leases"
        );
      } finally {
        stMon.close();
      }
    }

    // 4. Standalone UI VM (`!window.sidecar`): active subagent in `cachedWatchdog.current` must NEVER hijack
    //    `toggleWatchdogEnabled()` / `toggleTtlNotify()` into flipping the topbar capsule to `自动续温：已跳过`!
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);
    const elements = new Map();
    const makeEl = (id) => ({
      id,
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "3",
      disabled: false,
      className: "",
      style: {},
      dataset: { enabled: "1", used: "0", max: "3", subagent: "0" },
      options: [],
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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

    const standaloneActionBodies = [];
    const vmFetch = async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (url.startsWith("/api/watchdog/action")) {
        standaloneActionBodies.push(body);
        const queriedSub = body.conversationId === "conv-active-sub-150s";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            status: {
              ok: true,
              enabled: false,
              ttlKeepalive: queriedSub
                ? { conversationId: "conv-active-sub-150s", enabled: false, supported: false, isSubagent: true, maxCount: 3, usedCount: 0, leadSec: 30 }
                : { conversationId: "conv-custom-profile-human", enabled: true, supported: true, isSubagent: false, maxCount: 7, usedCount: 2, leadSec: 30 },
              current: { conversationId: "conv-active-sub-150s", isSubagent: true, phase: "LLM_INFLIGHT", severity: "active" },
              sessions: [],
              alertingSessions: []
            }
          })
        };
      }
      if (url.startsWith("/api/watchdog")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            enabled: true,
            ttlKeepalive: { conversationId: "conv-custom-profile-human", enabled: true, supported: true, isSubagent: false, maxCount: 7, usedCount: 2, leadSec: 30 },
            current: { conversationId: "conv-active-sub-150s", isSubagent: true, phase: "LLM_INFLIGHT", severity: "active" },
            sessions: [],
            alertingSessions: []
          })
        };
      }
      if (url.startsWith("/api/cache-diag")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            transcriptFound: true,
            resolvedConversationId: "conv-active-sub-150s",
            ttlKeepalive: { conversationId: "conv-custom-profile-human", enabled: true, supported: true, isSubagent: false, maxCount: 7, usedCount: 2, leadSec: 30 }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const vmCtx = vm.createContext({
      window: {
        location: { search: "", href: "http://127.0.0.1:4321/" },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-tok" }),
        querySelectorAll() { return []; },
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: vmFetch,
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

    const kaBtn = getEl("kv-keepalive-btn");
    assert.equal(kaBtn.innerText, "自动续温：2/7");

    await vmCtx.toggleWatchdogEnabled();
    await vmCtx.toggleTtlNotify();
    assert.equal(
      standaloneActionBodies.some((b) => b.conversationId === "conv-active-sub-150s"),
      false,
      "Non-incident watchdog actions must NEVER pass active subagent ID from cachedWatchdog.current"
    );
    assert.equal(
      kaBtn.innerText,
      "自动续温：2/7",
      "Toggling watchdog/notify while subagent is active must NOT clobber primary keepalive capsule to Skipped"
    );

    // 5. Killed conversation firewall (`killed = 1` in summary DB & metadata) + `PreToolUse` zero-deny on independent subagents!
    {
      const sdbKill = new DatabaseSync(sumDbPath);
      sdbKill.exec("ALTER TABLE conversation_summaries ADD COLUMN killed INTEGER NOT NULL DEFAULT 0;");
      sdbKill
        .prepare("INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth, killed) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("conv-killed-primary", "已终止对话", JSON.stringify(["file:///e%3A/work"]), "", "", 0, 1);
      sdbKill
        .prepare("INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth, killed) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("conv-pretool-worker", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoderWorkerL0", "conv-custom-profile-human", 2, 0);
      sdbKill.close();

      const killedSum = lookupConversationSummary("conv-killed-primary", { summaryDbPath: sumDbPath, allowDefaultDb: false });
      assert.equal(killedSum.killed, true, "lookupConversationSummary must read killed=1 from conversation_summaries");

      let sendApiCalls = 0;
      const killedSendRes = await sendSidecarKeepaliveMessage(
        "conv-killed-primary",
        "[agy-dart TTL保活 1/3] 仅回复 OK",
        {
          allowDefaultSummaryDb: true,
          execFn: async (cmdArgs) => {
            if (cmdArgs[0] === "send-message") sendApiCalls += 1;
            return {};
          }
        }
      );
      assert.equal(killedSendRes.ok, false);
      assert.equal(killedSendRes.skippedKilled, true, "Killed conversation must be suppressed before send-message");
      assert.equal(sendApiCalls, 0, "send-message must NEVER execute on killed conversation");

      const metaKilledRes = await sendSidecarKeepaliveMessage(
        "conv-killed-meta-only",
        "[agy-dart TTL保活 1/3] 仅回复 OK",
        {
          allowDefaultSummaryDb: false,
          execFn: async (cmdArgs) => {
            if (cmdArgs[0] === "get-conversation-metadata") {
              return { response: { conversationMetadata: { killed: 1, title: "Killed via Metadata" } } };
            }
            if (cmdArgs[0] === "send-message") sendApiCalls += 1;
            return {};
          }
        }
      );
      assert.equal(metaKilledRes.skippedKilled, true, "Metadata killed=1 must also block send-message");
      assert.equal(sendApiCalls, 0);

      // WatchdogMonitor self-heals killed lease to USER_CANCELED without retrying or firing TTL alert
      const stKill = new ContextModeStore({ dbPath });
      try {
        const nowKill = Date.now();
        writeWatchdogLease(stKill, {
          conversationId: "conv-killed-primary",
          rootSessionId: "conv-killed-primary",
          isSubagent: false,
          convTitle: "已终止对话",
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          stopReason: "NO_TOOL_CALL",
          contextTokens: 150_000,
          cacheTtlSec: 300,
          idleAnchorTs: nowKill - 280_000,
          phaseChangedTs: nowKill - 280_000,
          updatedTs: nowKill - 280_000
        });
        const killPopups = [];
        const monKill = new WatchdogMonitor({
          getStore: () => stKill,
          getConfig: () => ({
            stallWatchdog: true,
            ttlKeepalive: true,
            ttlKeepaliveMaxCount: 3,
            ttlKeepaliveLeadSec: 30,
            ttlDesktopNotify: true
          }),
          nowFn: () => nowKill,
          notifyFn: (n) => {
            killPopups.push(n);
            return { dispatched: true };
          },
          keepaliveSendFn: ({ conversationId, message }) =>
            sendSidecarKeepaliveMessage(conversationId, message, { allowDefaultSummaryDb: true, execFn: async () => ({}) })
        });
        monKill.tick();
        await flushMicrotasks();
        assert.equal(readWatchdogLease(stKill, "conv-killed-primary")?.stopReason, "USER_CANCELED");
        assert.equal(stKill.getMeta("cache:ttl_keepalive_state:conv-killed-primary", null), null);
        assert.equal(killPopups.length, 0);
      } finally {
        stKill.close();
      }

      // Independent subagent (`conv-pretool-worker` with NO subagent flags in PreToolUse payload!)
      // MUST allow >60 KB source, >25 KB .log, unchanged re-read, and diff-read on FIRST call (0 red hook denials!),
      // while still enforcing sensitiveFileGuard & strict mode, and keeping primary chat 45 KB guard intact!
      const bigSubSrc = path.join(tmpDir, "sub_worker_70k.js");
      fs.writeFileSync(
        bigSubSrc,
        Array.from({ length: 1100 }, (_, idx) => `export const line_${idx} = "${"w".repeat(52)}";`).join("\n") + "\n",
        "utf8"
      );
      const bigSubLog = path.join(tmpDir, "sub_worker_30k.log");
      fs.writeFileSync(
        bigSubLog,
        Array.from({ length: 700 }, (_, idx) => `INFO worker step ${idx} ${"z".repeat(36)}`).join("\n") + "\n",
        "utf8"
      );
      const subEnvFile = path.join(tmpDir, ".env");
      fs.writeFileSync(subEnvFile, "SECRET_KEY=sub_test_secret\n", "utf8");
      const diffCfgPath = path.join(tmpDir, "diff_on.json");
      fs.writeFileSync(diffCfgPath, JSON.stringify({ diffRead: true }), "utf8");

      const runPreTool = (pl, extraEnv = {}) => {
        const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
          input: JSON.stringify(pl),
          encoding: "utf8",
          windowsHide: true,
          env: { ...hookEnv, ...extraEnv }
        });
        assert.equal(res.status, 0, res.stderr);
        return JSON.parse(res.stdout.trim());
      };

      // 1st read of 70 KB source & 30 KB .log by real subagent `conv-pretool-worker` -> immediate allow!
      assert.equal(
        runPreTool({ conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSubSrc } } }).decision,
        "allow",
        "Independent subagent reading >45 KB source must allow immediately without hook error"
      );
      assert.equal(
        runPreTool({ conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSubLog } } }).decision,
        "allow",
        "Independent subagent reading >16 KB .log in soft mode must allow immediately without hook error"
      );
      // Unchanged 2nd re-read & diffRead modified re-read on independent subagent -> immediate allow!
      const medSubSrc = path.join(tmpDir, "sub_worker_12k.js");
      const medLines = Array.from({ length: 240 }, (_, idx) => `export const m_${idx} = "${"a".repeat(36)}";`);
      fs.writeFileSync(medSubSrc, medLines.join("\n") + "\n", "utf8");
      assert.equal(
        runPreTool(
          { conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: medSubSrc } } },
          { AGY_DART_CONFIG_PATH: diffCfgPath }
        ).decision,
        "allow"
      );
      assert.equal(
        runPreTool(
          { conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: medSubSrc } } },
          { AGY_DART_CONFIG_PATH: diffCfgPath }
        ).decision,
        "allow",
        "Independent subagent unchanged re-read must NOT throw read-dedup pre-tool hook error"
      );
      medLines[10] = 'export const m_10 = "MODIFIED_LINE";';
      fs.writeFileSync(medSubSrc, medLines.join("\n") + "\n", "utf8");
      assert.equal(
        runPreTool(
          { conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: medSubSrc } } },
          { AGY_DART_CONFIG_PATH: diffCfgPath }
        ).decision,
        "allow",
        "Independent subagent modified re-read must NOT throw diff-read pre-tool hook error"
      );

      // Sensitive file guard & strict mode STILL protect even independent subagents!
      assert.equal(
        runPreTool(
          { conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: subEnvFile } } },
          { AGY_DART_SENSITIVE_FILE_GUARD: "warn" }
        ).decision,
        "deny",
        "Sensitive .env guard must still warn on independent subagents"
      );
      assert.equal(
        runPreTool(
          { conversationId: "conv-pretool-worker", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSubSrc } } },
          { AGY_DART_READ_GUARD_MODE: "strict" }
        ).decision,
        "deny",
        "Explicit strict readGuardMode must still enforce size cap on subagents"
      );

      // Primary human conversation (`conv-custom-profile-human`) STILL gets normal 45 KB guard!
      assert.equal(
        runPreTool({ conversationId: "conv-custom-profile-human", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSubSrc } } }).decision,
        "deny",
        "Primary human conversation must keep 45 KB read_file size guard intact"
      );
    }
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevSumDbEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevSumDbEnv;
    resetConfigCache();
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("v1.5.4-ka-12: Adversarial hardening — PreToolUse agentName/isSubagent without parentId, minified dense slice, post-#1 killed firewall, killed popup suppression & cross-process Monitor dedup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v154-ka12-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const sumDbPath = path.join(tmpDir, "conversation_summaries.db");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevSumDbEnv = process.env.AGY_DART_SUMMARY_DB_PATH;

  fs.writeFileSync(cfgPath, JSON.stringify({ stallWatchdog: true, ttlKeepalive: true, ttlDesktopNotify: true }), "utf8");
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  process.env.AGY_DART_SUMMARY_DB_PATH = sumDbPath;
  resetConfigCache();
  closeRuntimeStore();

  try {
    const sumDb = new DatabaseSync(sumDbPath);
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_uris TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL,
        nesting_depth INTEGER NOT NULL,
        killed INTEGER NOT NULL DEFAULT 0
      );
    `);
    const ins = sumDb.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth, killed) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    ins.run("conv-primary-main", "主窗口正常对话", JSON.stringify(["file:///e%3A/work"]), "", "", 0, 0);
    ins.run("conv-indep-worker", "", JSON.stringify(["file:///e%3A/work"]), "DeepCoderWorkerL0", "conv-primary-main", 2, 0);
    ins.run("conv-killed-exhausted", "已满3次后终止的对话", JSON.stringify(["file:///e%3A/work"]), "", "", 0, 1);
    sumDb.close();

    const hookEnv = {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_SUMMARY_DB_PATH: sumDbPath
    };
    delete hookEnv.ANTIGRAVITY_SUBAGENT;
    delete hookEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
    delete hookEnv.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    delete hookEnv.ANTIGRAVITY_CONVERSATION_ID;

    const runPreTool = (pl, extraEnv = {}) => {
      const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
        input: JSON.stringify(pl),
        encoding: "utf8",
        windowsHide: true,
        env: { ...hookEnv, ...extraEnv }
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout.trim());
    };

    const bigSrc = path.join(tmpDir, "big_worker_68k.js");
    fs.writeFileSync(
      bigSrc,
      Array.from({ length: 1050 }, (_, idx) => `export const v_${idx} = "${"q".repeat(52)}";`).join("\n") + "\n",
      "utf8"
    );
    const denseJs = path.join(tmpDir, "dense_vendor_bundle.js");
    fs.writeFileSync(denseJs, `${"var a=1;".repeat(3200)}\n${"var b=2;".repeat(3200)}\n${"var c=3;".repeat(3200)}\n`, "utf8");

    // 1. Independent child subagent WITH `agentName` / `isSubagent: true` in payload (no parentConversationId, no subagentId)
    //    MUST still resolve as independent subagent (`allow` on 1st call + `isSubagent: true` on its lease)!
    assert.equal(
      runPreTool({
        conversationId: "conv-indep-worker",
        agentName: "DeepCoderWorkerL0",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: bigSrc } }
      }).decision,
      "allow",
      "Independent subagent with agentName in payload (no parentConversationId) must NOT short-circuit to false"
    );
    {
      const stCheck = new ContextModeStore({ dbPath });
      try {
        const wLease = readWatchdogLease(stCheck, "conv-indep-worker");
        assert.equal(wLease?.isSubagent, true, "Independent subagent lease must be tagged isSubagent=true, never suppressed");
        assert.equal(wLease?.parentConversationId, "conv-primary-main");
      } finally {
        stCheck.close();
      }
    }

    // Inline subagent sharing `conv-primary-main` WITHOUT `subagentId` (`{ conversationId: "conv-primary-main", subagent: true }`)
    // MUST still guard `bigSrc` AND keep `conv-primary-main` lease `isSubagent: false`!
    assert.equal(
      runPreTool({
        conversationId: "conv-primary-main",
        subagent: true,
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: bigSrc } }
      }).decision,
      "deny",
      "Inline subagent sharing primary conversationId must keep read guard"
    );
    {
      const stCheck2 = new ContextModeStore({ dbPath });
      try {
        assert.equal(
          readWatchdogLease(stCheck2, "conv-primary-main")?.isSubagent,
          false,
          "Inline subagent sharing primary conversationId must NEVER flip primary lease to isSubagent=true"
        );
      } finally {
        stCheck2.close();
      }
    }

    // 2. Dense single-line/minified slice (`isMinifiedDenseSlice === true`):
    //    - Independent subagent in soft mode -> `allow`
    //    - Independent subagent in strict mode -> `deny`
    //    - Primary human conversation in soft mode -> HardDeny (both 1st and 2nd strike deny!)
    assert.equal(
      runPreTool({
        conversationId: "conv-indep-worker",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: denseJs, StartLine: 1, EndLine: 2 } }
      }).decision,
      "allow",
      "Independent subagent reading >45 KB dense minified slice in soft mode must allow (host caps at 45 KiB)"
    );
    assert.equal(
      runPreTool(
        {
          conversationId: "conv-indep-worker",
          cwd: tmpDir,
          toolCall: { name: "read_file", args: { Path: denseJs, StartLine: 1, EndLine: 2 } }
        },
        { AGY_DART_READ_GUARD_MODE: "strict" }
      ).decision,
      "deny",
      "Explicit strict mode must still deny dense minified slice on subagent"
    );
    assert.equal(
      runPreTool({
        conversationId: "conv-primary-main",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: denseJs, StartLine: 1, EndLine: 2 } }
      }).decision,
      "deny"
    );
    assert.equal(
      runPreTool({
        conversationId: "conv-primary-main",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: denseJs, StartLine: 1, EndLine: 2 } }
      }).decision,
      "deny",
      "Primary human conversation must HardDeny >45 KB dense minified slice without 2-strike bypass"
    );

    // 3. Post-Keepalive-#1 killed transition (`_convProjectIdCache` already populated on #1 -> `killed: 1` on #2 MUST block `send-message`!)
    let liveKilled = 0;
    let sendCallsAfterCache = 0;
    const execKillMidCycle = async (cmdArgs, opts) => {
      if (cmdArgs[0] === "get-conversation-metadata") {
        return {
          response: {
            conversationMetadata: {
              killed: liveKilled,
              metadata: { projectId: "proj-cached-77" }
            }
          }
        };
      }
      if (cmdArgs[0] === "send-message") {
        sendCallsAfterCache += 1;
        assert.equal(opts.projectId, "proj-cached-77");
      }
      return { ok: true };
    };
    const ka1 = await sendSidecarKeepaliveMessage("conv-midcycle-kill", "[agy-dart TTL保活 1/3] OK", {
      allowDefaultSummaryDb: false,
      execFn: execKillMidCycle
    });
    assert.equal(ka1.ok, true);
    assert.equal(sendCallsAfterCache, 1);

    liveKilled = 1;
    const ka2 = await sendSidecarKeepaliveMessage("conv-midcycle-kill", "[agy-dart TTL保活 2/3] OK", {
      allowDefaultSummaryDb: false,
      execFn: execKillMidCycle
    });
    assert.equal(ka2.ok, false);
    assert.equal(ka2.skippedKilled, true, "Post-#1 killed=1 metadata must NOT be bypassed by cached projectId");
    assert.equal(sendCallsAfterCache, 1, "send-message must NOT execute after conversation becomes killed=1");

    // 4. Killed conversation (`conv-killed-exhausted`) with exhausted 3/3 keepalives & critical watermark:
    //    MUST NOT fire TTL or Watermark desktop popups, and `sanitizeModelTtlState` must self-heal killed leases!
    const st = new ContextModeStore({ dbPath });
    try {
      const baseNow = Date.now();
      writeWatchdogLease(st, {
        conversationId: "conv-killed-exhausted",
        rootSessionId: "conv-killed-exhausted",
        isSubagent: false,
        convTitle: "已满3次后终止的对话",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: 420_000,
        windowTokens: 512_000,
        watermark: "critical",
        cacheTtlSec: 300,
        idleAnchorTs: baseNow - 260_000,
        phaseChangedTs: baseNow - 260_000,
        updatedTs: baseNow - 260_000
      });
      st.setTtlKeepaliveState("conv-killed-exhausted", {
        usedCount: 3,
        maxCount: 3,
        lastIdleAnchorTs: baseNow - 560_000,
        lastSentTs: baseNow - 290_000,
        pendingAck: false,
        updatedTs: baseNow - 290_000
      });

      const killedPopups = [];
      const monKilledPopup = new WatchdogMonitor({
        getStore: () => st,
        getConfig: () => ({
          stallWatchdog: true,
          ttlKeepalive: true,
          ttlKeepaliveMaxCount: 3,
          ttlDesktopNotify: true,
          watermarkDesktopNotify: true
        }),
        nowFn: () => baseNow,
        notifyFn: (n) => {
          killedPopups.push(n);
          return { dispatched: true };
        },
        keepaliveSendFn: async () => ({ ok: true })
      });
      monKilledPopup.tick();
      assert.equal(killedPopups.length, 0, "Killed conversation must NEVER fire exhausted TTL or critical watermark desktop popups");
      assert.equal(readWatchdogLease(st, "conv-killed-exhausted")?.stopReason, "USER_CANCELED");
      assert.equal(st.getMeta("cache:ttl_keepalive_state:conv-killed-exhausted", null), null);

      // Reset stopReason & re-seed keepalive state to verify sanitizeModelTtlState() also heals killed primary leases
      writeWatchdogLease(st, {
        ...readWatchdogLease(st, "conv-killed-exhausted"),
        stopReason: "NO_TOOL_CALL"
      });
      st.setTtlKeepaliveState("conv-killed-exhausted", { usedCount: 1, updatedTs: baseNow });
      st.sanitizeModelTtlState();
      assert.equal(readWatchdogLease(st, "conv-killed-exhausted")?.stopReason, "USER_CANCELED");
      assert.equal(st.getMeta("cache:ttl_keepalive_state:conv-killed-exhausted", null), null);

      // 5. Cross-process deduplication: TWO concurrent WatchdogMonitor instances polling the same SQLite DB
      //    MUST fire at most 1 keepalive AND at most 1 TTL desktop notification for the same `(conversationId, idleAnchorTs)`!
      const anchorDual = baseNow - 280_000;
      writeWatchdogLease(st, {
        conversationId: "conv-primary-main",
        rootSessionId: "conv-primary-main",
        isSubagent: false,
        convTitle: "主窗口正常对话",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: 180_000,
        cacheTtlSec: 300,
        idleAnchorTs: anchorDual,
        phaseChangedTs: anchorDual,
        updatedTs: anchorDual
      });

      const dualSent = [];
      const dualPopups = [];
      const makeDualMon = () =>
        new WatchdogMonitor({
          getStore: () => st,
          getConfig: () => ({
            stallWatchdog: true,
            ttlKeepalive: true,
            ttlKeepaliveMaxCount: 3,
            ttlKeepaliveLeadSec: 30,
            ttlDesktopNotify: true
          }),
          nowFn: () => baseNow,
          notifyFn: (n) => {
            dualPopups.push(n);
            return { dispatched: true };
          },
          keepaliveSendFn: async (p) => {
            dualSent.push(p);
            return { ok: true };
          }
        });
      const monA = makeDualMon();
      const monB = makeDualMon();
      monA.tick();
      monB.tick();
      await flushMicrotasks();
      assert.equal(dualSent.length, 1, "Two concurrent WatchdogMonitor instances must NOT double-send keepalive");

      // Muted windows must not consume the shared popup claim. Re-enabling allows one notification.
      const anchorPopupDual = baseNow - 255_000;
      writeWatchdogLease(st, {
        ...readWatchdogLease(st, "conv-primary-main"),
        idleAnchorTs: anchorPopupDual,
        phaseChangedTs: anchorPopupDual,
        updatedTs: anchorPopupDual
      });
      const makePopupMon = () =>
        new WatchdogMonitor({
          getStore: () => st,
          getConfig: () => ({
            stallWatchdog: true,
            ttlKeepalive: false,
            ttlDesktopNotify: true,
            ttlNotifyLeadSec: 60
          }),
          nowFn: () => baseNow,
          notifyFn: (n) => {
            dualPopups.push(n);
            return { dispatched: true };
          }
        });
      const pMonA = makePopupMon();
      const pMonB = makePopupMon();
      pMonA.tick();
      pMonB.tick();
      assert.equal(dualPopups.length, 0, "Both monitors must remain silent while warming is off");
      st.setTtlKeepaliveEnabled(true, "conv-primary-main");
      pMonA.tick();
      pMonB.tick();
      assert.equal(dualPopups.length, 1, "Two concurrent WatchdogMonitor instances must NOT fire duplicate TTL desktop popups");
    } finally {
      st.close();
    }

    // 6. SidecarApp backend mtime auto-reload: touching watched backend file causes clean exit(0) for `restart_policy: "always"`
    const watchSentinel = path.join(tmpDir, "watched-backend-sentinel.mjs");
    fs.writeFileSync(watchSentinel, "export const v = 1;\n", "utf8");
    const reloadPort = await new Promise((resolve, reject) => {
      const probeSrv = http.createServer();
      probeSrv.once("error", reject);
      probeSrv.listen(0, "127.0.0.1", () => {
        const p = probeSrv.address().port;
        probeSrv.close(() => resolve(p));
      });
    });
    // Supply the SidecarApp lifecycle contract even on CI machines without Antigravity.
    const sdkHome = path.join(tmpDir, "reload-home");
    const sdkDir = path.join(sdkHome, ".gemini/config/node_modules/sidecar_sdk");
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, "index.mjs"), `export class SidecarApp {
      config = {};
      api() {}
      page() {}
      async run() { this.timer = setInterval(() => {}, 1000); }
      async close() { clearInterval(this.timer); }
    }`);
    const reloadChild = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...hookEnv,
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
        ANTIGRAVITY_CSRF_TOKEN: "csrf-reload-test",
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(reloadPort),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "ui-tok-reload-test",
        HOME: sdkHome, USERPROFILE: sdkHome,
        AGY_DART_SIDECAR_WATCH_FILE: watchSentinel,
        AGY_DART_SIDECAR_RELOAD_POLL_MS: "180",
        AGY_DART_DISABLE_COMPILE_CACHE: "1"
      }
    });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Sidecar reload child startup timeout")), 5000);
        reloadChild.stdout.on("data", (chunk) => {
          const s = chunk.toString("utf8");
          if (s.includes("listening on") || s.includes("registered and running")) {
            clearTimeout(t);
            resolve();
          }
        });
        reloadChild.once("exit", (code) => {
          clearTimeout(t);
          reject(new Error(`Sidecar reload child exited prematurely: ${code}`));
        });
      });

      const bumpedSec = Math.floor(Date.now() / 1000) + 10;
      fs.utimesSync(watchSentinel, bumpedSec, bumpedSec);

      const exitCode = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Sidecar auto-reload did not exit(0) after mtime update")), 4000);
        reloadChild.once("exit", (code) => {
          clearTimeout(t);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0, "SidecarApp must exit cleanly with code 0 when watched backend files update");
    } finally {
      if (reloadChild.exitCode === null) {
        try {
          reloadChild.kill();
        } catch {}
      }
    }
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevSumDbEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevSumDbEnv;
    resetConfigCache();
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});

test("v1.5.4-ka-13: Global keepalive maxCount (0..20), per-window override vs follow-global, zero-statSync when 0, sanitize/prune survival & Sidecar VM", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-global-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();

  let srv = null;
  try {
    // 1. Store-level global inheritance, custom override isolation, 0-count OFF semantics & survival across sanitize/prune/clear
    const st = new ContextModeStore({ dbPath });
    try {
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(), 0);
      assert.equal(st.getFallbackNonZeroKeepaliveMaxCount(), 1);
      assert.equal(st.isTtlKeepaliveEnabled("conv-win-a"), false);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-a"), 1);
      assert.equal(st.hasCustomTtlKeepaliveOverride("conv-win-a"), false);

      // Upgrades preserve an explicit count in config.json and an explicit disable takes precedence.
      fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepaliveMaxCount: 4 }));
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(), 4);
      fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepalive: false, ttlKeepaliveMaxCount: 4 }));
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(), 0);
      fs.writeFileSync(cfgPath, "{}");

      // Window B sets custom override maxCount = 6
      st.setTtlKeepaliveMaxCount(6, "conv-win-b");
      assert.equal(st.hasCustomTtlKeepaliveOverride("conv-win-b"), true);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-b"), 6);

      // Global changed 3 -> 8: uncustomized Window A & brand-new Window C follow 8; custom Window B stays 6
      st.setGlobalTtlKeepaliveMaxCount(8);
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(), 8);
      assert.equal(st.getFallbackNonZeroKeepaliveMaxCount(), 8);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-a"), 8);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-c"), 8);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-b"), 6);

      // Global changed 8 -> 5 -> 0: uncustomized Window A turns OFF; last non-zero fallback remembers 5
      st.setGlobalTtlKeepaliveMaxCount(5);
      st.setGlobalTtlKeepaliveMaxCount(0);
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(), 0);
      assert.equal(st.getFallbackNonZeroKeepaliveMaxCount(), 5);
      assert.equal(st.isTtlKeepaliveEnabled("conv-win-a"), false, "Uncustomized window must turn OFF when global maxCount = 0");
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-a"), 5, "Display fallback for OFF uncustomized window uses last non-zero (5)");

      // Window D manually toggled ON while global=0 inherits fallback 5
      st.setTtlKeepaliveEnabled(true, "conv-win-d");
      assert.equal(st.isTtlKeepaliveEnabled("conv-win-d"), true);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-d"), 5);
      assert.equal(st.hasCustomTtlKeepaliveOverride("conv-win-d"), true);

      // Window E given only maxCount=4 while global=0 auto-enables in store resolution AND passes hasAnyExplicitTtlKeepaliveEnabled()
      st.clearTtlKeepaliveOverride("conv-win-b");
      st.clearTtlKeepaliveOverride("conv-win-d");
      st.setTtlKeepaliveMaxCount(4, "conv-win-e");
      assert.equal(st.isTtlKeepaliveEnabled("conv-win-e"), true, "Per-window maxCount override must enable window even when global=0");
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-e"), 4);
      assert.equal(
        st.hasAnyExplicitTtlKeepaliveEnabled(),
        true,
        "maxCount-only per-window override must trigger WatchdogMonitor decoupled lease evaluation when stallWatchdog=false"
      );

      // Preserve usedCount when clearing override (`随全局`), while `resetTtlKeepalive` preserves custom override
      st.setGlobalTtlKeepaliveMaxCount(7);
      st.setTtlKeepaliveMaxCount(6, "conv-win-f");
      st.setTtlKeepaliveState("conv-win-f", { usedCount: 2, lastSentTs: Date.now() - 5000 });
      assert.equal(st.hasCustomTtlKeepaliveOverride("conv-win-f"), true);
      st.clearTtlKeepaliveOverride("conv-win-f");
      assert.equal(st.hasCustomTtlKeepaliveOverride("conv-win-f"), false);
      assert.equal(st.getTtlKeepaliveMaxCount("conv-win-f", 3), 7, "Cleared override immediately follows global (7)");
      assert.equal(st.getTtlKeepaliveState("conv-win-f").usedCount, 2, "Clearing override must preserve usedCount=2");

      // Survival across sanitizeModelTtlState(), pruneByTtl(), and clearSessionOverrides()
      st.sanitizeModelTtlState();
      st.pruneByTtl({ maxAgeDays: 14 });
      st.clearSessionOverrides("conv-win-f");
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(3), 7, "Global maxCount must survive sanitizeModelTtlState + pruneByTtl + clearSessionOverrides");
      assert.equal(st.getFallbackNonZeroKeepaliveMaxCount(3), 7);

      // Watchdog tick with global=0 on uncustomized IDLE lease: 0 keepalives sent AND 0 fs.statSync calls!
      st.clearTtlKeepaliveOverride("conv-win-e");
      st.setGlobalTtlKeepaliveMaxCount(0);
      const baseNow = Date.now();
      writeWatchdogLease(st, {
        conversationId: "conv-idle-global-zero",
        rootSessionId: "conv-idle-global-zero",
        isSubagent: false,
        convTitle: "全局关闭测试窗",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: 160_000,
        cacheTtlSec: 300,
        idleAnchorTs: baseNow - 285_000,
        phaseChangedTs: baseNow - 285_000,
        updatedTs: baseNow - 285_000
      });

      let statCalls = 0;
      const sentZero = [];
      const notificationsWhileOff = [];
      const monZero = new WatchdogMonitor({
        getStore: () => st,
        notifyFn: (notification) => notificationsWhileOff.push(notification),
        getConfig: () => ({
          stallWatchdog: true,
          ttlKeepalive: true,
          ttlKeepaliveMaxCount: 3,
          ttlKeepaliveLeadSec: 30,
          ttlDesktopNotify: false
        }),
        nowFn: () => baseNow,
        statFn: (p) => {
          statCalls += 1;
          return fs.statSync(p);
        },
        keepaliveSendFn: async (p) => {
          sentZero.push(p);
          return { ok: true };
        }
      });
      monZero.tick();
      await flushMicrotasks();
      assert.equal(sentZero.length, 0, "Global maxCount=0 must suppress auto-keepalive on uncustomized windows");
      assert.deepEqual(notificationsWhileOff, [], "Global maxCount=0 must silence TTL notifications");
      assert.equal(monZero.statSyncCount, 0, "IDLE WatchdogMonitor.tick() with global maxCount=0 must maintain statSyncCount === 0");
      assert.equal(statCalls, 0, "IDLE WatchdogMonitor.tick() with global maxCount=0 must perform 0 transcript statSync calls");

      // Re-seed clean global=3 + Window A (follow global, used=1) & Window B (custom 6, used=2) for HTTP + VM checks
      st.setGlobalTtlKeepaliveMaxCount(3);
      writeWatchdogLease(st, {
        conversationId: "conv-http-a",
        rootSessionId: "conv-http-a",
        isSubagent: false,
        convTitle: "窗口 A",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        updatedTs: baseNow
      });
      st.setTtlKeepaliveState("conv-http-a", { usedCount: 1, updatedTs: baseNow });
      writeWatchdogLease(st, {
        conversationId: "conv-http-b",
        rootSessionId: "conv-http-b",
        isSubagent: false,
        convTitle: "窗口 B",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        updatedTs: baseNow
      });
      st.setTtlKeepaliveMaxCount(6, "conv-http-b");
      st.setTtlKeepaliveState("conv-http-b", { usedCount: 2, updatedTs: baseNow });
    } finally {
      st.close();
    }

    // 2. HTTP `/api/watchdog/action` boundary validation (`0..20` valid; out-of-range/non-int -> 400) + auto-enable + resetTtlKeepaliveOverride
    const token = "csrf-global-ka-test-token-012345";
    // The panel toggles live notification settings while simulated leases are still in the test DB.
    srv = createStandaloneServer({ csrfToken: token, watchdogOptions: { notifyFn: () => ({ dispatched: true }) } });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const headers = {
      Host: `127.0.0.1:${port}`,
      Connection: "close",
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": token
    };

    for (const badVal of [-1, 21, 1.5, "", "   ", true, false, null, {}, []]) {
      const resBad = await httpJsonRequest(port, "/api/watchdog/action", {
        headers,
        body: { action: "setGlobalTtlKeepalive", maxCount: badVal }
      });
      assert.equal(resBad.status, 400, `setGlobalTtlKeepalive(${JSON.stringify(badVal)}) must return HTTP 400`);
    }

    for (const okVal of [20, 0, 8]) {
      const resOk = await httpJsonRequest(port, "/api/watchdog/action", {
        headers,
        body: { action: "setGlobalTtlKeepalive", maxCount: okVal, conversationId: "conv-http-a" }
      });
      assert.equal(resOk.status, 200, `setGlobalTtlKeepalive(${okVal}) must return HTTP 200`);
      assert.equal(resOk.json.status.globalTtlKeepaliveMaxCount, okVal);
      assert.equal(resOk.json.status.ttlKeepalive.globalMaxCount, okVal);
    }

    // Window A (uncustomized) followed global -> 8; Window B (custom=6) stayed 6 with isCustomOverride=true
    const wdA = await httpJsonRequest(port, "/api/watchdog", { headers, body: { conversationId: "conv-http-a" } });
    const wdB = await httpJsonRequest(port, "/api/watchdog", { headers, body: { conversationId: "conv-http-b" } });
    assert.equal(wdA.json.ttlKeepalive.maxCount, 8);
    assert.equal(wdA.json.ttlKeepalive.isCustomOverride, false);
    assert.equal(wdB.json.ttlKeepalive.maxCount, 6);
    assert.equal(wdB.json.ttlKeepalive.isCustomOverride, true);

    // `resetTtlKeepalive` (`↺`) resets usedCount -> 0 while keeping custom override = 6
    const resetUsedB = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "resetTtlKeepalive", conversationId: "conv-http-b" }
    });
    assert.equal(resetUsedB.status, 200);
    assert.equal(resetUsedB.json.status.ttlKeepalive.usedCount, 0);
    assert.equal(resetUsedB.json.status.ttlKeepalive.maxCount, 6);
    assert.equal(resetUsedB.json.status.ttlKeepalive.isCustomOverride, true);

    // Re-seed usedCount=2 on B, then `resetTtlKeepaliveOverride` (`随全局`) clears custom override while preserving usedCount=2
    {
      const stSeed = new ContextModeStore({ dbPath });
      stSeed.setTtlKeepaliveState("conv-http-b", { usedCount: 2, updatedTs: Date.now() });
      stSeed.close();
    }
    const resetOvrB = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "resetTtlKeepaliveOverride", conversationId: "conv-http-b" }
    });
    assert.equal(resetOvrB.status, 200);
    assert.equal(resetOvrB.json.status.ttlKeepalive.isCustomOverride, false);
    assert.equal(resetOvrB.json.status.ttlKeepalive.maxCount, 8, "After resetTtlKeepaliveOverride, Window B follows global=8");
    assert.equal(resetOvrB.json.status.ttlKeepalive.usedCount, 2, "resetTtlKeepaliveOverride must preserve usedCount=2");

    // When global=0, setting per-window maxCount=4 without `enabled` auto-enables that window (`enabled: true, maxCount: 4`)
    await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setGlobalTtlKeepalive", maxCount: 0, conversationId: "conv-http-a" }
    });
    const autoEnA = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", maxCount: 4, conversationId: "conv-http-a" }
    });
    assert.equal(autoEnA.status, 200);
    assert.equal(autoEnA.json.status.ttlKeepalive.enabled, true, "Setting per-window maxCount=4 on OFF window must auto-enable it");
    assert.equal(autoEnA.json.status.ttlKeepalive.maxCount, 4);
    assert.equal(autoEnA.json.status.ttlKeepalive.isCustomOverride, true);

    // Restore Window A to follow global=5 and Window B to custom=6 (used=2) for Frontend VM checks
    await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "resetTtlKeepaliveOverride", conversationId: "conv-http-a" }
    });
    await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setGlobalTtlKeepalive", maxCount: 5, conversationId: "conv-http-b" }
    });
    await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", maxCount: 6, conversationId: "conv-http-b" }
    });

    // 3. Sidecar HTML layout order & Frontend VM integration against live HTTP server (ZH/EN, custom badge, clear-to-follow-global, `__unbound__` tab)
    const htmlSrc = readDashboardHtml();
    const idxCard = htmlSrc.indexOf('id="kv-cache-card"');
    const idxGlobalGroup = htmlSrc.indexOf('id="kv-global-keepalive-group"');
    const idxTtlNotifyBtn = htmlSrc.indexOf('id="kv-ttl-notify-btn"');
    const idxFollowBtn = htmlSrc.indexOf('id="kv-keepalive-follow-btn"');
    const idxResetBtn = htmlSrc.indexOf('id="kv-keepalive-reset-btn"');
    assert.ok(idxCard > 0 && idxGlobalGroup > idxCard, "#kv-global-keepalive-group must be inside #kv-cache-card");
    assert.ok(idxGlobalGroup < idxTtlNotifyBtn, "#kv-global-keepalive-group must appear directly left of #kv-ttl-notify-btn");
    assert.ok(idxFollowBtn > 0 && idxFollowBtn < idxResetBtn, "#kv-keepalive-follow-btn must appear inside #kv-keepalive-group before reset button");

    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const createFetchTracker = (fetchImpl) => {
      const pending = new Set();
      const trackedFetch = (url, opts = {}) => {
        const p = fetchImpl(url, opts);
        let entry;
        entry = Promise.resolve(p).catch(() => {}).finally(() => pending.delete(entry));
        pending.add(entry);
        return p;
      };
      const drainFetches = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        while (pending.size > 0) {
          await Promise.all([...pending]);
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      return { trackedFetch, drainFetches };
    };

    const runVmForSearch = async (searchQuery, initLang = "zh") => {
      const elements = new Map();
      let lang = initLang;
      const makeEl = (id) => ({
        id,
        textContent: "",
        innerText: "",
        innerHTML: "",
        title: "",
        value: "3",
        disabled: false,
        className: "",
        style: {},
        dataset: { enabled: "1", used: "0", max: "3", globalMax: "3", fallbackMax: "3", custom: "0", subagent: "0" },
        options: [],
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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
      const vmFetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : null;
        const res = await httpJsonRequest(port, url, {
          method: opts.method || (body ? "POST" : "GET"),
          headers,
          body
        });
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.json || {}
        };
      };
      const { trackedFetch, drainFetches } = createFetchTracker(vmFetch);
      const vmCtx = vm.createContext({
        window: {
          location: { search: searchQuery, href: `http://127.0.0.1:${port}/${searchQuery}` },
          addEventListener() {}
        },
        document: {
          hidden: false,
          activeElement: null,
          documentElement: { lang: initLang === "en" ? "en" : "zh-CN" },
          getElementById: getEl,
          querySelector: () => ({ getAttribute: () => token }),
          querySelectorAll() { return []; },
          addEventListener() {}
        },
        localStorage: { getItem: () => lang, setItem(_k, v) { lang = v; } },
        navigator: { language: initLang === "en" ? "en-US" : "zh-CN", clipboard: { writeText: async () => {} } },
        fetch: trackedFetch,
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
      await drainFetches();
      return { vmCtx, getEl, drainFetches };
    };

    // VM Case A: Custom Window B (`?conversationId=conv-http-b`) shows `本窗续温：2/6`, `随全局` visible, global `全局加热：×` + `5`
    const { vmCtx: vmB, getEl: elB, drainFetches: drainB } = await runVmForSearch("?conversationId=conv-http-b", "zh");
    assert.equal(elB("kv-global-keepalive-btn").innerText, "全局加热：×");
    assert.equal(elB("kv-global-keepalive-max").value, "5");
    assert.equal(elB("kv-keepalive-btn").innerText, "本窗续温：2/6");
    assert.equal(elB("kv-keepalive-follow-btn").className, "keepalive-follow-btn");
    assert.equal(elB("kv-keepalive-follow-btn").textContent, "随全局");

    // Switch to English and verify EN labels
    vmB.setLanguage("en", true);
    await drainB();
    assert.equal(elB("kv-global-keepalive-btn").innerText, "Global Warm: ×");
    assert.equal(elB("kv-keepalive-btn").innerText, "Window Warm: 2/6");
    assert.equal(elB("kv-keepalive-follow-btn").textContent, "Global");

    // Switch back to ZH, clear per-window input (`""`) -> triggers resetTtlKeepaliveOverride(), hides `随全局`, keeps used=2, follows global=5!
    vmB.setLanguage("zh", true);
    await drainB();
    await vmB.changeTtlKeepaliveMax("");
    await drainB();
    assert.equal(elB("kv-keepalive-btn").innerText, "自动续温：2/5");
    assert.equal(elB("kv-keepalive-follow-btn").className, "keepalive-follow-btn hidden");

    // Toggle global button OFF -> `全局加热：关` + `0`, and uncustomized Window B turns OFF (`自动续温：关`)
    await vmB.toggleGlobalTtlKeepalive();
    await drainB();
    assert.equal(elB("kv-global-keepalive-btn").innerText, "全局加热：关");
    assert.equal(elB("kv-global-keepalive-max").value, "0");
    assert.equal(elB("kv-keepalive-btn").innerText, "自动续温：关");

    // Toggle global button back ON -> restores fallback `5` (`全局加热：×` + `5`)
    await vmB.toggleGlobalTtlKeepalive();
    await drainB();
    assert.equal(elB("kv-global-keepalive-btn").innerText, "全局加热：×");
    assert.equal(elB("kv-global-keepalive-max").value, "5");
    assert.equal(elB("kv-keepalive-btn").innerText, "自动续温：2/5");

    // VM Case B: Unbound empty tab (`__unbound__`) tracks global count (`0/5` -> changeGlobalTtlKeepaliveMax("9") -> `0/9`)
    const { vmCtx: vmUnbound, getEl: elU, drainFetches: drainU } = await runVmForSearch("?conversationId=__unbound__", "zh");
    assert.equal(elU("kv-global-keepalive-max").value, "5");
    await vmUnbound.changeGlobalTtlKeepaliveMax("9");
    await drainU();
    assert.equal(elU("kv-global-keepalive-max").value, "9");
    assert.equal(elU("kv-keepalive-max").value, "9");

    // VM Case C: Real `window.sidecar` unbound tab (`conversationId: ""`) never leaks foreign convId on notify/global actions,
    // AND out-of-order rapid `toggle -> followGlobal -> setGlobal` reconciles deterministically!
    const hostActionBodies = [];
    let delayResetOverrideResolve = null;
    const { vmCtx: vmHostRace, getEl: elR, drainFetches: drainHostRace } = await (async () => {
      const elements = new Map();
      const makeEl = (id) => ({
        id,
        textContent: "",
        innerText: "",
        innerHTML: "",
        title: "",
        value: "3",
        disabled: false,
        className: "",
        style: {},
        dataset: { enabled: "1", used: "0", max: "3", fallback: "3", custom: "0", subagent: "0" },
        options: [],
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
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
      let sidecarConvId = "";
      const raceFetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : null;
        if (url === "/api/watchdog/action" && body) {
          hostActionBodies.push(body);
          if (body.action === "resetTtlKeepaliveOverride" && !delayResetOverrideResolve) {
            await new Promise((r) => {
              delayResetOverrideResolve = r;
            });
          }
        }
        const res = await httpJsonRequest(port, url, {
          method: opts.method || (body ? "POST" : "GET"),
          headers,
          body
        });
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.json || {}
        };
      };
      const { trackedFetch, drainFetches } = createFetchTracker(raceFetch);
      const vmCtx = vm.createContext({
        window: {
          sidecar: {
            get conversationId() {
              return sidecarConvId;
            },
            set conversationId(v) {
              sidecarConvId = v;
            },
            fetch: trackedFetch,
            ui: { toggleConversation() {} }
          },
          location: { search: "", href: `http://127.0.0.1:${port}/` },
          addEventListener() {}
        },
        document: {
          hidden: false,
          activeElement: null,
          documentElement: { lang: "zh-CN" },
          getElementById: getEl,
          querySelector: () => ({ getAttribute: () => token }),
          querySelectorAll() { return []; },
          addEventListener() {}
        },
        localStorage: { getItem: () => "zh", setItem() {} },
        navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
        fetch: trackedFetch,
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
      await drainFetches();
      return { vmCtx, getEl, drainFetches };
    })();

    // Unbound `window.sidecar` tab: `toggleTtlNotify` + `changeGlobalTtlKeepaliveMax` must pass `fromSidecarHost: true` and `conversationId: ""`
    hostActionBodies.length = 0;
    await vmHostRace.toggleTtlNotify();
    await vmHostRace.changeGlobalTtlKeepaliveMax("7");
    for (const actBody of hostActionBodies) {
      assert.equal(actBody.fromSidecarHost, true, "Sidecar host action must always send fromSidecarHost=true");
      assert.equal(actBody.conversationId, "", "Unbound Sidecar host tab must never leak another window's conversationId");
    }

    // Switch host tab to `conv-http-b`, then trigger out-of-order race:
    // 1. toggleTtlKeepalive() -> custom OFF
    // 2. resetTtlKeepaliveOverride() (delayed on network!) -> follow global
    // 3. changeGlobalTtlKeepaliveMax("11") (resolves BEFORE #2 mutates SQLite!)
    vmHostRace.window.sidecar.conversationId = "conv-http-b";
    await vmHostRace.refreshData(true);
    await vmHostRace.toggleTtlKeepalive();
    assert.equal(elR("kv-keepalive-btn").innerText, "本窗续温：关");

    const pFollow = vmHostRace.resetTtlKeepaliveOverride();
    const pGlobal = vmHostRace.changeGlobalTtlKeepaliveMax("11");
    await pGlobal; // Server ran setGlobalTtlKeepalive(11) BEFORE resetTtlKeepaliveOverride()!
    delayResetOverrideResolve(); // Now let resetTtlKeepaliveOverride() hit server and finish!
    await pFollow;
    await drainHostRace();
    assert.equal(
      elR("kv-keepalive-btn").innerText,
      "自动续温：2/11",
      "Out-of-order resetTtlKeepaliveOverride + setGlobalTtlKeepalive must reconcile to authoritative 2/11 follow-global state"
    );
    assert.equal(elR("kv-keepalive-follow-btn").className, "keepalive-follow-btn hidden");

    // 4. Optimistic custom-override UI state (`isCustomOverride: true`) BEFORE network response + error rollback
    {
      let holdSetKaResolve = null;
      let failSetKaOnce = false;
      let failGlobalOnce = false;
      const origSidecarFetch = vmHostRace.window.sidecar.fetch;
      vmHostRace.window.sidecar.fetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : null;
        if (url === "/api/watchdog/action" && body && body.action === "setTtlKeepalive") {
          if (holdSetKaResolve === "WAIT") {
            await new Promise((r) => {
              holdSetKaResolve = r;
            });
          }
          if (failSetKaOnce) {
            failSetKaOnce = false;
            return { ok: false, status: 500, json: async () => ({ ok: false }) };
          }
        }
        if (url === "/api/watchdog/action" && body && body.action === "setGlobalTtlKeepalive" && failGlobalOnce) {
          failGlobalOnce = false;
          return { ok: false, status: 500, json: async () => ({ ok: false }) };
        }
        return origSidecarFetch(url, opts);
      };

      // 4a. In-flight `changeTtlKeepaliveMax("8")` immediately sets `本窗续温：2/8`, `dataset.custom="1"`, visible `随全局`, and `snapshotKeepaliveUiState().isCustomOverride === true`
      holdSetKaResolve = "WAIT";
      const pOptMax = vmHostRace.changeTtlKeepaliveMax("8");
      assert.equal(elR("kv-keepalive-btn").innerText, "本窗续温：2/8", "changeTtlKeepaliveMax must optimistically render 本窗续温 before server responds");
      assert.equal(elR("kv-keepalive-btn").dataset.custom, "1");
      assert.equal(elR("kv-keepalive-follow-btn").className, "keepalive-follow-btn", "#kv-keepalive-follow-btn must appear optimistically without waiting for server");
      assert.equal(vmHostRace.snapshotKeepaliveUiState().isCustomOverride, true, "snapshotKeepaliveUiState().isCustomOverride must be true during in-flight edit");
      holdSetKaResolve();
      holdSetKaResolve = null;
      await pOptMax;
      assert.equal(elR("kv-keepalive-btn").innerText, "本窗续温：2/8");

      // Reset back to follow global (`自动续温：2/11`), then verify non-numeric guard, overlapping double-failure reconciliation, and in-flight `toggleTtlKeepalive()`
      await vmHostRace.resetTtlKeepaliveOverride();
      assert.equal(elR("kv-keepalive-btn").innerText, "自动续温：2/11");
      assert.equal(elR("kv-keepalive-btn").dataset.custom, "0");

      await vmHostRace.changeTtlKeepaliveMax("abc");
      assert.equal(elR("kv-keepalive-btn").innerText, "自动续温：2/11", "Non-numeric input must NOT convert uncustomized window into custom override");
      assert.equal(elR("kv-keepalive-btn").dataset.custom, "0");
      assert.equal(elR("kv-keepalive-max").value, "11");

      failSetKaOnce = true;
      await vmHostRace.changeTtlKeepaliveMax("15");
      assert.equal(elR("kv-keepalive-btn").innerText, "自动续温：2/11", "Failed changeTtlKeepaliveMax must roll back optimistic custom label");
      assert.equal(elR("kv-keepalive-btn").dataset.custom, "0");
      assert.equal(elR("kv-keepalive-max").value, "11", "Failed changeTtlKeepaliveMax must roll back input value");
      assert.equal(elR("kv-keepalive-follow-btn").className, "keepalive-follow-btn hidden");

      // Overlapping double HTTP 500 failure: `changeTtlKeepaliveMax("8")` (held) + `changeGlobalTtlKeepaliveMax("14")` (fails 500) -> `changeTtlKeepaliveMax("8")` (fails 500)
      // Must reconcile back to 2/11 AND clear `pendingCustomOverrideConvId` so subsequent global edits still update the uncustomized window!
      holdSetKaResolve = "WAIT";
      failSetKaOnce = true;
      failGlobalOnce = true;
      const pDoubleWin = vmHostRace.changeTtlKeepaliveMax("8");
      const pDoubleGlobal = vmHostRace.changeGlobalTtlKeepaliveMax("14");
      await pDoubleGlobal;
      holdSetKaResolve();
      holdSetKaResolve = null;
      await pDoubleWin;
      await drainHostRace();
      assert.equal(elR("kv-keepalive-btn").innerText, "自动续温：2/11", "Overlapping double HTTP 500 failure must reconcile window back to server 2/11");
      assert.equal(elR("kv-keepalive-btn").dataset.custom, "0");
      assert.equal(elR("kv-keepalive-max").value, "11");
      await vmHostRace.changeGlobalTtlKeepaliveMax("13");
      assert.equal(elR("kv-keepalive-btn").innerText, "自动续温：2/13", "pendingCustomOverrideConvId must be cleared after overlapping failure so window follows global 13");

      // Focused `#kv-global-keepalive-max` spinner edit while `AGY_DART_TTL_KEEPALIVE_MAX_COUNT=5` is pinned via env snaps input.value back to "5"!
      const prevSpinMaxEnv = process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
      process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT = "5";
      resetConfigCache();
      vmHostRace.document.activeElement = elR("kv-global-keepalive-max");
      try {
        await vmHostRace.changeGlobalTtlKeepaliveMax("16");
        assert.equal(elR("kv-global-keepalive-max").value, "5", "Focused global max input must snap back to env-pinned value 5");
      } finally {
        vmHostRace.document.activeElement = null;
        if (prevSpinMaxEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
        else process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT = prevSpinMaxEnv;
        resetConfigCache();
      }
      await vmHostRace.changeGlobalTtlKeepaliveMax("11");

      holdSetKaResolve = "WAIT";
      const pOptToggle = vmHostRace.toggleTtlKeepalive();
      assert.equal(elR("kv-keepalive-btn").innerText, "本窗续温：关", "toggleTtlKeepalive must optimistically render 本窗续温：关 before server responds");
      assert.equal(elR("kv-keepalive-btn").dataset.custom, "1");
      assert.equal(elR("kv-keepalive-follow-btn").className, "keepalive-follow-btn");
      assert.equal(vmHostRace.snapshotKeepaliveUiState().isCustomOverride, true);
      holdSetKaResolve();
      holdSetKaResolve = null;
      await pOptToggle;
      vmHostRace.window.sidecar.fetch = origSidecarFetch;
    }

    // 5. Env `AGY_DART_TTL_KEEPALIVE_MAX_COUNT` (`0` and `5`) vs per-window overrides & hard kill-switches across Store, WatchdogMonitor & Hooks
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise((resolve) => srv.close(resolve));
      srv = null;
    }
    closeRuntimeStore();

    const prevMaxEnv = process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
    const prevKaEnv = process.env.AGY_DART_TTL_KEEPALIVE;
    const prevDisKaEnv = process.env.AGY_DART_DISABLE_TTL_KEEPALIVE;
    try {
      const envTxPath = path.join(tmpDir, "env-precedence-transcript.jsonl");
      fs.writeFileSync(
        envTxPath,
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          model: "claude-opus-4-6-thinking",
          input_tokens: 90_000,
          cache_read_tokens: 80_000,
          output_tokens: 200,
          created_at: new Date(Date.now() - 10_000).toISOString()
        }) + "\n",
        "utf8"
      );

      // 5a. `AGY_DART_TTL_KEEPALIVE_MAX_COUNT=0`: global default is OFF, but per-window `enabled=true` (uses fallback 5) & `maxCount=4` override cleanly!
      {
        const stSeed = new ContextModeStore({ dbPath });
        stSeed.setTtlDesktopNotifyEnabled(false); // isolate ttlKeepaliveExplicit from earlier toggleTtlNotify()
        stSeed.setGlobalTtlKeepaliveMaxCount(5); // remembers last_nonzero_max = 5
        stSeed.setTtlKeepaliveEnabled(true, "conv-env0-win-on");
        stSeed.setTtlKeepaliveMaxCount(4, "conv-env0-win-max4");
        stSeed.close();
      }
      process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT = "0";
      delete process.env.AGY_DART_TTL_KEEPALIVE;
      delete process.env.AGY_DART_DISABLE_TTL_KEEPALIVE;
      resetConfigCache();

      const hookEnvZero = {
        ...process.env,
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_CONFIG_PATH: cfgPath,
        AGY_DART_DISABLE_STALL_WATCHDOG: "1",
        AGY_DART_TTL_KEEPALIVE_MAX_COUNT: "0"
      };
      for (const cid of ["conv-env0-uncust", "conv-env0-win-on", "conv-env0-win-max4"]) {
        const rPre = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
          input: JSON.stringify({ conversationId: cid, transcriptPath: envTxPath, invocationNum: 0, lastUserInput: "ping" }),
          encoding: "utf8",
          windowsHide: true,
          env: hookEnvZero
        });
        assert.equal(rPre.status, 0);
        assert.equal(rPre.stderr, "");
        const rStop = spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
          input: JSON.stringify({ conversationId: cid, terminationReason: "NO_TOOL_CALL" }),
          encoding: "utf8",
          windowsHide: true,
          env: hookEnvZero
        });
        assert.equal(rStop.status, 0);
        assert.equal(rStop.stderr, "");
      }

      {
        const stEnv0 = new ContextModeStore({ dbPath });
        try {
          assert.equal(stEnv0.getGlobalTtlKeepaliveMaxCount(), 0);
          assert.equal(stEnv0.isTtlKeepaliveEnabled("conv-env0-uncust"), false, "Uncustomized window must stay OFF under AGY_DART_TTL_KEEPALIVE_MAX_COUNT=0");
          assert.equal(stEnv0.isTtlKeepaliveEnabled("conv-env0-win-on"), true, "Per-window enabled=true must override AGY_DART_TTL_KEEPALIVE_MAX_COUNT=0");
          assert.equal(stEnv0.getTtlKeepaliveMaxCount("conv-env0-win-on"), 5, "Per-window enabled=true under env MAX_COUNT=0 must inherit fallback 5");
          assert.equal(stEnv0.isTtlKeepaliveEnabled("conv-env0-win-max4"), true, "Per-window maxCount=4 must override AGY_DART_TTL_KEEPALIVE_MAX_COUNT=0");
          assert.equal(stEnv0.getTtlKeepaliveMaxCount("conv-env0-win-max4"), 4);

          assert.equal(
            readWatchdogLease(stEnv0, "conv-env0-uncust"),
            null,
            "Decoupled hooks must NOT create lease for uncustomized window when AGY_DART_TTL_KEEPALIVE_MAX_COUNT=0"
          );
          const leaseOn = readWatchdogLease(stEnv0, "conv-env0-win-on");
          const leaseMax4 = readWatchdogLease(stEnv0, "conv-env0-win-max4");
          assert.equal(leaseOn?.subphase, "stopped", "Decoupled hooks MUST record lease for per-window enabled=true override under env MAX_COUNT=0");
          assert.equal(leaseMax4?.subphase, "stopped", "Decoupled hooks MUST record lease for per-window maxCount=4 override under env MAX_COUNT=0");

          const firedEnv0 = [];
          const simNow = Math.max(leaseOn.idleAnchorTs, leaseMax4.idleAnchorTs) + 280_000;
          const monEnv0 = new WatchdogMonitor({
            getStore: () => stEnv0,
            getConfig: () => ({ stallWatchdog: false, ttlDesktopNotify: false }),
            nowFn: () => simNow,
            monoNsFn: () => 20_000_000_000n,
            keepaliveSendFn: async (p) => {
              firedEnv0.push(p.conversationId);
              return { ok: true };
            }
          });
          assert.equal(monEnv0._resolveTtlKeepaliveEnabled(stEnv0, {}, "conv-env0-uncust"), false);
          assert.equal(monEnv0._resolveTtlKeepaliveEnabled(stEnv0, {}, "conv-env0-win-on"), true);
          assert.equal(monEnv0._resolveTtlKeepaliveMaxCount(stEnv0, {}, "conv-env0-win-on"), 5);
          assert.equal(monEnv0._resolveTtlKeepaliveMaxCount(stEnv0, {}, "conv-env0-win-max4"), 4);
          monEnv0.tick();
          await flushMicrotasks();
          assert.deepEqual(
            firedEnv0.filter((id) => id.startsWith("conv-env0-")).sort(),
            ["conv-env0-win-max4", "conv-env0-win-on"],
            "WatchdogMonitor must fire keepalive for per-window overrides even when AGY_DART_TTL_KEEPALIVE_MAX_COUNT=0"
          );

          // 5b. `AGY_DART_TTL_KEEPALIVE_MAX_COUNT=5`: uncustomized window gets 5, per-window `maxCount=9` keeps 9, per-window `enabled=false` stays OFF
          process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT = "5";
          resetConfigCache();
          stEnv0.setTtlKeepaliveMaxCount(9, "conv-env5-win-max9");
          stEnv0.setTtlKeepaliveEnabled(false, "conv-env5-win-off");
          assert.equal(stEnv0.getGlobalTtlKeepaliveMaxCount(), 5);
          assert.equal(stEnv0.getTtlKeepaliveMaxCount("conv-env5-uncust"), 5);
          assert.equal(stEnv0.getTtlKeepaliveMaxCount("conv-env5-win-max9"), 9, "Per-window maxCount=9 must NOT be clobbered by AGY_DART_TTL_KEEPALIVE_MAX_COUNT=5");
          assert.equal(monEnv0._resolveTtlKeepaliveMaxCount(stEnv0, {}, "conv-env5-win-max9"), 9);
          assert.equal(stEnv0.isTtlKeepaliveEnabled("conv-env5-win-off"), false, "Per-window enabled=false must override AGY_DART_TTL_KEEPALIVE_MAX_COUNT=5");
          assert.equal(monEnv0._resolveTtlKeepaliveEnabled(stEnv0, {}, "conv-env5-win-off"), false);

          const hookEnvFive = {
            ...process.env,
            AGY_DART_DB_PATH: dbPath,
            AGY_DART_CONFIG_PATH: cfgPath,
            AGY_DART_DISABLE_STALL_WATCHDOG: "1",
            AGY_DART_TTL_KEEPALIVE_MAX_COUNT: "5"
          };
          for (const cid of ["conv-env5-uncust", "conv-env5-win-off"]) {
            spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
              input: JSON.stringify({ conversationId: cid, transcriptPath: envTxPath, invocationNum: 0, lastUserInput: "ping" }),
              encoding: "utf8",
              windowsHide: true,
              env: hookEnvFive
            });
            spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
              input: JSON.stringify({ conversationId: cid, terminationReason: "NO_TOOL_CALL" }),
              encoding: "utf8",
              windowsHide: true,
              env: hookEnvFive
            });
          }
          assert.equal(readWatchdogLease(stEnv0, "conv-env5-uncust")?.subphase, "stopped", "AGY_DART_TTL_KEEPALIVE_MAX_COUNT=5 must enable decoupled hook lease recording");
          assert.equal(readWatchdogLease(stEnv0, "conv-env5-win-off"), null, "Per-window enabled=false must suppress decoupled hook lease even when env MAX_COUNT=5");

          // 5c. Hard kill-switches (`AGY_DART_DISABLE_TTL_KEEPALIVE=1` & `AGY_DART_TTL_KEEPALIVE=false`) override per-window `enabled=true`
          process.env.AGY_DART_DISABLE_TTL_KEEPALIVE = "1";
          resetConfigCache();
          assert.equal(stEnv0.isTtlKeepaliveEnabled("conv-env0-win-on"), false, "AGY_DART_DISABLE_TTL_KEEPALIVE=1 must kill-switch per-window enabled=true");
          assert.equal(monEnv0._resolveTtlKeepaliveEnabled(stEnv0, {}, "conv-env0-win-on"), false);

          delete process.env.AGY_DART_DISABLE_TTL_KEEPALIVE;
          process.env.AGY_DART_TTL_KEEPALIVE = "false";
          resetConfigCache();
          assert.equal(stEnv0.isTtlKeepaliveEnabled("conv-env0-win-on"), false, "AGY_DART_TTL_KEEPALIVE=false must kill-switch per-window enabled=true");
          assert.equal(monEnv0._resolveTtlKeepaliveEnabled(stEnv0, {}, "conv-env0-win-on"), false);
        } finally {
          stEnv0.close();
        }
      }
    } finally {
      if (prevMaxEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT;
      else process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT = prevMaxEnv;
      if (prevKaEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE;
      else process.env.AGY_DART_TTL_KEEPALIVE = prevKaEnv;
      if (prevDisKaEnv === undefined) delete process.env.AGY_DART_DISABLE_TTL_KEEPALIVE;
      else process.env.AGY_DART_DISABLE_TTL_KEEPALIVE = prevDisKaEnv;
      resetConfigCache();
    }
  } finally {
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise((resolve) => srv.close(resolve));
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("v1.5.4-ka-14: Cloud clock alignment + 60s lead + delivery EMA, default 1x, 3-layer cold-miss circuit breaker, adjustable window % threshold (512k/256k/200k/0% + custom bypass) & accordion UI", async () => {
  const { CONFIG_DEFAULTS, getEffectiveConfig } = await import("../context/lib/config.js");
  const { handleStopPayload } = await import("../hooks/stop.mjs");
  const { recordHookLeaseTransition } = await import("../context/lib/watchdog-lease.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-v154-14-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevMinPctEnv = process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  delete process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
  resetConfigCache();

  let srv = null;
  try {
    // 1. Verify updated product defaults: maxCount=1, leadSec=60s, minContextPct=15%
    assert.equal(CONFIG_DEFAULTS.ttlKeepalive, false);
    assert.equal(CONFIG_DEFAULTS.ttlKeepaliveMaxCount, 1);
    assert.equal(CONFIG_DEFAULTS.ttlKeepaliveLeadSec, 60);
    assert.equal(CONFIG_DEFAULTS.ttlKeepaliveMinContextPct, 15);
    const effDefaults = getEffectiveConfig();
    assert.equal(effDefaults.ttlKeepaliveMaxCount, 1);
    assert.equal(effDefaults.ttlKeepaliveLeadSec, 60);
    assert.equal(effDefaults.ttlKeepaliveMinContextPct, 15);

    // 2. Cloud Clock Alignment + 60s Lead + Send Pipeline Latency EMA Compensation
    const st = new ContextModeStore({ dbPath });
    st.open();
    st.setUiLang("zh");
    try {
      assert.equal(st.getGlobalTtlKeepaliveMaxCount(), 0);
      assert.equal(st.getGlobalTtlKeepaliveMinContextPct(), 15);
      assert.equal(st.getTtlKeepaliveDeliveryMs(), 0);

      let clockMs = 1_800_000_000_000;
      let monoNs = 1_000_000_000n;
      const setClock = (nextMs) => {
        const delta = Math.max(0, nextMs - clockMs);
        clockMs = nextMs;
        monoNs += BigInt(delta) * 1_000_000n;
      };
      const sent = [];
      let statCalls = 0;
      const mon = new WatchdogMonitor({
        getStore: () => st,
        nowFn: () => clockMs,
        monoNsFn: () => monoNs,
        statFn: (p) => {
          statCalls += 1;
          return fs.statSync(p);
        },
        keepaliveSendFn: async (p) => {
          sent.push(p);
          return { ok: true };
        }
      });

      // 2a. Long 55s thinking/streaming turn: PreInvocation starts prefill at t0, Stop completes at t0 + 55s
      const t0 = clockMs;
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-cloud-align", invocationNum: 0, lastUserInput: "深度推理分析" },
        { nowMs: t0, contextTokens: 90_000, windowTokens: 200_000, model: "claude-opus-4-6-thinking" }
      );
      setClock(t0 + 55_000);
      recordHookLeaseTransition(
        st,
        "Stop",
        { conversationId: "conv-cloud-align", terminationReason: "NO_TOOL_CALL" },
        { nowMs: clockMs }
      );
      const alignedLease = readWatchdogLease(st, "conv-cloud-align");
      assert.equal(alignedLease.idleAnchorTs, t0 + 55_000);
      assert.equal(alignedLease.cacheOriginTs, t0, "Stop must preserve turn LLM prefill start as cacheOriginTs");

      // At t0 + 239s (184s after Stop, 61s left on cloud 5m TTL): must NOT fire yet
      setClock(t0 + 239_000);
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.length, 0, "61s before cloud TTL expiry must not fire yet");

      // At t0 + 240s (185s after Stop, 60s left on cloud 5m TTL — 55s earlier than old late Stop+240s!): fires 1/1!
      setClock(t0 + 240_000);
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.length, 0, "A fresh install must send no keepalive even inside the trigger window");
      st.setGlobalTtlKeepaliveMaxCount(1);
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.length, 1, "Cloud-aligned keepalive must fire at t0 + 240s (4m00s cloud time), not Stop + 240s");
      assert.ok(sent[0].message.includes("1/1"));
      assert.equal(statCalls, 0, "IDLE tick must perform 0 fs.statSync calls");

      // Default maxCount=1 stops after 1/1 on renewed cycle
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-cloud-align", invocationNum: 0, lastUserInput: sent[0].message },
        { nowMs: clockMs + 2_000, isKeepaliveTurn: true, contextTokens: 90_000, windowTokens: 200_000 }
      );
      recordHookLeaseTransition(
        st,
        "Stop",
        { conversationId: "conv-cloud-align", terminationReason: "NO_TOOL_CALL" },
        { nowMs: clockMs + 4_000 }
      );
      setClock(clockMs + 250_000);
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.length, 1, "Default maxCount=1 must NOT fire a 2nd keepalive");

      // 2b. Multi-tool turn + flushed PLANNER_RESPONSE.created_at + Turn-0/1 Stop token enrichment
      const txAlign = path.join(tmpDir, "tx-align.jsonl");
      const tTurn = clockMs;
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-tool-align", invocationNum: 0, lastUserInput: "跑检查并总结" },
        { nowMs: tTurn, transcriptPath: txAlign, contextTokens: 0 }
      );
      recordHookLeaseTransition(
        st,
        "PostToolUse",
        { conversationId: "conv-tool-align" },
        { nowMs: tTurn + 20_000, toolName: "run_checks", toolArgs: {} }
      );
      const plannerCreatedMs = tTurn + 21_000;
      fs.writeFileSync(
        txAlign,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(tTurn).toISOString(), content: "跑检查并总结" },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: new Date(plannerCreatedMs).toISOString(),
            completed_at: new Date(tTurn + 69_000).toISOString(),
            model: "gemini-4-carbon-high",
            max_token_limit: 512_000,
            input_tokens: 85_000,
            cache_read_tokens: 0,
            output_tokens: 400,
            content: "检查完成。"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      await handleStopPayload(
        { conversationId: "conv-tool-align", transcriptPath: txAlign, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: tTurn + 70_000 }
      );
      const toolLease = readWatchdogLease(st, "conv-tool-align");
      assert.equal(toolLease.cacheOriginTs, plannerCreatedMs, "Stop must align cacheOriginTs to PLANNER_RESPONSE.created_at");
      assert.equal(toolLease.contextTokens, 85_000, "Stop must enrich contextTokens on Turn 0/1");
      assert.equal(toolLease.windowTokens, 512_000, "Stop must enrich max_token_limit on Turn 0/1");
      assert.equal(
        st.getTtlKeepaliveState("conv-tool-align").coldMissTripped,
        false,
        "Human Turn-1 cold prefill (cache_read=0) must NEVER trip keepalive cold-miss circuit breaker"
      );

      // 2c. Send->PreInvocation pipeline latency EMA compensation (+4s for 3200ms ack latency)
      st.recordTtlKeepaliveDeliveryMs(3_200);
      assert.equal(st.getTtlKeepaliveDeliveryMs(), 3_200);
      // 300s TTL - (60s lead + ceil(3.2s)=4s) = 236s after plannerCreatedMs!
      setClock(plannerCreatedMs + 235_000); // remSec = 65s > 64s -> no fire
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.filter((s) => s.conversationId === "conv-tool-align").length, 0);

      setClock(plannerCreatedMs + 236_000); // remSec = 64s <= 64s -> fires!
      mon.tick();
      await flushMicrotasks();
      assert.equal(
        sent.filter((s) => s.conversationId === "conv-tool-align").length,
        1,
        "Delivery latency compensation must advance trigger by 4s so keepalive arrives at cloud ~4m00s"
      );

      // 3. Adjustable Window % Threshold (15%: 512k=76.8k, 256k=38.4k, 200k=30k; 0% = no min; custom window bypasses)
      st.setMeta("cache:ttl_keepalive_delivery_ms", "0");
      const baseWinTs = clockMs + 500_000;
      const seedWindowCase = (cid, ctxTok, winTok, model = "claude-sonnet-4-5") => {
        writeWatchdogLease(st, {
          conversationId: cid,
          rootSessionId: cid,
          convTitle: cid,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          stopReason: "NO_TOOL_CALL",
          contextTokens: ctxTok,
          windowTokens: winTok,
          model,
          cacheTtlSec: 300,
          idleAnchorTs: baseWinTs,
          cacheOriginTs: baseWinTs,
          phaseChangedTs: baseWinTs,
          updatedTs: baseWinTs
        });
      };
      seedWindowCase("win-512k-below", 76_000, 512_000, "gemini-4-carbon-high");
      seedWindowCase("win-512k-above", 77_000, 512_000, "gemini-4-carbon-high");
      seedWindowCase("win-256k-below", 38_000, 256_000, "gemini-2.5-pro");
      seedWindowCase("win-256k-above", 39_000, 256_000, "gemini-2.5-pro");
      seedWindowCase("win-200k-below", 29_500, 200_000, "claude-opus-4-6-thinking");
      seedWindowCase("win-200k-above", 30_000, 200_000, "claude-opus-4-6-thinking");
      seedWindowCase("win-custom-small", 8_000, 200_000, "claude-opus-4-6-thinking");
      st.setTtlKeepaliveEnabled(true, "win-custom-small"); // manual per-window override bypasses 15% threshold!

      sent.length = 0;
      setClock(baseWinTs + 245_000); // 55s left <= 60s lead
      mon.tick();
      await flushMicrotasks();

      const firedIds15 = sent.map((s) => s.conversationId).sort();
      assert.deepEqual(
        firedIds15,
        ["win-200k-above", "win-256k-above", "win-512k-above", "win-custom-small"],
        "15% window threshold must filter <76.8k(512k)/<38.4k(256k)/<30k(200k) while exempting manual per-window overrides"
      );

      // Setting 0% removes threshold -> small uncustomized contexts now fire too!
      st.setGlobalTtlKeepaliveMinContextPct(0);
      sent.length = 0;
      mon.tick();
      await flushMicrotasks();
      const firedIds0 = sent.map((s) => s.conversationId).sort();
      assert.deepEqual(
        firedIds0,
        ["win-200k-below", "win-256k-below", "win-512k-below"],
        "0% threshold must allow all small-context windows without minimum"
      );
      st.setGlobalTtlKeepaliveMinContextPct(15);

      // 4. Multi-Round Cold-Miss Auto Circuit Breaker (Layers 1, 2, 3) + Reset & Human Turn Recovery
      st.setGlobalTtlKeepaliveMaxCount(3);
      const txCold = path.join(tmpDir, "tx-cold.jsonl");
      const tCold = clockMs + 100_000;
      fs.writeFileSync(
        txCold,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(tCold).toISOString(), content: "开始长任务" },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: new Date(tCold + 1_000).toISOString(),
            model: "claude-opus-4-6-thinking",
            input_tokens: 5_000,
            cache_read_tokens: 75_000,
            output_tokens: 100,
            content: "收到。"
          },
          {
            step_index: 3,
            type: "SYSTEM_MESSAGE",
            created_at: new Date(tCold + 242_000).toISOString(),
            content: "[agy-dart TTL保活 1/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。"
          },
          {
            step_index: 4,
            type: "PLANNER_RESPONSE",
            created_at: new Date(tCold + 243_000).toISOString(),
            model: "claude-opus-4-6-thinking",
            input_tokens: 80_200,
            cache_read_tokens: 0,
            output_tokens: 4,
            content: "OK"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      writeWatchdogLease(st, {
        conversationId: "conv-cold-l1",
        rootSessionId: "conv-cold-l1",
        convTitle: "冷断测试L1",
        phase: WATCHDOG_PHASES.LLM_INFLIGHT,
        subphase: "high_ctx",
        startedTs: tCold + 242_000,
        lastLlmStartTs: tCold + 242_000,
        updatedTs: tCold + 242_000,
        transcriptPath: txCold,
        contextTokens: 80_000,
        windowTokens: 200_000
      });
      st.setTtlKeepaliveState("conv-cold-l1", {
        usedCount: 1,
        lastSentTs: tCold + 241_500,
        inKeepaliveTurn: true,
        updatedTs: tCold + 242_000
      });
      // Layer 1: Stop hook sees cache_read_tokens === 0 on keepalive turn -> trips coldMissTripped!
      await handleStopPayload(
        { conversationId: "conv-cold-l1", transcriptPath: txCold, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: tCold + 245_000 }
      );
      assert.equal(st.getTtlKeepaliveState("conv-cold-l1").coldMissTripped, true, "Layer 1 Stop hook must trip coldMissTripped on cache_read=0");
      assert.equal(st.getTtlKeepaliveState("conv-cold-l1").inKeepaliveTurn, false);

      // Next idle expiry on conv-cold-l1 MUST NOT fire round 2/3!
      sent.length = 0;
      setClock(tCold + 243_000 + 250_000);
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.filter((s) => s.conversationId === "conv-cold-l1").length, 0, "Tripped coldMissTripped must block round 2/3");

      // Manual reset clears coldMissTripped -> round 1/3 is allowed again!
      st.resetTtlKeepaliveState("conv-cold-l1", clockMs);
      assert.equal(st.getTtlKeepaliveState("conv-cold-l1").coldMissTripped, false);

      // Layer 3: Un-flushed at Stop, flushed 200ms later, headless Watchdog catches cold miss with 0 fs.statSync!
      const txColdL3 = path.join(tmpDir, "tx-cold-l3.jsonl");
      const tL3 = clockMs + 50_000;
      const preFlushSteps = [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tL3).toISOString(), content: "任务L3" },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tL3 + 1_000).toISOString(), input_tokens: 5_000, cache_read_tokens: 75_000, output_tokens: 20 },
        { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(tL3 + 242_000).toISOString(), content: "[agy-dart TTL保活 1/3] 仅回复 OK" }
      ];
      fs.writeFileSync(txColdL3, preFlushSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
      writeWatchdogLease(st, {
        conversationId: "conv-cold-l3",
        rootSessionId: "conv-cold-l3",
        convTitle: "冷断测试L3",
        phase: WATCHDOG_PHASES.LLM_INFLIGHT,
        subphase: "high_ctx",
        startedTs: tL3 + 242_000,
        lastLlmStartTs: tL3 + 242_000,
        updatedTs: tL3 + 242_000,
        transcriptPath: txColdL3,
        contextTokens: 80_000,
        windowTokens: 200_000
      });
      st.setTtlKeepaliveState("conv-cold-l3", {
        usedCount: 1,
        lastSentTs: tL3 + 241_500,
        inKeepaliveTurn: true,
        lastColdCheckUsed: 0,
        updatedTs: tL3 + 242_000
      });
      await handleStopPayload(
        { conversationId: "conv-cold-l3", transcriptPath: txColdL3, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: tL3 + 244_000 }
      );
      assert.equal(st.getTtlKeepaliveState("conv-cold-l3").coldMissTripped, false, "Not yet flushed at Stop");
      assert.equal(st.getTtlKeepaliveState("conv-cold-l3").lastColdCheckUsed, 0);

      // Now flush the cold-miss PLANNER_RESPONSE to disk AFTER Stop!
      fs.appendFileSync(
        txColdL3,
        JSON.stringify({
          step_index: 4,
          type: "PLANNER_RESPONSE",
          created_at: new Date(tL3 + 242_500).toISOString(),
          input_tokens: 80_100,
          cache_read_tokens: 0,
          output_tokens: 3,
          content: "OK"
        }) + "\n",
        "utf8"
      );
      sent.length = 0;
      const statBeforeL3 = statCalls;
      setClock(tL3 + 242_000 + 250_000);
      mon.tick();
      await flushMicrotasks();
      assert.equal(statCalls, statBeforeL3, "Layer 3 IDLE cold-miss check must perform 0 fs.statSync calls");
      assert.equal(st.getTtlKeepaliveState("conv-cold-l3").coldMissTripped, true, "Layer 3 Watchdog tail check must trip coldMissTripped");
      assert.equal(sent.filter((s) => s.conversationId === "conv-cold-l3").length, 0, "Layer 3 must abort sending round 2/3");

      // Genuine human PreInvocation turn recovers coldMissTripped -> false!
      st.close();
      const rRecover = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
        input: JSON.stringify({ conversationId: "conv-cold-l3", invocationNum: 0, lastUserInput: "我回来了，继续下一步" }),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
      });
      assert.equal(rRecover.status, 0);
      assert.equal(rRecover.stderr, "");

      const stAfterRecover = new ContextModeStore({ dbPath });
      try {
        const recKa = stAfterRecover.getTtlKeepaliveState("conv-cold-l3");
        assert.equal(recKa.usedCount, 0);
        assert.equal(recKa.coldMissTripped, false, "Genuine human message must recover coldMissTripped -> false");

        // Survival across sanitizeModelTtlState, pruneByTtl, and clearSessionOverrides + env override
        stAfterRecover.setGlobalTtlKeepaliveMinContextPct(22);
        stAfterRecover.recordTtlKeepaliveDeliveryMs(2_500);
        stAfterRecover.sanitizeModelTtlState();
        stAfterRecover.pruneByTtl({ maxAgeDays: 14 });
        stAfterRecover.clearSessionOverrides();
        assert.equal(stAfterRecover.getGlobalTtlKeepaliveMinContextPct(), 22);
        assert.ok(stAfterRecover.getTtlKeepaliveDeliveryMs() > 0);

        process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT = "25";
        resetConfigCache();
        assert.equal(stAfterRecover.getGlobalTtlKeepaliveMinContextPct(), 25, "Env must override SQLite minContextPct");
        delete process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
        resetConfigCache();
        stAfterRecover.setGlobalTtlKeepaliveMinContextPct(15);
      } finally {
        stAfterRecover.close();
      }
    } finally {
      if (st.db) st.close();
    }

    // 5. Sidecar HTTP API validation + Accordion placement + VM live k-value & cold-miss rendering
    const htmlSrc = readDashboardHtml();
    const idxAccordion = htmlSrc.indexOf('id="exempt-accordion"');
    const idxAccordionEnd = htmlSrc.indexOf("</details>", idxAccordion);
    const idxMinCtxCtrl = htmlSrc.indexOf('id="ka-min-ctx-control"');
    const idxMinCtxInput = htmlSrc.indexOf('id="ka-min-ctx-pct-input"');
    const idxCutoffSelect = htmlSrc.indexOf('id="cutoff-select"');
    assert.ok(idxAccordion > 0 && idxAccordionEnd > idxAccordion, "#exempt-accordion must exist");
    assert.ok(
      idxMinCtxCtrl > idxAccordion && idxMinCtxCtrl < idxAccordionEnd && idxMinCtxInput > idxMinCtxCtrl,
      "#ka-min-ctx-control must be placed inside bottom #exempt-accordion alongside Cutoff/Exempt settings"
    );
    assert.ok(Math.abs(idxCutoffSelect - idxMinCtxInput) < 900, "#ka-min-ctx-pct-input must sit alongside #cutoff-select");

    const token = "test-ka14-csrf-0123456789abcdef";
    srv = createStandaloneServer({ csrfToken: token });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const headers = {
      Host: `127.0.0.1:${port}`,
      Connection: "close",
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": token
    };

    for (const badPct of [-1, 101, 12.5, "", true, false, null, {}, []]) {
      const badRes = await httpJsonRequest(port, "/api/watchdog/action", {
        headers,
        body: { action: "setTtlKeepaliveMinContextPct", minContextPct: badPct }
      });
      assert.equal(badRes.status, 400, `Invalid minContextPct ${JSON.stringify(badPct)} must return HTTP 400`);
    }

    for (const okPct of [0, 15, 25, 100, 15]) {
      const okRes = await httpJsonRequest(port, "/api/watchdog/action", {
        headers,
        body: { action: "setTtlKeepaliveMinContextPct", minContextPct: okPct }
      });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.json.globalTtlKeepaliveMinContextPct, okPct);
      assert.equal(okRes.json.status.globalTtlKeepaliveMinContextPct, okPct);
    }

    // Seed cold-miss tripped state on `conv-vm-cold` for VM rendering & reset verification
    {
      const stVm = new ContextModeStore({ dbPath });
      stVm.setGlobalTtlKeepaliveMaxCount(3);
      stVm.setTtlKeepaliveState("conv-vm-cold", { usedCount: 1, coldMissTripped: true });
      stVm.close();
    }
    closeRuntimeStore();

    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);
    const elements = new Map();
    const makeEl = (id) => ({
      id,
      value: id === "ka-min-ctx-pct-input" ? "15" : "1",
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      className: "",
      disabled: false,
      hidden: false,
      style: {},
      dataset:
        id === "kv-keepalive-btn"
          ? { enabled: "1", used: "0", max: "1", custom: "0", cold: "0" }
          : id === "kv-global-keepalive-btn"
            ? { max: "1", fallback: "1" }
            : {},
      options: [],
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(x) { return this._s.has(x); },
        toggle(x, f) {
          if (f === undefined) {
            if (this._s.has(x)) { this._s.delete(x); return false; }
            this._s.add(x); return true;
          }
          if (f) this._s.add(x); else this._s.delete(x);
          return Boolean(f);
        }
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      blur() {}
    });
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const vmFetch = async (url, opts = {}) => {
      const res = await httpJsonRequest(port, url, {
        method: opts.method || "POST",
        headers,
        body: opts.body ? JSON.parse(opts.body) : {}
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.json
      };
    };

    const vmCtx = vm.createContext({
      window: {
        location: { search: "?conversationId=conv-vm-cold&lang=zh" },
        addEventListener() {}
      },
      document: {
        hidden: false,
        activeElement: null,
        title: "",
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => token }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      localStorage: { getItem: () => null, setItem() {} },
      sessionStorage: { getItem: () => null, setItem() {} },
      fetch: vmFetch,
      Headers,
      URLSearchParams,
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      confirm: () => true,
      alert() {},
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      JSON,
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
    await vmCtx.refreshData(true);
    await flushMicrotasks();

    // Layer 2: Verify `/api/cache-diag` also detects a post-Stop flushed keepalive cold miss (cache_read = 0)
    const txLayer2 = path.join(tmpDir, "tx-cold-l2.jsonl");
    const tL2 = Date.now() - 10_000;
    fs.writeFileSync(
      txLayer2,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tL2).toISOString(), content: "开始L2" },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tL2 + 1_000).toISOString(), input_tokens: 4_000, cache_read_tokens: 60_000, output_tokens: 20 },
        { step_index: 3, type: "SYSTEM_MESSAGE", created_at: new Date(tL2 + 5_000).toISOString(), content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
        { step_index: 4, type: "PLANNER_RESPONSE", created_at: new Date(tL2 + 6_000).toISOString(), input_tokens: 64_100, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    {
      const stL2 = new ContextModeStore({ dbPath });
      writeWatchdogLease(stL2, {
        conversationId: "conv-cold-l2",
        rootSessionId: "conv-cold-l2",
        convTitle: "冷断测试L2",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        transcriptPath: txLayer2,
        contextTokens: 64_100,
        windowTokens: 200_000,
        idleAnchorTs: tL2 + 6_500,
        cacheOriginTs: tL2 + 6_000,
        updatedTs: tL2 + 6_500
      });
      stL2.setTtlKeepaliveState("conv-cold-l2", {
        usedCount: 1,
        lastSentTs: tL2 + 4_800,
        pendingAck: false,
        inKeepaliveTurn: false,
        coldMissTripped: false,
        lastColdCheckUsed: 0,
        updatedTs: tL2 + 6_500
      });
      stL2.close();
      closeRuntimeStore();
    }
    const cdL2 = await httpJsonRequest(port, "/api/cache-diag", {
      headers,
      body: { scope: "conversation", conversationId: "conv-cold-l2" }
    });
    assert.equal(cdL2.status, 200);
    assert.equal(cdL2.json.ttlKeepalive.coldMissTripped, true, "Layer 2 /api/cache-diag must trip coldMissTripped on post-flush cache_read=0");

    // Cold-miss tripped UI state in ZH & EN
    assert.equal(getEl("kv-keepalive-btn").innerText, "自动续温：1/3（冷断）");
    assert.ok(getEl("kv-keepalive-group").className.includes("is-exhausted"), "Cold-tripped capsule must show amber exhausted styling");
    assert.equal(getEl("kv-keepalive-reset-btn").className, "keepalive-reset-btn", "Reset ↺ button must show when coldMissTripped");

    vmCtx.setLanguage("en", true);
    await flushMicrotasks();
    assert.equal(getEl("kv-keepalive-btn").innerText, "Auto-Keepalive: 1/3 (Cold)");
    vmCtx.setLanguage("zh", true);
    await flushMicrotasks();

    // Live k-value conversion for 512k / 256k / 200k / 0%
    vmCtx.renderKeepaliveMinContextControls(15, 512_000);
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "≈77k/512k");
    vmCtx.renderKeepaliveMinContextControls(15, 256_000);
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "≈38k/256k");
    vmCtx.renderKeepaliveMinContextControls(15, 200_000);
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "≈30k/200k");

    await vmCtx.changeTtlKeepaliveMinContextPct("0");
    await flushMicrotasks();
    assert.equal(getEl("ka-min-ctx-pct-input").value, "0");
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "（无门槛）");

    await vmCtx.changeTtlKeepaliveMinContextPct("20");
    await flushMicrotasks();
    assert.equal(getEl("ka-min-ctx-pct-input").value, "20");
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "≈40k/200k");

    // Manual ↺ reset clears coldMissTripped back to 0/3!
    await vmCtx.resetTtlKeepalive();
    await flushMicrotasks();
    assert.equal(getEl("kv-keepalive-btn").innerText, "自动续温：0/3");
    assert.equal(getEl("kv-keepalive-btn").dataset.cold, "0");
  } finally {
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise((resolve) => srv.close(resolve));
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevMinPctEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
    else process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT = prevMinPctEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("v1.5.4-ka-15: Hardened multi-tool causal cacheOriginTs, clock skew bounds, Round-2+ cold-miss anti-poisoning, Turn-0 delayed flush backfill, >32KB transcript tail, disabled-watchdog decoupling & Sidecar VM races", async () => {
  const { handleStopPayload } = await import("../hooks/stop.mjs");
  const {
    readWatchdogTranscriptTail,
    recordHookLeaseTransition
  } = await import("../context/lib/watchdog-lease.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-v154-15-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevMinPctEnv = process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
  const prevDisWdEnv = process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  delete process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
  delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
  resetConfigCache();

  let srv = null;
  try {
    const st = new ContextModeStore({ dbPath });
    st.open();
    st.setUiLang("zh");

    let clockMs = 1_850_000_000_000;
    let monoNs = 1_000_000_000n;
    const setClock = (nextMs) => {
      const delta = Math.max(0, nextMs - clockMs);
      clockMs = nextMs;
      monoNs += BigInt(delta) * 1_000_000n;
    };
    const sent = [];
    let statCalls = 0;
    const mon = new WatchdogMonitor({
      getStore: () => st,
      nowFn: () => clockMs,
      monoNsFn: () => monoNs,
      statFn: (p) => {
        statCalls += 1;
        return fs.statSync(p);
      },
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    try {
      // 1a. PostToolUse -> denied PreToolUse -> un-flushed Stop preserves the denial-triggered LLM prefill start (t1 + 32s, not t1 or Stop t1 + 45s)
      const t1 = clockMs;
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-denied-tool", invocationNum: 0, lastUserInput: "检查目录" },
        { nowMs: t1, contextTokens: 80_000, windowTokens: 200_000 }
      );
      recordHookLeaseTransition(
        st,
        "PostToolUse",
        { conversationId: "conv-denied-tool" },
        { nowMs: t1 + 30_000, toolName: "run_command", toolArgs: { CommandLine: "git status" } }
      );
      recordHookLeaseTransition(
        st,
        "PreToolUse",
        { conversationId: "conv-denied-tool" },
        { nowMs: t1 + 32_000, toolName: "run_command", decision: "deny" }
      );
      recordHookLeaseTransition(
        st,
        "Stop",
        { conversationId: "conv-denied-tool", terminationReason: "NO_TOOL_CALL" },
        { nowMs: t1 + 45_000 }
      );
      assert.equal(
        readWatchdogLease(st, "conv-denied-tool").cacheOriginTs,
        t1 + 32_000,
        "PostToolUse -> denied PreToolUse -> un-flushed Stop must preserve denial-triggered LLM prefill start (t1 + 32s)"
      );

      // 1b. Clock skew bounds: minor future skew (+3s <= +5s) clamps to Stop; bogus future skew (+20s > +5s) & stale (< startedTs - 5s) fall back to causal floor
      const txFutureClamp = path.join(tmpDir, "tx-future-clamp.jsonl");
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-future-clamp", invocationNum: 0, lastUserInput: "测试轻微时钟超前" },
        { nowMs: t1, transcriptPath: txFutureClamp, contextTokens: 60_000, windowTokens: 200_000 }
      );
      fs.writeFileSync(
        txFutureClamp,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(t1).toISOString(), content: "测试轻微时钟超前" },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: new Date(t1 + 48_000).toISOString(), // +3s ahead of Stop (t1 + 45s) -> clamped to Stop
            input_tokens: 60_000,
            cache_read_tokens: 55_000,
            output_tokens: 20,
            content: "完成"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      await handleStopPayload(
        { conversationId: "conv-future-clamp", transcriptPath: txFutureClamp, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: t1 + 45_000 }
      );
      assert.equal(
        readWatchdogLease(st, "conv-future-clamp").cacheOriginTs,
        t1 + 45_000,
        "Minor future-skewed PLANNER_RESPONSE.created_at (+3s) must clamp to Stop nowMs"
      );

      const txFutureSkew = path.join(tmpDir, "tx-future-skew.jsonl");
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-future-skew", invocationNum: 0, lastUserInput: "测试大时钟超前" },
        { nowMs: t1, transcriptPath: txFutureSkew, contextTokens: 60_000, windowTokens: 200_000 }
      );
      fs.writeFileSync(
        txFutureSkew,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(t1).toISOString(), content: "测试大时钟超前" },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: new Date(t1 + 65_000).toISOString(), // +20s ahead of Stop (t1 + 45s) -> rejected to causal floor t1
            input_tokens: 60_000,
            cache_read_tokens: 55_000,
            output_tokens: 20,
            content: "完成"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      await handleStopPayload(
        { conversationId: "conv-future-skew", transcriptPath: txFutureSkew, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: t1 + 45_000 }
      );
      assert.equal(
        readWatchdogLease(st, "conv-future-skew").cacheOriginTs,
        t1,
        "Bogus future PLANNER_RESPONSE.created_at (+20s > +5s tolerance) must fall back to causal LLM start timestamp"
      );

      const txStaleSkew = path.join(tmpDir, "tx-stale-skew.jsonl");
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-stale-skew", invocationNum: 0, lastUserInput: "测试过期时间戳" },
        { nowMs: t1 + 50_000, transcriptPath: txStaleSkew, contextTokens: 60_000, windowTokens: 200_000 }
      );
      fs.writeFileSync(
        txStaleSkew,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(t1 + 50_000).toISOString(), content: "测试过期时间戳" },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: new Date(t1 + 30_000).toISOString(), // 20s before turn startedTs
            input_tokens: 60_000,
            cache_read_tokens: 55_000,
            output_tokens: 20,
            content: "完成"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      await handleStopPayload(
        { conversationId: "conv-stale-skew", transcriptPath: txStaleSkew, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: t1 + 70_000 }
      );
      assert.equal(
        readWatchdogLease(st, "conv-stale-skew").cacheOriginTs,
        t1 + 50_000,
        "Stale PLANNER_RESPONSE.created_at (< causal floor - 5s) must fall back to causal LLM start timestamp"
      );

      // 1c. PreToolUse(read_file, allow) without PostToolUse + un-flushed Stop advances causal floor to >= PreToolUse
      const tRead = t1 + 100_000;
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-read-floor", invocationNum: 0, lastUserInput: "读取配置" },
        { nowMs: tRead, contextTokens: 70_000, windowTokens: 200_000 }
      );
      recordHookLeaseTransition(
        st,
        "PreToolUse",
        { conversationId: "conv-read-floor" },
        { nowMs: tRead + 40_000, toolName: "read_file", blocked: false }
      );
      recordHookLeaseTransition(
        st,
        "Stop",
        { conversationId: "conv-read-floor", terminationReason: "NO_TOOL_CALL" },
        { nowMs: tRead + 60_000 }
      );
      assert.equal(
        readWatchdogLease(st, "conv-read-floor").cacheOriginTs,
        tRead + 40_000,
        "Allowed read_file PreToolUse (without PostToolUse hook) must advance causal cacheOriginTs floor"
      );

      // 1d. Multi-tool turn where intermediate PLANNER_RESPONSE (with tool_calls) + GENERIC flushed, but final PLANNER_RESPONSE has NOT flushed at Stop
      const txMultiTool = path.join(tmpDir, "tx-multi-tool.jsonl");
      const tMulti = tRead + 100_000;
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-multi-unflushed", invocationNum: 0, lastUserInput: "长工具执行并总结" },
        { nowMs: tMulti, transcriptPath: txMultiTool, contextTokens: 0 }
      );
      recordHookLeaseTransition(
        st,
        "PostToolUse",
        { conversationId: "conv-multi-unflushed" },
        { nowMs: tMulti + 180_000, toolName: "run_command", toolArgs: { CommandLine: "npm test" } }
      );
      fs.writeFileSync(
        txMultiTool,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(tMulti).toISOString(), content: "长工具执行并总结" },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: new Date(tMulti + 1_000).toISOString(),
            model: "gemini-4-carbon-high",
            max_token_limit: 512_000,
            input_tokens: 15_000,
            cache_read_tokens: 140_000,
            output_tokens: 80,
            tool_calls: [{ id: "tc-1", name: "run_command" }]
          },
          {
            step_index: 3,
            type: "GENERIC",
            created_at: new Date(tMulti + 180_000).toISOString(),
            tool_call_id: "tc-1",
            output: "PASS"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      await handleStopPayload(
        { conversationId: "conv-multi-unflushed", transcriptPath: txMultiTool, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: tMulti + 210_000 }
      );
      const multiLease = readWatchdogLease(st, "conv-multi-unflushed");
      assert.equal(
        multiLease.cacheOriginTs,
        tMulti + 180_000,
        "Intermediate PLANNER_RESPONSE with tool_calls must NEVER clobber PostToolUse cacheOriginTs (tMulti + 180s)"
      );
      assert.equal(multiLease.contextTokens, 155_000, "Intermediate turn PLANNER_RESPONSE must still enrich Turn-0 contextTokens");
      assert.equal(multiLease.windowTokens, 512_000, "Intermediate turn PLANNER_RESPONSE must still enrich Turn-0 windowTokens");

      // 2. Round-2+ Cold-Miss Circuit Breaker Anti-Poisoning (when Round 2 has not flushed yet during early poll/tick)
      st.setGlobalTtlKeepaliveMaxCount(3);
      const txRound2 = path.join(tmpDir, "tx-round2-cold.jsonl");
      const tR = tMulti + 400_000;
      fs.writeFileSync(
        txRound2,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(tR).toISOString(), content: "保持多轮续温" },
          { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tR + 1_000).toISOString(), input_tokens: 5_000, cache_read_tokens: 80_000, output_tokens: 40 },
          { step_index: 3, type: "SYSTEM_MESSAGE", content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
          // Deliberately omit created_at on Round 1's PLANNER_RESPONSE to attack the missing-created_at branch too!
          { step_index: 4, type: "PLANNER_RESPONSE", input_tokens: 100, cache_read_tokens: 85_000, output_tokens: 3, content: "OK" }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      writeWatchdogLease(st, {
        conversationId: "conv-r2-anti-poison",
        rootSessionId: "conv-r2-anti-poison",
        convTitle: "二轮冷断防投毒",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        transcriptPath: txRound2,
        contextTokens: 85_100,
        windowTokens: 200_000,
        cacheTtlSec: 300,
        idleAnchorTs: tR + 484_000,
        cacheOriginTs: tR + 482_000,
        phaseChangedTs: tR + 484_000,
        updatedTs: tR + 484_000
      });
      st.setTtlKeepaliveState("conv-r2-anti-poison", {
        usedCount: 2,
        lastSentTs: tR + 481_000,
        pendingAck: false,
        inKeepaliveTurn: false,
        coldMissTripped: false,
        lastColdCheckUsed: 1,
        updatedTs: tR + 484_000
      });

      // Poll Layer 3 before Round 2 flushes (still outside Round 3's trigger window at tR + 500s) -> no poison
      setClock(tR + 500_000);
      mon.tick();
      assert.equal(st.getTtlKeepaliveState("conv-r2-anti-poison").lastColdCheckUsed, 1);

      // Now Round 2 flushes with cache_read_tokens = 0 before Round 3's trigger window (tR + 482s + 240s = tR + 722s)
      fs.appendFileSync(
        txRound2,
        [
          { step_index: 5, type: "SYSTEM_MESSAGE", created_at: new Date(tR + 481_500).toISOString(), content: "[agy-dart TTL保活 2/3] 仅回复 OK" },
          { step_index: 6, type: "PLANNER_RESPONSE", created_at: new Date(tR + 482_000).toISOString(), input_tokens: 85_200, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      sent.length = 0;
      statCalls = 0;
      setClock(tR + 725_000); // Inside Round 3 trigger window!
      mon.tick();
      await flushMicrotasks();
      const r2StateAfterTick = st.getTtlKeepaliveState("conv-r2-anti-poison");
      assert.equal(r2StateAfterTick.coldMissTripped, true, "Layer 3 must trip coldMissTripped on Round 2's cache_read=0 without being poisoned by Round 1's 1/3 step");
      assert.equal(r2StateAfterTick.lastColdCheckUsed, 2);
      assert.equal(sent.filter((s) => s.conversationId === "conv-r2-anti-poison").length, 0, "Round 3/3 must NOT fire after Round 2 cold miss");
      assert.equal(statCalls, 0, "Layer 3 pre-send tail check must perform 0 fs.statSync calls");

      st.setGlobalTtlKeepaliveMaxCount(1);

      // 3. Turn-0 Un-flushed Large Prompt IDLE Backfill (Headless WatchdogMonitor, 0 fs.statSync)
      const txTurn0 = path.join(tmpDir, "tx-turn0-delayed.jsonl");
      const tTurn0 = clockMs + 100_000;
      fs.writeFileSync(
        txTurn0,
        JSON.stringify({ step_index: 1, type: "USER_INPUT", created_at: new Date(tTurn0).toISOString(), content: "95k首轮任务" }) + "\n",
        "utf8"
      );
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-turn0-backfill", invocationNum: 0, lastUserInput: "95k首轮任务" },
        { nowMs: tTurn0, transcriptPath: txTurn0, contextTokens: 0 }
      );
      await handleStopPayload(
        { conversationId: "conv-turn0-backfill", transcriptPath: txTurn0, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: tTurn0 + 10_000 }
      );
      assert.equal(readWatchdogLease(st, "conv-turn0-backfill").contextTokens, 0, "At Stop before disk flush, contextTokens is 0");

      // Host flushes 95k PLANNER_RESPONSE 2s after Stop
      fs.appendFileSync(
        txTurn0,
        JSON.stringify({
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: new Date(tTurn0 + 1_000).toISOString(),
          model: "claude-opus-4-6-thinking",
          max_token_limit: 200_000,
          input_tokens: 95_000,
          cache_read_tokens: 0,
          output_tokens: 300,
          content: "首轮完成"
        }) + "\n",
        "utf8"
      );
      sent.length = 0;
      statCalls = 0;
      setClock(tTurn0 + 245_000);
      mon.tick();
      await flushMicrotasks();
      assert.equal(
        sent.filter((s) => s.conversationId === "conv-turn0-backfill").length,
        1,
        "Headless WatchdogMonitor must backfill delayed Turn-0 95k contextTokens and send 1/1 keepalive"
      );
      assert.equal(readWatchdogLease(st, "conv-turn0-backfill").contextTokens, 95_000);
      assert.equal(statCalls, 0, "Turn-0 lazy backfill must perform 0 fs.statSync calls");

      // 4. >32 KB transcript_full.jsonl tail line auto-widening (38 KB thinking payload)
      const txGiant = path.join(tmpDir, "transcript_full.jsonl");
      const tGiant = clockMs + 100_000;
      fs.writeFileSync(
        txGiant,
        [
          { step_index: 1, type: "USER_INPUT", created_at: new Date(tGiant - 250_000).toISOString(), content: "长思考测试" },
          { step_index: 2, type: "SYSTEM_MESSAGE", created_at: new Date(tGiant - 2_000).toISOString(), content: "[agy-dart TTL保活 1/2] 仅回复 OK" },
          {
            step_index: 3,
            type: "PLANNER_RESPONSE",
            created_at: new Date(tGiant).toISOString(),
            thinking: "深".repeat(14_000), // >42 KB UTF-8 line!
            input_tokens: 92_000,
            cache_read_tokens: 0,
            output_tokens: 5,
            content: "OK"
          }
        ]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
        "utf8"
      );
      const giantTail = readWatchdogTranscriptTail(txGiant);
      assert.ok(giantTail.steps.length >= 2, "readWatchdogTranscriptTail must auto-widen window to parse >32KB PLANNER_RESPONSE + preceding SYSTEM_MESSAGE");

      st.setGlobalTtlKeepaliveMaxCount(2);
      recordHookLeaseTransition(
        st,
        "PreInvocation",
        { conversationId: "conv-giant-cold", invocationNum: 0, lastUserInput: "[agy-dart TTL保活 1/2] 仅回复 OK" },
        { nowMs: tGiant - 1_500, isKeepaliveTurn: true, transcriptPath: txGiant, contextTokens: 92_000 }
      );
      st.setTtlKeepaliveState("conv-giant-cold", {
        usedCount: 1,
        lastSentTs: tGiant - 2_000,
        inKeepaliveTurn: true,
        coldMissTripped: false,
        lastColdCheckUsed: 0
      });
      await handleStopPayload(
        { conversationId: "conv-giant-cold", transcriptPath: txGiant, terminationReason: "NO_TOOL_CALL" },
        { store: st, nowMs: tGiant + 3_000 }
      );
      assert.equal(
        st.getTtlKeepaliveState("conv-giant-cold").coldMissTripped,
        true,
        "Layer 1 Stop must trip coldMissTripped even when PLANNER_RESPONSE line in transcript_full.jsonl exceeds 32 KB"
      );
      assert.equal(readWatchdogLease(st, "conv-giant-cold").cacheOriginTs, tGiant);
      st.setGlobalTtlKeepaliveMaxCount(1);

      // 5. Disabled Stall Watchdog (`watchdog:enabled = false`) preserves `globalTtlKeepaliveMinContextPct` & explicit keepalive leases while respecting v1.4-9 uncustomized quietness
      st.setWatchdogEnabled(false);
      const disabledStatus = mon.getStatus({ refresh: true });
      assert.equal(disabledStatus.enabled, false);
      assert.equal(
        disabledStatus.globalTtlKeepaliveMinContextPct,
        15,
        "WatchdogMonitor.tick() when disabled must still expose globalTtlKeepaliveMinContextPct"
      );
      st.setGlobalTtlKeepaliveMaxCount(1); // explicit global keepalive (1x)
    } finally {
      st.close();
    }

    // Spawn real pre-invocation & stop hooks while SQLite watchdog:enabled = false + explicit global keepalive (1x)
    const txWdOff = path.join(tmpDir, "tx-wd-off.jsonl");
    fs.writeFileSync(
      txWdOff,
      JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "UI关防卡死但显式开续温" }) + "\n",
      "utf8"
    );
    const hookEnvUiOff = {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath
    };
    delete hookEnvUiOff.AGY_DART_DISABLE_STALL_WATCHDOG;
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: "conv-ui-wdoff-kaon", transcriptPath: txWdOff, invocationNum: 0, lastUserInput: "ping" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnvUiOff
    });
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "stop.mjs")], {
      input: JSON.stringify({ conversationId: "conv-ui-wdoff-kaon", transcriptPath: txWdOff, terminationReason: "NO_TOOL_CALL" }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnvUiOff
    });
    {
      const stVerify = new ContextModeStore({ dbPath });
      try {
        assert.equal(
          readWatchdogLease(stVerify, "conv-ui-wdoff-kaon")?.subphase,
          "stopped",
          "Explicit Auto-Keepalive (1x) must still record leases when UI Stall Watchdog SQLite toggle is OFF"
        );
        stVerify.setWatchdogEnabled(true);
      } finally {
        stVerify.close();
      }
    }

    // 6. Sidecar Server + VM: Layer-2 anti-poisoning, Turn-0 /api/cache-diag backfill, narrow CSS, below-min tooltip, Enter 1x override, env-pin focused snapback & concurrent 500 reconciliation
    const htmlSrc = readDashboardHtml();
    assert.match(htmlSrc, /\.cutoff-control\s*\{[^}]*flex-wrap:\s*wrap/s, ".cutoff-control must wrap cleanly on narrow Sidecar widths");
    assert.match(htmlSrc, /\.cutoff-num-input\s*\{[^}]*width:\s*48px/s, ".cutoff-num-input must fit 3-digit 100% cleanly");
    assert.match(htmlSrc, /#ka-min-ctx-label,\s*#ka-min-ctx-k-hint\s*\{[^}]*white-space:\s*nowrap/s);

    // Seed conv-vm-small (12k < 30k on 200k window) + conv-diag-turn0 (un-flushed lease + flushed 90k transcript) + conv-l2-r2 (Round 1 warm, Round 2 un-flushed)
    const txSmall = path.join(tmpDir, "tx-small-12k.jsonl");
    const tNow = Date.now() - 5_000;
    fs.writeFileSync(
      txSmall,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tNow).toISOString(), content: "小上下文窗口" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: new Date(tNow + 1_000).toISOString(),
          model: "claude-opus-4-6-thinking",
          max_token_limit: 200_000,
          input_tokens: 12_000,
          cache_read_tokens: 0,
          output_tokens: 50,
          content: "短回复"
        }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    const txDiagTurn0 = path.join(tmpDir, "tx-diag-turn0.jsonl");
    fs.writeFileSync(
      txDiagTurn0,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tNow).toISOString(), content: "诊断回填" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: new Date(tNow + 1_000).toISOString(),
          model: "claude-opus-4-6-thinking",
          max_token_limit: 200_000,
          input_tokens: 90_000,
          cache_read_tokens: 0,
          output_tokens: 100,
          content: "已落盘"
        }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    const txL2AntiPoison = path.join(tmpDir, "tx-l2-antipoison.jsonl");
    fs.writeFileSync(
      txL2AntiPoison,
      [
        { step_index: 1, type: "USER_INPUT", created_at: new Date(tNow - 300_000).toISOString(), content: "L2防投毒" },
        { step_index: 2, type: "SYSTEM_MESSAGE", created_at: new Date(tNow - 250_000).toISOString(), content: "[agy-dart TTL保活 1/3] 仅回复 OK" },
        { step_index: 3, type: "PLANNER_RESPONSE", created_at: new Date(tNow - 249_000).toISOString(), input_tokens: 100, cache_read_tokens: 70_000, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );

    {
      const stSeed = new ContextModeStore({ dbPath });
      writeWatchdogLease(stSeed, {
        conversationId: "conv-vm-small",
        rootSessionId: "conv-vm-small",
        convTitle: "12k小窗口",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        transcriptPath: txSmall,
        contextTokens: 12_050,
        windowTokens: 200_000,
        idleAnchorTs: tNow + 2_000,
        cacheOriginTs: tNow + 1_000,
        updatedTs: tNow + 2_000
      });
      writeWatchdogLease(stSeed, {
        conversationId: "conv-diag-turn0",
        rootSessionId: "conv-diag-turn0",
        convTitle: "Turn0回填",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        transcriptPath: txDiagTurn0,
        contextTokens: 0,
        windowTokens: 0,
        idleAnchorTs: tNow + 2_000,
        cacheOriginTs: tNow,
        updatedTs: tNow + 2_000
      });
      writeWatchdogLease(stSeed, {
        conversationId: "conv-l2-antipoison",
        rootSessionId: "conv-l2-antipoison",
        convTitle: "L2二轮防投毒",
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        transcriptPath: txL2AntiPoison,
        contextTokens: 70_100,
        windowTokens: 200_000,
        idleAnchorTs: tNow,
        cacheOriginTs: tNow - 1_000,
        updatedTs: tNow
      });
      stSeed.setTtlKeepaliveState("conv-l2-antipoison", {
        usedCount: 2,
        lastSentTs: tNow - 2_000,
        pendingAck: false,
        inKeepaliveTurn: false,
        coldMissTripped: false,
        lastColdCheckUsed: 1,
        updatedTs: tNow
      });
      stSeed.close();
      closeRuntimeStore();
    }

    srv = createStandaloneServer();
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const indexRes = await httpJsonRequest(port, "/", { method: "GET" });
    const token = indexRes.raw.match(/meta name="agy-dart-token" content="([^"]+)"/)[1];
    const headers = { "Content-Type": "application/json", "X-Agy-Dart-Token": token };

    // Verify /api/cache-diag Turn-0 IDLE lease backfill
    const diagTurn0Res = await httpJsonRequest(port, "/api/cache-diag", {
      headers,
      body: { scope: "conversation", conversationId: "conv-diag-turn0" }
    });
    assert.equal(diagTurn0Res.status, 200);
    {
      const stCheck = new ContextModeStore({ dbPath });
      try {
        assert.equal(
          readWatchdogLease(stCheck, "conv-diag-turn0").contextTokens,
          90_000,
          "/api/cache-diag must backfill Turn-0 IDLE lease contextTokens once transcript flushes"
        );
      } finally {
        stCheck.close();
      }
    }

    // Verify /api/cache-diag Layer 2 does NOT poison lastColdCheckUsed=2 while Round 2 is un-flushed, then trips once Round 2 flushes cold!
    const l2BeforeFlush = await httpJsonRequest(port, "/api/cache-diag", {
      headers,
      body: { scope: "conversation", conversationId: "conv-l2-antipoison" }
    });
    assert.equal(l2BeforeFlush.json.ttlKeepalive.coldMissTripped, false);
    fs.appendFileSync(
      txL2AntiPoison,
      [
        { step_index: 4, type: "SYSTEM_MESSAGE", created_at: new Date(tNow - 1_500).toISOString(), content: "[agy-dart TTL保活 2/3] 仅回复 OK" },
        { step_index: 5, type: "PLANNER_RESPONSE", created_at: new Date(tNow - 1_000).toISOString(), input_tokens: 70_200, cache_read_tokens: 0, output_tokens: 3, content: "OK" }
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n",
      "utf8"
    );
    const l2AfterFlush = await httpJsonRequest(port, "/api/cache-diag", {
      headers,
      body: { scope: "conversation", conversationId: "conv-l2-antipoison" }
    });
    assert.equal(
      l2AfterFlush.json.ttlKeepalive.coldMissTripped,
      true,
      "Layer 2 /api/cache-diag must trip coldMissTripped after Round 2 flushes even after an earlier pre-flush poll"
    );

    // VM tests on conv-vm-small
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    const elements = new Map();
    const makeEl = (id) => ({
      id,
      value: id === "ka-min-ctx-pct-input" ? "15" : "1",
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      className: "",
      disabled: false,
      hidden: false,
      style: {},
      dataset:
        id === "kv-keepalive-btn"
          ? { enabled: "1", used: "0", max: "1", custom: "0", cold: "0" }
          : id === "kv-global-keepalive-btn"
            ? { max: "1", fallback: "1" }
            : {},
      options: [],
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(x) { return this._s.has(x); },
        toggle(x, f) {
          if (f === undefined) {
            if (this._s.has(x)) { this._s.delete(x); return false; }
            this._s.add(x); return true;
          }
          if (f) this._s.add(x); else this._s.delete(x);
          return Boolean(f);
        }
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      blur() {}
    });
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    let failWatchdog500 = false;
    let holdNextStatsGate = null;
    let delayedMinCtxGate = null;
    const vmDoc = {
      hidden: false,
      activeElement: null,
      title: "",
      documentElement: { lang: "zh-CN" },
      getElementById: getEl,
      querySelector: () => ({ getAttribute: () => token }),
      querySelectorAll: () => [],
      addEventListener() {}
    };

    const vmFetch = async (url, opts = {}) => {
      const parsedBody = opts.body ? JSON.parse(opts.body) : {};
      if (url === "/api/stats" && holdNextStatsGate) {
        const waitGate = holdNextStatsGate;
        holdNextStatsGate = null;
        await waitGate;
      }
      if (url === "/api/watchdog/action" && parsedBody.action === "setTtlKeepaliveMinContextPct" && delayedMinCtxGate) {
        const waitGate = delayedMinCtxGate;
        delayedMinCtxGate = null;
        await waitGate;
      }
      if (url === "/api/watchdog/action" && failWatchdog500) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "simulated_500" })
        };
      }
      const res = await httpJsonRequest(port, url, {
        method: opts.method || "POST",
        headers,
        body: parsedBody
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.json
      };
    };

    const vmCtx = vm.createContext({
      window: {
        location: { search: "?conversationId=conv-vm-small&lang=zh" },
        addEventListener() {}
      },
      document: vmDoc,
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      localStorage: { getItem: () => null, setItem() {} },
      sessionStorage: { getItem: () => null, setItem() {} },
      fetch: vmFetch,
      Headers,
      URLSearchParams,
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      confirm: () => true,
      alert() {},
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      JSON,
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
    await vmCtx.refreshData(true);
    await flushMicrotasks();

    // 6a. Uncustomized 12k (< 30k / 15%) window preserves exact innerText while surfacing below-min hint in title!
    assert.equal(getEl("kv-keepalive-btn").innerText, "自动续温：0/1");
    assert.match(getEl("kv-keepalive-btn").title, /12k\s*(?:<|未达)\s*30k.*15%/, "Uncustomized below-min window must explain threshold pause in tooltip");

    // 6b. Pressing Enter on #kv-keepalive-max (value="1") commits an explicit per-window 1x override & clears below-min pause!
    const kaMaxKeydownMatch = htmlSrc.match(/id="kv-keepalive-max"[^>]*onkeydown="([^"]+)"/);
    assert.ok(kaMaxKeydownMatch && kaMaxKeydownMatch[1], "#kv-keepalive-max must define Enter keydown handler");
    const decodedKeydown = kaMaxKeydownMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    vm.runInContext(
      `(function(event){ ${decodedKeydown} }).call(document.getElementById('kv-keepalive-max'), { key: 'Enter' })`,
      vmCtx
    );
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(getEl("kv-keepalive-btn").dataset.custom, "1", "Pressing Enter on default 1x must promote window to explicit custom override");
    assert.equal(getEl("kv-keepalive-btn").innerText, "本窗续温：0/1");
    assert.equal(
      /12k\s*(?:<|未达)\s*30k/.test(getEl("kv-keepalive-btn").title),
      false,
      "Explicit per-window 1x override bypasses default 15% threshold and clears pause tooltip"
    );

    // 6c. Env-pinned AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT=25 snaps focused input back even during concurrent action
    process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT = "25";
    resetConfigCache();
    vmDoc.activeElement = getEl("ka-min-ctx-pct-input");
    await Promise.all([
      vmCtx.changeTtlKeepaliveMinContextPct("5"),
      vmCtx.changeGlobalTtlKeepaliveMax("4")
    ]);
    await flushMicrotasks();
    assert.equal(
      getEl("ka-min-ctx-pct-input").value,
      "25",
      "Focused #ka-min-ctx-pct-input must snap back to env-pinned 25% even when concurrent global action advances watchdogActionSeq"
    );
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "≈50k/200k");
    vmDoc.activeElement = null;
    delete process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
    resetConfigCache();

    // 6d. Language switch mid-flight during changeTtlKeepaliveMinContextPct("0") must NOT clobber optimistic "0" / "(no min)"
    let releaseMinCtx;
    delayedMinCtxGate = new Promise((resolve) => {
      releaseMinCtx = resolve;
    });
    const pendingZeroPromise = vmCtx.changeTtlKeepaliveMinContextPct("0");
    await flushMicrotasks();
    vmCtx.setLanguage("en", true);
    assert.equal(getEl("ka-min-ctx-pct-input").value, "0", "setLanguage during in-flight minContextPct action must keep optimistic 0%");
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "(no min)");
    releaseMinCtx();
    await pendingZeroPromise;
    await flushMicrotasks();
    assert.equal(getEl("ka-min-ctx-pct-input").value, "0");
    assert.equal(getEl("ka-min-ctx-k-hint").textContent, "(no min)");
    vmCtx.setLanguage("zh", true);
    await flushMicrotasks();

    // 6e. Concurrent double HTTP 500 while autoRefreshInFlight === true still reconciles to server truth (0% & globalMax=4)
    let releaseStats;
    holdNextStatsGate = new Promise((resolve) => {
      releaseStats = resolve;
    });
    const bgAutoRefresh = vmCtx.refreshData(false); // sets autoRefreshInFlight = true
    await flushMicrotasks();

    failWatchdog500 = true;
    const pFailPct = vmCtx.changeTtlKeepaliveMinContextPct("30");
    const pFailMax = vmCtx.changeGlobalTtlKeepaliveMax("9");
    failWatchdog500 = false;
    releaseStats();
    await Promise.all([bgAutoRefresh, pFailPct, pFailMax]);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(
      getEl("ka-min-ctx-pct-input").value,
      "0",
      "Concurrent HTTP 500 rollback + refreshData(true) reconciliation must restore server truth 0% instead of leaving stale 30%"
    );
    assert.equal(getEl("kv-global-keepalive-max").value, "4");
  } finally {
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise((resolve) => srv.close(resolve));
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevMinPctEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT;
    else process.env.AGY_DART_TTL_KEEPALIVE_MIN_CONTEXT_PCT = prevMinPctEnv;
    if (prevDisWdEnv === undefined) delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
    else process.env.AGY_DART_DISABLE_STALL_WATCHDOG = prevDisWdEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
