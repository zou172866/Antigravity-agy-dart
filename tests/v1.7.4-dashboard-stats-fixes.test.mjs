import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  describeToolCall,
  formatCacheDiagMarkdown,
  shortTargetLabel
} from "../context/lib/cache-analyzer.js";
import { ContextModeStore } from "../context/lib/store.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const T0_MS = Date.parse("2026-11-25T10:00:00.000Z");
const iso = (sec) => new Date(T0_MS + sec * 1000).toISOString();

function loadDashboardSandbox() {
  const html = readDashboardHtml();
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length >= 1, "Expected inline <script> in dashboard index.html");
  for (const m of scriptMatches) {
    new Function(m[1]);
    new vm.Script(m[1]);
  }
  const mainScript = scriptMatches[0][1];
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
    Headers: class {
      set() {}
      has() {
        return false;
      }
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    console: { error: () => {}, log: () => {} },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  vm.runInNewContext(mainScript, sandbox);
  return { html, sandbox, mockElements };
}

test("v1.7.4-1: shortTargetLabel preserves filename tail for long paths without corrupting commands", () => {
  const longWinPath =
    "C:\\Users\\js\\works\\codex\\codex_official\\vasp-band-agent\\docs\\development\\UNIFIED_CONFIRMATION_AND_STABILITY_PLAN.md";
  const lbl42 = shortTargetLabel(longWinPath, 42);
  assert.equal(lbl42, "UNIFIED_CONFIRMATION_AND_STABILITY_PLAN.md");
  assert.ok(lbl42.endsWith(".md"));
  assert.equal(lbl42.toLowerCase().includes("c:/users/"), false);

  // When basename itself exceeds maxLen, preserve trailing filename + extension
  const lbl30 = shortTargetLabel(longWinPath, 30);
  assert.equal(lbl30.length, 30);
  assert.ok(lbl30.startsWith("..."), `Expected leading ellipsis, got: ${lbl30}`);
  assert.ok(lbl30.endsWith(".md"), `Expected .md extension preserved, got: ${lbl30}`);
  assert.equal(lbl30.toLowerCase().includes("c:/users/"), false);

  // Windows absolute path with spaces still preserves filename
  const spacedWinPath = "C:\\Program Files\\My Workspace\\docs\\UNIFIED_CONFIRMATION_AND_STABILITY_PLAN.md";
  assert.equal(shortTargetLabel(spacedWinPath, 42), "UNIFIED_CONFIRMATION_AND_STABILITY_PLAN.md");

  // Short parent/base stays parent/base
  const shortTailPath = "C:\\Users\\js\\works\\codex\\chat\\toolbox_submission.py";
  assert.equal(shortTargetLabel(shortTailPath, 42), "chat/toolbox_submission.py");

  // Non-path shell command keeps head truncation (never drops command verb)
  const longCmd = "pytest tests/test_unified_confirm_stage2.py -v --tb=short --maxfail=1";
  const cmdLbl = shortTargetLabel(longCmd, 44);
  assert.ok(cmdLbl.startsWith("pytest "), `Command label must keep leading verb, got: ${cmdLbl}`);
  assert.ok(cmdLbl.endsWith("..."));

  // End-to-end describeToolCall for read_file with long path
  const desc = describeToolCall({ name: "read_file", args: { Path: longWinPath } });
  assert.equal(desc.label, "read_file(UNIFIED_CONFIRMATION_AND_STABILITY_PLAN.md)");
});

test("v1.7.4-2: loopWatch ignores timeouts and user cancellations, handles progressive TDD, and still catches real oscillations", () => {
  // 1. Batch apply_edits returning Verify [TIMEOUT] -> 0 oscillations
  const timeoutApplySteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 40000,
      tool_calls: [
        {
          id: "c1",
          name: "mcp_agy-dart_fast_apply_edits",
          args: {
            edits: [
              { path: "chat/fork_naming.py", create: "x = 1\n" },
              { path: "permissions/unified_confirm.py", create: "y = 2\n" }
            ],
            verify: "pytest tests/"
          }
        }
      ]
    },
    {
      type: "TOOL_RESULT",
      step_index: 2,
      tool_call_id: "c1",
      content: "Applied edits to 2 file(s):\nVerify [TIMEOUT in 60000ms] `pytest tests/`:\nTIMED OUT"
    }
  ];
  const dTimeoutApply = analyzeTranscriptCache(timeoutApplySteps, { nowMs: T0_MS + 10000 });
  assert.equal(dTimeoutApply.loopWatch.editFailOscillations, 0);
  assert.equal(dTimeoutApply.loopWatch.status, "ok");
  assert.deepEqual(dTimeoutApply.loopWatch.oscillatingFiles, []);

  // 2. run_checks with "Checks: 2/3 passed, 1 failed" where the only non-passing item is ## [TIMEOUT] -> 0 oscillations
  const runChecksTimeoutSteps = [
    ...timeoutApplySteps,
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(70),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 44000,
      tool_calls: [
        {
          id: "c2",
          name: "mcp_agy-dart_fast_run_checks",
          args: { commands: [{ name: "unit", command: "pytest tests/unit" }, { name: "mpl", command: "pytest tests/mpl" }] }
        }
      ]
    },
    {
      type: "TOOL_RESULT",
      step_index: 4,
      tool_call_id: "c2",
      content:
        "Checks: 1/2 passed, 1 failed (wall: 60010ms)\n\n- [PASS 120ms] unit (`pytest tests/unit`): 18 passed\n\n## [TIMEOUT 60000ms] mpl\n$ pytest tests/mpl\nTIMED OUT"
    }
  ];
  const dRunChecksTimeout = analyzeTranscriptCache(runChecksTimeoutSteps, { nowMs: T0_MS + 80000 });
  assert.equal(dRunChecksTimeout.loopWatch.editFailOscillations, 0);
  assert.equal(dRunChecksTimeout.loopWatch.status, "ok");
  assert.deepEqual(dRunChecksTimeout.loopWatch.oscillatingFiles, []);

  // 3. Full 6-step progressive TDD timeline from report (timeouts + ImportError -> ValueError -> 1 passed + AssertionError + user cancel)
  const fullTddTimeline = [
    ...runChecksTimeoutSteps,
    // Step 3: write_file new test file -> ImportError
    {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      created_at: iso(100),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 48000,
      tool_calls: [{ id: "c3", name: "write_file", args: { Path: "tests/test_unified_confirm_stage2.py", Content: "..." } }]
    },
    { type: "TOOL_RESULT", step_index: 6, tool_call_id: "c3", content: "Created file" },
    {
      type: "PLANNER_RESPONSE",
      step_index: 7,
      created_at: iso(110),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 52000,
      tool_calls: [{ id: "c4", name: "run_command", args: { CommandLine: "pytest tests/test_unified_confirm_stage2.py" } }]
    },
    {
      type: "TOOL_RESULT",
      step_index: 8,
      tool_call_id: "c4",
      status: "ERROR",
      exit_code: 2,
      content: "ImportError: cannot import name 'confirm_stage2' from 'permissions.unified_confirm'"
    },
    // Step 4: edit test file -> ValueError (POTCAR stub missing)
    {
      type: "PLANNER_RESPONSE",
      step_index: 9,
      created_at: iso(130),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 56000,
      tool_calls: [{ id: "c5", name: "edit_file", args: { Path: "tests/test_unified_confirm_stage2.py", Target: "a", Replacement: "b" } }]
    },
    { type: "TOOL_RESULT", step_index: 10, tool_call_id: "c5", content: "Edited file" },
    {
      type: "PLANNER_RESPONSE",
      step_index: 11,
      created_at: iso(140),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 60000,
      tool_calls: [{ id: "c6", name: "run_command", args: { CommandLine: "pytest tests/test_unified_confirm_stage2.py -k stage2" } }]
    },
    {
      type: "TOOL_RESULT",
      step_index: 12,
      tool_call_id: "c6",
      status: "ERROR",
      exit_code: 1,
      content: "ValueError: POTCAR fixture missing\n1 failed in 0.42s"
    },
    // Step 5: edit test file -> 1 passed, 1 failed AssertionError (real progress + bug located)
    {
      type: "PLANNER_RESPONSE",
      step_index: 13,
      created_at: iso(160),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 64000,
      tool_calls: [{ id: "c7", name: "edit_file", args: { Path: "tests/test_unified_confirm_stage2.py", Target: "b", Replacement: "c" } }]
    },
    { type: "TOOL_RESULT", step_index: 14, tool_call_id: "c7", content: "Edited file" },
    {
      type: "PLANNER_RESPONSE",
      step_index: 15,
      created_at: iso(170),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 68000,
      tool_calls: [{ id: "c8", name: "run_command", args: { CommandLine: "pytest tests/test_unified_confirm_stage2.py -v" } }]
    },
    {
      type: "TOOL_RESULT",
      step_index: 16,
      tool_call_id: "c8",
      status: "ERROR",
      exit_code: 1,
      content: "E   AssertionError: expected 'allow' == 'confirm'\n1 passed, 1 failed in 0.55s"
    },
    // Step 6: user cancels apply_edits fix (host marks status ERROR + "Tool execution was canceled")
    {
      type: "PLANNER_RESPONSE",
      step_index: 17,
      created_at: iso(190),
      model: "claude-sonnet-4-6",
      input_tokens: 4000,
      cache_read_tokens: 72000,
      tool_calls: [
        {
          id: "c9",
          name: "mcp_agy-dart_fast_apply_edits",
          args: { edits: [{ path: "permissions/unified_confirm.py", hunks: [{ target: "x", replacement: "y" }] }] }
        }
      ]
    },
    {
      type: "TOOL_RESULT",
      step_index: 18,
      tool_call_id: "c9",
      status: "ERROR",
      content: "Tool execution was canceled"
    }
  ];
  const dTdd = analyzeTranscriptCache(fullTddTimeline, { nowMs: T0_MS + 200000 });
  assert.equal(dTdd.loopWatch.status, "ok", `Progressive TDD + timeout + cancel must stay ok, got: ${JSON.stringify(dTdd.loopWatch)}`);
  assert.equal(dTdd.loopWatch.editFailOscillations, 1);
  assert.deepEqual(dTdd.loopWatch.oscillatingFiles, []);
  assert.equal(dTdd.inToolLoop, false, "Canceled tool turn must clear inToolLoop");

  // PreInvocation hook must emit ZERO convergence alerts for this timeline
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v174-loop-"));
  try {
    const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db") });
    const alerts = evaluateCacheAlerts(dTdd, { sessionId: "tdd-no-false-alert", store });
    assert.equal(alerts.length, 0, `Expected no convergence alert, got: ${JSON.stringify(alerts)}`);
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }

  // 4. Disjoint files failing once each (a.js -> b.js -> c.js) do NOT trigger oscillation
  const disjointSteps = ["src/a.js", "src/b.js", "src/c.js"].flatMap((file, idx) => [
    {
      type: "PLANNER_RESPONSE",
      step_index: idx * 4 + 1,
      created_at: iso(idx * 20),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 30000,
      tool_calls: [{ id: `e${idx}`, name: "edit_file", args: { Path: file, Target: "1", Replacement: "2" } }]
    },
    { type: "TOOL_RESULT", step_index: idx * 4 + 2, tool_call_id: `e${idx}`, content: "ok" },
    {
      type: "PLANNER_RESPONSE",
      step_index: idx * 4 + 3,
      created_at: iso(idx * 20 + 5),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 31000,
      tool_calls: [{ id: `t${idx}`, name: "run_command", args: { CommandLine: `npm test -- ${file}` } }]
    },
    { type: "TOOL_RESULT", step_index: idx * 4 + 4, tool_call_id: `t${idx}`, status: "ERROR", exit_code: 1, content: "AssertionError: mismatch" }
  ]);
  const dDisjoint = analyzeTranscriptCache(disjointSteps, { nowMs: T0_MS + 90000 });
  assert.equal(dDisjoint.loopWatch.status, "ok");
  assert.equal(dDisjoint.loopWatch.editFailOscillations, 1);
  assert.deepEqual(dDisjoint.loopWatch.oscillatingFiles, []);

  // 5. True A<->B<->A ping-pong regression on the SAME file IS caught as warn, listing only that file
  const pingPongSteps = [
    // Unrelated single-edit file first
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 20000,
      tool_calls: [{ id: "u1", name: "edit_file", args: { Path: "src/once.js" } }]
    },
    { type: "TOOL_RESULT", step_index: 2, tool_call_id: "u1", content: "ok" },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(5),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 21000,
      tool_calls: [{ id: "u2", name: "run_command", args: { CommandLine: "npm test -- once" } }]
    },
    { type: "TOOL_RESULT", step_index: 4, tool_call_id: "u2", status: "ERROR", exit_code: 1, content: "SyntaxError: bad token" },
    // Now src/flaky.js bounces AssertionError -> TypeError -> AssertionError
    ...["AssertionError: bad output", "TypeError: cannot read x", "AssertionError: bad output"].flatMap((errText, k) => [
      {
        type: "PLANNER_RESPONSE",
        step_index: 5 + k * 4,
        created_at: iso(20 + k * 15),
        model: "claude-sonnet-4-6",
        input_tokens: 3000,
        cache_read_tokens: 22000 + k * 1000,
        tool_calls: [{ id: `f${k}`, name: "edit_file", args: { Path: "src/flaky.js", Target: `v${k}`, Replacement: `v${k + 1}` } }]
      },
      { type: "TOOL_RESULT", step_index: 6 + k * 4, tool_call_id: `f${k}`, content: "ok" },
      {
        type: "PLANNER_RESPONSE",
        step_index: 7 + k * 4,
        created_at: iso(25 + k * 15),
        model: "claude-sonnet-4-6",
        input_tokens: 3000,
        cache_read_tokens: 22500 + k * 1000,
        tool_calls: [{ id: `r${k}`, name: "run_command", args: { CommandLine: `npm test -- flaky-${k}` } }]
      },
      { type: "TOOL_RESULT", step_index: 8 + k * 4, tool_call_id: `r${k}`, status: "ERROR", exit_code: 1, content: errText }
    ])
  ];
  const dPingPong = analyzeTranscriptCache(pingPongSteps, { nowMs: T0_MS + 100000 });
  assert.equal(dPingPong.loopWatch.status, "warn");
  assert.equal(dPingPong.loopWatch.editFailOscillations, 2);
  assert.deepEqual(dPingPong.loopWatch.oscillatingFiles, ["src/flaky.js"]);

  // 6. Mixed run_checks (## [FAIL] + ## [TIMEOUT]) is still treated as a real failure
  const mixedFailTimeout = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 20000,
      tool_calls: [{ id: "m1", name: "edit_file", args: { Path: "src/mix.js" } }]
    },
    { type: "TOOL_RESULT", step_index: 2, tool_call_id: "m1", content: "ok" },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(5),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 21000,
      tool_calls: [{ id: "m2", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "a", command: "npm test" }] } }]
    },
    {
      type: "TOOL_RESULT",
      step_index: 4,
      tool_call_id: "m2",
      content: "Checks: 0/2 passed, 2 failed (wall: 60010ms)\n\n## [FAIL (exit 1) 120ms] unit\nAssertionError: x\n\n## [TIMEOUT 60000ms] slow\nTIMED OUT"
    }
  ];
  const dMixed = analyzeTranscriptCache(mixedFailTimeout, { nowMs: T0_MS + 20000 });
  assert.equal(dMixed.loopWatch.editFailOscillations, 1);

  // 7. Explicitly aborted turn (aborted: true) does not increment oscillation
  const abortedTurnSteps = [
    ...mixedFailTimeout,
    {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      created_at: iso(15),
      model: "claude-sonnet-4-6",
      aborted: true,
      input_tokens: 3000,
      cache_read_tokens: 22000,
      tool_calls: [{ id: "m3", name: "edit_file", args: { Path: "src/mix.js" } }]
    },
    { type: "TOOL_RESULT", step_index: 6, tool_call_id: "m3", status: "ERROR", content: "AssertionError: stale" }
  ];
  const dAborted = analyzeTranscriptCache(abortedTurnSteps, { nowMs: T0_MS + 30000 });
  assert.equal(dAborted.loopWatch.editFailOscillations, 1);
  assert.equal(dAborted.loopWatch.status, "ok");
});

test("v1.7.4-3: parallel tool turn annotates topContextDeltas and recentTurns with +N count and byte-share breakdown", () => {
  const steps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      input_tokens: 5000,
      cache_read_tokens: 45000,
      tool_calls: [
        { id: "r1", name: "read_file", args: { Path: "chat/toolbox_submission.py" } },
        { id: "r2", name: "read_file", args: { Path: "chat/toolbox_workflow.py" } },
        { id: "r3", name: "read_file", args: { Path: "chat/worker_prepare.py" } },
        { id: "r4", name: "mcp_agy-dart_fast_batch_search", args: { queries: [{ type: "text", pattern: "confirm" }] } }
      ]
    },
    { type: "TOOL_RESULT", step_index: 2, tool_call_id: "r1", content: "A".repeat(16000) },
    { type: "TOOL_RESULT", step_index: 3, tool_call_id: "r2", content: "B".repeat(14000) },
    { type: "TOOL_RESULT", step_index: 4, tool_call_id: "r3", content: "C".repeat(12000) },
    { type: "TOOL_RESULT", step_index: 5, tool_call_id: "r4", content: "D".repeat(8000) },
    {
      type: "PLANNER_RESPONSE",
      step_index: 6,
      created_at: iso(20),
      model: "claude-sonnet-4-6",
      input_tokens: 20900,
      cache_read_tokens: 50000,
      tool_calls: [{ id: "s1", name: "read_file", args: { Path: "chat/single.py" } }]
    },
    { type: "TOOL_RESULT", step_index: 7, tool_call_id: "s1", content: "S".repeat(6000) },
    {
      type: "PLANNER_RESPONSE",
      step_index: 8,
      created_at: iso(35),
      model: "claude-sonnet-4-6",
      input_tokens: 3000,
      cache_read_tokens: 70900
    }
  ];

  const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 40000 });
  assert.equal(diag.topContextDeltas.length, 2);

  // Parallel turn entry
  const par = diag.topContextDeltas[0];
  assert.equal(par.deltaTokens, 20900);
  assert.equal(par.label, "read_file(chat/toolbox_submission.py) +3");
  assert.equal(par.toolCount, 4);
  assert.ok(Array.isArray(par.parallelTools) && par.parallelTools.length === 4);
  assert.equal(par.parallelTools[0].label, "read_file(chat/toolbox_submission.py)");
  assert.equal(par.parallelTools[0].sharePct, 32); // 16000 / 50000
  assert.equal(par.parallelTools[1].sharePct, 28); // 14000 / 50000
  assert.equal(par.parallelTools[2].sharePct, 24); // 12000 / 50000
  assert.equal(par.parallelTools[3].sharePct, 16); // 8000 / 50000

  // recentTurns triggerTool also displays +3
  const turn2 = diag.recentTurns.find((t) => t.turn === 2);
  assert.equal(turn2.triggerTool, "read_file(chat/toolbox_submission.py) +3");

  // Single-tool turn keeps clean label without +0 and omits parallelTools
  const single = diag.topContextDeltas[1];
  assert.equal(single.label, "read_file(chat/single.py)");
  assert.equal(single.toolCount, 1);
  assert.equal(single.parallelTools, undefined);

  // Markdown report displays the +3 parallel tag
  const md = formatCacheDiagMarkdown(diag);
  assert.ok(md.includes("`read_file(chat/toolbox_submission.py) +3`"), `Expected +3 in Markdown:\n${md}`);
});

test("v1.7.4-4: Dashboard UI renders parallel delta tooltip, transcript-vs-API prefix scope, XSS safety, and high-contrast toolCalls bar", () => {
  const { html, sandbox, mockElements } = loadDashboardSandbox();

  // Issue 5: CSS contrast & bar height check
  assert.ok(html.includes(".seg-bg-toolCalls { background: #0d9488; }"), "toolCalls segment must use high-contrast #0d9488");
  assert.equal(html.includes(".seg-bg-toolCalls { background: #64748b; }"), false, "Legacy low-contrast #64748b must be replaced");
  assert.match(html, /\.comp-bar\s*\{[^}]*height:\s*9px;/s, ".comp-bar height must be 9px");

  const steps = [
    { type: "USER_INPUT", step_index: 1, created_at: iso(0), content: "Inspect modules in parallel." },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(5),
      model: "claude-sonnet-4-6",
      input_tokens: 18000,
      cache_read_tokens: 162000, // currentContextTokens = 180k, transcript est << 180k -> inferred prefix > 1000
      tool_calls: [
        { id: "p1", name: "read_file", args: { Path: "chat/toolbox_submission.py" } },
        { id: "p2", name: "read_file", args: { Path: "chat/toolbox_workflow.py" } }
      ]
    },
    { type: "TOOL_RESULT", step_index: 3, tool_call_id: "p1", content: "X".repeat(12000) },
    { type: "TOOL_RESULT", step_index: 4, tool_call_id: "p2", content: "Y".repeat(8000) },
    {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      created_at: iso(25),
      model: "claude-sonnet-4-6",
      input_tokens: 200000,
      cache_read_tokens: 0 // 1 bust -> 180k waste
    }
  ];
  const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 35000 });
  const kvPayload = { ok: true, transcriptFound: true, ...diag };

  // 1. English rendering: parallel tooltip + inferred prefix readout + API scope waste tooltip
  sandbox.setLanguage("en");
  sandbox.renderKvCacheCard(kvPayload);
  const deltasEn = mockElements.get("kv-top-deltas-row").innerHTML;
  assert.ok(deltasEn.includes("read_file(chat/toolbox_submission.py) +1"), `EN delta chip: ${deltasEn}`);
  assert.ok(deltasEn.includes("2 parallel tools"), `EN parallel tooltip missing count: ${deltasEn}`);
  assert.ok(deltasEn.includes("~60%"), `EN parallel tooltip missing 60% share: ${deltasEn}`);
  assert.ok(deltasEn.includes("~40%"), `EN parallel tooltip missing 40% share: ${deltasEn}`);

  const compTotalEn = mockElements.get("kv-composition-total");
  assert.ok(compTotalEn.textContent.includes("Transcript ~"), `EN comp total must specify Transcript scope: ${compTotalEn.textContent}`);
  assert.ok(compTotalEn.textContent.includes("prefix)"), `EN comp total must show inferred prefix gap: ${compTotalEn.textContent}`);
  assert.ok(compTotalEn.title.includes("excluding system prompt"), `EN comp tip must clarify scope: ${compTotalEn.title}`);
  assert.ok(compTotalEn.title.includes("Actual API context"), `EN comp tip must show API context: ${compTotalEn.title}`);
  assert.ok(mockElements.get("kv-wasted-tokens").title.includes("incl. system & tool prefix"));

  // 2. Chinese rendering: parallel tooltip + inferred prefix readout + no regression to 前缀漂移
  sandbox.setLanguage("zh");
  const deltasZh = mockElements.get("kv-top-deltas-row").innerHTML;
  assert.ok(deltasZh.includes("并行 2 个工具"), `ZH parallel tooltip missing count: ${deltasZh}`);
  assert.ok(deltasZh.includes("~60%"), `ZH parallel tooltip missing share: ${deltasZh}`);

  const compTotalZh = mockElements.get("kv-composition-total");
  assert.ok(compTotalZh.textContent.includes("+前缀约"), `ZH comp total must show inferred prefix gap: ${compTotalZh.textContent}`);
  assert.ok(compTotalZh.title.includes("仅统计对话记录"), `ZH comp tip must clarify transcript-only scope: ${compTotalZh.title}`);
  assert.ok(mockElements.get("kv-wasted-tokens").title.includes("按含系统/工具前缀的 API 真实上下文计算"));
  const causesZh = mockElements.get("kv-bust-causes").innerHTML;
  assert.ok(causesZh.includes("原因未定"));
  assert.equal(causesZh.includes("前缀漂移"), false, "ZH bust causes must never regress to 前缀漂移");

  // 3. Multi-session payload omits single-session inferred prefix subtraction
  const agg = analyzeMultipleSessionsCache([steps, steps], { nowMs: T0_MS + 40000 });
  sandbox.renderKvCacheCard({ ok: true, transcriptFound: true, ...agg });
  assert.equal(mockElements.get("kv-composition-total").textContent.includes("+前缀约"), false);
  assert.ok(mockElements.get("kv-composition-total").textContent.includes("对话记录约"));

  // 4. XSS hardening on parallelTools and adversarial apiContextTokens
  sandbox.setLanguage("en");
  sandbox.renderKvCacheCard({
    ...kvPayload,
    currentContextTokens: '<img src=x onerror="alert(1)">',
    topContextDeltas: [
      {
        turn: 2,
        deltaTokens: 15000,
        label: 'read_file(<script>x</script>) +1',
        toolCount: 2,
        parallelTools: [
          { label: '<img src=x onerror="alert(1)">', sharePct: 70 },
          { label: "safe.py", sharePct: 30 }
        ]
      }
    ]
  });
  const xssDeltas = mockElements.get("kv-top-deltas-row").innerHTML;
  assert.equal(xssDeltas.includes("<script>"), false);
  assert.equal(xssDeltas.includes("<img"), false);
  assert.equal(mockElements.get("kv-composition-total").title.includes("NaN"), false);
  assert.equal(mockElements.get("kv-composition-total").textContent.includes("NaN"), false);
});
