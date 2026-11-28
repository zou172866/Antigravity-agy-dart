import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  createEmptyContextComposition,
  createEmptySubagentBreakdown,
  DEFAULT_MEDIA_EST_TOKENS,
  estimateTextTokens,
  formatCacheDiagMarkdown
} from "../context/lib/cache-analyzer.js";
import { fetchDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function assertNoNaNOrInfinity(obj, pathPrefix = "root") {
  if (typeof obj === "number") {
    assert.ok(Number.isFinite(obj), `Non-finite number at ${pathPrefix}: ${obj}`);
    return;
  }
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((v, idx) => assertNoNaNOrInfinity(v, `${pathPrefix}[${idx}]`));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    assertNoNaNOrInfinity(v, `${pathPrefix}.${k}`);
  }
}

test("P2-9.1: contextComposition splits all 7 buckets accurately, avoids thinking double-count, and handles CJK & empty transcripts with zero NaN", () => {
  const t0 = Date.parse("2026-11-20T12:00:00.000Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // 1. Direct CJK / ASCII / Emoji estimator checks
  assert.deepEqual(estimateTextTokens(""), { bytes: 0, estTokens: 0 });
  assert.deepEqual(estimateTextTokens(null), { bytes: 0, estTokens: 0 });
  const asciiEst = estimateTextTokens("a".repeat(400));
  assert.equal(asciiEst.bytes, 400);
  assert.equal(asciiEst.estTokens, 100);

  const cjkStr = "中文上下文分析测试".repeat(10); // 90 CJK chars = 270 UTF-8 bytes
  const cjkEst = estimateTextTokens(cjkStr);
  assert.equal(cjkEst.bytes, Buffer.byteLength(cjkStr, "utf8"));
  assert.equal(cjkEst.bytes, 270);
  assert.equal(cjkEst.estTokens, 90, "CJK estimation should be CJK-aware (~1 tok/char, not naive chars/4=23)");

  const emojiStr = "hello 世界 🚀";
  const emojiEst = estimateTextTokens(emojiStr);
  assert.equal(emojiEst.bytes, Buffer.byteLength(emojiStr, "utf8"));
  assert.ok(emojiEst.estTokens >= 5);

  // 2. Full 7-bucket transcript covering every tool type & out-of-order tool_call_id matching
  const steps = [
    {
      type: "USER_INPUT",
      step_index: 1,
      created_at: iso(0),
      content: "Please inspect src/app.js and run tests. 请检查核心逻辑。".repeat(2),
      media: [{ mime_type: "image/png", uri: "file:///shot1.png" }]
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(5),
      model: "claude-sonnet-4-6",
      // BOTH thinking text AND explicit thinking_tokens present -> MUST use thinking_tokens (500) without double-counting!
      thinking: "Let me plan my inspection carefully. ".repeat(10),
      thinking_tokens: 500,
      content: "I will read the target files and run the test suite.",
      input_tokens: 8000,
      cache_read_tokens: 0,
      output_tokens: 180,
      tool_calls: [
        { id: "call-read", name: "read_file", args: { Path: "src/app.js", StartLine: 1, EndLine: 80 } },
        { id: "call-cmd", name: "run_command", args: { CommandLine: "npm test" } },
        {
          id: "call-mcp-slices",
          name: "call_mcp_tool",
          args: { ServerName: "agy-dart_fast", ToolName: "read_slices", Arguments: { slices: [{ path: "src/lib.js", ranges: [[1, 40]] }] } }
        }
      ]
    },
    // Out-of-order tool_call_id results to verify accurate fileReads vs toolResults routing
    {
      type: "TOOL_RESULT",
      step_index: 3,
      tool_call_id: "call-cmd",
      content: "PASS 24 tests in 110ms\n".repeat(15)
    },
    {
      type: "GENERIC",
      step_index: 4,
      tool_call_id: "call-read",
      content: "export function main() {\n  return 42;\n}\n".repeat(40)
    },
    {
      type: "TOOL_RESULT",
      step_index: 5,
      tool_call_id: "call-mcp-slices",
      content: "export const helper = () => 'ok';\n".repeat(30)
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 6,
      created_at: iso(15),
      model: "claude-sonnet-4-6",
      // Thinking text ONLY (no thinking_tokens field) -> estimated from text!
      thinking: "Everything passed cleanly. ".repeat(8),
      content: "All 24 tests pass and the core logic looks solid.",
      input_tokens: 2000,
      cache_read_tokens: 8000,
      output_tokens: 120,
      tool_calls: [
        { name: "view_file", arguments: JSON.stringify({ AbsolutePath: "src/extra.js", StartLine: 1, EndLine: 20 }) },
        { name: "mcp_agy-dart_fast_read_slices", args: { outlines: ["src/app.js"] } },
        { name: "batch_search", args: { queries: [{ pattern: "main", type: "text" }] } }
      ]
    },
    // Positional results matching view_file, direct MCP read_slices, and batch_search
    { type: "GENERIC", step_index: 7, content: "export const extra = 1;\n".repeat(25) },
    { type: "GENERIC", step_index: 8, content: "outline: main L1-L3\n".repeat(10) },
    {
      type: "GENERIC",
      step_index: 9,
      content: "src/app.js:1: export function main()\n".repeat(12),
      media: [{ mime_type: "image/webp", tokens: 900, bytes: 20480 }]
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 10,
      created_at: iso(25),
      model: "gemini-4-pro",
      // Explicit thoughtsTokenCount ONLY (no step.thinking text) -> counted in thinking bucket!
      usage: {
        promptTokenCount: 12000,
        cachedContentTokenCount: 9000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 300
      },
      content: "Done."
    }
  ];

  const diag = analyzeTranscriptCache(steps, { nowMs: t0 + 35 * 1000 });
  assertNoNaNOrInfinity(diag);

  const comp = diag.contextComposition;
  assert.ok(comp, "contextComposition must exist");
  for (const key of ["user", "thinking", "assistant", "toolCalls", "fileReads", "toolResults", "media"]) {
    assert.ok(comp[key], `Missing bucket: ${key}`);
    assert.ok(comp[key].estTokens > 0, `Expected positive estTokens in bucket ${key}, got ${comp[key].estTokens}`);
    assert.ok(comp[key].pct > 0, `Expected positive pct in bucket ${key}, got ${comp[key].pct}`);
  }

  // Thinking bucket MUST NOT double-count turn 2 (500 explicit) + turn 6 (text est ~54) + turn 10 (300 explicit)
  const turn6ThinkingEst = estimateTextTokens("Everything passed cleanly. ".repeat(8)).estTokens;
  assert.equal(comp.thinking.estTokens, 500 + turn6ThinkingEst + 300);
  const expectedThinkingBytes =
    Buffer.byteLength("Let me plan my inspection carefully. ".repeat(10), "utf8") +
    Buffer.byteLength("Everything passed cleanly. ".repeat(8), "utf8");
  assert.equal(comp.thinking.bytes, expectedThinkingBytes);

  // Media bucket: 1 default attachment (1600) + 1 explicit attachment (900 tok, 20480 bytes)
  assert.equal(comp.mediaCount, 2);
  assert.equal(comp.media.mediaCount, 2);
  assert.equal(comp.media.estTokens, DEFAULT_MEDIA_EST_TOKENS + 900);
  assert.equal(comp.media.bytes, 20480);

  // fileReads captures read_file + call_mcp_tool(read_slices) + view_file + mcp_agy-dart_fast_read_slices
  const expectedFileReadBytes =
    Buffer.byteLength("export function main() {\n  return 42;\n}\n".repeat(40), "utf8") +
    Buffer.byteLength("export const helper = () => 'ok';\n".repeat(30), "utf8") +
    Buffer.byteLength("export const extra = 1;\n".repeat(25), "utf8") +
    Buffer.byteLength("outline: main L1-L3\n".repeat(10), "utf8");
  assert.equal(comp.fileReads.bytes, expectedFileReadBytes);

  // toolResults captures run_command + batch_search ONLY
  const expectedToolResBytes =
    Buffer.byteLength("PASS 24 tests in 110ms\n".repeat(15), "utf8") +
    Buffer.byteLength("src/app.js:1: export function main()\n".repeat(12), "utf8");
  assert.equal(comp.toolResults.bytes, expectedToolResBytes);

  // Totals & percentages reconcile cleanly
  const sumEst =
    comp.user.estTokens +
    comp.thinking.estTokens +
    comp.assistant.estTokens +
    comp.toolCalls.estTokens +
    comp.fileReads.estTokens +
    comp.toolResults.estTokens +
    comp.media.estTokens;
  assert.equal(comp.totalEstTokens, sumEst);
  const sumPct =
    comp.user.pct +
    comp.thinking.pct +
    comp.assistant.pct +
    comp.toolCalls.pct +
    comp.fileReads.pct +
    comp.toolResults.pct +
    comp.media.pct;
  assert.ok(Math.abs(sumPct - 100) <= 0.5, `Bucket percentages should sum near 100%, got ${sumPct}`);
  assert.equal(comp.dominantCategory, "media", "Media (2,500 est tokens) should be dominant bucket in this fixture");

  // 3. Empty & malformed transcripts produce clean zeros, null dominantCategory, zero NaN
  for (const weirdInput of [
    [],
    null,
    undefined,
    [null, {}, { type: "PLANNER_RESPONSE", thinking: null, content: 123, tool_calls: "invalid", media: [] }]
  ]) {
    const emptyDiag = analyzeTranscriptCache(weirdInput);
    assertNoNaNOrInfinity(emptyDiag);
    assert.equal(emptyDiag.contextComposition.totalEstTokens, 0);
    assert.equal(emptyDiag.contextComposition.totalBytes, 0);
    assert.equal(emptyDiag.contextComposition.dominantCategory, null);
    assert.equal(emptyDiag.contextComposition.mediaCount, 0);
    for (const k of ["user", "thinking", "assistant", "toolCalls", "fileReads", "toolResults", "media"]) {
      assert.equal(emptyDiag.contextComposition[k].bytes, 0);
      assert.equal(emptyDiag.contextComposition[k].estTokens, 0);
      assert.equal(emptyDiag.contextComposition[k].pct, 0);
    }
    assert.equal(emptyDiag.subagentBreakdown.subagentSharePct, 0);
    assert.equal(emptyDiag.subagentBreakdown.subagentDelegations, 0);
  }
});

test("P2-9.2: subagentBreakdown distinguishes primary vs subagent turns/tools, counts invoke_subagent & swarm(add), and avoids double-counting", () => {
  const t0 = Date.parse("2026-11-20T13:00:00.000Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  const steps = [
    { type: "USER_INPUT", step_index: 1, created_at: iso(0), content: "Refactor auth and audit tests in parallel." },
    // Primary turn 1: delegates via invoke_subagent AND swarm(add), plus non-delegation swarm(status) & read_file
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(5),
      model: "claude-sonnet-4-6",
      agent: "primary",
      content: "Spawning two specialist workers now.",
      input_tokens: 10000,
      cache_read_tokens: 0,
      tool_calls: [
        { name: "invoke_subagent", args: { agent: "auditor", prompt: "Audit auth module" } },
        { name: "swarm", arguments: JSON.stringify({ action: "add", name: "test-writer", brief: "Write tests" }) },
        { name: "swarm", args: { action: "status" } },
        { name: "read_file", args: { Path: "src/auth.js" } }
      ]
    },
    // Result of invoke_subagent AND ALSO tagged subagent:true -> MUST NOT double-count!
    {
      type: "TOOL_RESULT",
      step_index: 3,
      subagent: true,
      content: "Auditor report: verified JWT verification and found 1 edge case. ".repeat(10)
    },
    // Result of swarm(add)
    {
      type: "GENERIC",
      step_index: 4,
      content: "Spawned worker test-writer on board #14."
    },
    // Result of swarm(status) -> NOT a delegation result!
    {
      type: "GENERIC",
      step_index: 5,
      content: "Roster: coordinator working, test-writer working."
    },
    // Result of primary read_file -> primary fileReads, NOT subagent
    {
      type: "GENERIC",
      step_index: 6,
      content: "export function verifyJwt() { return true; }\n".repeat(12)
    },
    // Subagent-tagged PLANNER_RESPONSE via step.subagent === true
    {
      type: "PLANNER_RESPONSE",
      step_index: 7,
      created_at: iso(20),
      model: "claude-sonnet-4-6",
      subagent: true,
      thinking: "Inspecting auth tests.",
      content: "Running targeted unit tests.",
      input_tokens: 2000,
      cache_read_tokens: 10000,
      tool_calls: [{ name: "run_command", args: { CommandLine: "node --test auth.test.mjs" } }]
    },
    // Subagent-tagged tool result via step.source === "SUBAGENT"
    {
      type: "TOOL_RESULT",
      step_index: 8,
      source: "SUBAGENT",
      content: "12 passed, 0 failed in auth.test.mjs"
    },
    // Subagent-tagged PLANNER_RESPONSE via non-primary step.agent === "test-writer"
    {
      type: "PLANNER_RESPONSE",
      step_index: 9,
      created_at: iso(30),
      model: "claude-sonnet-4-6",
      agent: "test-writer",
      content: "Added regression tests.",
      input_tokens: 1500,
      cache_read_tokens: 12000,
      tool_calls: [
        { name: "edit_file", args: { Path: "tests/auth.test.mjs", Target: "a", Replacement: "b" } },
        { name: "run_command", args: { CommandLine: "npm test" } }
      ]
    },
    // Subagent message via step.role === "subagent"
    {
      type: "SUBAGENT_MESSAGE",
      step_index: 10,
      role: "subagent",
      content: "Worker test-writer completed all assertions."
    },
    // Primary turn 2 with step.agent === "antigravity" (must be treated as primary, NOT subagent!)
    {
      type: "PLANNER_RESPONSE",
      step_index: 11,
      created_at: iso(40),
      model: "claude-sonnet-4-6",
      agent: "antigravity",
      content: "All subagent work has been integrated and verified.",
      input_tokens: 1000,
      cache_read_tokens: 14000
    }
  ];

  const diag = analyzeTranscriptCache(steps, { nowMs: t0 + 50 * 1000 });
  assertNoNaNOrInfinity(diag);
  const sub = diag.subagentBreakdown;

  assert.equal(sub.subagentDelegations, 2, "Only invoke_subagent + swarm(add) count as delegations (not swarm(status))");
  assert.equal(sub.primaryTurns, 2, "primary + antigravity turns count as primaryTurns");
  assert.equal(sub.subagentTurns, 2, "subagent:true + agent:'test-writer' turns count as subagentTurns");
  assert.equal(sub.primaryToolCalls, 4);
  assert.equal(sub.subagentToolCalls, 3);

  // Verify exact subagentResultBytes without double-counting step 3
  const step3Text = "Auditor report: verified JWT verification and found 1 edge case. ".repeat(10);
  const step4Text = "Spawned worker test-writer on board #14.";
  const step7Thinking = "Inspecting auth tests.";
  const step7Content = "Running targeted unit tests.";
  const step7Call = 'run_command {"CommandLine":"node --test auth.test.mjs"}';
  const step8Text = "12 passed, 0 failed in auth.test.mjs";
  const step9Content = "Added regression tests.";
  const step9Call1 = 'edit_file {"Path":"tests/auth.test.mjs","Target":"a","Replacement":"b"}';
  const step9Call2 = 'run_command {"CommandLine":"npm test"}';
  const step10Text = "Worker test-writer completed all assertions.";
  const expectedSubBytes = [
    step3Text,
    step4Text,
    step7Thinking,
    step7Content,
    step7Call,
    step8Text,
    step9Content,
    step9Call1,
    step9Call2,
    step10Text
  ].reduce((acc, s) => acc + Buffer.byteLength(s, "utf8"), 0);

  assert.equal(sub.subagentResultBytes, expectedSubBytes, "Subagent bytes must match exact sum with zero double-counting");
  assert.ok(sub.subagentResultEstTokens > 0);
  assert.ok(sub.subagentSharePct > 0 && sub.subagentSharePct <= 100);
});

test("P2-9.3: analyzeMultipleSessionsCache aggregates contextComposition & subagentBreakdown and formatCacheDiagMarkdown preserves existing rows", () => {
  const t0 = Date.parse("2026-11-20T14:00:00.000Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  const sessionA = [
    { type: "USER_INPUT", step_index: 1, created_at: iso(0), content: "Inspect server logs." },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(5),
      model: "claude-sonnet-4-6",
      thinking: "Reading the log file first.",
      content: "Checking server.log now.",
      input_tokens: 10000,
      cache_read_tokens: 0,
      tool_calls: [{ name: "read_file", args: { Path: "logs/server.log" } }]
    },
    { type: "GENERIC", step_index: 3, content: "INFO started server on port 8765\n".repeat(40) }
  ];

  const sessionB = [
    { type: "USER_INPUT", step_index: 1, created_at: iso(100), content: "Delegate audit to subagent." },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(105),
      model: "claude-sonnet-4-6",
      thinking_tokens: 400,
      content: "Delegating to security reviewer.",
      input_tokens: 4000,
      cache_read_tokens: 12000,
      tool_calls: [{ name: "invoke_subagent", args: { prompt: "Review security" } }]
    },
    {
      type: "TOOL_RESULT",
      step_index: 3,
      content: "No vulnerabilities found across 18 endpoints.\n".repeat(15),
      media: [{ mime_type: "image/png" }]
    }
  ];

  const diagA = analyzeTranscriptCache(sessionA, { nowMs: t0 + 200 * 1000 });
  const diagB = analyzeTranscriptCache(sessionB, { nowMs: t0 + 200 * 1000 });
  const agg = analyzeMultipleSessionsCache([sessionA, sessionB], { nowMs: t0 + 200 * 1000 });
  assertNoNaNOrInfinity(agg);

  // Composition sums cleanly across sessions
  assert.equal(
    agg.contextComposition.totalEstTokens,
    diagA.contextComposition.totalEstTokens + diagB.contextComposition.totalEstTokens
  );
  assert.equal(
    agg.contextComposition.totalBytes,
    diagA.contextComposition.totalBytes + diagB.contextComposition.totalBytes
  );
  assert.equal(agg.contextComposition.mediaCount, 1);
  assert.equal(
    agg.contextComposition.fileReads.bytes,
    diagA.contextComposition.fileReads.bytes + diagB.contextComposition.fileReads.bytes
  );
  assert.equal(
    agg.contextComposition.thinking.estTokens,
    diagA.contextComposition.thinking.estTokens + diagB.contextComposition.thinking.estTokens
  );
  assert.ok(agg.contextComposition.dominantCategory !== null);

  // Subagent breakdown sums cleanly across sessions
  assert.equal(agg.subagentBreakdown.primaryTurns, 2);
  assert.equal(agg.subagentBreakdown.subagentTurns, 0);
  assert.equal(agg.subagentBreakdown.primaryToolCalls, 2);
  assert.equal(agg.subagentBreakdown.subagentDelegations, 1);
  assert.equal(agg.subagentBreakdown.subagentResultBytes, diagB.subagentBreakdown.subagentResultBytes);
  assert.equal(agg.subagentBreakdown.subagentResultEstTokens, diagB.subagentBreakdown.subagentResultEstTokens);
  assert.ok(agg.subagentBreakdown.subagentSharePct > 0 && agg.subagentBreakdown.subagentSharePct <= 100);

  // Single-session wrapper matches direct analyzeTranscriptCache
  const singleAgg = analyzeMultipleSessionsCache([sessionB], { nowMs: t0 + 200 * 1000 });
  assert.deepEqual(singleAgg.contextComposition, diagB.contextComposition);
  assert.deepEqual(singleAgg.subagentBreakdown, diagB.subagentBreakdown);

  // Empty sessions list has zero NaN
  const emptyAgg = analyzeMultipleSessionsCache([]);
  assertNoNaNOrInfinity(emptyAgg);
  assert.deepEqual(emptyAgg.contextComposition, createEmptyContextComposition());
  assert.deepEqual(emptyAgg.subagentBreakdown, createEmptySubagentBreakdown());

  // Markdown preserves ALL existing rows AND adds Context Composition table + Subagent Attribution line
  const mdAgg = formatCacheDiagMarkdown(agg);
  for (const requiredExistingRow of [
    "| Sessions analyzed |",
    "| Turns with token usage |",
    "| Weighted Prompt Cache hit rate |",
    "| Average turn hit rate |",
    "| Est. input cost savings (at 90% cache discount) |",
    "| Peak context size (tokens) |",
    "| Total cache busts detected |",
    "| Wasted re-prefill tokens |",
    "| Bust cause: Idle TTL expiry |",
    "| Bust cause: Compaction / truncation |",
    "| Bust cause: Model switch |",
    "| Bust cause: System injection |",
    "| Bust cause: Multimodal media |",
    "| Bust cause: Unattributed |",
    "| Duplicate identical read_file calls |"
  ]) {
    assert.ok(mdAgg.includes(requiredExistingRow), `Missing preserved Markdown row: ${requiredExistingRow}`);
  }
  assert.ok(mdAgg.includes("### Context Composition"), "Markdown must include Context Composition table when totalEstTokens > 0");
  assert.ok(mdAgg.includes("| File Reads |"));
  assert.ok(mdAgg.includes("| Media (1 item) |"));
  assert.ok(mdAgg.includes("| **Total**"));
  assert.ok(mdAgg.includes("**Subagent Attribution:** 1 delegation(s)"), `Missing Subagent Attribution line in:\n${mdAgg}`);

  // When no subagents exist (sessionA), Subagent Attribution line is omitted
  const mdA = formatCacheDiagMarkdown(diagA);
  assert.ok(mdA.includes("### Context Composition"));
  assert.ok(!mdA.includes("**Subagent Attribution:**"));

  // When totalEstTokens === 0 (usage-only transcript), Context Composition table is omitted
  const usageOnlyDiag = analyzeTranscriptCache(
    [{ type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 5000, cache_read_tokens: 20000 }],
    { nowMs: t0 + 10000 }
  );
  const mdUsageOnly = formatCacheDiagMarkdown(usageOnlyDiag);
  assert.equal(usageOnlyDiag.contextComposition.totalEstTokens, 0);
  assert.ok(!mdUsageOnly.includes("### Context Composition"));

  // Regression: Markdown "Subagent traffic" token figure must use subagentTrafficEstTokens (matching subagentSharePct)
  const delegOnlyDiag = analyzeTranscriptCache(
    [
      { type: "USER_INPUT", step_index: 1, created_at: iso(0), content: "a".repeat(400) },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(5),
        model: "claude-sonnet-4-6",
        input_tokens: 5000,
        cache_read_tokens: 0,
        tool_calls: [{ name: "swarm", args: { action: "add", name: "worker", brief: "b".repeat(800) } }]
      },
      { type: "GENERIC", step_index: 3, content: "ok" }
    ],
    { nowMs: t0 + 10000 }
  );
  assert.ok(
    delegOnlyDiag.subagentBreakdown.subagentTrafficEstTokens > delegOnlyDiag.subagentBreakdown.subagentResultEstTokens,
    "Delegation call payload should make subagentTrafficEstTokens > subagentResultEstTokens"
  );
  const mdDeleg = formatCacheDiagMarkdown(delegOnlyDiag);
  assert.ok(
    mdDeleg.includes(`Subagent traffic: ~${delegOnlyDiag.subagentBreakdown.subagentTrafficEstTokens.toLocaleString("en-US")} est. tokens (${delegOnlyDiag.subagentBreakdown.subagentSharePct.toFixed(1)}% of context)`),
    `Expected Markdown Subagent traffic to reconcile with subagentTrafficEstTokens, got:\n${mdDeleg}`
  );
});

test("P2-9.4: Sidecar /api/cache-diag exposes contextComposition & subagentBreakdown, and index.html passes JS syntax, DOM rendering & XSS checks", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-p29-sidecar-"));
  const fakeHome = path.join(tmpDir, "fake-home");
  const tmpDb = path.join(tmpDir, "context.db");
  const convId = "p29-composition-conv";
  const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const now = Date.now();
  const transcriptSteps = [
    {
      type: "USER_INPUT",
      step_index: 1,
      created_at: new Date(now - 45000).toISOString(),
      content: "Analyze cache composition and spawn a verifier subagent."
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: new Date(now - 35000).toISOString(),
      model: "claude-sonnet-4-6",
      thinking: "Need to inspect cache-analyzer.js and delegate verification.",
      content: "Reading cache-analyzer.js and delegating check.",
      usage: { input_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 36000, output_tokens: 220 },
      tool_calls: [
        { name: "read_file", args: { Path: "context/lib/cache-analyzer.js", StartLine: 1, EndLine: 80 } },
        { name: "invoke_subagent", args: { agent: "verifier", prompt: "Run smoke checks" } }
      ]
    },
    {
      type: "GENERIC",
      step_index: 3,
      content: "export function analyzeTranscriptCache(steps) { return {}; }\n".repeat(30)
    },
    {
      type: "TOOL_RESULT",
      step_index: 4,
      content: "Verifier PASS: all checks green.\n".repeat(12)
    }
  ];
  fs.writeFileSync(
    path.join(logDir, "transcript.jsonl"),
    transcriptSteps.map((s) => JSON.stringify(s)).join("\n") + "\n",
    "utf8"
  );

  const port = 40200 + Math.floor(Math.random() * 400);
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

    // Fetch HTML first to extract injected per-process CSRF token
    const html = await fetchDashboardHtml(`http://127.0.0.1:${port}`);
    const token = html.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");
    const authHeaders = { headers: { "X-Agy-Dart-Token": token } };

    // 1. Live transcript /api/cache-diag exposes contextComposition & subagentBreakdown (cold + cached)
    const kvLive = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)
    ).json();
    assert.equal(kvLive.ok, true);
    assert.equal(kvLive.transcriptFound, true);
    assertNoNaNOrInfinity(kvLive.contextComposition, "kvLive.contextComposition");
    assertNoNaNOrInfinity(kvLive.subagentBreakdown, "kvLive.subagentBreakdown");
    assert.ok(kvLive.contextComposition.totalEstTokens > 0);
    assert.ok(kvLive.contextComposition.fileReads.estTokens > 0);
    assert.equal(kvLive.subagentBreakdown.subagentDelegations, 1);
    assert.equal(kvLive.subagentBreakdown.primaryTurns, 1);
    assert.ok(kvLive.subagentBreakdown.subagentResultEstTokens > 0);

    // Second request hits parsedDiagCache -> must preserve both structures
    const kvCached = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)
    ).json();
    assert.deepEqual(kvCached.contextComposition, kvLive.contextComposition);
    assert.deepEqual(kvCached.subagentBreakdown, kvLive.subagentBreakdown);

    // 2. Missing transcript fallback exposes consistent zeroed defaults
    const kvMissing = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=missing-p29-conv`, authHeaders)
    ).json();
    assert.equal(kvMissing.ok, true);
    assert.equal(kvMissing.transcriptFound, false);
    assert.deepEqual(kvMissing.contextComposition, createEmptyContextComposition());
    assert.deepEqual(kvMissing.subagentBreakdown, createEmptySubagentBreakdown());

    // 3. Dashboard HTML preserves ALL existing DOM IDs, adds P2-9 DOM IDs, and passes new Function + vm.Script
    for (const domId of [
      "kv-cache-card",
      "kv-watermark-badge",
      "kv-temp-badge",
      "kv-ttl-badge",
      "kv-model-badge",
      "kv-cost-savings",
      "kv-loop-badge",
      "kv-ttl-bar-row",
      "kv-handoff-btn",
      "kv-turns-chart-row",
      "kv-bust-causes",
      "kv-composition-row",
      "kv-composition-bar",
      "kv-composition-legend",
      "kv-subagent-badge"
    ]) {
      assert.ok(html.includes(`id="${domId}"`), `Missing DOM ID: ${domId}`);
    }

    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scriptMatches.length >= 1);
    for (const m of scriptMatches) {
      new Function(m[1]);
      new vm.Script(m[1]);
    }

    // 4. Isolated VM DOM rendering & XSS escaping verification
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
        getElementById: (id) => mockElements.get(id) || makeEl(id),
        createElement: () => makeEl("tmp"),
        body: { appendChild: () => {}, removeChild: () => {} },
        execCommand: () => true
      },
      navigator: {},
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

    // 4a. Render live KV payload -> composition bar & legend populated, subagent badge visible
    sandbox.renderKvCacheCard(kvLive);
    const rowEl = mockElements.get("kv-composition-row");
    const barEl = mockElements.get("kv-composition-bar");
    const legendEl = mockElements.get("kv-composition-legend");
    const subBadgeEl = mockElements.get("kv-subagent-badge");
    assert.equal(rowEl.classList.contains("hidden"), false, "Composition row should be visible when totalEstTokens > 0");
    assert.ok(barEl.innerHTML.includes("File Reads:"), "Stacked bar tooltip must show File Reads segment");
    assert.ok(barEl.innerHTML.includes("est. tok"), "Stacked bar tooltip must show exact est. tokens");
    assert.ok(barEl.innerHTML.includes("%"), "Stacked bar tooltip must show percentage");
    assert.ok(legendEl.innerHTML.includes("File Reads"));
    assert.ok(legendEl.innerHTML.includes("Thinking"));
    assert.equal(subBadgeEl.classList.contains("hidden"), false, "Subagent badge should show when subagentDelegations > 0");
    assert.ok(subBadgeEl.textContent.includes("1 subagent"));
    assert.ok(subBadgeEl.title.includes("Delegations: 1"));

    // 4b. Render missing / zero payload -> hides composition row & subagent badge cleanly
    sandbox.renderKvCacheCard(kvMissing);
    assert.equal(rowEl.classList.contains("hidden"), true, "Composition row must hide when totalEstTokens === 0");
    assert.equal(barEl.innerHTML, "");
    assert.equal(legendEl.innerHTML, "");
    assert.equal(subBadgeEl.classList.contains("hidden"), true, "Subagent badge must hide when delegations=0 & turns=0");

    // 4c. Subagent badge shows when subagentTurns > 0 even if subagentDelegations === 0
    sandbox.renderContextComposition(kvLive.contextComposition, {
      ...createEmptySubagentBreakdown(),
      primaryTurns: 1,
      subagentTurns: 2,
      subagentSharePct: 40
    });
    assert.equal(subBadgeEl.classList.contains("hidden"), false);
    assert.ok(subBadgeEl.textContent.includes("2 sub-turns"));

    // 4d. Adversarial XSS payload injection test -> zero unescaped HTML tags or NaN
    sandbox.renderContextComposition(
      {
        user: { bytes: 400, estTokens: 100, pct: '<img src=x onerror="alert(1)">' },
        thinking: { bytes: 0, estTokens: 0, pct: 0 },
        assistant: { bytes: 0, estTokens: 0, pct: 0 },
        toolCalls: { bytes: 0, estTokens: 0, pct: 0 },
        fileReads: { bytes: 0, estTokens: 0, pct: 0 },
        toolResults: { bytes: 0, estTokens: 0, pct: 0 },
        media: { bytes: 0, estTokens: 0, pct: 0, mediaCount: "<script>evil()</script>" },
        mediaCount: "<script>evil()</script>",
        totalBytes: "<script>alert(1)</script>",
        totalEstTokens: 100,
        dominantCategory: '<script>alert("xss")</script>'
      },
      {
        primaryTurns: 1,
        subagentTurns: 1,
        primaryToolCalls: 0,
        subagentToolCalls: 0,
        subagentDelegations: 0,
        subagentResultBytes: 0,
        subagentResultEstTokens: 50,
        subagentSharePct: 50
      }
    );
    assert.ok(!barEl.innerHTML.includes("<script"), "Bar HTML must never contain raw <script");
    assert.ok(!barEl.innerHTML.includes("<img"), "Bar HTML must never contain raw <img");
    assert.ok(!barEl.innerHTML.includes("onerror="), "Bar HTML must never contain unescaped onerror");
    assert.ok(!legendEl.innerHTML.includes("<script"), "Legend HTML must never contain raw <script");
    assert.ok(!mockElements.get("kv-composition-total").title.includes("NaN"), "Total title must never show NaN");
    assert.equal(mockElements.get("kv-composition-label").textContent, "Context Composition");

    // 4e. Regression: bucket.pct null / "" / false must fall back to exactPct (never coerce to 0%),
    // and #kv-subagent-badge title must display subagentTrafficEstTokens matching subagentSharePct
    sandbox.renderContextComposition(
      {
        user: { bytes: 400, estTokens: 100, pct: null },
        thinking: { bytes: 400, estTokens: 100, pct: "" },
        assistant: { bytes: 800, estTokens: 200, pct: false },
        toolCalls: { bytes: 0, estTokens: 0, pct: 0 },
        fileReads: { bytes: 0, estTokens: 0, pct: 0 },
        toolResults: { bytes: 0, estTokens: 0, pct: 0 },
        media: { bytes: 0, estTokens: 0, pct: 0, mediaCount: 0 },
        mediaCount: 0,
        totalBytes: 1600,
        totalEstTokens: 400,
        dominantCategory: "assistant"
      },
      {
        primaryTurns: 2,
        subagentTurns: 0,
        primaryToolCalls: 2,
        subagentToolCalls: 0,
        subagentDelegations: 2,
        subagentResultBytes: 1200,
        subagentResultEstTokens: 304,
        subagentTrafficEstTokens: 1664,
        subagentSharePct: 1.7
      }
    );
    assert.ok(barEl.innerHTML.includes("User: ~100 est. tok (25.0%)"), `null pct must fallback to 25.0%, got: ${barEl.innerHTML}`);
    assert.ok(barEl.innerHTML.includes("Thinking: ~100 est. tok (25.0%)"), `"" pct must fallback to 25.0%, got: ${barEl.innerHTML}`);
    assert.ok(barEl.innerHTML.includes("Assistant: ~200 est. tok (50.0%)"), `false pct must fallback to 50.0%, got: ${barEl.innerHTML}`);
    assert.ok(
      subBadgeEl.title.includes(`Subagent traffic: ~${(1664).toLocaleString()} est. tok (1.7%)`),
      `Subagent badge title must display subagentTrafficEstTokens (1,664), got: ${subBadgeEl.title}`
    );
  } finally {
    await new Promise((resolve) => {
      if (serverProc.exitCode !== null) return resolve();
      const t = setTimeout(resolve, 1000);
      serverProc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      serverProc.kill("SIGTERM");
    });
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  }
});
