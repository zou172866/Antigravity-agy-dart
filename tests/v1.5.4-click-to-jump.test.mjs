import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { suppressSqliteExperimentalWarning } from "../hooks/compile-cache.mjs";
import { resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  DEFAULT_PENDING_JUMP_TTL_MS,
  NOTIFY_CLICK_EXIT_CODE,
  NOTIFY_CLICK_STDOUT_TOKEN,
  PENDING_JUMP_META_KEY,
  WIN32_WINDOW_FOCUS_CSHARP,
  WatchdogMonitor,
  buildDesktopNotificationCommand,
  buildWindowFocusCommand,
  focusDesktopConversationWindow,
  sendDesktopNotification
} from "../context/lib/watchdog.js";
import { recordHookLeaseTransition } from "../context/lib/watchdog-lease.js";
import {
  closeRuntimeStore,
  createStandaloneServer,
  registerSidecarRoutes
} from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

suppressSqliteExperimentalWarning();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function httpJsonRequest(port, reqPath, { method = "POST", headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (rawBody !== undefined && !reqHeaders["Content-Length"] && !reqHeaders["content-length"]) {
      reqHeaders["Content-Length"] = Buffer.byteLength(rawBody, "utf8");
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: reqHeaders
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          chunks += c;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(chunks);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json: parsed, text: chunks });
        });
      }
    );
    req.on("error", reject);
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

test("v1.5.4-1: Desktop notification click loop, exit-code 42 + stdout fast-path protocol, zero-injection env indirection & Win32 window scoring", () => {
  const evilTitle = "$(calc.exe); `whoami` \"' " + "W".repeat(80);
  const evilBody = "--urgency=critical; Invoke-Expression evil\r\nsecond line";
  const evilCwd = "e:\\故事\\1\\$(Start-Process calc)";
  const evilWs = "故事/1'; calc.exe; #";
  const evilConvTitle = "第一章大纲润色 $(evil) 'quote'...";

  const winSpec = buildDesktopNotificationCommand({
    title: evilTitle,
    body: evilBody,
    conversationId: "conv-jump-win-01",
    cwd: evilCwd,
    workspaceLabel: evilWs,
    convTitle: evilConvTitle,
    lastUserInput: "TOP_SECRET_PROMPT_NEVER_LEAK",
    platform: "win32",
    baseEnv: {}
  });

  assert.equal(winSpec.cmd, "powershell.exe");
  assert.ok(Buffer.byteLength(winSpec.safeTitle, "utf8") <= 60);
  assert.ok(Buffer.byteLength(winSpec.safeBody, "utf8") <= 220);
  assert.equal(winSpec.env.AGY_DART_NOTIFY_TITLE, winSpec.safeTitle);
  assert.equal(winSpec.env.AGY_DART_NOTIFY_BODY, winSpec.safeBody);
  assert.equal(winSpec.env.AGY_DART_NOTIFY_CONV_ID, "conv-jump-win-01");
  assert.ok(winSpec.env.AGY_DART_NOTIFY_CWD.includes("故事"));
  assert.equal(winSpec.env.AGY_DART_NOTIFY_WS_LABEL, evilWs);
  assert.ok(winSpec.env.AGY_DART_NOTIFY_CONV_TITLE.startsWith("第一章大纲润色"));

  const joinedArgs = winSpec.args.join(" ");
  assert.equal(WIN32_WINDOW_FOCUS_CSHARP.includes("'"), false, "C# source must contain zero single quotes for PS single-quoted embedding");
  assert.ok(joinedArgs.includes("add_BalloonTipClicked"), "Must bind BalloonTipClicked");
  assert.ok(joinedArgs.includes("Application]::DoEvents()"), "Must pump WinForms message loop");
  assert.ok(joinedArgs.includes(`[Environment]::Exit(${NOTIFY_CLICK_EXIT_CODE})`));
  const addTypePos = joinedArgs.indexOf("Add-Type -TypeDefinition");
  const clickTokenPos = joinedArgs.indexOf(`WriteLine('${NOTIFY_CLICK_STDOUT_TOKEN}')`);
  const focusBestPos = joinedArgs.indexOf("[AgyDartWinFocus]::FocusBest(");
  assert.ok(
    addTypePos > 0 && clickTokenPos > addTypePos && focusBestPos > clickTokenPos,
    "Click sequence must compile Add-Type FIRST, then flush AGY_CLICKED, then invoke [AgyDartWinFocus]::FocusBest"
  );
  assert.equal(joinedArgs.includes("calc"), false, "Untrusted fields must NEVER be interpolated into PowerShell args");
  assert.equal(joinedArgs.includes("第一章大纲润色"), false, "convTitle must be passed via env only");
  assert.equal(JSON.stringify(winSpec).includes("TOP_SECRET_PROMPT_NEVER_LEAK"), false, "lastUserInput must never enter spec/env");

  const focusSpec = buildWindowFocusCommand({
    conversationId: "conv-jump-win-01",
    cwd: "file:///e%3A/%E6%95%85%E4%BA%8B/1",
    workspaceLabel: evilWs,
    convTitle: evilConvTitle,
    platform: "win32",
    baseEnv: {}
  });
  assert.equal(focusSpec.cmd, "powershell.exe");
  assert.equal(focusSpec.args.join(" ").includes("calc.exe"), false);
  assert.ok(focusSpec.env.AGY_DART_NOTIFY_CWD.endsWith(path.join("故事", "1")) || focusSpec.env.AGY_DART_NOTIFY_CWD.includes("故事/1"));

  const macFocus = buildWindowFocusCommand({ conversationId: "c1", platform: "darwin", baseEnv: {} });
  assert.equal(macFocus.cmd, "osascript");
  const linFocus = focusDesktopConversationWindow({ conversationId: "c1", platform: "linux" });
  assert.equal(linFocus.dispatched, false, "Headless Linux focus fails open cleanly without spawning missing tools");

  // Verify sendDesktopNotification click callback deduplication across stdout token + exit code 42
  const makeFakeSpawn = () => {
    const calls = [];
    const spawnFn = (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.unref = () => {};
      child.unref = () => {};
      child.kill = () => {};
      calls.push({ cmd, args, opts, child });
      return child;
    };
    return { calls, spawnFn };
  };

  // Case A: Both stdout token AND exit code 42 -> fires onClick EXACTLY ONCE
  {
    const { calls, spawnFn } = makeFakeSpawn();
    const clicks = [];
    const res = sendDesktopNotification({
      title: "agy-dart [故事/1]：缓存即将过期",
      body: "Body",
      conversationId: "conv-click-once",
      cwd: "e:\\故事\\1",
      workspaceLabel: "故事/1",
      convTitle: "第一章大纲",
      platform: "win32",
      spawnFn,
      onClick: (info) => clicks.push(info)
    });
    assert.equal(res.dispatched, true);
    assert.equal(calls.length, 1);
    calls[0].child.stdout.emit("data", Buffer.from(`${NOTIFY_CLICK_STDOUT_TOKEN}\r\n`, "utf8"));
    assert.equal(clicks.length, 1, "Stdout fast-path token must trigger onClick immediately before C# compile finishes");
    calls[0].child.emit("close", NOTIFY_CLICK_EXIT_CODE);
    calls[0].child.emit("exit", NOTIFY_CLICK_EXIT_CODE);
    assert.equal(clicks.length, 1, "Subsequent exit code 42 must NOT double-fire onClick");
    assert.equal(clicks[0].conversationId, "conv-click-once");
    assert.equal(clicks[0].workspaceLabel, "故事/1");
  }

  // Case B: Exit code 42 alone (without stdout) -> fires onClick; exit code 0 -> does NOT fire onClick
  {
    const { calls, spawnFn } = makeFakeSpawn();
    let clicked42 = 0;
    let clicked0 = 0;
    sendDesktopNotification({
      conversationId: "conv-42",
      platform: "win32",
      spawnFn,
      onClick: () => { clicked42 += 1; }
    });
    sendDesktopNotification({
      conversationId: "conv-0",
      platform: "win32",
      spawnFn,
      onClick: () => { clicked0 += 1; }
    });
    calls[0].child.emit("close", NOTIFY_CLICK_EXIT_CODE);
    calls[1].child.emit("close", 0);
    assert.equal(clicked42, 1);
    assert.equal(clicked0, 0);
  }

  // Case C: On Windows, verify C# 5.0 P/Invoke compiles in PowerShell 5.1 with 0 stderr & scores multi-window titles accurately
  if (process.platform === "win32") {
    const psVerify = [
      `Add-Type -TypeDefinition '${WIN32_WINDOW_FOCUS_CSHARP}' -ErrorAction Stop;`,
      "$sTarget = [AgyDartWinFocus]::ScoreWindow('第一章大纲润色与细节扩写 - 1 - Antigravity', 'Antigravity', '第一章大纲润色...', '故事/1', 'e:\\故事\\1');",
      "$sCwdOnly = [AgyDartWinFocus]::ScoreWindow('其他对话 - 1 - Antigravity', 'Antigravity', '未命中标题', '故事/1', 'e:\\故事\\1');",
      "$sOtherWs = [AgyDartWinFocus]::ScoreWindow('work - Antigravity', 'Antigravity', '第一章大纲润色...', '故事/1', 'e:\\故事\\1');",
      "$sLauncher = [AgyDartWinFocus]::ScoreWindow('Antigravity', 'Antigravity Launcher', '第一章大纲润色...', '故事/1', 'e:\\故事\\1');",
      "$sBrowser = [AgyDartWinFocus]::ScoreWindow('第一章大纲润色 - 1 - Antigravity', 'msedge', '第一章大纲润色...', '故事/1', 'e:\\故事\\1');",
      "$sDesktop2Trunc = [AgyDartWinFocus]::ScoreWindow('Transcript Batch Cleaning...', 'Antigravity', 'Transcript Batch Cleaning St...', 'mys', 'e:\\mys');",
      "$sFalseSubstr = [AgyDartWinFocus]::ScoreWindow('Happy Coding - Antigravity', 'Antigravity', 'Unmatched Title', 'a/app', 'd:\\a\\app');",
      "$sCompositeHit = [AgyDartWinFocus]::ScoreWindow('chap - 故事/1 - Antigravity', 'Antigravity', '未命中标题', '故事/1', 'e:\\故事\\1');",
      "$sSiblingLeaf = [AgyDartWinFocus]::ScoreWindow('chap - 架构/1 - Antigravity', 'Antigravity', '未命中标题', '故事/1', 'e:\\故事\\1');",
      "$sDevTools = [AgyDartWinFocus]::ScoreWindow('Developer Tools - http://127.0.0.1:8765', 'Antigravity', 'Transcript', 'work', 'e:\\work');",
      '[Console]::Out.WriteLine("$sTarget,$sCwdOnly,$sOtherWs,$sLauncher,$sBrowser,$sDesktop2Trunc,$sFalseSubstr,$sCompositeHit,$sSiblingLeaf,$sDevTools");'
    ].join(" ");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psVerify], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    assert.equal(r.status, 0, `PowerShell C# compile failed: ${r.stderr}`);
    assert.equal(Buffer.byteLength(r.stderr || "", "utf8"), 0, "Win32 C# helper must compile with 0 stderr bytes");
    const scores = r.stdout.trim().split(",").map((n) => Number(n));
    assert.equal(scores.length, 10);
    const [
      sTarget,
      sCwdOnly,
      sOtherWs,
      sLauncher,
      sBrowser,
      sDesktop2Trunc,
      sFalseSubstr,
      sCompositeHit,
      sSiblingLeaf,
      sDevTools
    ] = scores;
    assert.ok(sTarget > sCwdOnly && sCwdOnly > sOtherWs && sOtherWs > 0, `Unexpected score ordering: ${scores}`);
    assert.equal(sLauncher, -1, "Must reject Antigravity Launcher process");
    assert.equal(sBrowser, -1, "Must reject browser process even with matching window title");
    assert.ok(sDesktop2Trunc >= 950, `Must match Desktop 2.0 truncated OS window title ('Transcript Batch Cleaning...'), got ${sDesktop2Trunc}`);
    assert.equal(sFalseSubstr, 20, `Must NOT match 'app' inside 'Happy' without token boundaries, got ${sFalseSubstr}`);
    assert.ok(sCompositeHit > sSiblingLeaf + 400, `Composite '故事/1' (${sCompositeHit}) must decisively beat sibling '架构/1' (${sSiblingLeaf})`);
    assert.equal(sDevTools, -1, "Must reject Developer Tools window");
  }
});

test("v1.5.4-2: WatchdogMonitor 3-popup click callbacks, cross-process SQLite pendingJump, 20s TTL expiry, ackJump idempotency, summary DB fallback & 0 statSync", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v154-monitor-"));
  resetConfigCache();
  const dbPath = path.join(tmpDir, "context.db");
  const storeA = new ContextModeStore({ dbPath });
  const storeB = new ContextModeStore({ dbPath });

  try {
    // Seed a synthetic conversation_summaries.db for lease-less focusConversation fallback
    const agRoot = path.join(tmpDir, "antigravity");
    fs.mkdirSync(agRoot, { recursive: true });
    const sumDbPath = path.join(agRoot, "conversation_summaries.db");
    const sumDb = new DatabaseSync(sumDbPath);
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_uris TEXT NOT NULL
      );
    `);
    sumDb
      .prepare("INSERT INTO conversation_summaries (conversation_id, title, workspace_uris) VALUES (?, ?, ?)")
      .run("conv-summary-only", "历史对话跨窗口恢复", JSON.stringify(["file:///e%3A/%E6%95%85%E4%BA%8B/1"]));
    sumDb.close();

    let nowMs = 1_800_000_000_000;
    let monoNs = 80_000_000_000n;
    const advanceMs = (ms) => {
      nowMs += ms;
      monoNs += BigInt(ms) * 1_000_000n;
    };

    const cfgState = {
      stallWatchdog: true,
      watchdogPollMs: 5000,
      watchdogDesktopNotify: true,
      ttlKeepalive: true,
      ttlDesktopNotify: true,
      ttlNotifyLeadSec: 60,
      ttlNotifyMinTokens: 60000,
      watermarkDesktopNotify: true,
      uiLang: "zh"
    };

    const popups = [];
    const focusCalls = [];
    let allowStat = false;

    const monitorA = new WatchdogMonitor({
      getStore: () => storeA,
      getConfig: () => cfgState,
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      lookupSummaryFn: (convId) => {
        const db = new DatabaseSync(sumDbPath, { readOnly: true });
        try {
          const row = db.prepare("SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?").get(convId);
          if (!row) return { title: "", cwd: "" };
          return { title: row.title, cwd: "e:\\故事\\1" };
        } finally {
          db.close();
        }
      },
      statFn: () => {
        monitorA.statSyncCount += 1;
        if (!allowStat) throw new Error("All-IDLE path must NEVER call statSync");
        return { isFile: () => false };
      },
      notifyFn: (p) => {
        popups.push(p);
        return { dispatched: true };
      },
      focusWindowFn: (f) => {
        focusCalls.push(f);
        return { dispatched: true, platform: "win32" };
      }
    });

    // Separate Sidecar process monitor reading shared SQLite DB (even with watchdog disabled!)
    const monitorB = new WatchdogMonitor({
      getStore: () => storeB,
      getConfig: () => ({ ...cfgState, stallWatchdog: false }),
      nowFn: () => nowMs,
      monoNsFn: () => monoNs,
      findTranscriptFn: () => null,
      statFn: () => {
        monitorB.statSyncCount += 1;
        throw new Error("IDLE monitorB must NEVER call statSync");
      },
      notifyFn: () => ({ dispatched: true })
    });

    // 1. Trigger IDLE TTL + Critical Watermark popups -> 0 statSync -> click each popup!
    recordHookLeaseTransition(
      storeA,
      "PreInvocation",
      { conversationId: "conv-ttl-jump" },
      {
        nowMs: nowMs - 260_000,
        cwd: "e:\\work",
        workspaceLabel: "work/agy-dart",
        convTitle: "优化点击跳转",
        contextTokens: 210_000,
        cacheTtlSec: 300
      }
    );
    recordHookLeaseTransition(storeA, "Stop", { conversationId: "conv-ttl-jump" }, { nowMs: nowMs - 255_000 });

    recordHookLeaseTransition(
      storeA,
      "PreInvocation",
      { conversationId: "conv-wm-jump" },
      {
        nowMs: nowMs - 10_000,
        cwd: "e:\\故事\\1",
        workspaceLabel: "故事/1",
        convTitle: "满水位章节写作",
        contextTokens: 430_000,
        windowTokens: 512_000,
        watermark: "critical"
      }
    );
    recordHookLeaseTransition(storeA, "Stop", { conversationId: "conv-wm-jump" }, { nowMs: nowMs - 5_000 });

    monitorA.tick();
    assert.equal(monitorA.statSyncCount, 0, "All-IDLE tick must perform 0 statSync");
    const ttlPopup = popups.find((p) => p.kind === "ttl_expiring");
    const wmPopup = popups.find((p) => p.kind === "watermark_critical");
    assert.ok(ttlPopup && typeof ttlPopup.onClick === "function");
    assert.ok(wmPopup && typeof wmPopup.onClick === "function");

    // Simulate user clicking TTL desktop popup
    ttlPopup.onClick();
    const stB = monitorB.getStatus({ conversationId: "other-conv" });
    assert.equal(monitorB.statSyncCount, 0, "Reading pendingJump in getStatus must perform 0 statSync");
    assert.equal(stB.enabled, false, "monitorB has watchdog disabled");
    assert.ok(stB.pendingJump, "pendingJump must still be returned when watchdog is disabled");
    assert.equal(stB.pendingJump.conversationId, "conv-ttl-jump");
    assert.equal(stB.pendingJump.workspaceLabel, "work/agy-dart");
    assert.equal(stB.pendingJump.convTitle, "优化点击跳转");
    assert.equal(stB.pendingJump.expiresTs - stB.pendingJump.createdTs, DEFAULT_PENDING_JUMP_TTL_MS);

    // 2. Test 20s TTL auto-expiration & cleanup from SQLite meta
    advanceMs(DEFAULT_PENDING_JUMP_TTL_MS + 1);
    const stExpired = monitorB.getStatus({ conversationId: "other-conv" });
    assert.equal(stExpired.pendingJump, null, "Expired pendingJump must auto-clear after 20s");
    assert.equal(storeA.getMeta(PENDING_JUMP_META_KEY, null), null, "Expired ticket must be deleted from SQLite meta");

    // 3. Click Watermark popup + test ackJump validation & idempotency
    wmPopup.onClick();
    const wmJump = monitorA.getPendingConversationJump();
    assert.ok(wmJump && wmJump.conversationId === "conv-wm-jump");
    assert.equal(monitorA.acknowledgePendingJump("").ok, false);
    assert.equal(monitorA.acknowledgePendingJump("bad space!").ok, false);
    const ack1 = monitorB.acknowledgePendingJump(wmJump.jumpId);
    assert.deepEqual(ack1, {
      ok: true,
      acknowledged: true,
      jumpId: wmJump.jumpId,
      conversationId: "conv-wm-jump"
    });
    assert.equal(monitorA.getPendingConversationJump(), null);
    const ackRepeat = monitorB.acknowledgePendingJump(wmJump.jumpId);
    assert.equal(ackRepeat.ok, true);
    assert.equal(ackRepeat.acknowledged, false, "Repeat ackJump must be idempotent without failing");

    // 4. Stalled popup onClick + focusConversation summary DB fallback & skipOsFocus
    allowStat = true;
    recordHookLeaseTransition(
      storeA,
      "PreInvocation",
      { conversationId: "conv-stall-jump" },
      {
        nowMs: nowMs - 300_000,
        cwd: "e:\\mys",
        convTitle: "卡死会话跳转验证",
        contextTokens: 150_000
      }
    );
    monitorA.tick();
    const stallPopup = popups.find((p) => p.conversationId === "conv-stall-jump");
    assert.ok(stallPopup && typeof stallPopup.onClick === "function");
    stallPopup.onClick();
    assert.equal(monitorA.getPendingConversationJump()?.conversationId, "conv-stall-jump");

    // focusConversation for a historic session without lease falls back to conversation_summaries.db
    const focusRes = monitorA.focusConversation("conv-summary-only");
    assert.equal(focusRes.ok, true);
    assert.equal(focusRes.focused, true);
    assert.equal(focusRes.pendingJump.workspaceLabel, "故事/1");
    assert.equal(focusRes.pendingJump.convTitle, "历史对话跨窗口恢复");
    assert.equal(focusCalls.length, 1);
    assert.equal(focusCalls[0].convTitle, "历史对话跨窗口恢复");

    // skipOsFocus: true records ticket without spawning OS window focus
    const sameWinRes = monitorA.focusConversation("conv-summary-only", { skipOsFocus: true });
    assert.equal(sameWinRes.ok, true);
    assert.equal(sameWinRes.focused, false);
    assert.equal(focusCalls.length, 1);

    // Invalid conversationIds rejected
    assert.equal(monitorA.focusConversation("").ok, false);
    assert.equal(monitorA.focusConversation("default").ok, false);
    assert.equal(monitorA.focusConversation("../evil").ok, false);
  } finally {
    storeA.close();
    storeB.close();
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-3: Sidecar /api/watchdog/action focusConversation & ackJump auth, validation & SidecarApp POST parity", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v154-server-"));
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = path.join(tmpDir, "context.db");
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing.json");
  resetConfigCache();
  closeRuntimeStore();

  const csrfToken = "csrf-v154-test-token-1234567890";
  const focusedPayloads = [];
  let srv = null;

  try {
    const seedStore = new ContextModeStore({ dbPath: process.env.AGY_DART_DB_PATH });
    recordHookLeaseTransition(
      seedStore,
      "PreInvocation",
      { conversationId: "conv-cross-target" },
      {
        cwd: "e:\\故事\\1",
        workspaceLabel: "故事/1",
        convTitle: "跨窗口目标对话",
        contextTokens: 168_000
      }
    );
    recordHookLeaseTransition(seedStore, "Stop", { conversationId: "conv-cross-target" }, {});
    seedStore.close();

    srv = createStandaloneServer({
      csrfToken,
      watchdogOptions: {
        findTranscriptFn: () => null,
        notifyFn: () => ({ dispatched: true }),
        focusWindowFn: (p) => {
          focusedPayloads.push(p);
          return { dispatched: true, platform: "win32" };
        }
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const authHeaders = {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken
    };

    // 1. Unauthenticated / bad-type / invalid parameters -> rejected
    const unauth = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: { "Content-Type": "application/json" },
      body: { action: "focusConversation", conversationId: "conv-cross-target" }
    });
    assert.equal(unauth.status, 403);

    const nonStringJumpId = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: authHeaders,
      body: { action: "ackJump", jumpId: 12345 }
    });
    assert.equal(nonStringJumpId.status, 400);

    const badSkipFlag = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: authHeaders,
      body: { action: "focusConversation", conversationId: "conv-cross-target", skipOsFocus: "yes" }
    });
    assert.equal(badSkipFlag.status, 400);

    const emptyFocus = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: authHeaders,
      body: { action: "focusConversation", conversationId: "" }
    });
    assert.equal(emptyFocus.status, 400);

    const emptyAck = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: authHeaders,
      body: { action: "ackJump", jumpId: "" }
    });
    assert.equal(emptyAck.status, 400);

    // 2. Valid focusConversation -> dispatches focusWindowFn + persists pendingJump visible in /api/watchdog
    const focusRes = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: authHeaders,
      body: { action: "focusConversation", conversationId: "conv-cross-target" }
    });
    assert.equal(focusRes.status, 200);
    assert.equal(focusRes.json.ok, true);
    assert.equal(focusRes.json.focused, true);
    assert.equal(focusedPayloads.length, 1);
    assert.equal(focusedPayloads[0].workspaceLabel, "故事/1");
    const jumpId = focusRes.json.pendingJump?.jumpId;
    assert.ok(jumpId);

    const wdPoll = await httpJsonRequest(port, "/api/watchdog", {
      headers: authHeaders,
      body: { scope: "conversation", conversationId: "conv-other" }
    });
    assert.equal(wdPoll.status, 200);
    assert.equal(wdPoll.json.pendingJump?.jumpId, jumpId);
    assert.equal(wdPoll.json.pendingJump?.conversationId, "conv-cross-target");

    // 3. ackJump consumes pendingJump cleanly
    const ackRes = await httpJsonRequest(port, "/api/watchdog/action", {
      headers: authHeaders,
      body: { action: "ackJump", jumpId }
    });
    assert.equal(ackRes.status, 200);
    assert.equal(ackRes.json.ok, true);
    assert.equal(ackRes.json.acknowledged, true);
    assert.equal(ackRes.json.status?.pendingJump, null);

    // 4. SidecarApp route parity
    const routes = [];
    registerSidecarRoutes({
      config: { conversationId: "conv-host-default" },
      api(routePath, handler, method = "POST") {
        routes.push({ routePath, handler, method });
      }
    });
    const actRoute = routes.find((r) => r.routePath === "/api/watchdog/action");
    assert.ok(actRoute && actRoute.method === "POST");
    assert.equal(actRoute.handler({ action: "ackJump", jumpId: ["bad"] }).status, 400);
    assert.equal(
      actRoute.handler({ action: "focusConversation", conversationId: "" }).status,
      400,
      "SidecarApp mode must reject explicit empty conversationId instead of falling back to app.config.conversationId"
    );
    const scFocus = actRoute.handler({ action: "focusConversation", conversationId: "conv-cross-target", skipOsFocus: true });
    assert.equal(scFocus.ok, true);
    const scAck = actRoute.handler({ action: "ackJump", jumpId: scFocus.pendingJump.jumpId });
    assert.equal(scAck.ok, true);
    assert.equal(scAck.acknowledged, true);
  } finally {
    if (srv) {
      await new Promise((resolve) => srv.close(resolve));
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-4: Sidecar index.html VM test — alert & session-switcher click/Enter jump, workspace-priority pendingJump claim, 1200ms fallback & XSS safety", async () => {
  const htmlSrc = readDashboardHtml();
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  function createDashboardSandbox({ sidecar = undefined, search = "" } = {}) {
    const elements = new Map();
    const timers = [];
    let nextTimerId = 1;
    const apiCalls = [];
    let latestWatchdogState = {
      ok: true,
      enabled: true,
      desktopNotifyEnabled: true,
      ttlDesktopNotifyEnabled: true,
      uiLang: "zh",
      uiLangSource: "sqlite",
      pendingJump: null,
      current: { conversationId: "conv-cur", phase: "IDLE", severity: "idle", cwd: "e:\\work" },
      sessions: [],
      alertingSessions: []
    };

    const makeEl = (id) => {
      const listeners = new Map();
      return {
        id,
        textContent: "",
        innerText: "",
        innerHTML: "",
        title: "",
        value: "",
        className: "",
        style: {},
        dataset: {},
        options: [],
        listeners,
        classList: {
          _s: new Set(["hidden"]),
          add(...c) { c.forEach((x) => this._s.add(x)); },
          remove(...c) { c.forEach((x) => this._s.delete(x)); },
          contains(x) { return this._s.has(x); },
          toggle(x, f) {
            if (f === undefined) {
              if (this._s.has(x)) { this._s.delete(x); return false; }
              this._s.add(x);
              return true;
            }
            if (f) this._s.add(x); else this._s.delete(x);
            return Boolean(f);
          }
        },
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        dispatch(type, eventInit = {}) {
          const list = listeners.get(type) || [];
          for (const fn of list) fn({ type, ...eventInit });
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getAttribute() { return ""; },
        setAttribute() {}
      };
    };

    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const handleFetch = async (url, opts = {}) => {
      const parsedBody = opts.body ? JSON.parse(opts.body) : {};
      apiCalls.push({ url, method: opts.method || "GET", body: parsedBody });
      if (url === "/api/watchdog/action") {
        if (parsedBody.action === "focusConversation") {
          const ticket = {
            jumpId: `jmp_sim_${apiCalls.length}`,
            conversationId: parsedBody.conversationId,
            cwd: parsedBody.conversationId === "conv-same-ws" ? "e:\\work\\agy-dart" : "e:\\故事\\1",
            workspaceLabel: parsedBody.conversationId === "conv-same-ws" ? "work/agy-dart" : "故事/1",
            convTitle: "模拟会话"
          };
          latestWatchdogState = { ...latestWatchdogState, pendingJump: ticket };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              conversationId: parsedBody.conversationId,
              pendingJump: ticket,
              focused: !parsedBody.skipOsFocus,
              status: latestWatchdogState
            })
          };
        }
        if (parsedBody.action === "ackJump") {
          if (latestWatchdogState.pendingJump?.jumpId === parsedBody.jumpId) {
            latestWatchdogState = { ...latestWatchdogState, pendingJump: null };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, acknowledged: true, status: latestWatchdogState })
          };
        }
      }
      if (url === "/api/watchdog") {
        return { ok: true, status: 200, json: async () => latestWatchdogState };
      }
      if (url === "/api/stats") {
        return { ok: true, status: 200, json: async () => ({ version: "1.5.4" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const winListeners = new Map();
    const docListeners = new Map();
    const winObj = {
      location: { search, href: `http://127.0.0.1:4321/${search}` },
      sidecar,
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      }
    };
    if (sidecar && !sidecar.fetch) {
      sidecar.fetch = handleFetch;
    }

    const ctx = vm.createContext({
      window: winObj,
      document: {
        hidden: false,
        documentElement: { lang: "zh-CN" },
        getElementById: getEl,
        querySelector: () => ({ getAttribute: () => "csrf-tok" }),
        querySelectorAll: () => [],
        addEventListener(type, fn) {
          if (!docListeners.has(type)) docListeners.set(type, []);
          docListeners.get(type).push(fn);
        }
      },
      localStorage: { getItem: () => "zh", setItem() {} },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: handleFetch,
      Headers,
      URLSearchParams,
      setInterval: () => 999,
      clearInterval() {},
      setTimeout(fn, delay) {
        const id = nextTimerId++;
        timers.push({ id, fn, delay, cleared: false });
        return id;
      },
      clearTimeout(id) {
        const found = timers.find((t) => t.id === id);
        if (found) found.cleared = true;
      },
      Date,
      Math,
      Number,
      String,
      Boolean,
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
    return {
      ctx,
      elements,
      timers,
      apiCalls,
      winListeners,
      setWatchdogState(next) {
        latestWatchdogState = next;
      },
      getWatchdogState() {
        return latestWatchdogState;
      }
    };
  }

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  };

  // 1. Window A (`e:\work`): renders XSS-safe `#wd-other-alerts` + `#wd-session-switcher`, handles click + Enter, zero double-toggle on same-workspace
  const toggledInA = [];
  const boxA = createDashboardSandbox({
    sidecar: {
      conversationId: "conv-cur",
      getWorkspaceUris: async () => ["file:///e%3A/work"],
      ui: {
        toggleConversation(id) {
          toggledInA.push(id);
        }
      }
    }
  });
  await flushMicrotasks();
  boxA.apiCalls.length = 0;

  const sampleWd = {
    enabled: true,
    desktopNotifyEnabled: true,
    ttlDesktopNotifyEnabled: true,
    uiLang: "zh",
    uiLangSource: "sqlite",
    pendingJump: null,
    current: { conversationId: "conv-cur", phase: "IDLE", severity: "idle", cwd: "e:\\work" },
    sessions: [
      {
        conversationId: "conv-cur",
        cwd: "e:\\work",
        workspaceLabel: "work/agy-dart",
        convTitle: "当前开发会话",
        phase: "IDLE",
        severity: "idle",
        watermark: "ok",
        contextTokens: 96_000,
        isSubagent: false
      },
      {
        conversationId: "conv-same-ws",
        cwd: "e:\\work\\agy-dart",
        workspaceLabel: "work/agy-dart",
        convTitle: "同窗口高水位 <script>alert(1)</script>",
        phase: "IDLE",
        severity: "idle",
        watermark: "critical",
        contextTokens: 425_000,
        isSubagent: false
      },
      {
        conversationId: "conv-story-win",
        cwd: "e:\\故事\\1",
        workspaceLabel: "故事/1",
        convTitle: "跨窗口卡死会话 <img src=x onerror=alert(2)>",
        phase: "LLM_INFLIGHT",
        severity: "stalled",
        watermark: "warn",
        silentSec: 210,
        contextTokens: 185_000,
        isSubagent: false
      }
    ],
    alertingSessions: [
      {
        conversationId: "conv-story-win",
        cwd: "e:\\故事\\1",
        workspaceLabel: "故事/1",
        convTitle: "跨窗口卡死会话 <img src=x onerror=alert(2)>",
        severity: "stalled",
        silentSec: 210,
        isSubagent: false
      }
    ]
  };

  boxA.setWatchdogState(sampleWd);
  vm.runInContext("renderWatchdogCard(wdSample);", Object.assign(boxA.ctx, { wdSample: sampleWd }));
  await flushMicrotasks();

  const alertsEl = boxA.elements.get("wd-other-alerts");
  const switcherEl = boxA.elements.get("wd-session-switcher");
  assert.equal(alertsEl.classList.contains("hidden"), false);
  assert.equal(switcherEl.classList.contains("hidden"), false);
  assert.ok(!alertsEl.innerHTML.includes("<img") && !alertsEl.innerHTML.includes("<svg"));
  assert.ok(!switcherEl.innerHTML.includes("<script>") && !switcherEl.innerHTML.includes("<img"));
  assert.ok(alertsEl.innerHTML.includes('data-jump-conv="conv-story-win"'));
  assert.ok(switcherEl.innerHTML.includes('data-jump-conv="conv-same-ws"'));
  assert.ok(switcherEl.innerHTML.includes("425k"));

  // Click same-workspace pill in `#wd-session-switcher` -> skipOsFocus: true, toggleConversation called EXACTLY ONCE, auto-acked
  const sameWsPill = {
    dataset: { jumpConv: "conv-same-ws", jumpCwd: "e:\\work\\agy-dart" },
    classList: { add() {}, remove() {} }
  };
  switcherEl.dispatch("click", { target: { parentElement: sameWsPill } });
  await flushMicrotasks();

  assert.deepEqual(toggledInA, ["conv-same-ws"], "Same-workspace click must call toggleConversation once without echo double-toggle");
  const focusCallSame = boxA.apiCalls.find(
    (c) => c.url === "/api/watchdog/action" && c.body.action === "focusConversation"
  );
  assert.ok(focusCallSame);
  assert.equal(focusCallSame.body.conversationId, "conv-same-ws");
  assert.equal(focusCallSame.body.skipOsFocus, true, "Same-workspace click must set skipOsFocus=true");
  const ackCallSame = boxA.apiCalls.find(
    (c) => c.url === "/api/watchdog/action" && c.body.action === "ackJump"
  );
  assert.ok(ackCallSame, "Same-workspace click must immediately ack its own jump ticket");

  // Keyboard `Enter` on cross-window alert pill in `#wd-other-alerts` -> skipOsFocus omitted, leaves ticket for target window B
  let prevented = false;
  boxA.apiCalls.length = 0;
  alertsEl.dispatch("keydown", {
    key: "Enter",
    preventDefault() { prevented = true; },
    target: { dataset: { jumpConv: "conv-story-win", jumpCwd: "e:\\故事\\1" }, classList: { add() {}, remove() {} } }
  });
  await flushMicrotasks();
  assert.equal(prevented, true);
  assert.equal(toggledInA[toggledInA.length - 1], "conv-story-win");
  const focusCallCross = boxA.apiCalls.find(
    (c) => c.url === "/api/watchdog/action" && c.body.action === "focusConversation"
  );
  assert.ok(focusCallCross);
  assert.equal(focusCallCross.body.skipOsFocus, undefined, "Cross-workspace click must allow OS window foreground activation");
  assert.equal(
    vm.runInContext("getActiveConversationId()", boxA.ctx),
    "conv-same-ws",
    "Cross-workspace click must NOT hijack Window A's own inspected conversation"
  );

  // 2. Desktop Notification pendingJump: Window B (`file:///e%3A/%E6%95%85%E4%BA%8B/1`, even with watchdog disabled!) claims in 0ms; Window A waits 1200ms and skips once claimed
  const toggledInB = [];
  const boxB = createDashboardSandbox({
    sidecar: {
      conversationId: "conv-story-old",
      getWorkspaceUris: async () => ["file:///e%3A/%E6%95%85%E4%BA%8B/1"],
      ui: {
        toggleConversation(id) {
          toggledInB.push(id);
        }
      }
    }
  });
  await flushMicrotasks();
  boxA.apiCalls.length = 0;
  boxB.apiCalls.length = 0;

  const desktopTicket = {
    jumpId: "jmp_desktop_popup_99",
    conversationId: "conv-story-target",
    cwd: "e:\\故事\\1",
    workspaceLabel: "故事/1",
    convTitle: "第一章大纲"
  };

  // Non-matching Window A sees desktopTicket first -> must NOT toggle immediately; schedules 1200ms fallback
  const wdForA = { ...sampleWd, pendingJump: desktopTicket };
  boxA.setWatchdogState(wdForA);
  toggledInA.length = 0;
  vm.runInContext("renderWatchdogCard(wdDesktop);", Object.assign(boxA.ctx, { wdDesktop: wdForA }));
  await flushMicrotasks();
  assert.equal(toggledInA.length, 0, "Non-matching workspace window must NOT immediately claim another window's jump");
  const fallbackTimerA = boxA.timers.find((t) => t.delay === 1200 && !t.cleared);
  assert.ok(fallbackTimerA, "Non-matching visible window must arm 1200ms fallback timer");

  // Matching Window B (with enabled: false!) wakes up on focus and claims desktopTicket in 0ms!
  const wdForB = { ...sampleWd, enabled: false, pendingJump: desktopTicket };
  boxB.setWatchdogState(wdForB);
  vm.runInContext("renderWatchdogCard(wdDesktopB);", Object.assign(boxB.ctx, { wdDesktopB: wdForB }));
  await flushMicrotasks();
  assert.deepEqual(toggledInB, ["conv-story-target"], "Matching workspace window must claim pendingJump in 0ms even when Guard is paused");
  assert.ok(
    boxB.apiCalls.some((c) => c.url === "/api/watchdog/action" && c.body.action === "ackJump" && c.body.jumpId === "jmp_desktop_popup_99"),
    "Matching window must ackJump on server"
  );

  // Simulate shared DB now having pendingJump = null when Window A's 1200ms timer fires -> Window A does nothing!
  boxA.setWatchdogState({ ...sampleWd, pendingJump: null });
  await fallbackTimerA.fn();
  await flushMicrotasks();
  assert.equal(toggledInA.length, 0, "Fallback timer must abort once matching window already acked the jump");

  // If unclaimed after 1200ms (e.g. untitled workspace), fallback timer claims cleanly
  const unclaimedTicket = {
    jumpId: "jmp_unclaimed_77",
    conversationId: "conv-orphan-win",
    cwd: "",
    workspaceLabel: "",
    convTitle: "无目录对话"
  };
  boxA.setWatchdogState({ ...sampleWd, pendingJump: unclaimedTicket });
  vm.runInContext("renderWatchdogCard(wdUnclaimed);", Object.assign(boxA.ctx, { wdUnclaimed: { ...sampleWd, pendingJump: unclaimedTicket } }));
  await flushMicrotasks();
  const orphanTimer = boxA.timers.find((t) => t.delay === 1200 && !t.cleared && t !== fallbackTimerA);
  assert.ok(orphanTimer);
  await orphanTimer.fn();
  await flushMicrotasks();
  assert.deepEqual(toggledInA, ["conv-orphan-win"], "Unclaimed jump without workspace match must be claimed after 1200ms fallback");

  // 3. Standalone browser (`!window.sidecar`) NEVER steals pendingJump, but clicking a pill updates selectedConvOverride
  const boxBrowser = createDashboardSandbox({ sidecar: undefined, search: "?conversationId=conv-init" });
  await flushMicrotasks();
  boxBrowser.apiCalls.length = 0;
  const browserTicket = {
    jumpId: "jmp_browser_must_ignore",
    conversationId: "conv-host-only",
    cwd: "e:\\work"
  };
  vm.runInContext(
    "renderWatchdogCard(wdBr);",
    Object.assign(boxBrowser.ctx, { wdBr: { ...sampleWd, pendingJump: browserTicket } })
  );
  await flushMicrotasks();
  assert.equal(
    boxBrowser.apiCalls.some((c) => c.url === "/api/watchdog/action" && c.body.action === "ackJump"),
    false,
    "Standalone browser tab without window.sidecar must NEVER steal/ack pendingJump"
  );
  await vm.runInContext("jumpToConversation('conv-story-win', { cwd: 'e:\\\\故事\\\\1' })", boxBrowser.ctx);
  await flushMicrotasks();
  assert.equal(vm.runInContext("getActiveConversationId()", boxBrowser.ctx), "conv-story-win");
});

test("v1.5.4-5: Sidecar edge-case regressions — hanging getWorkspaceUris timeout, subproject vs umbrella isolation, rapid-click race, Desktop 2.0 onWorkspaceChange & sessionStorage reload guard", async () => {
  const htmlSrc = readDashboardHtml();
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  const flushTicks = async (n = 8) => {
    for (let i = 0; i < n; i += 1) {
      await Promise.resolve();
    }
  };

  function makeEdgeSandbox({ sidecar, hasFocus = undefined, sessionStoreMap = new Map(), customActionHandler = null } = {}) {
    const elements = new Map();
    const timers = [];
    let nextTimerId = 1;
    const apiCalls = [];
    let latestWatchdogState = {
      ok: true,
      enabled: true,
      desktopNotifyEnabled: true,
      ttlDesktopNotifyEnabled: true,
      uiLang: "zh",
      uiLangSource: "sqlite",
      pendingJump: null,
      current: { conversationId: "conv-cur", phase: "IDLE", severity: "idle", cwd: "e:\\work" },
      sessions: [],
      alertingSessions: []
    };

    const makeEl = (id) => {
      const listeners = new Map();
      return {
        id,
        textContent: "",
        innerText: "",
        innerHTML: "",
        title: "",
        value: "",
        className: "",
        style: {},
        dataset: {},
        options: [],
        listeners,
        classList: {
          _s: new Set(["hidden"]),
          add(...c) { c.forEach((x) => this._s.add(x)); },
          remove(...c) { c.forEach((x) => this._s.delete(x)); },
          contains(x) { return this._s.has(x); },
          toggle(x, f) {
            if (f === undefined) {
              if (this._s.has(x)) { this._s.delete(x); return false; }
              this._s.add(x);
              return true;
            }
            if (f) this._s.add(x); else this._s.delete(x);
            return Boolean(f);
          }
        },
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        dispatch(type, eventInit = {}) {
          const list = listeners.get(type) || [];
          for (const fn of list) fn({ type, ...eventInit });
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getAttribute() { return ""; },
        setAttribute() {}
      };
    };

    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const handleFetch = async (url, opts = {}) => {
      const parsedBody = opts.body ? JSON.parse(opts.body) : {};
      apiCalls.push({ url, method: opts.method || "GET", keepalive: Boolean(opts.keepalive), body: parsedBody });
      if (url === "/api/watchdog/action") {
        if (customActionHandler) {
          const customRes = await customActionHandler(parsedBody, apiCalls.length);
          if (customRes) return customRes;
        }
        if (parsedBody.action === "focusConversation") {
          const ticket = {
            jumpId: `jmp_edge_${apiCalls.length}`,
            conversationId: parsedBody.conversationId,
            cwd: parsedBody.conversationId === "conv-story" ? "e:\\故事\\1" : "e:\\work\\agy-dart",
            workspaceLabel: parsedBody.conversationId === "conv-story" ? "故事/1" : "work/agy-dart",
            convTitle: "测试会话"
          };
          latestWatchdogState = { ...latestWatchdogState, pendingJump: ticket };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              conversationId: parsedBody.conversationId,
              pendingJump: ticket,
              focused: !parsedBody.skipOsFocus,
              status: {
                ...latestWatchdogState,
                current: {
                  conversationId: parsedBody.conversationId,
                  phase: parsedBody.conversationId === "conv-story" ? "LLM_INFLIGHT" : "IDLE",
                  severity: parsedBody.conversationId === "conv-story" ? "stalled" : "idle",
                  stalledSec: 120,
                  silentSec: 180
                }
              }
            })
          };
        }
        if (parsedBody.action === "ackJump") {
          if (latestWatchdogState.pendingJump?.jumpId === parsedBody.jumpId) {
            latestWatchdogState = { ...latestWatchdogState, pendingJump: null };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, acknowledged: true, status: latestWatchdogState })
          };
        }
      }
      if (url === "/api/watchdog") {
        return { ok: true, status: 200, json: async () => latestWatchdogState };
      }
      if (url === "/api/stats") {
        return { ok: true, status: 200, json: async () => ({ version: "1.5.4" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    if (sidecar && !sidecar.fetch) {
      sidecar.fetch = handleFetch;
    }

    const docObj = {
      hidden: false,
      documentElement: { lang: "zh-CN" },
      getElementById: getEl,
      querySelector: () => ({ getAttribute: () => "csrf-tok" }),
      querySelectorAll: () => [],
      addEventListener() {}
    };
    if (typeof hasFocus === "function") {
      docObj.hasFocus = hasFocus;
    }

    const ctx = vm.createContext({
      window: {
        location: { search: "", href: "http://127.0.0.1:4321/" },
        sidecar,
        addEventListener() {}
      },
      document: docObj,
      localStorage: { getItem: () => "zh", setItem() {} },
      sessionStorage: {
        getItem: (k) => (sessionStoreMap.has(k) ? sessionStoreMap.get(k) : null),
        setItem: (k, v) => sessionStoreMap.set(k, String(v))
      },
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      fetch: handleFetch,
      Headers,
      URLSearchParams,
      setInterval: () => 999,
      clearInterval() {},
      setTimeout(fn, delay) {
        const id = nextTimerId++;
        timers.push({ id, fn, delay, cleared: false });
        return id;
      },
      clearTimeout(id) {
        const found = timers.find((t) => t.id === id);
        if (found) found.cleared = true;
      },
      Date,
      Math,
      Number,
      String,
      Boolean,
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
    return {
      ctx,
      elements,
      timers,
      apiCalls,
      setWatchdogState(next) { latestWatchdogState = next; }
    };
  }

  // 5A: Hanging window.sidecar.getWorkspaceUris() (never-resolving initialWorkspacePromise) must NOT deadlock jump or fallback
  {
    const toggled = [];
    const boxHang = makeEdgeSandbox({
      sidecar: {
        conversationId: "conv-cur",
        getWorkspaceUris: () => new Promise(() => {}),
        ui: { toggleConversation: (id) => toggled.push(id) }
      }
    });
    await flushTicks();
    for (const t of boxHang.timers) {
      if (t.delay === 200 && !t.cleared) t.fn();
    }
    await flushTicks();
    boxHang.apiCalls.length = 0;

    // Panel click with cwd when getWorkspaceUris() never resolves
    const jumpPromise = vm.runInContext(
      "jumpToConversation('conv-story', { cwd: 'e:\\\\故事\\\\1' })",
      boxHang.ctx
    );
    await flushTicks(3);
    for (const t of boxHang.timers) {
      if (t.delay === 200 && !t.cleared) t.fn();
    }
    await jumpPromise;
    assert.ok(
      boxHang.apiCalls.some((c) => c.url === "/api/watchdog/action" && c.body.action === "focusConversation"),
      "Hanging getWorkspaceUris() must time out cleanly and still dispatch focusConversation"
    );

    // Desktop pendingJump when getWorkspaceUris() never resolves -> still arms 1200ms fallback
    const hangTicket = { jumpId: "jmp_hang_01", conversationId: "conv-after-hang", cwd: "e:\\故事\\1" };
    boxHang.setWatchdogState({
      ok: true,
      enabled: true,
      pendingJump: hangTicket,
      current: { conversationId: "conv-cur", phase: "IDLE", severity: "idle" },
      sessions: [],
      alertingSessions: []
    });
    vm.runInContext(
      "consumePendingJumpIfEligible(wdHang)",
      Object.assign(boxHang.ctx, { wdHang: { pendingJump: hangTicket } })
    );
    await flushTicks(3);
    for (const t of boxHang.timers) {
      if (t.delay === 200 && !t.cleared) t.fn();
    }
    await flushTicks();
    const fbTimer = boxHang.timers.find((t) => t.delay === 1200 && !t.cleared);
    assert.ok(fbTimer, "Must still arm 1200ms fallback timer after getWorkspaceUris() 200ms guard expires");
    await fbTimer.fn();
    await flushTicks();
    assert.ok(toggled.includes("conv-after-hang"));
  }

  // 5B: Subproject window (`e:\work\baidu-ai-batch`) must NOT steal sibling umbrella jump (`cwd: e:\work`, `workspaceLabel: work/agy-dart`),
  //     and unfocused umbrella window (`e:\work`, hasFocus=false) yields 0ms claim to focused child window
  {
    const toggledBaidu = [];
    const boxBaidu = makeEdgeSandbox({
      sidecar: {
        conversationId: "conv-baidu",
        getWorkspaceUris: async () => ["file:///e%3A/work/baidu-ai-batch"],
        ui: { toggleConversation: (id) => toggledBaidu.push(id) }
      }
    });
    await flushTicks();

    // Sibling subproject jump under umbrella `e:\work` -> must NOT claim in 0ms!
    const dartUmbrellaTicket = {
      jumpId: "jmp_umbrella_dart",
      conversationId: "conv-dart",
      cwd: "e:\\work",
      workspaceLabel: "work/agy-dart"
    };
    vm.runInContext(
      "consumePendingJumpIfEligible(wdSibling)",
      Object.assign(boxBaidu.ctx, { wdSibling: { pendingJump: dartUmbrellaTicket } })
    );
    await flushTicks();
    assert.equal(toggledBaidu.length, 0, "Subproject window baidu-ai-batch must NOT claim work/agy-dart umbrella jump in 0ms");

    // Matching subproject label under umbrella `e:\work` -> DOES claim in 0ms!
    const baiduUmbrellaTicket = {
      jumpId: "jmp_umbrella_baidu",
      conversationId: "conv-baidu-target",
      cwd: "e:\\work",
      workspaceLabel: "work/baidu-ai-batch"
    };
    vm.runInContext(
      "consumePendingJumpIfEligible(wdOwnSub)",
      Object.assign(boxBaidu.ctx, { wdOwnSub: { pendingJump: baiduUmbrellaTicket } })
    );
    await flushTicks();
    assert.deepEqual(toggledBaidu, ["conv-baidu-target"], "Subproject window must claim umbrella jump when workspaceLabel matches its subproject");

    // Unfocused umbrella window (`e:\work`, hasFocus() === false) defers ancestor-only match so focused child window wins
    const toggledUnfocusedUmbrella = [];
    const boxUmbrellaBg = makeEdgeSandbox({
      hasFocus: () => false,
      sidecar: {
        conversationId: "conv-umbrella",
        getWorkspaceUris: async () => ["file:///e%3A/work"],
        ui: { toggleConversation: (id) => toggledUnfocusedUmbrella.push(id) }
      }
    });
    await flushTicks();
    const childTicket = {
      jumpId: "jmp_child_exact",
      conversationId: "conv-child-exact",
      cwd: "e:\\work\\baidu-ai-batch",
      workspaceLabel: "baidu-ai-batch"
    };
    vm.runInContext(
      "consumePendingJumpIfEligible(wdChild)",
      Object.assign(boxUmbrellaBg.ctx, { wdChild: { pendingJump: childTicket } })
    );
    await flushTicks();
    assert.equal(
      toggledUnfocusedUmbrella.length,
      0,
      "Unfocused ancestor umbrella window must defer 0ms claim so focused exact child window can claim first"
    );
  }

  // 5C: Rapid <100ms clicks out-of-order resolution + pill flash cleanup + cross-window card flash guard + Desktop 2.0 onWorkspaceChange + sessionStorage reload
  {
    let resolveSlowAction = null;
    let wsChangeListener = null;
    const sharedSessionStorage = new Map();
    const toggledRapid = [];

    const boxRapid = makeEdgeSandbox({
      sessionStoreMap: sharedSessionStorage,
      sidecar: {
        conversationId: "conv-native",
        getWorkspaceUris: async () => ["file:///e%3A/work"],
        onWorkspaceChange(fn) { wsChangeListener = fn; return () => {}; },
        ui: { toggleConversation: (id) => toggledRapid.push(id) }
      },
      customActionHandler: async (body) => {
        if (body.action === "focusConversation" && body.conversationId === "conv-slow") {
          await new Promise((r) => { resolveSlowAction = r; });
        }
        return null;
      }
    });
    await flushTicks();

    const pill1Set = new Set();
    const pill2Set = new Set();
    const pill1 = { classList: { add: (c) => pill1Set.add(c), remove: (c) => pill1Set.delete(c) } };
    const pill2 = { classList: { add: (c) => pill2Set.add(c), remove: (c) => pill2Set.delete(c) } };

    const p1 = vm.runInContext(
      "jumpToConversation('conv-slow', { cwd: 'e:\\\\work\\\\agy-dart', pillEl: p1El })",
      Object.assign(boxRapid.ctx, { p1El: pill1 })
    );
    await flushTicks(3);
    assert.equal(pill1Set.has("is-jumped"), true);

    const p2 = vm.runInContext(
      "jumpToConversation('conv-fast', { cwd: 'e:\\\\work\\\\agy-dart', pillEl: p2El })",
      Object.assign(boxRapid.ctx, { p2El: pill2 })
    );
    assert.equal(pill1Set.has("is-jumped"), false, "Rapid second click must immediately clear .is-jumped from previous pill");
    assert.equal(pill2Set.has("is-jumped"), true);
    await p2;

    // Now resolve the earlier slow click AFTER p2 already finished -> must NOT revert active conversation!
    resolveSlowAction();
    await p1;
    await flushTicks();
    assert.equal(
      vm.runInContext("getActiveConversationId()", boxRapid.ctx),
      "conv-fast",
      "Out-of-order slow response from earlier click must NOT overwrite newer click's selected conversation"
    );

    // Cross-workspace click must NOT flash Window B's stalled rescueBox into Window A's card,
    // AND if Desktop 2.0 single-window switches workspace via onWorkspaceChange, it updates selectedConvOverride + acks with keepalive!
    const rescueBox = boxRapid.elements.get("wd-rescue-box");
    rescueBox.classList.add("hidden");
    await vm.runInContext("jumpToConversation('conv-story', { cwd: 'e:\\\\故事\\\\1', workspaceLabel: '故事/1' })", boxRapid.ctx);
    await flushTicks();
    assert.equal(rescueBox.classList.contains("hidden"), true, "Cross-workspace click must NOT flash target window's stalled rescueBox locally");
    assert.equal(vm.runInContext("getActiveConversationId()", boxRapid.ctx), "conv-fast");

    // Simulate Antigravity Desktop 2.0 single-window Agent Manager switching workspace without reloading iframe
    const storyTicket = boxRapid.apiCalls.filter((c) => c.body?.action === "focusConversation").pop();
    assert.ok(storyTicket && typeof wsChangeListener === "function");
    const latestStateWithStoryJump = {
      ok: true,
      enabled: true,
      pendingJump: {
        jumpId: `jmp_edge_${boxRapid.apiCalls.findIndex((c) => c === storyTicket) + 1}`,
        conversationId: "conv-story",
        cwd: "e:\\故事\\1",
        workspaceLabel: "故事/1"
      },
      current: { conversationId: "conv-fast", phase: "IDLE", severity: "idle" },
      sessions: [],
      alertingSessions: []
    };
    boxRapid.setWatchdogState(latestStateWithStoryJump);
    vm.runInContext("cachedWatchdog = wdSync;", Object.assign(boxRapid.ctx, { wdSync: latestStateWithStoryJump }));
    wsChangeListener(["file:///e%3A/%E6%95%85%E4%BA%8B/1"]);
    await flushTicks();
    assert.equal(
      vm.runInContext("getActiveConversationId()", boxRapid.ctx),
      "conv-story",
      "Single-window Desktop 2.0 workspace-change to target cwd must sync selectedConvOverride without iframe reload"
    );
    const ackCalls = boxRapid.apiCalls.filter((c) => c.body?.action === "ackJump");
    assert.ok(ackCalls.length > 0 && ackCalls.every((c) => c.keepalive === true), "ackJump must set keepalive: true");

    // Simulate iframe reload sharing sessionStorage: already-consumed jumpId must NOT double-toggle on reload!
    const consumedId = latestStateWithStoryJump.pendingJump.jumpId;
    const toggledAfterReload = [];
    const boxReloaded = makeEdgeSandbox({
      sessionStoreMap: sharedSessionStorage,
      sidecar: {
        conversationId: "conv-story",
        getWorkspaceUris: async () => ["file:///e%3A/%E6%95%85%E4%BA%8B/1"],
        ui: { toggleConversation: (id) => toggledAfterReload.push(id) }
      }
    });
    await flushTicks();
    vm.runInContext(
      "renderWatchdogCard(wdReload);",
      Object.assign(boxReloaded.ctx, {
        wdReload: {
          ...latestStateWithStoryJump,
          pendingJump: { ...latestStateWithStoryJump.pendingJump, jumpId: consumedId },
          sessions: [
            { conversationId: "conv-other-1", cwd: "e:\\work", workspaceLabel: "work", convTitle: "会话1", phase: "IDLE", severity: "idle", isSubagent: false },
            { conversationId: "conv-story", cwd: "e:\\故事\\1", workspaceLabel: "故事/1", convTitle: "故事会话", phase: "IDLE", severity: "idle", isSubagent: false }
          ]
        }
      })
    );
    await flushTicks();
    assert.equal(toggledAfterReload.length, 0, "sessionStorage consumedJumpIds must prevent post-reload double-toggle");

    // Verify #wd-session-switcher highlights host's real active conversation even when cur falls back to sessions[0] in app scope
    vm.runInContext(
      "renderWatchdogCard(wdAppScope);",
      Object.assign(boxReloaded.ctx, {
        wdAppScope: {
          enabled: true,
          current: { conversationId: "conv-other-1", phase: "IDLE", severity: "idle" },
          sessions: [
            { conversationId: "conv-other-1", cwd: "e:\\work", workspaceLabel: "work", convTitle: "会话1", phase: "IDLE", severity: "idle", isSubagent: false },
            { conversationId: "conv-story", cwd: "e:\\故事\\1", workspaceLabel: "故事/1", convTitle: "故事会话", phase: "IDLE", severity: "idle", isSubagent: false }
          ],
          alertingSessions: []
        }
      })
    );
    const swHtml = boxReloaded.elements.get("wd-session-switcher").innerHTML;
    assert.ok(
      swHtml.includes('data-jump-conv="conv-story" data-jump-cwd="e:\\故事\\1" data-jump-ws="故事/1"') &&
      swHtml.includes('aria-current="true"><span class="wd-session-pill-text">故事/1 · 故事会话'),
      "Session switcher must mark host active conversation as aria-current even when wd.current is another session in app scope"
    );
  }
});
