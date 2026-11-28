import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  analyzeTranscriptCache,
  doesPassResolveFailure,
  extractCheckIdentity
} from "../context/lib/cache-analyzer.js";
import {
  doesPassResolveFailure as checkpointDoesPassResolveFailure,
  extractCheckIdentity as checkpointExtractCheckIdentity
} from "../context/lib/store/checkpoints.js";
import {
  formatEffectiveConfigLines,
  getConfigSnapshot,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { WatchdogMonitor, recordHookLeaseTransition } from "../context/lib/watchdog.js";
import { writeWatchdogLease } from "../context/lib/watchdog-lease.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { extractVerificationSignal } from "../hooks/post-tool-use.mjs";
import { registerSidecarRoutes, closeRuntimeStore } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const T0_MS = Date.parse("2026-11-25T10:00:00.000Z");
const iso = (offsetSec) => new Date(T0_MS + offsetSec * 1000).toISOString();

function plannerTurn(stepIndex, offsetSec, toolCalls, usage = {}) {
  return {
    type: "PLANNER_RESPONSE",
    step_index: stepIndex,
    created_at: iso(offsetSec),
    model: usage.model || "claude-sonnet-4-6",
    input_tokens: usage.input_tokens ?? 2500,
    cache_read_tokens: usage.cache_read_tokens ?? 42000,
    output_tokens: usage.output_tokens ?? 200,
    tool_calls: toolCalls
  };
}

function toolResult(stepIndex, callId, content, extra = {}) {
  return {
    type: "TOOL_RESULT",
    step_index: stepIndex,
    tool_call_id: callId,
    content,
    ...extra
  };
}

function bgLaunchStep(stepIndex, callId, taskId, cmdDesc = "") {
  return {
    type: "GENERIC",
    step_index: stepIndex,
    tool_call_id: callId,
    status: "RUNNING",
    content: `Tool is running as a background task with task id: ${taskId}${cmdDesc ? `\nTask Description: ${cmdDesc}` : ""}`
  };
}

function bgNotifyStep(stepIndex, offsetSec, taskId, verb, body) {
  return {
    type: "SYSTEM_MESSAGE",
    step_index: stepIndex,
    created_at: iso(offsetSec),
    source: "SYSTEM",
    status: "DONE",
    content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(offsetSec)} sender=${taskId} content=Task id "${taskId}" ${verb}:\n${body}\n</SYSTEM_MESSAGE>`
  };
}

function createDashboardVm(html, { nativeConvId = "", apiHandler = null, clipboardRef = { text: "" } } = {}) {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "index.html must contain main inline <script>");

  const elements = new Map();
  const makeClassList = (el) => ({
    add: (...cls) => {
      const cur = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const c of cls) if (c) cur.add(c);
      el.className = Array.from(cur).join(" ");
    },
    remove: (...cls) => {
      const cur = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const c of cls) cur.delete(c);
      el.className = Array.from(cur).join(" ");
    },
    contains: (c) => String(el.className || "").split(/\s+/).includes(c)
  });

  const getEl = (id) => {
    if (!elements.has(id)) {
      const el = {
        id,
        className: id.includes("hidden") ? "hidden" : "",
        innerText: "",
        textContent: "",
        innerHTML: "",
        title: "",
        value: "",
        disabled: false,
        style: {},
        dataset: {},
        attributes: {},
        listeners: {},
        setAttribute(k, v) {
          this.attributes[k] = String(v);
        },
        getAttribute(k) {
          return this.attributes[k] ?? null;
        },
        addEventListener(ev, fn) {
          this.listeners[ev] = fn;
        },
        scrollIntoView() {}
      };
      el.classList = makeClassList(el);
      elements.set(id, el);
    }
    return elements.get(id);
  };

  // Pre-seed elements that start hidden in HTML
  for (const hiddenId of [
    "kv-guidance-actions",
    "kv-guidance-error-btn",
    "kv-guidance-handoff-btn",
    "kv-error-viewer",
    "kv-error-meta",
    "kv-handoff-drawer",
    "kv-loop-badge",
    "kv-loop-row",
    "kv-turns-chart-row",
    "kv-top-deltas-row",
    "kv-ttl-bar-row",
    "kv-composition-row",
    "kv-model-badge",
    "kv-cost-savings",
    "kv-subagent-badge",
    "kv-handoff-cue",
    "star-milestone-banner",
    "kv-keepalive-interval-custom-wrap",
    "kv-global-keepalive-interval-custom-wrap",
    "kv-keepalive-follow-btn",
    "kv-keepalive-reset-btn"
  ]) {
    getEl(hiddenId).className = "hidden";
  }

  let currentNativeConvId = nativeConvId;
  const sidecarHost = {
    get conversationId() {
      return currentNativeConvId;
    },
    set conversationId(v) {
      currentNativeConvId = v;
    },
    async api(route, payload) {
      if (typeof apiHandler === "function") {
        return apiHandler(route, payload);
      }
      return { ok: true };
    }
  };

  const timers = [];
  const doc = {
    title: "",
    documentElement: { lang: "en" },
    hidden: false,
    hasFocus: () => true,
    body: {
      appendChild() {},
      removeChild() {}
    },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      value: "",
      style: {},
      setAttribute() {},
      focus() {},
      select() {}
    }),
    execCommand: () => false,
    addEventListener() {}
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
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
    RegExp,
    Error,
    Promise,
    Headers,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    setTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    localStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null;
      },
      setItem(k, v) {
        this._m.set(k, String(v));
      }
    },
    sessionStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null;
      },
      setItem(k, v) {
        this._m.set(k, String(v));
      }
    },
    navigator: {
      language: "zh-CN",
      clipboard: {
        async writeText(text) {
          clipboardRef.text = String(text);
        }
      }
    },
    document: doc,
    fetch: async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const data = typeof apiHandler === "function" ? await apiHandler(url, body) : { ok: true };
      return { ok: true, status: 200, async json() { return data; } };
    }
  };
  sandbox.window = {
    location: { search: "", origin: "http://127.0.0.1:0" },
    sidecar: sidecarHost,
    addEventListener() {}
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  // Prevent auto-init network traffic at bottom of script
  const runnableScript = scriptMatch[1]
    .replace(/window\.addEventListener\('DOMContentLoaded'[\s\S]*$/m, "")
    .replace(/\brefreshData\s*\(\s*\)\s*;/g, "");
  vm.runInContext(runnableScript, ctx);

  return { ctx, getEl, elements, sidecarHost, clipboardRef };
}

test("v1.7.4-tp-1: Background & status-query timeout+exit-124 never counts as code failure (from 0->0 and 2->2), while real errors & bare exit-124 still fail", () => {
  const convId = "11111111-2222-4333-8444-555555555555";

  // Helper: 2 rounds of edit + background check with specified verb & body (starting from 0 prior failures)
  const runTwoBgRoundsFromZero = (verb, body, { useManageTaskStatus = false, duplicateNotifyAfterStatus = false } = {}) => {
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      const tid = `${convId}/task-to-${k}`;
      steps.push(
        plannerTurn(si++, k * 30, [
          { id: `e${k}`, name: "edit_file", args: { Path: "src/slow.ts", Target: `v${k}`, Replacement: `v${k + 1}` } },
          { id: `c${k}`, name: "run_command", args: { CommandLine: "npx vitest run slow", WaitMsBeforeAsync: 500 } }
        ]),
        toolResult(si++, `e${k}`, "Edited"),
        bgLaunchStep(si++, `c${k}`, tid, "npx vitest run slow")
      );
      if (useManageTaskStatus) {
        steps.push(
          plannerTurn(si++, k * 30 + 15, [
            { id: `ms${k}`, name: "manage_task", args: { Action: "status", TaskId: tid } }
          ]),
          toolResult(si++, `ms${k}`, `Task: ${tid}\n${body}`)
        );
        if (duplicateNotifyAfterStatus) {
          steps.push(bgNotifyStep(si++, k * 30 + 18, tid, verb, body));
        }
      } else {
        steps.push(bgNotifyStep(si++, k * 30 + 15, tid, verb, body));
      }
    }
    return analyzeTranscriptCache(steps, { nowMs: T0_MS + 120000 });
  };

  // 1a. Pure timeout + exit 124 (finished with result, failed with error, Chinese 60秒超时, manage_task status) -> 0->0
  const pureTimeout124Body =
    `Command timed out after 60s.\nCommand exited with code 124.\n\nNo output from the command.\n\nLog: file:///C:/Users/Administrator/.gemini/antigravity/brain/${convId}/.system_generated/tasks/t.log`;
  const pureTimeout124ZhBody =
    "60 秒超时。\nCommand exited with code 124.\n\nCommand output:\nRunning slow integration test...";
  const pureTimeoutStatusBody =
    "Status: TIMED_OUT\nCommand timed out after 60s.\nCommand exited with code 124.\n\nLog output:\nRunning slow integration test...";

  for (const [label, diag] of [
    ["finished with result + exit 124", runTwoBgRoundsFromZero("finished with result", pureTimeout124Body)],
    ["failed with error + exit 124", runTwoBgRoundsFromZero("failed with error", pureTimeout124Body)],
    ["finished with result + zh 60s timeout + exit 124", runTwoBgRoundsFromZero("finished with result", pureTimeout124ZhBody)],
    [
      "manage_task(status) timeout + exit 124 (+ duplicate notify)",
      runTwoBgRoundsFromZero("failed with error", pureTimeoutStatusBody, {
        useManageTaskStatus: true,
        duplicateNotifyAfterStatus: true
      })
    ]
  ]) {
    assert.equal(diag.loopWatch.status, "ok", `${label} must stay ok`);
    assert.equal(diag.loopWatch.editFailOscillations, 0, `${label} must stay at 0 oscillations`);
    assert.equal(diag.checkStatus.latestCheck?.outcome, "timeout", `${label} latestCheck must be timeout`);
    assert.equal(diag.checkStatus.unresolvedFailures.length, 0, `${label} must have 0 unresolved failures`);
    assert.equal(diag.checkStatus.latestRealFailure, null);
  }

  // 1b. Starting from 2 existing real failures -> 2 more pure timeouts (with exit 124) keep count at 2 AND preserve prior real failure!
  {
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [
          { id: `rf_e${k}`, name: "edit_file", args: { Path: "src/parser.ts", Target: `a${k}`, Replacement: `b${k}` } }
        ]),
        toolResult(si++, `rf_e${k}`, "Edited"),
        plannerTurn(si++, k * 20 + 5, [
          { id: `rf_c${k}`, name: "run_command", args: { CommandLine: "npx vitest run parser" } }
        ]),
        toolResult(
          si++,
          `rf_c${k}`,
          "Command exited with code 1.\n\nCommand output:\nAssertionError: expected parsed token 'foo' to equal 'bar'\n    at tests/parser.test.ts:42:12",
          { status: "ERROR", exit_code: 1 }
        )
      );
    }
    const beforeTimeout = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(beforeTimeout.loopWatch.editFailOscillations, 2);
    assert.equal(beforeTimeout.checkStatus.latestCheck?.outcome, "fail");
    assert.match(beforeTimeout.checkStatus.latestRealFailure?.firstErrorLine || "", /AssertionError: expected parsed token/);

    // Now append 2 pure timeout rounds (1 finished with result + exit 124, 1 failed with error + exit 124)
    for (let k = 0; k < 2; k++) {
      const tid = `${convId}/task-after2-${k}`;
      const verb = k === 0 ? "finished with result" : "failed with error";
      steps.push(
        plannerTurn(si++, 60 + k * 30, [
          { id: `to_e${k}`, name: "edit_file", args: { Path: "src/parser.ts", Target: `c${k}`, Replacement: `d${k}` } },
          { id: `to_c${k}`, name: "run_command", args: { CommandLine: `npx vitest run parser-slow-${k}`, WaitMsBeforeAsync: 500 } }
        ]),
        toolResult(si++, `to_e${k}`, "Edited"),
        bgLaunchStep(si++, `to_c${k}`, tid, `npx vitest run parser-slow-${k}`),
        bgNotifyStep(si++, 60 + k * 30 + 15, tid, verb, pureTimeout124Body)
      );
    }
    const afterTwoTimeouts = analyzeTranscriptCache(steps, { nowMs: T0_MS + 150000 });
    assert.equal(afterTwoTimeouts.loopWatch.editFailOscillations, 2, "Pure timeouts from 2 prior failures must stay at 2 (not 3 or 4)");
    assert.equal(afterTwoTimeouts.loopWatch.status, "warn");
    assert.equal(afterTwoTimeouts.checkStatus.latestCheck?.outcome, "timeout", "latestCheck must report timeout");
    assert.ok(afterTwoTimeouts.checkStatus.latestRealFailure, "Prior unresolved real failure must be preserved");
    assert.equal(afterTwoTimeouts.checkStatus.latestRealFailure.name, "npx vitest run parser");
    assert.match(afterTwoTimeouts.checkStatus.latestRealFailure.errorExcerpt, /AssertionError: expected parsed token/);
  }

  // 1c. Timeout WITH real assertion failure OR real compile error -> counts as REAL FAILURE and preserves first relevant error!
  {
    const dAssert = runTwoBgRoundsFromZero(
      "finished with result",
      "Command timed out after 60s.\nCommand exited with code 124.\n\nCommand output:\nRunning tests...\nAssertionError: expected 42 to equal 7\n    at src/slow.test.ts:18:5"
    );
    assert.equal(dAssert.loopWatch.status, "warn");
    assert.equal(dAssert.loopWatch.editFailOscillations, 2);
    assert.equal(dAssert.checkStatus.latestCheck?.outcome, "fail");
    assert.match(dAssert.checkStatus.latestRealFailure?.firstErrorLine || "", /AssertionError: expected 42 to equal 7/);
    assert.match(dAssert.checkStatus.latestRealFailure?.errorExcerpt || "", /AssertionError: expected 42 to equal 7/);

    const dCompile = runTwoBgRoundsFromZero(
      "failed with error",
      "Command timed out after 60s.\nCommand exited with code 124.\n\nCommand output:\nsrc/slow.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'."
    );
    assert.equal(dCompile.loopWatch.status, "warn");
    assert.equal(dCompile.loopWatch.editFailOscillations, 2);
    assert.equal(dCompile.checkStatus.latestCheck?.outcome, "fail");
    assert.match(dCompile.checkStatus.latestRealFailure?.firstErrorLine || "", /error TS2322/);
  }

  // 1d. Bare exit code 124 WITHOUT trusted timeout header (even when log body mentions "timeout") -> normal non-zero failure!
  {
    const bare124 = "Command exited with code 124.\n\nNo output from the command.";
    const logMentionsTimeout124 =
      "Command exited with code 124.\n\nCommand output:\nWARN: upstream socket timeout while connecting to test fixture";
    const noSectionLogTimeout124 =
      "Command exited with code 124.\nWARN: connection timeout after 3000ms";
    const statusBare124 =
      "Status: FAILED\nCommand exited with code 124.\n\nLog output:\nrequest timeout in worker pool";

    for (const [label, diag] of [
      ["bare exit 124 (finished)", runTwoBgRoundsFromZero("finished with result", bare124)],
      ["exit 124 + log body timeout (finished)", runTwoBgRoundsFromZero("finished with result", logMentionsTimeout124)],
      ["exit 124 + log body timeout (failed)", runTwoBgRoundsFromZero("failed with error", logMentionsTimeout124)],
      ["exit 124 + no-section log timeout", runTwoBgRoundsFromZero("finished with result", noSectionLogTimeout124)],
      ["manage_task(status) exit 124 + log body timeout", runTwoBgRoundsFromZero("failed with error", statusBare124, { useManageTaskStatus: true })]
    ]) {
      assert.equal(diag.loopWatch.status, "warn", `${label} must count as real failure`);
      assert.equal(diag.loopWatch.editFailOscillations, 2, `${label} must reach 2 oscillations`);
      assert.equal(diag.checkStatus.latestCheck?.outcome, "fail", `${label} latestCheck must be fail`);
      assert.equal(diag.checkStatus.latestCheck?.exitCode, 124);
    }
  }
});

test("v1.7.4-tp-2: Re-running corresponding check clears its failure, while same-round or sibling build pass never erases real test failure", () => {
  const convId = "22222222-3333-4444-8555-666666666667";

  // 2a. Fail twice -> fix & re-run corresponding test check -> updates to pass & clears failure reminder
  {
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [{ id: `e${k}`, name: "edit_file", args: { Path: "src/calc.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(si++, `e${k}`, "Edited"),
        plannerTurn(si++, k * 20 + 5, [{ id: `t${k}`, name: "run_command", args: { CommandLine: "npx vitest run calc" } }]),
        toolResult(si++, `t${k}`, "Command exited with code 1.\n\nCommand output:\nAssertionError: 1 !== 2", { status: "ERROR", exit_code: 1 })
      );
    }
    const dFail = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(dFail.loopWatch.editFailOscillations, 2);
    assert.equal(dFail.checkStatus.latestCheck?.outcome, "fail");
    assert.equal(dFail.checkStatus.unresolvedFailures.length, 1);

    // Edit & re-run corresponding check -> passes
    steps.push(
      plannerTurn(si++, 50, [{ id: "e3", name: "edit_file", args: { Path: "src/calc.ts", Target: "b1", Replacement: "fixed" } }]),
      toolResult(si++, "e3", "Edited"),
      plannerTurn(si++, 55, [{ id: "t3", name: "run_command", args: { CommandLine: "npx vitest run calc" } }]),
      toolResult(si++, "t3", "Command exited with code 0.\n\nCommand output:\n10 passed", { exit_code: 0 })
    );
    const dPass = analyzeTranscriptCache(steps, { nowMs: T0_MS + 70000 });
    assert.equal(dPass.loopWatch.status, "ok");
    assert.equal(dPass.loopWatch.editFailOscillations, 0);
    assert.equal(dPass.checkStatus.latestCheck?.outcome, "pass");
    assert.equal(dPass.checkStatus.unresolvedFailures.length, 0);
    assert.equal(dPass.checkStatus.latestRealFailure, null);
  }

  // 2b. Same round: one test fails + another build passes (sync parallel AND run_checks) -> build pass NEVER wipes out test failure
  {
    const syncMixedSteps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/feature.ts", Target: "x", Replacement: "y" } }]),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [
        { id: "t1", name: "run_command", args: { CommandLine: "npx vitest run feature" } },
        { id: "b1", name: "run_command", args: { CommandLine: "npx electron-vite build" } }
      ]),
      toolResult(4, "t1", "Command exited with code 1.\n\nCommand output:\nAssertionError: feature mismatch", { status: "ERROR", exit_code: 1 }),
      toolResult(5, "b1", "Command exited with code 0.\n\nCommand output:\nbuilt in 1.1s", { exit_code: 0 })
    ];
    const dSyncMixed = analyzeTranscriptCache(syncMixedSteps, { nowMs: T0_MS + 30000 });
    assert.equal(dSyncMixed.checkStatus.latestCheck?.outcome, "fail");
    assert.equal(dSyncMixed.checkStatus.unresolvedFailures.length, 1);
    assert.equal(dSyncMixed.checkStatus.unresolvedFailures[0].kind, "test");
    assert.match(dSyncMixed.checkStatus.latestRealFailure?.firstErrorLine || "", /AssertionError: feature mismatch/);
    assert.equal(dSyncMixed.checkStatus.checksByKind.build?.outcome, "pass");

    // run_checks with test FAIL + build PASS
    const rcSteps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/feature.ts", Target: "x", Replacement: "y" } }]),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [
        {
          id: "rc1",
          name: "mcp_agy-dart_fast_run_checks",
          args: {
            commands: [
              { name: "build", command: "npx electron-vite build" },
              { name: "vitest", command: "npx vitest run feature" }
            ]
          }
        }
      ]),
      toolResult(
        4,
        "rc1",
        "Checks: 1/2 passed, 1 failed (wall: 900ms)\n\n- [PASS 400ms] build (`npx electron-vite build`): built\n\n## [FAIL (exit 1) 500ms] vitest\n$ npx vitest run feature\nAssertionError: expected true to be false"
      )
    ];
    const dRc = analyzeTranscriptCache(rcSteps, { nowMs: T0_MS + 30000 });
    assert.equal(dRc.checkStatus.latestCheck?.outcome, "fail");
    assert.equal(dRc.checkStatus.unresolvedFailures.length, 1);
    assert.equal(dRc.checkStatus.unresolvedFailures[0].name, "vitest");
    assert.equal(dRc.checkStatus.checksByKind.build?.outcome, "pass");
  }

  // 2c. Two checks fail (test + build) -> re-running ONLY test to pass resolves test while preserving build's own failure!
  {
    const steps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/dual.ts" } }]),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [
        { id: "t1", name: "run_command", args: { CommandLine: "npx vitest run dual" } },
        { id: "b1", name: "run_command", args: { CommandLine: "npx tsc --noEmit" } }
      ]),
      toolResult(4, "t1", "Command exited with code 1.\n\nCommand output:\nAssertionError: test broke", { status: "ERROR", exit_code: 1 }),
      toolResult(5, "b1", "Command exited with code 2.\n\nCommand output:\nsrc/dual.ts(8,3): error TS2345: Argument of type 'number' is not assignable.", { status: "ERROR", exit_code: 2 }),
      // Re-run ONLY test -> passes
      plannerTurn(6, 20, [{ id: "t2", name: "run_command", args: { CommandLine: "npx vitest run dual" } }]),
      toolResult(7, "t2", "Command exited with code 0.\n\nCommand output:\n5 passed", { exit_code: 0 })
    ];
    const dPartial = analyzeTranscriptCache(steps, { nowMs: T0_MS + 40000 });
    assert.equal(dPartial.checkStatus.checksByKind.test?.outcome, "pass", "Resolved test check must update to pass");
    assert.equal(dPartial.checkStatus.checksByKind.build?.outcome, "fail", "Other failing build check must keep its own record");
    assert.equal(dPartial.checkStatus.unresolvedFailures.length, 1);
    assert.equal(dPartial.checkStatus.unresolvedFailures[0].kind, "build");
    assert.match(dPartial.checkStatus.latestRealFailure?.firstErrorLine || "", /error TS2345/);
  }
});

test("v1.7.4-tp-3: High hit-rate failure/timeout suppresses delay_hot_cache and PreInvocation evaluateCacheAlerts aligns with panel judgment", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-alerts-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "ctx.db"), hookMode: true });
  try {
    // 3a. Hot cache (95% hit) at warn watermark (140k) + pure timeout -> NO delay_hot_cache in diag OR alerts!
    const hotTimeoutSteps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/hot.ts" } }], {
        input_tokens: 7000,
        cache_read_tokens: 133000
      }),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 10, [{ id: "c1", name: "run_command", args: { CommandLine: "npx vitest run hot" } }], {
        input_tokens: 7000,
        cache_read_tokens: 133000
      }),
      toolResult(4, "c1", "Command timed out after 60s.\nCommand exited with code 124.", { exit_code: 124 })
    ];
    const dHotTimeout = analyzeTranscriptCache(hotTimeoutSteps, { ttlSec: 300, nowMs: T0_MS + 20000 });
    assert.equal(dHotTimeout.watermark, "warn");
    assert.ok(dHotTimeout.weightedHitRate >= 0.9);
    assert.notEqual(dHotTimeout.compactAdvice, "delay_hot_cache", "Timeout must suppress delay_hot_cache even at >90% hit rate");
    const alertsHotTimeoutZh = evaluateCacheAlerts(dHotTimeout, { sessionId: "s-hot-to-zh", store, lang: "zh" });
    assert.ok(
      alertsHotTimeoutZh.some((a) => a.includes("检查超时，结果还不知道。可以重跑这项检查。")),
      `Expected timeout alert in zh: ${JSON.stringify(alertsHotTimeoutZh)}`
    );
    assert.equal(
      alertsHotTimeoutZh.some((a) => a.includes("暂缓")),
      false,
      `Must NOT emit '暂缓 /compact' during timeout: ${JSON.stringify(alertsHotTimeoutZh)}`
    );

    // 3b. Hot cache (95% hit) at warn watermark (140k) + 2x real failure -> NO delay_hot_cache; aligned 2-round failure message
    const hotFail2Steps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/hot.ts" } }], { input_tokens: 7000, cache_read_tokens: 133000 }),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [{ id: "c1", name: "run_command", args: { CommandLine: "npx vitest run hot" } }], { input_tokens: 7000, cache_read_tokens: 133000 }),
      toolResult(4, "c1", "AssertionError: boom 1", { status: "ERROR", exit_code: 1 }),
      plannerTurn(5, 10, [{ id: "e2", name: "edit_file", args: { Path: "src/hot.ts" } }], { input_tokens: 7000, cache_read_tokens: 133000 }),
      toolResult(6, "e2", "Edited"),
      plannerTurn(7, 15, [{ id: "c2", name: "run_command", args: { CommandLine: "npx vitest run hot" } }], { input_tokens: 7000, cache_read_tokens: 133000 }),
      toolResult(8, "c2", "AssertionError: boom 2", { status: "ERROR", exit_code: 1 })
    ];
    const dHotFail2 = analyzeTranscriptCache(hotFail2Steps, { ttlSec: 300, nowMs: T0_MS + 25000 });
    assert.notEqual(dHotFail2.compactAdvice, "delay_hot_cache");
    const alertsHotFailZh = evaluateCacheAlerts(dHotFail2, { sessionId: "s-hot-fail-zh", store, lang: "zh" });
    assert.ok(
      alertsHotFailZh.some((a) => a.includes("src/hot.ts") && a.includes("改了两轮，检查都没过") && a.includes("先看最近一次报错")),
      `Expected aligned zh 2-round fail alert: ${JSON.stringify(alertsHotFailZh)}`
    );
    assert.equal(
      alertsHotFailZh.some((a) => a.includes("暂缓")),
      false,
      `Must NOT emit '暂缓 /compact' during failure: ${JSON.stringify(alertsHotFailZh)}`
    );

    // 3c. Critical watermark prioritizes handoff reminder over failure/timeout
    const critSteps = [
      ...hotFail2Steps,
      plannerTurn(9, 20, [], { input_tokens: 10000, cache_read_tokens: 160000 })
    ];
    const dCrit = analyzeTranscriptCache(critSteps, { ttlSec: 300, nowMs: T0_MS + 28000 });
    assert.equal(dCrit.watermark, "critical");
    const alertsCritZh = evaluateCacheAlerts(dCrit, { sessionId: "s-crit-zh", store, lang: "zh" });
    assert.equal(alertsCritZh.length, 1, "Critical watermark should fire a single prioritized handoff alert");
    assert.ok(alertsCritZh[0].includes("这段对话快满了") && alertsCritZh[0].includes("交接简报"));

    // 3d. Reusable cache + passed check (ok watermark) -> 0 popup alerts
    const passSteps = [
      plannerTurn(1, 0, [{ id: "c1", name: "run_command", args: { CommandLine: "npx vitest run ok" } }], {
        input_tokens: 2000,
        cache_read_tokens: 48000
      }),
      toolResult(2, "c1", "Command exited with code 0.\n\nCommand output:\n24 passed", { exit_code: 0 })
    ];
    const dPass = analyzeTranscriptCache(passSteps, { ttlSec: 300, nowMs: T0_MS + 10000 });
    assert.equal(dPass.checkStatus.latestCheck?.outcome, "pass");
    assert.deepEqual(evaluateCacheAlerts(dPass, { sessionId: "s-pass-zh", store, lang: "zh" }), []);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-tp-4: Dashboard single-sentence panel guidance covers all 5 states, View Error, Copy Handoff Brief, and cross-conversation isolation", async () => {
  const html = readDashboardHtml();
  const clipboardRef = { text: "" };
  const handoffPayloads = {
    "conv-crit": {
      ok: true,
      scope: "conversation",
      conversationId: "conv-crit",
      confirmedConversation: true,
      mode: "agent",
      markdown: "# Handoff Brief\n- Conversation: `conv-crit`\n- Note: CRITICAL_SESSION_MARKER",
      anchors: { confirmed: true, conversationId: "conv-crit", workspace: "/repo" },
      bytes: 82,
      truncated: false
    },
    "conv-b": {
      ok: true,
      scope: "conversation",
      conversationId: "conv-b",
      confirmedConversation: true,
      mode: "agent",
      markdown: "# Handoff Brief\n- Conversation: `conv-b`\n- Note: CONV_B_ONLY_MARKER",
      anchors: { confirmed: true, conversationId: "conv-b", workspace: "/repo" },
      bytes: 76,
      truncated: false
    }
  };

  const { ctx, getEl, sidecarHost } = createDashboardVm(html, {
    nativeConvId: "conv-a",
    clipboardRef,
    apiHandler: async (route, body) => {
      if (route === "/api/handoff") {
        const cid = body?.conversationId || sidecarHost.conversationId;
        return handoffPayloads[cid] || { ok: false, error: "not found" };
      }
      return { ok: true };
    }
  });

  vm.runInContext("setLanguage('zh', false);", ctx);

  const baseKv = {
    ok: true,
    transcriptFound: true,
    turnsWithUsage: 4,
    weightedHitRate: 0.94,
    currentContextTokens: 60000,
    warnTokens: 130000,
    criticalTokens: 160000,
    watermark: "ok",
    cacheTemperature: "hot",
    ttlStatus: "warm",
    cacheTtlSec: 300,
    idleSeconds: 15,
    ttlRemainingSec: 285,
    compactAdvice: "none",
    modelProfile: { id: "claude-sonnet-4-6", windowTokens: 200000 },
    loopWatch: { status: "ok", editFailOscillations: 0, oscillatingFiles: [], maxRepeatCount: 1, repeatRate: 0, reason: null },
    checkStatus: { latestCheck: null, latestRealFailure: null, unresolvedFailures: [], checksByKind: {}, hasConfirmedResult: false }
  };

  // State 5: No confirmed check result
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(baseKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "还没有检查结果。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);
  assert.equal(getEl("kv-guidance-handoff-btn").classList.contains("hidden"), true);

  // State 1: Cache reusable + latest related check passed
  const passKv = {
    ...baseKv,
    checkStatus: {
      latestCheck: { outcome: "pass", kind: "test", name: "npx vitest run", exitCode: 0, firstErrorLine: "", errorExcerpt: "", files: ["src/app.ts"] },
      latestRealFailure: null,
      unresolvedFailures: [],
      checksByKind: { test: { outcome: "pass", kind: "test", name: "npx vitest run", exitCode: 0 } },
      hasConfirmedResult: true
    }
  };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(passKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run 通过了，可以接着做。");
  assert.equal(getEl("kv-guidance-bar").classList.contains("is-ok"), true);
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);

  // Generic unnamed pass falls back cleanly to generic pass copy
  const genericPassKv = {
    ...baseKv,
    checkStatus: {
      latestCheck: { outcome: "pass", kind: "check", name: "check", command: "", exitCode: 0, firstErrorLine: "", errorExcerpt: "", files: [] },
      latestRealFailure: null,
      unresolvedFailures: [],
      checksByKind: {},
      hasConfirmedResult: true
    }
  };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(genericPassKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "刚才的检查通过了，可以接着做。");

  // State 2: Same file edited 2 rounds + both checks really failed -> includes filename + View Error works!
  const fail2Kv = {
    ...baseKv,
    loopWatch: {
      status: "warn",
      editFailOscillations: 2,
      oscillatingFiles: ["src/app.ts"],
      maxRepeatCount: 1,
      repeatRate: 0,
      reason: "edit_fail_oscillation"
    },
    checkStatus: {
      latestCheck: {
        outcome: "fail",
        kind: "test",
        name: "npx vitest run app",
        command: "npx vitest run app",
        exitCode: 1,
        firstErrorLine: "AssertionError: expected 200 to equal 201",
        errorExcerpt: "AssertionError: expected 200 to equal 201\n    at tests/app.test.ts:19:7",
        files: ["src/app.ts"]
      },
      latestRealFailure: {
        outcome: "fail",
        kind: "test",
        name: "npx vitest run app",
        command: "npx vitest run app",
        exitCode: 1,
        firstErrorLine: "AssertionError: expected 200 to equal 201",
        errorExcerpt: "AssertionError: expected 200 to equal 201\n    at tests/app.test.ts:19:7",
        files: ["src/app.ts"]
      },
      unresolvedFailures: [
        {
          outcome: "fail",
          kind: "test",
          name: "npx vitest run app",
          exitCode: 1,
          firstErrorLine: "AssertionError: expected 200 to equal 201",
          errorExcerpt: "AssertionError: expected 200 to equal 201\n    at tests/app.test.ts:19:7",
          files: ["src/app.ts"]
        }
      ],
      checksByKind: {},
      hasConfirmedResult: true
    }
  };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(fail2Kv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "这个文件（src/app.ts）改了两轮，检查都没过。先看最近一次报错。");
  assert.equal(getEl("kv-loop-row").classList.contains("hidden"), true, "Single primary message: hide redundant edit_fail_oscillation row");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false);
  assert.equal(getEl("kv-error-viewer").classList.contains("hidden"), true);
  // Click "看报错"
  vm.runInContext("toggleErrorViewer();", ctx);
  assert.equal(getEl("kv-error-viewer").classList.contains("hidden"), false);
  assert.equal(getEl("kv-error-badge").textContent, "最近一次报错");
  assert.equal(getEl("kv-error-check-name").textContent, "npx vitest run app");
  assert.match(getEl("kv-error-excerpt").textContent, /AssertionError: expected 200 to equal 201/);

  // State 3: Latest check only timed out WITH prior unresolved real failure -> marks previous real failure!
  const timeoutWithPriorKv = {
    ...fail2Kv,
    weightedHitRate: 0.96,
    checkStatus: {
      ...fail2Kv.checkStatus,
      latestCheck: {
        outcome: "timeout",
        kind: "test",
        name: "npx vitest run app",
        exitCode: 124,
        firstErrorLine: "",
        errorExcerpt: "",
        files: ["src/app.ts"]
      }
    }
  };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(timeoutWithPriorKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "检查超时，结果还不知道。可以重跑这项检查。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false, "Prior unresolved failure keeps View Error entry");
  assert.equal(getEl("kv-error-badge").textContent, "上一次真实报错", "Must clearly label prior failure as previous");
  assert.match(getEl("kv-error-excerpt").textContent, /AssertionError: expected 200 to equal 201/);
  assert.equal(getEl("kv-guidance-text").textContent.includes("先别压缩"), false);

  // State 4: Context critical watermark (even when failure still exists) -> handoff priority + keeps View Error!
  sidecarHost.conversationId = "conv-crit";
  vm.runInContext("syncNativeHostConversation({ reloadIfOpen: false });", ctx);
  const critWithFailKv = {
    ...fail2Kv,
    currentContextTokens: 170000,
    watermark: "critical",
    compactAdvice: "critical_compact"
  };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(critWithFailKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "这段对话快满了。先复制交接简报，记下做到哪儿，再压缩。");
  assert.equal(getEl("kv-guidance-handoff-btn").classList.contains("hidden"), false);
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false, "Must retain View Error alongside Handoff Brief when failure exists");
  await vm.runInContext("copyGuidanceHandoffBrief();", ctx);
  assert.match(clipboardRef.text, /CRITICAL_SESSION_MARKER/, "Copy Handoff Brief must copy current conversation's brief");

  // Switch conversation conv-crit -> conv-b: old error viewer & guidance reset immediately, B gets only B's own result & brief
  vm.runInContext("toggleErrorViewer(true);", ctx);
  assert.equal(getEl("kv-error-viewer").classList.contains("hidden"), false);
  sidecarHost.conversationId = "conv-b";
  vm.runInContext("syncNativeHostConversation({ reloadIfOpen: false });", ctx);
  assert.equal(getEl("kv-error-viewer").classList.contains("hidden"), true, "Switching conversation must close previous error viewer");
  assert.equal(getEl("kv-guidance-text").textContent, "还没有检查结果。", "Switching conversation must clear old conversation's guidance");

  // Render conv-b's own passed state
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(passKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run 通过了，可以接着做。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);
  assert.equal(getEl("kv-error-excerpt").textContent.includes("AssertionError"), false, "Old conversation error must not bleed into new conversation");

  // English translation smoke check (named + generic fallback)
  vm.runInContext("setLanguage('en', false);", ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run passed — you can keep going.");
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(genericPassKv)});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "The latest check passed — you can keep going.");
});

test("v1.7.4-tp-5: Server /api/cache-diag exposes redacted checkStatus for confirmed conversation and strips excerpts on unconfirmed/overview scopes", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-srv-"));
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevBrain = process.env.AGY_DART_BRAIN_DIR;
  try {
    const dbPath = path.join(tmpBase, "context.db");
    const convA = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeee0001";
    const convDir = path.join(tmpBase, "brain", convA, ".system_generated", "logs");
    fs.mkdirSync(convDir, { recursive: true });
    const txPath = path.join(convDir, "transcript.jsonl");
    const steps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/secret.ts" } }]),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [{ id: "c1", name: "run_command", args: { CommandLine: "npx vitest run secret" } }]),
      toolResult(
        4,
        "c1",
        "Command exited with code 1.\n\nCommand output:\nAssertionError: failed with key sk-ant-api03-SECRETTOKENVALUE1234567890",
        { status: "ERROR", exit_code: 1 }
      )
    ];
    fs.writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf8");

    const seedStore = new ContextModeStore({ dbPath, hookMode: true });
    writeWatchdogLease(seedStore, {
      conversationId: convA,
      rootSessionId: convA,
      phase: "IDLE",
      subphase: "stopped",
      cwd: tmpBase,
      transcriptPath: txPath,
      updatedTs: Date.now()
    });
    seedStore.close();

    closeRuntimeStore();
    process.env.AGY_DART_DB_PATH = dbPath;

    const routes = new Map();
    registerSidecarRoutes({ config: {}, api: (route, fn) => routes.set(route, fn) });
    const cacheDiagFn = routes.get("/api/cache-diag");

    // Confirmed conversation receives checkStatus with redacted errorExcerpt
    const confirmedRes = cacheDiagFn({ scope: "conversation", conversationId: convA, conversationConfirmed: true });
    assert.equal(confirmedRes.ok, true);
    assert.equal(confirmedRes.transcriptFound, true);
    assert.equal(confirmedRes.checkStatus?.latestCheck?.outcome, "fail");
    assert.match(confirmedRes.checkStatus?.latestRealFailure?.errorExcerpt || "", /AssertionError:/);
    assert.equal(
      (confirmedRes.checkStatus?.latestRealFailure?.errorExcerpt || "").includes("SECRETTOKENVALUE1234567890"),
      false,
      "Secrets in errorExcerpt must be redacted"
    );

    // Unconfirmed conversation strips raw errorExcerpt & firstErrorLine
    const unconfirmedRes = cacheDiagFn({ scope: "conversation", conversationId: convA, conversationConfirmed: false });
    assert.equal(unconfirmedRes.checkStatus?.latestRealFailure?.errorExcerpt, "");
    assert.equal(unconfirmedRes.checkStatus?.latestRealFailure?.firstErrorLine, "");
  } finally {
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevBrain === undefined) delete process.env.AGY_DART_BRAIN_DIR;
    else process.env.AGY_DART_BRAIN_DIR = prevBrain;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

function buildKvFromDiag(diag, extra = {}) {
  return {
    ok: true,
    transcriptFound: true,
    turnsWithUsage: diag.turnsWithUsage || 2,
    currentContextTokens: diag.currentContextTokens || 44500,
    watermark: diag.watermark || "ok",
    weightedHitRate: diag.weightedHitRate ?? 0.94,
    cacheTemperature: diag.cacheTemperature || "warm",
    compactAdvice: diag.compactAdvice || "none",
    modelProfile: diag.modelProfile || { id: "claude", label: "Claude", windowTokens: 200000 },
    loopWatch: diag.loopWatch,
    checkStatus: diag.checkStatus,
    ...extra
  };
}

test("v1.7.4-tp-6: Payment test failure is NOT cleared by passing profile test and only clears when payment test itself re-runs and passes (with panel copy check)", () => {
  const html = readDashboardHtml();
  const { ctx, getEl } = createDashboardVm(html, { nativeConvId: "conv-pay-1" });
  vm.runInContext("setLanguage('zh', false);", ctx);

  // 1. Payment test fails, then only profile test runs and passes
  const stepsAfterProfilePass = [
    plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/payment.ts" } }]),
    toolResult(2, "e1", "Edited"),
    plannerTurn(3, 5, [{ id: "t_pay_1", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts" } }]),
    toolResult(
      4,
      "t_pay_1",
      "Command exited with code 1.\n\nCommand output:\nAssertionError: payment charge rejected: expected 200 to equal 500\n    at tests/payment.test.ts:28:10",
      { status: "ERROR", exit_code: 1 }
    ),
    plannerTurn(5, 15, [{ id: "t_prof_1", name: "run_command", args: { CommandLine: "npx vitest run tests/profile.test.ts" } }]),
    toolResult(
      6,
      "t_prof_1",
      "Command exited with code 0.\n\nCommand output:\n8 passed",
      { exit_code: 0 }
    )
  ];

  const diagAfterProfile = analyzeTranscriptCache(stepsAfterProfilePass, { ttlSec: 300, nowMs: T0_MS + 25000 });
  assert.equal(diagAfterProfile.checkStatus.unresolvedFailures.length, 1, "Payment failure must remain unresolved after profile test passes");
  assert.match(diagAfterProfile.checkStatus.latestRealFailure?.name || "", /payment\.test\.ts/);
  assert.match(diagAfterProfile.checkStatus.latestRealFailure?.errorExcerpt || "", /payment charge rejected/);
  assert.notEqual(diagAfterProfile.compactAdvice, "delay_hot_cache");

  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagAfterProfile))});`, ctx);
  const textAfterProfile = getEl("kv-guidance-text").textContent;
  assert.notEqual(textAfterProfile, "刚才的检查通过了，可以接着做。", "Panel must NOT report pass when payment test is still failing");
  assert.match(textAfterProfile, /payment\.test\.ts/, "Panel guidance must surface unresolved payment test");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false, "View Error button must stay visible for payment error");

  vm.runInContext("toggleErrorViewer(true);", ctx);
  assert.equal(getEl("kv-error-viewer").classList.contains("hidden"), false);
  assert.match(getEl("kv-error-check-name").textContent, /payment\.test\.ts/);
  assert.match(getEl("kv-error-excerpt").textContent, /payment charge rejected/);

  // 2. Same guard for scoped npm scripts (`npm run test:payment` vs `npm run test:profile`)
  const scriptSteps = [
    plannerTurn(1, 0, [{ id: "sp1", name: "run_command", args: { CommandLine: "npm run test:payment" } }]),
    toolResult(2, "sp1", "Command exited with code 1.\n\nCommand output:\nAssertionError: refund failed", { status: "ERROR", exit_code: 1 }),
    plannerTurn(3, 10, [{ id: "sp2", name: "run_command", args: { CommandLine: "npm run test:profile" } }]),
    toolResult(4, "sp2", "Command exited with code 0.\n\nCommand output:\n6 passed", { exit_code: 0 })
  ];
  const diagScripts = analyzeTranscriptCache(scriptSteps, { nowMs: T0_MS + 20000 });
  assert.equal(diagScripts.checkStatus.unresolvedFailures.length, 1);
  assert.equal(diagScripts.checkStatus.latestRealFailure?.name, "npm run test:payment");

  // 3. Re-running payment test itself after fix clears payment failure -> panel now says passed
  const stepsAfterPaymentPass = [
    ...stepsAfterProfilePass,
    plannerTurn(7, 25, [{ id: "e2", name: "edit_file", args: { Path: "src/payment.ts" } }]),
    toolResult(8, "e2", "Edited"),
    plannerTurn(9, 30, [{ id: "t_pay_2", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts" } }]),
    toolResult(10, "t_pay_2", "Command exited with code 0.\n\nCommand output:\n12 passed", { exit_code: 0 })
  ];
  const diagAfterPaymentPass = analyzeTranscriptCache(stepsAfterPaymentPass, { ttlSec: 300, nowMs: T0_MS + 40000 });
  assert.equal(diagAfterPaymentPass.checkStatus.unresolvedFailures.length, 0);
  assert.equal(diagAfterPaymentPass.checkStatus.latestRealFailure, null);
  assert.equal(diagAfterPaymentPass.checkStatus.latestCheck?.outcome, "pass");

  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagAfterPaymentPass))});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run tests/payment.test.ts 通过了，可以接着做。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);
});

test("v1.7.4-tp-7: Truncated run_checks with summary '1 failed' and only passing block remaining shows missing-details failure copy (never pass)", () => {
  const html = readDashboardHtml();
  const { ctx, getEl } = createDashboardVm(html, { nativeConvId: "conv-trunc-1" });
  vm.runInContext("setLanguage('zh', false);", ctx);

  const truncatedSteps = [
    plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/billing.ts" } }], {
      input_tokens: 7000,
      cache_read_tokens: 133000
    }),
    toolResult(2, "e1", "Edited"),
    plannerTurn(3, 5, [
      {
        id: "rc_trunc",
        name: "mcp_agy-dart_fast_run_checks",
        args: {
          commands: [
            { name: "profile", command: "npx vitest run tests/profile.test.ts" },
            { name: "payment", command: "npx vitest run tests/payment.test.ts" }
          ]
        }
      }
    ], {
      input_tokens: 7000,
      cache_read_tokens: 133000
    }),
    toolResult(
      4,
      "rc_trunc",
      "Checks: 1/2 passed, 1 failed (wall: 920ms)\n\n- [PASS 310ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed\n\n... [output truncated before failing block]"
    )
  ];

  const diagTrunc = analyzeTranscriptCache(truncatedSteps, { ttlSec: 300, nowMs: T0_MS + 15000 });
  assert.equal(diagTrunc.checkStatus.latestCheck?.outcome, "fail");
  assert.equal(diagTrunc.checkStatus.latestCheck?.missingDetails, true);
  assert.equal(diagTrunc.checkStatus.latestCheck?.missingFailureCount, 1);
  assert.equal(diagTrunc.checkStatus.unresolvedFailures.length, 1);
  assert.notEqual(diagTrunc.compactAdvice, "delay_hot_cache", "Truncated failure summary must still suppress delay_hot_cache");

  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagTrunc))});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "有 1 项检查失败，当前日志缺少报错明细。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false);

  vm.runInContext("toggleErrorViewer(true);", ctx);
  assert.match(getEl("kv-error-excerpt").textContent, /当前日志缺少报错明细.*1 项失败/);

  // English copy check
  vm.runInContext("setLanguage('en', false);", ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "1 check failed, but error details are missing from the current log.");

  // Subsequent clean run_checks pass (0 failed) clears the missing-details failure
  vm.runInContext("setLanguage('zh', false);", ctx);
  const recoveredSteps = [
    ...truncatedSteps,
    plannerTurn(5, 20, [
      {
        id: "rc_pass",
        name: "mcp_agy-dart_fast_run_checks",
        args: {
          commands: [
            { name: "profile", command: "npx vitest run tests/profile.test.ts" },
            { name: "payment", command: "npx vitest run tests/payment.test.ts" }
          ]
        }
      }
    ]),
    toolResult(
      6,
      "rc_pass",
      "Checks: 2/2 passed (wall: 810ms)\n\n- [PASS 310ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed\n- [PASS 500ms] payment (`npx vitest run tests/payment.test.ts`): 9 passed"
    )
  ];
  const diagRecovered = analyzeTranscriptCache(recoveredSteps, { ttlSec: 300, nowMs: T0_MS + 30000 });
  assert.equal(diagRecovered.checkStatus.unresolvedFailures.length, 0);
  assert.equal(diagRecovered.checkStatus.latestCheck?.outcome, "pass");
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagRecovered))});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "profile、payment 通过了，可以接着做。");
});

test("v1.7.4-tp-8: Late background timeout from older code epoch goes to history only and preserves newer passing panel state", () => {
  const html = readDashboardHtml();
  const { ctx, getEl } = createDashboardVm(html, { nativeConvId: "conv-stale-1" });
  vm.runInContext("setLanguage('zh', false);", ctx);

  const convId = "33333333-4444-4555-8666-777777777778";
  const oldTaskId = `${convId}/task-old-v1`;
  const steps = [
    // Old code (editEpoch = 1) launches background test
    plannerTurn(1, 0, [
      { id: "e1", name: "edit_file", args: { Path: "src/checkout.ts", Target: "v0", Replacement: "v1" } },
      { id: "bg1", name: "run_command", args: { CommandLine: "npx vitest run tests/checkout.test.ts", WaitMsBeforeAsync: 500 } }
    ]),
    toolResult(2, "e1", "Edited"),
    bgLaunchStep(3, "bg1", oldTaskId, "npx vitest run tests/checkout.test.ts"),
    // Code is updated to new version (editEpoch = 2) and tested cleanly -> PASS
    plannerTurn(4, 15, [
      { id: "e2", name: "edit_file", args: { Path: "src/checkout.ts", Target: "v1", Replacement: "v2" } },
      { id: "sync2", name: "run_command", args: { CommandLine: "npx vitest run tests/checkout.test.ts" } }
    ]),
    toolResult(5, "e2", "Edited"),
    toolResult(6, "sync2", "Command exited with code 0.\n\nCommand output:\n14 passed", { exit_code: 0 }),
    // Later, the old background test finally reports timeout + exit 124
    bgNotifyStep(
      7,
      65,
      oldTaskId,
      "finished with result",
      "Command timed out after 60s.\nCommand exited with code 124.\n\nNo output from the command."
    )
  ];

  const diag = analyzeTranscriptCache(steps, { ttlSec: 300, nowMs: T0_MS + 75000 });
  assert.equal(diag.checkStatus.latestCheck?.outcome, "pass", "Newer passing check must NOT be overwritten by stale timeout");
  assert.equal(diag.checkStatus.latestCheck?.editEpoch, 2);
  assert.equal(diag.checkStatus.unresolvedFailures.length, 0);
  const staleEntry = (diag.checkStatus.history || []).find((h) => h.stale === true && h.outcome === "timeout");
  assert.ok(staleEntry, "Late timeout from old code epoch must still be recorded in checkStatus.history as stale");
  assert.equal(staleEntry.editEpoch, 1);

  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diag))});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run tests/checkout.test.ts 通过了，可以接着做。");
  assert.equal(getEl("kv-guidance-text").textContent.includes("检查超时"), false);
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);
});

test("v1.7.4-tp-9: Pure timeout recovered strictly from saved sessionCheckpoint still renders timeout copy (never failed check copy)", () => {
  const html = readDashboardHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-cp-timeout-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db"), hookMode: true });
  try {
    const convId = "conv-cp-timeout-1";
    const { ctx, getEl } = createDashboardVm(html, { nativeConvId: convId });
    vm.runInContext("setLanguage('zh', false);", ctx);

    // 1. Pure run_checks timeout written via extractVerificationSignal -> ContextModeStore.recordVerificationResult
    const sigRunChecksTimeout = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "unit", command: "npm test" }, { name: "slow", command: "npm run e2e" }] },
      "Checks: 1/2 passed, 1 failed (wall: 60010ms)\n\n- [PASS 120ms] unit (`npm test`): 18 passed\n\n## [TIMEOUT 60000ms] slow\n$ npm run e2e\nTIMED OUT"
    );
    assert.equal(sigRunChecksTimeout.passed, false, "Must keep passed=false for existing osc-2 contract");
    assert.equal(sigRunChecksTimeout.exitCode, 1, "Must keep exitCode=1 for existing osc-2 contract");
    assert.equal(sigRunChecksTimeout.outcome, "timeout");
    assert.equal(sigRunChecksTimeout.timedOut, true);
    assert.equal(sigRunChecksTimeout.failureSection, "");

    store.recordVerificationResult(convId, {
      ...sigRunChecksTimeout,
      failureExcerpt: "",
      worktree: tmpDir
    });
    const cpOnlyTimeout = store.getSessionCheckpoint(convId);
    assert.equal(cpOnlyTimeout.lastTest?.outcome, "timeout");
    assert.equal(cpOnlyTimeout.lastTest?.timedOut, true);

    const noTranscriptKv = {
      ok: true,
      transcriptFound: false,
      turnsWithUsage: 0,
      checkStatus: { latestCheck: null, latestRealFailure: null, unresolvedFailures: [], checksByKind: {}, history: [], hasConfirmedResult: false }
    };
    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify({ sessionCheckpoint: cpOnlyTimeout })}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(
      getEl("kv-guidance-text").textContent,
      "检查超时，结果还不知道。可以重跑这项检查。",
      "Checkpoint recovery after pure timeout must show timeout copy, not failed-check copy"
    );
    assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true, "No prior real failure -> View Error stays hidden");

    // 2. Prior real failure followed by apply_edits verify pure timeout -> checkpoint recovery shows timeout copy + Previous real failure!
    const convWithPrior = "conv-cp-timeout-2";
    store.recordVerificationResult(convWithPrior, {
      kind: "test",
      command: "npx vitest run tests/payment.test.ts",
      ruleId: "apply_edits_verify",
      exitCode: 1,
      passed: false,
      outcome: "fail",
      summary: "Verify [FAIL in 40ms] `npx vitest run tests/payment.test.ts`:",
      failureExcerpt: "AssertionError: previous payment error",
      worktree: tmpDir
    });
    const sigVerifyTimeout = extractVerificationSignal(
      "apply_edits",
      { edits: [], verify: "npx vitest run tests/payment.test.ts" },
      "Applied edits to 1 file(s).\nVerify [TIMEOUT 60000ms] `npx vitest run tests/payment.test.ts`:\nTIMED OUT"
    );
    assert.equal(sigVerifyTimeout.outcome, "timeout");
    assert.equal(sigVerifyTimeout.timedOut, true);
    store.recordVerificationResult(convWithPrior, {
      ...sigVerifyTimeout,
      failureExcerpt: "",
      worktree: tmpDir
    });
    const cpWithPrior = store.getSessionCheckpoint(convWithPrior);
    assert.equal(cpWithPrior.lastTest?.outcome, "timeout");
    assert.match(cpWithPrior.lastTest?.previousFailure?.failureExcerpt || "", /previous payment error/);

    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify({ sessionCheckpoint: cpWithPrior })}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(getEl("kv-guidance-text").textContent, "检查超时，结果还不知道。可以重跑这项检查。");
    assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false, "Prior failure preserved across checkpoint timeout keeps View Error");
    vm.runInContext("toggleErrorViewer(true);", ctx);
    assert.equal(getEl("kv-error-badge").textContent, "上一次真实报错");
    assert.match(getEl("kv-error-excerpt").textContent, /previous payment error/);

    // 3. Legacy checkpoint record saved before `outcome` field existed (summary has Verify [TIMEOUT ...]) still restores as timeout
    const legacyResume = {
      sessionCheckpoint: {
        modifiedFiles: [],
        modifiedFileCount: 0,
        lastTest: {
          command: "npm test",
          ok: false,
          exitCode: 1,
          summary: "Verify [TIMEOUT 60000ms] `npm test`:",
          failureExcerpt: "TIMED OUT",
          at: new Date().toISOString()
        },
        lastBuild: null,
        updatedAt: new Date().toISOString()
      }
    };
    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify(legacyResume)}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(getEl("kv-guidance-text").textContent, "检查超时，结果还不知道。可以重跑这项检查。");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-tp-10: Single-case / narrowed pass (-t/-k/--shard/::case/-run/--) NEVER clears broader file or suite failure", () => {
  const html = readDashboardHtml();
  const { ctx, getEl } = createDashboardVm(html, { nativeConvId: "conv-narrow-case-1" });
  vm.runInContext("setLanguage('zh', false);", ctx);

  // Unit contract matrix for narrowing filters / shards / sub-selectors (both live analyzer & checkpoint module parity)
  const pairResolves = (passCmd, failCmd) => {
    const aRes = doesPassResolveFailure(
      extractCheckIdentity("test", "", passCmd),
      extractCheckIdentity("test", "", failCmd)
    );
    const cRes = checkpointDoesPassResolveFailure(
      checkpointExtractCheckIdentity("test", "", passCmd),
      checkpointExtractCheckIdentity("test", "", failCmd)
    );
    assert.equal(cRes, aRes, `checkpoints.js and cache-analyzer.js must agree on (${passCmd}) vs (${failCmd})`);
    return aRes;
  };
  assert.equal(pairResolves('npx vitest run tests/payment.test.ts -t "refund"', "npx vitest run tests/payment.test.ts"), false);
  assert.equal(pairResolves("npx vitest run tests/payment.test.ts", 'npx vitest run tests/payment.test.ts -t "refund"'), true);
  assert.equal(pairResolves('npm test -- tests/payment.test.ts -t "refund"', "npm test -- tests/payment.test.ts"), false);
  assert.equal(pairResolves("npx vitest run --shard 1/4 tests/payment.test.ts", "npx vitest run tests/payment.test.ts"), false);
  assert.equal(pairResolves("npx vitest run --shard=1/4", "npx vitest run"), false);
  assert.equal(pairResolves("pytest tests/test_payment.py::test_refund", "pytest tests/test_payment.py"), false);
  assert.equal(pairResolves("pytest tests/test_payment.py", "pytest tests/test_payment.py::test_refund"), true);
  assert.equal(pairResolves("go test ./pkg/payment -run TestRefund", "go test ./pkg/payment"), false);
  assert.equal(pairResolves("go test ./pkg/payment", "go test ./pkg/payment -run TestRefund"), true);
  assert.equal(pairResolves("cargo test --test payment refund", "cargo test --test payment"), false);
  assert.equal(pairResolves("cargo test --test payment", "cargo test --test payment refund"), true);
  assert.equal(pairResolves('npm run test:payment -- -t "refund"', "npm run test:payment"), false);

  // End-to-end: full payment.test.ts fails -> only 1 case (-t "refund") passes -> payment failure MUST remain unresolved!
  const stepsAfterSingleCase = [
    plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/payment.ts" } }]),
    toolResult(2, "e1", "Edited"),
    plannerTurn(3, 5, [{ id: "t_pay_full", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts" } }]),
    toolResult(
      4,
      "t_pay_full",
      "Command exited with code 1.\n\nCommand output:\nAssertionError: capture charge failed\n    at tests/payment.test.ts:55:9",
      { status: "ERROR", exit_code: 1 }
    ),
    plannerTurn(5, 15, [{ id: "t_pay_one", name: "run_command", args: { CommandLine: 'npx vitest run tests/payment.test.ts -t "refund"' } }]),
    toolResult(6, "t_pay_one", "Command exited with code 0.\n\nCommand output:\n1 passed", { exit_code: 0 })
  ];
  const diagSingleCase = analyzeTranscriptCache(stepsAfterSingleCase, { ttlSec: 300, nowMs: T0_MS + 25000 });
  assert.equal(diagSingleCase.checkStatus.unresolvedFailures.length, 1, "Single-case pass must NOT clear whole-file payment failure");
  assert.equal(diagSingleCase.checkStatus.latestRealFailure?.name, "npx vitest run tests/payment.test.ts");

  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagSingleCase))});`, ctx);
  const textAfterSingleCase = getEl("kv-guidance-text").textContent;
  assert.equal(textAfterSingleCase, "还有检查未通过（npx vitest run tests/payment.test.ts）。先看这项报错。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false);

  // Re-running full payment.test.ts cleanly clears the failure and names the passed check
  const stepsAfterFullPass = [
    ...stepsAfterSingleCase,
    plannerTurn(7, 25, [{ id: "t_pay_full_2", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts" } }]),
    toolResult(8, "t_pay_full_2", "Command exited with code 0.\n\nCommand output:\n12 passed", { exit_code: 0 })
  ];
  const diagFullPass = analyzeTranscriptCache(stepsAfterFullPass, { ttlSec: 300, nowMs: T0_MS + 35000 });
  assert.equal(diagFullPass.checkStatus.unresolvedFailures.length, 0);
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagFullPass))});`, ctx);
  assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run tests/payment.test.ts 通过了，可以接着做。");
  assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);
});

test("v1.7.4-tp-11: Background payment test failure is NOT ignored after editing unrelated profile file (even if profile test passes), while superseded same-check fail still goes to history", () => {
  const html = readDashboardHtml();
  const { ctx, getEl } = createDashboardVm(html, { nativeConvId: "conv-bg-unrelated-1" });
  vm.runInContext("setLanguage('zh', false);", ctx);
  const convId = "44444444-5555-4666-8777-888888888881";

  // Variant A: bg payment test launched (epoch 1) -> edit profile.ts (epoch 2) + pass profile.test.ts -> bg payment returns FAIL
  {
    const bgPayId = `${convId}/task-pay-a`;
    const steps = [
      plannerTurn(1, 0, [
        { id: "e1", name: "edit_file", args: { Path: "src/payment.ts", Target: "a", Replacement: "b" } },
        { id: "bg_pay", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts", WaitMsBeforeAsync: 500 } }
      ]),
      toolResult(2, "e1", "Edited"),
      bgLaunchStep(3, "bg_pay", bgPayId, "npx vitest run tests/payment.test.ts"),
      plannerTurn(4, 10, [
        { id: "e2", name: "edit_file", args: { Path: "src/profile.ts", Target: "x", Replacement: "y" } },
        { id: "t_prof", name: "run_command", args: { CommandLine: "npx vitest run tests/profile.test.ts" } }
      ]),
      toolResult(5, "e2", "Edited"),
      toolResult(6, "t_prof", "Command exited with code 0.\n\nCommand output:\n8 passed", { exit_code: 0 }),
      bgNotifyStep(
        7,
        25,
        bgPayId,
        "finished with result",
        "Command exited with code 1.\n\nCommand output:\nAssertionError: payment webhook signature invalid\n    at tests/payment.test.ts:91:5"
      )
    ];
    const diag = analyzeTranscriptCache(steps, { ttlSec: 300, nowMs: T0_MS + 35000 });
    assert.equal(diag.checkStatus.unresolvedFailures.length, 1, "Unrelated profile pass must NOT mark returning bg payment failure stale");
    assert.equal(diag.checkStatus.latestRealFailure?.name, "npx vitest run tests/payment.test.ts");
    assert.match(diag.checkStatus.latestRealFailure?.errorExcerpt || "", /payment webhook signature invalid/);
    assert.equal((diag.checkStatus.history || []).some((h) => h.stale === true && h.outcome === "fail"), false);

    vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diag))});`, ctx);
    assert.equal(getEl("kv-guidance-text").textContent, "最近一次检查（npx vitest run tests/payment.test.ts）没过。先看最近一次报错。");
    assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false);
    vm.runInContext("toggleErrorViewer(true);", ctx);
    assert.match(getEl("kv-error-excerpt").textContent, /payment webhook signature invalid/);
  }

  // Variant B: profile.ts edited before & after bg payment test launch (no newer check at all) -> returning bg payment FAIL must STILL surface
  {
    const bgPayId = `${convId}/task-pay-b`;
    const steps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/profile.ts", Target: "v0", Replacement: "v1" } }]),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [{ id: "bg_pay", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts", WaitMsBeforeAsync: 500 } }]),
      bgLaunchStep(4, "bg_pay", bgPayId, "npx vitest run tests/payment.test.ts"),
      plannerTurn(5, 10, [{ id: "e2", name: "edit_file", args: { Path: "src/profile.ts", Target: "v1", Replacement: "v2" } }]),
      toolResult(6, "e2", "Edited"),
      bgNotifyStep(
        7,
        20,
        bgPayId,
        "finished with result",
        "Command exited with code 1.\n\nCommand output:\nAssertionError: ledger imbalance"
      )
    ];
    const diag = analyzeTranscriptCache(steps, { ttlSec: 300, nowMs: T0_MS + 30000 });
    assert.equal(diag.checkStatus.unresolvedFailures.length, 1, "Re-editing unrelated profile.ts must NOT discard bg payment failure");
    assert.match(diag.checkStatus.latestRealFailure?.errorExcerpt || "", /ledger imbalance/);
  }

  // Variant C: Same check re-runs and passes on newer code -> old bg payment FAIL IS marked stale in history and panel stays pass
  {
    const bgPayId = `${convId}/task-pay-c`;
    const steps = [
      plannerTurn(1, 0, [
        { id: "e1", name: "edit_file", args: { Path: "src/payment.ts", Target: "v0", Replacement: "v1" } },
        { id: "bg_pay", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts", WaitMsBeforeAsync: 500 } }
      ]),
      toolResult(2, "e1", "Edited"),
      bgLaunchStep(3, "bg_pay", bgPayId, "npx vitest run tests/payment.test.ts"),
      plannerTurn(4, 10, [
        { id: "e2", name: "edit_file", args: { Path: "src/payment.ts", Target: "v1", Replacement: "v2" } },
        { id: "sync_pay", name: "run_command", args: { CommandLine: "npx vitest run tests/payment.test.ts" } }
      ]),
      toolResult(5, "e2", "Edited"),
      toolResult(6, "sync_pay", "Command exited with code 0.\n\nCommand output:\n12 passed", { exit_code: 0 }),
      bgNotifyStep(
        7,
        25,
        bgPayId,
        "finished with result",
        "Command exited with code 1.\n\nCommand output:\nAssertionError: old v1 payment failure"
      )
    ];
    const diag = analyzeTranscriptCache(steps, { ttlSec: 300, nowMs: T0_MS + 35000 });
    assert.equal(diag.checkStatus.unresolvedFailures.length, 0);
    assert.equal(diag.checkStatus.latestCheck?.outcome, "pass");
    assert.ok((diag.checkStatus.history || []).some((h) => h.stale === true && h.outcome === "fail"));
    vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diag))});`, ctx);
    assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run tests/payment.test.ts 通过了，可以接着做。");
  }
});

test("v1.7.4-tp-12: Session checkpoint recovery preserves unresolved payment failure after profile/single-case pass, and unconfirmed /api/resume strips excerpts", () => {
  const html = readDashboardHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-cp-unresolved-"));
  const dbPath = path.join(tmpDir, "context.db");
  const prevDb = process.env.AGY_DART_DB_PATH;
  const store = new ContextModeStore({ dbPath, hookMode: true });
  try {
    const convId = "conv-cp-unres-1";
    const { ctx, getEl } = createDashboardVm(html, { nativeConvId: convId });
    vm.runInContext("setLanguage('zh', false);", ctx);

    // 1. Payment test fails
    store.recordVerificationResult(convId, {
      kind: "test",
      command: "npx vitest run tests/payment.test.ts",
      ruleId: "test-runner",
      exitCode: 1,
      passed: false,
      outcome: "fail",
      summary: "1 failed",
      failureExcerpt: "AssertionError: stripe webhook rejected with token sk-ant-api03-SHOULDNOTLEAK1234567890",
      worktree: tmpDir
    });
    // 2. Profile test passes (same kind="test")
    store.recordVerificationResult(convId, {
      kind: "test",
      command: "npx vitest run tests/profile.test.ts",
      ruleId: "test-runner",
      exitCode: 0,
      passed: true,
      outcome: "pass",
      summary: "8 passed",
      worktree: tmpDir
    });
    // 3. Single payment test case passes (-t "refund")
    store.recordVerificationResult(convId, {
      kind: "test",
      command: 'npx vitest run tests/payment.test.ts -t "refund"',
      ruleId: "test-runner",
      exitCode: 0,
      passed: true,
      outcome: "pass",
      summary: "1 passed",
      worktree: tmpDir
    });

    const cpAfterPartial = store.getSessionCheckpoint(convId);
    assert.equal(cpAfterPartial.lastTest?.ok, true);
    assert.equal(cpAfterPartial.lastTest?.unresolvedFailures?.length, 1, "Checkpoint must preserve unresolved payment failure");
    assert.equal(cpAfterPartial.lastTest.unresolvedFailures[0].command, "npx vitest run tests/payment.test.ts");

    const noTranscriptKv = {
      ok: true,
      transcriptFound: false,
      turnsWithUsage: 0,
      checkStatus: { latestCheck: null, latestRealFailure: null, unresolvedFailures: [], checksByKind: {}, history: [], hasConfirmedResult: false }
    };
    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify({ sessionCheckpoint: cpAfterPartial })}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(
      getEl("kv-guidance-text").textContent,
      "还有检查未通过（npx vitest run tests/payment.test.ts）。先看这项报错。",
      "Restored dashboard from checkpoint must surface unresolved payment failure instead of profile pass"
    );
    assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false);
    vm.runInContext("toggleErrorViewer(true);", ctx);
    assert.match(getEl("kv-error-excerpt").textContent, /stripe webhook rejected/);

    // Verify unconfirmed /api/resume strips failureExcerpt from unresolvedFailures as well
    closeRuntimeStore();
    process.env.AGY_DART_DB_PATH = dbPath;
    const routes = new Map();
    registerSidecarRoutes({ config: {}, api: (route, fn) => routes.set(route, fn) });
    const resumeFn = routes.get("/api/resume");
    const unconfirmedResume = resumeFn({ scope: "conversation", conversationId: convId, conversationConfirmed: false });
    const unconfFailures = unconfirmedResume.sessionCheckpoint?.lastTest?.unresolvedFailures || [];
    assert.equal(unconfFailures.length, 1);
    assert.equal(unconfFailures[0].failureExcerpt, undefined, "Unconfirmed /api/resume must strip failureExcerpt inside unresolvedFailures");

    // 4. Full payment test re-runs and passes -> unresolvedFailures clears and checkpoint restores named pass
    store.recordVerificationResult(convId, {
      kind: "test",
      command: "npx vitest run tests/payment.test.ts",
      ruleId: "test-runner",
      exitCode: 0,
      passed: true,
      outcome: "pass",
      summary: "12 passed",
      worktree: tmpDir
    });
    const cpAfterFull = store.getSessionCheckpoint(convId);
    assert.equal(cpAfterFull.lastTest?.unresolvedFailures, undefined);
    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify({ sessionCheckpoint: cpAfterFull })}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(getEl("kv-guidance-text").textContent, "npx vitest run tests/payment.test.ts 通过了，可以接着做。");
    assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), true);
  } finally {
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-tp-13: Truncated run_checks failure is NOT cleared by unrelated docs pass and persists 'previous batch failed (missing details)' until original batch re-runs", () => {
  const html = readDashboardHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-trunc-batch-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db"), hookMode: true });
  try {
    const { ctx, getEl } = createDashboardVm(html, { nativeConvId: "conv-trunc-batch-1" });
    vm.runInContext("setLanguage('zh', false);", ctx);

    const origBatchCmds = [
      { name: "profile", command: "npx vitest run tests/profile.test.ts" },
      { name: "payment", command: "npx vitest run tests/payment.test.ts" }
    ];
    const docsBatchCmds = [{ name: "docs", command: "npm run brief:check" }];
    const partialBatchCmds = [{ name: "profile", command: "npx vitest run tests/profile.test.ts" }];

    // 1. Live transcript: Batch 1 truncated fail -> Batch 2 unrelated docs pass -> Batch 3 partial profile pass -> Batch 4 full rerun pass
    const batch1Steps = [
      plannerTurn(1, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/billing.ts" } }]),
      toolResult(2, "e1", "Edited"),
      plannerTurn(3, 5, [{ id: "rc1", name: "mcp_agy-dart_fast_run_checks", args: { commands: origBatchCmds } }]),
      toolResult(
        4,
        "rc1",
        "Checks: 1/2 passed, 1 failed (wall: 920ms)\n\n- [PASS 310ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed\n\n... [truncated]"
      )
    ];
    const afterDocsSteps = [
      ...batch1Steps,
      plannerTurn(5, 15, [{ id: "rc_docs", name: "mcp_agy-dart_fast_run_checks", args: { commands: docsBatchCmds } }]),
      toolResult(6, "rc_docs", "Checks: 1/1 passed (wall: 120ms)\n\n- [PASS 120ms] docs (`npm run brief:check`): ok")
    ];
    const diagAfterDocs = analyzeTranscriptCache(afterDocsSteps, { ttlSec: 300, nowMs: T0_MS + 25000 });
    assert.equal(diagAfterDocs.checkStatus.unresolvedFailures.length, 1, "Unrelated docs run_checks pass must NOT clear earlier truncated batch failure");
    assert.equal(diagAfterDocs.checkStatus.latestRealFailure?.missingDetails, true);

    vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagAfterDocs))});`, ctx);
    assert.equal(getEl("kv-guidance-text").textContent, "上批检查有失败，明细缺失。请重跑原检查批次确认。");
    assert.equal(getEl("kv-guidance-error-btn").classList.contains("hidden"), false);

    // EN copy check
    vm.runInContext("setLanguage('en', false);", ctx);
    assert.equal(getEl("kv-guidance-text").textContent, "An earlier check batch failed with missing details. Re-run that batch to confirm.");
    vm.runInContext("setLanguage('zh', false);", ctx);

    // Partial rerun (only profile) STILL must NOT clear truncated [profile, payment] batch failure
    const afterPartialSteps = [
      ...afterDocsSteps,
      plannerTurn(7, 25, [{ id: "rc_part", name: "mcp_agy-dart_fast_run_checks", args: { commands: partialBatchCmds } }]),
      toolResult(8, "rc_part", "Checks: 1/1 passed (wall: 220ms)\n\n- [PASS 220ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed")
    ];
    const diagAfterPartial = analyzeTranscriptCache(afterPartialSteps, { ttlSec: 300, nowMs: T0_MS + 35000 });
    assert.equal(diagAfterPartial.checkStatus.unresolvedFailures.length, 1, "Partial batch rerun must NOT clear truncated [profile, payment] failure");

    // Re-running the original [profile, payment] batch cleanly clears the missing-details failure
    const afterRerunSteps = [
      ...afterPartialSteps,
      plannerTurn(9, 35, [{ id: "rc_full", name: "mcp_agy-dart_fast_run_checks", args: { commands: origBatchCmds } }]),
      toolResult(
        10,
        "rc_full",
        "Checks: 2/2 passed (wall: 750ms)\n\n- [PASS 300ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed\n- [PASS 450ms] payment (`npx vitest run tests/payment.test.ts`): 9 passed"
      )
    ];
    const diagAfterRerun = analyzeTranscriptCache(afterRerunSteps, { ttlSec: 300, nowMs: T0_MS + 45000 });
    assert.equal(diagAfterRerun.checkStatus.unresolvedFailures.length, 0);
    vm.runInContext(`renderKvCacheCard(${JSON.stringify(buildKvFromDiag(diagAfterRerun))});`, ctx);
    assert.equal(getEl("kv-guidance-text").textContent, "profile、payment 通过了，可以接着做。");

    // 2. Checkpoint recovery parity for truncated batch followed by unrelated docs run_checks (same kind="test")
    const convCp = "conv-trunc-cp-1";
    const sigTrunc = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: origBatchCmds },
      "Checks: 1/2 passed, 1 failed (wall: 920ms)\n\n- [PASS 310ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed\n\n... [truncated]"
    );
    store.recordVerificationResult(convCp, { ...sigTrunc, failureExcerpt: "", worktree: tmpDir });
    const sigDocsSameKind = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "docs", command: "node scripts/verify-docs.mjs" }] },
      "Checks: 1/1 passed (wall: 80ms)\n\n- [PASS 80ms] docs (`node scripts/verify-docs.mjs`): ok"
    );
    store.recordVerificationResult(convCp, { ...sigDocsSameKind, failureExcerpt: "", worktree: tmpDir });

    const cpAfterDocs = store.getSessionCheckpoint(convCp);
    assert.equal(cpAfterDocs.lastTest?.unresolvedFailures?.length, 1);
    assert.equal(cpAfterDocs.lastTest.unresolvedFailures[0].missingDetails, true);

    const noTranscriptKv = {
      ok: true,
      transcriptFound: false,
      turnsWithUsage: 0,
      checkStatus: { latestCheck: null, latestRealFailure: null, unresolvedFailures: [], checksByKind: {}, history: [], hasConfirmedResult: false }
    };
    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify({ sessionCheckpoint: cpAfterDocs })}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(getEl("kv-guidance-text").textContent, "上批检查有失败，明细缺失。请重跑原检查批次确认。");

    // Re-running original batch updates checkpoint and clears truncated failure
    const sigRerun = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: origBatchCmds },
      "Checks: 2/2 passed (wall: 750ms)\n\n- [PASS 300ms] profile (`npx vitest run tests/profile.test.ts`): 12 passed\n- [PASS 450ms] payment (`npx vitest run tests/payment.test.ts`): 9 passed"
    );
    store.recordVerificationResult(convCp, { ...sigRerun, failureExcerpt: "", worktree: tmpDir });
    const cpAfterRerun = store.getSessionCheckpoint(convCp);
    assert.equal(cpAfterRerun.lastTest?.unresolvedFailures, undefined);
    vm.runInContext(
      `cachedKv = ${JSON.stringify(noTranscriptKv)}; cachedResume = ${JSON.stringify({ sessionCheckpoint: cpAfterRerun })}; renderPanelGuidance();`,
      ctx
    );
    assert.equal(getEl("kv-guidance-text").textContent, "profile、payment 通过了，可以接着做。");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-tp-14: Keepalive interval tiers — config/env precedence, global vs per-window SQLite override, fixed vs adaptive watchdog scheduling, staleness cap & cold-miss breaker", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-ka-tier-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const dbPath = path.join(tmpDir, "context.db");
  const prevIntervalEnv = process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const store = new ContextModeStore({ dbPath });
  try {
    // 1. Config & env precedence (default 0/auto, config.json, env override, "auto", clamping, invalid <60 ignored)
    delete process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
    resetConfigCache();
    const defSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(defSnap.values.ttlKeepaliveIntervalSec, 0);
    assert.equal(defSnap.sources.ttlKeepaliveIntervalSec, "default");
    assert.match(formatEffectiveConfigLines(defSnap).join("\n"), /interval=auto/);

    fs.writeFileSync(cfgPath, JSON.stringify({ ttlKeepaliveIntervalSec: 240 }), "utf8");
    resetConfigCache();
    const fileSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(fileSnap.values.ttlKeepaliveIntervalSec, 240);
    assert.equal(fileSnap.sources.ttlKeepaliveIntervalSec, "config");
    assert.match(formatEffectiveConfigLines(fileSnap).join("\n"), /interval=240s/);

    const envFixedSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC: "540" }
    });
    assert.equal(envFixedSnap.values.ttlKeepaliveIntervalSec, 540);
    assert.equal(envFixedSnap.sources.ttlKeepaliveIntervalSec, "env");

    const envAutoSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC: "auto" }
    });
    assert.equal(envAutoSnap.values.ttlKeepaliveIntervalSec, 0);
    assert.equal(envAutoSnap.sources.ttlKeepaliveIntervalSec, "env");

    const envClampSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC: "7200" }
    });
    assert.equal(envClampSnap.values.ttlKeepaliveIntervalSec, 3600);

    const envTooSmallSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC: "30" }
    });
    assert.equal(envTooSmallSnap.values.ttlKeepaliveIntervalSec, 240, "Invalid <60 env must fall back to config");

    // 2. Store persistence: global default, per-window override, Global reset, and __unbound__ migration
    process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "nonexistent-cfg.json");
    resetConfigCache();
    assert.equal(store.getGlobalTtlKeepaliveIntervalSec(), 0);
    assert.equal(store.hasExplicitGlobalTtlKeepaliveIntervalSec(), false);
    assert.equal(store.getTtlKeepaliveIntervalSec("conv-a"), 0);

    store.setGlobalTtlKeepaliveIntervalSec(240);
    assert.equal(store.hasExplicitGlobalTtlKeepaliveIntervalSec(), true);
    assert.equal(store.getGlobalTtlKeepaliveIntervalSec(), 240);
    assert.equal(store.getTtlKeepaliveIntervalSec("conv-a"), 240);
    assert.equal(store.hasCustomTtlKeepaliveOverride("conv-a"), false);

    store.setTtlKeepaliveIntervalSec(900, "conv-a");
    assert.equal(store.getTtlKeepaliveIntervalSec("conv-a"), 900);
    assert.equal(store.getTtlKeepaliveIntervalSec("conv-b"), 240);
    assert.equal(store.hasCustomTtlKeepaliveOverride("conv-a"), true);

    store.clearTtlKeepaliveOverride("conv-a");
    assert.equal(store.hasCustomTtlKeepaliveOverride("conv-a"), false);
    assert.equal(store.getTtlKeepaliveIntervalSec("conv-a"), 240);

    store.setTtlKeepaliveIntervalSec(420, "__unbound__");
    const claimedUnbound = store.claimPendingUnboundTtlKeepalive("conv-claimed");
    assert.equal(claimedUnbound?.intervalSec, 420);
    assert.equal(store.getTtlKeepaliveIntervalSec("conv-claimed"), 420);
    assert.equal(store.hasCustomTtlKeepaliveOverride("conv-claimed"), true);
    assert.equal(store.hasCustomTtlKeepaliveOverride("__unbound__"), false);

    // 3. Watchdog scheduling: Fixed 4m beats bloated 63m calibrated TTL, Fixed 9m beats 5m floor, staleness cap & cold-miss breaker & Auto compatibility
    let nowMs = 1_760_100_000_000;
    let monoNs = 10_000_000_000n;
    const advanceSec = (sec) => {
      nowMs += sec * 1000;
      monoNs += BigInt(sec) * 1_000_000_000n;
    };
    const sentPings = [];
    const cfgState = {
      stallWatchdog: true,
      watchdogPollMs: 5000,
      ttlDesktopNotify: false,
      ttlNotifyLeadSec: 60,
      ttlKeepalive: true,
      ttlKeepaliveMaxCount: 2,
      ttlKeepaliveMinTokens: 20000,
      ttlKeepaliveMinContextPct: 0,
      ttlKeepaliveIntervalSec: 0
    };
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfgState,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      statFn: () => {
        throw new Error("IDLE keepalive must NEVER call statSync");
      },
      keepaliveSendFn: async (req) => {
        sentPings.push({ ...req, atMs: nowMs });
        return { ok: true, deliveryMs: 5000 };
      }
    });

    // Global default max=2, interval=240 (Fixed 4m). Delivery default=10s -> fixedTriggerAtSec = 230s, fixedMaxWindowSec = 360s.
    store.setGlobalTtlKeepaliveMaxCount(2);
    store.setGlobalTtlKeepaliveIntervalSec(240);

    // 3a. Fixed 4m on bloated 3780s (63m) calibrated TTL: no fire at 180s, fires at 235s!
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-fixed-4m" },
      { nowMs, contextTokens: 95000, model: "Gemini 4 Carbon (High)", cacheTtlSec: 3780, ttlSource: "empirical" }
    );
    advanceSec(5);
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-fixed-4m" }, { nowMs });

    advanceSec(180);
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 0, "Fixed 4m must NOT fire prematurely at 180s idle");

    advanceSec(55); // total idle = 235s >= 230s
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 1, "Fixed 4m MUST fire at 235s even when calibrated TTL is 3780s");
    assert.equal(sentPings[0].conversationId, "conv-fixed-4m");
    const st4m = monitor.getStatus({ conversationId: "conv-fixed-4m" });
    assert.equal(st4m.globalTtlKeepaliveIntervalSec, 240);
    assert.equal(st4m.ttlKeepalive.intervalSec, 240);
    assert.equal(st4m.ttlKeepalive.intervalMode, "fixed");

    // 3b. Cold-miss circuit breaker STILL stops round 2 in fixed mode
    advanceSec(30);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-fixed-4m" },
      { nowMs, contextTokens: 95000, model: "Gemini 4 Carbon (High)", cacheTtlSec: 3780, ttlSource: "empirical" }
    );
    advanceSec(5);
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-fixed-4m" }, { nowMs });
    store.setTtlKeepaliveState("conv-fixed-4m", {
      ...store.getTtlKeepaliveState("conv-fixed-4m"),
      coldMissTripped: true
    });
    advanceSec(240);
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 1, "Cold-miss circuit breaker must still halt fixed-interval keepalive");

    // 3c. Staleness upper cap: long-abandoned session (idle 500s > fixedMaxWindowSec 360s) must NOT late-fire
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-stale-4m" },
      { nowMs: nowMs - 505_000, contextTokens: 95000, model: "Gemini 4 Carbon (High)", cacheTtlSec: 3780 }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-stale-4m" }, { nowMs: nowMs - 500_000 });
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 1, "Abandoned session beyond fixedMaxWindowSec must NOT late-fire");

    // 3d. Fixed 9m (540s) beats 5m (300s) profile floor (not blocked by remSec <= 0)
    store.setTtlKeepaliveIntervalSec(540, "conv-fixed-9m");
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-fixed-9m" },
      { nowMs, contextTokens: 95000, model: "Gemini 4 Carbon (High)", cacheTtlSec: 300, ttlSource: "profile" }
    );
    advanceSec(5);
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-fixed-9m" }, { nowMs });
    advanceSec(400);
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 1, "Fixed 9m must NOT fire at 400s");
    advanceSec(140); // idle = 540s (>= fixedTriggerAtSec ~530..535s)
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 2, "Fixed 9m MUST fire at 540s even when profile TTL floor is 300s");
    assert.equal(sentPings[1].conversationId, "conv-fixed-9m");

    // 3e. Adaptive mode (intervalSec = 0) preserves existing effectiveTtlSec - leadSec scheduling
    store.setTtlKeepaliveIntervalSec(0, "conv-auto");
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-auto" },
      { nowMs, contextTokens: 95000, model: "Gemini 4 Carbon (High)", cacheTtlSec: 600, ttlSource: "empirical" }
    );
    advanceSec(5);
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-auto" }, { nowMs });
    advanceSec(240);
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 2, "Auto mode (0) must NOT fire at 240s when calibrated TTL is 600s");
    advanceSec(300); // idle = 540s, remSec = 60 <= lead+comp
    monitor.tick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sentPings.length, 3, "Auto mode (0) must still fire near effectiveTtlSec - leadSec");
    assert.equal(sentPings[2].conversationId, "conv-auto");
    assert.equal(monitor.getStatus({ conversationId: "conv-auto" }).ttlKeepalive.intervalMode, "auto");
  } finally {
    if (prevIntervalEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
    else process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC = prevIntervalEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.7.4-tp-15: Server /api/watchdog/action interval validation & Dashboard VM global/per-window preset, custom minutes, Global reset & ZH/EN i18n", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tp-ka-ui-"));
  const dbPath = path.join(tmpDir, "context.db");
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const prevIntervalEnv = process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
  try {
    closeRuntimeStore();
    process.env.AGY_DART_DB_PATH = dbPath;
    process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-config.json");
    delete process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
    resetConfigCache();

    const routes = new Map();
    registerSidecarRoutes({ config: {}, api: (route, fn) => routes.set(route, fn) });
    const wdActionFn = routes.get("/api/watchdog/action");
    const cacheDiagFn = routes.get("/api/cache-diag");
    assert.ok(wdActionFn && cacheDiagFn, "Watchdog action and cache-diag routes must be registered");

    const convA = "aaaa2222-bbbb-4ccc-8ddd-eeeeeeee0001";
    const convB = "aaaa2222-bbbb-4ccc-8ddd-eeeeeeee0002";

    // 1. Strict 400 validation on invalid intervalSec values
    for (const badVal of [30, -1, 3601, "abc", true, 240.5, ""]) {
      const rGlobal = wdActionFn({ action: "setGlobalTtlKeepaliveInterval", intervalSec: badVal });
      assert.equal(rGlobal.ok, false, `Global invalid intervalSec=${JSON.stringify(badVal)} must fail`);
      assert.equal(rGlobal.status, 400);
      const rWin = wdActionFn({ action: "setTtlKeepalive", conversationId: convA, intervalSec: badVal });
      assert.equal(rWin.ok, false, `Window invalid intervalSec=${JSON.stringify(badVal)} must fail`);
      assert.equal(rWin.status, 400);
    }

    // 2. Global default interval -> exposed by /api/cache-diag; per-window override & Auto (0) without force-enabling OFF window
    const setGlobalRes = wdActionFn({ action: "setGlobalTtlKeepaliveInterval", intervalSec: 240 });
    assert.equal(setGlobalRes.ok, true);
    assert.equal(setGlobalRes.globalTtlKeepaliveIntervalSec, 240);
    const diagA0 = cacheDiagFn({ scope: "conversation", conversationId: convA, conversationConfirmed: true });
    assert.equal(diagA0.globalTtlKeepaliveIntervalSec, 240);
    assert.equal(diagA0.ttlKeepalive.intervalSec, 240);
    assert.equal(diagA0.ttlKeepalive.globalIntervalSec, 240);
    assert.equal(diagA0.ttlKeepalive.intervalMode, "fixed");

    // Per-window fixed interval (>=60) auto-enables OFF window and isolates from convB
    const setWinCustom = wdActionFn({ action: "setTtlKeepalive", conversationId: convA, intervalSec: 420 });
    assert.equal(setWinCustom.ok, true);
    assert.equal(setWinCustom.isCustomOverride, true);
    assert.equal(setWinCustom.ttlKeepaliveEnabled, true);
    assert.equal(setWinCustom.ttlKeepaliveIntervalSec, 420);

    // Per-window Auto (0) sets override without force-enabling OFF convB
    const setWinAuto = wdActionFn({ action: "setTtlKeepalive", conversationId: convB, intervalSec: 0 });
    assert.equal(setWinAuto.ok, true);
    assert.equal(setWinAuto.isCustomOverride, true);
    assert.equal(setWinAuto.ttlKeepaliveEnabled, false, "Selecting Auto (0) on OFF window must not force-enable it");
    assert.equal(setWinAuto.ttlKeepaliveIntervalSec, 0);

    // Reset convA back to global 240s
    const resetRes = wdActionFn({ action: "resetTtlKeepaliveOverride", conversationId: convA });
    assert.equal(resetRes.ok, true);
    assert.equal(resetRes.isCustomOverride, false);
    assert.equal(resetRes.ttlKeepaliveIntervalSec, 240);

    // 3. End-to-end Dashboard VM wired to real sidecar routes: ZH/EN option labels, preset select, custom minutes, and Global reset
    const html = readDashboardHtml();
    const dispatched = [];
    const { ctx, getEl } = createDashboardVm(html, {
      nativeConvId: convA,
      apiHandler: async (route, payload) => {
        dispatched.push({ route, payload });
        const fn = routes.get(route);
        return fn ? fn(payload || {}) : { ok: true };
      }
    });

    // Hydrate from real /api/cache-diag and check ZH & EN option labels
    vm.runInContext("setLanguage('zh', false);", ctx);
    const liveDiag = cacheDiagFn({ scope: "conversation", conversationId: convA, conversationConfirmed: true });
    vm.runInContext(`renderKvCacheCard(${JSON.stringify(liveDiag)});`, ctx);
    assert.equal(getEl("kv-global-keepalive-interval-opt-0").textContent, "动态(现方案)");
    assert.equal(getEl("kv-global-keepalive-interval-opt-240").textContent, "固定 4min");
    assert.equal(getEl("kv-keepalive-interval-opt-540").textContent, "固定 9min");
    assert.equal(getEl("kv-keepalive-interval-opt-900").textContent, "固定 15min");
    assert.equal(getEl("kv-keepalive-interval-opt-custom").textContent, "自定义");
    assert.equal(getEl("kv-global-keepalive-interval").value, "240");
    assert.equal(getEl("kv-keepalive-interval").value, "240");
    assert.equal(getEl("kv-keepalive-interval-custom-wrap").classList.contains("hidden"), true);

    vm.runInContext("setLanguage('en', false);", ctx);
    assert.equal(getEl("kv-keepalive-interval-opt-0").textContent, "Auto");
    assert.equal(getEl("kv-keepalive-interval-opt-240").textContent, "Fixed 4min");
    assert.equal(getEl("kv-keepalive-interval-opt-custom").textContent, "Custom");
    vm.runInContext("setLanguage('zh', false);", ctx);

    // Change global preset to 540 (Fixed 9m) -> both global and uncustomized window follow 540
    const kaActions = () => dispatched.filter((d) => d.payload?.action && d.payload.action !== "setUiLang");
    await vm.runInContext("changeGlobalTtlKeepaliveInterval('540');", ctx);
    assert.equal(getEl("kv-global-keepalive-interval").value, "540");
    assert.equal(getEl("kv-keepalive-interval").value, "540");
    assert.equal(kaActions().at(-1)?.payload?.action, "setGlobalTtlKeepaliveInterval");
    assert.equal(kaActions().at(-1)?.payload?.intervalSec, 540);

    // Switch window dropdown to 'custom' -> reveals minute box without sending premature request
    const callsBeforeCustom = kaActions().length;
    await vm.runInContext("changeTtlKeepaliveInterval('custom');", ctx);
    assert.equal(kaActions().length, callsBeforeCustom);
    assert.equal(getEl("kv-keepalive-interval").value, "custom");
    assert.equal(getEl("kv-keepalive-interval-custom-wrap").classList.contains("hidden"), false);

    // Commit 7 minutes (420s) -> persists custom override, auto-enables window, shows follow-global button
    await vm.runInContext("changeTtlKeepaliveCustomMin('7');", ctx);
    assert.equal(kaActions().at(-1)?.payload?.action, "setTtlKeepalive");
    assert.equal(kaActions().at(-1)?.payload?.intervalSec, 420);
    assert.equal(getEl("kv-keepalive-interval").value, "custom");
    assert.equal(getEl("kv-keepalive-interval-custom").value, "7");
    assert.equal(getEl("kv-keepalive-interval-custom-wrap").classList.contains("hidden"), false);
    assert.equal(getEl("kv-keepalive-follow-btn").classList.contains("hidden"), false);
    assert.equal(getEl("kv-keepalive-btn").dataset.enabled, "1");

    // Click '随全局' (Global) reset -> clears override, hides custom input, restores window to global 540
    await vm.runInContext("resetTtlKeepaliveOverride();", ctx);
    assert.equal(kaActions().at(-1)?.payload?.action, "resetTtlKeepaliveOverride");
    assert.equal(getEl("kv-keepalive-interval").value, "540");
    assert.equal(getEl("kv-keepalive-interval-custom-wrap").classList.contains("hidden"), true);
    assert.equal(getEl("kv-keepalive-follow-btn").classList.contains("hidden"), true);
  } finally {
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    if (prevIntervalEnv === undefined) delete process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC;
    else process.env.AGY_DART_TTL_KEEPALIVE_INTERVAL_SEC = prevIntervalEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
