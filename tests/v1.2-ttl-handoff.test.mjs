import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import { analyzeTranscriptCache } from "../context/lib/cache-analyzer.js";
import {
  buildHandoffBrief,
  inferWorkspaceFromStore,
  truncateUtf8Safe
} from "../context/lib/handoff.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { fetchDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "test@example.com"
};

function runGit(dir, args) {
  const res = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    env: GIT_ENV
  });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, scriptRel)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("P1-7.1: buildHandoffBrief gathers git branch, diff --stat, checkpoint, FTS5 handles, cacheDiag & redacts secrets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-handoff-git-"));
  const repoDir = path.join(tmpDir, "repo");
  const tmpDb = path.join(tmpDir, "context.db");
  fs.mkdirSync(repoDir, { recursive: true });

  const store = new ContextModeStore({ dbPath: tmpDb });
  const sid = "handoff-git-sess";

  try {
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["checkout", "-b", "feat/ttl-handoff"]);
    fs.writeFileSync(path.join(repoDir, "app.js"), "export const v = 1;\n", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "init"]);

    // Modify tracked file + stage a new file so git diff --stat HEAD reports both
    fs.writeFileSync(path.join(repoDir, "app.js"), "export const v = 2;\nexport const ok = true;\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "helper.js"), "export function help() { return 42; }\n", "utf8");
    runGit(repoDir, ["add", "helper.js"]);

    // Seed structured checkpoint + FTS5 source
    store.recordModifiedFiles(sid, [path.join(repoDir, "app.js"), path.join(repoDir, "helper.js")], {
      worktree: repoDir,
      tool: "apply_edits"
    });
    store.recordVerificationResult(sid, {
      kind: "test",
      command: "npm test",
      exitCode: 0,
      passed: true,
      summary: "42 passed, 0 failed (leak=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234)"
    });
    store.recordVerificationResult(sid, {
      kind: "build",
      command: "npm run build",
      exitCode: 0,
      passed: true,
      summary: "dist bundle compiled cleanly"
    });
    const indexed = store.indexContent({
      sessionId: sid,
      worktree: repoDir,
      kind: "file",
      label: "logs/benchmark-report.md",
      content: "# Benchmark\n" + "metrics row data payload\n".repeat(40)
    });

    const cacheDiag = {
      turnsWithUsage: 6,
      currentModel: "claude-sonnet-4-6",
      currentContextTokens: 145000,
      modelProfile: { id: "claude-200k", windowTokens: 200000 },
      cacheTemperature: "cold",
      compactAdvice: "opportunistic_cold_compact",
      weightedHitRate: 0.884,
      estimatedSavedUsd: 0.42,
      ttlStatus: "expired",
      ttlRemainingSec: 0,
      cacheTtlSec: 300
    };

    const brief = buildHandoffBrief({ store, sessionId: sid, cwd: repoDir, cacheDiag });
    assert.equal(brief.truncated, false);
    assert.equal(brief.bytes, Buffer.byteLength(brief.markdown, "utf8"));
    assert.ok(brief.bytes <= 5800);

    // Git branch + diff --stat
    assert.ok(brief.markdown.includes("feat/ttl-handoff"), `Missing branch in brief:\n${brief.markdown}`);
    assert.ok(brief.markdown.includes("## Git Diff Stat"));
    assert.ok(brief.markdown.includes("app.js"));
    assert.ok(brief.markdown.includes("helper.js"));

    // Structured checkpoint
    assert.ok(brief.markdown.includes("## Session Checkpoint"));
    assert.ok(brief.markdown.includes("Modified Files (2)"));
    assert.ok(brief.markdown.includes("Last Test**: PASS (exit 0) `npm test`"));
    assert.ok(brief.markdown.includes("Last Build**: PASS (exit 0) `npm run build`"));
    // Secret redaction
    assert.ok(!brief.markdown.includes("ghp_1234567890"), "GitHub token must be redacted from handoff brief");
    assert.ok(brief.markdown.includes("[REDACTED:GITHUB_TOKEN]"));

    // FTS5 source handles
    assert.ok(brief.markdown.includes(indexed.sourceId));
    assert.ok(brief.markdown.includes("logs/benchmark-report.md"));

    // Live KV-cache snapshot
    assert.ok(brief.markdown.includes("## KV-Cache Snapshot"));
    assert.ok(brief.markdown.includes("claude-sonnet-4-6"));
    assert.ok(brief.markdown.includes("145k / 200k"));
    assert.ok(brief.markdown.includes("COLD"));
    assert.ok(brief.markdown.includes("opportunistic_cold_compact"));
    assert.ok(brief.markdown.includes("88.4%"));
    assert.ok(brief.markdown.includes("$0.42"));

    // Actionable next-step instruction
    assert.ok(brief.markdown.includes("Call ctx_resume({}) after /compact or paste this brief into a fresh session"));
    assert.ok(brief.summary.includes("branch=feat/ttl-handoff"));
    assert.ok(brief.summary.includes("2 modified"));

    // Workspace inference from store checkpoint works
    assert.equal(inferWorkspaceFromStore(store, sid), path.resolve(repoDir));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-7.2: buildHandoffBrief non-git / missing cwd fail-open + strict CJK & emoji <= maxBytes UTF-8 cap", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-handoff-cjk-"));
  const nonGitDir = path.join(tmpDir, "plain-folder");
  const tmpDb = path.join(tmpDir, "context.db");
  fs.mkdirSync(nonGitDir, { recursive: true });

  const store = new ContextModeStore({ dbPath: tmpDb });
  const sid = "handoff-cjk-sess";

  try {
    // 1. Direct truncateUtf8Safe boundary checks (3-byte CJK + 4-byte emoji)
    const sampleCjk = "中文测试🚀结束";
    for (let limit = 0; limit <= Buffer.byteLength(sampleCjk, "utf8") + 2; limit++) {
      const cut = truncateUtf8Safe(sampleCjk, limit);
      assert.ok(Buffer.byteLength(cut, "utf8") <= limit, `Exceeded limit ${limit}`);
      assert.ok(!cut.includes("\uFFFD"), `Broken UTF-8 at limit ${limit}`);
      assert.equal(hasLoneSurrogate(cut), false, `Lone surrogate at limit ${limit}`);
      assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);
    }

    // 2. Non-git dir & nonexistent cwd fail open cleanly without throwing
    const nonGitBrief = buildHandoffBrief({ store, sessionId: sid, cwd: nonGitDir });
    assert.equal(nonGitBrief.truncated, false);
    assert.ok(!nonGitBrief.markdown.includes("## Git Diff Stat"));
    assert.ok(!nonGitBrief.markdown.includes("Git Branch"));
    assert.ok(nonGitBrief.markdown.includes("Call ctx_resume({}) after /compact"));

    const missingBrief = buildHandoffBrief({
      store,
      sessionId: sid,
      cwd: path.join(tmpDir, "does-not-exist-xyz")
    });
    assert.equal(missingBrief.truncated, false);
    assert.ok(missingBrief.bytes <= 5800);

    // 3. Heavy CJK & emoji content strictly obeys <= maxBytes across tight caps
    const cjkFiles = Array.from({ length: 12 }, (_, i) => `模块/子目录/核心处理_${i}_中文路径🚀.ts`);
    store.recordModifiedFiles(sid, cjkFiles, { worktree: nonGitDir, tool: "edit_file" });
    store.recordVerificationResult(sid, {
      kind: "test",
      command: "node --test 测试套件_中文命令.test.mjs",
      exitCode: 1,
      passed: false,
      summary: "断言失败：期望返回中文结构化摘要🚀但实际超时，".repeat(8)
    });
    for (let i = 0; i < 5; i++) {
      store.indexContent({
        sessionId: sid,
        worktree: nonGitDir,
        kind: "file",
        label: `归档报告_${i}_超长中文标题说明文档🚀🔥_${"内容".repeat(20)}.md`,
        content: "中文日志内容".repeat(50)
      });
    }

    for (const cap of [1200, 600, 320, 90]) {
      const capped = buildHandoffBrief({
        store,
        sessionId: sid,
        cwd: nonGitDir,
        cacheDiag: {
          currentModel: "gemini-4-pro",
          currentContextTokens: 180000,
          cacheTemperature: "cold",
          compactAdvice: "critical_compact",
          weightedHitRate: 0.91,
          estimatedSavedUsd: 1.23
        },
        maxBytes: cap
      });
      const actualBytes = Buffer.byteLength(capped.markdown, "utf8");
      assert.equal(capped.truncated, true, `Expected truncated=true for maxBytes=${cap}`);
      assert.equal(capped.bytes, actualBytes);
      assert.ok(actualBytes <= cap, `Expected <= ${cap} UTF-8 bytes, got ${actualBytes}`);
      assert.ok(!capped.markdown.includes("\uFFFD"), `Unexpected replacement char at maxBytes=${cap}`);
      assert.equal(hasLoneSurrogate(capped.markdown), false, `Lone surrogate at maxBytes=${cap}`);
      if (cap >= 600) {
        assert.ok(
          capped.markdown.includes("Call ctx_resume({}) after /compact"),
          `Next-step footer should be preserved at maxBytes=${cap}`
        );
      }
    }
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-7.3: Standalone Sidecar HTTP /api/handoff + /api/cache-diag (serverNowMs) + index.html TTL bar & Handoff UI", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sidecar-p17-"));
  const repoDir = path.join(tmpDir, "workspace-repo");
  const nonGitDir = path.join(tmpDir, "non-git-dir");
  const fakeHome = path.join(tmpDir, "fake-home");
  const tmpDb = path.join(tmpDir, "context.db");
  const convId = "p17-sidecar-conv";

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(nonGitDir, { recursive: true });
  const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  // Prepare real git repo
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["checkout", "-b", "main"]);
  fs.writeFileSync(path.join(repoDir, "index.js"), "export const a = 1;\n", "utf8");
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "initial"]);
  fs.writeFileSync(path.join(repoDir, "index.js"), "export const a = 2;\nexport const b = 3;\n", "utf8");

  // Seed store checkpoint + FTS5 source referencing repoDir (to test automatic workspace inference)
  const store = new ContextModeStore({ dbPath: tmpDb });
  store.recordModifiedFiles(convId, [path.join(repoDir, "index.js")], { worktree: repoDir, tool: "edit_file" });
  store.recordVerificationResult(convId, {
    kind: "test",
    command: "node --test",
    exitCode: 0,
    passed: true,
    summary: "12 passed"
  });
  const src = store.indexContent({
    sessionId: convId,
    worktree: repoDir,
    kind: "file",
    label: "trace/output.log",
    content: "indexed sidecar handoff test payload\n".repeat(20)
  });
  store.close();

  // Seed live expiring transcript (~40s remaining on 300s TTL -> 260s idle)
  const now = Date.now();
  const transcriptPath = path.join(logDir, "transcript.jsonl");
  const steps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(now - 260 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 110000, output_tokens: 250 }
    }
  ];
  fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

  const port = 39550 + Math.floor(Math.random() * 350);
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

    // 1. /api/cache-diag returns serverNowMs on miss, cached refreshWallClockTtl hit, and missing-transcript fallback
    const tBefore1 = Date.now();
    const diag1 = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)
    ).json();
    assert.equal(diag1.ok, true);
    assert.equal(diag1.transcriptFound, true);
    assert.equal(diag1.ttlStatus, "expiring");
    assert.equal(typeof diag1.serverNowMs, "number");
    assert.ok(diag1.serverNowMs >= tBefore1 - 2000 && diag1.serverNowMs <= Date.now() + 2000);

    await new Promise((r) => setTimeout(r, 60));
    const diag2 = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)
    ).json();
    assert.equal(typeof diag2.serverNowMs, "number");
    assert.ok(diag2.serverNowMs >= diag1.serverNowMs, "refreshWallClockTtl must emit fresh serverNowMs");

    const diagMissing = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=no-such-conv-p17`, authHeaders)
    ).json();
    assert.equal(diagMissing.transcriptFound, false);
    assert.equal(typeof diagMissing.serverNowMs, "number");
    assert.ok(Number.isFinite(diagMissing.serverNowMs) && diagMissing.serverNowMs > 0);

    // 2. /api/handoff infers workspace from checkpoint/sources and includes git + checkpoint + FTS5 + cacheDiag
    const handoff1 = await (
      await fetch(`http://127.0.0.1:${port}/api/handoff?scope=conversation&conversationId=${convId}`, authHeaders)
    ).json();
    assert.equal(handoff1.ok, true);
    assert.equal(handoff1.sessionId, convId);
    assert.equal(handoff1.truncated, false);
    assert.equal(handoff1.bytes, Buffer.byteLength(handoff1.markdown, "utf8"));
    assert.ok(handoff1.bytes <= 5800);
    assert.ok(handoff1.markdown.includes("main"));
    assert.ok(handoff1.markdown.includes("index.js"));
    assert.ok(handoff1.markdown.includes(src.sourceId));
    assert.ok(handoff1.markdown.includes("claude-sonnet-4-6"));
    assert.ok(handoff1.markdown.includes("Call ctx_resume({}) after /compact"));

    // 3. /api/handoff respects explicit non-git cwd query and maxBytes cap
    const handoffExplicit = await (
      await fetch(
        `http://127.0.0.1:${port}/api/handoff?scope=conversation&conversationId=${convId}&cwd=${encodeURIComponent(nonGitDir)}&maxBytes=420`,
        authHeaders
      )
    ).json();
    assert.equal(handoffExplicit.ok, true);
    assert.ok(!handoffExplicit.markdown.includes("## Git Diff Stat"));
    assert.ok(handoffExplicit.bytes <= 420);

    // 4. Dashboard index.html syntax validation (both new Function & vm.Script) + DOM IDs + XSS-safe rendering + countdown math
    for (const preservedId of [
      "kv-cache-card",
      "kv-hit-rate",
      "kv-ctx-tokens",
      "kv-bust-count",
      "kv-wasted-tokens",
      "kv-watermark-badge",
      "kv-temp-badge",
      "kv-ttl-badge",
      "kv-model-badge",
      "kv-cost-savings",
      "kv-bust-causes"
    ]) {
      assert.ok(html.includes(`id="${preservedId}"`), `Missing preserved DOM ID: ${preservedId}`);
    }
    for (const newId of [
      "kv-ttl-bar-row",
      "kv-ttl-bar-track",
      "kv-ttl-bar-fill",
      "kv-ttl-bar-text",
      "kv-handoff-btn",
      "kv-handoff-cue",
      "kv-handoff-drawer",
      "kv-handoff-meta",
      "kv-handoff-preview",
      "kv-handoff-copy-btn"
    ]) {
      assert.ok(html.includes(`id="${newId}"`), `Missing new P1-7 DOM ID: ${newId}`);
    }

    // Verify XSS safety & clipboard fallback presence
    assert.ok(html.includes("previewEl.textContent ="), "Handoff preview must assign via textContent (XSS-safe)");
    assert.ok(!html.includes("previewEl.innerHTML"), "Handoff preview must never use innerHTML");
    assert.ok(html.includes("navigator.clipboard.writeText"));
    assert.ok(html.includes("document.execCommand('copy')"));
    assert.ok(html.includes("apiFetch('/api/handoff'"));

    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scriptMatches.length >= 1);
    for (const m of scriptMatches) {
      new Function(m[1]);
      new vm.Script(m[1]);
    }

    // 5. Execute client TTL countdown math in an isolated VM sandbox to prove drift-free accuracy & zero NaN/negative/timer leaks
    const mainScript = scriptMatches[0][1];
    const activeTimers = new Set();
    let nextTimerId = 1;
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
      window: {
        location: { search: "" },
        addEventListener: () => {}
      },
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
      setInterval: (fn, ms) => {
        const id = nextTimerId++;
        activeTimers.add({ id, ms });
        return id;
      },
      clearInterval: (id) => {
        for (const item of activeTimers) {
          if (item.id === id) activeTimers.delete(item);
        }
      },
      setTimeout: () => 0,
      clearTimeout: () => {}
    };
    vm.runInNewContext(mainScript, sandbox);

    const baseMs = Date.parse("2026-11-20T16:00:00.000Z");
    // Warm (>60s remaining): 100s idle of 300s with +5000ms server clock offset
    const snapWarm = sandbox.computeLocalTtlSnapshot(
      { lastPlannerMs: baseMs, cacheTtlSec: 300, clockOffsetMs: 5000 },
      baseMs + 95000
    );
    assert.equal(snapWarm.idleSeconds, 100);
    assert.equal(snapWarm.remainingSec, 200);
    assert.equal(snapWarm.ttlStatus, "warm");
    assert.ok(snapWarm.pct > 66 && snapWarm.pct < 67);

    // Expiring (<=60s remaining): 255s idle of 300s -> 45s left
    const snapExp = sandbox.computeLocalTtlSnapshot(
      { lastPlannerMs: baseMs, cacheTtlSec: 300, clockOffsetMs: 0 },
      baseMs + 255000
    );
    assert.equal(snapExp.remainingSec, 45);
    assert.equal(snapExp.ttlStatus, "expiring");
    assert.equal(snapExp.pct, 15);

    // Expired (0s remaining): 420s idle of 300s -> clamped to 0, never negative
    const snapDead = sandbox.computeLocalTtlSnapshot(
      { lastPlannerMs: baseMs, cacheTtlSec: 300, clockOffsetMs: 0 },
      baseMs + 420000
    );
    assert.equal(snapDead.remainingSec, 0);
    assert.equal(snapDead.pct, 0);
    assert.equal(snapDead.ttlStatus, "expired");
    assert.equal(snapDead.cacheTemperature, "cold");

    // Future clock skew never produces negative idle or >100% width
    const snapSkew = sandbox.computeLocalTtlSnapshot(
      { lastPlannerMs: baseMs, cacheTtlSec: 300, clockOffsetMs: 0 },
      baseMs - 15000
    );
    assert.equal(snapSkew.idleSeconds, 0);
    assert.equal(snapSkew.remainingSec, 300);
    assert.equal(snapSkew.pct, 100);

    // Invalid state returns null cleanly (zero NaN)
    assert.equal(sandbox.computeLocalTtlSnapshot({ lastPlannerMs: NaN, cacheTtlSec: 300 }), null);
    assert.equal(sandbox.computeLocalTtlSnapshot({ lastPlannerMs: baseMs, cacheTtlSec: 0 }), null);

    // Timer lifecycle: calling syncKvTtlState repeatedly creates at most 1 local 1s timer and cleans up on null
    const timersBefore = activeTimers.size;
    sandbox.syncKvTtlState({
      transcriptFound: true,
      turnsWithUsage: 2,
      lastPlannerAt: new Date(Date.now() - 250000).toISOString(),
      serverNowMs: Date.now(),
      cacheTtlSec: 300,
      currentContextTokens: 80000,
      compactAdvice: "none",
      ttlSource: "profile"
    });
    sandbox.syncKvTtlState({
      transcriptFound: true,
      turnsWithUsage: 2,
      lastPlannerAt: new Date(Date.now() - 252000).toISOString(),
      serverNowMs: Date.now(),
      cacheTtlSec: 300,
      currentContextTokens: 80000,
      compactAdvice: "none",
      ttlSource: "profile"
    });
    assert.equal(activeTimers.size, timersBefore + 1, "Repeated sync must reuse a single 1s interval");
    assert.ok(mockElements.get("kv-ttl-bar-fill").className.includes("bg-amber-400"));

    sandbox.syncKvTtlState(null);
    assert.equal(activeTimers.size, timersBefore, "Clearing TTL state must clear the 1s interval (no leak)");

    // 6. EN <-> ZH bilingual i18n toggle verification
    assert.ok(html.includes('id="lang-toggle"') && html.includes('id="lang-zh-btn"') && html.includes('id="lang-en-btn"'));
    sandbox.setLanguage("zh");
    assert.equal(mockElements.get("active-text").innerText, "运行中");
    assert.equal(mockElements.get("purge-btn").innerText, "清空当前对话");
    assert.equal(mockElements.get("toggle-cli-filter-btn").innerText, "CLI 过滤：开");
    sandbox.setLanguage("en");
    assert.equal(mockElements.get("active-text").innerText, "Active");
    assert.equal(mockElements.get("purge-btn").innerText, "Clear Conversation");
    assert.equal(mockElements.get("toggle-cli-filter-btn").innerText, "CLI Filter: ON");
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

test("P1-7.4: PreInvocation proactive expiring TTL alert (deduped >=60k, silent <60k) + Handoff Brief cues + zero-prefix-pollution", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-preinv-exp-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });

  try {
    const t0 = Date.parse("2026-11-20T16:00:00.000Z");
    const makeExpiringDiag = (tokens, remSec, lastPlannerIso) =>
      analyzeTranscriptCache(
        [
          {
            type: "PLANNER_RESPONSE",
            step_index: 1,
            created_at: lastPlannerIso,
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 5000, output_tokens: 200 }
          }
        ],
        { ttlSec: 300, nowMs: Date.parse(lastPlannerIso) + (300 - remSec) * 1000 }
      );

    // 1. Below 60k tokens (59,000 tokens, 35s left): MUST NOT fire expiring alert
    const lowDiag = makeExpiringDiag(59000, 35, new Date(t0).toISOString());
    assert.equal(lowDiag.ttlStatus, "expiring");
    const lowAlerts = evaluateCacheAlerts(lowDiag, { sessionId: "exp-low-sess", store });
    assert.equal(lowAlerts.length, 0, `Expiring alert must not fire below 60k tokens: ${JSON.stringify(lowAlerts)}`);

    // 2. >= 60k tokens (80,000 tokens, 40s left): fires ONCE per episode with seconds, USD, Handoff Brief & /compact
    const turn1Iso = new Date(t0).toISOString();
    const exp1 = makeExpiringDiag(80000, 40, turn1Iso);
    assert.equal(exp1.ttlStatus, "expiring");
    assert.equal(exp1.ttlRemainingSec, 40);

    const a1 = evaluateCacheAlerts(exp1, { sessionId: "exp-sess-1", store });
    assert.equal(a1.length, 1);
    assert.ok(a1[0].includes("40s"), `Expected remaining seconds in alert: ${a1[0]}`);
    assert.ok(a1[0].includes("$"), `Expected USD re-prefill estimate in alert: ${a1[0]}`);
    assert.ok(a1[0].includes("Handoff Brief"), `Expected Handoff Brief mention: ${a1[0]}`);
    assert.ok(a1[0].includes("/compact"), `Expected /compact mention: ${a1[0]}`);
    assert.equal(store.getTimedMeta("cache_alert:exp-sess-1:ttl_expiring_turn", ""), turn1Iso);

    // Same lastPlannerAt (even 15s later at 25s left): MUST NOT fire a second time!
    const exp1Again = makeExpiringDiag(80000, 25, turn1Iso);
    const a2 = evaluateCacheAlerts(exp1Again, { sessionId: "exp-sess-1", store });
    assert.equal(a2.length, 0, "Expiring alert must deduplicate on identical lastPlannerAt");

    // Transition to expired on same turn1Iso: expired alert still fires via separate ttl_turn key + mentions Handoff Brief!
    const expiredSameTurn = analyzeTranscriptCache(
      [
        {
          type: "PLANNER_RESPONSE",
          step_index: 1,
          created_at: turn1Iso,
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 75000, output_tokens: 200 }
        }
      ],
      { ttlSec: 300, nowMs: t0 + 360 * 1000 }
    );
    assert.equal(expiredSameTurn.ttlStatus, "expired");
    assert.equal(expiredSameTurn.compactAdvice, "opportunistic_cold_compact");
    const aExpired = evaluateCacheAlerts(expiredSameTurn, { sessionId: "exp-sess-1", store });
    assert.equal(aExpired.length, 1);
    assert.ok(aExpired[0].includes("Handoff Brief"));
    assert.ok(aExpired[0].includes("/compact"));
    assert.ok(aExpired[0].includes("`ctx_resume`"));

    // New turn (new lastPlannerAt) entering expiring again fires once for the new episode
    const turn2Iso = new Date(t0 + 600 * 1000).toISOString();
    const exp2 = makeExpiringDiag(85000, 30, turn2Iso);
    const a3 = evaluateCacheAlerts(exp2, { sessionId: "exp-sess-1", store });
    assert.equal(a3.length, 1);
    assert.ok(a3[0].includes("30s"));

    // Missing lastPlannerAt must NOT fire expiring alert
    const noTsDiag = { ...exp2, lastPlannerAt: null };
    assert.equal(evaluateCacheAlerts(noTsDiag, { sessionId: "exp-nots-sess", store }).length, 0);

    // 3. critical_compact includes Sidecar Handoff Brief alongside /compact + ctx_resume
    const critDiag = analyzeTranscriptCache(
      [
        {
          type: "PLANNER_RESPONSE",
          step_index: 1,
          created_at: new Date(t0).toISOString(),
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 160000, output_tokens: 200 }
        }
      ],
      { ttlSec: 300, nowMs: t0 + 15000 }
    );
    assert.equal(critDiag.watermark, "critical");
    assert.equal(critDiag.compactAdvice, "critical_compact");
    const critAlerts = evaluateCacheAlerts(critDiag, { sessionId: "crit-handoff-sess", store });
    assert.equal(critAlerts.length, 1);
    assert.ok(critAlerts[0].includes("Handoff Brief"));
    assert.ok(critAlerts[0].includes("/compact"));
    assert.ok(critAlerts[0].includes("`ctx_resume`"));

    store.close();

    // 4. Live hooks/pre-invocation.mjs process test: expiring 90k transcript emits zero-prefix-pollution alert once
    const transcriptPath = path.join(tmpDir, "expiring_live.jsonl");
    const liveStep = {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: new Date(Date.now() - 265 * 1000).toISOString(), // ~35s remaining on 300s TTL
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 80000, output_tokens: 200 }
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(liveStep) + "\n", "utf8");

    const live1 = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "live-exp-conv", transcriptPath },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(live1.injectSteps?.length, 1);
    assert.equal(live1.injectSteps[0].systemMessage.systemMessage, "", "Must preserve zero-prefix-pollution systemMessage: ''");
    const userMd = live1.injectSteps[0].systemMessage.metadata?.user_markdown || "";
    assert.ok(userMd.includes("KV-cache expiring in"), `Unexpected user_markdown: ${userMd}`);
    assert.ok(userMd.includes("Handoff Brief"));
    assert.ok(userMd.includes("/compact"));
    assert.ok(userMd.includes("$"));

    // Second live invocation on unchanged transcript MUST NOT re-emit
    const live2 = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "live-exp-conv", transcriptPath },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(live2.injectSteps, undefined);
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-7.5: install.mjs packages runtime-only by default and all v1.2 devtools with --with-devtools cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-install-v12-"));
  const runtimeDir = path.join(tmpDir, "installed-runtime");
  const installDir = path.join(tmpDir, "installed-full");
  const tmpDb = path.join(tmpDir, "context.db");
  const sampleFile = path.join(tmpDir, "sample.js");
  fs.writeFileSync(sampleFile, "export const v = 1;\n", "utf8");

  let serverProc = null;
  try {
    // 1a. Default runtime-only install omits devtools and passes doctor
    const instRt = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", runtimeDir, "--mode", "balanced-16k"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(instRt.status, 0, `runtime install failed:\n${instRt.stdout}\n${instRt.stderr}`);
    assert.equal(fs.existsSync(path.join(runtimeDir, "scripts", "cache-audit.mjs")), false, "Runtime-only install must omit cache-audit.mjs");
    assert.equal(fs.existsSync(path.join(runtimeDir, "fast", "benchmark.mjs")), false, "Runtime-only install must omit benchmark.mjs");
    assert.ok(fs.existsSync(path.join(runtimeDir, "context", "lib", "handoff.js")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "context", "lib", "config.js")));

    // 1b. --with-devtools install + doctor to isolated target
    const inst = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--mode", "balanced-16k", "--with-devtools"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(inst.status, 0, `install failed:\n${inst.stdout}\n${inst.stderr}`);

    const doc = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "doctor", "--target", installDir],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(doc.status, 0, `doctor failed:\n${doc.stdout}\n${doc.stderr}`);

    // 2. Verify all 4 new v1.2 files were copied
    for (const rel of [
      "scripts/cache-audit.mjs",
      "context/lib/text-diff.js",
      "context/lib/json-crusher.js",
      "context/lib/handoff.js"
    ]) {
      assert.ok(fs.existsSync(path.join(installDir, rel)), `Missing packaged v1.2 file: ${rel}`);
    }

    // 3. Load context/lib/tools.js directly from installed target (zero missing modules)
    const installedToolsMod = await import(pathToFileURL(path.join(installDir, "context", "lib", "tools.js")).href);
    assert.equal(typeof installedToolsMod.createTools, "function");

    // 4. Execute hooks/pre-tool-use.mjs directly from installed target (exercises text-diff & filter-rules path)
    const hookRun = spawnSync(process.execPath, [path.join(installDir, "hooks", "pre-tool-use.mjs")], {
      input: JSON.stringify({
        conversationId: "inst-v12-sess",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: sampleFile } }
      }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    assert.equal(hookRun.status, 0, `installed pre-tool-use failed: ${hookRun.stderr}`);
    assert.equal(JSON.parse(hookRun.stdout.trim()).decision, "allow");

    // 5. Execute scripts/cache-audit.mjs directly from installed target
    const auditRun = spawnSync(
      process.execPath,
      [path.join(installDir, "scripts", "cache-audit.mjs"), "--workspace", installDir, "--no-live", "--json"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(auditRun.status, 0, `installed cache-audit failed: ${auditRun.stderr}`);
    const auditJson = JSON.parse(auditRun.stdout);
    assert.equal(typeof auditJson.score, "number");

    // 6. Boot sidecars/dashboard/server.mjs directly from installed target (verifies handoff.js static import & endpoints)
    const port = 39920 + Math.floor(Math.random() * 250);
    serverProc = spawn(process.execPath, [path.join(installDir, "sidecars", "dashboard", "server.mjs")], {
      cwd: installDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        AGY_DART_DB_PATH: tmpDb,
        AGY_DART_DISABLE_COMPILE_CACHE: "1",
        SIDECAR_FORCE_HTTP: "1",
        PORT: String(port)
      }
    });
    await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`Installed Sidecar startup timed out: ${stderr}`)), 5000);
      serverProc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      serverProc.stdout.on("data", (d) => {
        if (d.toString("utf8").includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Installed Sidecar exited prematurely (${code}): ${stderr}`));
      });
    });

    const instHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const instToken = instHtml.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(instToken, "Installed Sidecar HTML must inject agy-dart-token meta");
    const instAuth = { headers: { "X-Agy-Dart-Token": instToken } };

    const diagResp = await (
      await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=inst-v12-sess`, instAuth)
    ).json();
    assert.equal(diagResp.ok, true);
    assert.equal(typeof diagResp.serverNowMs, "number");

    const handoffResp = await (
      await fetch(`http://127.0.0.1:${port}/api/handoff?scope=conversation&conversationId=inst-v12-sess`, instAuth)
    ).json();
    assert.equal(handoffResp.ok, true);
    assert.ok(handoffResp.markdown.includes("Call ctx_resume({}) after /compact"));

    // 7. Live in-place upgrade while Sidecar holds CWD lock on installDir (Windows EBUSY regression)
    //    Switching from --with-devtools back to runtime-only must succeed and prune stale devtools files.
    const liveReinstall = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(liveReinstall.status, 0, `Live in-place reinstall under CWD lock failed: ${liveReinstall.stderr}`);
    assert.equal(fs.existsSync(path.join(installDir, "fast", "mcp-server.mjs")), true);
    assert.equal(fs.existsSync(path.join(installDir, "scripts", "cache-audit.mjs")), false, "Stale devtools file must be pruned");
    assert.equal(fs.existsSync(path.join(installDir, "fast", "benchmark.mjs")), false, "Stale benchmark CLI must be pruned");
  } finally {
    if (serverProc) {
      await new Promise((resolve) => {
        if (serverProc.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 1000);
        serverProc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        serverProc.kill("SIGTERM");
      });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  }
});
