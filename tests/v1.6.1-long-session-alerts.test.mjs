import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  CONFIG_DEFAULTS,
  formatEffectiveConfigLines,
  getConfigSnapshot,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  DEFAULT_STALE_LEASE_MS,
  WATCHDOG_PHASES,
  WatchdogMonitor,
  classifyToolExecutionKind,
  deriveLlmSubphase,
  diagnoseStallCause,
  isHighReasoningModel,
  readWatchdogLease,
  recordHookLeaseTransition,
  resolveDynamicThresholds,
  writeWatchdogLease
} from "../context/lib/watchdog.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { suppressSqliteExperimentalWarning } from "../hooks/compile-cache.mjs";
import { closeRuntimeStore, registerSidecarRoutes } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

suppressSqliteExperimentalWarning();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 25));

test("v1.6.1-1: Dynamic timeout matrix (600s / 900s / 1200s), isHighReasoningModel, deriveLlmSubphase, config overrides & diagnoseStallCause", () => {
  // 1. Config defaults & env/file overrides
  assert.equal(CONFIG_DEFAULTS.watchdogLlmReasoningSec, 600);
  assert.equal(CONFIG_DEFAULTS.watchdogLlmCompoundSec, 900);
  assert.equal(CONFIG_DEFAULTS.watchdogSubagentSec, 1200);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v161-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        watchdogLlmReasoningSec: 540,
        watchdogLlmCompoundSec: 840,
        watchdogSubagentSec: 1500
      }),
      "utf8"
    );
    resetConfigCache();
    const cfgSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(cfgSnap.values.watchdogLlmReasoningSec, 540);
    assert.equal(cfgSnap.values.watchdogLlmCompoundSec, 840);
    assert.equal(cfgSnap.values.watchdogSubagentSec, 1500);
    const cfgLines = formatEffectiveConfigLines(cfgSnap).join("\n");
    assert.ok(cfgLines.includes("llm=120s/240s/360s"), cfgLines);
    assert.ok(cfgLines.includes("reasoning=540s/840s"), cfgLines);
    assert.ok(cfgLines.includes("bg=1500s"), cfgLines);

    const envSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: {
        AGY_DART_WATCHDOG_LLM_REASONING_SEC: "700",
        AGY_DART_WATCHDOG_LLM_COMPOUND_SEC: "1080",
        AGY_DART_WATCHDOG_SUBAGENT_SEC: "1800"
      }
    });
    assert.equal(envSnap.values.watchdogLlmReasoningSec, 700);
    assert.equal(envSnap.values.watchdogLlmCompoundSec, 1080);
    assert.equal(envSnap.values.watchdogSubagentSec, 1800);
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // 2. High-reasoning model matcher positive & negative boundary checks
  for (const posModel of [
    "gemini-4-carbon",
    "gemini-4-carbon-high",
    "gemini-4-neon",
    "gemini-4-neon-xhigh",
    "orchestrator-neon",
    "orchestrator_neon",
    "Carbon High",
    "Neon (XHigh)",
    "Claude Thinking",
    "claude-3-7-sonnet-thinking",
    "o1",
    "o3",
    "o4-mini",
    "openai/o3-high",
    "OpenAI (o3)",
    "deepseek-r1",
    "deepseek_r1",
    "claude-opus-4-6",
    "Claude 4 Opus"
  ]) {
    assert.equal(isHighReasoningModel(posModel), true, `Expected reasoning=true for ${posModel}`);
  }
  for (const negModel of [
    "",
    null,
    undefined,
    "gpt-4o",
    "gpt-4o-mini",
    "gemini-4-carbon-low",
    "gemini-4-carbon-medium",
    "gemini-4-neon-low",
    "gemini-4-neon-medium",
    "gemini-4-hydrogen",
    "claude-4-sonnet",
    "deepseek-v3",
    "highlight-v2",
    "corpus-reader"
  ]) {
    assert.equal(isHighReasoningModel(negModel), false, `Expected reasoning=false for ${String(negModel)}`);
  }

  // 3. Full LLM_INFLIGHT + SUBAGENT_BG threshold & subphase matrix
  // Non-reasoning models retain fast 120s / 240s / 360s budgets
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 80_000, model: "claude-4-sonnet" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_low_ctx", suspectSec: 72, stalledSec: 120 }
  );
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 180_000, model: "gpt-4o" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_high_ctx", suspectSec: 144, stalledSec: 240 }
  );
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 50_000, isCompactCmd: true, model: "gpt-4o" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_compact", suspectSec: 144, stalledSec: 240 }
  );
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 105_000, mediaCount: 3, model: "gpt-4o" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_multimodal_high_ctx", suspectSec: 216, stalledSec: 360 }
  );

  // Single high dimension -> 600s (suspect 360s)
  for (const m of ["gemini-4-carbon-high", "gemini-4-neon-xhigh", "Claude Thinking", "o3"]) {
    assert.equal(deriveLlmSubphase({ contextTokens: 90_000, model: m }), "reasoning");
    assert.deepEqual(
      resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 90_000, model: m }),
      { phase: "LLM_INFLIGHT", bucket: "llm_reasoning", suspectSec: 360, stalledSec: 600 }
    );
  }
  assert.equal(deriveLlmSubphase({ contextTokens: 280_000, model: "claude-4-sonnet" }), "ultra_high_ctx");
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 280_000, model: "claude-4-sonnet" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_ultra_high_ctx", suspectSec: 360, stalledSec: 600 }
  );

  // Compound / extreme window -> 900s (suspect 540s)
  assert.equal(deriveLlmSubphase({ contextTokens: 260_000, model: "gemini-4-carbon-high" }), "reasoning_compound");
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 260_000, model: "gemini-4-carbon-high" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_reasoning_compound", suspectSec: 540, stalledSec: 900 }
  );
  assert.equal(
    deriveLlmSubphase({ contextTokens: 110_000, mediaCount: 1, model: "gemini-4-neon-xhigh" }),
    "reasoning_compound"
  );
  assert.deepEqual(
    resolveDynamicThresholds({
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      contextTokens: 110_000,
      mediaCount: 1,
      model: "gemini-4-neon-xhigh"
    }),
    { phase: "LLM_INFLIGHT", bucket: "llm_reasoning_compound", suspectSec: 540, stalledSec: 900 }
  );
  assert.equal(deriveLlmSubphase({ contextTokens: 510_000, model: "gemini-4-argon" }), "reasoning_compound");
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.LLM_INFLIGHT, contextTokens: 510_000, model: "gemini-4-argon" }),
    { phase: "LLM_INFLIGHT", bucket: "llm_reasoning_compound", suspectSec: 540, stalledSec: 900 }
  );

  // Subagent floor -> 1200s default, or explicit custom cfg.watchdogSubagentSec
  assert.deepEqual(
    resolveDynamicThresholds({ phase: WATCHDOG_PHASES.SUBAGENT_BG }),
    { phase: "SUBAGENT_BG", bucket: "subagent_bg", suspectSec: 720, stalledSec: 1200 }
  );
  assert.deepEqual(
    resolveDynamicThresholds({
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      isSubagent: true,
      contextTokens: 280_000,
      model: "gemini-4-carbon-high"
    }),
    { phase: "LLM_INFLIGHT", bucket: "subagent_llm", suspectSec: 720, stalledSec: 1200 }
  );

  // Stall diagnosis attribution for reasoning / ultra_high_ctx / reasoning_compound
  const diagReasoning = diagnoseStallCause({
    phase: WATCHDOG_PHASES.LLM_INFLIGHT,
    contextTokens: 60_000,
    model: "gemini-4-carbon-high",
    subphase: "reasoning"
  });
  assert.equal(diagReasoning.causeId, "deep_reasoning_stall");
  const diagReasoning160k = diagnoseStallCause({
    phase: WATCHDOG_PHASES.LLM_INFLIGHT,
    contextTokens: 160_000,
    mediaCount: 0,
    model: "gemini-4-carbon-high",
    subphase: "reasoning"
  });
  assert.equal(
    diagReasoning160k.causeId,
    "deep_reasoning_stall",
    "160k non-compound high-reasoning turn in 600s llm_reasoning bucket must attribute to deep_reasoning_stall, not auto_compact_deadlock"
  );

  const diagCompound = diagnoseStallCause({
    phase: WATCHDOG_PHASES.LLM_INFLIGHT,
    contextTokens: 310_000,
    model: "gemini-4-neon-xhigh",
    subphase: "reasoning_compound"
  });
  assert.equal(diagCompound.causeId, "auto_compact_deadlock");
  assert.ok(diagCompound.labelZh.includes("深度推理"));

  const diagUltra = diagnoseStallCause({
    phase: WATCHDOG_PHASES.LLM_INFLIGHT,
    contextTokens: 300_000,
    model: "claude-4-sonnet",
    subphase: "ultra_high_ctx"
  });
  assert.equal(diagUltra.causeId, "auto_compact_deadlock");
  assert.ok(diagUltra.labelZh.includes("超长上下文"));
});

test("v1.6.1-2: Split tailIsFreshForEnrich vs tailIsFreshForHeal — >2s (65s) thinking + parallel [write_file, invoke_subagent] and [read_file, call_mcp_tool(ctx_execute)] upgrade cleanly without breaking cross-turn ERROR_MESSAGE safety", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v161-split-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_796_100_000_000;
    let monoNs = 5_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };

    const appStartMs = nowMs - 30_000;
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartMs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null
    });

    // Case A: Model thinks 65s (PLANNER_RESPONSE.created_at = t0 + 100ms), then emits parallel [write_file, invoke_subagent].
    // write_file finishes at t0 + 66s (PostToolUse refreshes lease.updatedTs = t0 + 66s, resetting lease.phase to LLM_INFLIGHT),
    // while invoke_subagent continues running in background!
    const txSub = path.join(tmpDir, "parallel-subagent.jsonl");
    const t0 = nowMs;
    fs.writeFileSync(
      txSub,
      JSON.stringify({ type: "USER_INPUT", content: "Run parallel edit + subagent", created_at: new Date(t0).toISOString() }) + "\n",
      "utf8"
    );
    const stSub0 = fs.statSync(txSub);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-par-sub", transcriptPath: txSub },
      { nowMs: t0, transcriptMtimeMs: stSub0.mtimeMs, transcriptSize: stSub0.size, contextTokens: 50_000 }
    );

    advanceSec(65);
    fs.appendFileSync(
      txSub,
      [
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: new Date(t0 + 100).toISOString(),
          tool_calls: [
            { id: "call-w1", name: "write_file", args: { Path: "a.txt", Content: "ok" } },
            { id: "call-sub1", name: "invoke_subagent", args: { Prompt: "deep audit" } }
          ]
        }),
        JSON.stringify({
          type: "TOOL_RESULT",
          tool_call_id: "call-w1",
          created_at: new Date(nowMs).toISOString(),
          content: "written"
        })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(txSub, new Date(nowMs), new Date(nowMs));

    // Fast parallel write_file triggers PostToolUse 1s later -> lease.updatedTs = t0 + 66s (> lastStepTs + 2s!)
    advanceSec(1);
    recordHookLeaseTransition(
      store,
      "PostToolUse",
      { conversationId: "conv-par-sub", toolCall: { id: "call-w1", name: "write_file", args: { Path: "a.txt" } } },
      { nowMs }
    );

    // Advance 400s (well past 120s LLM_INFLIGHT limit, inside 1200s SUBAGENT_BG budget!)
    advanceSec(400);
    const evalSub = monitor.getStatus({ conversationId: "conv-par-sub" });
    assert.equal(evalSub.current.phase, WATCHDOG_PHASES.SUBAGENT_BG, "tailIsFreshForEnrich must upgrade lease to SUBAGENT_BG despite PostToolUse refreshing updatedTs after 65s thinking");
    assert.equal(evalSub.current.activeTool, "invoke_subagent");
    assert.equal(evalSub.current.stalledSec, 1200);
    assert.equal(evalSub.current.severity, "active");

    // Case B: Model thinks 65s, emits parallel [read_file, call_mcp_tool(ctx_execute)].
    // PreToolUse(read_file) refreshes lease.updatedTs = t1 + 65s with 90s read_file tier -> tailIsFreshForEnrich upgrades to mcp_long (300s)!
    const txMcp = path.join(tmpDir, "parallel-mcp-long.jsonl");
    const t1 = nowMs;
    fs.writeFileSync(
      txMcp,
      JSON.stringify({ type: "USER_INPUT", content: "Read + sandbox execute", created_at: new Date(t1).toISOString() }) + "\n",
      "utf8"
    );
    const stMcp0 = fs.statSync(txMcp);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-par-mcp", transcriptPath: txMcp },
      { nowMs: t1, transcriptMtimeMs: stMcp0.mtimeMs, transcriptSize: stMcp0.size, contextTokens: 40_000 }
    );

    advanceSec(65);
    fs.appendFileSync(
      txMcp,
      [
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: new Date(t1 + 120).toISOString(),
          tool_calls: [
            { id: "r1", name: "read_file", args: { Path: "foo.js" } },
            {
              id: "m1",
              name: "call_mcp_tool",
              args: { ServerName: "agy-dart_context", ToolName: "ctx_execute", Arguments: { language: "nodejs", code: "1+1" } }
            }
          ]
        }),
        JSON.stringify({ type: "TOOL_RESULT", tool_call_id: "r1", created_at: new Date(t1 + 500).toISOString(), content: "ok" })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(txMcp, new Date(nowMs), new Date(nowMs));

    recordHookLeaseTransition(
      store,
      "PreToolUse",
      { conversationId: "conv-par-mcp", toolCall: { id: "r1", name: "read_file", args: { Path: "foo.js" } } },
      { nowMs, decision: "allow" }
    );

    advanceSec(150); // 150s > 90s read_file & > 120s LLM_INFLIGHT, but < 180s suspect / 300s stalled of mcp_long!
    const evalMcp = monitor.getStatus({ conversationId: "conv-par-mcp" });
    assert.equal(evalMcp.current.phase, WATCHDOG_PHASES.TOOL_RUNNING);
    assert.equal(evalMcp.current.activeTool, "ctx_execute");
    assert.equal(evalMcp.current.bucket, "tool_mcp_long");
    assert.equal(evalMcp.current.stalledSec, 300);
    assert.equal(evalMcp.current.severity, "active");

    // Case C: Cross-turn ERROR_MESSAGE safety is preserved (tailIsFreshForHeal remains strict!)
    const txErr = path.join(tmpDir, "cross-turn-err.jsonl");
    fs.writeFileSync(
      txErr,
      [
        JSON.stringify({ type: "USER_INPUT", content: "Turn 1", created_at: new Date(nowMs - 10_000).toISOString() }),
        JSON.stringify({ type: "ERROR_MESSAGE", error: { code: "INTERRUPTED" }, created_at: new Date(nowMs - 5_000).toISOString() })
      ].join("\n") + "\n",
      "utf8"
    );
    const stErr = fs.statSync(txErr);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-err-guard", lastUserInput: "Turn 2 retry", transcriptPath: txErr },
      { nowMs, transcriptMtimeMs: stErr.mtimeMs, transcriptSize: stErr.size, contextTokens: 30_000 }
    );
    advanceSec(10);
    const evalErr = monitor.getStatus({ conversationId: "conv-err-guard" });
    assert.equal(evalErr.current.phase, WATCHDOG_PHASES.LLM_INFLIGHT, "Prior-turn ERROR_MESSAGE must NEVER self-heal Turn 2");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.6.1-3: run_workflow & apply_edits({ verify }) & generate_image classification + 25m (1500s) parent-child subagent heartbeat fusion + SQLite store activity heartbeat", () => {
  // 1. Tool execution classification
  const clsWf = classifyToolExecutionKind("default_api:run_workflow", { name: "batch-asr" });
  assert.equal(clsWf.activeTool, "run_workflow");
  assert.equal(clsWf.activeToolKind, "subagent");
  assert.equal(clsWf.isBackground, true);

  const clsEditVerify = classifyToolExecutionKind("mcp_agy-dart_fast_apply_edits", {
    edits: [{ path: "a.js" }],
    verify: "npm test"
  });
  assert.equal(clsEditVerify.activeTool, "apply_edits");
  assert.equal(clsEditVerify.activeToolKind, "mcp_long");
  assert.equal(clsEditVerify.isBackground, false);

  const clsEditWrappedVerify = classifyToolExecutionKind("call_mcp_tool", {
    ServerName: "agy-dart_fast",
    ToolName: "apply_edits",
    Arguments: JSON.stringify({ edits: [{ path: "a.js" }], verify: "node --test" })
  });
  assert.equal(clsEditWrappedVerify.activeTool, "apply_edits");
  assert.equal(clsEditWrappedVerify.activeToolKind, "mcp_long");

  const clsEditFast = classifyToolExecutionKind("mcp_agy-dart_fast_apply_edits", {
    edits: [{ path: "a.js" }]
  });
  assert.equal(clsEditFast.activeToolKind, "mcp");

  const clsGenImg = classifyToolExecutionKind("default_api:generate_image", { ImageName: "hero", Prompt: "diagram" });
  assert.equal(clsGenImg.activeTool, "generate_image");
  assert.equal(clsGenImg.activeToolKind, "mcp_long");
  assert.equal(
    diagnoseStallCause({ phase: WATCHDOG_PHASES.TOOL_RUNNING, activeTool: "generate_image", activeToolKind: "mcp_long" }).causeId,
    "host_tool_blocked"
  );

  // 2. 25-minute (1500s > 1200s SUBAGENT_BG cap) workflow where child subagents emit heartbeats every 180s
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v161-hb-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });

  try {
    let nowMs = 1_796_200_000_000;
    let monoNs = 10_000_000_000n;
    const advanceSec = (s) => {
      nowMs += s * 1000;
      monoNs += BigInt(s) * 1_000_000_000n;
    };

    const appStartMs = nowMs - 30_000;
    const popups = [];
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartMs,
      getConfig: () => ({
        stallWatchdog: true,
        watchdogDesktopNotify: true,
        watchdogSubagentSec: 1200
      }),
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      notifyFn: (p) => popups.push(p)
    });

    // Parent enters SUBAGENT_BG via run_workflow at t=0 and never receives another direct parent hook for 25 minutes!
    recordHookLeaseTransition(
      store,
      "PreToolUse",
      {
        conversationId: "conv-parent-25m",
        cwd: "e:\\work",
        toolCall: { id: "wf-1", name: "run_workflow", args: { workflow: "deep-audit" } }
      },
      { nowMs, decision: "allow" }
    );

    // First half (0..720s): explicit child -> grandchild subagent heartbeats every 180s
    for (let step = 0; step < 4; step += 1) {
      advanceSec(180);
      recordHookLeaseTransition(
        store,
        "PreInvocation",
        {
          conversationId: "conv-child-coord",
          parentConversationId: "conv-parent-25m",
          cwd: "e:\\work\\agy-dart"
        },
        { nowMs: nowMs - 90_000, isSubagent: true, contextTokens: 80_000, model: "gemini-4-carbon-high" }
      );
      recordHookLeaseTransition(
        store,
        "PreToolUse",
        {
          conversationId: "conv-grandchild-worker",
          parentConversationId: "conv-child-coord",
          rootConversationId: "conv-parent-25m",
          cwd: "e:\\work\\agy-dart",
          toolCall: { id: `gc-${step}`, name: "read_file", args: { Path: "src.js" } }
        },
        { nowMs, decision: "allow", isSubagent: true }
      );
      const stMid = monitor.getStatus({ conversationId: "conv-parent-25m" });
      assert.equal(stMid.current.severity, "active", `Parent must stay active at ${(step + 1) * 180}s via grandchild heartbeat`);
      assert.ok(stMid.current.silentSec <= 5);
    }

    // Retire explicit child & grandchild, then run second half (720s..1500s = 25m total!) via same-CWD headless worker WITHOUT parentConversationId!
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-grandchild-worker" }, { nowMs });
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-child-coord" }, { nowMs });

    for (let step = 0; step < 5; step += 1) {
      advanceSec(156); // 720 + 5*156 = 1500s (25 minutes!)
      recordHookLeaseTransition(
        store,
        "PreInvocation",
        {
          conversationId: "conv-cwd-headless-worker",
          cwd: "e:\\work\\agy-dart",
          lastUserInput: "Audit chunk.\n\nWhen you are done, call the finish tool with your result."
        },
        { nowMs, contextTokens: 140_000, model: "gemini-4-carbon-high" }
      );
      const stLate = monitor.getStatus({ conversationId: "conv-parent-25m" });
      assert.equal(stLate.current.severity, "active", "Same-CWD active headless worker must keep SUBAGENT_BG parent active past 25 minutes");
      assert.ok(stLate.current.silentSec <= 5);
    }
    assert.equal(popups.length, 0, "Zero false stall notifications across 25-minute subagent workflow");

    // 3. Same-session SQLite store activity (events / sources / session_checkpoints) resets silence when preSilentSec >= 30s
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-mcp-sqlite" },
      { nowMs, contextTokens: 60_000, model: "claude-4-sonnet" }
    );
    advanceSec(95); // Would be suspect (>=72s on 120s budget) without SQLite store activity!
    store.open();
    store.db
      .prepare(
        "INSERT INTO events (session_id, worktree, agent, kind, tool, ok, bytes, turn, sandbox_bytes, returned_bytes, created_at) VALUES (?, ?, ?, ?, ?, 1, 100, 1, 100, 50, ?)"
      )
      .run("conv-mcp-sqlite", "e:\\work", "main", "tool", "ctx_index", new Date(nowMs - 5_000).toISOString());

    const stSql = monitor.getStatus({ conversationId: "conv-mcp-sqlite" });
    assert.equal(stSql.current.severity, "active", "Recent SQLite event write for same session must reset silentSec");
    assert.ok(stSql.current.silentSec <= 10);

    // Read-only Sidecar FTS5 search (`store.search()` touching `sources.accessed_ts`) MUST NOT wipe out a genuine stall!
    store.indexContent({
      sessionId: "conv-stalled-search",
      worktree: "e:\\work",
      label: "stalled-doc.md",
      content: "# Architecture\n Stall watchdog regression verification content."
    });
    // Backdate `created_ts` on indexed source so only `accessed_ts` is fresh during search
    store.db
      .prepare("UPDATE sources SET created_ts = ? WHERE session_id = ?")
      .run(nowMs - 300_000, "conv-stalled-search");
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-stalled-search" },
      { nowMs: nowMs - 180_000, contextTokens: 50_000, model: "claude-4-sonnet" }
    );
    store.search({ queries: ["watchdog regression"], sessionId: "conv-stalled-search", scope: "session" });
    const stAfterSearch = monitor.getStatus({ conversationId: "conv-stalled-search" });
    assert.equal(
      stAfterSearch.current.severity,
      "stalled",
      "Read-only Sidecar FTS5 search touching sources.accessed_ts must NOT reset silentSec on a stalled session"
    );

    // 4. First-tick subagent discovery via lookupSummaryFn propagates live transcript growth to SUBAGENT_BG parent immediately
    const txDiscoveredSub = path.join(tmpDir, "discovered-sub.jsonl");
    fs.writeFileSync(txDiscoveredSub, '{"type":"USER_INPUT","content":"sub"}\n', "utf8");
    const stSubInit = fs.statSync(txDiscoveredSub);
    writeWatchdogLease(store, {
      conversationId: "conv-parent-first-tick",
      rootSessionId: "conv-parent-first-tick",
      isSubagent: false,
      phase: WATCHDOG_PHASES.SUBAGENT_BG,
      subphase: "subagent",
      activeTool: "run_workflow",
      activeToolKind: "subagent",
      startedTs: nowMs - 1300_000,
      phaseChangedTs: nowMs - 1300_000,
      updatedTs: nowMs - 1300_000,
      lastHeartbeatTs: nowMs - 1300_000
    });
    writeWatchdogLease(store, {
      conversationId: "conv-unlinked-pretool-sub",
      rootSessionId: "conv-unlinked-pretool-sub",
      parentConversationId: "",
      isSubagent: false,
      phase: WATCHDOG_PHASES.TOOL_RUNNING,
      subphase: "read_or_mcp",
      transcriptPath: txDiscoveredSub,
      transcriptSize: stSubInit.size,
      transcriptMtimeMs: stSubInit.mtimeMs,
      startedTs: nowMs - 200_000,
      phaseChangedTs: nowMs - 200_000,
      updatedTs: nowMs - 200_000,
      lastHeartbeatTs: nowMs - 200_000
    });
    fs.appendFileSync(txDiscoveredSub, '{"type":"PLANNER_RESPONSE","output_tokens":20}\n', "utf8");
    fs.utimesSync(txDiscoveredSub, new Date(nowMs), new Date(nowMs));

    const monSummaryDiscover = new WatchdogMonitor({
      getStore: () => store,
      getAppStartTime: () => appStartMs,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      lookupSummaryFn: (cid) =>
        cid === "conv-unlinked-pretool-sub"
          ? { found: true, isSubagent: true, parentConversationId: "conv-parent-first-tick", agentName: "DeepCoder", title: "" }
          : { found: false }
    });
    const firstTickStatus = monSummaryDiscover.getStatus({ conversationId: "conv-parent-first-tick" });
    assert.equal(
      firstTickStatus.current.severity,
      "active",
      "Summary-discovered subagent must run in subagentPass and feed live transcript growth to parent on the very first tick"
    );
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.6.1-4: Suppress false-idle TTL alerts during stopped_bg_pending, active child subagents, PreInvocation SYSTEM_MESSAGE wakeups & Sidecar active turns — while preserving true-idle 3/3 exhausted popup", async () => {
  const htmlSrc = readDashboardHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v161-ttl-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ stallWatchdog: true, ttlDesktopNotify: true, ttlKeepalive: true }), "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();
  closeRuntimeStore();

  try {
    let nowMs = 1_796_300_000_000;
    let monoNs = 20_000_000_000n;

    // 1. Watchdog desktop TTL popup suppression for `stopped_bg_pending` (with 0 fs.statSync!) and active child subagents,
    //    plus preservation of true-idle exhausted 3/3 popup!
    {
      const store = new ContextModeStore({ dbPath });
      try {
        // Parent A: IDLE with subphase="stopped_bg_pending" (all leases IDLE -> must maintain 0 statSync AND 0 TTL popups!)
        writeWatchdogLease(store, {
          conversationId: "conv-bg-pending",
          rootSessionId: "conv-bg-pending",
          convTitle: "后台等待中",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped_bg_pending",
          stopReason: "NO_TOOL_CALL",
          contextTokens: 180_000,
          cacheTtlSec: 300,
          idleAnchorTs: nowMs - 260_000,
          phaseChangedTs: nowMs - 260_000,
          updatedTs: nowMs - 260_000
        });

        const ttlPopups = [];
        const monIdle = new WatchdogMonitor({
          getStore: () => store,
          getConfig: () => ({
            stallWatchdog: true,
            ttlDesktopNotify: true,
            ttlKeepalive: false,
            ttlNotifyLeadSec: 60,
            ttlNotifyMinTokens: 60_000
          }),
          nowFn: () => nowMs,
          monoNsFn: () => monoNs,
          notifyFn: (n) => {
            ttlPopups.push(n);
            return { dispatched: true };
          }
        });
        monIdle.tick();
        assert.equal(monIdle.statSyncCount, 0, "All-IDLE tick with stopped_bg_pending must maintain 0 fs.statSync");
        assert.equal(ttlPopups.length, 0, "stopped_bg_pending must NOT fire false-idle TTL desktop popup");

        // Parent B: subphase="stopped", BUT has an active child subagent running -> still 0 TTL popups!
        writeWatchdogLease(store, {
          conversationId: "conv-parent-with-child",
          rootSessionId: "conv-parent-with-child",
          convTitle: "主会话等子代理",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          stopReason: "NO_TOOL_CALL",
          contextTokens: 180_000,
          cacheTtlSec: 300,
          idleAnchorTs: nowMs - 260_000,
          phaseChangedTs: nowMs - 260_000,
          updatedTs: nowMs - 260_000
        });
        writeWatchdogLease(store, {
          conversationId: "conv-active-child",
          rootSessionId: "conv-parent-with-child",
          parentConversationId: "conv-parent-with-child",
          isSubagent: true,
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          subphase: "reasoning",
          contextTokens: 90_000,
          model: "gemini-4-carbon-high",
          startedTs: nowMs - 30_000,
          phaseChangedTs: nowMs - 30_000,
          updatedTs: nowMs - 30_000,
          lastHeartbeatTs: nowMs - 30_000
        });
        monIdle.tick();
        assert.equal(ttlPopups.length, 0, "Active child subagent must suppress parent TTL desktop popup");

        // Once child subagent finishes AND parent truly exhausts 3/3 auto-keepalives -> fires exactly 1 desktop alert!
        writeWatchdogLease(store, {
          ...readWatchdogLease(store, "conv-active-child"),
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped",
          updatedTs: nowMs
        });
        store.setTtlKeepaliveState("conv-parent-with-child", {
          usedCount: 3,
          maxCount: 3,
          lastIdleAnchorTs: nowMs - 560_000,
          lastSentTs: nowMs - 300_000,
          pendingAck: false,
          updatedTs: nowMs - 300_000
        });
        const monExhausted = new WatchdogMonitor({
          getStore: () => store,
          getConfig: () => ({
            stallWatchdog: true,
            ttlDesktopNotify: true,
            ttlKeepalive: true,
            ttlKeepaliveMaxCount: 3,
            ttlNotifyLeadSec: 60
          }),
          nowFn: () => nowMs,
          monoNsFn: () => monoNs,
          keepaliveSendFn: async () => ({ ok: true }),
          notifyFn: (n) => {
            ttlPopups.push(n);
            return { dispatched: true };
          }
        });
        store.setTtlKeepaliveEnabled(false, "conv-parent-with-child");
        monExhausted.tick();
        assert.equal(ttlPopups.length, 0, "Turning off warming must silence a previously exhausted conversation");
        store.setTtlKeepaliveEnabled(true, "conv-parent-with-child");
        store.setTtlDesktopNotifyEnabled(false);
        monExhausted.tick();
        assert.equal(ttlPopups.length, 0, "A muted TTL alert must stay silent when warming is exhausted");
        store.setTtlDesktopNotifyEnabled(true);
        monExhausted.tick();
        assert.equal(ttlPopups.length, 1, "True-idle conversation after exhausting 3/3 keepalives must fire 1 desktop alert");
        assert.ok(ttlPopups[0].title.includes("3/3"));
      } finally {
        store.close();
      }
    }

    // 2. PreInvocation hook: suppress TTL / cold-compact banner on background SYSTEM_MESSAGE subagent callback wakeup,
    //    while still alerting when a real human sends USER_INPUT after a cold gap!
    const realNowMs = Date.now();
    const txWake = path.join(tmpDir, "wakeup-tx.jsonl");
    fs.writeFileSync(
      txWake,
      [
        JSON.stringify({
          type: "USER_INPUT",
          user_input: "派子代理排查慢查询",
          created_at: new Date(realNowMs - 600_000).toISOString()
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          model: "gemini-4-carbon-high",
          input_tokens: 180_000,
          cache_read_tokens: 160_000,
          output_tokens: 400,
          created_at: new Date(realNowMs - 480_000).toISOString(),
          tool_calls: [{ id: "sub-1", name: "invoke_subagent", args: { Prompt: "check queries" } }]
        }),
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: "[Message] timestamp=2026-11-23T03:00:00Z sender=sub-worker-1 content=Subagent report ready",
          created_at: new Date(realNowMs - 1_000).toISOString()
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const hookEnv = {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1"
    };

    // Seed `usedCount: 2` + post-compact `file_reads` on `conv-bg-wake`, and test stale `lastUserInput: "/compact"` on background wakeup!
    const txWakeCompact = path.join(tmpDir, "wakeup-compact-tx.jsonl");
    fs.writeFileSync(
      txWakeCompact,
      [
        JSON.stringify({
          type: "USER_INPUT",
          user_input: "/compact",
          created_at: new Date(realNowMs - 600_000).toISOString()
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          model: "gemini-4-carbon-high",
          input_tokens: 90_000,
          cache_read_tokens: 80_000,
          output_tokens: 200,
          created_at: new Date(realNowMs - 500_000).toISOString()
        }),
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: "[Message] timestamp=2026-11-23T03:00:00Z sender=sub-worker-1 content=Subagent report ready",
          created_at: new Date(realNowMs - 1_000).toISOString()
        })
      ].join("\n") + "\n",
      "utf8"
    );
    {
      const stWakeSeed = new ContextModeStore({ dbPath });
      try {
        stWakeSeed.setTtlKeepaliveState("conv-bg-wake", {
          usedCount: 2,
          lastIdleAnchorTs: realNowMs - 500_000,
          lastSentTs: realNowMs - 200_000,
          pendingAck: false,
          updatedTs: realNowMs - 200_000
        });
        stWakeSeed.recordFileRead({
          sessionId: "conv-bg-wake",
          filePath: "e:\\work\\src\\keep.js",
          mtimeMs: 12345,
          fileSize: 512,
          stepIdx: 2
        });
      } finally {
        stWakeSeed.close();
      }
    }

    const bgWakeRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-bg-wake",
        invocationNum: 0,
        initialNumSteps: 3,
        lastUserInput: "/compact", // stale carry-over `/compact` from before subagent callback!
        transcriptPath: txWakeCompact
      }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });
    assert.equal(bgWakeRes.status, 0, bgWakeRes.stderr);
    assert.equal(
      bgWakeRes.stdout.trim(),
      "{}",
      "Subagent SYSTEM_MESSAGE callback wakeup must NOT inject false Idle > TTL banner into chat"
    );
    {
      const stWakeCheck = new ContextModeStore({ dbPath });
      stWakeCheck.open();
      try {
        assert.equal(
          stWakeCheck.getTtlKeepaliveState("conv-bg-wake").usedCount,
          2,
          "Background SYSTEM_MESSAGE wakeup must NOT reset usedCount=2 back to 0 while human is away"
        );
        const keptReads =
          stWakeCheck.db.prepare("SELECT COUNT(*) AS cnt FROM file_reads WHERE session_id = ?").get("conv-bg-wake")?.cnt || 0;
        assert.equal(keptReads, 1, "Background wakeup with stale lastUserInput='/compact' must NOT wipe post-compact file_reads");
        assert.equal(
          readWatchdogLease(stWakeCheck, "conv-bg-wake")?.isCompactCmd,
          false,
          "Background wakeup with stale lastUserInput='/compact' must NOT mark lease.isCompactCmd=true"
        );
      } finally {
        stWakeCheck.close();
      }
    }

    // Genuine human sending a brand-new un-flushed prompt AFTER a trailing SYSTEM_MESSAGE MUST NOT be misclassified as isBackgroundWakeup!
    const humanAfterSysRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({
        conversationId: "conv-bg-wake",
        invocationNum: 0,
        initialNumSteps: 4,
        lastUserInput: "现在开始正式发布新版本", // brand-new human prompt (not yet flushed to transcript!)
        transcriptPath: txWakeCompact
      }),
      encoding: "utf8",
      windowsHide: true,
      env: hookEnv
    });
    assert.equal(humanAfterSysRes.status, 0, humanAfterSysRes.stderr);
    assert.ok(
      humanAfterSysRes.stdout.includes("user_markdown"),
      "Brand-new un-flushed human prompt after trailing SYSTEM_MESSAGE must NOT suppress cold-TTL alert"
    );
    {
      const stHumanCheck = new ContextModeStore({ dbPath });
      try {
        assert.equal(
          stHumanCheck.getTtlKeepaliveState("conv-bg-wake").usedCount,
          0,
          "Genuine new human prompt must reset usedCount back to 0"
        );
      } finally {
        stHumanCheck.close();
      }
    }

    // Direct unit check on evaluateCacheAlerts for isBackgroundWakeup=true vs false
    {
      const stAlert = new ContextModeStore({ dbPath });
      try {
        const mockExpiredDiag = {
          turnsWithUsage: 3,
          currentContextTokens: 180_000,
          warnTokens: 130_000,
          criticalTokens: 250_000,
          watermark: "warn",
          weightedHitRate: 0.9,
          cacheTtlSec: 300,
          idleSeconds: 480,
          ttlRemainingSec: 0,
          ttlStatus: "expired",
          cacheTemperature: "cold",
          compactAdvice: "opportunistic_cold_compact",
          lastPlannerAt: new Date(realNowMs - 480_000).toISOString()
        };
        assert.deepEqual(
          evaluateCacheAlerts(mockExpiredDiag, {
            sessionId: "conv-unit-bg-wake",
            store: stAlert,
            invocationNum: 0,
            isBackgroundWakeup: true
          }),
          [],
          "isBackgroundWakeup=true must suppress both opportunistic_cold_compact warn and expired TTL banners"
        );
        const humanWakeAlerts = evaluateCacheAlerts(mockExpiredDiag, {
          sessionId: "conv-unit-human-wake",
          store: stAlert,
          invocationNum: 0,
          isBackgroundWakeup: false
        });
        assert.ok(humanWakeAlerts.some((a) => a.includes("Idle") || a.includes("已空闲")), "Genuine human wakeup after cold gap must still alert");
      } finally {
        stAlert.close();
      }
    }

    // 3. Sidecar /api/cache-diag + index.html VM: active turn freezes TTL bar in calm blue ("执行中 · 本轮完成后刷新")
    //    and suppresses "冷态可压", then immediately restores red expired countdown once turn enters IDLE (stopped)!
    const brainTranscriptDir = path.join(tmpDir, "brain", "conv-sidecar-live", ".system_generated", "logs");
    fs.mkdirSync(brainTranscriptDir, { recursive: true });
    const txLive = path.join(brainTranscriptDir, "transcript.jsonl");
    fs.writeFileSync(
      txLive,
      [
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          model: "gemini-4-carbon-high",
          input_tokens: 185_000,
          cache_read_tokens: 170_000,
          output_tokens: 500,
          created_at: new Date(realNowMs - 420_000).toISOString()
        })
      ].join("\n") + "\n",
      "utf8"
    );

    const prevSummaryEnv = process.env.AGY_DART_SUMMARY_DB_PATH;
    process.env.AGY_DART_SUMMARY_DB_PATH = path.join(tmpDir, "conversation_summaries.db");
    try {
      {
        const stTxLive = fs.statSync(txLive);
        const stLive = new ContextModeStore({ dbPath });
        writeWatchdogLease(stLive, {
          conversationId: "conv-sidecar-live",
          rootSessionId: "conv-sidecar-live",
          isSubagent: false,
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          subphase: "reasoning",
          model: "gemini-4-carbon-high",
          contextTokens: 185_000,
          transcriptPath: txLive,
          transcriptSize: stTxLive.size,
          transcriptMtimeMs: stTxLive.mtimeMs,
          startedTs: realNowMs - 90_000,
          phaseChangedTs: realNowMs - 90_000,
          updatedTs: realNowMs - 90_000,
          lastHeartbeatTs: realNowMs - 90_000
        });
        stLive.close();
        closeRuntimeStore();
      }

      const routes = new Map();
      registerSidecarRoutes({
        config: { conversationId: "conv-sidecar-live" },
        api(routePath, handler) {
          routes.set(routePath, handler);
        }
      });

      // The sidecar can open mid-turn without access to the host process clock.
      const previousPath = process.env.PATH;
      try {
        process.env.PATH = tmpDir;
        const status = routes.get("/api/watchdog")({ scope: "conversation", conversationId: "conv-sidecar-live" });
        assert.equal(status.current?.phase, WATCHDOG_PHASES.LLM_INFLIGHT,
          "Opening the dashboard must preserve a fresh lease when the host start time is unknown");
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }

      const liveDiag = routes.get("/api/cache-diag")({
        scope: "conversation",
        conversationId: "conv-sidecar-live",
        fromSidecarHost: true
      });
      assert.equal(liveDiag.ok, true);
      assert.equal(liveDiag.conversationActive, true, "/api/cache-diag must report conversationActive=true while turn is in-flight");
      assert.notEqual(
        liveDiag.compactAdvice,
        "opportunistic_cold_compact",
        "Active turn must NOT mark compactAdvice as opportunistic_cold_compact"
      );

      // Run index.html VM to verify blue active TTL bar -> exact red expired TTL restoration on Stop!
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
        dataset: { enabled: "1", used: "0", max: "3", fallback: "3", custom: "0", subagent: "0" },
        options: [],
        classList: {
          add(c) {
            const parts = new Set(String(this._owner.className || "").split(/\s+/).filter(Boolean));
            parts.add(c);
            this._owner.className = Array.from(parts).join(" ");
          },
          remove(c) {
            const parts = String(this._owner.className || "").split(/\s+/).filter((x) => x && x !== c);
            this._owner.className = parts.join(" ");
          },
          contains() { return false; },
          toggle() { return false; }
        },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getAttribute() { return ""; },
        setAttribute() {}
      });
      const getEl = (id) => {
        if (!elements.has(id)) {
          const el = makeEl(id);
          el.classList._owner = el;
          elements.set(id, el);
        }
        return elements.get(id);
      };

      const vmFetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : {};
        const handler = routes.get(url);
        if (!handler) return { ok: true, status: 200, json: async () => ({ ok: true }) };
        const out = await handler(body);
        return { ok: true, status: 200, json: async () => out };
      };

      const vmCtx = vm.createContext({
        window: {
          sidecar: {
            conversationId: "conv-sidecar-live",
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

      assert.equal(getEl("kv-ttl-bar-text").textContent, "执行中 · 本轮完成后刷新");
      assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-active");
      assert.equal(getEl("kv-ttl-badge").textContent, "TTL：执行中");
      assert.equal(getEl("kv-handoff-cue").textContent, "", "Handoff button must NOT show 冷态可压 while turn is active");
      assert.ok(getEl("wd-bucket-badge").textContent.includes("深度推理"), `Expected 深度推理 bucket badge, got: ${getEl("wd-bucket-badge").textContent}`);

      vmCtx.setLanguage("en", true);
      await flushMicrotasks();
      assert.equal(getEl("kv-ttl-bar-text").textContent, "Turn active · refreshes on completion");
      assert.ok(getEl("wd-bucket-badge").textContent.includes("Deep reasoning"));
      vmCtx.setLanguage("zh", true);
      await flushMicrotasks();

      // Clicking `markWatchdogIdle()` (`clear`) immediately unfreezes the TTL bar in place without waiting for /api/cache-diag!
      await vmCtx.markWatchdogIdle();
      await flushMicrotasks();
      assert.ok(
        getEl("kv-ttl-bar-text").textContent.includes("已过期"),
        `markWatchdogIdle() must immediately unfreeze active TTL bar, got: ${getEl("kv-ttl-bar-text").textContent}`
      );

      // Re-seed active in-flight turn (`LLM_INFLIGHT`) + `stopped_bg_pending` lease, then toggle Watchdog OFF mid-turn (`setEnabled: false`)
      // -> must immediately unfreeze `#kv-ttl-bar-fill` from blue `is-active` to red `is-expired` and clear backend leases!
      {
        const stReActive = new ContextModeStore({ dbPath });
        const stTxRe = fs.statSync(txLive);
        writeWatchdogLease(stReActive, {
          conversationId: "conv-sidecar-live",
          rootSessionId: "conv-sidecar-live",
          isSubagent: false,
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          subphase: "reasoning",
          model: "gemini-4-carbon-high",
          contextTokens: 185_000,
          transcriptPath: txLive,
          transcriptSize: stTxRe.size,
          transcriptMtimeMs: stTxRe.mtimeMs,
          startedTs: realNowMs - 60_000,
          phaseChangedTs: realNowMs - 60_000,
          updatedTs: realNowMs - 60_000,
          lastHeartbeatTs: realNowMs - 60_000
        });
        writeWatchdogLease(stReActive, {
          conversationId: "conv-sidecar-bg-wait",
          rootSessionId: "conv-sidecar-bg-wait",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped_bg_pending",
          updatedTs: realNowMs - 30_000,
          lastHeartbeatTs: realNowMs - 30_000
        });
        stReActive.close();
        closeRuntimeStore();
      }
      await vmCtx.refreshData(true);
      assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-active", "Active turn must freeze TTL bar in blue is-active");
      assert.equal(getEl("kv-ttl-bar-text").textContent, "执行中 · 本轮完成后刷新");

      await vmCtx.toggleWatchdogEnabled();
      await flushMicrotasks();
      assert.equal(getEl("wd-severity-badge").textContent, "已关闭");
      assert.equal(
        getEl("kv-ttl-bar-fill").className,
        "ttl-fill is-expired",
        "Toggling Watchdog OFF mid-turn must immediately unfreeze #kv-ttl-bar-fill from is-active to is-expired"
      );
      assert.ok(
        getEl("kv-ttl-bar-text").textContent.includes("已过期"),
        `Toggling Watchdog OFF mid-turn must immediately restore expired TTL countdown, got: ${getEl("kv-ttl-bar-text").textContent}`
      );
      assert.equal(getEl("kv-handoff-cue").textContent, "冷态可压");
      assert.equal(
        routes.get("/api/cache-diag")({ scope: "conversation", conversationId: "conv-sidecar-bg-wait", fromSidecarHost: true }).conversationActive,
        false,
        "Disabling Watchdog must also clear stopped_bg_pending leases so conversationActive becomes false"
      );

      // Even if a still-running turn fires mid-turn PreInvocation (`invocationNum: 1` with `ttlDesktopNotify: true`) while Watchdog is OFF,
      // `/api/cache-diag` and subsequent `refreshData()` polls MUST keep `conversationActive === false` and NEVER re-freeze `#kv-ttl-bar-fill`!
      const midTurnWhileOffRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
        input: JSON.stringify({
          conversationId: "conv-sidecar-live",
          invocationNum: 1,
          transcriptPath: txLive
        }),
        encoding: "utf8",
        windowsHide: true,
        env: hookEnv
      });
      assert.equal(midTurnWhileOffRes.status, 0, midTurnWhileOffRes.stderr);
      closeRuntimeStore();
      assert.equal(
        routes.get("/api/cache-diag")({ scope: "conversation", conversationId: "conv-sidecar-live", fromSidecarHost: true }).conversationActive,
        false,
        "isSidecarConversationActive must return false while Watchdog is disabled even if decoupled PreInvocation wrote LLM_INFLIGHT"
      );
      await vmCtx.refreshData(true);
      assert.equal(
        getEl("kv-ttl-bar-fill").className,
        "ttl-fill is-expired",
        "Subsequent refreshData() polls while Watchdog is OFF must NEVER re-freeze #kv-ttl-bar-fill in blue is-active"
      );

      // Rapid multi-action race: re-enable Watchdog + active turn -> start `changeTtlKeepaliveMax("8")` (in-flight) ->
      // `toggleWatchdogEnabled()` (disables Watchdog mid-turn) -> `changeTtlKeepaliveMax("8")` fails with HTTP 500!
      await vmCtx.toggleWatchdogEnabled();
      {
        const stRaceActive = new ContextModeStore({ dbPath });
        const stTxRace = fs.statSync(txLive);
        writeWatchdogLease(stRaceActive, {
          conversationId: "conv-sidecar-live",
          rootSessionId: "conv-sidecar-live",
          isSubagent: false,
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          subphase: "reasoning",
          model: "gemini-4-carbon-high",
          contextTokens: 185_000,
          transcriptPath: txLive,
          transcriptSize: stTxRace.size,
          transcriptMtimeMs: stTxRace.mtimeMs,
          startedTs: realNowMs - 45_000,
          phaseChangedTs: realNowMs - 45_000,
          updatedTs: realNowMs - 45_000,
          lastHeartbeatTs: realNowMs - 45_000
        });
        stRaceActive.close();
        closeRuntimeStore();
      }
      await vmCtx.refreshData(true);
      assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-active");
      {
        let releaseFailedSetKa = null;
        const origVmFetch = vmCtx.window.sidecar.fetch;
        vmCtx.window.sidecar.fetch = async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/watchdog/action" && body.action === "setTtlKeepalive") {
            await new Promise((r) => {
              releaseFailedSetKa = r;
            });
            return { ok: false, status: 500, json: async () => ({ ok: false }) };
          }
          return origVmFetch(url, opts);
        };
        const pInFlightKa = vmCtx.changeTtlKeepaliveMax("8");
        assert.equal(getEl("kv-keepalive-btn").innerText, "本窗续温：0/8");
        await vmCtx.toggleWatchdogEnabled(); // disables Watchdog mid-turn while setTtlKeepalive("8") is still in-flight!
        assert.equal(getEl("wd-severity-badge").textContent, "已关闭");
        assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-expired");
        releaseFailedSetKa();
        await pInFlightKa;
        await flushMicrotasks();
        await flushMicrotasks();
        vmCtx.window.sidecar.fetch = origVmFetch;
        assert.equal(getEl("wd-severity-badge").textContent, "已关闭", "Failed overlapping keepalive edit must NOT corrupt cachedWatchdog.enabled");
        assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-expired", "Failed overlapping keepalive edit must NOT re-freeze #kv-ttl-bar-fill");
        assert.equal(getEl("kv-keepalive-btn").innerText, "自动续温：0/1", "Overlapping failed keepalive edit must reconcile back to server 0/1");
        assert.equal(getEl("kv-keepalive-max").value, "1");
      }

      // Re-enable Watchdog & re-seed active turn before testing Stop hook restoration
      await vmCtx.toggleWatchdogEnabled();
      {
        const stReSeed = new ContextModeStore({ dbPath });
        const stTxRe = fs.statSync(txLive);
        writeWatchdogLease(stReSeed, {
          conversationId: "conv-sidecar-live",
          rootSessionId: "conv-sidecar-live",
          isSubagent: false,
          phase: WATCHDOG_PHASES.LLM_INFLIGHT,
          subphase: "reasoning",
          model: "gemini-4-carbon-high",
          contextTokens: 185_000,
          transcriptPath: txLive,
          transcriptSize: stTxRe.size,
          transcriptMtimeMs: stTxRe.mtimeMs,
          startedTs: realNowMs - 50_000,
          phaseChangedTs: realNowMs - 50_000,
          updatedTs: realNowMs - 50_000,
          lastHeartbeatTs: realNowMs - 50_000
        });
        stReSeed.close();
        closeRuntimeStore();
      }
      await vmCtx.refreshData(true);
      assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-active");

      // Re-verify Stop hook path -> IDLE (stopped): Sidecar restores exact expired TTL bar & 冷态可压!
      {
        const stStop = new ContextModeStore({ dbPath });
        recordHookLeaseTransition(
          stStop,
          "Stop",
          { conversationId: "conv-sidecar-live", terminationReason: "NO_TOOL_CALL" },
          { nowMs: realNowMs - 420_000 }
        );
        // Also verify `cleanupStaleLeasesOnStartup` retires a prior-app `stopped_bg_pending` lease
        writeWatchdogLease(stStop, {
          conversationId: "conv-prior-app-bg",
          rootSessionId: "conv-prior-app-bg",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped_bg_pending",
          updatedTs: realNowMs - 60_000
        });
        const monBoot = new WatchdogMonitor({
          getStore: () => stStop,
          getAppStartTime: () => realNowMs,
          nowFn: () => realNowMs
        });
        monBoot.cleanupStaleLeasesOnStartup(realNowMs);
        assert.equal(
          readWatchdogLease(stStop, "conv-prior-app-bg")?.subphase,
          "stale_cleanup",
          "cleanupStaleLeasesOnStartup must retire prior-app stopped_bg_pending leases"
        );
        stStop.close();
        closeRuntimeStore();
      }
      await vmCtx.refreshData(true);
      assert.ok(getEl("kv-ttl-bar-text").textContent.includes("已过期"), `Expected expired TTL bar after Stop, got: ${getEl("kv-ttl-bar-text").textContent}`);
      assert.equal(getEl("kv-ttl-bar-fill").className, "ttl-fill is-expired");
      assert.equal(getEl("kv-handoff-cue").textContent, "冷态可压");

      // Orphaned `stopped_bg_pending` lease older than `DEFAULT_STALE_LEASE_MS` (>2h) must NOT freeze Sidecar TTL bar blue!
      {
        const stOldBg = new ContextModeStore({ dbPath });
        const staleTs = realNowMs - DEFAULT_STALE_LEASE_MS - 60_000;
        writeWatchdogLease(stOldBg, {
          conversationId: "conv-sidecar-live",
          rootSessionId: "conv-sidecar-live",
          isSubagent: false,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "stopped_bg_pending",
          stopReason: "NO_TOOL_CALL",
          transcriptPath: txLive,
          idleAnchorTs: staleTs,
          phaseChangedTs: staleTs,
          updatedTs: staleTs,
          lastHeartbeatTs: staleTs
        });
        stOldBg.close();
        closeRuntimeStore();
      }
      const staleBgDiag = routes.get("/api/cache-diag")({
        scope: "conversation",
        conversationId: "conv-sidecar-live",
        fromSidecarHost: true
      });
      assert.equal(
        staleBgDiag.conversationActive,
        false,
        "Stale (>2h) stopped_bg_pending lease must NOT report conversationActive=true"
      );
      closeRuntimeStore();
    } finally {
      if (prevSummaryEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
      else process.env.AGY_DART_SUMMARY_DB_PATH = prevSummaryEnv;
    }
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {}
  }
});
