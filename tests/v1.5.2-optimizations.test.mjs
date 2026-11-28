import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { executeCode } from "../context/lib/executor.js";
import { ContextModeStore } from "../context/lib/store.js";
import { CURRENT_SCHEMA_USER_VERSION } from "../context/lib/store/schema.js";
import { buildWorkspaceSnapshot } from "../fast/session-start.mjs";
import {
  classifyFileTier,
  computeEffectiveReadBounds,
  createFileReadContext
} from "../hooks/pre-tool-use.mjs";
import { closeRuntimeStore, createStandaloneServer } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function callFastMcp(requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "fast", "mcp-server.mjs")], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        AGY_DART_DISABLE_OUTLINE_DB: "1",
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    const responses = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const ln of lines) {
        const trimmed = ln.trim();
        if (!trimmed) continue;
        try {
          responses.push(JSON.parse(trimmed));
        } catch {}
      }
      if (responses.length >= requests.length) {
        child.stdin.end();
      }
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, responses });
    });
    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }
  });
}

test("v1.5.2-1: PreToolUse createFileReadContext memoizes <=2 MB buffer & realpathSync and recognizes .dart/.astro/.mdx/.proto", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v152-readctx-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    const dartFile = path.join(tmpDir, "widget.dart");
    const lines = Array.from({ length: 200 }, (_, i) => `final int item_${i} = ${i};`).join("\n");
    fs.writeFileSync(dartFile, lines, "utf8");
    const stat = fs.statSync(dartFile);

    let readSyncCalls = 0;
    let realpathCalls = 0;
    const origReadFileSync = fs.readFileSync;
    const origRealpathSync = fs.realpathSync;
    fs.readFileSync = function (...args) {
      if (String(args[0]) === dartFile) readSyncCalls += 1;
      return origReadFileSync.apply(this, args);
    };
    fs.realpathSync = function (...args) {
      if (String(args[0]) === dartFile) realpathCalls += 1;
      return origRealpathSync.apply(this, args);
    };

    try {
      const ctx = createFileReadContext(dartFile, stat.size);
      assert.equal(ctx.getRealPath(), origRealpathSync(dartFile));
      assert.equal(ctx.getRealPath(), origRealpathSync(dartFile));
      const tierInfo = classifyFileTier(dartFile, ".dart", stat.size, 1024, ctx);
      assert.equal(tierInfo.tier, "source");
      const b1 = computeEffectiveReadBounds(dartFile, 1, null, stat.size, 800, 1024, ctx);
      const b2 = computeEffectiveReadBounds(dartFile, 10, 50, stat.size, 800, 1024, ctx);
      assert.equal(b1.hostTruncated, true);
      assert.equal(b2.hostTruncated, false);
      assert.equal(realpathCalls, 1, "getRealPath + classifyFileTier must call fs.realpathSync at most once");
      assert.equal(readSyncCalls, 1, "Shared readCtx must read <=2 MB file buffer from disk at most once");
    } finally {
      fs.readFileSync = origReadFileSync;
      fs.realpathSync = origRealpathSync;
    }

    // End-to-end hook run on .dart with 0 stderr
    const hookRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
      input: JSON.stringify({
        conversationId: "v152-dart-conv",
        toolCall: { name: "read_file", args: { Path: dartFile, StartLine: 1, EndLine: 80 } }
      }),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing.json")
      }
    });
    assert.equal(hookRes.status, 0);
    assert.equal(hookRes.stderr, "");
    assert.equal(JSON.parse(hookRes.stdout.trim()).decision, "allow");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.2-2: SQLite initSchema user_version fast-path skips DDL on warm open while self-healing dropped/legacy tables", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v152-schema-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    const first = new ContextModeStore({ dbPath });
    first.open();
    const uv = first.db.prepare("PRAGMA user_version").get();
    assert.equal(Number(uv.user_version), CURRENT_SCHEMA_USER_VERSION);
    assert.equal(first.getMeta("schema_version"), "3");
    const idxRow = first.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_tool_sandbox'")
      .get();
    assert.equal(idxRow?.name, "idx_events_tool_sandbox");
    first.close();

    // Warm open: spy on _withBusyRetry to prove DDL blocks are skipped completely
    const warm = new ContextModeStore({ dbPath, hookMode: true });
    let ddlBlocksRun = 0;
    const origRetry = warm._withBusyRetry.bind(warm);
    warm._withBusyRetry = (fn, maxAttempts) => {
      ddlBlocksRun += 1;
      return origRetry(fn, maxAttempts);
    };
    warm.open();
    assert.equal(ddlBlocksRun, 0, "Warm open at CURRENT_SCHEMA_USER_VERSION must skip DDL & PRAGMA table_info");

    // Simulate dropped table on warm DB -> re-init must detect missing table and self-heal
    warm.db.exec("DROP TABLE outline_cache;");
    warm.close();

    const healed = new ContextModeStore({ dbPath });
    healed.open();
    const restored = healed.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outline_cache'")
      .get();
    assert.equal(restored?.name, "outline_cache", "initSchema must self-heal dropped core tables");
    healed.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.2-3: SessionStart runs snapshot in-process with 0 git spawns on subagents and detects Dart/Flutter pubspec.yaml", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v152-session-"));
  const wsDir = path.join(tmpDir, "flutter_ws");
  const fakeBinDir = path.join(tmpDir, "fake_bin");
  const gitMarker = path.join(tmpDir, "git_called.log");
  const dbPath = path.join(tmpDir, "context.db");
  fs.mkdirSync(path.join(wsDir, "lib"), { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsDir, "pubspec.yaml"),
    "name: my_flutter_app\ndescription: Demo\ndependencies:\n  flutter:\n    sdk: flutter\n",
    "utf8"
  );
  fs.writeFileSync(path.join(wsDir, "lib", "main.dart"), "void main() {}\n", "utf8");

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(fakeBinDir, "git.cmd"),
      `@echo off\r\necho called>>"${gitMarker}"\r\nexit /b 1\r\n`,
      "utf8"
    );
  } else {
    const shPath = path.join(fakeBinDir, "git");
    fs.writeFileSync(shPath, `#!/bin/sh\necho called >> "${gitMarker}"\nexit 1\n`, { mode: 0o755 });
  }

  try {
    const directSnap = await buildWorkspaceSnapshot(wsDir, { omitGit: true });
    assert.ok(directSnap && directSnap.includes("pubspec.yaml (my_flutter_app, flutter)"));

    const pathSep = process.platform === "win32" ? ";" : ":";
    const subRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ cwd: wsDir, isSubagent: true, conversationId: "sub-1", rootConversationId: "root-1" }),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${pathSep}${process.env.PATH || ""}`,
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_DISABLE_REPO_HUBS: "1",
        AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing.json")
      }
    });
    assert.equal(subRes.status, 0, subRes.stderr);
    assert.equal(subRes.stderr, "");
    assert.equal(fs.existsSync(gitMarker), false, "Subagent SessionStart must spawn 0 git processes");
    const parsed = JSON.parse(subRes.stdout.trim());
    const sysMsg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
    assert.ok(sysMsg.includes("pubspec.yaml (my_flutter_app, flutter)"));
    assert.equal(sysMsg.includes("Git:"), false);

    // Standalone CLI compatibility check for fast/session-start.mjs
    const cliRes = spawnSync(process.execPath, [path.join(ROOT, "fast", "session-start.mjs")], {
      input: JSON.stringify({ cwd: wsDir }),
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(cliRes.status, 0);
    assert.equal(cliRes.stderr, "");
    assert.ok(cliRes.stdout.includes("my_flutter_app"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.2-4: read_slices({ outlines }) extracts indented HTML (<style>/<body>/<script> JS functions) and Dart 3 symbols", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v152-outlines-"));
  const dartPath = path.join(tmpDir, "service.dart");
  fs.writeFileSync(
    dartPath,
    [
      "mixin CacheableMixin {",
      "  void invalidateCache() {",
      "    return;",
      "  }",
      "}",
      "",
      "base class TokenService with CacheableMixin {",
      "  factory TokenService.create() => TokenService();",
      "  Future<String?> fetchToken(String userId) async {",
      "    return userId;",
      "  }",
      "}",
      "",
      "extension StringTrimExt on String {",
      "  String clean() => trim();",
      "}",
      "",
      "int computeScore(int a, int b) => a + b;"
    ].join("\n"),
    "utf8"
  );

  const inlinedHtmlPath = path.join(tmpDir, "dashboard-inlined.html");
  fs.writeFileSync(inlinedHtmlPath, readDashboardHtml(), "utf8");

  try {
    const { stderr, responses } = await callFastMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: ROOT,
            outlines: [inlinedHtmlPath]
          }
        }
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: ROOT,
            outlines: [dartPath]
          }
        }
      }
    ], { AGY_DART_DB_PATH: path.join(tmpDir, "v152-outlines.db") });

    assert.equal(stderr, "", "fast/mcp-server.mjs must emit 0 bytes stderr");
    const htmlResp = responses.find((r) => r.id === 2);
    const dartResp = responses.find((r) => r.id === 3);
    assert.ok(htmlResp && dartResp);
    assert.ok(Buffer.byteLength(JSON.stringify(htmlResp), "utf8") <= 8800, "MCP JSON-RPC frame must stay <= 8.8 KB");
    assert.ok(Buffer.byteLength(JSON.stringify(dartResp), "utf8") <= 8800, "MCP JSON-RPC frame must stay <= 8.8 KB");
    const htmlText = htmlResp.result?.content?.[0]?.text || "";
    const dartText = dartResp.result?.content?.[0]?.text || "";
    assert.equal(htmlText.includes("(no top-level symbols detected)"), false, htmlText);
    assert.ok(htmlText.includes("[style] <style>"), "HTML outline must include indented <style> block");
    assert.ok(htmlText.includes("[body] <body>"), "HTML outline must include <body> landmark");
    assert.ok(htmlText.includes("[script] <script>"), "HTML outline must include indented <script> block");
    assert.ok(htmlText.includes("detectInitialLang"), "HTML outline must extract indented JS functions inside <script>");
    assert.ok(dartText.includes("[mixin] CacheableMixin"), "Dart outline must include mixin");
    assert.ok(dartText.includes("[class] TokenService"), "Dart outline must include base class");
    assert.ok(dartText.includes("fetchToken"), "Dart outline must include nullable Future<String?> method");
    assert.ok(dartText.includes("[extension] StringTrimExt"), "Dart outline must include extension");
    assert.ok(dartText.includes("computeScore"), "Dart outline must include expression-body top-level function");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.2-5: ctx_execute preserves UTF-8 CJK/Unicode output and exit codes across PowerShell (including param blocks) & Node", async () => {
  const sample = "中文UTF8校验-αβγ-✓";
  const nodeRes = await executeCode({
    language: "nodejs",
    code: `process.stdout.write(${JSON.stringify(sample)});`,
    cwd: ROOT
  });
  assert.equal(nodeRes.ok, true);
  assert.equal(nodeRes.stdout, sample);

  if (process.platform === "win32") {
    const psRes = await executeCode({
      language: "powershell",
      code: `Write-Output "${sample}"; exit 7`,
      cwd: ROOT
    });
    assert.equal(psRes.exitCode, 7);
    assert.equal(psRes.stdout.trim(), sample);
    assert.equal(psRes.stdout.includes("\uFFFD"), false);

    const psParamRes = await executeCode({
      language: "powershell",
      code: `param([string]$Greeting)\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nWrite-Output "$Greeting-${sample}"`,
      args: ["你好"],
      cwd: ROOT
    });
    assert.equal(psParamRes.ok, true, psParamRes.stderr);
    assert.equal(psParamRes.stdout.trim(), `你好-${sample}`);
  }
});

test("v1.5.2-6: Sidecar refreshData parallelizes 5 polls, skips hidden-tab intervals, deduplicates ghost/star queries & batches app search", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v152-sidecar-"));
  const dbPath = path.join(tmpDir, "sidecar.db");
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing.json");

  let srv = null;
  try {
    // 1. Verify terminal starPrompt skips getStats("all") full-table scans
    const seedStore = new ContextModeStore({ dbPath });
    seedStore.setStarPromptState("dismissed", { nowIso: "2026-11-22T00:00:00.000Z" });
    seedStore.indexContent({
      sessionId: "s-app-1",
      worktree: ROOT,
      kind: "doc",
      label: "alpha",
      content: "alpha unique_v152_token"
    });
    seedStore.indexContent({
      sessionId: "s-app-2",
      worktree: ROOT,
      kind: "doc",
      label: "beta",
      content: "beta unique_v152_token"
    });
    let getStatsCalls = 0;
    const origGetStats = seedStore.getStats.bind(seedStore);
    seedStore.getStats = (...args) => {
      getStatsCalls += 1;
      return origGetStats(...args);
    };
    const termEval = seedStore.evaluateStarPrompt({ markTriggered: true });
    assert.equal(termEval.state, "dismissed");
    assert.equal(termEval.shouldShow, false);
    assert.equal(getStatsCalls, 0, "Terminal starPrompt must short-circuit heavy getStats('all') scan");

    let ghostCalls = 0;
    const origGhost = seedStore.getGhostStats.bind(seedStore);
    seedStore.getGhostStats = (...args) => {
      ghostCalls += 1;
      return origGhost(...args);
    };
    const g = seedStore.getGhostStats("s-app-1");
    seedStore.getFeatureRoi("s-app-1", { ghost: g });
    assert.equal(ghostCalls, 1, "getFeatureRoi({ ghost }) must reuse precomputed ghost stats");
    seedStore.close();

    // 2. Verify Sidecar HTTP server /api/stats & batched /api/search in app scope
    const token = "v152-csrf-secret-token-123456";
    srv = createStandaloneServer({ csrfToken: token, watchdogOptions: { pollMs: 60000 } });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const postJson = (urlPath, bodyObj) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(bodyObj);
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: urlPath,
            method: "POST",
            headers: {
              Host: `127.0.0.1:${port}`,
              "Content-Type": "application/json",
              "X-Agy-Dart-Token": token,
              "Content-Length": Buffer.byteLength(body, "utf8")
            }
          },
          (res) => {
            let raw = "";
            res.on("data", (d) => (raw += d.toString("utf8")));
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });

    const statsResp = await postJson("/api/stats", { scope: "app", conversationId: "s-app-1" });
    assert.equal(statsResp.status, 200);
    assert.equal(statsResp.json.starPrompt.state, "dismissed");
    assert.ok(statsResp.json.featureRoi?.features?.large_file_guard);

    const searchResp = await postJson("/api/search", { scope: "app", query: "unique_v152_token" });
    assert.equal(searchResp.status, 200);
    assert.equal(searchResp.json.hits.length, 2);

    // 3. Verify frontend refreshData concurrency (inFlightPeak === 5) & hidden-tab pause
    const htmlSource = readDashboardHtml();
    const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    const mainUiScript = scriptBlocks[scriptBlocks.length - 1][1];

    const elements = new Map();
    const getEl = (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          value: id === "cutoff-select" ? "46080" : "",
          innerText: "",
          textContent: "",
          innerHTML: "",
          className: "",
          style: {},
          dataset: {},
          options: [{ value: "46080" }],
          classList: {
            _s: new Set(["hidden"]),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            contains(c) { return this._s.has(c); }
          },
          getAttribute: () => token
        });
      }
      return elements.get(id);
    };

    let activeFetches = 0;
    let peakFetches = 0;
    let fetchCount = 0;
    let intervalFn = null;
    const visibilityListeners = [];
    const docObj = {
      hidden: false,
      title: "",
      documentElement: { lang: "en" },
      getElementById: getEl,
      querySelector: () => getEl("meta-csrf"),
      querySelectorAll: () => [],
      addEventListener(ev, fn) {
        if (ev === "visibilitychange") visibilityListeners.push(fn);
      }
    };

    const sandbox = {
      window: { location: { search: "?conversationId=v152-ui" }, addEventListener() {}, sidecar: null },
      document: docObj,
      navigator: { language: "en-US" },
      localStorage: { getItem: () => "en", setItem: () => {} },
      URLSearchParams,
      Headers,
      fetch: async (urlPath) => {
        fetchCount += 1;
        activeFetches += 1;
        if (activeFetches > peakFetches) peakFetches = activeFetches;
        await new Promise((r) => setTimeout(r, 25));
        activeFetches -= 1;
        const payload =
          urlPath === "/api/stats"
            ? {
                isPaused: false,
                cutoffBytes: 46080,
                conversationCutoffBytes: 46080,
                appCutoffBytes: 46080,
                globalCutoffBytes: 46080,
                exemptCategories: [],
                starPrompt: { state: "dismissed", shouldShow: false }
              }
            : { status: "HEALTHY", ok: true, recentEvents: [], recentSources: [] };
        return { ok: true, status: 200, json: async () => payload };
      },
      alert: () => {},
      confirm: () => true,
      setInterval: (fn) => {
        intervalFn = fn;
        return 1;
      },
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      console: { log() {}, warn() {}, error() {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(`${mainUiScript}\nglobalThis.__v152 = { refreshData };`, sandbox);
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(peakFetches, 5, "refreshData() must issue all 5 /api/* POST requests concurrently via Promise.all");
    const countAfterInit = fetchCount;

    // Hidden tab skips background interval poll
    docObj.hidden = true;
    intervalFn();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(fetchCount, countAfterInit, "Background poll interval must skip network fetches while document.hidden === true");

    // Returning tab visible triggers immediate refresh
    docObj.hidden = false;
    for (const fn of visibilityListeners) fn();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fetchCount, countAfterInit + 5, "visibilitychange back to visible must refresh all 5 endpoints");
  } finally {
    if (srv) {
      await new Promise((r) => srv.close(r));
    }
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
