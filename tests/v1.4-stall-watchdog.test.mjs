import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import {
  CONFIG_DEFAULTS,
  formatEffectiveConfigLines,
  getConfigSnapshot,
  resetConfigCache
} from "../context/lib/config.js";
import { buildHandoffBrief } from "../context/lib/handoff.js";
import {
  WATCHDOG_PHASES,
  WatchdogMonitor,
  buildDesktopNotificationCommand,
  classifyToolExecutionKind,
  diagnoseStallCause,
  inspectTranscriptTailForWatchdog,
  isHeadlessWorkerPrompt,
  listWatchdogLeases,
  readWatchdogLease,
  recordHookLeaseTransition,
  resolveDynamicThresholds
} from "../context/lib/watchdog.js";
import { closeRuntimeStore, createStandaloneServer, registerSidecarRoutes } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHookRaw(scriptRel, payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, scriptRel);
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
  delete env.ANTIGRAVITY_SUBAGENT;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [hook], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env
  });
}

function httpJsonRequest(port, pathname, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d.toString("utf8")));
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
    if (body !== null && body !== undefined) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test("v1.4-1: Stall Watchdog config defaults, config.json/env precedence, store toggles & purge/TTL cleanup", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const dbPath = path.join(tmpDir, "context.db");
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevNotifyEnv = process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
  const prevDisableEnv = process.env.AGY_DART_DISABLE_STALL_WATCHDOG;

  try {
    // 1. Defaults
    assert.equal(CONFIG_DEFAULTS.stallWatchdog, true);
    assert.equal(CONFIG_DEFAULTS.watchdogDesktopNotify, false);
    assert.equal(CONFIG_DEFAULTS.watchdogPollMs, 5000);
    assert.equal(CONFIG_DEFAULTS.watchdogSuspectRatio, 0.6);
    assert.equal(CONFIG_DEFAULTS.watchdogLlmLowSec, 120);
    assert.equal(CONFIG_DEFAULTS.watchdogLlmHighSec, 240);
    assert.equal(CONFIG_DEFAULTS.watchdogLlmMultimodalSec, 360);
    assert.equal(CONFIG_DEFAULTS.watchdogToolFastSec, 90);
    assert.equal(CONFIG_DEFAULTS.watchdogToolCmdSec, 300);
    assert.equal(CONFIG_DEFAULTS.watchdogSubagentSec, 1200);
    assert.equal(CONFIG_DEFAULTS.watchdogLlmReasoningSec, 600);
    assert.equal(CONFIG_DEFAULTS.watchdogLlmCompoundSec, 900);
    assert.equal(CONFIG_DEFAULTS.watchdogNotifyCooldownSec, 300);

    // 2. config.json overrides & clamping
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        stallWatchdog: true,
        watchdogPollMs: 2500,
        watchdogSuspectRatio: 0.75,
        watchdogLlmLowSec: 90,
        watchdogLlmHighSec: 180,
        watchdogLlmMultimodalSec: 300,
        watchdogToolFastSec: 60,
        watchdogToolCmdSec: 210,
        watchdogSubagentSec: 480,
        watchdogDesktopNotify: true,
        watchdogNotifyCooldownSec: 120
      }),
      "utf8"
    );
    resetConfigCache();
    const fromCfg = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(fromCfg.values.watchdogPollMs, 2500);
    assert.equal(fromCfg.sources.watchdogPollMs, "config");
    assert.equal(fromCfg.values.watchdogSuspectRatio, 0.75);
    assert.equal(fromCfg.values.watchdogLlmLowSec, 90);
    assert.equal(fromCfg.values.watchdogDesktopNotify, true);
    assert.equal(fromCfg.sources.watchdogDesktopNotify, "config");

    // 3. Env overrides take precedence & clamp extremes; DISABLE beats ENABLE
    const fromEnv = getConfigSnapshot({
      configPath: cfgPath,
      env: {
        AGY_DART_DISABLE_STALL_WATCHDOG: "1",
        AGY_DART_STALL_WATCHDOG: "1",
        AGY_DART_WATCHDOG_POLL_MS: "200", // clamped to 1000
        AGY_DART_WATCHDOG_SUSPECT_RATIO: "0.99", // clamped to 0.95
        AGY_DART_WATCHDOG_LLM_LOW_SEC: "5", // clamped to 15
        AGY_DART_WATCHDOG_DESKTOP_NOTIFY: "0",
        AGY_DART_WATCHDOG_NOTIFY_COOLDOWN_SEC: "10" // clamped to 30
      }
    });
    assert.equal(fromEnv.values.stallWatchdog, false);
    assert.equal(fromEnv.sources.stallWatchdog, "env");
    assert.equal(fromEnv.values.watchdogPollMs, 1000);
    assert.equal(fromEnv.values.watchdogSuspectRatio, 0.95);
    assert.equal(fromEnv.values.watchdogLlmLowSec, 15);
    assert.equal(fromEnv.values.watchdogDesktopNotify, false);
    assert.equal(fromEnv.values.watchdogNotifyCooldownSec, 30);

    // 4. Doctor config summary prints Stall watchdog line
    const lines = formatEffectiveConfigLines(fromCfg).join("\n");
    assert.ok(lines.includes("Stall watchdog:"), `Expected Stall watchdog line in:\n${lines}`);
    assert.ok(lines.includes("llm=90s/180s/300s"));

    // 5. Store toggles & lease purge / pruneByTtl
    process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "nonexistent.json");
    delete process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
    delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
    resetConfigCache();

    const store = new ContextModeStore({ dbPath });
    try {
      assert.equal(store.isWatchdogEnabled(), true);
      assert.equal(store.isWatchdogDesktopNotifyEnabled(), false);
      store.setWatchdogEnabled(false);
      assert.equal(store.isWatchdogEnabled(), false);
      store.setWatchdogEnabled(true);
      store.setWatchdogDesktopNotifyEnabled(true);
      assert.equal(store.isWatchdogDesktopNotifyEnabled(), true);

      // Env still overrides SQLite toggle
      process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY = "0";
      assert.equal(store.isWatchdogDesktopNotifyEnabled(), false);
      delete process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
      assert.equal(store.isWatchdogDesktopNotifyEnabled(), true);

      // Lease CRUD & purge isolation
      recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-a" }, { nowMs: 100000 });
      recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-b" }, { nowMs: 100000 });
      assert.equal(listWatchdogLeases(store).length, 2);

      store.purge({ scope: "session", sessionId: "conv-a" });
      assert.equal(readWatchdogLease(store, "conv-a"), null);
      assert.ok(readWatchdogLease(store, "conv-b"));

      // pruneByTtl removes stale watchdog leases
      store.pruneByTtl({ maxAgeDays: 0 });
      assert.equal(readWatchdogLease(store, "conv-b"), null);

      recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-c" }, { nowMs: Date.now() });
      store.purge({ scope: "all" });
      assert.equal(listWatchdogLeases(store).length, 0);
    } finally {
      store.close();
    }
  } finally {
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevNotifyEnv === undefined) delete process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
    else process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY = prevNotifyEnv;
    if (prevDisableEnv === undefined) delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
    else process.env.AGY_DART_DISABLE_STALL_WATCHDOG = prevDisableEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-2: Live 4-hook lease lifecycle (PreInvocation -> PreToolUse -> PostToolUse -> Stop), secret redaction, 0B stderr & 0-SQLite preservation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-hooks-"));
  const dbPath = path.join(tmpDir, "context.db");
  const sampleFile = path.join(tmpDir, "src.js");
  const hugeLog = path.join(tmpDir, "huge.log");
  const skillFile = path.join(tmpDir, "SKILL.md");
  fs.writeFileSync(sampleFile, "export const x = 1;\n", "utf8");
  fs.writeFileSync(hugeLog, "log line\n".repeat(4000), "utf8");
  fs.writeFileSync(skillFile, "# Skill\n", "utf8");

  try {
    // 1. PreInvocation writes LLM_INFLIGHT lease and redacts secrets in lastUserInput
    const rPreInv = runHookRaw(
      "hooks/pre-invocation.mjs",
      {
        conversationId: "conv-live-1",
        cwd: tmpDir,
        invocationNum: 0,
        lastUserInput: "Check token sk-proj-abcdefghijklmnopqrstuvwxyz123456 in auth.js"
      },
      dbPath
    );
    assert.equal(rPreInv.status, 0, rPreInv.stderr);
    assert.equal(Buffer.byteLength(rPreInv.stderr || "", "utf8"), 0, "PreInvocation must emit 0 bytes stderr");

    let store = new ContextModeStore({ dbPath });
    let lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.ok(lease, "PreInvocation must write watchdog_lease");
    assert.equal(lease.phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.ok(!lease.lastUserInput.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), "Must redact secret from lastUserInput");
    assert.ok(lease.lastUserInput.includes("Check token"), "Must preserve non-secret user prompt context");

    // 2. PreToolUse sync run_command -> TOOL_RUNNING (sync_cmd) + redacts inline secret
    const rPreCmd = runHookRaw(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "conv-live-1",
        cwd: tmpDir,
        toolCall: {
          name: "run_command",
          args: { CommandLine: "node deploy.js --token ghp_1234567890abcdefghijklmnopqrstuvwxyz1234", WaitMsBeforeAsync: 8000 }
        }
      },
      dbPath
    );
    assert.equal(rPreCmd.status, 0, rPreCmd.stderr);
    assert.equal(Buffer.byteLength(rPreCmd.stderr || "", "utf8"), 0);
    store = new ContextModeStore({ dbPath });
    lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.equal(lease.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(lease.activeTool, "run_command");
    assert.equal(lease.activeToolKind, "sync_cmd");
    assert.ok(!lease.activeToolSummary.includes("ghp_1234567890"), "Must redact secret from command summary");

    // 3. PreToolUse denied unbounded cat -> transitions back to LLM_INFLIGHT (never stuck in TOOL_RUNNING!)
    const rDenyCmd = runHookRaw(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "conv-live-1",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: `cat "${hugeLog}"`, WaitMsBeforeAsync: 5000 } }
      },
      dbPath
    );
    assert.equal(rDenyCmd.status, 0);
    assert.equal(JSON.parse(rDenyCmd.stdout.trim()).decision, "deny");
    store = new ContextModeStore({ dbPath });
    lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.equal(lease.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Denied tool must return lease to LLM_INFLIGHT");
    assert.equal(lease.activeTool, "");

    // 4. PreToolUse async/daemon run_command -> SUBAGENT_BG
    const rAsyncCmd = runHookRaw(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "conv-live-1",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm run dev", IsDaemon: true, WaitMsBeforeAsync: 500 } }
      },
      dbPath
    );
    assert.equal(rAsyncCmd.status, 0);
    store = new ContextModeStore({ dbPath });
    lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.equal(lease.phase, WATCHDOG_PHASES.SUBAGENT_BG);
    assert.equal(lease.activeToolKind, "async_cmd");

    // 5. PostToolUse sync run_command completion -> LLM_INFLIGHT with lastCompletedTool
    const rPostCmd = runHookRaw(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "conv-live-1",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } },
        toolResponse: "all tests passed"
      },
      dbPath
    );
    assert.equal(rPostCmd.status, 0, rPostCmd.stderr);
    assert.equal(Buffer.byteLength(rPostCmd.stderr || "", "utf8"), 0);
    store = new ContextModeStore({ dbPath });
    lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.equal(lease.phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.equal(lease.lastCompletedTool, "run_command");

    // 6. PostToolUse background task response -> SUBAGENT_BG
    const rPostBg = runHookRaw(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "conv-live-1",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } },
        toolResponse: "Tool is running as a background task with task id: task-99"
      },
      dbPath
    );
    assert.equal(rPostBg.status, 0);
    store = new ContextModeStore({ dbPath });
    lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.equal(lease.phase, WATCHDOG_PHASES.SUBAGENT_BG);

    // 7. Stop hook -> marks lease IDLE with 0-byte stderr and official `{"decision":"allow"}` stdout
    const rStop = runHookRaw(
      "hooks/stop.mjs",
      { conversationId: "conv-live-1", cwd: tmpDir, stopReason: "end_turn" },
      dbPath
    );
    assert.equal(rStop.status, 0, rStop.stderr);
    assert.equal(Buffer.byteLength(rStop.stderr || "", "utf8"), 0, "Stop hook must emit 0 bytes stderr");
    assert.equal(rStop.stdout, '{"decision":"allow"}\n');
    assert.deepEqual(JSON.parse(rStop.stdout.trim()), { decision: "allow" });
    store = new ContextModeStore({ dbPath });
    lease = readWatchdogLease(store, "conv-live-1");
    store.close();
    assert.equal(lease.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(lease.stopReason, "end_turn");

    // 8. Stop hook fails open & never creates orphan DB when DB doesn't exist
    const missingDb = path.join(tmpDir, "never-created-stop.db");
    const rStopNoDb = runHookRaw("hooks/stop.mjs", { conversationId: "conv-x" }, missingDb);
    assert.equal(rStopNoDb.status, 0);
    assert.equal(rStopNoDb.stdout, '{"decision":"allow"}\n');
    assert.equal(fs.existsSync(missingDb), false, "Stop hook must not create a new DB when none exists");

    const rStopBadJson = runHookRaw("hooks/stop.mjs", "{invalid-json", dbPath);
    assert.equal(rStopBadJson.status, 0);
    assert.equal(rStopBadJson.stdout, '{"decision":"allow"}\n');

    // 9. PreToolUse 0-SQLite fast path (SKILL.md) still creates zero DB files
    const fastDb = path.join(tmpDir, "fast-zero-sql.db");
    const rFast = runHookRaw(
      "hooks/pre-tool-use.mjs",
      { conversationId: "conv-fast", toolCall: { name: "read_file", args: { Path: skillFile } } },
      fastDb
    );
    assert.equal(rFast.status, 0);
    assert.equal(fs.existsSync(fastDb), false, "PreToolUse 0-SQLite fast path must remain untouched");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-3: Dynamic timeout matrix across all phases/buckets + yellow suspect -> red stalled + dual-silence transcript growth extension", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-matrix-"));
  const dbPath = path.join(tmpDir, "context.db");
  const txPath = path.join(tmpDir, "transcript.jsonl");
  const store = new ContextModeStore({ dbPath });

  try {
    // 1. Verify every bucket in resolveDynamicThresholds
    assert.deepEqual(
      resolveDynamicThresholds({ phase: WATCHDOG_PHASES.IDLE }),
      { phase: "IDLE", bucket: "idle", suspectSec: 0, stalledSec: 0 }
    );
    assert.equal(resolveDynamicThresholds({ phase: "LLM_INFLIGHT", contextTokens: 50000 }).stalledSec, 120);
    assert.equal(resolveDynamicThresholds({ phase: "LLM_INFLIGHT", contextTokens: 50000 }).suspectSec, 72);
    assert.equal(resolveDynamicThresholds({ phase: "LLM_INFLIGHT", contextTokens: 125000 }).stalledSec, 240);
    assert.equal(resolveDynamicThresholds({ phase: "LLM_INFLIGHT", contextTokens: 40000, isCompactCmd: true }).stalledSec, 240);
    assert.equal(resolveDynamicThresholds({ phase: "LLM_INFLIGHT", contextTokens: 160000, mediaCount: 2 }).stalledSec, 360);
    assert.equal(resolveDynamicThresholds({ phase: "TOOL_RUNNING", activeTool: "read_file", activeToolKind: "read" }).stalledSec, 90);
    assert.equal(resolveDynamicThresholds({ phase: "TOOL_RUNNING", activeTool: "batch_search", activeToolKind: "mcp" }).stalledSec, 90);
    assert.equal(resolveDynamicThresholds({ phase: "TOOL_RUNNING", activeTool: "ctx_execute", activeToolKind: "mcp_long" }).stalledSec, 300);
    assert.equal(resolveDynamicThresholds({ phase: "TOOL_RUNNING", activeTool: "run_command", activeToolKind: "sync_cmd" }).stalledSec, 300);
    assert.equal(resolveDynamicThresholds({ phase: "SUBAGENT_BG" }).stalledSec, 1200);

    // 2. Dual-silence test with injectable wall & monotonic clocks
    let nowMs = 1_700_000_000_000;
    let monoNs = 1_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };

    const userStep = JSON.stringify({ type: "USER_INPUT", user_input: "Investigate flaky test", created_at: new Date(nowMs).toISOString() }) + "\n";
    fs.writeFileSync(txPath, userStep, "utf8");
    const initStat = fs.statSync(txPath);

    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-grow", lastUserInput: "Investigate flaky test", transcriptPath: txPath },
      { nowMs, transcriptMtimeMs: initStat.mtimeMs, transcriptSize: initStat.size, contextTokens: 45000 }
    );

    const appStartTs = nowMs - 10_000;
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      notifyFn: () => {}
    });

    // At +60s (< 72s suspect): active
    advanceSec(60);
    let st = monitor.getStatus({ conversationId: "conv-grow" });
    assert.equal(st.current.severity, "active");

    // At +80s (>= 72s suspect, < 120s stalled): yellow suspect
    advanceSec(20);
    st = monitor.getStatus({ conversationId: "conv-grow" });
    assert.equal(st.current.severity, "suspect");
    assert.ok(st.current.diagnosis, "Suspect state must include diagnosis");
    assert.equal(st.current.rescueBrief, null, "Rescue brief pre-generates on red stalled, not yellow suspect");

    // At +110s, transcript.jsonl grows (streaming thinking/tool step written) -> silence resets!
    advanceSec(30);
    fs.appendFileSync(
      txPath,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ id: "tc1", name: "read_file", args: { Path: "a.js" } }],
        created_at: new Date(nowMs).toISOString()
      }) + "\n",
      "utf8"
    );
    fs.utimesSync(txPath, new Date(nowMs), new Date(nowMs));
    st = monitor.getStatus({ conversationId: "conv-grow" });
    assert.equal(st.current.transcriptGrowing, true, "Growing transcript must be detected");
    assert.equal(st.current.severity, "active", "Transcript growth must extend silence and clear suspect warning");
    assert.ok(st.current.silentSec <= 2);

    // After transcript stops growing for 95s (pending read_file tool threshold = 90s) -> red stalled!
    advanceSec(95);
    st = monitor.getStatus({ conversationId: "conv-grow" });
    assert.equal(st.current.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(st.current.severity, "stalled");
    assert.ok(st.current.rescueBrief && st.current.rescueBrief.markdown.includes("## Stall Rescue Snapshot"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-4: Transcript tail self-healing on missed Stop hook vs genuine hang after prior completed turn + pending MCP/subagent enrichment", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-heal-"));
  const dbPath = path.join(tmpDir, "context.db");
  const txHeal = path.join(tmpDir, "heal.jsonl");
  const txPrior = path.join(tmpDir, "prior-then-hang.jsonl");
  const txMcp = path.join(tmpDir, "pending-mcp.jsonl");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_700_001_000_000;
    let monoNs = 2_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };

    // Case A: Missed Stop hook -> terminal PLANNER_RESPONSE written AFTER PreInvocation -> self-heals to IDLE
    fs.writeFileSync(
      txHeal,
      JSON.stringify({ type: "USER_INPUT", user_input: "Explain store.js", created_at: new Date(nowMs).toISOString() }) + "\n",
      "utf8"
    );
    const stA0 = fs.statSync(txHeal);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-heal", transcriptPath: txHeal },
      { nowMs, transcriptMtimeMs: stA0.mtimeMs, transcriptSize: stA0.size }
    );

    advanceSec(10);
    fs.appendFileSync(
      txHeal,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        content: "Here is the explanation of store.js.",
        stop_reason: "end_turn",
        output_tokens: 80,
        created_at: new Date(nowMs).toISOString()
      }) + "\n",
      "utf8"
    );
    fs.utimesSync(txHeal, new Date(nowMs), new Date(nowMs));

    const appStartTs = nowMs - 60_000;
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      notifyFn: () => {}
    });

    advanceSec(15);
    let statusA = monitor.getStatus({ conversationId: "conv-heal" });
    assert.equal(statusA.current.phase, WATCHDOG_PHASES.IDLE, "Missed Stop hook must self-heal to IDLE");
    assert.equal(statusA.current.selfHealed, true);
    assert.equal(readWatchdogLease(store, "conv-heal").hookEvent, "SidecarHeal");

    // Case B: Prior Turn 1 finished cleanly, then Turn 2 starts & genuinely hangs with 0 new transcript bytes!
    // Watchdog MUST NOT falsely self-heal Turn 2 from Turn 1's old terminal step!
    const turn1DoneTs = nowMs - 60_000;
    fs.writeFileSync(
      txPrior,
      [
        JSON.stringify({ type: "USER_INPUT", user_input: "Turn 1", created_at: new Date(turn1DoneTs - 5000).toISOString() }),
        JSON.stringify({ type: "PLANNER_RESPONSE", content: "Done with Turn 1.", stop_reason: "end_turn", created_at: new Date(turn1DoneTs).toISOString() })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(txPrior, new Date(turn1DoneTs), new Date(turn1DoneTs));
    const stB0 = fs.statSync(txPrior);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-hang-t2", lastUserInput: "Turn 2 please refactor", transcriptPath: txPrior },
      { nowMs, transcriptMtimeMs: stB0.mtimeMs, transcriptSize: stB0.size, contextTokens: 50000 }
    );

    advanceSec(130); // > 120s threshold for <120k LLM_INFLIGHT
    const statusB = monitor.getStatus({ conversationId: "conv-hang-t2" });
    assert.equal(statusB.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Must NOT heal Turn 2 using Turn 1's old terminal step");
    assert.equal(statusB.current.severity, "stalled");
    assert.equal(statusB.current.diagnosis.causeId, "oauth_ghost_or_network");

    // Case C: Pending MCP call in transcript enriches phase to TOOL_RUNNING (mcp_tool_blocked)
    const tMcpStart = nowMs;
    fs.writeFileSync(
      txMcp,
      JSON.stringify({ type: "USER_INPUT", user_input: "Query docs", created_at: new Date(tMcpStart).toISOString() }) + "\n",
      "utf8"
    );
    const stC0 = fs.statSync(txMcp);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-mcp", transcriptPath: txMcp },
      { nowMs: tMcpStart, transcriptMtimeMs: stC0.mtimeMs, transcriptSize: stC0.size }
    );
    advanceSec(5);
    fs.appendFileSync(
      txMcp,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ id: "m1", name: "call_mcp_tool", args: { ServerName: "figma", ToolName: "get_design_context", Arguments: {} } }],
        created_at: new Date(nowMs).toISOString()
      }) + "\n",
      "utf8"
    );
    fs.utimesSync(txMcp, new Date(nowMs), new Date(nowMs));
    monitor.tick(); // observe growth & pending MCP tool

    advanceSec(95); // > 90s fast MCP threshold
    const statusC = monitor.getStatus({ conversationId: "conv-mcp" });
    assert.equal(statusC.current.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(statusC.current.activeTool, "get_design_context");
    assert.equal(statusC.current.severity, "stalled");
    assert.equal(statusC.current.diagnosis.causeId, "mcp_tool_blocked");

    // Unit check: UI-only systemMessage:"" steps are ignored by tail inspector; subagent calls infer SUBAGENT_BG
    const tailSub = inspectTranscriptTailForWatchdog([
      { type: "PLANNER_RESPONSE", tool_calls: [{ id: "s1", name: "schedule", args: { Prompt: "check build" } }], created_at: new Date(nowMs).toISOString() },
      { type: "SYSTEM_MESSAGE", systemMessage: "", metadata: { user_markdown: "> **[agy-dart KV-Cache Watch]** alert" } }
    ]);
    assert.equal(tailSub.isTerminal, false);
    assert.equal(tailSub.hasPendingToolCalls, true);
    assert.equal(tailSub.inferredPhase, WATCHDOG_PHASES.SUBAGENT_BG);
    assert.equal(classifyToolExecutionKind("run_command", { CommandLine: "npm test", WaitMsBeforeAsync: 500 }).isBackground, true);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-5: Rescue Handoff Brief pre-generation, all 4 root-cause attributions, UTF-8/secret redaction & opt-in debounced desktop notifications", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-rescue-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    // 1. All 4 root-cause attribution buckets return 1-2 actionable EN + ZH tips
    const cCompact = diagnoseStallCause({ phase: "LLM_INFLIGHT", contextTokens: 160000, mediaCount: 2, subphase: "multimodal_high_ctx" });
    assert.equal(cCompact.causeId, "auto_compact_deadlock");
    assert.equal(cCompact.tips.length, 2);
    assert.equal(cCompact.tipsZh.length, 2);

    const cTerm = diagnoseStallCause({ phase: "TOOL_RUNNING", activeTool: "run_command", activeToolKind: "sync_cmd" }, { platform: "win32" });
    assert.equal(cTerm.causeId, "terminal_eof_or_interactive");
    assert.ok(cTerm.label.includes("Windows"));

    const cMcp = diagnoseStallCause({ phase: "TOOL_RUNNING", activeTool: "ctx_execute", activeToolKind: "mcp_long" });
    assert.equal(cMcp.causeId, "mcp_tool_blocked");

    const cOauth = diagnoseStallCause({ phase: "LLM_INFLIGHT", contextTokens: 30000 });
    assert.equal(cOauth.causeId, "oauth_ghost_or_network");

    // 2. buildHandoffBrief backward compatibility (without stallContext) vs Rescue Brief (with stallContext + CJK/secret cap)
    const normalBrief = buildHandoffBrief({ store, sessionId: "s-normal", cwd: tmpDir });
    assert.ok(!normalBrief.markdown.includes("Stall Rescue Snapshot"), "Normal handoff brief must stay unchanged");

    const rescueBrief = buildHandoffBrief({
      store,
      sessionId: "s-rescue",
      cwd: tmpDir,
      maxBytes: 900,
      stallContext: {
        severity: "stalled",
        phase: "TOOL_RUNNING",
        subphase: "sync_cmd",
        silentSec: 320,
        stalledThresholdSec: 300,
        activeTool: "run_command",
        activeToolSummary: "deploy --secret sk-ant-api03-1234567890abcdefghijklmnop " + "中文日志测试🚀".repeat(40),
        lastUserInput: "部署到预发环境并跑完集成测试",
        causeId: "terminal_eof_or_interactive",
        causeLabel: "Windows Terminal EOF / Interactive Hang",
        tips: cTerm.tips
      }
    });
    assert.ok(rescueBrief.markdown.includes("## Stall Rescue Snapshot"));
    assert.ok(!rescueBrief.markdown.includes("sk-ant-api03-1234567890"), "Rescue brief must redact secrets");
    assert.ok(rescueBrief.bytes <= 900, `Expected <= 900 B, got ${rescueBrief.bytes}`);
    assert.ok(!rescueBrief.markdown.includes("\uFFFD"), "Rescue brief truncation must remain valid UTF-8");

    // 3. Opt-in & Debounced Desktop Notification gating
    let nowMs = 1_700_002_000_000;
    let monoNs = 3_000_000_000n;
    const notifications = [];
    let notifyConfigOn = false;

    const appStartTs = nowMs - 10_000;
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      getConfig: () => ({
        stallWatchdog: true,
        watchdogPollMs: 5000,
        watchdogSuspectRatio: 0.6,
        watchdogLlmLowSec: 120,
        watchdogDesktopNotify: notifyConfigOn,
        watchdogNotifyCooldownSec: 300
      }),
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: (payload) => notifications.push(payload)
    });

    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-notify", lastUserInput: "Run audit" }, { nowMs });

    // Advance past stalled threshold (130s) with notify OFF (default!) -> 0 notifications
    nowMs += 130_000;
    monoNs += 130_000_000_000n;
    monitor.tick();
    assert.equal(notifications.length, 0, "Desktop notify MUST be OFF by default");

    // Opt-in ON -> fires ONCE, then debounced on repeated ticks for same incident
    notifyConfigOn = true;
    monitor.tick();
    assert.equal(notifications.length, 1, "Opt-in desktop notify should fire once on red stalled");
    nowMs += 10_000;
    monoNs += 10_000_000_000n;
    monitor.tick();
    assert.equal(notifications.length, 1, "Same stalled incident must NOT spam notifications");

    // New incident starts within 300s cooldown -> still suppressed by cooldown!
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-notify", lastUserInput: "Second try" }, { nowMs });
    nowMs += 130_000; // total elapsed since notify = 140s < 300s cooldown
    monoNs += 130_000_000_000n;
    monitor.tick();
    assert.equal(notifications.length, 1, "New incident inside cooldown window must remain debounced");

    // Advance past 300s cooldown -> fires again!
    nowMs += 200_000; // total elapsed since notify = 340s > 300s cooldown
    monoNs += 200_000_000_000n;
    monitor.tick();
    assert.equal(notifications.length, 2, "Notification should fire again once cooldown expires");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-6: Engineering safeguards — zero statSync when IDLE, Sleep Drift Guard, multi-session/subagent isolation & restart stale-lease cleanup", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-guards-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_700_003_000_000;
    let monoNs = 4_000_000_000n;
    const appStartTs = nowMs - 60_000;

    // 1. Restart stale-lease cleanup
    //   - priorApp: active from BEFORE appStartTs -> cleaned to IDLE
    //   - ancientActive: active >2h ago -> cleaned to IDLE
    //   - recentActive: active after appStartTs (30s ago) -> preserved!
    //   - ancientIdle: IDLE >24h ago -> deleted!
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-prior-app" }, { nowMs: appStartTs - 120_000 });
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-ancient-active" }, { nowMs: nowMs - 3 * 3600 * 1000 });
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-recent-active" }, { nowMs: nowMs - 30_000 });
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-ancient-idle" }, { nowMs: nowMs - 30 * 3600 * 1000 });

    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: () => {}
    });

    const cleanRes = monitor.cleanupStaleLeasesOnStartup(nowMs);
    assert.equal(cleanRes.cleaned, 2);
    assert.equal(cleanRes.deleted, 1);
    assert.equal(readWatchdogLease(store, "conv-prior-app").phase, WATCHDOG_PHASES.IDLE);
    assert.equal(readWatchdogLease(store, "conv-prior-app").stopReason, "stale_prior_app_restart");
    assert.equal(readWatchdogLease(store, "conv-ancient-active").phase, WATCHDOG_PHASES.IDLE);
    assert.equal(readWatchdogLease(store, "conv-recent-active").phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.equal(readWatchdogLease(store, "conv-ancient-idle"), null);

    // 2. Zero statSync when ALL leases are IDLE
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-recent-active" }, { nowMs });
    for (let i = 0; i < 5; i++) {
      nowMs += 5000;
      monoNs += 5_000_000_000n;
      monitor.tick();
    }
    assert.equal(monitor.statSyncCount, 0, "Idle conversations MUST incur strictly 0 statSync calls");

    // 3. Sleep Drift Guard (lid-close 10m jump must NOT false-alarm active lease, yet post-wake turn still times out normally)
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-sleep" }, { nowMs });
    nowMs += 5000;
    monoNs += 5_000_000_000n;
    monitor.tick();

    // Simulate OS suspend for 10 minutes (wall clock jumps +600s, monotonic ticks +5s -> POSIX suspend)
    nowMs += 600_000;
    monoNs += 5_000_000_000n;
    const afterWake = monitor.getStatus({ conversationId: "conv-sleep" });
    assert.equal(afterWake.sleepGuard.triggeredCount, 1, "Sleep drift guard must trigger on 10m POSIX jump");
    assert.equal(afterWake.current.severity, "active", "Sleep wake-up MUST NOT trigger false red stall");
    assert.ok(afterWake.current.silentSec < 30, `Expected compensated silence <30s, got ${afterWake.current.silentSec}s`);

    // Simulate Windows S0/S3 suspend where BOTH wall & QPC monotonic jump +600s while poller is running
    monitor.start();
    try {
      nowMs += 600_000;
      monoNs += 600_000_000_000n;
      const afterWinWake = monitor.getStatus({ conversationId: "conv-sleep" });
      assert.equal(afterWinWake.sleepGuard.triggeredCount, 2, "Sleep drift guard must trigger on Windows sleep with active poller");
      assert.equal(afterWinWake.current.severity, "active", "Windows sleep wake-up MUST NOT trigger false red stall");
    } finally {
      monitor.stop();
    }

    // Simulate backward NTP clock jump (-120s) -> must trigger guard and never produce negative silence
    nowMs -= 120_000;
    const afterNtpBack = monitor.getStatus({ conversationId: "conv-sleep" });
    assert.equal(afterNtpBack.sleepGuard.triggeredCount, 3, "Backward NTP clock jump must trigger sleep guard");
    assert.ok(afterNtpBack.current.silentSec >= 0);
    nowMs += 120_000;

    // A brand-new turn starting AFTER wake must NOT inherit the 10-minute grace credit!
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-post-wake" }, { nowMs });
    for (let s = 0; s < 130; s += 5) {
      nowMs += 5000;
      monoNs += 5_000_000_000n;
      monitor.tick();
    }
    assert.equal(
      monitor.getStatus({ conversationId: "conv-post-wake", refresh: false }).current.severity,
      "stalled",
      "Post-wake turn must stall normally after its own 120s timeout"
    );

    // 4. Multi-session & subagent isolation
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-sleep" }, { nowMs });
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-post-wake" }, { nowMs });

    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-parent" }, { nowMs });
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-sub-1",
        parentConversationId: "conv-parent",
        toolCall: { name: "run_command", args: { CommandLine: "npm run build", IsDaemon: true } }
      },
      { nowMs }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-other-idle" }, { nowMs });

    // Advance 140s in steady 5s ticks (so sleep guard doesn't fire):
    // - conv-parent (LLM_INFLIGHT <120k, limit 120s) -> STALLED
    // - conv-sub-1 (SUBAGENT_BG, limit 600s) -> ACTIVE (isolated!)
    // - conv-other-idle (IDLE) -> IDLE (isolated!)
    for (let s = 0; s < 140; s += 5) {
      nowMs += 5000;
      monoNs += 5_000_000_000n;
      monitor.tick();
    }
    const parentSt = monitor.getStatus({ conversationId: "conv-parent", scope: "conversation", refresh: false });
    const subSt = monitor.getStatus({ conversationId: "conv-sub-1", scope: "conversation", refresh: false });
    const idleSt = monitor.getStatus({ conversationId: "conv-other-idle", scope: "conversation", refresh: false });

    assert.equal(parentSt.current.severity, "stalled");
    assert.equal(subSt.current.phase, WATCHDOG_PHASES.SUBAGENT_BG);
    assert.equal(subSt.current.isSubagent, true);
    assert.equal(subSt.current.severity, "active", "Subagent 600s budget must stay active at 140s");
    assert.equal(idleSt.current.severity, "idle", "Unrelated idle conversation must not bleed parent stall");
    assert.ok(idleSt.alertingSessions.some((s) => s.conversationId === "conv-parent"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-7: Sidecar /api/watchdog & /api/watchdog/action CSRF/POST-only security, live Rescue Brief handoff, index.html JS syntax & installer doctor", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-sidecar-"));
  const dbPath = path.join(tmpDir, "context.db");
  const installDir = path.join(tmpDir, "installed-plugin");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;

  try {
    // 1. Static security & syntax checks on server.mjs & index.html
    const serverSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "server.mjs"), "utf8");
    assert.equal(
      /app\.api\([^)]*,\s*["']GET["']\)/.test(serverSrc),
      false,
      "SidecarApp must NOT register GET on any /api/* route including /api/watchdog*"
    );
    assert.ok(serverSrc.includes('app.api("/api/watchdog"'));
    assert.ok(serverSrc.includes('app.api("/api/watchdog/action"'));

    const htmlSrc = readDashboardHtml();
    assert.ok(htmlSrc.includes('id="watchdog-card"'));
    assert.ok(htmlSrc.includes('id="wd-rescue-box"'));
    assert.ok(htmlSrc.includes('id="wd-copy-rescue-btn"'));
    assert.ok(htmlSrc.includes("/api/watchdog/action"));
    assert.equal(/apiFetch\([^)]*method:\s*['"]GET['"]/.test(htmlSrc), false, "index.html must use POST for all /api/* calls");

    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1], "index.html must contain inline script");
    // Must compile with zero JS syntax errors
    new vm.Script(scriptMatch[1], { filename: "sidecars/dashboard/index.html" });

    // 2. Live standalone HTTP server tests with controlled clock
    process.env.AGY_DART_DB_PATH = dbPath;
    process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-cfg.json");
    resetConfigCache();

    const baseNow = Date.now();
    let virtualNow = baseNow;
    let virtualMono = 10_000_000_000n;

    const seed = new ContextModeStore({ dbPath });
    recordHookLeaseTransition(
      seed,
      "PreInvocation",
      { conversationId: "conv-http-1", cwd: tmpDir, lastUserInput: "Fix deadlock in worker" },
      { nowMs: baseNow }
    );
    seed.close();

    // Advance virtual clock 150s -> conv-http-1 is STALLED (>120s)
    virtualNow = baseNow + 150_000;
    virtualMono = 160_000_000_000n;

    const token = "test-v14-csrf-token-0123456789abcdef";
    const srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        nowFn: () => virtualNow,
        monoNsFn: () => virtualMono,
        findTranscriptFn: () => null,
        notifyFn: () => {}
      }
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // Method enforcement: GET /api/watchdog/action -> 405 Allow: POST
      const getMut = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "GET",
        headers: { Host: `127.0.0.1:${port}`, "X-Agy-Dart-Token": token }
      });
      assert.equal(getMut.status, 405);
      assert.equal(getMut.headers.allow, "POST");

      // Missing CSRF token -> 403
      const noTok = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
        body: { conversationId: "conv-http-1" }
      });
      assert.equal(noTok.status, 403);

      // Non-JSON Content-Type -> 415
      const badCt = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "text/plain", "X-Agy-Dart-Token": token },
        body: JSON.stringify({ action: "clear", conversationId: "conv-http-1" })
      });
      assert.equal(badCt.status, 415);

      // Invalid action, path-traversal conversationId -> 400, same-site -> 403
      const badAct = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { action: "killHostProcess", conversationId: "conv-http-1" }
      });
      assert.equal(badAct.status, 400);

      const badConv = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { action: "ack", conversationId: "../../etc/passwd" }
      });
      assert.equal(badConv.status, 400);

      const sameSiteBlocked = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/json",
          "X-Agy-Dart-Token": token,
          "Sec-Fetch-Site": "same-site"
        },
        body: { action: "clear", conversationId: "conv-http-1" }
      });
      assert.equal(sameSiteBlocked.status, 403);

      // Valid POST /api/watchdog -> returns STALLED + pre-generated Rescue Handoff Brief
      const wd = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { scope: "conversation", conversationId: "conv-http-1" }
      });
      assert.equal(wd.status, 200);
      assert.equal(wd.json.ok, true);
      assert.equal(wd.json.desktopNotifyEnabled, false);
      assert.equal(wd.json.current.severity, "stalled");
      assert.ok(wd.json.current.rescueBrief?.markdown.includes("## Stall Rescue Snapshot"));
      assert.ok(wd.json.current.rescueBrief?.markdown.includes("Fix deadlock in worker"));

      // Valid POST /api/handoff automatically includes stallContext for stalled conversation
      const handoff = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { scope: "conversation", conversationId: "conv-http-1" }
      });
      assert.equal(handoff.status, 200);
      assert.equal(handoff.json.hasStallContext, true);
      assert.ok(handoff.json.markdown.includes("## Stall Rescue Snapshot"));

      // Snooze (ack) -> severity becomes "snoozed"
      const ackRes = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { action: "ack", snoozeSec: 300, conversationId: "conv-http-1" }
      });
      assert.equal(ackRes.status, 200);
      assert.equal(ackRes.json.status.current.severity, "snoozed");

      // Toggle opt-in desktop notify ON then OFF
      const notifyOn = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { action: "setDesktopNotify", enabled: true, conversationId: "conv-http-1" }
      });
      assert.equal(notifyOn.status, 200);
      assert.equal(notifyOn.json.desktopNotifyEnabled, true);

      // Mark Idle -> clears stall cleanly
      const clearRes = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: { action: "clear", conversationId: "conv-http-1" }
      });
      assert.equal(clearRes.status, 200);
      assert.equal(clearRes.json.status.current.phase, WATCHDOG_PHASES.IDLE);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }

    // 3. Installer copies watchdog modules + Stop hook and passes doctor
    const ins = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json") }
      }
    );
    assert.equal(ins.status, 0, `${ins.stdout}\n${ins.stderr}`);
    assert.ok(ins.stdout.includes("Stop          : OK"), `Doctor must confirm Stop hook:\n${ins.stdout}`);
    assert.ok(fs.existsSync(path.join(installDir, "hooks", "stop.mjs")));
    assert.ok(fs.existsSync(path.join(installDir, "context", "lib", "watchdog.js")));
    assert.ok(fs.existsSync(path.join(installDir, "context", "lib", "watchdog-lease.js")));
    const installedHooks = JSON.parse(fs.readFileSync(path.join(installDir, "hooks.json"), "utf8"));
    assert.ok(Array.isArray(installedHooks["agy-dart-lifecycle"].Stop));
    assert.ok(installedHooks["agy-dart-lifecycle"].PostToolUse[0].matcher.includes("run_command"));
  } finally {
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-8: Adversarial state-machine hardening — 1s rapid Turn-2 non-heal, GENERIC results, subagent isolation, parallel tools, Tick N+1 token stability, backward NTP jump & SidecarHeal CAS", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-adv-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_700_010_000_000;
    let monoNs = 5_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };
    const appStartTs = nowMs - 60_000;

    // 1. Rapid Turn 2 (800ms after Turn 1 finished) with 0 new transcript bytes MUST NOT falsely self-heal!
    const txRapid = path.join(tmpDir, "rapid.jsonl");
    const t1DoneMs = nowMs;
    fs.writeFileSync(
      txRapid,
      [
        JSON.stringify({ type: "USER_INPUT", user_input: "Turn 1", created_at: new Date(t1DoneMs - 2000).toISOString() }),
        JSON.stringify({ type: "PLANNER_RESPONSE", content: "Done!", stop_reason: "end_turn", created_at: new Date(t1DoneMs).toISOString() })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(txRapid, new Date(t1DoneMs), new Date(t1DoneMs));
    const stRapid0 = fs.statSync(txRapid);

    nowMs = t1DoneMs + 800; // Only 800ms after Turn 1 ended (< old 2000ms bug window!)
    monoNs += 800_000_000n;
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-rapid-t2", lastUserInput: "Turn 2 hung", transcript_path: txRapid },
      { nowMs, transcriptMtimeMs: stRapid0.mtimeMs, transcriptSize: stRapid0.size, contextTokens: 50000 }
    );

    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: () => {}
    });

    advanceSec(5);
    let rRapid = monitor.getStatus({ conversationId: "conv-rapid-t2" });
    assert.equal(rRapid.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Turn 2 starting 800ms after Turn 1 must NOT falsely self-heal");
    assert.equal(rRapid.current.selfHealed, false);

    for (let s = 0; s < 120; s += 5) {
      advanceSec(5);
      monitor.tick();
    }
    rRapid = monitor.getStatus({ conversationId: "conv-rapid-t2", refresh: false });
    assert.equal(rRapid.current.severity, "stalled", "Genuine rapid Turn-2 hang must alert stalled after 120s");

    // 2. Real Antigravity `type: "GENERIC"` tool results, empty `SYSTEM_MESSAGE`, `TURN_ABORTED`, and embedded subagent step isolation
    const tailGeneric = inspectTranscriptTailForWatchdog([
      { type: "USER_INPUT", content: "Inspect codebase" },
      {
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 140000,
        tool_calls: [{ name: "read_file", args: { Path: "a.js" } }]
      },
      { type: "GENERIC", content: "file content here", tool_name: "read_file" },
      {
        type: "PLANNER_RESPONSE",
        subagent: true,
        model: "gemini-2.5-flash",
        input_tokens: 10000,
        content: "Subagent finished!",
        stop_reason: "end_turn"
      },
      { type: "SYSTEM_MESSAGE", content: "" }
    ]);
    assert.equal(tailGeneric.isTerminal, false, "Embedded subagent terminal step must NOT mark parent transcript terminal");
    assert.equal(tailGeneric.contextTokens, 140000, "Embedded subagent must NOT overwrite parent 140k contextTokens");
    assert.equal(tailGeneric.hasPendingToolCalls, false, "GENERIC step must resolve preceding read_file tool call");
    assert.equal(tailGeneric.inferredPhase, WATCHDOG_PHASES.LLM_INFLIGHT);

    assert.equal(
      inspectTranscriptTailForWatchdog([{ type: "TURN_ABORTED", created_at: new Date(nowMs).toISOString() }]).isTerminal,
      true
    );
    assert.equal(
      inspectTranscriptTailForWatchdog([{ type: "USER_CANCEL", created_at: new Date(nowMs).toISOString() }]).isTerminal,
      true
    );

    // 3. Parallel tool calls: PreToolUse(run_command) + PreToolUse(read_file) (allow & deny) must preserve sync_cmd (300s)
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par", toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } } },
      { nowMs, decision: "allow" }
    );
    const parAfterReadAllow = recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par", toolCall: { name: "read_file", args: { Path: "src/index.js" } } },
      { nowMs: nowMs + 10, decision: "allow" }
    );
    assert.equal(parAfterReadAllow.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(parAfterReadAllow.activeToolKind, "sync_cmd", "Parallel read_file allow must NOT downgrade sync_cmd to 90s read");

    const parAfterReadDeny = recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par", toolCall: { name: "read_file", args: { Path: "huge.log" } } },
      { nowMs: nowMs + 20, decision: "deny" }
    );
    assert.equal(parAfterReadDeny.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(parAfterReadDeny.activeToolKind, "sync_cmd", "Parallel read_file deny must NOT clobber active sync_cmd");

    // Transcript parallel unmatched calls pick highest timeout tier (run_command > read_file; swarm/subagent > all)
    const parTail = inspectTranscriptTailForWatchdog([
      {
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { id: "c1", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } },
          { id: "c2", name: "read_file", args: { Path: "a.js" } }
        ]
      }
    ]);
    assert.equal(parTail.pendingTool.activeToolKind, "sync_cmd");
    assert.equal(classifyToolExecutionKind("swarm", { action: "add", prompt: "audit" }).isBackground, true);

    // Active read_file lease upgraded to pending ctx_execute (300s) AND transitions back to LLM_INFLIGHT (240s) when GENERIC completes it
    const txReadUpg = path.join(tmpDir, "read-upgrade.jsonl");
    fs.writeFileSync(txReadUpg, JSON.stringify({ type: "USER_INPUT", content: "Run big script", created_at: new Date(nowMs).toISOString() }) + "\n", "utf8");
    const stRU0 = fs.statSync(txReadUpg);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-read-upg", transcriptPath: txReadUpg },
      { nowMs, transcriptMtimeMs: stRU0.mtimeMs, transcriptSize: stRU0.size, contextTokens: 50000 }
    );
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-read-upg", toolCall: { name: "read_file", args: { Path: "a.js" } } },
      { nowMs: nowMs + 100, decision: "allow" }
    );
    advanceSec(5);
    fs.appendFileSync(
      txReadUpg,
      [
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          input_tokens: 160000,
          media: [{ type: "image" }],
          tool_calls: [
            { id: "r1", name: "read_file", args: { Path: "a.js" } },
            { id: "m1", name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_execute", Arguments: { intent: "parse log" } } }
          ],
          created_at: new Date(nowMs).toISOString()
        }),
        JSON.stringify({ type: "GENERIC", tool_call_id: "r1", content: "ok", created_at: new Date(nowMs).toISOString() })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(txReadUpg, new Date(nowMs), new Date(nowMs));

    // Tick N: upgrades read_file (90s) -> ctx_execute (300s) and captures 160k contextTokens
    let stRU = monitor.getStatus({ conversationId: "conv-read-upg" });
    assert.equal(stRU.current.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(stRU.current.activeTool, "ctx_execute");
    assert.equal(stRU.current.stalledSec, 300);
    assert.equal(stRU.current.contextTokens, 160000);

    // Tick N+1 (cached tail, no file change): MUST preserve ctx_execute (300s) and 160k contextTokens!
    advanceSec(5);
    stRU = monitor.getStatus({ conversationId: "conv-read-upg" });
    assert.equal(stRU.current.activeTool, "ctx_execute");
    assert.equal(stRU.current.stalledSec, 300);
    assert.equal(stRU.current.contextTokens, 160000, "Tick N+1 must NOT collapse contextTokens back to 50k");

    // Now ctx_execute finishes with GENERIC -> wait, lease in SQLite is still read_file; transcript has 0 pending calls -> LLM_INFLIGHT (360s multimodal!)
    advanceSec(5);
    fs.appendFileSync(
      txReadUpg,
      JSON.stringify({ type: "GENERIC", tool_call_id: "m1", content: "done", created_at: new Date(nowMs).toISOString() }) + "\n",
      "utf8"
    );
    fs.utimesSync(txReadUpg, new Date(nowMs), new Date(nowMs));
    stRU = monitor.getStatus({ conversationId: "conv-read-upg" });
    assert.equal(stRU.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Completed read_file/tools in transcript must transition back to LLM_INFLIGHT");
    assert.equal(stRU.current.stalledSec, 360, "160k + media must get 360s multimodal budget");
    // Tick N+1 must ALSO keep 360s multimodal budget!
    advanceSec(5);
    stRU = monitor.getStatus({ conversationId: "conv-read-upg" });
    assert.equal(stRU.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.equal(stRU.current.stalledSec, 360, "Tick N+1 must keep 360s multimodal budget (no collapse to 120s)");

    // 4. Backward NTP clock jump (-120s) MUST NOT blind Watchdog!
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-ntp" }, { nowMs, contextTokens: 40000 });
    advanceSec(5);
    monitor.tick();
    // NTP shifts wall clock backward by 120s while 5s real monotonic time passes
    nowMs = nowMs - 120_000 + 5_000;
    monoNs += 5_000_000_000n;
    let stNtp = monitor.getStatus({ conversationId: "conv-ntp" });
    assert.ok(stNtp.current.silentSec >= 8 && stNtp.current.silentSec <= 12, `Expected ~10s elapsed across backward NTP jump, got ${stNtp.current.silentSec}s`);
    // Advance 115s real time (total real silence = 125s >= 120s threshold) -> MUST be stalled!
    for (let s = 0; s < 115; s += 5) {
      advanceSec(5);
      monitor.tick();
    }
    stNtp = monitor.getStatus({ conversationId: "conv-ntp", refresh: false });
    assert.equal(stNtp.current.severity, "stalled", "Backward NTP jump must NOT blind Watchdog to genuine 120s stall");

    // 5. TOCTOU CAS: concurrent PreInvocation arriving DURING Sidecar readTailFn MUST NOT be overwritten by SidecarHeal!
    const txCas = path.join(tmpDir, "cas.jsonl");
    fs.writeFileSync(txCas, JSON.stringify({ type: "USER_INPUT", content: "Turn 1", created_at: new Date(nowMs).toISOString() }) + "\n", "utf8");
    const stCas0 = fs.statSync(txCas);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-cas", lastUserInput: "Turn 1", transcriptPath: txCas },
      { nowMs, transcriptMtimeMs: stCas0.mtimeMs, transcriptSize: stCas0.size }
    );
    advanceSec(5);
    fs.appendFileSync(
      txCas,
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Turn 1 done", stop_reason: "end_turn", created_at: new Date(nowMs).toISOString() }) + "\n",
      "utf8"
    );
    fs.utimesSync(txCas, new Date(nowMs), new Date(nowMs));
    const stCas1 = fs.statSync(txCas);

    let injectedConcurrentTurn2 = false;
    const casMonitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      readTailFn: (p, bytes) => {
        const lines = fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        if (!injectedConcurrentTurn2 && p === txCas) {
          injectedConcurrentTurn2 = true;
          // Simulate concurrent PreInvocation writing Turn 2 while Sidecar is reading Turn 1's transcript!
          recordHookLeaseTransition(
            store,
            "PreInvocation",
            { conversationId: "conv-cas", lastUserInput: "Turn 2 fresh", transcriptPath: txCas },
            { nowMs: nowMs + 1, transcriptMtimeMs: stCas1.mtimeMs, transcriptSize: stCas1.size }
          );
        }
        return lines;
      },
      findTranscriptFn: () => null,
      notifyFn: () => {}
    });

    const stCas = casMonitor.getStatus({ conversationId: "conv-cas" });
    assert.equal(injectedConcurrentTurn2, true);
    assert.equal(stCas.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "CAS must abort stale SidecarHeal when Turn 2 started concurrently");
    assert.equal(stCas.current.lastUserInput, "Turn 2 fresh");
    assert.equal(readWatchdogLease(store, "conv-cas").phase, WATCHDOG_PHASES.LLM_INFLIGHT);

    // 6. Broad-root lease.cwd (os.homedir()) is rejected when generating Rescue Brief
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-homedir", cwd: os.homedir(), lastUserInput: "Chat without workspace" },
      { nowMs }
    );
    for (let s = 0; s < 130; s += 5) {
      advanceSec(5);
      monitor.tick();
    }
    const stHome = monitor.getStatus({ conversationId: "conv-homedir", refresh: false });
    assert.equal(stHome.current.severity, "stalled");
    assert.ok(stHome.current.rescueBrief?.markdown.includes("## Stall Rescue Snapshot"));
    assert.ok(
      !stHome.current.rescueBrief.markdown.includes(os.homedir().replace(/\\/g, "/")),
      "Broad-root os.homedir() cwd must be rejected from Rescue Brief workspace"
    );
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-9: Production Sidecar env > sqlite precedence, UI disable clears leases & stops hooks, app-scope /api/handoff stall context, SidecarApp routes & notification injection safety", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-prod-"));
  const dbPath = path.join(tmpDir, "context.db");
  const sampleFile = path.join(tmpDir, "sample.js");
  fs.writeFileSync(sampleFile, "export const v = 1;\n", "utf8");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevNotifyEnv = process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
  const prevDisableEnv = process.env.AGY_DART_DISABLE_STALL_WATCHDOG;

  try {
    process.env.AGY_DART_DB_PATH = dbPath;
    process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-cfg.json");
    delete process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
    delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
    resetConfigCache();

    const baseNow = Date.now();
    let virtualNow = baseNow;
    let virtualMono = 20_000_000_000n;

    const seed = new ContextModeStore({ dbPath });
    recordHookLeaseTransition(
      seed,
      "PreInvocation",
      { conversationId: "conv-stalled-app", cwd: tmpDir, lastUserInput: "Deploy release" },
      { nowMs: baseNow, contextTokens: 165000, mediaCount: 1, model: "claude-opus-4-6" }
    );
    recordHookLeaseTransition(seed, "Stop", { conversationId: "conv-idle-app" }, { nowMs: baseNow });
    seed.close();

    // Advance 950s -> conv-stalled-app (>900s opus + >=100k multimodal compound) is STALLED
    virtualNow = baseNow + 950_000;
    virtualMono = 970_000_000_000n;

    const token = "test-v14-prod-csrf-0123456789abcdef";
    const srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        nowFn: () => virtualNow,
        monoNsFn: () => virtualMono,
        findTranscriptFn: () => null,
        notifyFn: () => {}
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const authHeaders = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token };

    try {
      // 1. Standalone app-scope /api/handoff (no conversationId) includes top alerting stallContext + tokens/model,
      //    while conversation-scope for idle conversation stays strictly isolated!
      const appHandoff = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "app" }
      });
      assert.equal(appHandoff.status, 200);
      assert.equal(appHandoff.json.hasStallContext, true);
      assert.ok(appHandoff.json.markdown.includes("## Stall Rescue Snapshot"));
      assert.ok(appHandoff.json.markdown.includes("165k tok"));
      assert.ok(appHandoff.json.markdown.includes("claude-opus-4-6"));

      const idleHandoff = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: "conv-idle-app" }
      });
      assert.equal(idleHandoff.status, 200);
      assert.equal(idleHandoff.json.hasStallContext, false, "Idle conversation must NOT inherit another conversation's stallContext");

      // 2. Env > SQLite precedence in live Sidecar (must NOT be inverted by _hasCustomConfig!)
      const toggleOn = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setDesktopNotify", enabled: true, conversationId: "conv-stalled-app" }
      });
      assert.equal(toggleOn.status, 200);
      assert.equal(toggleOn.json.desktopNotifyEnabled, true);
      assert.equal(toggleOn.json.status.desktopNotifyEnabled, true);

      // Now override via env var = 0 -> BOTH /api/watchdog AND /api/watchdog/action MUST respect env = false!
      process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY = "0";
      const wdEnvNotify = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: "conv-stalled-app" }
      });
      assert.equal(wdEnvNotify.json.desktopNotifyEnabled, false, "Env=0 must beat SQLite desktop_notify=true in live Sidecar");

      const tryToggleUnderEnv = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setDesktopNotify", enabled: true, conversationId: "conv-stalled-app" }
      });
      assert.equal(tryToggleUnderEnv.json.desktopNotifyEnabled, false);
      assert.equal(tryToggleUnderEnv.json.status.desktopNotifyEnabled, false);
      delete process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;

      // Env disable watchdog beats SQLite enabled
      process.env.AGY_DART_DISABLE_STALL_WATCHDOG = "1";
      const wdEnvOff = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: "conv-stalled-app" }
      });
      assert.equal(wdEnvOff.json.enabled, false, "AGY_DART_DISABLE_STALL_WATCHDOG=1 must beat SQLite enabled");
      delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;

      // 3. UI setEnabled(false) clears active leases so re-enabling doesn't flash stale alerts, AND hooks respect SQLite OFF!
      const uiOff = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setEnabled", enabled: false, conversationId: "conv-stalled-app" }
      });
      assert.equal(uiOff.status, 200);
      assert.equal(uiOff.json.enabled, false);

      // Hooks must NOT write new active leases while UI Watchdog is OFF
      const hPre = runHookRaw("hooks/pre-invocation.mjs", { conversationId: "conv-while-off", cwd: tmpDir }, dbPath);
      assert.equal(hPre.status, 0);
      assert.equal(Buffer.byteLength(hPre.stderr || "", "utf8"), 0);
      const hTool = runHookRaw(
        "hooks/pre-tool-use.mjs",
        { conversationId: "conv-while-off", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: sampleFile } } },
        dbPath
      );
      assert.equal(hTool.status, 0);
      const hPost = runHookRaw(
        "hooks/post-tool-use.mjs",
        { conversationId: "conv-while-off", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: "echo hi" } } },
        dbPath
      );
      assert.equal(hPost.status, 0);
      const hStop = runHookRaw("hooks/stop.mjs", { conversationId: "conv-while-off", cwd: tmpDir }, dbPath);
      assert.equal(hStop.status, 0);
      assert.equal(hStop.stdout, '{"decision":"allow"}\n');

      const checkStore = new ContextModeStore({ dbPath });
      assert.equal(readWatchdogLease(checkStore, "conv-while-off"), null, "Hooks must skip writing leases when UI Watchdog is OFF");
      assert.equal(readWatchdogLease(checkStore, "conv-stalled-app").phase, WATCHDOG_PHASES.IDLE, "Disabling Watchdog must clear active leases to IDLE");
      checkStore.close();

      // Re-enabling Watchdog must NOT resurrect stale pre-disable stall!
      const uiOn = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setEnabled", enabled: true, conversationId: "conv-stalled-app" }
      });
      assert.equal(uiOn.json.enabled, true);
      assert.equal(uiOn.json.status.current.phase, WATCHDOG_PHASES.IDLE);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }

    // 4. SidecarApp route registration enforces POST-only & rejects malformed bodies
    const routes = [];
    const mockApp = {
      config: { conversationId: "conv-sdk-1" },
      api(routePath, handler, method) {
        routes.push({ routePath, handler, method });
      }
    };
    registerSidecarRoutes(mockApp);
    const wdRoute = routes.find((r) => r.routePath === "/api/watchdog");
    const wdActRoute = routes.find((r) => r.routePath === "/api/watchdog/action");
    assert.ok(wdRoute && wdRoute.method === "POST");
    assert.ok(wdActRoute && wdActRoute.method === "POST");
    assert.equal(wdRoute.handler("not-an-object").status, 400);
    assert.equal(wdActRoute.handler({ action: "invalidOp" }).status, 400);

    // 5. buildDesktopNotificationCommand injection safety & Windows title length cap
    const evilTitle = "$(calc.exe); `whoami` \"' " + "A".repeat(80);
    const evilBody = "--urgency=critical; rm -rf / & $(powershell -c evil)\nnext line";
    const winCmd = buildDesktopNotificationCommand({ title: evilTitle, body: evilBody, platform: "win32", baseEnv: {} });
    assert.equal(winCmd.cmd, "powershell.exe");
    assert.ok(winCmd.safeTitle.length <= 60, `Windows BalloonTipTitle must stay <= 60 chars, got ${winCmd.safeTitle.length}`);
    assert.equal(winCmd.env.AGY_DART_NOTIFY_TITLE, winCmd.safeTitle);
    assert.equal(winCmd.env.AGY_DART_NOTIFY_BODY, winCmd.safeBody);
    assert.equal(winCmd.args.join(" ").includes("calc.exe"), false, "Untrusted title must NEVER be interpolated into PowerShell script");
    assert.equal(winCmd.args.join(" ").includes("rm -rf"), false, "Untrusted body must NEVER be interpolated into PowerShell script");

    const macCmd = buildDesktopNotificationCommand({ title: evilTitle, body: evilBody, platform: "darwin", baseEnv: {} });
    assert.equal(macCmd.cmd, "osascript");
    assert.equal(macCmd.args[2], "--");
    assert.equal(macCmd.args[3], macCmd.safeTitle);
    assert.equal(macCmd.args[1].includes("calc.exe"), false, "macOS AppleScript must use argv indirection");

    const linCmd = buildDesktopNotificationCommand({ title: "--bad-flag", body: evilBody, platform: "linux", baseEnv: {} });
    assert.equal(linCmd.cmd, "notify-send");
    assert.equal(linCmd.args[2], "--", "Linux notify-send must use -- option terminator before untrusted args");
    assert.equal(linCmd.args[3], "--bad-flag");
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevNotifyEnv === undefined) delete process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY;
    else process.env.AGY_DART_WATCHDOG_DESKTOP_NOTIFY = prevNotifyEnv;
    if (prevDisableEnv === undefined) delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
    else process.env.AGY_DART_DISABLE_STALL_WATCHDOG = prevDisableEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-10: Dashboard index.html Watchdog UI DOM execution — 1s ticker escalation, sleep-wake flash guard, EN/ZH switch, XSS neutralization & Rescue Brief actions", async () => {
  const htmlSrc = readDashboardHtml();
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  // Extract all DOM element IDs from index.html so the lightweight DOM harness has every expected node
  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const attrs = new Map();
    const el = {
      id,
      _text: "",
      _html: "",
      title: "",
      value: "",
      dataset: {},
      style: {},
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c)
      },
      get className() {
        return Array.from(classes).join(" ");
      },
      set className(val) {
        classes.clear();
        for (const c of String(val || "").split(/\s+/).filter(Boolean)) classes.add(c);
      },
      get textContent() {
        return this._text;
      },
      set textContent(v) {
        this._text = String(v ?? "");
      },
      get innerText() {
        return this._text;
      },
      set innerText(v) {
        this._text = String(v ?? "");
      },
      get innerHTML() {
        return this._html;
      },
      set innerHTML(v) {
        this._html = String(v ?? "");
      },
      getAttribute: (k) => attrs.get(k) ?? null,
      setAttribute: (k, v) => attrs.set(k, String(v)),
      scrollIntoView: () => {},
      focus: () => {},
      select: () => {}
    };
    return el;
  };
  for (const m of htmlSrc.matchAll(/\bid="([^"]+)"/g)) {
    if (!elements.has(m[1])) elements.set(m[1], makeEl(m[1]));
  }
  elements.get("wd-enable-btn").dataset.enabled = "1";
  elements.get("wd-notify-btn").dataset.enabled = "0";

  let fakeNow = 1_700_020_000_000;
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fakeNow]));
    }
    static now() {
      return fakeNow;
    }
  }

  const copiedTexts = [];
  const fetchCalls = [];
  const intervals = new Map();
  let nextTimerId = 1;
  const storage = new Map([["agy_dart_dashboard_lang", "zh"]]);

  const sandbox = {
    Date: FakeDate,
    Headers: globalThis.Headers,
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    JSON,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: () => nextTimerId++,
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const id = nextTimerId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v))
    },
    navigator: {
      language: "zh-CN",
      clipboard: {
        writeText: async (text) => {
          copiedTexts.push(text);
        }
      }
    },
    document: {
      documentElement: { lang: "en" },
      title: "",
      body: { appendChild: () => {}, removeChild: () => {} },
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) =>
        sel && sel.includes("agy-dart-csrf") ? { getAttribute: () => "ui-test-csrf" } : null,
      querySelectorAll: () => [],
      createElement: () => makeEl("dynamic")
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: {
            ok: true,
            enabled: true,
            desktopNotifyEnabled: true,
            current: { conversationId: "conv-ui-1", phase: "IDLE", severity: "idle", silentSec: 0, stalledSec: 0 }
          }
        })
      };
    },
    window: {
      location: { search: "" },
      sidecar: null,
      addEventListener: () => {}
    }
  };
  sandbox.window.AGY_DART_CSRF = "ui-test-csrf";
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  // Execute the real index.html script in our isolated DOM harness
  new vm.Script(scriptMatch[1], { filename: "sidecars/dashboard/index.html" }).runInContext(ctx);

  // 1. Initial load in ZH before first API response translates Watchdog pills & badges immediately and hides duplicate phase pill!
  assert.equal(elements.get("wd-enable-btn").textContent, "防卡死：开");
  assert.equal(elements.get("wd-notify-btn").textContent, "桌面弹窗：关");
  assert.equal(elements.get("wd-severity-badge").textContent, "正常待命");
  assert.equal(elements.get("wd-phase-badge").classList.contains("hidden"), true, "Initial IDLE state must hide duplicate phase badge");
  assert.ok(elements.get("wd-status-hint").textContent.includes("对话空闲中"));

  // 1b. Explicit IDLE / high_ctx bucket rendering checks (plain localized labels, no raw snake_case, no duplicate IDLE pills)
  const highCtxActive = {
    ok: true,
    enabled: true,
    desktopNotifyEnabled: false,
    sleepGuard: { triggeredCount: 0 },
    current: {
      conversationId: "conv-ui-hi",
      phase: "LLM_INFLIGHT",
      bucket: "llm_high_ctx",
      severity: "active",
      silentSec: 12,
      suspectSec: 144,
      stalledSec: 240,
      contextTokens: 135000
    },
    alertingSessions: []
  };
  vm.runInContext("cachedWatchdog = hiWd; renderWatchdogCard(hiWd);", Object.assign(ctx, { hiWd: highCtxActive }));
  assert.equal(elements.get("wd-phase-badge").classList.contains("hidden"), false, "Active state must show phase badge");
  assert.equal(elements.get("wd-phase-badge").textContent, "AI 思考/输出中");
  assert.equal(elements.get("wd-bucket-badge").textContent, "高上下文 · 135k");
  assert.ok(!elements.get("wd-bucket-badge").textContent.includes("llm_high_ctx"), "Must not expose raw snake_case bucket ID");
  assert.equal(elements.get("wd-status-hint").classList.contains("hidden"), true, "Active state hides idle hint");

  const idleBgPending = {
    ok: true,
    enabled: true,
    desktopNotifyEnabled: false,
    sleepGuard: { triggeredCount: 0 },
    current: {
      conversationId: "conv-ui-idle",
      phase: "IDLE",
      subphase: "stopped_bg_pending",
      severity: "idle",
      silentSec: 0,
      stalledSec: 0
    },
    alertingSessions: []
  };
  vm.runInContext("cachedWatchdog = idleWd; renderWatchdogCard(idleWd);", Object.assign(ctx, { idleWd: idleBgPending }));
  assert.equal(elements.get("wd-severity-badge").textContent, "正常待命");
  assert.equal(elements.get("wd-phase-badge").classList.contains("hidden"), true, "IDLE render must hide phase badge (no duplicate pills)");
  assert.equal(elements.get("wd-status-hint").classList.contains("hidden"), false);
  assert.ok(elements.get("wd-status-hint").textContent.includes("后台任务仍在运行"));

  // 2. Render active lease, verify 1s local tick escalates green -> yellow -> red, AND laptop sleep jump does NOT flash red!
  const activeWd = {
    ok: true,
    enabled: true,
    desktopNotifyEnabled: false,
    sleepGuard: { triggeredCount: 0 },
    current: {
      conversationId: "conv-ui-1",
      phase: "LLM_INFLIGHT",
      bucket: "llm_low_ctx",
      severity: "active",
      silentSec: 65,
      suspectSec: 72,
      stalledSec: 120,
      contextTokens: 50000
    },
    alertingSessions: []
  };
  vm.runInContext("cachedWatchdog = wdPayload; renderWatchdogCard(wdPayload);", Object.assign(ctx, { wdPayload: activeWd }));
  assert.equal(elements.get("wd-severity-badge").className, "meta-tag is-ok");
  assert.equal(elements.get("wd-bucket-badge").textContent, "常规对话 · 50k");

  // Simulate 10-minute OS sleep jump in client tab -> MUST NOT flash red!
  fakeNow += 600_000;
  vm.runInContext("renderWatchdogLocalTick();", ctx);
  assert.equal(elements.get("wd-severity-badge").className, "meta-tag is-ok", "Client wake-up jump must NOT flash false red stalled");

  // Advance 10 normal 1s ticks (65 + 1 + 10 = 76s >= 72s suspect -> yellow!)
  for (let i = 0; i < 10; i++) {
    fakeNow += 1000;
    vm.runInContext("renderWatchdogLocalTick();", ctx);
  }
  assert.equal(elements.get("wd-severity-badge").className, "meta-tag is-warn", "1s local ticker must transition to yellow suspect");

  // Advance 45 more 1s ticks (121s >= 120s -> red stalled!)
  for (let i = 0; i < 45; i++) {
    fakeNow += 1000;
    vm.runInContext("renderWatchdogLocalTick();", ctx);
  }
  assert.equal(elements.get("wd-severity-badge").className, "meta-tag is-danger", "1s local ticker must transition to red stalled");

  // 3. Render stalled lease with XSS payloads in tool summary, diagnosis, and otherAlerts + EN/ZH toggle
  const xssStalled = {
    ok: true,
    enabled: true,
    desktopNotifyEnabled: false,
    sleepGuard: { triggeredCount: 1 },
    current: {
      conversationId: "conv-ui-1",
      phase: "TOOL_RUNNING",
      bucket: "tool_sync_cmd",
      severity: "stalled",
      silentSec: 315,
      suspectSec: 180,
      stalledSec: 300,
      activeTool: "run_command",
      activeToolSummary: "<img src=x onerror=alert(1)> npm test",
      diagnosis: {
        causeId: "terminal_eof_or_interactive",
        label: "Windows Terminal <script>alert(1)</script>",
        labelZh: "Windows 终端 <script>alert(1)</script>",
        tips: ["Press Ctrl+C <img src=x onerror=alert(2)>", "Use --yes"],
        tipsZh: ["按 Ctrl+C <img src=x onerror=alert(2)>", "使用 --yes"]
      },
      rescueBrief: {
        markdown: "# agy-dart Handoff Brief\n## Stall Rescue Snapshot\n- Status: STALLED",
        summary: "stall=stalled",
        bytes: 72,
        truncated: false
      }
    },
    alertingSessions: [
      { conversationId: "<svg/onload=alert(3)>", severity: "stalled", silentSec: 200, isSubagent: true }
    ]
  };
  vm.runInContext("cachedWatchdog = xssWd; renderWatchdogCard(xssWd);", Object.assign(ctx, { xssWd: xssStalled }));
  assert.ok(!elements.get("wd-tips-list").innerHTML.includes("<img"), "Tips innerHTML must escape XSS");
  assert.ok(elements.get("wd-tips-list").innerHTML.includes("&lt;img"), "Tips innerHTML must contain escaped entity");
  assert.ok(!elements.get("wd-other-alerts").innerHTML.includes("<svg"), "Other alerts innerHTML must escape XSS");
  assert.ok(elements.get("wd-cause-title").textContent.includes("Windows 终端"));

  // Language switch EN <-> ZH preserves syncedAtClientMs and re-renders localized diagnosis
  const syncedBeforeLang = xssStalled._syncedAtClientMs;
  fakeNow += 4000;
  vm.runInContext("setLanguage('en');", ctx);
  assert.equal(xssStalled._syncedAtClientMs, syncedBeforeLang, "Language switch must NOT rewind 1s timer baseline");
  assert.ok(elements.get("wd-cause-title").textContent.includes("Windows Terminal"));
  assert.ok(elements.get("wd-tips-list").innerHTML.includes("Press Ctrl+C"));

  // 4. Copy Rescue Brief, Open Rescue Drawer, Snooze & Mark Idle all work and strictly use POST
  await vm.runInContext("copyWatchdogRescueBrief();", ctx);
  assert.equal(copiedTexts.length, 1);
  assert.ok(copiedTexts[0].includes("## Stall Rescue Snapshot"));

  vm.runInContext("openWatchdogRescueDrawer();", ctx);
  assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), false);
  assert.ok(elements.get("kv-handoff-preview").textContent.includes("## Stall Rescue Snapshot"));

  fetchCalls.length = 0;
  await vm.runInContext("snoozeWatchdogAlert();", ctx);
  await vm.runInContext("markWatchdogIdle();", ctx);
  await vm.runInContext("toggleWatchdogNotify();", ctx);
  await vm.runInContext("toggleWatchdogEnabled();", ctx);
  assert.equal(fetchCalls.length, 4);
  assert.ok(fetchCalls.every((c) => c.method === "POST" && c.url === "/api/watchdog/action"));
  assert.deepEqual(
    fetchCalls.map((c) => c.body.action),
    ["ack", "clear", "setDesktopNotify", "setEnabled"]
  );
});

test("v1.4-11: Antigravity Stop protocol alignment, PostToolUse parallel slow-tool protection & 6-bucket root-cause attribution", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-proto-"));
  const dbPath = path.join(tmpDir, "context.db");
  const editTarget = path.join(tmpDir, "a.js");
  fs.writeFileSync(editTarget, "export const a = 1;\n", "utf8");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_700_030_000_000;
    let monoNs = 10_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };
    const appStartTs = nowMs - 30_000;

    // -------------------------------------------------------------------------
    // 1. Official Antigravity Stop Contract (terminationReason / fullyIdle / error / decision:allow)
    // -------------------------------------------------------------------------
    // Seed active lease then fire live hooks/stop.mjs with official camelCase fields
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-stop-ok", cwd: tmpDir }, { nowMs });
    const rStopOfficial = runHookRaw(
      "hooks/stop.mjs",
      {
        conversationId: "conv-stop-ok",
        cwd: tmpDir,
        terminationReason: "NO_TOOL_CALL",
        stopReason: "legacy_ignored",
        fullyIdle: true,
        error: ""
      },
      dbPath
    );
    assert.equal(rStopOfficial.status, 0, rStopOfficial.stderr);
    assert.equal(Buffer.byteLength(rStopOfficial.stderr || "", "utf8"), 0);
    assert.equal(rStopOfficial.stdout, '{"decision":"allow"}\n');
    let lease = readWatchdogLease(store, "conv-stop-ok");
    assert.equal(lease.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(lease.subphase, "stopped");
    assert.equal(lease.stopReason, "NO_TOOL_CALL", "terminationReason must take priority over stopReason");

    // Disabled env and empty stdin must also emit official {"decision":"allow"}\n with 0B stderr
    const rStopDisabled = runHookRaw(
      "hooks/stop.mjs",
      { conversationId: "conv-stop-ok", terminationReason: "NO_TOOL_CALL" },
      dbPath,
      { AGY_DART_DISABLE_STALL_WATCHDOG: "1" }
    );
    assert.equal(rStopDisabled.status, 0);
    assert.equal(Buffer.byteLength(rStopDisabled.stderr || "", "utf8"), 0);
    assert.equal(rStopDisabled.stdout, '{"decision":"allow"}\n');

    const rStopEmpty = runHookRaw("hooks/stop.mjs", "", dbPath);
    assert.equal(rStopEmpty.status, 0);
    assert.equal(Buffer.byteLength(rStopEmpty.stderr || "", "utf8"), 0);
    assert.equal(rStopEmpty.stdout, '{"decision":"allow"}\n');

    // fullyIdle: false with NO_TOOL_CALL / MAX_INVOCATIONS -> IDLE + subphase="stopped_bg_pending"
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-stop-bg", cwd: tmpDir }, { nowMs });
    const rStopBg = runHookRaw(
      "hooks/stop.mjs",
      {
        conversationId: "conv-stop-bg",
        cwd: tmpDir,
        terminationReason: "NO_TOOL_CALL",
        fullyIdle: false
      },
      dbPath
    );
    assert.equal(rStopBg.status, 0);
    assert.equal(rStopBg.stdout, '{"decision":"allow"}\n');
    lease = readWatchdogLease(store, "conv-stop-bg");
    assert.equal(lease.phase, WATCHDOG_PHASES.IDLE, "fullyIdle:false must stay IDLE to avoid daemon false positives");
    assert.equal(lease.subphase, "stopped_bg_pending", "fullyIdle:false must preserve stopped_bg_pending diagnostic subphase");
    assert.equal(lease.stopReason, "NO_TOOL_CALL");

    // snake_case termination_reason + fully_idle: false works in direct recordHookLeaseTransition too
    const leaseSnakeBg = recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-stop-snake", termination_reason: "MAX_INVOCATIONS", fully_idle: false },
      { nowMs }
    );
    assert.equal(leaseSnakeBg.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(leaseSnakeBg.subphase, "stopped_bg_pending");
    assert.equal(leaseSnakeBg.stopReason, "MAX_INVOCATIONS");

    // Whitespace-only terminationReason falls back cleanly to stopReason
    const leaseBlankTerm = recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-stop-blank", terminationReason: "   ", stopReason: "end_turn" },
      { nowMs }
    );
    assert.equal(leaseBlankTerm.stopReason, "end_turn");

    // USER_CANCELED with fullyIdle: false stays subphase="stopped" (NOT stopped_bg_pending)
    const leaseCanceled = recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-stop-cancel", terminationReason: "USER_CANCELED", fullyIdle: false },
      { nowMs }
    );
    assert.equal(leaseCanceled.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(leaseCanceled.subphase, "stopped");
    assert.equal(leaseCanceled.stopReason, "USER_CANCELED");

    // ERROR with secret + long CJK/emoji error string -> redacted, UTF-8 safe truncated, subphase="stopped"
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-stop-err", cwd: tmpDir }, { nowMs });
    const rStopErr = runHookRaw(
      "hooks/stop.mjs",
      {
        conversationId: "conv-stop-err",
        cwd: tmpDir,
        terminationReason: "ERROR",
        fullyIdle: false,
        error: "Upstream 503 key sk-proj-abcdefghijklmnopqrstuvwxyz123456 报错详情🚀".repeat(4)
      },
      dbPath
    );
    assert.equal(rStopErr.status, 0);
    assert.equal(rStopErr.stdout, '{"decision":"allow"}\n');
    const leaseErr = readWatchdogLease(store, "conv-stop-err");
    assert.equal(leaseErr.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(leaseErr.subphase, "stopped", "ERROR stop must use stopped, not stopped_bg_pending");
    assert.ok(leaseErr.stopReason.startsWith("ERROR: "), `Expected 'ERROR: ...', got ${leaseErr.stopReason}`);
    assert.ok(!leaseErr.stopReason.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), "Stop error must redact secrets");
    assert.ok(Buffer.byteLength(leaseErr.stopReason, "utf8") <= 120, "Stop error must stay <= 120 bytes UTF-8");
    assert.ok(!leaseErr.stopReason.includes("\uFFFD"), "Stop error truncation must be valid UTF-8");

    // ERROR with empty error string -> plain "ERROR" without dangling colon
    const leaseErrEmpty = recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-stop-err-empty", terminationReason: "ERROR", error: "   " },
      { nowMs }
    );
    assert.equal(leaseErrEmpty.stopReason, "ERROR");

    // Unstripped proto enum prefix (EXECUTOR_TERMINATION_REASON_ERROR / USER_CANCELED), British USER_CANCELLED,
    // bare error without terminationReason, and null/primitive payloads must fail-open cleanly
    const leaseEnumErr = recordHookLeaseTransition(
      store,
      "Stop",
      {
        conversationId: "conv-stop-enum-err",
        terminationReason: "EXECUTOR_TERMINATION_REASON_ERROR",
        error: "503 upstream timeout sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        fullyIdle: false
      },
      { nowMs }
    );
    assert.equal(leaseEnumErr.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(leaseEnumErr.subphase, "stopped", "Unstripped EXECUTOR_TERMINATION_REASON_ERROR must not use stopped_bg_pending");
    assert.ok(leaseEnumErr.stopReason.startsWith("ERROR: 503 upstream timeout"));
    assert.ok(!leaseEnumErr.stopReason.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"));

    const leaseEnumCancel = recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-stop-enum-cancel", terminationReason: "EXECUTOR_TERMINATION_REASON_USER_CANCELED", fullyIdle: false },
      { nowMs }
    );
    assert.equal(leaseEnumCancel.subphase, "stopped");

    const leaseBareErr = recordHookLeaseTransition(
      store,
      "Stop",
      { conversationId: "conv-stop-bare-err", error: "502 socket reset", fullyIdle: false },
      { nowMs }
    );
    assert.equal(leaseBareErr.subphase, "stopped");
    assert.equal(leaseBareErr.stopReason, "ERROR: 502 socket reset");

    const rStopNullJson = runHookRaw("hooks/stop.mjs", "null", dbPath);
    assert.equal(rStopNullJson.status, 0);
    assert.equal(Buffer.byteLength(rStopNullJson.stderr || "", "utf8"), 0);
    assert.equal(rStopNullJson.stdout, '{"decision":"allow"}\n');
    assert.doesNotThrow(() => recordHookLeaseTransition(store, "Stop", null));
    assert.equal(diagnoseStallCause(null).causeId, "oauth_ghost_or_network");

    // -------------------------------------------------------------------------
    // 2. PostToolUse parallel fast tool race MUST NOT clobber active slow tool (sync_cmd / mcp_long)
    // -------------------------------------------------------------------------
    const tCmdStart = nowMs;
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-par-post",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } }
      },
      { nowMs: tCmdStart, decision: "allow" }
    );

    // 5ms later, parallel edit_file runs PreToolUse + PostToolUse: NEITHER may clobber active sync_cmd (300s)
    const tPreEdit = tCmdStart + 2;
    const afterPreEdit = recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-par-post",
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: editTarget } }
      },
      { nowMs: tPreEdit, decision: "allow" }
    );
    assert.equal(afterPreEdit.phase, WATCHDOG_PHASES.TOOL_RUNNING, "Parallel PreToolUse(edit_file) must NOT clobber active sync_cmd");
    assert.equal(afterPreEdit.activeTool, "run_command");
    assert.equal(afterPreEdit.activeToolKind, "sync_cmd");
    assert.equal(afterPreEdit.phaseChangedTs, tCmdStart);

    const tEditDone = tCmdStart + 5;
    const afterEdit = recordHookLeaseTransition(
      store,
      "PostToolUse",
      {
        conversationId: "conv-par-post",
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: editTarget } }
      },
      { nowMs: tEditDone, responseText: "Edited a.js" }
    );
    assert.equal(afterEdit.phase, WATCHDOG_PHASES.TOOL_RUNNING, "Parallel edit_file must NOT downgrade sync_cmd to LLM_INFLIGHT");
    assert.equal(afterEdit.subphase, "sync_cmd");
    assert.equal(afterEdit.activeTool, "run_command");
    assert.equal(afterEdit.activeToolKind, "sync_cmd");
    assert.equal(afterEdit.activeToolSummary, "npm test");
    assert.equal(afterEdit.phaseChangedTs, tCmdStart, "Must preserve original slow-tool phaseChangedTs");
    assert.equal(afterEdit.lastCompletedTool, "edit_file");
    assert.equal(afterEdit.lastCompletedToolTs, tEditDone);
    assert.equal(afterEdit.lastHeartbeatTs, tEditDone);

    // Verify end-to-end WatchdogMonitor stays GREEN at 150s (> 120s LLM budget, < 180s sync_cmd yellow)
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: () => {}
    });
    advanceSec(150);
    const stMid = monitor.getStatus({ conversationId: "conv-par-post" });
    assert.equal(stMid.current.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(stMid.current.stalledSec, 300, "Must retain 300s sync_cmd budget after parallel edit_file");
    assert.equal(stMid.current.severity, "active", "Long npm test at 150s must NOT false-alarm red");

    // Live hooks/pre-tool-use.mjs (run_command) -> hooks/post-tool-use.mjs (edit_file) preserves sync_cmd end-to-end
    const rLivePreCmd = runHookRaw(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "conv-par-live",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } }
      },
      dbPath
    );
    assert.equal(rLivePreCmd.status, 0, rLivePreCmd.stderr);
    const liveBeforeEdit = readWatchdogLease(store, "conv-par-live");
    assert.equal(liveBeforeEdit.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(liveBeforeEdit.activeToolKind, "sync_cmd");

    const rLivePostEdit = runHookRaw(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "conv-par-live",
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: editTarget } },
        toolResponse: "File updated"
      },
      dbPath
    );
    assert.equal(rLivePostEdit.status, 0, rLivePostEdit.stderr);
    const afterLiveEdit = readWatchdogLease(store, "conv-par-live");
    assert.equal(afterLiveEdit.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(afterLiveEdit.activeTool, "run_command");
    assert.equal(afterLiveEdit.activeToolKind, "sync_cmd");
    assert.equal(afterLiveEdit.phaseChangedTs, liveBeforeEdit.phaseChangedTs);
    assert.equal(afterLiveEdit.lastCompletedTool, "edit_file");
    assert.ok(afterLiveEdit.lastHeartbeatTs >= liveBeforeEdit.lastHeartbeatTs);

    // Same-tool PostToolUse(run_command) transitions cleanly back to LLM_INFLIGHT
    const afterCmdDone = recordHookLeaseTransition(
      store,
      "PostToolUse",
      {
        conversationId: "conv-par-post",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } }
      },
      { nowMs: nowMs + 1000, responseText: "153 passing" }
    );
    assert.equal(afterCmdDone.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Completing run_command itself must transition to LLM_INFLIGHT");
    assert.equal(afterCmdDone.activeTool, "");
    assert.equal(afterCmdDone.lastCompletedTool, "run_command");

    // Peer tier-3 completion (ctx_execute while run_command active) is NOT treated as low-tier -> transitions to LLM_INFLIGHT
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-par-peer",
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } }
      },
      { nowMs: nowMs + 1200, decision: "allow" }
    );
    const afterPeerTier3 = recordHookLeaseTransition(
      store,
      "PostToolUse",
      {
        conversationId: "conv-par-peer",
        toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_execute", Arguments: { intent: "check" } } }
      },
      { nowMs: nowMs + 1300 }
    );
    assert.equal(afterPeerTier3.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Peer tier-3 completion must not lock lease in sync_cmd");
    assert.equal(afterPeerTier3.activeTool, "");

    // WatchdogMonitor treats stopped_bg_pending as IDLE (no false alarm)
    const stStopBg = monitor.getStatus({ conversationId: "conv-stop-bg" });
    assert.equal(stStopBg.current.phase, WATCHDOG_PHASES.IDLE);
    assert.equal(stStopBg.current.subphase, "stopped_bg_pending");
    assert.equal(stStopBg.current.severity, "idle");

    // Active mcp_long (ctx_execute) also protected against parallel read_file / apply_edits,
    // while peer tier-3 completion or background launch or >600s stale slow tool transitions normally
    const tMcpStart = nowMs + 2000;
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-par-mcp",
        toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_execute", Arguments: { intent: "parse" } } }
      },
      { nowMs: tMcpStart, decision: "allow" }
    );
    const afterApply = recordHookLeaseTransition(
      store,
      "PostToolUse",
      {
        conversationId: "conv-par-mcp",
        toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_fast", ToolName: "apply_edits", Arguments: {} } }
      },
      { nowMs: tMcpStart + 20 }
    );
    assert.equal(afterApply.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(afterApply.activeTool, "ctx_execute");
    assert.equal(afterApply.activeToolKind, "mcp_long");
    assert.equal(afterApply.lastCompletedTool, "apply_edits");

    // Background launch from parallel PostToolUse upgrades to SUBAGENT_BG
    const afterBgLaunch = recordHookLeaseTransition(
      store,
      "PostToolUse",
      {
        conversationId: "conv-par-mcp",
        toolCall: { name: "run_command", args: { CommandLine: "npm run dev", WaitMsBeforeAsync: 500 } }
      },
      { nowMs: tMcpStart + 40 }
    );
    assert.equal(afterBgLaunch.phase, WATCHDOG_PHASES.SUBAGENT_BG);

    // Stale slow tool >= 600_000 ms is NOT preserved forever
    const tStaleStart = nowMs + 5000;
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-par-stale",
        toolCall: { name: "run_command", args: { CommandLine: "long-cmd", WaitMsBeforeAsync: 8000 } }
      },
      { nowMs: tStaleStart, decision: "allow" }
    );
    const afterStaleWindow = recordHookLeaseTransition(
      store,
      "PostToolUse",
      {
        conversationId: "conv-par-stale",
        toolCall: { name: "edit_file", args: { Path: editTarget } }
      },
      { nowMs: tStaleStart + 600_000 }
    );
    assert.equal(afterStaleWindow.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Slow tool older than 600s must NOT block PostToolUse recovery");
    assert.equal(afterStaleWindow.activeTool, "");

    // Parallel same-tool & peer-tier calls correlated via official toolCall.id (both [fast,slow] and [slow,fast] orders + denied peer)
    const tIdBase = nowMs + 10_000;
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par-id-order1", toolCall: { id: "tc_slow_1", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } } },
      { nowMs: tIdBase, decision: "allow" }
    );
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par-id-order1", toolCall: { id: "tc_fast_1", name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } },
      { nowMs: tIdBase + 5, decision: "allow" }
    );
    // Denied parallel call with distinct id must NOT clear tracked slow calls
    const afterDeniedPeerId = recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par-id-order1", toolCall: { id: "tc_deny_1", name: "run_command", args: { CommandLine: "cat huge.log", WaitMsBeforeAsync: 5000 } } },
      { nowMs: tIdBase + 8, decision: "deny" }
    );
    assert.equal(afterDeniedPeerId.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    // Fast run_command finishes first -> restores slow npm test (preserving original tIdBase phaseChangedTs!)
    const afterFastIdDone = recordHookLeaseTransition(
      store,
      "PostToolUse",
      { conversationId: "conv-par-id-order1", toolCall: { id: "tc_fast_1", name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } },
      { nowMs: tIdBase + 25 }
    );
    assert.equal(afterFastIdDone.phase, WATCHDOG_PHASES.TOOL_RUNNING, "Completing fast parallel run_command must restore still-running slow run_command");
    assert.equal(afterFastIdDone.activeToolSummary, "npm test");
    assert.equal(afterFastIdDone.activeToolCallId, "tc_slow_1");
    assert.equal(afterFastIdDone.phaseChangedTs, tIdBase);
    // Peer tier-3 ctx_execute with distinct id finishes while tc_slow_1 is still running -> preserves tc_slow_1
    const afterPeerIdMcp = recordHookLeaseTransition(
      store,
      "PostToolUse",
      { conversationId: "conv-par-id-order1", toolCall: { id: "tc_mcp_1", name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_execute", Arguments: {} } } },
      { nowMs: tIdBase + 40 }
    );
    assert.equal(afterPeerIdMcp.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(afterPeerIdMcp.activeToolCallId, "tc_slow_1");
    // Finally tc_slow_1 finishes -> transitions cleanly to LLM_INFLIGHT
    const afterSlowIdDone = recordHookLeaseTransition(
      store,
      "PostToolUse",
      { conversationId: "conv-par-id-order1", toolCall: { id: "tc_slow_1", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } } },
      { nowMs: tIdBase + 100 }
    );
    assert.equal(afterSlowIdDone.phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.equal(afterSlowIdDone.activeTool, "");
    assert.equal(afterSlowIdDone.activeToolCallId, "");
    assert.deepEqual(afterSlowIdDone.pendingSlowCalls, []);

    // -------------------------------------------------------------------------
    // 3. diagnoseStallCause root-cause attribution fixes (SUBAGENT_BG & TOOL_RUNNING read/other)
    // -------------------------------------------------------------------------
    const cSub = diagnoseStallCause({
      phase: WATCHDOG_PHASES.SUBAGENT_BG,
      activeTool: "browser_subagent",
      activeToolKind: "subagent"
    });
    assert.equal(cSub.causeId, "subagent_or_bg_stalled");
    assert.equal(cSub.label, "Background Task / Subagent Unresponsive");
    assert.equal(cSub.labelZh, "后台任务 / 子代理长时间无响应");
    assert.equal(cSub.tips.length, 2);
    assert.equal(cSub.tipsZh.length, 2);
    assert.ok(!/vpn|oauth|ghost/i.test(cSub.tips.join(" ")), "SUBAGENT_BG tips must NOT blame VPN/OAuth/Ghost Session");
    assert.ok(!/vpn|oauth|ghost/i.test(cSub.tipsZh.join(" ")), "SUBAGENT_BG ZH tips must NOT blame VPN/OAuth/Ghost Session");
    assert.ok(/background|subagent/i.test(cSub.tips[0]));
    assert.ok(/Rescue Handoff Brief/i.test(cSub.tips[1]));

    const cSubAsync = diagnoseStallCause({ phase: WATCHDOG_PHASES.SUBAGENT_BG, activeTool: "run_command", activeToolKind: "async_cmd" });
    assert.equal(cSubAsync.causeId, "subagent_or_bg_stalled");

    const cRead = diagnoseStallCause({
      phase: WATCHDOG_PHASES.TOOL_RUNNING,
      activeTool: "read_file",
      activeToolKind: "read"
    });
    assert.equal(cRead.causeId, "host_tool_blocked");
    assert.equal(cRead.tips.length, 2);
    assert.equal(cRead.tipsZh.length, 2);
    assert.ok(!/vpn|oauth|ghost|mcp/i.test(cRead.tips.join(" ")), "read_file stall must NOT blame VPN/OAuth/MCP");
    assert.ok(!/vpn|oauth|ghost|mcp/i.test(cRead.tipsZh.join(" ")), "read_file ZH tips must NOT blame VPN/OAuth/MCP");
    assert.ok(/read_file/i.test(cRead.tips[0]));

    const cHostOther = diagnoseStallCause({
      phase: WATCHDOG_PHASES.TOOL_RUNNING,
      activeTool: "custom_host_tool",
      activeToolKind: "other"
    });
    assert.equal(cHostOther.causeId, "host_tool_blocked");
    assert.ok(!/vpn|oauth|ghost/i.test(cHostOther.tips.join(" ")), "Non-sync_cmd host tool must NOT fall into oauth_ghost_or_network");

    const cToolBare = diagnoseStallCause({ phase: WATCHDOG_PHASES.TOOL_RUNNING });
    assert.equal(cToolBare.causeId, "host_tool_blocked");

    // Native host tools (edit_file, write_file, grep_search, default_api:edit_file) classify as "host" -> host_tool_blocked,
    // while real MCP tools (call_mcp_tool, mcp_*, server:tool, batch_search) stay "mcp" -> mcp_tool_blocked
    const clsEdit = classifyToolExecutionKind("edit_file", { Path: editTarget });
    assert.equal(clsEdit.activeToolKind, "host", "Native edit_file must NOT be misclassified as mcp");
    assert.equal(classifyToolExecutionKind("default_api:edit_file", { Path: editTarget }).activeToolKind, "host");
    assert.equal(classifyToolExecutionKind("grep_search", { SearchPath: tmpDir }).activeToolKind, "host");
    assert.equal(classifyToolExecutionKind("call_mcp_tool", { ServerName: "figma", ToolName: "get_design_context", Arguments: {} }).activeToolKind, "mcp");
    assert.equal(classifyToolExecutionKind("mcp_figma_get_design_context", {}).activeToolKind, "mcp");
    assert.equal(classifyToolExecutionKind("agy-dart_fast:batch_search", {}).activeToolKind, "mcp");
    assert.equal(classifyToolExecutionKind("batch_search", {}).activeToolKind, "mcp");
    assert.equal(resolveDynamicThresholds({ phase: "TOOL_RUNNING", activeTool: "edit_file", activeToolKind: "host" }).bucket, "tool_host");
    assert.equal(resolveDynamicThresholds({ phase: "TOOL_RUNNING", activeTool: "edit_file", activeToolKind: "host" }).stalledSec, 90);

    const cEditStall = diagnoseStallCause({ phase: WATCHDOG_PHASES.TOOL_RUNNING, activeTool: clsEdit.activeTool, activeToolKind: clsEdit.activeToolKind });
    assert.equal(cEditStall.causeId, "host_tool_blocked");
    assert.ok(!/mcp|vpn|oauth|ghost/i.test(cEditStall.tips.join(" ")), "edit_file stall must NOT blame MCP servers or VPN/OAuth");

    // End-to-end transcript pending edit_file stalling >90s attributes to host_tool_blocked (not mcp_tool_blocked)
    const txHostEdit = path.join(tmpDir, "pending-edit.jsonl");
    fs.writeFileSync(txHostEdit, JSON.stringify({ type: "USER_INPUT", user_input: "Update a.js", created_at: new Date(nowMs).toISOString() }) + "\n", "utf8");
    const stHe0 = fs.statSync(txHostEdit);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-edit-stall", transcriptPath: txHostEdit },
      { nowMs, transcriptMtimeMs: stHe0.mtimeMs, transcriptSize: stHe0.size }
    );
    advanceSec(2);
    fs.appendFileSync(
      txHostEdit,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ id: "e_hang", name: "edit_file", args: { Path: editTarget } }],
        created_at: new Date(nowMs).toISOString()
      }) + "\n",
      "utf8"
    );
    fs.utimesSync(txHostEdit, new Date(nowMs), new Date(nowMs));
    monitor.tick();
    advanceSec(95);
    const stEditStall = monitor.getStatus({ conversationId: "conv-edit-stall" });
    assert.equal(stEditStall.current.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(stEditStall.current.activeTool, "edit_file");
    assert.equal(stEditStall.current.bucket, "tool_host");
    assert.equal(stEditStall.current.severity, "stalled");
    assert.equal(stEditStall.current.diagnosis.causeId, "host_tool_blocked");

    // End-to-end WatchdogMonitor stall diagnosis for SUBAGENT_BG (>600s) and read_file (>90s)
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-sub-stall", toolCall: { name: "browser_subagent", args: { Prompt: "check UI" } } },
      { nowMs, decision: "allow" }
    );
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-read-stall", toolCall: { name: "read_file", args: { Path: editTarget } } },
      { nowMs, decision: "allow" }
    );
    advanceSec(100);
    const stReadStall = monitor.getStatus({ conversationId: "conv-read-stall" });
    assert.equal(stReadStall.current.severity, "stalled");
    assert.equal(stReadStall.current.diagnosis.causeId, "host_tool_blocked");

    advanceSec(1120); // total 1220s > 1200s SUBAGENT_BG threshold
    const stSubStall = monitor.getStatus({ conversationId: "conv-sub-stall" });
    assert.equal(stSubStall.current.severity, "stalled");
    assert.equal(stSubStall.current.diagnosis.causeId, "subagent_or_bg_stalled");
    assert.ok(stSubStall.current.rescueBrief?.markdown.includes("Background Task / Subagent Unresponsive"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4-12: Headless run_workflow worker 600s LLM budget & desktop notify suppression, ERROR_MESSAGE + finish/GENERIC self-heal, and Turn-0 orphan auto-retirement", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v14-wf-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_700_020_000_000;
    let monoNs = 8_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };
    const appStartTs = nowMs - 60_000;
    const notifications = [];

    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartTs,
      getConfig: () => ({
        stallWatchdog: true,
        watchdogPollMs: 5000,
        watchdogSuspectRatio: 0.6,
        watchdogLlmLowSec: 120,
        watchdogLlmHighSec: 240,
        watchdogSubagentSec: 600,
        watchdogDesktopNotify: true,
        watchdogNotifyCooldownSec: 300
      }),
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: (payload) => notifications.push(payload)
    });

    // 1. Headless run_workflow worker ("When you are done, call the finish tool with your result.")
    //    -> detected as isSubagent=true even when full prompt > 240B, gets 600s LLM budget, 0 desktop popups!
    const longHeadlessPrompt =
      "你是 ASR 逐字稿推理专家，请完成本课全部待核查条目。\n" +
      "上下文语料片段：".repeat(60) +
      "\n\nWhen you are done, call the finish tool with your result.";
    assert.equal(isHeadlessWorkerPrompt(longHeadlessPrompt), true);

    const wfLease = recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-wf-worker", lastUserInput: longHeadlessPrompt },
      { nowMs, contextTokens: 195_000 }
    );
    assert.equal(wfLease.isSubagent, true, "Headless finish-tool prompt must set isSubagent=true");

    // Subsequent mid-turn PreInvocation with empty lastUserInput preserves isSubagent=true
    const wfLeaseMid = recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-wf-worker", invocationNum: 17, lastUserInput: "" },
      { nowMs, contextTokens: 195_000 }
    );
    assert.equal(wfLeaseMid.isSubagent, true);

    // At 320s (well past 240s foreground high_ctx limit!), worker is still ACTIVE (320s < 360s suspect / 600s stalled) and fires 0 notifications
    for (let s = 0; s < 320; s += 10) {
      advanceSec(10);
      monitor.tick();
    }
    let stWf = monitor.getStatus({ conversationId: "conv-wf-worker", refresh: false });
    assert.equal(stWf.current.bucket, "subagent_llm");
    assert.equal(stWf.current.stalledSec, 600);
    assert.equal(stWf.current.severity, "active", "320s high-ctx batch worker turn must stay active under 600s subagent budget");
    assert.equal(notifications.length, 0, "Headless worker must NOT trigger false desktop stall popup at 242s-320s");

    // Even if the worker genuinely stalls >600s (620s), Sidecar tracks it as subagent_or_bg_stalled, with 0 desktop OS popups!
    for (let s = 0; s < 300; s += 10) {
      advanceSec(10);
      monitor.tick();
    }
    stWf = monitor.getStatus({ conversationId: "conv-wf-worker", refresh: false });
    assert.equal(stWf.current.severity, "stalled");
    assert.equal(stWf.current.diagnosis.causeId, "subagent_or_bg_stalled");
    assert.equal(notifications.length, 0, "Stalled background worker/subagent must NOT fire foreground OS desktop popup");
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-wf-worker" }, { nowMs });

    // 2. ERROR_MESSAGE stream interruption self-heals when Stop hook is skipped, WITHOUT healing a fresh Turn 2 hang!
    const txErr = path.join(tmpDir, "err-stream.jsonl");
    fs.writeFileSync(
      txErr,
      JSON.stringify({ type: "USER_INPUT", content: "Explain cache TTL", created_at: new Date(nowMs).toISOString() }) + "\n",
      "utf8"
    );
    const stErr0 = fs.statSync(txErr);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-err-heal", transcriptPath: txErr },
      { nowMs, transcriptMtimeMs: stErr0.mtimeMs, transcriptSize: stErr0.size }
    );
    advanceSec(5);
    fs.appendFileSync(
      txErr,
      [
        JSON.stringify({ type: "PLANNER_RESPONSE", status: "DONE", content: "", created_at: new Date(nowMs - 3000).toISOString() }),
        JSON.stringify({
          type: "ERROR_MESSAGE",
          source: "SYSTEM",
          status: "DONE",
          error: { code: "STREAM_INTERRUPTED" },
          content: "Error: The stream was interrupted.",
          created_at: new Date(nowMs).toISOString()
        })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(txErr, new Date(nowMs), new Date(nowMs));

    const stErrHeal = monitor.getStatus({ conversationId: "conv-err-heal" });
    assert.equal(stErrHeal.current.phase, WATCHDOG_PHASES.IDLE, "ERROR_MESSAGE must self-heal missed Stop hook to IDLE");
    assert.equal(stErrHeal.current.selfHealed, true);
    assert.equal(stErrHeal.current.stopReason, "error_message");

    // Turn 2 starts after ERROR_MESSAGE with 0 new bytes -> must NOT falsely self-heal from Turn 1's ERROR_MESSAGE!
    const stErr1 = fs.statSync(txErr);
    advanceSec(2);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-err-heal", lastUserInput: "Retry please", transcriptPath: txErr },
      { nowMs, transcriptMtimeMs: stErr1.mtimeMs, transcriptSize: stErr1.size, contextTokens: 20_000 }
    );
    advanceSec(5);
    const stErrT2 = monitor.getStatus({ conversationId: "conv-err-heal" });
    assert.equal(stErrT2.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Turn 2 must NOT heal from prior Turn 1 ERROR_MESSAGE");
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-err-heal" }, { nowMs });

    // 3. finish tool call followed by GENERIC tool-result receipt resolves as terminal (finish_tool) + detectedSubagent
    const tailFinishGeneric = inspectTranscriptTailForWatchdog([
      { type: "USER_INPUT", content: "Process batch" },
      { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ id: "f1", name: "finish", args: { result: "ok" } }] },
      { type: "GENERIC", status: "DONE", tool_call_id: "f1", content: "Created At: ...\nCompleted At: ..." }
    ]);
    assert.equal(tailFinishGeneric.isTerminal, true, "finish + GENERIC receipt must resolve as terminal");
    assert.equal(tailFinishGeneric.terminalReason, "finish_tool");
    assert.equal(tailFinishGeneric.inferredPhase, WATCHDOG_PHASES.IDLE);
    assert.equal(tailFinishGeneric.detectedSubagent, true);

    // 4. Turn-0 zero-output orphan lease alerts stalled at 130s, then auto-retires at >=900s to restore 0-statSync IDLE fast path
    const txOrphan = path.join(tmpDir, "orphan-t0.jsonl");
    fs.writeFileSync(
      txOrphan,
      [
        JSON.stringify({ type: "USER_INPUT", content: "", created_at: new Date(nowMs).toISOString() }),
        JSON.stringify({ type: "SYSTEM_MESSAGE", content: "[agy-dart startup snapshot]", created_at: new Date(nowMs).toISOString() })
      ].join("\n") + "\n",
      "utf8"
    );
    const stOrp0 = fs.statSync(txOrphan);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-orphan-t0", invocationNum: 0, transcriptPath: txOrphan },
      { nowMs, transcriptMtimeMs: stOrp0.mtimeMs, transcriptSize: stOrp0.size, contextTokens: 0 }
    );

    // At 130s -> alerts stalled (foreground root session -> fires 1 desktop notification)
    for (let s = 0; s < 130; s += 10) {
      advanceSec(10);
      monitor.tick();
    }
    let stOrp = monitor.getStatus({ conversationId: "conv-orphan-t0", refresh: false });
    assert.equal(stOrp.current.severity, "stalled", "Turn-0 hang must still alert stalled at 130s");
    assert.equal(notifications.length, 1, "Foreground root session stall should fire 1 desktop notification");

    // Advance past 900s total silence (e.g. +780s = 910s) -> auto-retires to IDLE and stops statSync!
    for (let s = 0; s < 780; s += 10) {
      advanceSec(10);
      monitor.tick();
    }
    stOrp = monitor.getStatus({ conversationId: "conv-orphan-t0", refresh: false });
    assert.equal(stOrp.current.phase, WATCHDOG_PHASES.IDLE, "Abandoned Turn-0 zero-output orphan must auto-retire after 900s");
    assert.equal(stOrp.current.stopReason, "orphan_turn0_abandoned");

    const statCountAfterRetire = monitor.statSyncCount;
    for (let i = 0; i < 4; i++) {
      advanceSec(5);
      monitor.tick();
    }
    assert.equal(monitor.statSyncCount, statCountAfterRetire, "Once orphan auto-retires, IDLE 0-statSync fast path must resume");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
