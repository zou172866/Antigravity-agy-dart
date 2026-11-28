import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  analyzeTranscriptCache,
  readTranscriptTail
} from "../context/lib/cache-analyzer.js";
import { buildRepoHotspots, getCachedRepoHotspots } from "../context/lib/repo-skeleton.js";
import {
  applyFilterRule,
  matchFilterRule,
  stripAnsiAndProgress
} from "../hooks/filter-rules.mjs";
import { cleanStringArg } from "../hooks/pre-tool-use.mjs";
import { extractInvalidationTargets } from "../hooks/post-tool-use.mjs";
import { assemblePrefixStableStartup } from "../hooks/session-start.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, scriptRel);
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGY_DART_DB_PATH: dbPath, ...extraEnv }
  });
  assert.equal(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test("P0 filter-rules: matches noisy dev commands, blocks unsafe/compound/structured commands, strips ANSI & spinners", () => {
  // Should match
  assert.equal(matchFilterRule("git status")?.rule.id, "git-status");
  assert.equal(matchFilterRule("git diff HEAD~1")?.rule.id, "git-diff");
  const unboundedLog = matchFilterRule("git log");
  assert.equal(unboundedLog?.rule.id, "git-log");
  assert.ok(unboundedLog.effectiveCommand.includes("-n 30"));
  assert.ok(unboundedLog.note);

  const boundedLog = matchFilterRule("git log -n 5");
  assert.equal(boundedLog?.rule.id, "git-log");
  assert.equal(boundedLog.effectiveCommand, "git log -n 5");
  assert.equal(boundedLog.note, null);

  assert.equal(matchFilterRule("npm test")?.rule.id, "test-runner");
  assert.equal(matchFilterRule("node --test tests/a.test.mjs")?.rule.id, "test-runner");
  assert.equal(matchFilterRule("pytest -v")?.rule.id, "test-runner");
  assert.equal(matchFilterRule("cargo test")?.rule.id, "test-runner");
  assert.equal(matchFilterRule("npx tsc --noEmit")?.rule.id, "build-lint");
  assert.equal(matchFilterRule("npm install")?.rule.id, "pkg-install");
  assert.equal(matchFilterRule("docker build .")?.rule.id, "docker-build");

  // MUST NOT match (compound, pipelines, redirects, watch, structured output, recursion)
  assert.equal(matchFilterRule("git status && git diff"), null);
  assert.equal(matchFilterRule("npm test | head -n 20"), null);
  assert.equal(matchFilterRule("pytest > out.txt"), null);
  assert.equal(matchFilterRule("git log; echo hi"), null);
  assert.equal(matchFilterRule("git status --porcelain"), null);
  assert.equal(matchFilterRule("git diff --stat"), null);
  assert.equal(matchFilterRule("vitest --watch"), null);
  assert.equal(matchFilterRule("npm test -- --json"), null);
  assert.equal(matchFilterRule("git log --format=%h"), null);
  assert.equal(matchFilterRule('node "hooks/cli-filter.mjs" --rule git-status --b64 abc'), null);

  // ANSI & carriage-return spinner stripping
  const dirty = "\x1b[32mPASS\x1b[0m\nDownloading 10%\rDownloading 50%\rDownloading 100%\nDone";
  assert.equal(stripAnsiAndProgress(dirty), "PASS\nDownloading 100%\nDone");

  // Repeated identical error lines deduplicated down to a single line
  const repeatedCjk = "错误日志输出测试行\n".repeat(1500);
  const resDedup = applyFilterRule("build-lint", repeatedCjk, "", 1);
  assert.equal(resDedup.wasFiltered, true);
  assert.ok(Buffer.byteLength(resDedup.filteredText, "utf8") < 400);

  // Unique CJK lines trigger UTF-8 safe hard truncation <= 7900 bytes with zero \uFFFD
  const hugeUniqueCjk = Array.from({ length: 1500 }, (_, i) => `第${i}行错误日志输出测试内容`).join("\n");
  const resTrunc = applyFilterRule("build-lint", hugeUniqueCjk, "", 1);
  assert.ok(Buffer.byteLength(resTrunc.filteredText, "utf8") <= 7900);
  assert.ok(!resTrunc.filteredText.includes("\uFFFD"));
  assert.equal(resTrunc.truncated, true);

  // Tiny already-compact test output MUST NOT be inflated
  const tinyOut = "PASS 3 tests in 12ms\n";
  const resTiny = applyFilterRule("test-runner", tinyOut, "", 0);
  assert.equal(resTiny.wasFiltered, false);
  assert.equal(resTiny.filteredText, tinyOut);
});

test("P0 PreToolUse.overwrite + cli-filter.mjs: live transparent filtering preserves exit codes, caps <=8.8KB, and indexes raw output", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-clifilter-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const passTestFile = path.join(tmpDir, "pass.test.mjs");
  const failTestFile = path.join(tmpDir, "fail.test.mjs");

  fs.writeFileSync(
    passTestFile,
    `import test from "node:test";
import assert from "node:assert/strict";
for (let i = 0; i < 60; i++) {
  test("passing case #" + i + " " + "x".repeat(180), () => {
    if (i === 42) console.log("SECRET_HIDDEN_MARKER_42");
    assert.equal(1 + 1, 2);
  });
}\n`
  );

  fs.writeFileSync(
    failTestFile,
    `import test from "node:test";
import assert from "node:assert/strict";
test("ok case", () => { assert.equal(1, 1); });
test("broken case", () => { assert.equal("expected_alpha", "actual_beta"); });\n`
  );

  try {
    // 1. PreToolUse rewrites safe node --test via overwrite (no deny!)
    const hookPass = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "cli-sess-1",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: `node --test "${passTestFile}"` } }
      },
      tmpDb
    );
    assert.equal(hookPass.decision, "allow");
    assert.ok(hookPass.overwrite?.CommandLine?.includes("cli-filter.mjs"));

    // 2. Execute the exact rewritten command through OS shell (strip NODE_TEST_CONTEXT so child node --test prints full output)
    const cleanChildEnv = { ...process.env, AGY_DART_DB_PATH: tmpDb };
    delete cleanChildEnv.NODE_TEST_CONTEXT;
    const runPass = spawnSync(hookPass.overwrite.CommandLine, {
      shell: process.platform === "win32" ? "powershell.exe" : true,
      cwd: tmpDir,
      encoding: "utf8",
      windowsHide: true,
      env: cleanChildEnv
    });
    assert.equal(runPass.status, 0, `Passing filtered cmd failed: ${runPass.stderr}`);
    assert.ok(Buffer.byteLength(runPass.stdout, "utf8") <= 8000);
    assert.ok(runPass.stdout.includes("PASS (exit 0)"));
    assert.ok(runPass.stdout.includes("[agy-dart cli-filter: rule=test-runner"));

    // Verify raw output was indexed in SQLite and is searchable!
    const store = new ContextModeStore({ dbPath: tmpDb });
    const hits = store.search({ queries: ["SECRET_HIDDEN_MARKER_42"], sessionId: "cli-sess-1" });
    assert.ok(hits.hits.length >= 1, "Expected hidden raw test log line to be searchable in FTS5");
    const stats = store.getStats("cli-sess-1");
    assert.ok(stats.breakdown.cliFilters >= 1);
    assert.ok(stats.keptOutBytes > 5000);
    store.close();

    // 3. Failing test MUST preserve non-zero exit code AND failure assertion message
    const hookFail = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "cli-sess-1",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: `node --test "${failTestFile}"` } }
      },
      tmpDb
    );
    assert.equal(hookFail.decision, "allow");
    const runFail = spawnSync(hookFail.overwrite.CommandLine, {
      shell: true,
      cwd: tmpDir,
      encoding: "utf8",
      windowsHide: true,
      env: cleanChildEnv
    });
    assert.notEqual(runFail.status, 0, "Failing test MUST keep non-zero exit code");
    assert.ok(runFail.stdout.includes("expected_alpha") || runFail.stdout.includes("broken case"));

    // 4. IsDaemon: true MUST NOT be rewritten
    const hookDaemon = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "cli-sess-1",
        toolCall: { name: "run_command", args: { CommandLine: "npm test", IsDaemon: true } }
      },
      tmpDb
    );
    assert.equal(hookDaemon.decision, "allow");
    assert.equal(hookDaemon.overwrite, undefined);

    // 5. Disabling CLI filter restores unbounded git log deny
    const hookDisabled = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "cli-sess-1",
        toolCall: { name: "run_command", args: { CommandLine: "git log" } }
      },
      tmpDb,
      { AGY_DART_DISABLE_CLI_FILTER: "1" }
    );
    assert.equal(hookDisabled.decision, "deny");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P0 KV-Cache analyzer: accurately attributes all 6 cache-bust causes without false positives on large appended tool outputs", () => {
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  const iso = (secOffset) => new Date(t0 + secOffset * 1000).toISOString();

  const steps = [
    // Turn 1: cold start (20k)
    { type: "SYSTEM_MESSAGE", content: "startup snapshot" },
    { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(0), model: "model-a", input_tokens: 20000, cache_read_tokens: 0, output_tokens: 300, tool_calls: [{ name: "read_file", args: { Path: "a.js", StartLine: 1, EndLine: 50 } }] },
    // Turn 2: HUGE new tool output (+40k uncached), BUT full 20k prefix HIT -> NOT a bust!
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(10), model: "model-a", input_tokens: 40000, cache_read_tokens: 20000, output_tokens: 200, tool_calls: [{ name: "read_file", args: { Path: "a.js", StartLine: 1, EndLine: 50 } }] },
    // Turn 3: Idle TTL expiry (gap 360s >= 300s), cache dropped to 0
    { type: "PLANNER_RESPONSE", step_index: 3, created_at: iso(370), model: "model-a", input_tokens: 62000, cache_read_tokens: 0, output_tokens: 200 },
    // Turn 4: Model switch (model-a -> model-b), cache dropped to 0
    { type: "PLANNER_RESPONSE", step_index: 4, created_at: iso(385), model: "model-b", input_tokens: 65000, cache_read_tokens: 0, output_tokens: 200 },
    // Turn 5: Compaction (65k -> 18k)
    { type: "PLANNER_RESPONSE", step_index: 5, created_at: iso(400), model: "model-b", input_tokens: 18000, cache_read_tokens: 0, output_tokens: 100 },
    // Turn 6: Warm hit on 18k
    { type: "PLANNER_RESPONSE", step_index: 6, created_at: iso(410), model: "model-b", input_tokens: 4000, cache_read_tokens: 18000, output_tokens: 100 },
    // Turn 7: Mid-session system injection bust
    { type: "SYSTEM_MESSAGE", content: "Mid-session extra instruction" },
    { type: "PLANNER_RESPONSE", step_index: 7, created_at: iso(420), model: "model-b", input_tokens: 23000, cache_read_tokens: 1000, output_tokens: 100 },
    // Turn 8: Multimodal media bust
    { type: "GENERIC", media: [{ mimeType: "image/png" }] },
    { type: "PLANNER_RESPONSE", step_index: 8, created_at: iso(430), model: "model-b", input_tokens: 25000, cache_read_tokens: 2000, output_tokens: 100 },
    // Turn 9: Prefix drift / unexplained eviction
    { type: "PLANNER_RESPONSE", step_index: 9, created_at: iso(440), model: "model-b", input_tokens: 28000, cache_read_tokens: 0, output_tokens: 100 }
  ];

  const diag = analyzeTranscriptCache(steps, { ttlSec: 300, nowMs: t0 + 460 * 1000 });
  assert.equal(diag.turnsWithUsage, 9);
  assert.equal(diag.bustCount, 6);
  assert.equal(diag.bustsByCause.ttl_idle_expiry, 1);
  assert.equal(diag.bustsByCause.model_switch, 1);
  assert.equal(diag.bustsByCause.compaction_or_truncation, 1);
  assert.equal(diag.bustsByCause.system_injection, 1);
  assert.equal(diag.bustsByCause.multimodal_media, 1);
  assert.equal(diag.bustsByCause.prefix_drift, 1);
  assert.equal(diag.duplicateReadCount, 1);
  assert.equal(diag.ttlStatus, "warm");
  assert.equal(diag.ttlRemainingSec, 280);
  assert.ok(diag.wastedTokensTotal > 150000);
});

test("P0 PreInvocation hook + benchmark cache CLI: emits UI-only zero-prefix-pollution alerts once without spam", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-preinv-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const transcriptPath = path.join(tmpDir, "transcript_full.jsonl");
  const oldTime = new Date(Date.now() - 420 * 1000).toISOString(); // 7 min ago (> 5 min TTL)

  const lines = [
    JSON.stringify({ type: "GENERIC", media: [{ mimeType: "image/png" }] }),
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 10,
      created_at: oldTime,
      model: "unknown-custom-model",
      input_tokens: 15000,
      cache_read_tokens: 152000,
      output_tokens: 400
    })
  ];
  // Pad > 150 KB before tail to test readTranscriptTail as well
  const padLine = JSON.stringify({ type: "GENERIC", content: "p".repeat(4000) });
  fs.writeFileSync(transcriptPath, `${Array(45).fill(padLine).join("\n")}\n${lines.join("\n")}\n`);

  try {
    const tailSteps = readTranscriptTail(transcriptPath, 32768);
    assert.ok(tailSteps.some((s) => s.type === "PLANNER_RESPONSE" && s.step_index === 10));

    // First invocation (with opt-in inline alerts) emits UI-only metadata.user_markdown with EMPTY systemMessage (0 model tokens!)
    const r1 = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "inv-sess-1", transcriptPath, invocationNum: 11 },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(r1.injectSteps?.length, 1);
    assert.equal(r1.injectSteps[0].systemMessage.systemMessage, "");
    const md = r1.injectSteps[0].systemMessage.metadata?.user_markdown || "";
    assert.ok(md.includes("critical watermark"));
    assert.ok(md.includes("KV-cache TTL"));
    assert.ok(md.includes("media/image"));

    // Second invocation on unchanged transcript MUST NOT spam (deduplicated)
    const r2 = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "inv-sess-1", transcriptPath, invocationNum: 12 },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(r2.injectSteps, undefined);

    // benchmark.mjs cache CLI works cleanly on the transcript
    const bench = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", transcriptPath, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(bench.status, 0, bench.stderr);
    const parsedBench = JSON.parse(bench.stdout);
    assert.equal(parsedBench.peakContextTokens, 167000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1 Read Dedup (2-strike bypass) + PostToolUse edit/ctx_resume invalidation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-dedup-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const srcFile = path.join(tmpDir, "module.js");
  fs.writeFileSync(srcFile, Array.from({ length: 120 }, (_, i) => `export const v${i} = "${"a".repeat(30)}";`).join("\n"));

  try {
    const minBytesEnv = { AGY_DART_READ_DEDUP_MIN_BYTES: "1024" };

    // 1. First read of lines 1-80 -> allow
    const r1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 1, EndLine: 80 } } },
      tmpDb,
      minBytesEnv
    );
    assert.equal(r1.decision, "allow");

    // 2. Subset unchanged re-read (lines 10-50) -> Strike 1: deny with read-dedup guidance
    const r2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 10, EndLine: 50 } } },
      tmpDb,
      minBytesEnv
    );
    assert.equal(r2.decision, "deny");
    assert.ok(r2.reason.includes("[agy-dart read-dedup]"));

    // 3. Immediate retry on same range -> Strike 2: allow (compaction-safe escape hatch)
    const r3 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 10, EndLine: 50 } } },
      tmpDb,
      minBytesEnv
    );
    assert.equal(r3.decision, "allow");

    // 4. Different non-covered range (81-120) -> allow immediately
    const r4 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 81, EndLine: 120 } } },
      tmpDb
    );
    assert.equal(r4.decision, "allow");

    // 5. PostToolUse edit_file invalidates tracked reads -> immediate allow on 1-80 again!
    const postEdit = runHook(
      "hooks/post-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "edit_file", args: { Path: srcFile } } },
      tmpDb
    );
    assert.deepEqual(postEdit, {});

    const r5 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 1, EndLine: 80 } } },
      tmpDb
    );
    assert.equal(r5.decision, "allow");

    // 6. PostToolUse call_mcp_tool(apply_edits with stringified Arguments) also invalidates
    const postMcp = runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "dedup-s1",
        cwd: tmpDir,
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "agy-dart_fast",
            ToolName: "apply_edits",
            Arguments: JSON.stringify({ cwd: tmpDir, edits: [{ path: "module.js", hunks: [] }] })
          }
        }
      },
      tmpDb
    );
    assert.deepEqual(postMcp, {});

    const r6 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 1, EndLine: 80 } } },
      tmpDb
    );
    assert.equal(r6.decision, "allow");

    // 7. Different conversationId is isolated even when inherited ANTIGRAVITY_CONVERSATION_ID env var is set
    const rOther = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "dedup-s2", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile, StartLine: 1, EndLine: 80 } } },
      tmpDb,
      { ANTIGRAVITY_CONVERSATION_ID: "dedup-s1" }
    );
    assert.equal(rOther.decision, "allow");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1 Heading-aware Markdown chunking + DB TTL pruning/VACUUM + git-HEAD-cached repo hubs + prefix-stable SessionStart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-p1-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });
  const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "p1-sess" });

  try {
    // 1. Heading-aware Markdown chunking (fenced # comments must NOT become headings!)
    const mdDoc = [
      "# Platform Guide",
      "Intro paragraph. " + "overview ".repeat(90),
      "",
      "## Authentication",
      "```python",
      "# NOT_A_HEADING_INSIDE_CODE",
      "def verify_oauth():",
      "    return True",
      "```",
      "OAuth flow details. " + "token ".repeat(110),
      "",
      "### Refresh Tokens",
      "Rotation policy details. " + "rotate ".repeat(110),
      "",
      "## Billing",
      "Invoice calculation details. " + "invoice ".repeat(110)
    ].join("\n");

    const indexed = store.indexContent({
      sessionId: "p1-sess",
      worktree: tmpDir,
      kind: "file",
      label: "guide.md",
      content: mdDoc
    });

    assert.ok(indexed.chunkCount >= 3);
    assert.ok(indexed.chunkTitles.some((t) => t === "guide.md :: Platform Guide > Authentication > Refresh Tokens"));
    assert.ok(indexed.chunkTitles.some((t) => t === "guide.md :: Platform Guide > Billing"));
    assert.ok(!indexed.chunkTitles.some((t) => t.includes("NOT_A_HEADING_INSIDE_CODE")));

    const searchRes = await tools.ctx_search({ queries: ["Billing", "invoice"], sourceId: indexed.sourceId });
    assert.ok(searchRes.hits.length >= 1);
    assert.ok(searchRes.hits[0].title.includes("Billing"));

    // 2. DB TTL pruning + VACUUM via ctx_purge({ scope: "stale", olderThanDays: 7, vacuum: true })
    const oldTs = Date.now() - 20 * 24 * 3600 * 1000;
    const oldIso = new Date(oldTs).toISOString();
    store.db.prepare(
      "INSERT INTO sources (id, session_id, worktree, agent, kind, label, bytes_total, chunk_count, created_ts, created_at, accessed_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("s_ancient", "old-sess", tmpDir, "antigravity", "file", "ancient.log", 1000, 0, oldTs, oldIso, oldTs);

    const purgeRes = await tools.ctx_purge({ scope: "stale", olderThanDays: 7, vacuum: true });
    assert.equal(purgeRes.ok, true);
    assert.equal(purgeRes.deletedSources, 1);
    assert.equal(purgeRes.vacuumed, true);

    const doc = await tools.ctx_doctor();
    assert.equal(doc.doctor.schemaVersion, "3");
    assert.equal(doc.doctor.totalSources, 1); // fresh guide.md preserved, ancient.log pruned!
    assert.ok(doc.doctor.lastMaintenanceAt);

    // 3. Repo hotspots scanner + SQLite cache
    const hubs = buildRepoHotspots(ROOT);
    assert.ok(hubs.fileCount >= 5);
    assert.ok(hubs.hubs.some((h) => h.path === "context/lib/store.js"));
    const cachedHub1 = getCachedRepoHotspots(ROOT, store, { headSha: "deadbeef1234" });
    const cachedHub2 = getCachedRepoHotspots(ROOT, store, { headSha: "deadbeef1234" });
    assert.equal(cachedHub1, cachedHub2);
    assert.ok(cachedHub1.includes("context/lib/store.js"));

    // 4. Prefix-stable SessionStart ordering (Static note -> Project -> Layout -> Hubs -> Volatile Git)
    const sampleSnapshot = [
      "[agy-dart startup snapshot] Workspace: /repo",
      "Git: branch `main`",
      "Modified (2): a.js, b.js",
      "Project:",
      "  - package.json (demo)",
      "Layout (2 levels):",
      "  src/ (index.js)"
    ].join("\n");
    const assembled = assemblePrefixStableStartup(sampleSnapshot, "Core hubs (5 src files): src/core.js (3)");
    const idxStatic = assembled.indexOf("agy-dart active:");
    const idxProject = assembled.indexOf("Project:");
    const idxLayout = assembled.indexOf("Layout (2 levels):");
    const idxHubs = assembled.indexOf("Core hubs");
    const idxGit = assembled.indexOf("Git: branch");
    assert.ok(idxStatic < idxProject && idxProject < idxLayout && idxLayout < idxHubs && idxHubs < idxGit);
    assert.ok(assembled.includes("[agy-dart startup snapshot] Workspace: /repo"));

    // Backward-compatibility: legacy [agy-fast startup snapshot] headers still assemble in prefix-stable order
    const legacyAssembled = assemblePrefixStableStartup(
      sampleSnapshot.replace("[agy-dart startup snapshot]", "[agy-fast startup snapshot]"),
      "Core hubs (5 src files): src/core.js (3)"
    );
    assert.ok(legacyAssembled.includes("[agy-fast startup snapshot] Workspace: /repo"));
    assert.ok(legacyAssembled.indexOf("Project:") < legacyAssembled.indexOf("Git: branch"));

    // Real SessionStart hook deterministic check (2 runs byte-identical)
    const ss1 = runHook("hooks/session-start.mjs", { cwd: ROOT, workspacePaths: [ROOT], hookEventName: "SessionStart" }, tmpDb);
    const ss2 = runHook("hooks/session-start.mjs", { cwd: ROOT, workspacePaths: [ROOT], hookEventName: "SessionStart" }, tmpDb);
    assert.equal(ss1.injectSteps[0].systemMessage.systemMessage, ss2.injectSteps[0].systemMessage.systemMessage);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Sidecar standalone HTTP server exposes /api/cache-diag, /api/cli-filter, /api/read-dedup, and /api/maintenance", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sidecar-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const port = 18700 + Math.floor(Math.random() * 900);

  const child = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      AGY_DART_DB_PATH: tmpDb,
      ANTIGRAVITY_LS_ADDRESS: "",
      ANTIGRAVITY_CSRF_TOKEN: "",
      ANTIGRAVITY_SIDECAR_WEB_PORT: ""
    }
  });

  const waitReady = () =>
    new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("Sidecar startup timeout")), 5000);
      child.stdout.on("data", (d) => {
        out += d.toString("utf8");
        if (out.includes("listening at")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited early: ${code}`));
      });
    });

  const httpJson = (urlPath, method = "GET", bodyObj = null, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const payload = bodyObj !== null ? JSON.stringify(bodyObj) : null;
      const headers = { ...extraHeaders };
      if (payload !== null) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload, "utf8");
      }
      const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      if (payload !== null) req.write(payload);
      req.end();
    });

  try {
    await waitReady();
    const html = await httpJson("/");
    assert.equal(html.status, 200);
    assert.ok(html.body.includes("KV-Cache &amp; Context Watermark"));
    const tokenMatch = html.body.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i);
    assert.ok(tokenMatch && tokenMatch[1], "Sidecar HTML must inject per-process CSRF token meta tag");
    const csrfHeaders = { "X-Agy-Dart-Token": tokenMatch[1] };

    // Unauthenticated / GET mutation attempts must be rejected
    assert.equal((await httpJson("/api/purge?scope=all", "GET")).status, 405);
    assert.equal((await httpJson("/api/cli-filter", "POST", { enabled: false })).status, 403);
    assert.equal((await httpJson("/api/stats", "GET")).status, 403);

    const stats = JSON.parse((await httpJson("/api/stats", "GET", null, csrfHeaders)).body);
    assert.equal(stats.cliFilterEnabled, true);
    assert.equal(stats.readDedupEnabled, true);

    const toggled = JSON.parse((await httpJson("/api/cli-filter", "POST", { enabled: false }, csrfHeaders)).body);
    assert.equal(toggled.cliFilterEnabled, false);

    const dedupToggled = JSON.parse((await httpJson("/api/read-dedup", "POST", { enabled: false }, csrfHeaders)).body);
    assert.equal(dedupToggled.readDedupEnabled, false);

    const kv = JSON.parse((await httpJson("/api/cache-diag", "GET", null, csrfHeaders)).body);
    assert.equal(kv.ok, true);

    // Brand-new specific conversation MUST NOT leak another conversation's transcript
    const kvNew = JSON.parse(
      (await httpJson("/api/cache-diag?scope=conversation&conversationId=brand-new-nonexistent-conv-xyz", "GET", null, csrfHeaders)).body
    );
    assert.equal(kvNew.ok, true);
    assert.equal(kvNew.transcriptFound, false);

    // Empty maxAgeDays MUST NOT wipe fresh indexed sources
    const seedStore = new ContextModeStore({ dbPath: tmpDb });
    seedStore.indexContent({ sessionId: "sidecar-keep", worktree: tmpDir, kind: "file", label: "keep.txt", content: "keep me alive" });
    seedStore.close();
    const maintEmpty = JSON.parse((await httpJson("/api/maintenance", "POST", { action: "vacuum", maxAgeDays: "" }, csrfHeaders)).body);
    assert.equal(maintEmpty.ok, true);
    assert.equal(maintEmpty.deletedSources, 0);

    const maint = JSON.parse((await httpJson("/api/maintenance", "POST", { action: "vacuum", maxAgeDays: 14 }, csrfHeaders)).body);
    assert.equal(maint.ok, true);
    assert.equal(maint.vacuumed, true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("End-to-end real git repo CLI filtering (git status/diff/unbounded log) + installer mode switch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-git-e2e-"));
  const repoDir = path.join(tmpDir, "repo");
  const tmpDb = path.join(tmpDir, "context.db");
  const installDir = path.join(tmpDir, "installed");
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (args) => {
    const r = spawnSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com"
      }
    });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };

  try {
    git(["init"]);
    const dataFile = path.join(repoDir, "big.txt");
    fs.writeFileSync(dataFile, Array.from({ length: 400 }, (_, i) => `original line ${i} ${"z".repeat(40)}`).join("\n"));
    git(["add", "."]);
    git(["commit", "-m", "initial commit"]);

    // Modify 300 lines to create a >25 KB git diff
    fs.writeFileSync(dataFile, Array.from({ length: 400 }, (_, i) => `updated line ${i} ${"w".repeat(40)}`).join("\n"));

    // 1. PreToolUse rewrites git diff -> compact <= 8000 B with file summary
    const hDiff = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "git-e2e", cwd: repoDir, toolCall: { name: "run_command", args: { CommandLine: "git diff" } } },
      tmpDb
    );
    assert.equal(hDiff.decision, "allow");
    assert.ok(hDiff.overwrite?.CommandLine?.includes("cli-filter.mjs"));

    const rDiff = spawnSync(hDiff.overwrite.CommandLine, {
      shell: true,
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(rDiff.status, 0, rDiff.stderr);
    assert.ok(Buffer.byteLength(rDiff.stdout, "utf8") <= 8000);
    assert.ok(rDiff.stdout.includes("Files changed: 1"));
    assert.ok(rDiff.stdout.includes("big.txt"));

    // 2. Unbounded git log rewritten with -n 30 bound and succeeds in 1 turn
    const hLog = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "git-e2e", cwd: repoDir, toolCall: { name: "run_command", args: { CommandLine: "git log" } } },
      tmpDb
    );
    assert.equal(hLog.decision, "allow");
    const rLog = spawnSync(hLog.overwrite.CommandLine, {
      shell: true,
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(rLog.status, 0, rLog.stderr);
    assert.ok(rLog.stdout.includes("initial commit"));
    assert.ok(rLog.stdout.includes("bounded unbounded git log to -n 30"));

    // 3. Installer install + mode no-read-hook preserves PostToolUse & PreInvocation
    const ins = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--mode", "balanced-16k"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(ins.status, 0, `${ins.stdout}\n${ins.stderr}`);
    assert.ok(ins.stdout.includes("PostToolUse   : OK"));
    assert.ok(ins.stdout.includes("PreInvocation : OK"));
    assert.ok(fs.existsSync(path.join(installDir, "hooks", "cli-filter.mjs")));
    assert.ok(fs.existsSync(path.join(installDir, "context", "lib", "cache-analyzer.js")));

    const sw = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "mode", "no-read-hook", "--target", installDir],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(sw.status, 0, `${sw.stdout}\n${sw.stderr}`);
    const hooksAfter = JSON.parse(fs.readFileSync(path.join(installDir, "hooks.json"), "utf8"));
    assert.equal(hooksAfter["agy-dart-lifecycle"].PreToolUse[0].matcher, "run_command");
    assert.ok(Array.isArray(hooksAfter["agy-dart-lifecycle"].PostToolUse));
    assert.ok(Array.isArray(hooksAfter["agy-dart-lifecycle"].PreInvocation));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Hardening regressions: CLI filter edge cases (git log -p, git diff HEAD^ & quoted paths, unborn repo, fail tail preservation, cleanStringArg)", () => {
  // 1. git log -p / --patch / --graph MUST NOT be stripped by filterGitLog
  assert.equal(matchFilterRule("git log -n 5 -p"), null);
  assert.equal(matchFilterRule("git log -n 5 --patch"), null);
  assert.equal(matchFilterRule("git log -n 5 --graph"), null);
  // Subshell parens rejected
  assert.equal(matchFilterRule("git status $(whoami)"), null);
  assert.equal(matchFilterRule("(git status)"), null);

  // 2. cleanStringArg must NOT corrupt valid quoted command strings
  assert.equal(cleanStringArg('"C:\\Program Files\\node.exe" --test "a.test.mjs"'), '"C:\\Program Files\\node.exe" --test "a.test.mjs"');
  assert.equal(cleanStringArg('"single-wrapped-path.txt"'), "single-wrapped-path.txt");

  // 3. Failing test runner preserves BOTH head & tail assertions/summary strictly <= 7900 B
  const noisyHead = Array.from({ length: 220 }, (_, i) => `WARN step ${i}: 中文日志 ${"x".repeat(55)}`).join("\n");
  const tailFailure = "\nFAIL tests/auth.test.mjs\nAssertionError: EXPECTED_FINAL_ROOT_CAUSE_TOKEN !== actual\nTests: 1 failed, 50 passed\n";
  const failOut = applyFilterRule("test-runner", noisyHead + tailFailure, "", 1);
  assert.ok(Buffer.byteLength(failOut.filteredText, "utf8") <= 7900);
  assert.ok(!failOut.filteredText.includes("\uFFFD"));
  assert.ok(failOut.filteredText.includes("EXPECTED_FINAL_ROOT_CAUSE_TOKEN"), "Tail failure summary must be preserved");
  assert.ok(failOut.filteredText.includes("WARN step 0"), "Head context should be preserved");

  // 4. git diff preserves quoted/spaced filenames and new/deleted file mode
  const rawDiff = [
    'diff --git "a/dir/my file.txt" "b/dir/my file.txt"',
    "new file mode 100644",
    "index 0000000..1234567",
    "--- /dev/null",
    '+++ "b/dir/my file.txt"',
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    ...Array.from({ length: 200 }, (_, i) => `+line ${i}`)
  ].join("\n");
  const diffOut = applyFilterRule("git-diff", rawDiff, "", 0);
  assert.ok(diffOut.filteredText.includes("dir/my file.txt (+202 / -0)"));
  assert.ok(!diffOut.filteredText.includes('"a/dir/my file.txt"'));
  assert.ok(diffOut.filteredText.includes("new file mode 100644"));

  // 5. Real git repo: git diff HEAD^ (Windows caret test!) and unborn repo git log (exit 128)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-git-hard-"));
  const repoDir = path.join(tmpDir, "repo");
  const unbornDir = path.join(tmpDir, "unborn");
  const tmpDb = path.join(tmpDir, "context.db");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(unbornDir, { recursive: true });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com"
  };
  const gitIn = (dir, args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, env: gitEnv });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };

  try {
    gitIn(repoDir, ["init"]);
    fs.writeFileSync(path.join(repoDir, "a.txt"), "v1\n");
    gitIn(repoDir, ["add", "."]);
    gitIn(repoDir, ["commit", "-m", "first"]);
    fs.writeFileSync(path.join(repoDir, "a.txt"), "v2_unique_marker\n");
    gitIn(repoDir, ["add", "."]);
    gitIn(repoDir, ["commit", "-m", "second"]);

    const hCaret = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "git-caret", cwd: repoDir, toolCall: { name: "run_command", args: { CommandLine: "git diff HEAD^" } } },
      tmpDb
    );
    assert.equal(hCaret.decision, "allow");
    assert.ok(hCaret.overwrite?.CommandLine?.includes("cli-filter.mjs"));
    const rCaret = spawnSync(hCaret.overwrite.CommandLine, {
      shell: process.platform === "win32" ? "powershell.exe" : true,
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(rCaret.status, 0, rCaret.stderr);
    assert.ok(rCaret.stdout.includes("v2_unique_marker"), `Expected diff output for HEAD^, got: ${rCaret.stdout}`);

    // Unborn repo git log MUST preserve exit 128 without crashing
    gitIn(unbornDir, ["init"]);
    const hUnborn = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "git-unborn", cwd: unbornDir, toolCall: { name: "run_command", args: { CommandLine: "git log" } } },
      tmpDb
    );
    const rUnborn = spawnSync(hUnborn.overwrite.CommandLine, {
      shell: true,
      cwd: unbornDir,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(rUnborn.status, 128);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Hardening regressions: Read Dedup superset/2-row bypass, view_file AbsolutePath, PostToolUse relative cwd & direct MCP, parallel WAL", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-dedup-hard-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const subDir = path.join(tmpDir, "packages", "api");
  fs.mkdirSync(subDir, { recursive: true });
  const bigFile = path.join(tmpDir, "big.log");
  const modFile = path.join(subDir, "index.js");
  fs.writeFileSync(bigFile, "x".repeat(25000));
  fs.writeFileSync(modFile, Array.from({ length: 120 }, (_, i) => `export const x${i} = "${"a".repeat(25)}";`).join("\n"));

  try {
    // 1. view_file with AbsolutePath is guarded (>16KB denied)
    const rView = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "hard-1", cwd: tmpDir, toolCall: { name: "view_file", args: { AbsolutePath: bigFile } } },
      tmpDb
    );
    assert.equal(rView.decision, "deny");

    // 2. Directory path is safely allowed (no stat error or dedup pollution)
    const rDir = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "hard-1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: subDir } } },
      tmpDb
    );
    assert.equal(rDir.decision, "allow");

    // 3. Superset (1..-1) -> Subset (10..50) Strike 1 deny -> Strike 2 allow -> 3rd read of (1..-1) MUST deny again (no permanent bypass leak!)
    const s = new ContextModeStore({ dbPath: tmpDb });
    s.recordFileRead({ sessionId: "hard-s", filePath: modFile, startLine: 1, endLine: null, mtimeMs: 1000, fileSize: 5000 });
    const d1 = s.findDuplicateRead({ sessionId: "hard-s", filePath: modFile, startLine: 10, endLine: 50, mtimeMs: 1000, fileSize: 5000 });
    assert.equal(Number(d1.bypass_armed), 0);
    s.armReadBypass({ sessionId: "hard-s", filePath: modFile, startLine: d1.start_line, endLine: d1.end_line });
    s.recordFileRead({ sessionId: "hard-s", filePath: modFile, startLine: 10, endLine: 50, mtimeMs: 1000, fileSize: 5000 });
    const d3 = s.findDuplicateRead({ sessionId: "hard-s", filePath: modFile, startLine: 1, endLine: null, mtimeMs: 1000, fileSize: 5000 });
    assert.equal(Number(d3.bypass_armed), 0, "Superset row must reset bypass_armed=0 after bypass is consumed");

    // 4. Two covering rows: armed (10..50) MUST NOT be shadowed by unarmed (1..-1)
    s.armReadBypass({ sessionId: "hard-s", filePath: modFile, startLine: 10, endLine: 50 });
    const dTwo = s.findDuplicateRead({ sessionId: "hard-s", filePath: modFile, startLine: 10, endLine: 50, mtimeMs: 1000, fileSize: 5000 });
    assert.equal(Number(dTwo.bypass_armed), 1, "Armed covering row must take precedence on strike 2");
    s.close();

    // 5. PostToolUse resolves relative apply_edits.cwd against workspace cwd & handles direct MCP tool names
    const tRel = extractInvalidationTargets(
      "call_mcp_tool",
      { ToolName: "apply_edits", Arguments: { cwd: "packages/api", edits: [{ path: "index.js" }] } },
      tmpDir
    );
    assert.equal(tRel.paths[0], path.resolve(tmpDir, "packages", "api", "index.js"));
    const tDirect = extractInvalidationTargets(
      "mcp_agy-dart_fast_apply_edits",
      { cwd: "packages/api", edits: [{ path: "index.js" }] },
      tmpDir
    );
    assert.equal(tDirect.paths[0], path.resolve(tmpDir, "packages", "api", "index.js"));
    const tDirectResume = extractInvalidationTargets("mcp_agy-dart_context_ctx_resume", {}, tmpDir);
    assert.equal(tDirectResume.clearAllSession, true);

    // 6. Parallel 6 concurrent PreToolUse hooks on same SQLite WAL DB
    const parallelFiles = Array.from({ length: 6 }, (_, i) => {
      const p = path.join(tmpDir, `p${i}.js`);
      fs.writeFileSync(p, `export const v = "${"k".repeat(2000)}";\n`);
      return p;
    });
    const parallelRes = await Promise.all(
      parallelFiles.map(
        (p) =>
          new Promise((resolve) => {
            const ch = spawn(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
              windowsHide: true,
              env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
            });
            let out = "";
            ch.stdout.on("data", (d) => (out += d));
            ch.on("close", (code) => resolve({ code, parsed: JSON.parse(out.trim()) }));
            ch.stdin.end(JSON.stringify({ conversationId: "par-1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: p } } }));
          })
      )
    );
    assert.ok(parallelRes.every((r) => r.code === 0 && r.parsed.decision === "allow"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Hardening regressions: Store lifetime toggles, pruneByTtl empty string safety, ctx_search CJK <=8.8KB, Markdown chunker, repo-skeleton, cache-analyzer, Sidecar JS & exactOnly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-store-hard-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });
  const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "cjk-s" });

  try {
    // 1. Lifetime toggle reads global & clears stale app/default overrides
    store.setCliFilterEnabled(false, "app");
    store.setCliFilterEnabled(true, "lifetime");
    assert.equal(store.isCliFilterEnabled("lifetime"), true);
    assert.equal(store.isCliFilterEnabled("app"), true);
    store.setReadDedupEnabled(false, "app");
    store.setReadDedupEnabled(true, "lifetime");
    assert.equal(store.isReadDedupEnabled("lifetime"), true);
    assert.equal(store.isReadDedupEnabled("app"), true);

    // 2. pruneByTtl with "" or null defaults to 14d (MUST NOT wipe fresh sources!) & cleans stale timed meta
    const idx = store.indexContent({
      sessionId: "cjk-s",
      worktree: tmpDir,
      kind: "file",
      label: "cjk.txt",
      content: Array.from({ length: 12 }, (_, i) => `章节${i} 测试关键词 ` + "中文内容测试段落".repeat(160)).join("\n\n")
    });
    store.setMeta("cache_alert:ancient-session:watermark", JSON.stringify({ v: "warn", ts: Date.now() - 30 * 24 * 3600 * 1000 }));
    const safePrune1 = store.pruneByTtl({ maxAgeDays: "" });
    const safePrune2 = store.pruneByTtl({ maxAgeDays: null });
    assert.equal(safePrune1.deletedSources, 0);
    assert.equal(safePrune2.deletedSources, 0);
    assert.equal(store.getMeta("cache_alert:ancient-session:watermark"), null);

    // 3. ctx_search on CJK content MUST stay strictly <= 8800 UTF-8 bytes
    const searchRes = await tools.ctx_search({ queries: ["测试关键词"], sourceId: idx.sourceId, limit: 10 });
    const searchBytes = Buffer.byteLength(JSON.stringify(searchRes, null, 2), "utf8");
    assert.ok(searchBytes <= 8800, `Expected ctx_search <= 8800 B, got ${searchBytes} B`);
    assert.ok(searchRes.hits.length >= 1);

    // 4. Markdown chunker: inline ```code``` does not poison fences, blank lines in fences never split fence, sibling headings keep titles
    const mdInline = "# Doc\n```inline_token``` is a macro.\n" + "filler ".repeat(100) + "\n## Real Heading After Inline\nContent here.\n";
    const c1 = store.chunkContentDetailed(mdInline, 4096, { label: "a.md", isMarkdown: true });
    assert.ok(c1.some((c) => c.title.includes("Real Heading After Inline")));

    const mdFence = "# Guide\n" + "intro ".repeat(350) + "\n```js\nfunction a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n```\n" + "after ".repeat(350);
    const c2 = store.chunkContentDetailed(mdFence, 2500, { label: "b.md", isMarkdown: true });
    assert.ok(!c2.some((c) => (c.body.match(/^```/gm) || []).length % 2 === 1), "Fenced code block must not be split on inner blank line");

    const mdSibling = "## Alpha\nShort alpha note.\n\n## Beta\n" + "Beta details ".repeat(80);
    const c3 = store.chunkContentDetailed(mdSibling, 4096, { label: "c.md", isMarkdown: true });
    assert.ok(c3.some((c) => c.title.includes("Alpha")), "Short sibling section must keep its own heading title");
    assert.ok(c3.some((c) => c.title.includes("Beta")));

    // 5. repo-skeleton ignores comments/strings & resolves Rust mod.rs
    const repoDir = path.join(tmpDir, "fake-repo");
    fs.mkdirSync(path.join(repoDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "target.js"), "export const x = 1;\n");
    fs.writeFileSync(path.join(repoDir, "b.js"), "export const y = 2;\n");
    fs.writeFileSync(path.join(repoDir, "fake.js"), `// import instructions\nconst s = "read from './target.js'";\nexport function demo() { return "from './target.js'"; }\n`);
    fs.writeFileSync(path.join(repoDir, "main.rs"), "pub mod sub;\n");
    fs.writeFileSync(path.join(repoDir, "sub", "mod.rs"), "pub fn hi() {}\n");
    const hubs = buildRepoHotspots(repoDir);
    assert.ok(!hubs.hubs.some((h) => h.path === "target.js"), "Comment/string must not register as JS import");
    assert.ok(hubs.hubs.some((h) => h.path === "sub/mod.rs"), "Rust mod sub; must resolve sub/mod.rs");

    // 6. readTranscriptTail widens past oversized last line; cache-analyzer invalidates on apply_edits & normalizes slashes
    const bigTrans = path.join(tmpDir, "big.jsonl");
    const step1 = JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 1, input_tokens: 10000, cache_read_tokens: 0, created_at: new Date().toISOString() });
    const hugeStep = JSON.stringify({ type: "GENERIC", content: "A".repeat(160000) });
    fs.writeFileSync(bigTrans, `${step1}\n${hugeStep}\n`);
    const tail = readTranscriptTail(bigTrans, 131072);
    assert.ok(tail.some((st) => st.type === "PLANNER_RESPONSE" && st.step_index === 1));

    const editSteps = [
      { type: "PLANNER_RESPONSE", step_index: 1, input_tokens: 10000, cache_read_tokens: 0, created_at: "2026-11-20T10:00:00Z", tool_calls: [{ name: "read_file", args: { Path: "e:\\work\\foo.js", StartLine: 1, EndLine: 50 } }] },
      { type: "PLANNER_RESPONSE", step_index: 2, input_tokens: 2000, cache_read_tokens: 10000, created_at: "2026-11-20T10:00:05Z", tool_calls: [{ name: "call_mcp_tool", args: { ServerName: "agy-dart_fast", ToolName: "apply_edits", Arguments: { cwd: "e:/work", edits: [{ path: "foo.js" }] } } }] },
      { type: "PLANNER_RESPONSE", step_index: 3, input_tokens: 2000, cache_read_tokens: 12000, created_at: "2026-11-20T10:00:10Z", tool_calls: [{ name: "read_file", args: { Path: "e:/work/foo.js", StartLine: 1, EndLine: 50 } }] },
      { type: "PLANNER_RESPONSE", step_index: 4, input_tokens: 2000, cache_read_tokens: 14000, created_at: "2026-11-20T10:00:15Z", tool_calls: [{ name: "view_file", args: { AbsolutePath: "e:\\work\\foo.js", StartLine: 1, EndLine: 50 } }] }
    ];
    const editDiag = analyzeTranscriptCache(editSteps);
    assert.equal(editDiag.duplicateReadCount, 1, "Read after apply_edits is fresh (0 dup), then cross-slash view_file is 1 dup");

    // 7. Sidecar dashboard inline <script> parses cleanly as valid JS and escapes HTML
    const html = readDashboardHtml();
    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scriptMatches.length >= 1);
    for (const m of scriptMatches) {
      new vm.Script(m[1]); // Throws SyntaxError if any JS syntax mistake exists
    }
    assert.ok(html.includes("function escapeHtml("));
    assert.ok(html.includes("inspectSourceEl(this)"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
