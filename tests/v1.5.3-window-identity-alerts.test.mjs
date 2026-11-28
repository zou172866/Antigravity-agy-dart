import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { suppressSqliteExperimentalWarning } from "../hooks/compile-cache.mjs";
import { getConfigSnapshot, resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  buildDesktopNotificationCommand,
  buildWindowNotificationPrefix,
  WatchdogMonitor
} from "../context/lib/watchdog.js";
import {
  extractPayloadWorkspaceRoot,
  formatWorkspaceWindowLabel,
  lookupConversationSummary,
  lookupConversationTitle,
  parseWorkspaceUriToPath,
  readWatchdogLease,
  recordHookLeaseTransition
} from "../context/lib/watchdog-lease.js";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

suppressSqliteExperimentalWarning();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHookProcess(relScript, payloadObj, envOverrides = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, relScript)], {
    cwd: ROOT,
    input: JSON.stringify(payloadObj),
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      ...envOverrides
    }
  });
}

test("v1.5.3-1: Smart workspace & subproject window label formatting + file:// URI decoding", () => {
  // 1. Umbrella workspace + single modified/read subproject -> "<workspace>/<subproject>"
  assert.equal(
    formatWorkspaceWindowLabel("e:\\work", ["e:\\work\\agy-dart\\package.json"]),
    "work/agy-dart"
  );
  assert.equal(
    formatWorkspaceWindowLabel("e:\\work", [
      { path: "agy-dart/hooks/pre-invocation.mjs" },
      { path: "agy-dart/context/lib/watchdog.js" },
      "C:\\Users\\Administrator\\.gemini\\config\\skills\\agy-dart\\SKILL.md"
    ]),
    "work/agy-dart",
    "External .gemini skill reads outside cwd must not break single-subproject refinement"
  );

  // 2. Umbrella workspace with multiple subprojects touched -> stays at workspace level
  assert.equal(
    formatWorkspaceWindowLabel("e:\\work", [
      "e:\\work\\agy-dart\\package.json",
      "e:\\work\\baidu-ai-batch\\index.js"
    ]),
    "work"
  );

  // 3. Ambiguous leaf directories (numeric, v<N>, generic structural leaf) prepend parent
  assert.equal(formatWorkspaceWindowLabel("e:\\故事\\1", []), "故事/1");
  assert.equal(formatWorkspaceWindowLabel("d:\\proj\\v2", []), "proj/v2");
  assert.equal(formatWorkspaceWindowLabel("/srv/acme/src", []), "acme/src");

  // 4. Single-project workspace does NOT append internal repo folders (`src`, `lib`, `hooks`)
  assert.equal(formatWorkspaceWindowLabel("e:\\mys", []), "mys");
  assert.equal(formatWorkspaceWindowLabel("e:\\mys", ["e:\\mys\\src\\main.dart"]), "mys");

  // 5. Monorepo container (`packages/<pkg>`) refines to package name
  assert.equal(
    formatWorkspaceWindowLabel("d:\\monorepo", ["d:\\monorepo\\packages\\billing-api\\src\\index.ts"]),
    "monorepo/billing-api"
  );

  // 6. Percent-encoded Windows & CJK `workspace_uris` decode cleanly
  const decodedStory = parseWorkspaceUriToPath('["file:///e%3A/%E6%95%85%E4%BA%8B/1"]');
  assert.equal(formatWorkspaceWindowLabel(decodedStory), "故事/1");
  const payloadRoot = extractPayloadWorkspaceRoot({
    workspace_paths: ["file:///e%3A/work"]
  });
  assert.equal(formatWorkspaceWindowLabel(payloadRoot, ["agy-dart/README.md"]), "work/agy-dart");
});

test("v1.5.3-2: Official conversation_summaries.db read-only title & workspace_uris fallback with zero prompt leakage", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v153-sumdb-"));
  try {
    const agRoot = path.join(tmpDir, "antigravity");
    const convId = "38caeca3-1111-4222-8333-abcdef123456";
    const logDir = path.join(agRoot, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const txPath = path.join(logDir, "transcript.jsonl");
    fs.writeFileSync(txPath, "", "utf8");

    const sumDbPath = path.join(agRoot, "conversation_summaries.db");
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
    sumDb
      .prepare(
        "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        convId,
        "检查dart项目，并优化多窗口右下角通知归属定位与满水位提醒体验",
        JSON.stringify(["file:///e%3A/work"]),
        "Antigravity",
        "",
        0
      );
    sumDb.close();

    // Derived automatically from transcriptPath (<agRoot>/brain/<id>/... -> <agRoot>/conversation_summaries.db)
    const summary = lookupConversationSummary(convId, {
      transcriptPath: txPath,
      allowDefaultDb: false
    });
    assert.ok(summary.title.startsWith("检查dart项目"), `Unexpected title: ${summary.title}`);
    assert.ok(Buffer.byteLength(summary.title, "utf8") <= 36, `Title must be <=36B: ${summary.title}`);
    assert.ok(!summary.title.includes("\uFFFD"), "UTF-8 CJK truncation must never emit replacement char");
    assert.equal(formatWorkspaceWindowLabel(summary.cwd, ["agy-dart/package.json"]), "work/agy-dart");
    assert.equal(lookupConversationTitle(convId, { transcriptPath: txPath, allowDefaultDb: false }), summary.title);

    // Missing DB path fails open without creating any file
    const missingDb = path.join(tmpDir, "nonexistent", "conversation_summaries.db");
    assert.equal(
      lookupConversationTitle("conv-missing", { summaryDbPath: missingDb, allowDefaultDb: false }),
      ""
    );
    assert.equal(fs.existsSync(missingDb), false, "Read-only summary lookup must NEVER create missing DB");

    // Lease transition caches workspaceLabel + convTitle while keeping TOP_SECRET_NEVER_LEAK strictly out of titles/popups
    const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db") });
    try {
      const lease = recordHookLeaseTransition(
        store,
        "PreInvocation",
        {
          conversationId: convId,
          lastUserInput: "TOP_SECRET_NEVER_LEAK sk-ant-api03-secretkeyvalue1234567890"
        },
        {
          transcriptPath: txPath,
          lookupSummary: true,
          allowDefaultDb: false,
          modifiedOrReadPaths: ["e:\\work\\agy-dart\\package.json"],
          contextTokens: 425000,
          windowTokens: 512000,
          watermark: "critical"
        }
      );
      assert.equal(lease.workspaceLabel, "work/agy-dart");
      assert.equal(lease.convTitle, summary.title);
      assert.equal(lease.convTitle.includes("TOP_SECRET_NEVER_LEAK"), false);
      assert.equal(lease.windowTokens, 512000);
      assert.equal(lease.watermark, "critical");

      // Subsequent PreToolUse / Stop with mixed drive case or slash style preserves workspaceLabel, convTitle & watermark
      recordHookLeaseTransition(
        store,
        "PreToolUse",
        { conversationId: convId, cwd: "E:/work/", toolCall: { name: "read_file", args: { Path: "a.js" } } },
        {}
      );
      const afterStop = recordHookLeaseTransition(store, "Stop", { conversationId: convId, cwd: "e:\\work" }, {});
      assert.equal(afterStop.workspaceLabel, "work/agy-dart", "Stop must not downgrade subproject workspaceLabel");
      assert.equal(afterStop.convTitle, summary.title);
      assert.equal(afterStop.watermark, "critical");
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.3-3: Critical watermark + TTL expiring + Stalled desktop alerts (ZH & EN) obey <=60B/<=220B caps, 0 statSync idle, dedup & /compact reset", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v153-alerts-"));
  const prevWmEnv = process.env.AGY_DART_WATERMARK_DESKTOP_NOTIFY;
  delete process.env.AGY_DART_WATERMARK_DESKTOP_NOTIFY;
  resetConfigCache();

  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db") });
  try {
    // Verify config.js defaults watermarkDesktopNotify to null (auto-follow) and parses env override
    assert.equal(getConfigSnapshot({ configPath: path.join(tmpDir, "no.json"), env: {} }).values.watermarkDesktopNotify, null);
    assert.equal(
      getConfigSnapshot({ configPath: path.join(tmpDir, "no.json"), env: { AGY_DART_WATERMARK_DESKTOP_NOTIFY: "false" } })
        .values.watermarkDesktopNotify,
      false
    );

    let nowMs = 1_790_000_000_000;
    let monoNs = 50_000_000_000n;
    const advanceSec = (sec) => {
      nowMs += sec * 1000;
      monoNs += BigInt(sec) * 1_000_000_000n;
    };

    let cfgState = {
      stallWatchdog: true,
      watchdogPollMs: 5000,
      watchdogDesktopNotify: true,
      ttlKeepalive: true,
      ttlDesktopNotify: true,
      ttlNotifyLeadSec: 60,
      ttlNotifyMinTokens: 60000,
      watermarkDesktopNotify: null, // auto-follows ttlDesktopNotify || watchdogDesktopNotify
      uiLang: "zh"
    };
    const popups = [];
    let allowActiveStat = false;

    const monitor = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfgState,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      statFn: () => {
        monitor.statSyncCount += 1;
        if (!allowActiveStat) {
          throw new Error("All-IDLE watermark & TTL path must NEVER call statSync");
        }
        return { isFile: () => false };
      },
      notifyFn: (p) => {
        popups.push(p);
        return { dispatched: true };
      }
    });

    // 1. All-IDLE tick with Critical Watermark + Idle TTL Expiring + Subagent Critical (ZH, including super-long CJK workspaceLabel)
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-wm-zh", lastUserInput: "TOP_SECRET_NEVER_LEAK" },
      {
        nowMs: nowMs - 10_000,
        cwd: "e:\\00-项目管理\\超长子项目归属定位测试工作台",
        workspaceLabel: "00-项目管理/超长子项目归属定位测试工作台",
        convTitle: "多窗口上下文快满了右下角提醒压测",
        contextTokens: 420000,
        windowTokens: 512000,
        watermark: "critical",
        cacheTtlSec: 300
      }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-wm-zh" }, { nowMs: nowMs - 5_000 });

    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-ttl-zh", lastUserInput: "TOP_SECRET_NEVER_LEAK" },
      {
        nowMs: nowMs - 260_000,
        cwd: "e:\\work",
        workspaceLabel: "work/agy-dart",
        convTitle: "检查dart项目并优化",
        contextTokens: 279000,
        windowTokens: 512000,
        watermark: "warn",
        cacheTtlSec: 300
      }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-ttl-zh" }, { nowMs: nowMs - 255_000 });

    // Subagent critical lease MUST NEVER trigger desktop popup
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-sub-crit", parentConversationId: "conv-wm-zh" },
      {
        nowMs: nowMs - 5_000,
        isSubagent: true,
        workspaceLabel: "work/agy-dart",
        convTitle: "子代理任务",
        contextTokens: 450000,
        windowTokens: 512000,
        watermark: "critical"
      }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-sub-crit" }, { nowMs: nowMs - 2_000, isSubagent: true });

    monitor.tick();
    assert.equal(monitor.statSyncCount, 0, "All-IDLE watermark + TTL check must perform 0 statSync calls");
    assert.equal(popups.length, 2, "Expected 1 critical watermark popup + 1 TTL popup (0 subagent popups)");
    assert.equal(monitor.watermarkNotificationCount, 1);
    assert.equal(monitor.ttlNotificationCount, 1);

    const zhWm = popups.find((p) => p.kind === "watermark_critical");
    const zhTtl = popups.find((p) => p.kind === "ttl_expiring");
    assert.ok(zhWm && zhTtl);
    assert.ok(zhWm.title.includes("：上下文快满了"), `Unexpected ZH watermark title: ${zhWm.title}`);
    assert.ok(zhWm.body.includes("420k/512k (82%)") && zhWm.body.includes("交接简报") && zhWm.body.includes("/compact"));
    assert.ok(zhWm.body.includes("多窗口上下文快满了"));
    assert.equal(zhTtl.title, "agy-dart [work/agy-dart]：缓存即将过期");
    assert.ok(zhTtl.body.includes("【work/agy-dart · 检查dart项目并优化】"));
    assert.ok(zhTtl.body.includes("279k 上下文热缓存"));

    // 2. Subsequent tick deduplicates critical watermark; `/compact` -> `ok` resets; next `critical` fires again!
    advanceSec(5);
    monitor.tick();
    assert.equal(monitor.watermarkNotificationCount, 1, "Critical watermark must fire only once before compaction");

    advanceSec(5);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-wm-zh", lastUserInput: "/compact" },
      { nowMs, contextTokens: 45000, windowTokens: 512000, watermark: "ok" }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-wm-zh" }, { nowMs });
    monitor.tick();
    assert.equal(monitor.watermarkNotificationCount, 1, "Compaction back to ok resets state silently");

    // Explicit watermarkDesktopNotify: false suppresses even when re-entering critical
    cfgState.watermarkDesktopNotify = false;
    advanceSec(5);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-wm-zh" },
      { nowMs, contextTokens: 430000, windowTokens: 512000, watermark: "critical" }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-wm-zh" }, { nowMs });
    monitor.tick();
    assert.equal(monitor.watermarkNotificationCount, 1, "watermarkDesktopNotify=false must suppress popup");

    // Re-enable in English (`uiLang: 'en'`) + add an active stalled session (`故事/1`) -> test all 3 EN popups!
    popups.length = 0;
    cfgState.uiLang = "en";
    cfgState.watermarkDesktopNotify = true;
    allowActiveStat = true;
    advanceSec(70);

    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-ttl-en", lastUserInput: "TOP_SECRET_NEVER_LEAK" },
      {
        nowMs: nowMs - 260_000,
        cwd: "e:\\mys",
        convTitle: "Fix auth token refresh",
        contextTokens: 207000,
        cacheTtlSec: 300
      }
    );
    recordHookLeaseTransition(store, "Stop", { conversationId: "conv-ttl-en" }, { nowMs: nowMs - 255_000 });

    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: "conv-stall-en", lastUserInput: "TOP_SECRET_NEVER_LEAK" },
      {
        nowMs: nowMs - 300_000,
        cwd: "e:\\故事\\1",
        convTitle: "第一章大纲润色",
        contextTokens: 185000
      }
    );

    monitor.tick();
    const enWm = popups.find((p) => p.kind === "watermark_critical");
    const enTtl = popups.find((p) => p.kind === "ttl_expiring");
    const enStall = popups.find((p) => p.conversationId === "conv-stall-en");
    assert.ok(enWm && enTtl && enStall, `Expected all 3 EN popups, got: ${JSON.stringify(popups)}`);
    assert.ok(enWm.title.includes(": Context Almost Full"));
    assert.ok(enWm.body.includes("430k/512k (84%)") && enWm.body.includes("Handoff Brief"));
    assert.equal(enTtl.title, "agy-dart [mys]: KV-Cache Expiring");
    assert.ok(enTtl.body.includes("[mys · Fix auth token refresh] 207k"));
    assert.equal(enStall.title, "agy-dart [故事/1]: Session Stalled");
    assert.ok(enStall.body.includes("[故事/1 · 第一章大纲润色]") && enStall.body.includes("Rescue Handoff Brief"));

    // Verify Windows NotifyIcon hard byte limits & zero prompt leakage across ALL emitted popups
    for (const p of [zhWm, zhTtl, enWm, enTtl, enStall]) {
      assert.ok(Buffer.byteLength(p.title, "utf8") <= 60, `Title exceeded 60B: ${p.title}`);
      assert.ok(Buffer.byteLength(p.body, "utf8") <= 220, `Body exceeded 220B: ${p.body}`);
      assert.ok(!p.title.includes("\uFFFD") && !p.body.includes("\uFFFD"));
      assert.equal(p.title.includes("TOP_SECRET_NEVER_LEAK"), false);
      assert.equal(p.body.includes("TOP_SECRET_NEVER_LEAK"), false);
      const spec = buildDesktopNotificationCommand({ title: p.title, body: p.body, platform: "win32", baseEnv: {} });
      assert.ok(Buffer.byteLength(spec.safeTitle, "utf8") <= 60);
      assert.ok(Buffer.byteLength(spec.safeBody, "utf8") <= 220);
    }

    // Verify buildWindowNotificationPrefix fallback matrix
    assert.deepEqual(buildWindowNotificationPrefix({ conversationId: "abcd1234" }, { isZh: true }), {
      titleTag: "",
      bodyPrefix: ""
    });
    assert.equal(
      buildWindowNotificationPrefix({ conversationId: "abcd1234", workspaceLabel: "mys" }, { isZh: true }).bodyPrefix,
      "【窗口: mys #abcd】"
    );
    assert.equal(
      buildWindowNotificationPrefix({ conversationId: "abcd1234", convTitle: "独立标题" }, { isZh: true }).bodyPrefix,
      "【独立标题】"
    );
  } finally {
    store.close();
    if (prevWmEnv === undefined) delete process.env.AGY_DART_WATERMARK_DESKTOP_NOTIFY;
    else process.env.AGY_DART_WATERMARK_DESKTOP_NOTIFY = prevWmEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.3-4: PreInvocation chat banner window badge & Sidecar wd-other-alerts workspace/title rendering (XSS-safe)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v153-e2e-"));
  try {
    const dbPath = path.join(tmpDir, "context.db");
    const agRoot = path.join(tmpDir, "antigravity");
    const convId = "117e335d-aaaa-4bbb-8ccc-000011112222";
    const logDir = path.join(agRoot, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const txPath = path.join(logDir, "transcript.jsonl");

    const sumDb = new DatabaseSync(path.join(agRoot, "conversation_summaries.db"));
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
    sumDb
      .prepare(
        "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(convId, "修复多窗口告警定位", JSON.stringify(["file:///e%3A/work"]), "Antigravity", "", 0);
    sumDb.close();

    fs.writeFileSync(
      txPath,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: new Date().toISOString(),
        model: "Gemini 4 Carbon (High)",
        input_tokens: 430000,
        cache_read_tokens: 380000
      }) + "\n",
      "utf8"
    );

    const seedStore = new ContextModeStore({ dbPath });
    seedStore.setUiLang("zh");
    seedStore.recordModifiedFiles(convId, ["e:\\work\\agy-dart\\context\\lib\\watchdog.js"], {
      worktree: "e:\\work",
      tool: "apply_edits"
    });
    seedStore.close();

    const rHook = runHookProcess(
      "hooks/pre-invocation.mjs",
      {
        conversationId: convId,
        cwd: "e:\\work",
        transcriptPath: txPath,
        lastUserInput: "SECRET_USER_INPUT_999"
      },
      {
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing.json"),
        AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1"
      }
    );
    assert.equal(rHook.status, 0);
    assert.equal(Buffer.byteLength(rHook.stderr || "", "utf8"), 0, "PreInvocation must emit 0 bytes on stderr");
    const out = JSON.parse(rHook.stdout.trim());
    assert.equal(out.injectSteps[0].systemMessage.systemMessage, "", "systemMessage must remain strictly empty");
    const md = out.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.ok(md.includes("[agy-dart 缓存守卫]"));
    assert.ok(md.includes("窗口 `work/agy-dart`（修复多窗口告警定位）"), `Expected window identity badge in: ${md}`);
    assert.equal(md.includes("SECRET_USER_INPUT_999"), false);

    const verifyStore = new ContextModeStore({ dbPath });
    try {
      const savedLease = readWatchdogLease(verifyStore, convId);
      assert.equal(savedLease.workspaceLabel, "work/agy-dart");
      assert.equal(savedLease.convTitle, "修复多窗口告警定位");
      assert.equal(savedLease.watermark, "critical");
      assert.equal(savedLease.windowTokens, 512000);
    } finally {
      verifyStore.close();
    }

    // Verify Sidecar index.html `wd-other-alerts` renders `workspaceLabel · convTitle` + hover `title` + escapes XSS
    const htmlSrc = readDashboardHtml();
    const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const makeEl = () => ({
      textContent: "",
      innerHTML: "",
      title: "",
      className: "",
      style: {},
      dataset: {},
      classList: {
        _s: new Set(["hidden"]),
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
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getAttribute() { return ""; },
      setAttribute() {}
    });
    const elements = new Map();
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    };
    const ctx = vm.createContext({
      window: { location: { search: "", href: "http://127.0.0.1:4321/" }, addEventListener() {} },
      document: {
        hidden: false,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "tok" }),
        querySelectorAll: () => [],
        addEventListener() {}
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      Headers,
      URLSearchParams,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      Date,
      Math,
      Number,
      String,
      Array,
      Object,
      JSON,
      Promise,
      RegExp,
      Error,
      Map,
      Set,
      encodeURIComponent,
      decodeURIComponent,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      console: { log() {}, warn() {}, error() {} }
    });
    vm.runInContext(scriptMatch[1], ctx);

    const mockWd = {
      enabled: true,
      desktopNotifyEnabled: true,
      ttlDesktopNotifyEnabled: true,
      uiLang: "zh",
      uiLangSource: "sqlite",
      current: { conversationId: "cur-conv-id", phase: "IDLE", severity: "idle" },
      alertingSessions: [
        {
          conversationId: "38caeca3-9999-4444-8888-ffffffffffff",
          workspaceLabel: "work/agy-dart",
          convTitle: "检查dart项目 <img src=x onerror=alert(1)>",
          severity: "stalled",
          silentSec: 245,
          isSubagent: false
        },
        {
          conversationId: "abcdef1234567890",
          workspaceLabel: "",
          convTitle: "",
          severity: "suspect",
          silentSec: 95,
          isSubagent: false
        }
      ]
    };
    vm.runInContext("renderWatchdogCard(wdSample);", Object.assign(ctx, { wdSample: mockWd }));
    const otherHtml = elements.get("wd-other-alerts").innerHTML;
    assert.ok(otherHtml.includes("work/agy-dart · 检查dart项目 &lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(!otherHtml.includes("<img"), "wd-other-alerts must escape XSS in workspaceLabel/convTitle");
    assert.ok(otherHtml.includes('title="38caeca3-9999-4444-8888-ffffffffffff"'));
    assert.ok(otherHtml.includes(">abcdef12:"), "Sessions without workspace/title must fall back to 8-char conversationId");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
