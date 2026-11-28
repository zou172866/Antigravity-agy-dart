import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  extractFailureExcerpt,
  isFailureAnchorLine,
  truncateTailUtf8Safe
} from "../hooks/filter-rules.mjs";
import { extractVerificationSignal } from "../hooks/post-tool-use.mjs";
import {
  findPreferredTranscriptForConversation,
  readTranscriptHeadTailFixed,
  resolveConversationBrainDir,
  resolveConversationOwnedFile
} from "../context/lib/cache-analyzer.js";
import {
  buildGitReadOnlyEnv,
  buildHandoffBrief,
  hasUnclosedFence,
  parseStatusPorcelainBZ,
  truncateUtf8Safe,
  wrapSafeFence
} from "../context/lib/handoff.js";
import { recordHookLeaseTransition } from "../context/lib/watchdog-lease.js";
import {
  WatchdogMonitor,
  focusDesktopConversationWindow,
  resolveTrustedCheckpointSessionId
} from "../context/lib/watchdog.js";
import {
  closeRuntimeStore,
  createStandaloneServer,
  registerSidecarRoutes
} from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

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

function httpJsonRequest(port, reqPath, { method = "GET", headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    if (payload !== null && !reqHeaders["Content-Type"]) {
      reqHeaders["Content-Type"] = "application/json";
    }
    if (payload !== null) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload, "utf8");
    }
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method, headers: reqHeaders }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function createDashboardVmSandbox({ fetchImpl, initialSearch = "", sidecarObj = undefined, copiedOut = [] } = {}) {
  const html = readDashboardHtml();
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length >= 1, "index.html must contain inline <script>");
  const mainScript = scriptMatches[0][1];
  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const attrs = new Map();
    const el = {
      id,
      className: "",
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      value: "",
      disabled: false,
      options: [],
      dataset: {},
      style: {},
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k) ?? null,
      addEventListener: () => {},
      scrollIntoView: () => {},
      focus: () => {},
      select: () => {},
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c)
      }
    };
    if (id) elements.set(id, el);
    return el;
  };
  let lastCreatedTextarea = null;
  const sandbox = {
    window: {
      location: { search: initialSearch },
      sidecar: sidecarObj,
      addEventListener: () => {}
    },
    document: {
      getElementById: (id) => elements.get(id) || makeEl(id),
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => {
        const el = makeEl("");
        if (String(tag).toLowerCase() === "textarea") lastCreatedTextarea = el;
        return el;
      },
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: (cmd) => {
        if (cmd === "copy" && lastCreatedTextarea) {
          copiedOut.push(lastCreatedTextarea.value);
          return true;
        }
        return false;
      }
    },
    navigator: {
      clipboard: {
        writeText: async (txt) => {
          copiedOut.push(txt);
        }
      }
    },
    URLSearchParams,
    Headers: class {
      constructor() {
        this._m = new Map();
      }
      set(k, v) {
        this._m.set(String(k).toLowerCase(), String(v));
      }
      has(k) {
        return this._m.has(String(k).toLowerCase());
      }
      get(k) {
        return this._m.get(String(k).toLowerCase()) ?? null;
      }
    },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    console: { error: () => {}, log: () => {}, warn: () => {} },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    queueMicrotask: (fn) => Promise.resolve().then(fn)
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(mainScript, ctx);
  return { html, ctx, elements, sandbox };
}

test("v1.7.3-1: Legacy full compat, HTTP GET/POST & SidecarApp mode/auth checks, and 5800..90 B budgets with CJK/Emoji/secrets/nested backticks", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-budget-"));
  const repoDir = path.join(tmpDir, "repo");
  const brainRoot = path.join(tmpDir, "brain");
  const tmpDb = path.join(tmpDir, "context.db");
  const convId = "conv-budget-alpha";
  const rootSid = "root-budget-session";

  fs.mkdirSync(repoDir, { recursive: true });
  const convLogDir = path.join(brainRoot, convId, ".system_generated", "logs");
  fs.mkdirSync(convLogDir, { recursive: true });

  runGit(repoDir, ["init"]);
  runGit(repoDir, ["checkout", "-b", "feat/handoff-upgrade"]);
  fs.writeFileSync(path.join(repoDir, "app.js"), "export const v = 1;\n", "utf8");
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "init with ```backticks``` and sk-ant-api03-1234567890abcdefghijklmnop"]);
  fs.writeFileSync(path.join(repoDir, "app.js"), "export const v = 2;\nexport const cjk = '中文🚀';\n", "utf8");

  const secretGh = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
  const secretAnt = "sk-ant-api03-1234567890abcdefghijklmnop";

  const txLines = [
    {
      type: "USER_INPUT",
      step_index: 1,
      created_at: "2026-11-24T10:00:00.000Z",
      user_input: `<USER_REQUEST>构建交接简报引擎🚀，包含 \`\`\`js code\`\`\` 与密钥 ${secretGh}</USER_REQUEST>`
    },
    {
      type: "USER_INPUT",
      step_index: 5,
      created_at: "2026-11-24T10:05:00.000Z",
      user_input: `<USER_REQUEST>纠偏：必须支持 90B 极窄预算并闭合 \`\`\`\`md 嵌套反引号，密钥 ${secretAnt}</USER_REQUEST>`
    }
  ];
  fs.writeFileSync(path.join(convLogDir, "transcript.jsonl"), txLines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(brainRoot, convId, "task.md"),
    [
      "- [x] 已完成基础框架",
      `- [/] 修复中文截断🚀与 \`\`\` 围栏（别泄露 ${secretGh}）`,
      "- [ ] 补齐全部验收矩阵回归测试"
    ].join("\n") + "\n",
    "utf8"
  );

  const store = new ContextModeStore({ dbPath: tmpDb });
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  try {
    // Establish legitimate child->root watchdog lease so explicit sessionId=rootSid is proven owned by convId (P1-02)
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      {
        conversationId: convId,
        parentConversationId: rootSid,
        rootSessionId: rootSid,
        cwd: repoDir,
        lastUserInput: "Budget test"
      },
      { nowMs: Date.now() }
    );
    store.recordModifiedFiles(rootSid, [path.join(repoDir, "app.js")], { worktree: repoDir, tool: "apply_edits" });
    store.recordVerificationResult(rootSid, {
      kind: "test",
      command: "node --test tests/core.test.mjs",
      exitCode: 1,
      passed: false,
      summary: "1 failed",
      failureExcerpt: [
        "✖ 中文测试失败🚀 ```js",
        `AssertionError: token=${secretAnt}`,
        "````nested fence line",
        "at tests/core.test.mjs:42"
      ].join("\n"),
      worktree: repoDir
    });
    store.indexContent({
      sessionId: rootSid,
      worktree: repoDir,
      kind: "file",
      label: "docs/中文日志🚀.log",
      content: "indexed log line\n".repeat(30)
    });

    // 1. Omitted / "full" mode preserves legacy format 100%
    const legacy = buildHandoffBrief({
      store,
      sessionId: rootSid,
      cwd: repoDir,
      cacheDiag: {
        turnsWithUsage: 3,
        currentModel: "claude-sonnet-4-6",
        currentContextTokens: 80000,
        cacheTemperature: "cold",
        compactAdvice: "opportunistic_cold_compact"
      }
    });
    assert.equal(legacy.mode, undefined);
    assert.ok(legacy.markdown.includes("## Git Diff Stat"));
    assert.ok(legacy.markdown.includes("## KV-Cache Snapshot"));
    assert.ok(legacy.markdown.includes("Call ctx_resume({}) after /compact"));

    // 2. mode="agent" across all 6 required byte budgets
    for (const cap of [5800, 2400, 1200, 600, 320, 90]) {
      const brief = buildHandoffBrief({
        store,
        mode: "agent",
        scope: "conversation",
        conversationId: convId,
        conversationConfirmed: true,
        sessionId: rootSid,
        cwd: repoDir,
        maxBytes: cap,
        brainRoots: [brainRoot]
      });
      const actualBytes = Buffer.byteLength(brief.markdown, "utf8");
      assert.equal(brief.mode, "agent");
      assert.equal(brief.confirmedConversation, true);
      assert.equal(brief.bytes, actualBytes, `bytes mismatch at cap=${cap}`);
      assert.ok(actualBytes <= cap, `Exceeded cap=${cap}: got ${actualBytes}`);
      assert.ok(!brief.markdown.includes("\uFFFD"), `Replacement char at cap=${cap}`);
      assert.equal(hasLoneSurrogate(brief.markdown), false, `Lone surrogate at cap=${cap}`);
      assert.equal(hasUnclosedFence(brief.markdown), false, `Unclosed fence at cap=${cap}:\n${brief.markdown}`);
      assert.ok(!brief.markdown.includes(secretGh), `GitHub secret leaked in markdown at cap=${cap}`);
      assert.ok(!brief.markdown.includes(secretAnt), `Anthropic secret leaked in markdown at cap=${cap}`);
      assert.ok(!brief.summary.includes(secretGh) && !brief.summary.includes(secretAnt), "Secret leaked in summary");
      const anchorJson = JSON.stringify(brief.anchors);
      assert.ok(!anchorJson.includes(secretGh) && !anchorJson.includes(secretAnt), "Secret leaked in anchors");

      if (cap === 5800) {
        assert.equal(brief.truncated, false);
        assert.ok(brief.markdown.includes(`Conversation**: \`${convId}\``));
        assert.ok(brief.markdown.includes(`Checkpoint Session**: \`${rootSid}\``));
        assert.ok(brief.markdown.includes("## User Intent"));
        assert.ok(brief.markdown.includes("## Plan & Artifacts"));
        assert.ok(brief.markdown.includes("## Verification & Checkpoint"));
        assert.ok(brief.markdown.includes("````text") || brief.markdown.includes("`````text"), "Dynamic fence must exceed inner backticks");
        assert.ok(brief.markdown.includes(`ctx_resume({ sessionId: "${rootSid}" })`));
        assert.ok(!brief.markdown.includes("## KV-Cache Snapshot"), "agent mode must omit KV-Cache Snapshot");
      }
      if (cap === 600) {
        assert.equal(brief.truncated, true);
        assert.ok(brief.markdown.includes("ctx_resume({})"), "600 B must preserve same-window recovery cue");
        assert.ok(
          brief.markdown.includes(`ctx_resume({ sessionId: "${rootSid}" })`),
          "600 B must preserve cross-window recovery cue"
        );
      }
      if (cap <= 1200) {
        assert.equal(brief.truncated, true);
      }
    }

    // 3. Unconfirmed / placeholder IDs never emit cross-window ctx_resume({ sessionId })
    for (const badId of ["default", "all", "app", "lifetime", "__unbound__", "unknown", "none", "null", "undefined"]) {
      const unconf = buildHandoffBrief({
        store,
        mode: "agent",
        scope:
          badId === "all" || badId === "app" || badId === "lifetime"
            ? badId
            : "conversation",
        conversationId: badId,
        conversationConfirmed: true,
        sessionId: badId,
        cwd: repoDir,
        brainRoots: [brainRoot]
      });
      assert.equal(unconf.confirmedConversation, false);
      assert.ok(!unconf.markdown.includes("ctx_resume({ sessionId:"), `Must not emit cross-window resume for ${badId}`);
      assert.equal(unconf.anchors.confirmed, false);
    }

    // 3b. Separate conversationId vs explicit checkpoint sessionId over /api/handoff + reserved 'unknown' stripped on /api/resume
    store.recordVerificationResult("unknown", {
      kind: "test",
      command: "npm test",
      exitCode: 1,
      passed: false,
      summary: "unknown fail",
      failureExcerpt: "AssertionError: UNKNOWN_PLACEHOLDER_LEAK",
      worktree: repoDir
    });

    // 4. Standalone HTTP GET/POST & SidecarApp mode/auth enforcement
    store.close();
    process.env.AGY_DART_DB_PATH = tmpDb;
    closeRuntimeStore();
    const token = "v173-test-csrf-token-0123456789abcdef";
    const srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        brainRoots: [brainRoot],
        findTranscriptFn: () => null,
        notifyFn: () => {},
        focusWindowFn: () => ({ dispatched: false, platform: process.platform })
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const authHeaders = { "X-Agy-Dart-Token": token };

    try {
      const noAuth = await httpJsonRequest(port, "/api/handoff", { method: "GET" });
      assert.equal(noAuth.status, 403);

      const getFull = await httpJsonRequest(port, `/api/handoff?scope=conversation&conversationId=${convId}`, {
        method: "GET",
        headers: authHeaders
      });
      assert.equal(getFull.status, 200);
      assert.equal(getFull.json.mode, undefined);

      const getAgentRejected = await httpJsonRequest(port, `/api/handoff?scope=conversation&conversationId=${convId}&mode=agent`, {
        method: "GET",
        headers: authHeaders
      });
      assert.equal(getAgentRejected.status, 400, "GET /api/handoff?mode=agent must return 400");

      const getBadMode = await httpJsonRequest(port, `/api/handoff?mode=invalid`, {
        method: "GET",
        headers: authHeaders
      });
      assert.equal(getBadMode.status, 400);

      const postBadMode = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convId, mode: "weird" }
      });
      assert.equal(postBadMode.status, 400);

      const postBadBool = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convId, mode: "agent", conversationConfirmed: "yes" }
      });
      assert.equal(postBadBool.status, 400);

      const postAgent = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convId, sessionId: rootSid, mode: "agent", conversationConfirmed: true }
      });
      assert.equal(postAgent.status, 200);
      assert.equal(postAgent.json.mode, "agent");
      assert.equal(postAgent.json.confirmedConversation, true);
      assert.equal(postAgent.json.sessionId, rootSid, "Explicit separate sessionId must be preserved for checkpoint");
      assert.equal(postAgent.json.anchors.confirmed, true);
      assert.ok(postAgent.json.markdown.includes("中文测试失败"), "Separate checkpoint sessionId failure excerpt must render");
      assert.ok(!postAgent.json.markdown.includes("## KV-Cache Snapshot"));

      const resUnknown = await httpJsonRequest(port, "/api/resume", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: "unknown" }
      });
      assert.equal(resUnknown.status, 200);
      assert.ok(!resUnknown.raw.includes("UNKNOWN_PLACEHOLDER_LEAK"), "Reserved placeholder 'unknown' must strip failureExcerpt");

      // SidecarApp POST-only & mode validation
      const routes = [];
      registerSidecarRoutes({
        config: { conversationId: convId },
        api(routePath, handler, method) {
          routes.push({ routePath, handler, method });
        }
      });
      const hoRoute = routes.find((r) => r.routePath === "/api/handoff");
      assert.ok(hoRoute && hoRoute.method === "POST");
      assert.equal(hoRoute.handler({ mode: "bogus" }).status, 400);
      assert.equal(hoRoute.handler({ mode: 99 }).status, 400);
      assert.equal(hoRoute.handler({ mode: "agent", conversationConfirmed: "nope" }).status, 400);
      const sdkAgent = hoRoute.handler({
        scope: "conversation",
        conversationId: convId,
        sessionId: rootSid,
        mode: "agent",
        conversationConfirmed: true
      });
      assert.equal(sdkAgent.ok, true);
      assert.equal(sdkAgent.mode, "agent");
      assert.equal(sdkAgent.sessionId, rootSid);
      assert.equal(sdkAgent.confirmedConversation, true);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      closeRuntimeStore();
    }
  } finally {
    try { store.close(); } catch {}
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-2: >512 KiB transcript fixed window (<=64 KiB head / <=128 KiB tail), filtering/dedup/order, >24 KiB task.md partial read & sibling link/junction isolation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-large-"));
  const brainRoot = path.join(tmpDir, "brain");
  const convMain = "conv-large-main";
  const convFallback = "conv-fallback-full";
  const convSibling = "conv-sibling-secret";
  const convPartial = "conv-partial-artifacts";
  const convGiant = "conv-giant-lines";

  try {
    // 1. >512 KiB transcript.jsonl with head goal, giant middle record, keepalive, subagent, headless worker, control cmd, duplicates
    const mainLogDir = path.join(brainRoot, convMain, ".system_generated", "logs");
    fs.mkdirSync(mainLogDir, { recursive: true });
    const hugeFiller = "x".repeat(95 * 1024); // 95 KiB single record
    const lines = [
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 0,
        created_at: "2026-11-24T07:59:00.000Z",
        content:
          "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\nSessionStart hook snapshot SYSTEM_PREAMBLE_MUST_SKIP\n</SYSTEM_MESSAGE>"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 1,
        created_at: "2026-11-24T08:00:00.000Z",
        user_input: "",
        content: "<USER_REQUEST>INITIAL_GOAL_ALPHA: build deterministic handoff brief</USER_REQUEST>"
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: "2026-11-24T08:01:00.000Z",
        content: "PLANNER_SHOULD_NOT_APPEAR"
      })
    ];
    for (let i = 0; i < 6; i++) {
      lines.push(
        JSON.stringify({
          type: "TOOL_RESULT",
          step_index: 3 + i,
          created_at: `2026-11-24T08:0${2 + i}:00.000Z`,
          content: hugeFiller
        })
      );
    }
    lines.push(
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 50,
        created_at: "2026-11-24T08:30:00.000Z",
        user_input: "[agy-dart TTL Keepalive 1/3] KEEPALIVE_MUST_SKIP"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 51,
        is_subagent: true,
        created_at: "2026-11-24T08:31:00.000Z",
        user_input: "SUBAGENT_STEP_MUST_SKIP"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 52,
        created_at: "2026-11-24T08:32:00.000Z",
        user_input: "Process item 3. When you are done, call the finish tool with your result. HEADLESS_MUST_SKIP"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 53,
        created_at: "2026-11-24T08:33:00.000Z",
        user_input: "/compact"
      }),
      JSON.stringify({
        type: "SYSTEM_MESSAGE",
        step_index: 54,
        created_at: "2026-11-24T08:34:00.000Z",
        content: "SYSTEM_MESSAGE_MUST_SKIP"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 55,
        created_at: "2026-11-24T08:35:00.000Z",
        user_input: "<USER_REQUEST>CORRECTION_OLDER_BETA: keep full mode backward compatible</USER_REQUEST>"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 56,
        created_at: "2026-11-24T08:36:00.000Z",
        user_input: "<USER_REQUEST>CORRECTION_LATEST_GAMMA: enforce 1200ms shared git deadline</USER_REQUEST>"
      }),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 57,
        created_at: "2026-11-24T08:37:00.000Z",
        user_input: "<USER_REQUEST>CORRECTION_LATEST_GAMMA: enforce 1200ms shared git deadline</USER_REQUEST>"
      })
    );
    const mainTxPath = path.join(mainLogDir, "transcript.jsonl");
    fs.writeFileSync(mainTxPath, lines.join("\n") + "\n", "utf8");
    // Also place transcript_full.jsonl with decoy content to confirm transcript.jsonl takes precedence
    fs.writeFileSync(
      path.join(mainLogDir, "transcript_full.jsonl"),
      JSON.stringify({ type: "USER_INPUT", user_input: "DECOY_FULL_TRANSCRIPT" }) + "\n",
      "utf8"
    );

    const preferredPath = findPreferredTranscriptForConversation(convMain, { extraRoots: [brainRoot] });
    assert.ok(preferredPath && preferredPath.endsWith("transcript.jsonl"), "Must prefer transcript.jsonl over transcript_full.jsonl");

    const fixedRead = readTranscriptHeadTailFixed(preferredPath);
    assert.ok(fixedRead.fileSize > 512 * 1024, `Expected >512 KiB transcript, got ${fixedRead.fileSize}`);
    assert.ok(fixedRead.headBytesRead <= 65536, `headBytesRead exceeded 64 KiB: ${fixedRead.headBytesRead}`);
    assert.ok(fixedRead.tailBytesRead <= 131072, `tailBytesRead exceeded 128 KiB: ${fixedRead.tailBytesRead}`);
    assert.ok(fixedRead.totalBytesRead <= 196608);
    assert.equal(fixedRead.overlapped, false);

    // 2. Fallback to same session's transcript_full.jsonl when transcript.jsonl is absent
    const fbLogDir = path.join(brainRoot, convFallback, ".system_generated", "logs");
    fs.mkdirSync(fbLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(fbLogDir, "transcript_full.jsonl"),
      JSON.stringify({ type: "USER_INPUT", user_input: "FALLBACK_SAME_SESSION_OK" }) + "\n",
      "utf8"
    );
    const fbPath = findPreferredTranscriptForConversation(convFallback, { extraRoots: [brainRoot] });
    assert.ok(fbPath && fbPath.endsWith("transcript_full.jsonl"));

    // 3. >24 KiB task.md with mixed [x], [/], [ ] states
    const taskLines = [
      "# Tasks",
      "- [x] Completed task 1",
      "- [/] Active task IN_PROGRESS_ONE",
      "- [ ] Pending task PENDING_TWO"
    ];
    for (let i = 0; i < 400; i++) {
      taskLines.push(`- [x] Padding completed item ${i} ${"P".repeat(60)}`);
    }
    taskLines.push("- [ ] BEYOND_24K_TASK_MUST_NOT_APPEAR");
    const taskPath = path.join(brainRoot, convMain, "task.md");
    fs.writeFileSync(taskPath, taskLines.join("\n") + "\n", "utf8");
    assert.ok(fs.statSync(taskPath).size > 24 * 1024);

    const brief = buildHandoffBrief({
      mode: "agent",
      scope: "conversation",
      conversationId: convMain,
      conversationConfirmed: true,
      sessionId: convMain,
      brainRoots: [brainRoot]
    });
    assert.ok(brief.readStats.headBytesRead <= 65536);
    assert.ok(brief.readStats.tailBytesRead <= 131072);
    assert.ok(brief.markdown.includes("INITIAL_GOAL_ALPHA"));
    assert.ok(brief.markdown.includes("CORRECTION_OLDER_BETA"));
    assert.ok(brief.markdown.includes("CORRECTION_LATEST_GAMMA"));
    assert.ok(
      brief.markdown.indexOf("CORRECTION_OLDER_BETA") < brief.markdown.indexOf("CORRECTION_LATEST_GAMMA"),
      "Recent user messages must be ordered chronologically"
    );
    assert.equal(
      brief.markdown.split("CORRECTION_LATEST_GAMMA").length - 1,
      1,
      "Duplicate user message must be deduplicated"
    );
    for (const forbidden of [
      "DECOY_FULL_TRANSCRIPT",
      "PLANNER_SHOULD_NOT_APPEAR",
      "KEEPALIVE_MUST_SKIP",
      "SUBAGENT_STEP_MUST_SKIP",
      "HEADLESS_MUST_SKIP",
      "SYSTEM_MESSAGE_MUST_SKIP",
      "SYSTEM_PREAMBLE_MUST_SKIP",
      "The following is a",
      "BEYOND_24K_TASK_MUST_NOT_APPEAR"
    ]) {
      assert.ok(!brief.markdown.includes(forbidden), `Unexpected filtered/beyond-cap content: ${forbidden}`);
    }
    assert.ok(brief.markdown.includes("已读部分"), "Partial >24 KiB task.md must be labeled with 已读部分");
    assert.ok(brief.markdown.includes("IN_PROGRESS_ONE"));
    assert.ok(brief.markdown.includes("PENDING_TWO"));

    // 4. Giant single line > 64 KiB at head & > 128 KiB at tail -> empty window degrades cleanly
    const giantLogDir = path.join(brainRoot, convGiant, ".system_generated", "logs");
    fs.mkdirSync(giantLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(giantLogDir, "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", user_input: "A".repeat(70 * 1024) }) +
        "\n" +
        JSON.stringify({ type: "USER_INPUT", user_input: "B".repeat(140 * 1024) }) +
        "\n",
      "utf8"
    );
    const giantBrief = buildHandoffBrief({
      mode: "agent",
      scope: "conversation",
      conversationId: convGiant,
      conversationConfirmed: true,
      sessionId: convGiant,
      brainRoots: [brainRoot]
    });
    assert.ok(!giantBrief.markdown.includes("## User Intent"), "Unparseable oversized head/tail windows should leave User Intent empty");

    // 5. Cross-session junction / symlink / traversal / missing-file independent degradation
    const sibDir = path.join(brainRoot, convSibling);
    const sibLogs = path.join(sibDir, ".system_generated", "logs");
    fs.mkdirSync(sibLogs, { recursive: true });
    fs.writeFileSync(path.join(sibDir, "task.md"), "- [ ] SIBLING_SECRET_TASK\n", "utf8");
    fs.writeFileSync(path.join(sibDir, "implementation_plan.md"), "# SIBLING_PLAN\n", "utf8");
    fs.writeFileSync(
      path.join(sibLogs, "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", user_input: "SIBLING_SECRET_QUOTE" }) + "\n",
      "utf8"
    );

    // Traversal & UNC rejected
    assert.equal(resolveConversationBrainDir("../" + convSibling, [brainRoot]), null);
    assert.equal(resolveConversationBrainDir(convSibling, ["\\\\evil-host\\share\\brain"]), null);

    // Conversation directory junction pointing to sibling -> rejected
    const junctionConv = path.join(brainRoot, "conv-junction-to-sib");
    fs.symlinkSync(sibDir, junctionConv, "junction");
    assert.equal(resolveConversationBrainDir("conv-junction-to-sib", [brainRoot]), null);
    assert.equal(findPreferredTranscriptForConversation("conv-junction-to-sib", { extraRoots: [brainRoot] }), null);

    // Partial artifacts: valid task.md, missing walkthrough.md, junction subdir logs -> sibling logs
    const partialDir = path.join(brainRoot, convPartial);
    fs.mkdirSync(path.join(partialDir, ".system_generated"), { recursive: true });
    fs.writeFileSync(path.join(partialDir, "task.md"), "- [ ] PARTIAL_OWN_TASK_OK\n", "utf8");
    fs.symlinkSync(sibLogs, path.join(partialDir, ".system_generated", "logs"), "junction");
    // Also place a directory/junction named implementation_plan.md -> must be rejected as non-file / escaping
    fs.symlinkSync(sibDir, path.join(partialDir, "implementation_plan.md"), "junction");

    const partialConvInfo = resolveConversationBrainDir(convPartial, [brainRoot]);
    assert.ok(partialConvInfo);
    assert.equal(resolveConversationOwnedFile(partialConvInfo, ["implementation_plan.md"]), null);
    assert.equal(findPreferredTranscriptForConversation(convPartial, { extraRoots: [brainRoot] }), null);

    const partialBrief = buildHandoffBrief({
      mode: "agent",
      scope: "conversation",
      conversationId: convPartial,
      conversationConfirmed: true,
      sessionId: convPartial,
      brainRoots: [brainRoot]
    });
    assert.ok(partialBrief.markdown.includes("PARTIAL_OWN_TASK_OK"), "Valid own task.md must still be included");
    assert.ok(!partialBrief.markdown.includes("SIBLING_SECRET_TASK"));
    assert.ok(!partialBrief.markdown.includes("SIBLING_SECRET_QUOTE"));
    assert.ok(!partialBrief.markdown.includes("implementation_plan.md"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-3: Dual-window A/B stall isolation across /api/handoff, /api/resume, /api/watchdog, /api/watchdog/action & VM DOM late-response guard", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-dual-"));
  const brainRoot = path.join(tmpDir, "brain");
  const tmpDb = path.join(tmpDir, "context.db");
  const wsA = path.join(tmpDir, "ws-a");
  const wsB = path.join(tmpDir, "ws-b");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const convA = "conv-win-A";
  const convB = "conv-win-B";

  const seedBrain = (cid, quoteMarker, taskMarker) => {
    const logDir = path.join(brainRoot, cid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 1,
        created_at: "2026-11-24T09:00:00.000Z",
        user_input: `<USER_REQUEST>${quoteMarker}</USER_REQUEST>`
      }) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(brainRoot, cid, "task.md"), `- [/] ${taskMarker}\n`, "utf8");
  };
  seedBrain(convA, "MARKER_QUOTE_ALPHA", "MARKER_TASK_ALPHA");
  seedBrain(convB, "MARKER_QUOTE_BETA", "MARKER_TASK_BETA");

  const baseNow = Date.now();
  let virtualNow = baseNow;
  let virtualMono = 50_000_000_000n;

  const store = new ContextModeStore({ dbPath: tmpDb });
  store.recordVerificationResult(convA, {
    kind: "test",
    command: "npm test -- alpha",
    exitCode: 1,
    passed: false,
    summary: "alpha failed",
    failureExcerpt: "AssertionError: MARKER_FAIL_ALPHA",
    worktree: wsA
  });
  store.recordVerificationResult(convB, {
    kind: "test",
    command: "npm test -- beta",
    exitCode: 1,
    passed: false,
    summary: "beta failed",
    failureExcerpt: "AssertionError: MARKER_FAIL_BETA",
    worktree: wsB
  });
  recordHookLeaseTransition(
    store,
    "PreInvocation",
    { conversationId: convA, cwd: wsA, lastUserInput: "Run alpha pipeline" },
    { nowMs: baseNow, contextTokens: 165000, mediaCount: 1, model: "claude-opus-4-6" }
  );
  recordHookLeaseTransition(
    store,
    "PreInvocation",
    { conversationId: convB, cwd: wsB, lastUserInput: "Run beta pipeline" },
    { nowMs: baseNow, contextTokens: 120000, model: "gemini-4-pro" }
  );
  store.close();

  // Advance 950s so BOTH Window A and Window B are simultaneously STALLED
  virtualNow = baseNow + 950_000;
  virtualMono = 1_000_000_000_000n;

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  process.env.AGY_DART_DB_PATH = tmpDb;
  closeRuntimeStore();

  const token = "v173-dual-csrf-token-0123456789abcdef";
  const srv = createStandaloneServer({
    csrfToken: token,
    watchdogOptions: {
      brainRoots: [brainRoot],
      nowFn: () => virtualNow,
      monoNsFn: () => virtualMono,
      findTranscriptFn: () => null,
      notifyFn: () => {},
      focusWindowFn: () => ({ dispatched: false, platform: process.platform })
    }
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const authHeaders = { "X-Agy-Dart-Token": token };

  const markersA = ["MARKER_QUOTE_ALPHA", "MARKER_TASK_ALPHA", "MARKER_FAIL_ALPHA"];
  const markersB = ["MARKER_QUOTE_BETA", "MARKER_TASK_BETA", "MARKER_FAIL_BETA"];
  const assertHasNone = (rawStr, markers, label) => {
    for (const m of markers) {
      assert.ok(!rawStr.includes(m), `${label} must NOT contain ${m}`);
    }
  };

  try {
    // 1. Confirmed Window A: gets A markers, zero B markers across all 4 endpoints
    const wdA = await httpJsonRequest(port, "/api/watchdog", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convA, conversationConfirmed: true }
    });
    assert.equal(wdA.status, 200);
    assert.equal(wdA.json.current.conversationId, convA);
    assert.equal(wdA.json.current.severity, "stalled");
    assert.ok(wdA.json.current.rescueBrief?.markdown.includes("MARKER_QUOTE_ALPHA"));
    assert.ok(wdA.json.current.rescueBrief?.markdown.includes("MARKER_TASK_ALPHA"));
    assert.ok(wdA.json.current.rescueBrief?.markdown.includes("MARKER_FAIL_ALPHA"));
    assert.ok(wdA.json.sessions.every((s) => s.rescueBrief === null), "sessions[] must strip rescueBrief");
    assert.ok(wdA.json.alertingSessions.every((s) => s.rescueBrief === null), "alertingSessions[] must strip rescueBrief");
    assertHasNone(wdA.raw, markersB, "Confirmed A /api/watchdog");

    const hoA = await httpJsonRequest(port, "/api/handoff", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convA, mode: "agent", conversationConfirmed: true }
    });
    assert.equal(hoA.status, 200);
    for (const m of markersA) assert.ok(hoA.raw.includes(m), `Confirmed A /api/handoff missing ${m}`);
    assertHasNone(hoA.raw, markersB, "Confirmed A /api/handoff");

    const resA = await httpJsonRequest(port, "/api/resume", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convA, conversationConfirmed: true }
    });
    assert.equal(resA.status, 200);
    assert.ok(resA.raw.includes("MARKER_FAIL_ALPHA"));
    assertHasNone(resA.raw, markersB, "Confirmed A /api/resume");

    const actA = await httpJsonRequest(port, "/api/watchdog/action", {
      method: "POST",
      headers: authHeaders,
      body: { action: "setDesktopNotify", enabled: false, scope: "conversation", conversationId: convA, conversationConfirmed: true }
    });
    assert.equal(actA.status, 200);
    assertHasNone(actA.raw, markersB, "Confirmed A /api/watchdog/action");

    // 2. Switch to Confirmed Window B: B's cached rescueBrief remained intact internally!
    const wdB = await httpJsonRequest(port, "/api/watchdog", {
      method: "POST",
      headers: authHeaders,
      body: { scope: "conversation", conversationId: convB, conversationConfirmed: true }
    });
    assert.equal(wdB.status, 200);
    assert.equal(wdB.json.current.conversationId, convB);
    assert.ok(wdB.json.current.rescueBrief?.markdown.includes("MARKER_QUOTE_BETA"));
    assert.ok(wdB.json.current.rescueBrief?.markdown.includes("MARKER_TASK_BETA"));
    assert.ok(wdB.json.current.rescueBrief?.markdown.includes("MARKER_FAIL_BETA"));
    assertHasNone(wdB.raw, markersA, "Confirmed B /api/watchdog");

    // 3. Inferred-only ID (conversationConfirmed: false) -> ZERO A or B markers anywhere
    for (const [ep, body] of [
      ["/api/handoff", { scope: "conversation", conversationId: convA, mode: "agent", conversationConfirmed: false }],
      ["/api/resume", { scope: "conversation", conversationId: convA, conversationConfirmed: false }],
      ["/api/watchdog", { scope: "conversation", conversationId: convA, conversationConfirmed: false }],
      ["/api/watchdog/action", { action: "tick", scope: "conversation", conversationId: convA, conversationConfirmed: false }]
    ]) {
      const r = await httpJsonRequest(port, ep, { method: "POST", headers: authHeaders, body });
      assert.equal(r.status, 200, `Expected 200 for inferred-only ${ep}`);
      assertHasNone(r.raw, [...markersA, ...markersB], `Inferred-only ${ep}`);
      if (ep === "/api/handoff") assert.equal(r.json.anchors.confirmed, false);
      if (ep === "/api/watchdog") assert.equal(r.json.current?.rescueBrief ?? null, null);
    }

    // 4. Aggregate scopes (app / lifetime) even when carrying specific conversationId -> ZERO A/B semantic markers, keeps model/tokens alert!
    for (const aggScope of ["app", "lifetime"]) {
      const hoAgg = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: convA, mode: "agent", conversationConfirmed: true }
      });
      assert.equal(hoAgg.status, 200);
      assert.equal(hoAgg.json.confirmedConversation, false);
      assert.equal(hoAgg.json.anchors.confirmed, false);
      assert.equal(hoAgg.json.hasStallContext, true);
      assert.ok(hoAgg.json.markdown.includes("165k tok") || hoAgg.json.markdown.includes("120k tok"), "Aggregate stall must retain tokens");
      assert.ok(
        hoAgg.json.markdown.includes("claude-opus-4-6") || hoAgg.json.markdown.includes("gemini-4-pro"),
        "Aggregate stall must retain model"
      );
      assertHasNone(hoAgg.raw, [...markersA, ...markersB], `Aggregate(${aggScope}) /api/handoff`);

      const resAgg = await httpJsonRequest(port, "/api/resume", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: convA }
      });
      assert.equal(resAgg.status, 200);
      assertHasNone(resAgg.raw, [...markersA, ...markersB], `Aggregate(${aggScope}) /api/resume`);

      const wdAgg = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: convA }
      });
      assert.equal(wdAgg.status, 200);
      assert.equal(wdAgg.json.current?.rescueBrief ?? null, null);
      assertHasNone(wdAgg.raw, [...markersA, ...markersB], `Aggregate(${aggScope}) /api/watchdog`);

      const actAgg = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setDesktopNotify", enabled: false, scope: aggScope, conversationId: convA }
      });
      assert.equal(actAgg.status, 200);
      assert.equal(actAgg.json.status?.current?.rescueBrief ?? null, null);
      assertHasNone(actAgg.raw, [...markersA, ...markersB], `Aggregate(${aggScope}) /api/watchdog/action`);
    }

    // 5. Unbound host tab -> ZERO A/B markers
    for (const [ep, body] of [
      ["/api/handoff", { scope: "conversation", conversationId: "", fromSidecarHost: true, mode: "agent" }],
      ["/api/resume", { scope: "conversation", conversationId: "", fromSidecarHost: true }],
      ["/api/watchdog", { scope: "conversation", conversationId: "", fromSidecarHost: true }],
      ["/api/watchdog/action", { action: "tick", scope: "conversation", conversationId: "", fromSidecarHost: true }]
    ]) {
      const r = await httpJsonRequest(port, ep, { method: "POST", headers: authHeaders, body });
      assert.equal(r.status, 200);
      assertHasNone(r.raw, [...markersA, ...markersB], `Unbound ${ep}`);
    }

    // Verify standalone inferredFallbackConvId sends conversationConfirmed: false, blocks cached rescueBrief & disables prompt button
    const inferredCalls = [];
    const { ctx: infCtx, elements: infEls } = createDashboardVmSandbox({
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        inferredCalls.push({ url, body });
        if (url === "/api/handoff") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              scope: body.scope || "conversation",
              mode: "agent",
              confirmedConversation: body.conversationConfirmed === true,
              conversationId: body.conversationId || "",
              markdown: "# Overview",
              summary: "scope=conversation",
              bytes: 10,
              truncated: false,
              anchors: { confirmed: false, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });
    const leakedInfRescue = vm.runInContext(
      `inferredFallbackConvId = ${JSON.stringify(convA)};
       cachedWatchdog = { current: { conversationId: ${JSON.stringify(convA)}, severity: 'stalled', rescueBrief: { conversationId: ${JSON.stringify(convA)}, confirmedConversation: true, markdown: '# LEAKED_RESCUE', anchors: { confirmed: true } } } };
       const r = getMatchingRescueBrief();
       toggleHandoffDrawer(true);
       r;`,
      infCtx
    );
    assert.equal(leakedInfRescue, null, "getMatchingRescueBrief() must return null when conversation is only inferred");
    await new Promise((r) => setTimeout(r, 20));
    const infHoCall = inferredCalls.find((c) => c.url === "/api/handoff");
    assert.ok(infHoCall, "Expected /api/handoff call for inferredFallbackConvId");
    assert.equal(infHoCall.body.conversationId, convA);
    assert.equal(infHoCall.body.conversationConfirmed, false, "Inferred fallback ID MUST send conversationConfirmed=false");
    assert.equal(infEls.get("kv-handoff-prompt-btn").disabled, true, "Inferred-only view must keep semantic prompt button disabled");

    // Verify native sidecar unbound tab sends fromSidecarHost: true on /api/resume,
    // cross-workspace jump sends conversationConfirmed: false, and native switch + Refresh does not double-fetch
    const nativeCalls = [];
    const nativeSidecar = {
      conversationId: "",
      getWorkspaceUris: async () => [`file:///${wsA.replace(/\\/g, "/")}`],
      ui: { toggleConversation() {} },
      fetch: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        nativeCalls.push({ url, body });
        if (url === "/api/handoff") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              scope: body.scope || "conversation",
              mode: "agent",
              confirmedConversation: body.conversationConfirmed === true,
              conversationId: body.conversationId || "",
              markdown: "# Native " + (body.conversationId || "unbound"),
              bytes: 16,
              truncated: false,
              anchors: { confirmed: body.conversationConfirmed === true, conversationId: body.conversationId || "" }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    const { ctx: natCtx } = createDashboardVmSandbox({ sidecarObj: nativeSidecar, fetchImpl: nativeSidecar.fetch });
    await new Promise((r) => setTimeout(r, 20));
    const unboundResumeCall = nativeCalls.find((c) => c.url === "/api/resume");
    assert.equal(unboundResumeCall?.body?.fromSidecarHost, true, "Unbound native sidecar /api/resume must send fromSidecarHost: true");

    nativeSidecar.conversationId = convA;
    await vm.runInContext("toggleHandoffDrawer(true);", natCtx);
    nativeCalls.length = 0;
    await vm.runInContext(`jumpToConversation(${JSON.stringify(convB)}, { cwd: ${JSON.stringify(wsB)}, workspaceLabel: 'ws-b' });`, natCtx);
    const crossFocusCall = nativeCalls.find((c) => c.url === "/api/watchdog/action" && c.body.action === "focusConversation");
    assert.equal(crossFocusCall?.body?.conversationConfirmed, false, "Cross-workspace focusConversation must not request other window rich rescue");

    nativeCalls.length = 0;
    nativeSidecar.conversationId = convB;
    await vm.runInContext("loadHandoffBrief({ forceRefresh: true });", natCtx);
    const switchHoCalls = nativeCalls.filter((c) => c.url === "/api/handoff");
    assert.equal(switchHoCalls.length, 1, "Native switch + Refresh must issue exactly 1 /api/handoff POST (no re-entrant double fetch)");
    assert.equal(switchHoCalls[0].body.conversationId, convB);

    // 6. VM DOM race test: A -> B switch clears preview/buttons & discards stale late A response
    const pendingByConv = new Map();
    const copied = [];
    const { ctx, elements } = createDashboardVmSandbox({
      copiedOut: copied,
      fetchImpl: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          return new Promise((resolve) => {
            pendingByConv.set(body.conversationId, () =>
              resolve({
                ok: true,
                status: 200,
                json: async () =>
                  body.conversationId === convA
                    ? {
                        ok: true,
                        scope: body.scope || "conversation",
                        mode: "agent",
                        confirmedConversation: true,
                        conversationId: convA,
                        markdown: "# Brief A\nMARKER_QUOTE_ALPHA",
                        summary: "A",
                        bytes: 28,
                        truncated: false,
                        anchors: {
                          confirmed: true,
                          conversationId: convA,
                          sessionId: convA,
                          branch: "branch-A",
                          nextTasks: ["[/] MARKER_TASK_ALPHA"],
                          failingChecks: [],
                          artifacts: [],
                          recentSources: [],
                          resumeSameWindow: "ctx_resume({})",
                          resumeCrossWindow: `ctx_resume({ sessionId: "${convA}" })`
                        }
                      }
                    : {
                        ok: true,
                        scope: body.scope || "conversation",
                        mode: "agent",
                        confirmedConversation: true,
                        conversationId: convB,
                        markdown: "# Brief B\nMARKER_QUOTE_BETA",
                        summary: "B",
                        bytes: 27,
                        truncated: false,
                        anchors: {
                          confirmed: true,
                          conversationId: convB,
                          sessionId: convB,
                          branch: "branch-B",
                          nextTasks: ["[/] MARKER_TASK_BETA"],
                          failingChecks: [],
                          artifacts: [],
                          recentSources: [],
                          resumeSameWindow: "ctx_resume({})",
                          resumeCrossWindow: `ctx_resume({ sessionId: "${convB}" })`
                        }
                      }
              })
            );
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    });

    vm.runInContext(`selectedConvOverride = ${JSON.stringify(convA)}; toggleHandoffDrawer(true);`, ctx);
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, "Copy button must be disabled while A loads");
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, "Prompt button must be disabled while A loads");
    assert.ok(pendingByConv.has(convA));

    // Switch A -> B while A is still in-flight
    vm.runInContext(`selectedConvOverride = ${JSON.stringify(convB)}; clearHandoffSnapshot({ resetPreview: true, reloadIfOpen: true });`, ctx);
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
    assert.ok(pendingByConv.has(convB));

    // B finishes FIRST
    pendingByConv.get(convB)();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("MARKER_QUOTE_BETA"));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);

    // Stale A arrives LATE -> MUST be discarded!
    pendingByConv.get(convA)();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("MARKER_QUOTE_BETA"));
    assert.ok(!elements.get("kv-handoff-preview").textContent.includes("MARKER_QUOTE_ALPHA"));

    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 2);
    assert.ok(copied[0].includes("MARKER_QUOTE_BETA") && !copied[0].includes("MARKER_QUOTE_ALPHA"));
    assert.ok(copied[1].includes("MARKER_TASK_BETA") && !copied[1].includes("MARKER_TASK_ALPHA"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-4: CLI short & tail failures, PostToolUse run_checks/verify excerpts, FAIL->PASS & no-error clearing, slot independence, legacy JSON, 0 getSourceChunks & ctx_resume <=8500 B", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-verify-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const sid = "conv-verify-evidence";

  const runCliFilter = (ruleId, cmdStr) => {
    const b64 = `b:${Buffer.from(cmdStr, "utf8").toString("base64url")}`;
    const sidB64 = `b:${Buffer.from(sid, "utf8").toString("base64url")}`;
    return spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "cli-filter.mjs"), "--rule", ruleId, "--b64", b64, "--orig-b64", b64, "--session", sidB64],
      {
        cwd: tmpDir,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
  };

  const runPostToolUse = (payload) => {
    const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "post-tool-use.mjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    assert.equal(res.status, 0, `post-tool-use failed: ${res.stderr}`);
  };

  const store = new ContextModeStore({ dbPath: tmpDb });
  try {
    // 0. Direct extractFailureExcerpt unit checks (filters 0 failed / 0 errors AND passing tests containing "fail"/"error"!)
    assert.equal(extractFailureExcerpt("All done: 0 failed, 0 errors\nok 1 - test\n"), "");
    const passNoiseLog = [
      "✔ Hardening regressions: CLI filter edge cases (fail tail preservation) (12ms)",
      "✔ Python non-string JSON errors handled cleanly (5ms)",
      "--- PASS: TestErrorHandling (0.00s)",
      "tests/test_err.py::test_fail_ok PASSED [ 50%]",
      "test error_mod::test_fail_gracefully ... ok",
      "PASS a",
      "✖ auth/login fails",
      "AssertionError: expected 200 got 401",
      "  at auth.test.mjs:19"
    ].join("\n");
    const ex = extractFailureExcerpt(passNoiseLog);
    assert.ok(ex.includes("auth/login fails") && ex.includes("AssertionError: expected 200 got 401"));
    assert.ok(!ex.includes("Hardening regressions") && !ex.includes("TestErrorHandling") && !ex.includes("PASSED"));
    assert.ok(Buffer.byteLength(ex, "utf8") <= 500);
    assert.ok(ex.split("\n").length <= 5);
    assert.equal(
      extractFailureExcerpt("✔ handles error states (2ms)\n--- PASS: TestFail (0.00s)\n"),
      "",
      "Passing tests alone with 'error'/'fail' in names must return empty excerpt"
    );

    // 1. CLI short failure (<1 KiB, no sourceId) captures failureExcerpt
    const shortRes = runCliFilter("test-runner", `node -e "console.error('AssertionError: short_cli_boom'); process.exit(1)"`);
    assert.equal(shortRes.status, 1);
    let cp = store.getSessionCheckpoint(sid);
    assert.equal(cp.lastTest.ok, false);
    assert.equal(cp.lastTest.sourceId, null, "Short <1 KiB failure should have sourceId=null");
    assert.ok(cp.lastTest.failureExcerpt?.includes("AssertionError: short_cli_boom"));

    // 2. CLI long log failure (>4 KiB noise + error at very end, has sourceId)
    const longRes = runCliFilter(
      "test-runner",
      `node -e "for(let i=0;i<120;i++) console.log('ok '+i+' passed noise line '+'z'.repeat(40)); console.error('TypeError: tail_end_explosion'); process.exit(1)"`
    );
    assert.equal(longRes.status, 1);
    cp = store.getSessionCheckpoint(sid);
    assert.ok(cp.lastTest.sourceId, "Long failure should index sourceId");
    assert.ok(cp.lastTest.failureExcerpt?.includes("TypeError: tail_end_explosion"));

    // 3. Fail A -> Fail B with NO error anchor lines clears stale failureExcerpt!
    const neutralFail = runCliFilter("test-runner", `node -e "console.log('completed step; 0 failed; 0 errors'); process.exit(1)"`);
    assert.equal(neutralFail.status, 1);
    cp = store.getSessionCheckpoint(sid);
    assert.equal(cp.lastTest.ok, false);
    assert.equal(cp.lastTest.failureExcerpt, undefined, "Fail B without error lines must clear stale failureExcerpt");

    // 4. PostToolUse: run_checks mixed PASS/FAIL skips PASS block and extracts ONLY FAIL block
    runPostToolUse({
      conversationId: sid,
      cwd: tmpDir,
      toolCall: {
        name: "run_checks",
        args: { commands: [{ name: "pass-suite", command: "npm run lint" }, { name: "unit-test", command: "npm test" }] }
      },
      toolResponse: [
        "Checks: 1/2 passed, 1 failed (wall: 50ms)",
        "",
        "## [PASS] pass-suite (10ms)",
        "$ npm run lint",
        "ErrorHandler test passed (0 errors)",
        "",
        "## [FAIL (exit 1) 40ms] unit-test",
        "$ npm test",
        "✖ checkout rejects expired card",
        "AssertionError: expected 400 received 500"
      ].join("\n")
    });
    cp = store.getSessionCheckpoint(sid);
    assert.equal(cp.lastTest.ok, false);
    assert.ok(cp.lastTest.failureExcerpt?.includes("AssertionError: expected 400 received 500"));
    assert.ok(!cp.lastTest.failureExcerpt?.includes("ErrorHandler test passed"));

    // 5. PostToolUse: apply_edits.verify (build slot) independent of test slot + redacts secret
    runPostToolUse({
      conversationId: sid,
      cwd: tmpDir,
      toolCall: {
        name: "apply_edits",
        args: { edits: [], verify: "npm run build" }
      },
      toolResponse: [
        "Applied edits to 1 file(s):",
        "- src/a.ts: updated",
        "Verify [FAIL (exit 2) in 88ms] `npm run build`:",
        "src/a.ts(14,5): error TS2322: Type 'string' is not assignable (leak=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234)"
      ].join("\n")
    });
    cp = store.getSessionCheckpoint(sid);
    assert.equal(cp.lastBuild.ok, false);
    assert.ok(cp.lastBuild.failureExcerpt?.includes("error TS2322"));
    assert.ok(!cp.lastBuild.failureExcerpt?.includes("ghp_1234567890"), "Verify excerpt must be secret-redacted");
    assert.ok(cp.lastTest.failureExcerpt?.includes("AssertionError: expected 400 received 500"), "test slot must stay independent from build slot");

    // Verify synchronous extractVerificationSignal exposes failureSection cleanly (including backticks inside verify command)
    const sig = extractVerificationSignal("apply_edits", { verify: "npm test" }, "Verify [FAIL in 12ms] `npm test`:\nReferenceError: x is not defined");
    assert.equal(sig.passed, false);
    assert.ok(sig.failureSection.includes("ReferenceError: x is not defined"));
    const sigBt = extractVerificationSignal(
      "apply_edits",
      { verify: 'node -e "console.log(`boom`)"' },
      'Verify [FAIL (exit 1) in 12ms] `node -e "console.log(`boom`)"`:\nReferenceError: boom is not defined'
    );
    assert.ok(sigBt && sigBt.passed === false && sigBt.failureSection.includes("ReferenceError: boom is not defined"));

    // 6. FAIL -> PASS on test slot clears test failureExcerpt while preserving build slot!
    runPostToolUse({
      conversationId: sid,
      cwd: tmpDir,
      toolCall: { name: "run_checks", args: { commands: [{ name: "unit-test", command: "npm test" }] } },
      toolResponse: "Checks: 1/1 passed (wall: 20ms)\n- [PASS 20ms] unit-test (`npm test`): ok"
    });
    cp = store.getSessionCheckpoint(sid);
    assert.equal(cp.lastTest.ok, true);
    assert.equal(cp.lastTest.failureExcerpt, undefined, "PASS must clear test failureExcerpt");
    assert.ok(cp.lastBuild.failureExcerpt?.includes("error TS2322"), "Clearing test slot must NOT touch build slot");

    // 7. Spy: buildHandoffBrief must NEVER call store.getSourceChunks()
    let getSourceChunksCalls = 0;
    const origGetSourceChunks = store.getSourceChunks.bind(store);
    store.getSourceChunks = (...args) => {
      getSourceChunksCalls += 1;
      return origGetSourceChunks(...args);
    };
    const brief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: tmpDir
    });
    assert.equal(getSourceChunksCalls, 0, "buildHandoffBrief must NEVER call store.getSourceChunks()");
    assert.ok(brief.markdown.includes("error TS2322"));

    // 8. Legacy JSON checkpoint without failureExcerpt field remains 100% compatible
    const legacySid = "conv-legacy-json";
    store.open();
    store.db
      .prepare(
        `INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
         VALUES (?, ?, '["legacy.js"]', ?, NULL, ?, ?)`
      )
      .run(
        legacySid,
        tmpDir,
        JSON.stringify({ command: "npm test", ruleId: "test-runner", ok: false, exitCode: 1, summary: "legacy fail summary", sourceId: "src_old_1", at: "2026-10-01T00:00:00.000Z" }),
        Date.now(),
        "2026-10-01T00:00:00.000Z"
      );
    const legacyBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: legacySid,
      conversationConfirmed: true,
      sessionId: legacySid,
      cwd: tmpDir
    });
    assert.ok(legacyBrief.markdown.includes("legacy fail summary"));
    assert.ok(legacyBrief.markdown.includes("src_old_1"));

    // 9. ctx_resume stays strictly <= 8500 B even with heavy CJK files + failureExcerpts on both slots
    const heavySid = "conv-resume-cap";
    const heavyFiles = Array.from({ length: 20 }, (_, i) => `模块目录/超长中文子路径_${i}_${"文件".repeat(35)}.ts`);
    store.recordModifiedFiles(heavySid, heavyFiles, { worktree: tmpDir, tool: "edit_file" });
    store.recordVerificationResult(heavySid, {
      kind: "test",
      command: "node --test " + "中文命令".repeat(25),
      exitCode: 1,
      passed: false,
      summary: "失败摘要".repeat(40),
      failureExcerpt: ("AssertionError: 中文失败摘录🚀\"\\n" + "错".repeat(40) + "\n").repeat(5),
      worktree: tmpDir
    });
    store.recordVerificationResult(heavySid, {
      kind: "build",
      command: "tsc --noEmit " + "构建参数".repeat(25),
      exitCode: 1,
      passed: false,
      summary: "编译失败".repeat(40),
      failureExcerpt: ("error TS2322: 中文类型错误🔥\"\\n" + "误".repeat(40) + "\n").repeat(5),
      worktree: tmpDir
    });
    for (let i = 0; i < 6; i++) {
      store.indexContent({
        sessionId: heavySid,
        worktree: tmpDir,
        kind: "file",
        label: `超长索引标签_${i}_${"说明".repeat(35)}.log`,
        content: "日志正文".repeat(100)
      });
    }
    const tools = createTools({
      store,
      getCwd: () => tmpDir,
      getSessionId: () => heavySid
    });
    const resumed = await tools.ctx_resume({ sessionId: heavySid });
    const resumeBytes = Buffer.byteLength(JSON.stringify(resumed, null, 2), "utf8");
    assert.ok(resumeBytes <= 8500, `ctx_resume exceeded 8500 B cap: got ${resumeBytes}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-5: Git states (untracked dir/file, clean commit, detached HEAD, unborn, non-git), shared 1200ms slow-Git deadline & bilingual narrow-UI dual-track DOM", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-git-ui-"));
  const repoDir = path.join(tmpDir, "repo-main");
  const unbornDir = path.join(tmpDir, "repo-unborn");
  const nonGitDir = path.join(tmpDir, "plain-non-git");
  const tmpDb = path.join(tmpDir, "context.db");

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(unbornDir, { recursive: true });
  fs.mkdirSync(nonGitDir, { recursive: true });

  const store = new ContextModeStore({ dbPath: tmpDb });
  const sid = "conv-git-ui";
  try {
    // 1. Freshly committed repo (empty diff) + recent branch history
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["checkout", "-b", "main"]);
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const a = 1;\n", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "feat: first commit"]);
    fs.writeFileSync(path.join(repoDir, "b.js"), "export const b = 2;\n", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "fix: second commit"]);

    const cleanBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: repoDir
    });
    assert.ok(cleanBrief.markdown.includes("Git Branch**: `main`"));
    assert.ok(!cleanBrief.markdown.includes("**Diff Stat**"), "Freshly committed repo must omit empty diff stat");
    assert.ok(cleanBrief.markdown.includes("Branch History"));
    assert.ok(cleanBrief.markdown.includes("fix: second commit"));

    // 2. Untracked file + untracked directory collapse (--untracked-files=normal)
    fs.writeFileSync(path.join(repoDir, "loose.txt"), "hello\n", "utf8");
    fs.mkdirSync(path.join(repoDir, "untracked-dir"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "untracked-dir", "inner1.txt"), "1\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "untracked-dir", "inner2.txt"), "2\n", "utf8");
    const untrackedBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: repoDir
    });
    assert.ok(untrackedBrief.markdown.includes("loose.txt"));
    assert.ok(untrackedBrief.markdown.includes("untracked-dir/"), "Untracked directory should collapse via --untracked-files=normal");
    assert.ok(!untrackedBrief.markdown.includes("inner1.txt"));

    // 3. Detached HEAD
    runGit(repoDir, ["checkout", "--detach", "HEAD"]);
    const detachedBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: repoDir
    });
    assert.ok(detachedBrief.markdown.includes("detached@"), `Expected detached@<sha>:\n${detachedBrief.markdown}`);

    // 4. Unborn repo (git init, 0 commits, 1 untracked file)
    runGit(unbornDir, ["init"]);
    fs.writeFileSync(path.join(unbornDir, "draft.md"), "# draft\n", "utf8");
    const unbornBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: unbornDir
    });
    assert.ok(unbornBrief.markdown.includes("Git Branch"));
    assert.ok(unbornBrief.markdown.includes("draft.md"));
    assert.ok(!unbornBrief.markdown.includes("Branch History"));

    // 5. Non-Git directory
    const nonGitBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: nonGitDir
    });
    assert.ok(!nonGitBrief.markdown.includes("Git Branch"));
    assert.ok(!nonGitBrief.markdown.includes("## Git Workspace"));

    // 6. Controlled slow-Git shared 1200ms monotonic deadline (single call timeout = min(500, remaining))
    store.recordVerificationResult(sid, {
      kind: "test",
      command: "npm test",
      exitCode: 0,
      passed: true,
      summary: "checkpoint still copyable",
      worktree: repoDir
    });
    let fakeMonoNs = 1_000_000_000n;
    const recordedTimeouts = [];
    const slowGitBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: repoDir,
      gitBudgetMs: 1200,
      monoNsFn: () => fakeMonoNs,
      gitExecFn: (args, opts) => {
        recordedTimeouts.push(opts.timeout);
        // Simulate each git call taking 450ms
        fakeMonoNs += 450_000_000n;
        if (args.includes("status")) {
          return { status: 0, stdout: "## main\0 M a.js\0", stderr: "" };
        }
        if (args.includes("diff")) {
          return { status: 0, stdout: " a.js | 2 ++\n 1 file changed, 2 insertions(+)\n", stderr: "" };
        }
        // 3rd call (log): only 300ms remained -> times out!
        return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) };
      }
    });
    assert.deepEqual(
      recordedTimeouts,
      [500, 500, 300],
      `Expected shared 1200ms deadline timeouts [500, 500, 300], got ${JSON.stringify(recordedTimeouts)}`
    );
    assert.equal(slowGitBrief.gitTimedOut, true);
    assert.ok(slowGitBrief.markdown.includes("checkpoint still copyable"), "Checkpoint must stay copyable when Git times out");
    assert.ok(slowGitBrief.markdown.includes("timed out after 1200ms"));

    // 6b. Real OS spawnSync timeout check with tight 1ms budget against real git binary
    const realTimeoutBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: sid,
      conversationConfirmed: true,
      sessionId: sid,
      cwd: repoDir,
      gitBudgetMs: 1
    });
    assert.equal(realTimeoutBrief.gitTimedOut, true, "Real OS git subprocess with 1ms budget must report gitTimedOut");
    assert.ok(realTimeoutBrief.markdown.includes("checkpoint still copyable"), "Checkpoint must stay intact after real OS git timeout");

    // 7. Bilingual narrow-width (360-450px) dual-track UI VM DOM check
    const copied = [];
    const fetchLog = [];
    const sampleAnchors = {
      confirmed: true,
      conversationId: sid,
      sessionId: sid,
      workspace: repoDir.replace(/\\/g, "/"),
      branch: "feat/handoff",
      artifacts: [{ name: "task.md", path: "/brain/conv-git-ui/task.md", mtime: "2026-11-24T10:00:00.000Z" }],
      nextTasks: ["[/] Wire dual-track drawer"],
      failingChecks: [{ kind: "test", command: "npm test", summary: "1 failed", sourceId: "src_fail_9", firstErrorLine: "AssertionError: boom" }],
      recentSources: [{ id: "src_fail_9", label: "cli:test-runner" }],
      stallSummary: "",
      resumeSameWindow: "ctx_resume({})",
      resumeCrossWindow: `ctx_resume({ sessionId: "${sid}" })`
    };
    let mockCacheTemp = "warm";
    const { html, ctx, elements } = createDashboardVmSandbox({
      copiedOut: copied,
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        fetchLog.push({ url, method: opts?.method, body });
        if (url === "/api/cache-diag") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, transcriptFound: true, cacheTemperature: mockCacheTemp })
          };
        }
        if (url === "/api/handoff") {
          const isConf = body.scope === "conversation" && body.conversationConfirmed === true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              scope: body.scope || "conversation",
              mode: "agent",
              confirmedConversation: isConf,
              conversationId: body.conversationId || "",
              markdown: isConf ? "# Fact Brief Markdown\n- **Git Branch**: `feat/handoff`" : "# Overview Only",
              summary: isConf ? "branch=feat/handoff" : "scope=app",
              bytes: 55,
              truncated: false,
              anchors: isConf ? sampleAnchors : { confirmed: false, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });

    // Narrow-sidebar stacked CSS & preserved a2a8e36 diagnostics checks
    assert.ok(html.includes(".handoff-dual-actions") && html.includes("flex-direction: column"));
    assert.ok(html.includes('id="kv-handoff-copy-btn"') && html.includes('id="kv-handoff-prompt-btn"') && html.includes('id="kv-handoff-warmth-hint"'));
    assert.ok(html.includes("hasValidDriftBreakdown") && html.includes("hasValidPriorContextMatch"));

    // Open drawer on confirmed warm cache conversation
    vm.runInContext(
      `selectedConvOverride = ${JSON.stringify(sid)}; cachedKv = { cacheTemperature: 'warm' }; setLanguage('zh'); toggleHandoffDrawer(true);`,
      ctx
    );
    await new Promise((r) => setTimeout(r, 20));

    const hoCall = fetchLog.find((c) => c.url === "/api/handoff");
    assert.ok(hoCall && hoCall.method === "POST");
    assert.equal(hoCall.body.mode, "agent");
    assert.equal(hoCall.body.conversationConfirmed, true);

    assert.equal(elements.get("kv-handoff-copy-btn").textContent, "复制事实简报");
    assert.equal(elements.get("kv-handoff-prompt-btn").textContent, "复制给当前窗口的交接指令");
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
    assert.ok(elements.get("kv-handoff-warmth-hint").textContent.includes("缓存尚热"));

    // Primary & secondary copy in ZH
    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 2);
    assert.ok(copied[0].includes("# Fact Brief Markdown"));
    assert.ok(copied[1].startsWith("宝宝，请为新窗口写一份可直接使用的 Markdown 交接单，控制在 800 字以内"));
    assert.ok(copied[1].includes("但交接单正文的第一个词必须是「宝宝」（第一句直接以「宝宝，」开头）"));
    assert.ok(copied[1].includes("feat/handoff"));
    assert.ok(copied[1].includes("task.md"));
    assert.ok(copied[1].includes("AssertionError: boom"));
    assert.ok(copied[1].includes("src_fail_9"));
    assert.ok(copied[1].includes(`ctx_resume({ sessionId: "${sid}" })`));

    // Switch to EN & cold cache -> warmth hint updates, EN prompt copies all anchors
    mockCacheTemp = "cold";
    vm.runInContext("cachedKv = { transcriptFound: true, cacheTemperature: 'cold' }; setLanguage('en');", ctx);
    assert.ok(elements.get("kv-handoff-warmth-hint").textContent.includes("Cache is cold"));
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 3);
    assert.ok(copied[2].startsWith("Sweetie, please write a ready-to-use Markdown handoff brief"));
    assert.ok(copied[2].includes('starting the very first sentence of the brief with "Sweetie," as its first word'));
    assert.ok(copied[2].includes("feat/handoff") && copied[2].includes("src_fail_9"));

    // Verify lossless Markdown backtick quoting & structure validity in buildSemanticHandoffPrompt (P2-09)
    for (const lang of ["en", "zh"]) {
      const btPrompt = vm.runInContext(
        `buildSemanticHandoffPrompt({
           confirmedConversation: true,
           secretRedactionEnabled: true,
           anchors: {
             confirmed: true,
             conversationId: ${JSON.stringify(sid)},
             branch: "feat/handoff",
             nextTasks: ["[/] Check \`\`\`fence\`\`\` safely"],
             modifiedFiles: ["src/a.js", "src/path-with-\`tick\`-AKIA0123456789ABCDEF.js"],
             modifiedFileCount: 5,
             failingChecks: [{ kind: "test", command: 'node -e "console.log(\`hi\`)"', firstErrorLine: "err \`\`\`js", sourceId: "src_1" }],
             passingChecks: [{ kind: "build", command: 'npm run build -- \`fast\`', summary: "ok \`\`\`pass", sourceId: "src_ok_2" }],
             recentSources: [{ id: "src_1", label: "log \`\`\`\`quad\`\`\`\` label" }],
             resumeSameWindow: "ctx_resume({})",
             resumeCrossWindow: ""
           }
         }, ${JSON.stringify(lang)});`,
        ctx
      );
      assert.ok(btPrompt.includes('``node -e "console.log(`hi`)"``'), `(${lang}) Backtick inside command must use dynamic inline code delimiters`);
      assert.ok(btPrompt.includes("````[/] Check ```fence``` safely````"), `(${lang}) Task with triple backticks must be losslessly quoted with 4-backtick inline span`);
      assert.ok(btPrompt.includes("````err ```js````"), `(${lang}) Error with triple backticks must be losslessly quoted`);
      assert.ok(btPrompt.includes("``npm run build -- `fast` ``") || btPrompt.includes("`` npm run build -- `fast` ``"), `(${lang}) Passing check command with backticks must use dynamic inline code delimiters`);
      assert.ok(btPrompt.includes("````ok ```pass````"), `(${lang}) Passing check summary with triple backticks must be losslessly quoted`);
      assert.ok(btPrompt.includes("src_ok_2"), `(${lang}) Passing check sourceId must be preserved`);
      assert.ok(btPrompt.includes(lang === "zh" ? "本轮已改文件（5 个）" : "Modified Files (5)"), `(${lang}) Modified files count must be rendered`);
      assert.ok(btPrompt.includes(lang === "zh" ? "另 3 个" : "+3 more"), `(${lang}) Overflow modified files count must be rendered`);
      assert.ok(!btPrompt.includes("AKIA0123456789ABCDEF"), `(${lang}) Modified files in semantic prompt must redact secrets when redaction ON`);
      assert.ok(btPrompt.includes("`````log ````quad```` label`````"), `(${lang}) Source label with 4 backticks must be losslessly quoted with 5-backtick inline span`);
      assert.ok(!btPrompt.includes("'''"), `(${lang}) Must not corrupt backticks into single quotes`);
      assert.equal(hasUnclosedFence(btPrompt), false, `(${lang}) Prompt must keep valid Markdown structure without unclosed fences`);
    }

    // Switch to aggregate scope 'app' -> clears old snapshot & disables secondary prompt button
    vm.runInContext("setScope('app');", ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, "Overview mode must disable semantic prompt button");
    assert.ok(elements.get("kv-handoff-warmth-hint").textContent.includes("Overview mode"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-6: P1-01/P1-02/P1-05/P2-03 session isolation, trusted child->root checkpoint ownership & single-line CLI error stripping", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-p1-iso-"));
  const brainRoot = path.join(tmpDir, "brain");
  const wsA = path.join(tmpDir, "ws-a");
  const wsB = path.join(tmpDir, "ws-b");
  const wsC = path.join(tmpDir, "ws-c");
  const tmpDb = path.join(tmpDir, "context.db");
  const convA = "conv-p1-alpha";
  const convB = "conv-p1-beta";
  const childC = "conv-p1-child-c";
  const rootC = "root-p1-session-c";

  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.mkdirSync(wsC, { recursive: true });
  const logA = path.join(brainRoot, convA, ".system_generated", "logs");
  const logB = path.join(brainRoot, convB, ".system_generated", "logs");
  fs.mkdirSync(logA, { recursive: true });
  fs.mkdirSync(logB, { recursive: true });

  const txA = path.join(logA, "transcript.jsonl");
  const txB = path.join(logB, "transcript.jsonl");
  fs.writeFileSync(
    txA,
    JSON.stringify({ type: "USER_INPUT", step_index: 1, created_at: "2026-11-24T10:00:00.000Z", user_input: "<USER_REQUEST>P1_QUOTE_ALPHA</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    txB,
    JSON.stringify({ type: "USER_INPUT", step_index: 1, created_at: "2026-11-24T10:00:00.000Z", user_input: "<USER_REQUEST>P1_QUOTE_BETA</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(brainRoot, convA, "task.md"), "- [/] P1_TASK_ALPHA\n", "utf8");
  fs.writeFileSync(path.join(brainRoot, convB, "task.md"), "- [/] P1_TASK_BETA\n", "utf8");

  const store = new ContextModeStore({ dbPath: tmpDb });
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const baseNow = Date.now();
  const virtualNow = baseNow + 950_000;
  try {
    // Seed stalled leases for A & B with distinct lastUserInput markers (virtualNow = baseNow + 950s > 600s threshold)
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      {
        conversationId: convA,
        cwd: wsA,
        lastUserInput: "P1_LEASE_INPUT_ALPHA",
        transcriptPath: txA
      },
      { nowMs: baseNow, model: "claude-opus-4-6", contextTokens: 150000 }
    );
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      {
        conversationId: convB,
        cwd: wsB,
        lastUserInput: "P1_LEASE_INPUT_BETA",
        transcriptPath: txB
      },
      { nowMs: baseNow, model: "gemini-4-pro", contextTokens: 115000 }
    );
    // Legitimate childC -> rootC lease mapping
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      {
        conversationId: childC,
        parentConversationId: rootC,
        rootSessionId: rootC,
        cwd: wsC,
        lastUserInput: "P1_LEASE_CHILD_C"
      },
      { nowMs: virtualNow - 10_000 }
    );

    store.recordModifiedFiles(convA, [path.join(wsA, "alpha-only.js")], { worktree: wsA, tool: "apply_edits" });
    store.recordModifiedFiles(convB, [path.join(wsB, "beta-secret.js")], { worktree: wsB, tool: "apply_edits" });
    store.recordVerificationResult(convB, {
      kind: "test",
      command: "npm test -- beta",
      exitCode: 1,
      passed: false,
      summary: "P1_BETA_FAIL_SUMMARY",
      failureExcerpt: "AssertionError: P1_BETA_FAIL_EXCERPT",
      worktree: wsB
    });
    store.recordModifiedFiles(rootC, [path.join(wsC, "root-c-file.js")], { worktree: wsC, tool: "apply_edits" });
    store.close();

    // P1-05 & P2-03: Write a single-line failure to rootC via REAL cli-filter.mjs (so extractCompactVerdict writes the exact single error line into summary!)
    const singleErrScript = path.join(wsC, "single-err.mjs");
    fs.writeFileSync(
      singleErrScript,
      `process.stdout.write("Error: P105_SINGLE_LINE_ONLY_ERR_991\\n");\nprocess.exit(1);\n`,
      "utf8"
    );
    const cliFilterPath = path.join(ROOT, "hooks", "cli-filter.mjs");
    const singleErrCmd = `node ${JSON.stringify(singleErrScript)}`;
    const cliRun = spawnSync(
      process.execPath,
      [
        cliFilterPath,
        "--rule",
        "test-runner",
        "--b64",
        `b:${Buffer.from(singleErrCmd, "utf8").toString("base64url")}`,
        "--session",
        `b:${Buffer.from(childC, "utf8").toString("base64url")}`
      ],
      {
        cwd: wsC,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
      }
    );
    assert.equal(cliRun.status, 1, `Real CLI single-line error run must preserve exit 1, stderr=${cliRun.stderr}`);

    // Verify DB actually stored the single error line into rootC's summary & failureExcerpt
    const checkStore = new ContextModeStore({ dbPath: tmpDb });
    const cpRootC = checkStore.getSessionCheckpoint(rootC);
    assert.ok(cpRootC.lastTest?.summary?.includes("P105_SINGLE_LINE_ONLY_ERR_991"), "CLI must have written single error line into summary");
    assert.ok(cpRootC.lastTest?.failureExcerpt?.includes("P105_SINGLE_LINE_ONLY_ERR_991"), "CLI must have written single error line into failureExcerpt");
    checkStore.close();

    process.env.AGY_DART_DB_PATH = tmpDb;
    closeRuntimeStore();
    const token = "v173-p1-iso-token-1122334455667788";
    const srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        brainRoots: [brainRoot],
        findTranscriptFn: () => null,
        notifyFn: () => {},
        focusWindowFn: () => ({ dispatched: false, platform: process.platform }),
        nowFn: () => virtualNow,
        monoNsFn: () => 1_000_000_000_000n
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const authHeaders = { "X-Agy-Dart-Token": token };

    const sidecarRoutes = [];
    registerSidecarRoutes({
      config: { conversationId: convA },
      api(routePath, handler, method) {
        sidecarRoutes.push({ routePath, handler, method });
      }
    });
    const sidecarHandoff = sidecarRoutes.find((r) => r.routePath === "/api/handoff").handler;
    const sidecarResume = sidecarRoutes.find((r) => r.routePath === "/api/resume").handler;

    const assertHasNone = (raw, markers, label) => {
      for (const m of markers) {
        assert.ok(!raw.includes(m), `${label} leaked forbidden marker ${m}`);
      }
    };

    try {
      // === P1-01: Watchdog getStatus projection, nested /api/watchdog/action status & aggregate full/agent handoff ===
      const wdA = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convA, conversationConfirmed: true }
      });
      assert.equal(wdA.status, 200);
      assert.equal(wdA.json.current?.conversationId, convA);
      assert.equal(wdA.json.current?.lastUserInput, "P1_LEASE_INPUT_ALPHA", "Confirmed A current must keep A lastUserInput");
      assert.ok(wdA.json.current?.rescueBrief?.markdown?.includes("P1_QUOTE_ALPHA"), "Confirmed A current must keep A rescueBrief");
      assert.ok(wdA.json.current?.incidentKey, "Stalled current must include non-empty incidentKey");
      assertHasNone(wdA.raw, ["P1_LEASE_INPUT_BETA", "P1_QUOTE_BETA", "P1_TASK_BETA", "P1_BETA_FAIL_EXCERPT"], "Confirmed A /api/watchdog");
      assertHasNone(JSON.stringify(wdA.json.sessions), ["P1_LEASE_INPUT_ALPHA", "P1_LEASE_INPUT_BETA"], "sessions[] must never expose lastUserInput");
      assertHasNone(JSON.stringify(wdA.json.alertingSessions), ["P1_LEASE_INPUT_ALPHA", "P1_LEASE_INPUT_BETA"], "alertingSessions[] must never expose lastUserInput");
      assert.ok(wdA.json.sessions.every((s) => s.rescueBrief === null && s.lastUserInput === ""));
      assert.ok(wdA.json.alertingSessions.length >= 2, "Alerting overview must still list stalled windows");

      // Nested status in /api/watchdog/action for A must also have zero B quotes/rescueBrief
      const actA = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setDesktopNotify", enabled: false, scope: "conversation", conversationId: convA, conversationConfirmed: true }
      });
      assert.equal(actA.status, 200);
      assert.equal(actA.json.status?.current?.lastUserInput, "P1_LEASE_INPUT_ALPHA");
      assertHasNone(actA.raw, ["P1_LEASE_INPUT_BETA", "P1_QUOTE_BETA", "P1_TASK_BETA"], "Confirmed A /api/watchdog/action");

      // Switching to B MUST still retrieve B's internal cached rescueBrief & lastUserInput
      const wdB = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convB, conversationConfirmed: true }
      });
      assert.equal(wdB.status, 200);
      assert.equal(wdB.json.current?.lastUserInput, "P1_LEASE_INPUT_BETA");
      assert.ok(wdB.json.current?.rescueBrief?.markdown?.includes("P1_QUOTE_BETA"), "Switching to B must still retrieve B cached rescueBrief");
      assertHasNone(wdB.raw, ["P1_LEASE_INPUT_ALPHA", "P1_QUOTE_ALPHA", "P1_TASK_ALPHA"], "Confirmed B /api/watchdog");

      // Aggregate (app/lifetime), inferred (conversationConfirmed=false), and unbound views across /api/watchdog, /api/watchdog/action, /api/handoff (full + agent)
      const allLeaseQuotes = ["P1_LEASE_INPUT_ALPHA", "P1_LEASE_INPUT_BETA", "P1_LEASE_CHILD_C", "P1_QUOTE_ALPHA", "P1_QUOTE_BETA"];
      for (const aggScope of ["app", "lifetime"]) {
        const wdAgg = await httpJsonRequest(port, "/api/watchdog", {
          method: "POST",
          headers: authHeaders,
          body: { scope: aggScope, conversationId: convA }
        });
        assert.equal(wdAgg.status, 200);
        assertHasNone(wdAgg.raw, allLeaseQuotes, `Aggregate(${aggScope}) /api/watchdog`);
        assert.ok(wdAgg.json.current?.model && wdAgg.json.current?.contextTokens > 0, "Aggregate watchdog must keep model/tokens");

        const actAgg = await httpJsonRequest(port, "/api/watchdog/action", {
          method: "POST",
          headers: authHeaders,
          body: { action: "setDesktopNotify", enabled: false, scope: aggScope, conversationId: convA }
        });
        assert.equal(actAgg.status, 200);
        assertHasNone(actAgg.raw, allLeaseQuotes, `Aggregate(${aggScope}) /api/watchdog/action`);

        for (const mode of ["full", "agent"]) {
          const hoAgg = await httpJsonRequest(port, "/api/handoff", {
            method: "POST",
            headers: authHeaders,
            body: { scope: aggScope, conversationId: convA, mode, conversationConfirmed: true }
          });
          assert.equal(hoAgg.status, 200);
          assertHasNone(hoAgg.raw, [...allLeaseQuotes, "P105_SINGLE_LINE_ONLY_ERR_991"], `Aggregate(${aggScope}) /api/handoff mode=${mode}`);
          assert.ok(hoAgg.json.markdown.includes("150k tok") || hoAgg.json.markdown.includes("115k tok"), `Aggregate mode=${mode} must keep tokens`);
          assert.ok(hoAgg.json.markdown.includes("claude-opus-4-6") || hoAgg.json.markdown.includes("gemini-4-pro"), `Aggregate mode=${mode} must keep model`);
        }
      }

      for (const [label, extraBody] of [
        ["inferred", { scope: "conversation", conversationId: convA, conversationConfirmed: false }],
        ["unbound", { scope: "conversation", conversationId: "", fromSidecarHost: true }]
      ]) {
        const wdU = await httpJsonRequest(port, "/api/watchdog", { method: "POST", headers: authHeaders, body: extraBody });
        assertHasNone(wdU.raw, allLeaseQuotes, `${label} /api/watchdog`);
        const actU = await httpJsonRequest(port, "/api/watchdog/action", { method: "POST", headers: authHeaders, body: { action: "tick", ...extraBody } });
        assertHasNone(actU.raw, allLeaseQuotes, `${label} /api/watchdog/action`);
        for (const mode of ["full", "agent"]) {
          const hoU = await httpJsonRequest(port, "/api/handoff", { method: "POST", headers: authHeaders, body: { ...extraBody, mode } });
          assertHasNone(hoU.raw, [...allLeaseQuotes, "P105_SINGLE_LINE_ONLY_ERR_991"], `${label} /api/handoff mode=${mode}`);
        }
      }

      // === P1-02: Trusted checkpoint ownership (HTTP + SidecarApp) ===
      // Confirmed A with UNRELATED explicit sessionId=convB must NOT leak B's checkpoint, files, anchors, or resumeCommand
      const spoofHttpHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convA, sessionId: convB, mode: "agent", conversationConfirmed: true }
      });
      assert.equal(spoofHttpHo.status, 200);
      assert.equal(spoofHttpHo.json.sessionId, convA, "HTTP /api/handoff must ignore unrelated explicit sessionId");
      assert.ok(spoofHttpHo.raw.includes("alpha-only.js"), "HTTP /api/handoff must read A's own modified file");
      assertHasNone(spoofHttpHo.raw, ["beta-secret.js", "P1_BETA_FAIL_EXCERPT", "P1_BETA_FAIL_SUMMARY", convB], "HTTP spoofed /api/handoff");

      const spoofSdkHo = sidecarHandoff({
        scope: "conversation",
        conversationId: convA,
        sessionId: convB,
        mode: "agent",
        conversationConfirmed: true
      });
      assert.equal(spoofSdkHo.ok, true);
      assert.equal(spoofSdkHo.sessionId, convA, "SidecarApp /api/handoff must ignore unrelated explicit sessionId");
      assertHasNone(JSON.stringify(spoofSdkHo), ["beta-secret.js", "P1_BETA_FAIL_EXCERPT", "P1_BETA_FAIL_SUMMARY", convB], "SidecarApp spoofed /api/handoff");

      const spoofHttpRes = await httpJsonRequest(port, "/api/resume", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: convA, sessionId: convB, conversationConfirmed: true }
      });
      assertHasNone(spoofHttpRes.raw, ["beta-secret.js", "P1_BETA_FAIL_EXCERPT", "P1_BETA_FAIL_SUMMARY"], "HTTP spoofed /api/resume");

      const spoofSdkRes = sidecarResume({
        scope: "conversation",
        conversationId: convA,
        sessionId: convB,
        conversationConfirmed: true
      });
      assertHasNone(JSON.stringify(spoofSdkRes), ["beta-secret.js", "P1_BETA_FAIL_EXCERPT", "P1_BETA_FAIL_SUMMARY"], "SidecarApp spoofed /api/resume");

      // === P2-03 & P1-02: Legitimate childC -> rootC on BOTH /api/resume AND /api/handoff (HTTP + SidecarApp) ===
      const childHttpHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: childC, mode: "agent", conversationConfirmed: true }
      });
      assert.equal(childHttpHo.status, 200);
      assert.equal(childHttpHo.json.sessionId, rootC);
      assert.ok(childHttpHo.raw.includes("P105_SINGLE_LINE_ONLY_ERR_991"), "Confirmed childC /api/handoff must read rootC verification");
      assert.ok(childHttpHo.raw.includes("root-c-file.js"));

      const childHttpRes = await httpJsonRequest(port, "/api/resume", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: childC, conversationConfirmed: true }
      });
      assert.equal(childHttpRes.status, 200);
      assert.equal(childHttpRes.json.sessionId, rootC, "Confirmed childC /api/resume must resolve to rootC");
      assert.ok(childHttpRes.json.sessionCheckpoint?.lastTest?.failureExcerpt?.includes("P105_SINGLE_LINE_ONLY_ERR_991"));
      assert.ok(childHttpRes.json.sessionCheckpoint?.lastTest?.summary?.includes("P105_SINGLE_LINE_ONLY_ERR_991"));

      const childSdkHo = sidecarHandoff({ scope: "conversation", conversationId: childC, sessionId: rootC, mode: "agent", conversationConfirmed: true });
      const childSdkRes = sidecarResume({ scope: "conversation", conversationId: childC, conversationConfirmed: true });
      assert.equal(childSdkHo.sessionId, rootC);
      assert.equal(childSdkRes.sessionId, rootC);
      assert.equal(
        childSdkRes.sessionCheckpoint?.lastTest?.at,
        childHttpRes.json.sessionCheckpoint?.lastTest?.at,
        "SidecarApp /api/resume and HTTP /api/resume must read identical rootC verification record"
      );

      // === P1-05: Single-line CLI failure stripped across aggregate/inferred/unbound /api/resume AND overview /api/handoff ===
      for (const [label, body] of [
        ["aggregate-app", { scope: "app", conversationId: childC }],
        ["aggregate-lifetime", { scope: "lifetime", conversationId: childC }],
        ["inferred", { scope: "conversation", conversationId: rootC, conversationConfirmed: false }],
        ["unbound", { scope: "conversation", conversationId: "", fromSidecarHost: true }]
      ]) {
        const res = await httpJsonRequest(port, "/api/resume", { method: "POST", headers: authHeaders, body });
        assert.equal(res.status, 200);
        assertHasNone(res.raw, ["P105_SINGLE_LINE_ONLY_ERR_991"], `${label} /api/resume must not leak single-line error in summary or failureExcerpt`);
        if (label !== "unbound") {
          assert.equal(res.json.sessionCheckpoint?.lastTest?.ok, false, `${label} /api/resume must preserve verification failed status`);
          assert.equal(res.json.sessionCheckpoint?.lastTest?.exitCode, 1, `${label} /api/resume must preserve exitCode`);
          assert.equal(res.json.sessionCheckpoint?.lastTest?.summary, "failed (exit 1)", `${label} /api/resume must use structured summary`);
          assert.equal("failureExcerpt" in (res.json.sessionCheckpoint?.lastTest || {}), false);
        }
      }

      // Overview /api/handoff (full & agent) on aggregate must also omit P105_SINGLE_LINE_ONLY_ERR_991 while keeping FAIL (exit 1)
      for (const mode of ["agent", "full"]) {
        const ovHo = await httpJsonRequest(port, "/api/handoff", {
          method: "POST",
          headers: authHeaders,
          body: { scope: "lifetime", conversationId: rootC, mode }
        });
        assert.equal(ovHo.status, 200);
        assertHasNone(ovHo.raw, ["P105_SINGLE_LINE_ONLY_ERR_991"], `Overview /api/handoff (${mode}) must not leak single-line error`);
        assert.ok(ovHo.json.markdown.includes("FAIL (exit 1)"), `Overview /api/handoff (${mode}) must still render FAIL (exit 1)`);
      }

      // === Adversarial P1-02 / P2-03: Multi-hop grandchild->child->root & cyclic leases + scoped /api/watchdog/action status ===
      const grandChildC = "conv-p1-grandchild-c";
      const cycX = "conv-p1-cycle-x";
      const cycY = "conv-p1-cycle-y";
      const leaseStore = new ContextModeStore({ dbPath: tmpDb });
      recordHookLeaseTransition(
        leaseStore,
        "PreInvocation",
        { conversationId: grandChildC, parentConversationId: childC, cwd: wsC },
        { nowMs: virtualNow - 5_000 }
      );
      recordHookLeaseTransition(
        leaseStore,
        "PreInvocation",
        { conversationId: cycX, parentConversationId: cycY, cwd: wsC },
        { nowMs: virtualNow - 5_000 }
      );
      recordHookLeaseTransition(
        leaseStore,
        "PreInvocation",
        { conversationId: cycY, parentConversationId: cycX, cwd: wsC },
        { nowMs: virtualNow - 5_000 }
      );
      leaseStore.close();

      // Multi-hop grandchild -> child -> root resolves cleanly across HTTP & SidecarApp, while still rejecting unrelated convB
      const grandHttpHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: grandChildC, sessionId: convB, mode: "agent", conversationConfirmed: true }
      });
      assert.equal(grandHttpHo.status, 200);
      assert.equal(grandHttpHo.json.sessionId, rootC, "Grandchild lease chain must resolve to rootC and reject spoofed convB");
      assert.ok(grandHttpHo.raw.includes("P105_SINGLE_LINE_ONLY_ERR_991"));
      assertHasNone(grandHttpHo.raw, ["beta-secret.js", "P1_BETA_FAIL_EXCERPT"], "Grandchild spoofed /api/handoff");

      const grandSdkRes = sidecarResume({ scope: "conversation", conversationId: grandChildC, conversationConfirmed: true });
      assert.equal(grandSdkRes.sessionId, rootC, "SidecarApp /api/resume must walk multi-hop grandchild -> rootC");

      // Cyclic leases must terminate safely without infinite recursion and reject unrelated sessionId
      const cycRes = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: cycX, sessionId: convB, mode: "agent", conversationConfirmed: true }
      });
      assert.equal(cycRes.status, 200);
      assert.ok(cycRes.json.sessionId === cycX || cycRes.json.sessionId === cycY, "Cyclic lease must terminate safely without reading convB");
      assertHasNone(cycRes.raw, ["beta-secret.js", "P1_BETA_FAIL_EXCERPT"], "Cyclic lease must never leak convB");

      // /api/watchdog/action must preserve `scope` on nested `status` for app/lifetime scopes
      const appAct = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "setDesktopNotify", enabled: false, scope: "app", conversationId: convA }
      });
      assert.equal(appAct.status, 200);
      assert.equal(appAct.json.status?.scope, "app", "/api/watchdog/action nested status must preserve requested scope");
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      closeRuntimeStore();
    }
  } finally {
    try { store.close(); } catch {}
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-7: P1-03/P1-04/P2-01/P2-02/P2-09 Dashboard VM DOM host sync, watchdog alignment, single inferred confirmation & incident race guards", async () => {
  const convA = "conv-ui-alpha";
  const convB = "conv-ui-beta";
  const convC = "conv-ui-gamma";
  const convSolo = "conv-ui-solo";

  // === P1-03: Native host switches A -> B before any poll/refresh -> copy buttons refuse A, load B, reject late A ===
  {
    const copied = [];
    const deferredByConv = new Map();
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          const cid = body.conversationId;
          return new Promise((resolve) => {
            const list = deferredByConv.get(cid) || [];
            list.push((overridePayload) =>
              resolve({
                ok: true,
                status: 200,
                json: async () =>
                  overridePayload || {
                    ok: true,
                    scope: body.scope || "conversation",
                    mode: "agent",
                    confirmedConversation: true,
                    conversationId: cid,
                    markdown: `# Brief for ${cid}\nMARKER_${cid}`,
                    summary: cid,
                    bytes: 32,
                    truncated: false,
                    anchors: {
                      confirmed: true,
                      conversationId: cid,
                      sessionId: cid,
                      branch: `branch-${cid}`,
                      nextTasks: [`[/] TASK_${cid}`],
                      failingChecks: [],
                      artifacts: [],
                      recentSources: [],
                      resumeSameWindow: "ctx_resume({})",
                      resumeCrossWindow: `ctx_resume({ sessionId: "${cid}" })`
                    }
                  }
              })
            );
            deferredByConv.set(cid, list);
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch,
      copiedOut: copied
    });

    // Open drawer for A and let first A load complete
    vm.runInContext("toggleHandoffDrawer(true);", ctx);
    assert.equal((deferredByConv.get(convA) || []).length, 1);
    deferredByConv.get(convA).shift()();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`MARKER_${convA}`));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);

    // Kick off a slow refresh for A so a late A response is still in flight when host switches
    vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.equal((deferredByConv.get(convA) || []).length, 1);
    const resolveLateA = deferredByConv.get(convA).shift();
    // Also restore an already-loaded snapshot state via a quick fresh A before switching:
    // Actually test the exact P1-03 scenario: A is loaded & copyable, host switches directly to B without poll/refresh!
    resolveLateA();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`MARKER_${convA}`));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);

    // Start one extra slow background refresh for A, then IMMEDIATELY complete A isn't needed;
    // Direct host switch A -> B with NO poll or manual refresh!
    nativeHost.conversationId = convB;
    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 0, "P1-03: Clicking copy buttons after host switch A->B must NEVER write A to clipboard");
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, "Copy button must be disabled while B loads");
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, "Prompt button must be disabled while B loads");
    assert.ok((deferredByConv.get(convB) || []).length >= 1, "Host switch detected on copy must trigger B load");

    // Resolve B
    deferredByConv.get(convB).shift()();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`MARKER_${convB}`));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);

    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 2);
    assert.ok(copied[0].includes(`MARKER_${convB}`) && !copied[0].includes(`MARKER_${convA}`));
    assert.ok(copied[1].includes(`TASK_${convB}`) && !copied[1].includes(`TASK_${convA}`));

    // Also prove an ACTUAL in-flight A response arriving AFTER B finishes cannot overwrite B preview!
    nativeHost.conversationId = convA;
    vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.equal((deferredByConv.get(convA) || []).length, 1);
    const resolveActualLateA = deferredByConv.get(convA).shift();
    nativeHost.conversationId = convB;
    vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.equal((deferredByConv.get(convB) || []).length, 1);
    deferredByConv.get(convB).shift()();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`MARKER_${convB}`));
    // Now late A arrives AFTER B
    resolveActualLateA();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`MARKER_${convB}`), "Late A response must NEVER overwrite B preview");
    assert.ok(!elements.get("kv-handoff-preview").textContent.includes(`MARKER_${convA}`));
  }

  // === P1-04: Watchdog action target alignment (A -> B before B status arrives -> cancelled; after B arrives -> acts on B) ===
  {
    const actionCalls = [];
    const deferredActions = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/watchdog/action") {
          actionCalls.push(body);
          return new Promise((resolve) => {
            deferredActions.push((statusPayload) =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({
                  ok: true,
                  conversationId: body.conversationId,
                  status: statusPayload
                })
              })
            );
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch
    });
    const wdStalledA = {
      ok: true,
      enabled: true,
      scope: "conversation",
      current: {
        conversationId: convA,
        phase: "TOOL_RUNNING",
        severity: "stalled",
        rawSeverity: "stalled",
        silentSec: 320,
        suspectSec: 180,
        stalledSec: 300,
        incidentKey: `${convA}:100:TOOL_RUNNING:stalled:cmd`,
        lastUserInput: "P104_SECRET_A",
        rescueBrief: { conversationId: convA, confirmedConversation: true, markdown: "# Rescue A P104_SECRET_A", incidentKey: `${convA}:100:TOOL_RUNNING:stalled:cmd`, anchors: { confirmed: true } }
      },
      sessions: [],
      alertingSessions: []
    };
    const wdStalledB = {
      ok: true,
      enabled: true,
      scope: "conversation",
      current: {
        conversationId: convB,
        phase: "LLM_INFLIGHT",
        severity: "stalled",
        rawSeverity: "stalled",
        silentSec: 260,
        suspectSec: 144,
        stalledSec: 240,
        incidentKey: `${convB}:200:LLM_INFLIGHT:stalled:llm`,
        lastUserInput: "P104_SECRET_B",
        rescueBrief: { conversationId: convB, confirmedConversation: true, markdown: "# Rescue B P104_SECRET_B", incidentKey: `${convB}:200:LLM_INFLIGHT:stalled:llm`, anchors: { confirmed: true } }
      },
      sessions: [],
      alertingSessions: []
    };

    vm.runInContext("cachedWatchdog = wdA; renderWatchdogCard(wdA);", Object.assign(ctx, { wdA: wdStalledA }));
    assert.equal(elements.get("wd-snooze-btn").disabled, false);
    assert.equal(elements.get("wd-clear-btn").disabled, false);

    // Switch host A -> B BEFORE B's watchdog status arrives!
    nativeHost.conversationId = convB;
    actionCalls.length = 0;
    await vm.runInContext("snoozeWatchdogAlert();", ctx);
    await vm.runInContext("markWatchdogIdle();", ctx);
    assert.equal(actionCalls.length, 0, "P1-04: Unaligned old card actions must be cancelled without mutating A or B");
    assert.equal(elements.get("wd-snooze-btn").disabled, true, "Snooze button must be disabled while watchdog is unaligned");
    assert.equal(elements.get("wd-clear-btn").disabled, true, "Clear button must be disabled while watchdog is unaligned");

    // B's watchdog status arrives -> buttons re-enabled -> snooze & clear act on B!
    vm.runInContext("cachedWatchdog = wdB; renderWatchdogCard(wdB);", Object.assign(ctx, { wdB: wdStalledB }));
    assert.equal(elements.get("wd-snooze-btn").disabled, false);
    assert.equal(elements.get("wd-clear-btn").disabled, false);

    const snoozeP = vm.runInContext("snoozeWatchdogAlert();", ctx);
    assert.equal(actionCalls.length, 1);
    assert.equal(actionCalls[0].action, "ack");
    assert.equal(actionCalls[0].conversationId, convB);
    assert.equal(actionCalls[0].conversationConfirmed, true);
    deferredActions.shift()({ ...wdStalledB, current: { ...wdStalledB.current, severity: "snoozed" } });
    await snoozeP;
    assert.equal(vm.runInContext("cachedWatchdog.current.conversationId", ctx), convB);
    assert.ok(!JSON.stringify(vm.runInContext("cachedWatchdog", ctx)).includes("P104_SECRET_A"));

    const clearP = vm.runInContext("markWatchdogIdle();", ctx);
    assert.equal(actionCalls.length, 2);
    assert.equal(actionCalls[1].action, "clear");
    assert.equal(actionCalls[1].conversationId, convB);
    // Switch B -> C while B's clear response is in-flight -> late B response must not overwrite C!
    nativeHost.conversationId = convC;
    deferredActions.shift()({ ...wdStalledB, current: { ...wdStalledB.current, phase: "IDLE", severity: "idle" } });
    await clearP;
    assert.equal(elements.get("wd-snooze-btn").disabled, true, "After switching B->C, old B response must not re-enable C buttons");
  }

  // === P2-01: Single inferred session in standalone dashboard has clickable confirmation entry ===
  {
    const copied = [];
    const hoCalls = [];
    const { ctx, elements } = createDashboardVmSandbox({
      copiedOut: copied,
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          hoCalls.push(body);
          const conf = body.conversationConfirmed === true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              scope: "conversation",
              mode: "agent",
              confirmedConversation: conf,
              conversationId: body.conversationId || "",
              markdown: conf ? "# Confirmed Solo\n> [transcript:head] SOLO_USER_QUOTE" : "# Overview Only",
              summary: conf ? "solo" : "overview",
              bytes: 40,
              truncated: false,
              anchors: conf
                ? {
                    confirmed: true,
                    conversationId: convSolo,
                    sessionId: convSolo,
                    nextTasks: ["[/] SOLO_TASK_1"],
                    failingChecks: [],
                    artifacts: [],
                    recentSources: [],
                    resumeSameWindow: "ctx_resume({})",
                    resumeCrossWindow: `ctx_resume({ sessionId: "${convSolo}" })`
                  }
                : { confirmed: false, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
            })
          };
        }
        if (url === "/api/watchdog") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              enabled: true,
              current: { conversationId: convSolo, phase: "IDLE", severity: "idle" },
              sessions: [{ conversationId: convSolo, workspaceLabel: "solo-ws", convTitle: "Solo Chat", phase: "IDLE", severity: "idle", isSubagent: false }],
              alertingSessions: []
            })
          };
        }
        if (url === "/api/watchdog/action" && body.action === "focusConversation") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              conversationId: convSolo,
              status: {
                ok: true,
                enabled: true,
                current: { conversationId: convSolo, phase: "IDLE", severity: "idle" },
                sessions: [{ conversationId: convSolo, workspaceLabel: "solo-ws", convTitle: "Solo Chat", phase: "IDLE", severity: "idle", isSubagent: false }],
                alertingSessions: []
              }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });

    vm.runInContext(
      `inferredFallbackConvId = ${JSON.stringify(convSolo)};
       const wdSolo = {
         ok: true,
         enabled: true,
         current: { conversationId: ${JSON.stringify(convSolo)}, phase: 'IDLE', severity: 'idle' },
         sessions: [{ conversationId: ${JSON.stringify(convSolo)}, workspaceLabel: 'solo-ws', convTitle: 'Solo Chat', phase: 'IDLE', severity: 'idle', isSubagent: false }],
         alertingSessions: []
       };
       cachedWatchdog = wdSolo;
       renderWatchdogCard(wdSolo);
       toggleHandoffDrawer(true);`,
      ctx
    );
    await new Promise((r) => setTimeout(r, 20));
    const switcher = elements.get("wd-session-switcher");
    assert.equal(switcher.classList.contains("hidden"), false, "P2-01: Switcher must be visible for single inferred session");
    assert.ok(switcher.innerHTML.includes(`data-jump-conv="${convSolo}"`), "Switcher must render clickable button for solo session");
    assert.ok(!switcher.innerHTML.includes('aria-current="true"'), "Unconfirmed inferred session must NOT have aria-current=true before click");
    assert.equal(hoCalls[0].conversationConfirmed, false, "Before click, drawer must request overview only");
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, "Before click, semantic prompt button must be disabled");

    // Click the solo confirmation entry -> confirms session, loads quote/task, enables semantic prompt copy!
    await vm.runInContext(`jumpToConversation(${JSON.stringify(convSolo)});`, ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(switcher.innerHTML.includes('aria-current="true"'), "After click, confirmed solo session must be marked aria-current=true");
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("SOLO_USER_QUOTE"));
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes("SOLO_TASK_1"));
  }

  // === P2-02: Healthy->Stalled auto-switch + suspect->stalled / ended / replaced incident late API fallback guards ===
  {
    const copied = [];
    const deferredHandoffs = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          return new Promise((resolve) => {
            deferredHandoffs.push({
              body,
              resolve: (payload) => resolve({ ok: true, status: 200, json: async () => payload })
            });
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch,
      copiedOut: copied
    });

    // 1. Healthy window opens drawer
    const wdHealthy = {
      ok: true,
      enabled: true,
      scope: "conversation",
      current: { conversationId: convA, phase: "IDLE", severity: "idle" },
      sessions: [],
      alertingSessions: []
    };
    vm.runInContext("cachedWatchdog = wdH; renderWatchdogCard(wdH); toggleHandoffDrawer(true);", Object.assign(ctx, { wdH: wdHealthy }));
    assert.equal(deferredHandoffs.length, 1);
    deferredHandoffs.shift().resolve({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      incidentKey: "",
      markdown: "# Healthy Brief A",
      bytes: 17,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA, nextTasks: ["[/] HEALTHY_TASK"], failingChecks: [], artifacts: [], recentSources: [], resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# Healthy Brief A"));

    // 2. Same window becomes SUSPECT (no rescueBrief yet), user clicks Copy Rescue Brief -> triggers fallback /api/handoff
    const wdSuspect = {
      ok: true,
      enabled: true,
      scope: "conversation",
      current: {
        conversationId: convA,
        phase: "LLM_INFLIGHT",
        phaseChangedTs: 1000,
        severity: "suspect",
        rawSeverity: "suspect",
        silentSec: 150,
        suspectSec: 144,
        stalledSec: 240,
        incidentKey: `${convA}:1000:LLM_INFLIGHT:suspect:llm_hang`,
        diagnosis: { causeId: "llm_hang", label: "LLM silent", labelZh: "LLM 无响应", tips: [], tipsZh: [] },
        rescueBrief: null
      },
      sessions: [],
      alertingSessions: []
    };
    vm.runInContext("cachedWatchdog = wdS; renderWatchdogCard(wdS);", Object.assign(ctx, { wdS: wdSuspect }));
    const suspectCopyPromise = vm.runInContext("copyWatchdogRescueBrief();", ctx);
    assert.equal(deferredHandoffs.length, 1, "Suspect rescue copy should issue fallback /api/handoff");
    const resolveLateSuspectWithKey = deferredHandoffs.shift().resolve;

    // 3. While suspect fallback is in-flight, same window escalates SUSPECT -> STALLED with prebuilt rescueBrief!
    const stalledKey1 = `${convA}:1000:LLM_INFLIGHT:stalled:llm_hang`;
    const wdStalled1 = {
      ok: true,
      enabled: true,
      scope: "conversation",
      current: {
        conversationId: convA,
        phase: "LLM_INFLIGHT",
        phaseChangedTs: 1000,
        severity: "stalled",
        rawSeverity: "stalled",
        silentSec: 260,
        suspectSec: 144,
        stalledSec: 240,
        incidentKey: stalledKey1,
        diagnosis: { causeId: "llm_hang", label: "LLM stalled", labelZh: "LLM 卡死", tips: [], tipsZh: [] },
        rescueBrief: {
          mode: "agent",
          confirmedConversation: true,
          conversationId: convA,
          incidentKey: stalledKey1,
          markdown: "# STALLED RESCUE INCIDENT_1",
          summary: "stall=stalled",
          bytes: 27,
          truncated: false,
          anchors: {
            confirmed: true,
            conversationId: convA,
            stallSummary: "STALLED: INCIDENT_1",
            nextTasks: ["[/] RESCUE_TASK_1"],
            failingChecks: [],
            artifacts: [],
            recentSources: [],
            resumeSameWindow: "ctx_resume({})",
            resumeCrossWindow: ""
          }
        }
      },
      sessions: [],
      alertingSessions: []
    };
    vm.runInContext("cachedWatchdog = wdSt1; renderWatchdogCard(wdSt1);", Object.assign(ctx, { wdSt1: wdStalled1 }));
    // Drawer was open since healthy -> MUST auto-switch preview & BOTH copy buttons to STALLED INCIDENT_1!
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# STALLED RESCUE INCIDENT_1"), "P2-02: Open healthy drawer must auto-switch to stalled rescue snapshot");

    // Late suspect API fallback arrives -> MUST NOT overwrite stalled preview or write to clipboard!
    resolveLateSuspectWithKey({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      incidentKey: `${convA}:1000:LLM_INFLIGHT:suspect:llm_hang`,
      markdown: "# STALE_SUSPECT_FALLBACK",
      bytes: 24,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA }
    });
    await suspectCopyPromise;
    assert.equal(copied.length, 0, "P2-02: Late suspect fallback must NOT write to clipboard after escalation to stalled");
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# STALLED RESCUE INCIDENT_1"));

    // Both drawer copy buttons must copy INCIDENT_1
    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 2);
    assert.ok(copied[0].includes("# STALLED RESCUE INCIDENT_1"));
    assert.ok(copied[1].includes("STALLED: INCIDENT_1"));

    // 4. Test fallback snapshot WITHOUT incidentKey when incident ends or changes
    const wdSuspectNoKey = {
      ok: true,
      enabled: true,
      scope: "conversation",
      current: {
        conversationId: convA,
        phase: "TOOL_RUNNING",
        phaseChangedTs: 5000,
        severity: "suspect",
        silentSec: 190,
        suspectSec: 180,
        stalledSec: 300,
        diagnosis: { causeId: "cmd_wait" },
        rescueBrief: null
      },
      sessions: [],
      alertingSessions: []
    };
    vm.runInContext("cachedWatchdog = wdSNK; renderWatchdogCard(wdSNK);", Object.assign(ctx, { wdSNK: wdSuspectNoKey }));
    const noKeyCopyP = vm.runInContext("copyWatchdogRescueBrief();", ctx);
    assert.equal(deferredHandoffs.length, 1);
    const resolveLateNoKey = deferredHandoffs.shift().resolve;

    // Incident ends (IDLE) before fallback without incidentKey arrives -> P2-02 auto-reloads healthy brief while open
    vm.runInContext("cachedWatchdog = wdH; renderWatchdogCard(wdH);", Object.assign(ctx, { wdH: wdHealthy }));
    assert.equal(deferredHandoffs.length, 1, "P2-02: Recovering to healthy while drawer is open must auto-reload healthy brief");
    const resolveRecoveryHealthy = deferredHandoffs.shift().resolve;
    resolveLateNoKey({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      // Deliberately omit incidentKey!
      markdown: "# STALE_NO_KEY_FALLBACK",
      bytes: 23,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA }
    });
    await noKeyCopyP;
    assert.equal(copied.length, 2, "P2-02: Late fallback without incidentKey must NOT write to clipboard after incident ended");
    assert.ok(!elements.get("kv-handoff-preview").textContent.includes("STALE_NO_KEY_FALLBACK"));
    resolveRecoveryHealthy({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      incidentKey: "",
      markdown: "# RECOVERED_HEALTHY_BRIEF",
      bytes: 25,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# RECOVERED_HEALTHY_BRIEF"));

    // 5. Incident replaced (inc-A -> inc-B) while old fallback without incidentKey is in-flight
    vm.runInContext("cachedWatchdog = wdSNK; renderWatchdogCard(wdSNK);", Object.assign(ctx, { wdSNK: wdSuspectNoKey }));
    const replacedCopyP = vm.runInContext("copyWatchdogRescueBrief();", ctx);
    assert.equal(deferredHandoffs.length, 1);
    const resolveOldReplaced = deferredHandoffs.shift().resolve;
    const wdReplacedStalled = {
      ...wdStalled1,
      current: {
        ...wdStalled1.current,
        phaseChangedTs: 9000,
        incidentKey: `${convA}:9000:TOOL_RUNNING:stalled:cmd_hang`,
        rescueBrief: {
          ...wdStalled1.current.rescueBrief,
          incidentKey: `${convA}:9000:TOOL_RUNNING:stalled:cmd_hang`,
          markdown: "# STALLED RESCUE INCIDENT_2"
        }
      }
    };
    vm.runInContext("cachedWatchdog = wdRep; renderWatchdogCard(wdRep);", Object.assign(ctx, { wdRep: wdReplacedStalled }));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# STALLED RESCUE INCIDENT_2"));
    resolveOldReplaced({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      markdown: "# STALE_REPLACED_INCIDENT_FALLBACK",
      bytes: 34,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA }
    });
    await replacedCopyP;
    assert.equal(copied.length, 2, "P2-02: Late fallback from replaced incident must NOT write to clipboard");
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# STALLED RESCUE INCIDENT_2"));
    assert.ok(!elements.get("kv-handoff-preview").textContent.includes("STALE_REPLACED_INCIDENT_FALLBACK"));

    // 6. Ended incident must immediately invalidate cached rescue snapshot in isHandoffSnapshotCurrent()
    vm.runInContext("cachedWatchdog = { ...wdH };", Object.assign(ctx, { wdH: wdHealthy }));
    assert.equal(
      vm.runInContext("isHandoffSnapshotCurrent(cachedHandoffSnapshot);", ctx),
      false,
      "P2-02: Cached rescue snapshot must be invalidated as soon as current incident ends (empty incidentKey)"
    );

    // 7. In-flight loadHandoffBrief() during healthy -> suspect transition must NOT deadlock in loading state!
    vm.runInContext("cachedWatchdog = wdH; renderWatchdogCard(wdH);", Object.assign(ctx, { wdH: wdHealthy }));
    deferredHandoffs.length = 0;
    const inflightHealthyP = vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.equal(deferredHandoffs.length, 1);
    const resolveStaleHealthyLoad = deferredHandoffs.shift().resolve;
    // Incident transitions healthy -> suspect (no prebuilt rescueBrief yet) while healthy load is in-flight
    vm.runInContext("cachedWatchdog = wdS; renderWatchdogCard(wdS);", Object.assign(ctx, { wdS: wdSuspect }));
    assert.equal(deferredHandoffs.length, 1, "P2-02: Transitioning healthy->suspect during in-flight load must trigger a fresh reload instead of deadlocking");
    const resolveFreshSuspectLoad = deferredHandoffs.shift().resolve;
    // Late healthy response arrives first -> rejected
    resolveStaleHealthyLoad({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      incidentKey: "",
      markdown: "# STALE_HEALTHY_DURING_SUSPECT",
      bytes: 30,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA }
    });
    await inflightHealthyP;
    assert.ok(!elements.get("kv-handoff-preview").textContent.includes("STALE_HEALTHY_DURING_SUSPECT"));
    // Fresh suspect response arrives -> completes loading cleanly and re-enables copy buttons!
    resolveFreshSuspectLoad({
      ok: true,
      scope: "conversation",
      mode: "agent",
      confirmedConversation: true,
      conversationId: convA,
      incidentKey: wdSuspect.current.incidentKey,
      markdown: "# FRESH_SUSPECT_BRIEF",
      bytes: 21,
      truncated: false,
      anchors: { confirmed: true, conversationId: convA, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(vm.runInContext("handoffLoading", ctx), false, "Drawer must exit loading state after fresh suspect brief arrives");
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# FRESH_SUSPECT_BRIEF"));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
  }

  // === Adversarial P1-03/P1-04: refreshData() in-flight for A when native host switches A->B + app scope watchdog action keeps buttons aligned ===
  {
    const deferredStats = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/stats") {
          return new Promise((resolve) => {
            deferredStats.push(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true, totalRawBytes: 100, totalReturnedBytes: 20 }) }));
          });
        }
        if (url === "/api/watchdog") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              enabled: true,
              scope: body.scope || "conversation",
              current: {
                conversationId: body.conversationId || convA,
                phase: "TOOL_RUNNING",
                severity: "stalled",
                rawSeverity: "stalled",
                silentSec: 320,
                suspectSec: 180,
                stalledSec: 300,
                lastUserInput: `SECRET_${body.conversationId || convA}`
              },
              sessions: [],
              alertingSessions: []
            })
          });
        }
        if (url === "/api/watchdog/action") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              desktopNotifyEnabled: false,
              status: {
                ok: true,
                enabled: true,
                // Even if server status omitted scope, client preserves reqScope!
                current: {
                  conversationId: convA,
                  phase: "TOOL_RUNNING",
                  severity: "stalled",
                  rawSeverity: "stalled",
                  silentSec: 320,
                  suspectSec: 180,
                  stalledSec: 300
                },
                sessions: [],
                alertingSessions: []
              }
            })
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch
    });
    deferredStats.length = 0;
    const refreshP = vm.runInContext("refreshData(true);", ctx);
    assert.equal(deferredStats.length, 1);
    // Native host switches A -> B BEFORE refreshData() responses resolve!
    nativeHost.conversationId = convB;
    deferredStats.shift()();
    await refreshP;
    assert.equal(
      vm.runInContext("cachedWatchdog", ctx),
      null,
      "Stale refreshData() response for A must NEVER populate cachedWatchdog after native host switched to B"
    );

    // Switching to app scope and running a watchdog action must keep watchdog buttons aligned (not falsely disabled)
    deferredStats.length = 0;
    vm.runInContext("setScope('app');", ctx);
    assert.equal(deferredStats.length, 1);
    deferredStats.shift()();
    await new Promise((r) => setTimeout(r, 20));
    await vm.runInContext("sendWatchdogAction({ action: 'setDesktopNotify', enabled: false });", ctx);
    assert.equal(vm.runInContext("cachedWatchdog?.scope", ctx), "app", "Watchdog action in app scope must preserve scope");
    assert.equal(elements.get("wd-snooze-btn").disabled, false, "Watchdog action in app scope must keep aligned buttons enabled");
  }
});

test("v1.7.3-8: P2-04/P2-05/P2-06/P2-07/P2-08/P3-01 persistence evidence, strict head/tail byte windows, case-sensitive dedup, >2 MiB CLI tail, TAP & transcript priority", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-p23-"));
  const brainRoot = path.join(tmpDir, "brain");
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // === P2-04: Cross-window resumeCommand requires real persisted checkpoint evidence ===
    {
      const emptyStore = new ContextModeStore({ dbPath: tmpDb });
      const cid = "conv-p204-empty";
      // (a) Empty checkpoint (no row saved -> updatedAt: null)
      const emptyBrief = buildHandoffBrief({
        store: emptyStore,
        mode: "agent",
        scope: "conversation",
        conversationId: cid,
        conversationConfirmed: true,
        sessionId: cid,
        cwd: tmpDir
      });
      assert.equal(emptyBrief.resumeCommand, "ctx_resume({})", "Empty checkpoint must NOT emit cross-window resumeCommand");
      assert.equal(emptyBrief.anchors.resumeCrossWindow, "");
      assert.equal(emptyBrief.anchors.sessionId, "");
      assert.ok(!emptyBrief.markdown.includes("ctx_resume({ sessionId:"), "Empty checkpoint markdown must not suggest cross-window resume");

      // (b) No store (store: null)
      const noStoreBrief = buildHandoffBrief({
        store: null,
        mode: "agent",
        scope: "conversation",
        conversationId: cid,
        conversationConfirmed: true,
        sessionId: cid,
        cwd: tmpDir
      });
      assert.equal(noStoreBrief.resumeCommand, "ctx_resume({})");
      assert.equal(noStoreBrief.anchors.resumeCrossWindow, "");
      assert.ok(!noStoreBrief.markdown.includes("ctx_resume({ sessionId:"));

      // (c) Failing store read (throws on getSessionCheckpoint & getResumeState)
      const throwingStore = {
        getSessionCheckpoint() {
          throw new Error("SQLITE_BUSY");
        },
        getResumeState() {
          throw new Error("SQLITE_BUSY");
        }
      };
      const failReadBrief = buildHandoffBrief({
        store: throwingStore,
        mode: "agent",
        scope: "conversation",
        conversationId: cid,
        conversationConfirmed: true,
        sessionId: cid,
        cwd: tmpDir
      });
      assert.equal(failReadBrief.resumeCommand, "ctx_resume({})");
      assert.equal(failReadBrief.anchors.resumeCrossWindow, "");
      assert.ok(!failReadBrief.markdown.includes("ctx_resume({ sessionId:"));

      // Semantic prompt for empty checkpoint must only offer same-window resume
      const { ctx } = createDashboardVmSandbox();
      const promptEmpty = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(emptyBrief)}, "en");`, ctx);
      assert.ok(promptEmpty.includes("ctx_resume({})"));
      assert.ok(!promptEmpty.includes("ctx_resume({ sessionId:"));

      // (d) After actually persisting a checkpoint -> cross-window resumeCommand IS emitted
      emptyStore.recordModifiedFiles(cid, [path.join(tmpDir, "saved.js")], { worktree: tmpDir, tool: "apply_edits" });
      const savedBrief = buildHandoffBrief({
        store: emptyStore,
        mode: "agent",
        scope: "conversation",
        conversationId: cid,
        conversationConfirmed: true,
        sessionId: cid,
        cwd: tmpDir
      });
      assert.equal(savedBrief.resumeCommand, `ctx_resume({ sessionId: "${cid}" })`);
      assert.equal(savedBrief.anchors.resumeCrossWindow, `ctx_resume({ sessionId: "${cid}" })`);
      assert.ok(savedBrief.markdown.includes(`ctx_resume({ sessionId: "${cid}" })`));
      emptyStore.close();
    }

    // === P2-05: readTranscriptHeadTailFixed strict <=64 KiB head / <=128 KiB tail + exact record-start tail boundary ===
    {
      // Case 1: ~90 KiB file with first USER_INPUT placed AFTER 64 KiB
      const conv90k = "conv-p205-90k";
      const log90k = path.join(brainRoot, conv90k, ".system_generated", "logs");
      fs.mkdirSync(log90k, { recursive: true });
      const tx90k = path.join(log90k, "transcript.jsonl");
      const padLine = JSON.stringify({ type: "TOOL_RESULT", step_index: 1, content: "P".repeat(2000) });
      const lines90k = [];
      // 35 lines * ~2060 B ≈ 72 KiB (> 64 KiB) of non-user records before first user message
      for (let i = 0; i < 35; i++) lines90k.push(padLine);
      lines90k.push(
        JSON.stringify({
          type: "USER_INPUT",
          step_index: 40,
          created_at: "2026-11-24T11:00:00.000Z",
          user_input: "<USER_REQUEST>AFTER_64K_USER_MSG</USER_REQUEST>"
        })
      );
      for (let i = 0; i < 8; i++) lines90k.push(padLine);
      fs.writeFileSync(tx90k, lines90k.join("\n") + "\n", "utf8");
      const sz90k = fs.statSync(tx90k).size;
      assert.ok(sz90k > 75 * 1024 && sz90k < 120 * 1024, `Expected ~90 KiB file, got ${sz90k}`);

      const r90k = readTranscriptHeadTailFixed(tx90k);
      assert.equal(r90k.overlapped, true, "90 KiB file must use single-read overlapping fast path");
      assert.ok(r90k.headBytesRead <= 65536);
      assert.equal(
        r90k.headSteps.some((s) => JSON.stringify(s).includes("AFTER_64K_USER_MSG")),
        false,
        "P2-05: Message placed after 64 KiB must NOT appear in headSteps"
      );
      assert.equal(
        r90k.tailSteps.some((s) => JSON.stringify(s).includes("AFTER_64K_USER_MSG")),
        true,
        "P2-05: Message placed after 64 KiB MUST appear in tailSteps"
      );
      const b90k = buildHandoffBrief({
        mode: "agent",
        scope: "conversation",
        conversationId: conv90k,
        conversationConfirmed: true,
        brainRoots: [brainRoot]
      });
      assert.ok(!b90k.markdown.includes("[transcript:head]"), "90 KiB brief must NOT attribute post-64KiB message to [transcript:head]");
      assert.ok(b90k.markdown.includes("[transcript:tail]") && b90k.markdown.includes("AFTER_64K_USER_MSG"));

      // Case 2: Exact record-start boundary at tailOffset (both overlapping ~150 KiB and large >210 KiB)
      for (const [tag, prefixBytesTarget, expectOverlapped] of [
        ["overlap-150k", 24 * 1024, true],
        ["large-220k", 90 * 1024, false]
      ]) {
        const convExact = `conv-p205-${tag}`;
        const logExact = path.join(brainRoot, convExact, ".system_generated", "logs");
        fs.mkdirSync(logExact, { recursive: true });
        const txExact = path.join(logExact, "transcript.jsonl");
        const boundaryMsgLine =
          JSON.stringify({
            type: "USER_INPUT",
            step_index: 200,
            created_at: "2026-11-24T11:10:00.000Z",
            user_input: `<USER_REQUEST>EXACT_TAIL_BOUNDARY_${tag}</USER_REQUEST>`
          }) + "\n";
        const tailTarget = 131072; // 128 KiB
        const remForTail = tailTarget - Buffer.byteLength(boundaryMsgLine, "utf8");
        const tailPadShell = JSON.stringify({ type: "TOOL_RESULT", step_index: 201, content: "" }) + "\n";
        const tailPadContentLen = remForTail - Buffer.byteLength(tailPadShell, "utf8");
        assert.ok(tailPadContentLen > 0);
        const tailPadLine =
          JSON.stringify({ type: "TOOL_RESULT", step_index: 201, content: "T".repeat(tailPadContentLen) }) + "\n";
        assert.equal(Buffer.byteLength(boundaryMsgLine + tailPadLine, "utf8"), tailTarget, "Tail section must be exactly 128 KiB");

        const headUserLine =
          JSON.stringify({
            type: "USER_INPUT",
            step_index: 1,
            created_at: "2026-11-24T11:00:00.000Z",
            user_input: `<USER_REQUEST>INITIAL_HEAD_MSG_${tag}</USER_REQUEST>`
          }) + "\n";
        const headPadLine =
          JSON.stringify({ type: "TOOL_RESULT", step_index: 2, content: "H".repeat(prefixBytesTarget) }) + "\n";
        fs.writeFileSync(txExact, headUserLine + headPadLine + boundaryMsgLine + tailPadLine, "utf8");

        const rExact = readTranscriptHeadTailFixed(txExact);
        assert.equal(rExact.overlapped, expectOverlapped);
        assert.ok(
          rExact.tailSteps.length > 0 && JSON.stringify(rExact.tailSteps[0]).includes(`EXACT_TAIL_BOUNDARY_${tag}`),
          `P2-05 (${tag}): Complete record starting at exact tailOffset must be tailSteps[0] and NOT dropped`
        );
        const bExact = buildHandoffBrief({
          mode: "agent",
          scope: "conversation",
          conversationId: convExact,
          conversationConfirmed: true,
          brainRoots: [brainRoot]
        });
        assert.ok(bExact.markdown.includes(`[transcript:head]`) && bExact.markdown.includes(`INITIAL_HEAD_MSG_${tag}`));
        assert.ok(bExact.markdown.includes(`[transcript:tail]`) && bExact.markdown.includes(`EXACT_TAIL_BOUNDARY_${tag}`));
      }
    }

    // === P2-06: Case-sensitive user message dedup (Keep UserID vs Keep userId + overlap single display) ===
    {
      const convCase = "conv-p206-case";
      const logCase = path.join(brainRoot, convCase, ".system_generated", "logs");
      fs.mkdirSync(logCase, { recursive: true });
      const txCase = path.join(logCase, "transcript.jsonl");
      fs.writeFileSync(
        txCase,
        [
          JSON.stringify({ type: "USER_INPUT", step_index: 1, created_at: "2026-11-24T12:00:00.000Z", user_input: "<USER_REQUEST>Keep UserID</USER_REQUEST>" }),
          JSON.stringify({ type: "USER_INPUT", step_index: 2, created_at: "2026-11-24T12:01:00.000Z", user_input: "<USER_REQUEST>Keep userId</USER_REQUEST>" })
        ].join("\n") + "\n",
        "utf8"
      );
      const bCase = buildHandoffBrief({
        mode: "agent",
        scope: "conversation",
        conversationId: convCase,
        conversationConfirmed: true,
        brainRoots: [brainRoot]
      });
      assert.ok(bCase.markdown.includes("[transcript:head] **Initial Request**: Keep UserID"), "P2-06: Initial Keep UserID must preserve exact case");
      assert.ok(bCase.markdown.includes("[transcript:tail] **Latest User Message**: Keep userId"), "P2-06: Correction Keep userId must NOT be deduped against Keep UserID");

      // Single message in overlap region -> shown ONLY ONCE
      const convOverlapOnce = "conv-p206-once";
      const logOnce = path.join(brainRoot, convOverlapOnce, ".system_generated", "logs");
      fs.mkdirSync(logOnce, { recursive: true });
      fs.writeFileSync(
        path.join(logOnce, "transcript.jsonl"),
        JSON.stringify({ type: "USER_INPUT", step_index: 1, created_at: "2026-11-24T12:00:00.000Z", user_input: "<USER_REQUEST>Keep UserID</USER_REQUEST>" }) + "\n",
        "utf8"
      );
      const bOnce = buildHandoffBrief({
        mode: "agent",
        scope: "conversation",
        conversationId: convOverlapOnce,
        conversationConfirmed: true,
        brainRoots: [brainRoot]
      });
      const occurrences = bOnce.markdown.split("Keep UserID").length - 1;
      assert.equal(occurrences, 1, "P2-06: Same record in head/tail overlap must appear exactly once");
    }

    // === P2-07: Real CLI >2 MiB stdout and >2 MiB stderr bounded tail capture + secret redaction ===
    {
      const cliFilterPath = path.join(ROOT, "hooks", "cli-filter.mjs");
      const secretGh = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
      const secretAnt = "sk-ant-api03-1234567890abcdefghijklmnop";
      for (const [streamName, sid, marker, secret] of [
        ["stdout", "sess-p207-stdout", "OVERFLOW_STDOUT_TAIL_ERR_77", secretGh],
        ["stderr", "sess-p207-stderr", "OVERFLOW_STDERR_TAIL_ERR_88", secretAnt]
      ]) {
        const scriptPath = path.join(tmpDir, `emit-${streamName}.mjs`);
        fs.writeFileSync(
          scriptPath,
          [
            `const chunk = "normal output line 0123456789abcdefghijklmnopqrstuvwxyz\\n".repeat(1000);`,
            `for (let i = 0; i < 45; i++) process.${streamName}.write(chunk);`,
            `process.${streamName}.write("AssertionError: ${marker} token=${secret}\\n");`,
            `process.exit(1);`
          ].join("\n"),
          "utf8"
        );
        const cmd = `node ${JSON.stringify(scriptPath)}`;
        const run = spawnSync(
          process.execPath,
          [
            cliFilterPath,
            "--rule",
            "test-runner",
            "--b64",
            `b:${Buffer.from(cmd, "utf8").toString("base64url")}`,
            "--session",
            `b:${Buffer.from(sid, "utf8").toString("base64url")}`
          ],
          {
            cwd: tmpDir,
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
          }
        );
        assert.equal(run.status, 1, `P2-07 (${streamName}) must preserve exit 1`);
        const st = new ContextModeStore({ dbPath: tmpDb });
        const cp = st.getSessionCheckpoint(sid);
        st.close();
        const ex = cp.lastTest?.failureExcerpt || "";
        assert.ok(ex.includes(marker), `P2-07 (${streamName}) checkpoint excerpt must capture tail error past 2 MiB, got: ${JSON.stringify(ex)}`);
        assert.ok(!ex.includes(secret), `P2-07 (${streamName}) checkpoint excerpt must redact secret`);
        assert.ok(ex.includes("[REDACTED:"), `P2-07 (${streamName}) checkpoint excerpt must include redaction marker`);
        assert.ok(ex.split("\n").length <= 5, `P2-07 (${streamName}) excerpt must be <= 5 lines`);
        assert.ok(Buffer.byteLength(ex, "utf8") <= 500, `P2-07 (${streamName}) excerpt must be <= 500 bytes`);
      }

      // Adversarial P2-07: Error line split RIGHT ACROSS the exact 2 MiB boundary + multi-byte UTF-8 CJK/Emoji at 64 KiB eviction boundary
      const boundaryScript = path.join(tmpDir, "emit-2m-split.mjs");
      fs.writeFileSync(
        boundaryScript,
        [
          `const padBytes = 2 * 1024 * 1024 - 3;`,
          `const line = "ok_line_0123456789abcdef0123456789abcdef0123456789abcdef012345\\n";`,
          `const fullLines = Math.floor(padBytes / line.length);`,
          `const rem = padBytes - fullLines * line.length;`,
          `for (let i = 0; i < fullLines; i++) process.stdout.write(line);`,
          `if (rem > 0) process.stdout.write("a".repeat(rem - 1) + "\\n");`,
          // Now at byte 2*1024*1024 - 3: split "Error: BOUNDARY_2MIB_SPLIT_99" across 2 MiB boundary!
          `process.stdout.write("Err");`,
          `setTimeout(() => {`,
          `  process.stdout.write("or: BOUNDARY_2MIB_SPLIT_99\\n");`,
          `  process.exit(1);`,
          `}, 15);`
        ].join("\n"),
        "utf8"
      );
      const splitRun = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(boundaryScript)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from("sess-p207-split", "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(splitRun.status, 1);
      const stSplit = new ContextModeStore({ dbPath: tmpDb });
      const cpSplit = stSplit.getSessionCheckpoint("sess-p207-split");
      stSplit.close();
      assert.ok(
        (cpSplit.lastTest?.failureExcerpt || "").includes("Error: BOUNDARY_2MIB_SPLIT_99"),
        `P2-07: Error split across exact 2 MiB boundary must be captured cleanly, got: ${JSON.stringify(cpSplit.lastTest?.failureExcerpt)}`
      );

      // Multi-byte UTF-8 (CJK + Emoji) pushed past 2 MiB + 64 KiB eviction boundary without replacement chars
      const utf8Script = path.join(tmpDir, "emit-utf8-tail.mjs");
      fs.writeFileSync(
        utf8Script,
        [
          `const uChunk = ("中🚀" + "normal_utf8_pad_").repeat(500) + "\\n";`,
          `for (let i = 0; i < 260; i++) process.stdout.write(uChunk);`,
          `process.stdout.write("AssertionError: UTF8_TAIL_OK_中文🎯\\n");`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const utf8Run = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(utf8Script)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from("sess-p207-utf8", "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(utf8Run.status, 1);
      const stUtf8 = new ContextModeStore({ dbPath: tmpDb });
      const cpUtf8 = stUtf8.getSessionCheckpoint("sess-p207-utf8");
      stUtf8.close();
      const utf8Ex = cpUtf8.lastTest?.failureExcerpt || "";
      assert.ok(utf8Ex.includes("AssertionError: UTF8_TAIL_OK_中文🎯"), `P2-07 UTF-8 tail must survive 64 KiB eviction, got: ${JSON.stringify(utf8Ex)}`);
      assert.ok(!utf8Ex.includes("\uFFFD"), "P2-07 UTF-8 tail must not contain U+FFFD corruption");
    }

    // === P2-08: TAP passing `error` title skipped + short log `firstErrorLine` picks real error ===
    {
      const tapLog = [
        "TAP version 13",
        "# Subtest: handles error recovery cleanly",
        "ok 1 - handles error recovery cleanly",
        "  ---",
        "  duration_ms: 1.42",
        "  ...",
        "ok - ignores unnumbered error noise",
        "# Subtest: validates manifest version",
        "not ok 2 - validates manifest version",
        "  ---",
        "  duration_ms: 0.91",
        "  type: 'test'",
        "  failureType: 'testCodeFailure'",
        "  error: 'AssertionError: expected version 2'",
        "  code: 'ERR_ASSERTION'",
        "  ..."
      ].join("\n");
      const tapExcerpt = extractFailureExcerpt(tapLog);
      assert.ok(tapExcerpt.includes("not ok 2 - validates manifest version"), `P2-08 TAP excerpt must identify real failing test, got:\n${tapExcerpt}`);
      assert.ok(tapExcerpt.includes("AssertionError: expected version 2"), `P2-08 TAP excerpt must include real assertion, got:\n${tapExcerpt}`);
      assert.ok(!tapExcerpt.includes("handles error recovery cleanly"), `P2-08 TAP excerpt must skip passing Subtest with 'error' in title:\n${tapExcerpt}`);
      assert.ok(!tapExcerpt.includes("ignores unnumbered error noise"), `P2-08 TAP excerpt must skip unnumbered 'ok -' passing line:\n${tapExcerpt}`);

      // Adversarial P2-08: Indented nested TAP subtests + Node spec-reporter passing suite header `▶ handles error ...`
      const specAndNestedLog = [
        "▶ handles error recovery suite",
        "  ✔ handles error recovery cleanly (1.2ms)",
        "✔ handles error recovery suite (2.0ms)",
        "    # Subtest: nested error handler check",
        "    ok 1 - nested error handler check",
        "      ---",
        "      duration_ms: 0.5",
        "      type: 'suite'",
        "      ...",
        "▶ real failing suite",
        "  ✖ rejects bad config (3.1ms)",
        "    AssertionError: expected config v2"
      ].join("\n");
      const specEx = extractFailureExcerpt(specAndNestedLog);
      assert.ok(specEx.includes("rejects bad config") && specEx.includes("AssertionError: expected config v2"), `P2-08 spec/nested excerpt must pick real failure, got:\n${specEx}`);
      assert.ok(!specEx.includes("handles error recovery"), `P2-08 must skip passing ▶ suite header containing 'error', got:\n${specEx}`);

      // Short log: "Loading project configuration" followed by "Error: expected version 2"
      const shortLog = "Loading project configuration\nError: expected version 2\n";
      const shortExcerpt = extractFailureExcerpt(shortLog);
      assert.ok(shortExcerpt.includes("Error: expected version 2"));
      const stShort = new ContextModeStore({ dbPath: tmpDb });
      const sidShort = "conv-p208-short";
      stShort.recordVerificationResult(sidShort, {
        kind: "test",
        command: "node --test config.test.mjs",
        exitCode: 1,
        passed: false,
        summary: "1 failed",
        failureExcerpt: shortExcerpt,
        worktree: tmpDir
      });
      const briefShort = buildHandoffBrief({
        store: stShort,
        mode: "agent",
        scope: "conversation",
        conversationId: sidShort,
        conversationConfirmed: true,
        sessionId: sidShort,
        cwd: tmpDir
      });
      stShort.close();
      assert.equal(
        briefShort.anchors.failingChecks[0]?.firstErrorLine,
        "Error: expected version 2",
        "P2-08: failingChecks.firstErrorLine must select real error line, not preceding context line"
      );
      const { ctx } = createDashboardVmSandbox();
      const shortPrompt = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(briefShort)}, "zh");`, ctx);
      assert.ok(shortPrompt.includes("Error: expected version 2"), "P2-08: Semantic handoff prompt must include real error line");
    }

    // === P3-01: findPreferredTranscriptForConversation checks all transcript.jsonl locations before transcript_full.jsonl ===
    {
      const convP3A = "conv-p301-subdir";
      const dirP3A = path.join(brainRoot, convP3A);
      fs.mkdirSync(path.join(dirP3A, ".system_generated", "logs"), { recursive: true });
      fs.writeFileSync(path.join(dirP3A, ".system_generated", "logs", "transcript_full.jsonl"), "{}\n", "utf8");
      const preferredSub = path.join(dirP3A, ".system_generated", "transcript.jsonl");
      fs.writeFileSync(preferredSub, "{}\n", "utf8");
      const canon = (p) => (typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(p) : fs.realpathSync(p));
      const foundA = findPreferredTranscriptForConversation(convP3A, { extraRoots: [brainRoot] });
      assert.equal(path.basename(foundA), "transcript.jsonl", "P3-01: Must prefer .system_generated/transcript.jsonl over logs/transcript_full.jsonl");
      assert.equal(canon(foundA), canon(preferredSub));

      const convP3B = "conv-p301-root";
      const dirP3B = path.join(brainRoot, convP3B);
      fs.mkdirSync(path.join(dirP3B, ".system_generated", "logs"), { recursive: true });
      fs.writeFileSync(path.join(dirP3B, ".system_generated", "logs", "transcript_full.jsonl"), "{}\n", "utf8");
      const preferredRoot = path.join(dirP3B, "transcript.jsonl");
      fs.writeFileSync(preferredRoot, "{}\n", "utf8");
      const foundB = findPreferredTranscriptForConversation(convP3B, { extraRoots: [brainRoot] });
      assert.equal(canon(foundB), canon(preferredRoot), "P3-01: Must prefer root transcript.jsonl over logs/transcript_full.jsonl");

      // Symlink/junction escape on preferred transcript.jsonl must still be rejected and fall back to owned transcript_full.jsonl
      const convP3Link = "conv-p301-symlink";
      const dirP3Link = path.join(brainRoot, convP3Link);
      fs.mkdirSync(dirP3Link, { recursive: true });
      const ownedRootFull = path.join(dirP3Link, "transcript_full.jsonl");
      fs.writeFileSync(ownedRootFull, "{}\n", "utf8");
      const outsideSysGen = path.join(tmpDir, "outside-sysgen");
      fs.mkdirSync(path.join(outsideSysGen, "logs"), { recursive: true });
      fs.writeFileSync(path.join(outsideSysGen, "logs", "transcript.jsonl"), "{}\n", "utf8");
      // Directory junction works on Windows without Developer Mode / elevation, and 'dir' symlink works on POSIX
      fs.symlinkSync(outsideSysGen, path.join(dirP3Link, ".system_generated"), process.platform === "win32" ? "junction" : "dir");
      const foundLink = findPreferredTranscriptForConversation(convP3Link, { extraRoots: [brainRoot] });
      assert.equal(canon(foundLink), canon(ownedRootFull), "P3-01: Escaping junction .system_generated/logs/transcript.jsonl must be rejected in favor of owned transcript_full.jsonl");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-9: Round-2 P1-02 (4 attribution states across HTTP & SDK + full compat) & P2-03 (real Watchdog 3-hop grandchild->child->root parity)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-r2-p102-"));
  const brainRoot = path.join(tmpDir, "brain");
  const wsA = path.join(tmpDir, "ws-a");
  const wsB = path.join(tmpDir, "ws-b");
  const wsRoot = path.join(tmpDir, "ws-root");
  const tmpDb = path.join(tmpDir, "context.db");
  const convA = "conv-r2-alpha";
  const convB = "conv-r2-beta";
  const rootG = "root-r2-chain";
  const childG = "child-r2-chain";
  const grandG = "grand-r2-chain";

  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.mkdirSync(wsRoot, { recursive: true });
  for (const [cid, quote, task] of [
    [convA, "R2_QUOTE_ALPHA", "R2_TASK_ALPHA"],
    [convB, "R2_QUOTE_BETA", "R2_TASK_BETA"],
    [grandG, "R2_QUOTE_GRANDCHILD", "R2_TASK_GRANDCHILD"]
  ]) {
    const logDir = path.join(brainRoot, cid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      JSON.stringify({
        type: "USER_INPUT",
        step_index: 1,
        created_at: "2026-11-24T10:00:00.000Z",
        user_input: `<USER_REQUEST>${quote}</USER_REQUEST>`
      }) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(brainRoot, cid, "task.md"), `- [/] ${task}\n`, "utf8");
  }
  // Seed a transcript with usage on convB to verify full-mode cacheDiag alignment too
  const txB = path.join(brainRoot, convB, ".system_generated", "logs", "transcript.jsonl");
  fs.appendFileSync(
    txB,
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 2,
      model: "claude-opus-4-6-secret-b",
      usageMetadata: { promptTokenCount: 95000, cachedContentTokenCount: 70000, candidatesTokenCount: 300 }
    }) + "\n",
    "utf8"
  );

  const store = new ContextModeStore({ dbPath: tmpDb });
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const baseNow = Date.now();
  const stalledNow = baseNow + 1_350_000;

  try {
    // Seed A & B checkpoints + stalled leases
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: convA, cwd: wsA, lastUserInput: "R2_LEASE_A" },
      { nowMs: baseNow, model: "gemini-4-pro", contextTokens: 40000 }
    );
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: convB, cwd: wsB, lastUserInput: "R2_LEASE_B", transcriptPath: txB },
      { nowMs: baseNow, model: "claude-opus-4-6", contextTokens: 95000 }
    );
    store.recordModifiedFiles(convA, [path.join(wsA, "alpha.js")], { worktree: wsA, tool: "apply_edits" });
    store.recordModifiedFiles(convB, [path.join(wsB, "beta-private.js")], { worktree: wsB, tool: "apply_edits" });
    store.recordVerificationResult(convB, {
      kind: "test",
      command: "npm test -- beta",
      exitCode: 1,
      passed: false,
      summary: "R2_BETA_SUMMARY_SECRET",
      failureExcerpt: "AssertionError: R2_BETA_EXCERPT_SECRET",
      worktree: wsB
    });
    // Also seed "default" checkpoint so bare GET /api/handoff preserves legacy "default" compatibility
    store.recordModifiedFiles("default", [path.join(wsA, "default-compat.js")], { worktree: wsA, tool: "apply_edits" });

    // P2-03: 3-hop chain grandG -> childG -> rootG; grandG lease deliberately has rootSessionId=childG (1-hop) & empty cwd!
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: rootG, cwd: wsRoot, lastUserInput: "R2_LEASE_ROOT" },
      { nowMs: baseNow - 60_000 }
    );
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      { conversationId: childG, parentConversationId: rootG, rootSessionId: rootG, cwd: wsRoot, lastUserInput: "R2_LEASE_CHILD" },
      { nowMs: baseNow - 30_000 }
    );
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      {
        conversationId: grandG,
        parentConversationId: childG,
        rootSessionId: childG,
        cwd: "",
        lastUserInput: "R2_LEASE_GRANDCHILD"
      },
      { nowMs: baseNow, model: "claude-opus-4-6", contextTokens: 150000 }
    );
    // Verification & worktree saved ONLY on rootG
    store.recordModifiedFiles(rootG, [path.join(wsRoot, "root-target.js")], { worktree: wsRoot, tool: "apply_edits" });
    store.recordVerificationResult(rootG, {
      kind: "test",
      command: "node --test root.test.mjs",
      exitCode: 1,
      passed: false,
      summary: "root test failed",
      failureExcerpt: "AssertionError: R2_ROOT_VERIFICATION_EVIDENCE_77",
      worktree: wsRoot
    });

    // Direct WatchdogMonitor P2-03 verification with in-memory/SQLite store
    assert.equal(resolveTrustedCheckpointSessionId(store, grandG, ""), rootG, "Shared resolver must walk 3 hops grandG->childG->rootG");
    assert.equal(resolveTrustedCheckpointSessionId(store, grandG, convB), rootG, "Shared resolver must reject unrelated convB");

    const monitor = new WatchdogMonitor({
      getStore: () => store,
      brainRoots: [brainRoot],
      findTranscriptFn: () => null,
      notifyFn: () => {},
      nowFn: () => stalledNow,
      monoNsFn: () => 2_000_000_000_000n
    });
    const wdGrand = monitor.getStatus({ conversationId: grandG, scope: "conversation", refresh: true, includeRichRescue: true });
    assert.equal(wdGrand.current?.severity, "stalled");
    const rescue = wdGrand.current?.rescueBrief;
    assert.ok(rescue, "Watchdog must pre-generate rescueBrief for stalled grandchild");
    assert.equal(rescue.conversationId, grandG);
    assert.equal(rescue.sessionId, rootG, "P2-03: Pre-generated rescueBrief.sessionId must resolve all the way to rootG, not childG");
    assert.equal(rescue.resumeCommand, `ctx_resume({ sessionId: "${rootG}" })`, "P2-03: rescueBrief must include cross-window root resumeCommand");
    assert.ok(rescue.markdown.includes("R2_ROOT_VERIFICATION_EVIDENCE_77"), "P2-03: rescueBrief must include root verification evidence");
    assert.ok(rescue.markdown.includes("R2_QUOTE_GRANDCHILD"), "P2-03: rescueBrief must still read user quote from selected grandchild");
    assert.ok(rescue.markdown.includes("R2_TASK_GRANDCHILD"), "P2-03: rescueBrief must still read task.md from selected grandchild");
    assert.ok(rescue.markdown.includes(wsRoot.replace(/\\/g, "/")), "P2-03: rescueBrief must infer workspace from final rootG checkpoint");
    store.close();

    // Now start HTTP + SDK servers on the exact same DB
    process.env.AGY_DART_DB_PATH = tmpDb;
    closeRuntimeStore();
    const token = "v173-r2-p102-token-001122334455";
    const srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        brainRoots: [brainRoot],
        findTranscriptFn: () => null,
        notifyFn: () => {},
        focusWindowFn: () => ({ dispatched: false, platform: process.platform }),
        nowFn: () => stalledNow,
        monoNsFn: () => 2_000_000_000_000n
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const authHeaders = { "X-Agy-Dart-Token": token };

    // Register BOTH a native-bound SDK app (bound to convA) AND an unbound SDK app (no default conversationId)
    const boundRoutes = [];
    registerSidecarRoutes({
      config: { conversationId: convA },
      api(routePath, handler, method) {
        boundRoutes.push({ routePath, handler, method });
      }
    });
    const unboundRoutes = [];
    registerSidecarRoutes({
      config: {},
      api(routePath, handler, method) {
        unboundRoutes.push({ routePath, handler, method });
      }
    });
    const getSdk = (list, p) => list.find((r) => r.routePath === p).handler;
    const assertNone = (str, markers, label) => {
      for (const m of markers) {
        assert.ok(!str.includes(m), `${label} leaked forbidden marker ${m}`);
      }
    };
    const betaSecrets = [
      "R2_QUOTE_BETA",
      "R2_TASK_BETA",
      "R2_LEASE_B",
      "beta-private.js",
      "R2_BETA_SUMMARY_SECRET",
      "R2_BETA_EXCERPT_SECRET",
      "claude-opus-4-6-secret-b",
      wsB.replace(/\\/g, "/")
    ];

    try {
      // === State 1: Checkpoint sessionId ONLY (no conversationId, no native binding) ===
      for (const mode of ["agent", "full"]) {
        const httpHo = await httpJsonRequest(port, "/api/handoff", {
          method: "POST",
          headers: authHeaders,
          body: { sessionId: convB, mode }
        });
        assert.equal(httpHo.status, 200);
        assert.equal(httpHo.json.sessionId, "__unbound__", `HTTP sessionId-only (${mode}) must isolate checkpoint to __unbound__`);
        assertNone(httpHo.raw, betaSecrets, `HTTP sessionId-only /api/handoff (${mode})`);
        if (mode === "agent") {
          assert.equal(httpHo.json.confirmedConversation, false);
        }

        const sdkHo = getSdk(unboundRoutes, "/api/handoff")({ sessionId: convB, mode });
        assert.equal(sdkHo.ok, true);
        assert.equal(sdkHo.sessionId, "__unbound__", `SDK sessionId-only (${mode}) must isolate checkpoint to __unbound__`);
        assertNone(JSON.stringify(sdkHo), betaSecrets, `SDK sessionId-only /api/handoff (${mode})`);
      }
      // Bare GET /api/handoff (no params) still keeps "default" compatibility
      const bareGet = await httpJsonRequest(port, "/api/handoff", { method: "GET", headers: authHeaders });
      assert.equal(bareGet.status, 200);
      assert.equal(bareGet.json.sessionId, "default");
      assert.ok(bareGet.json.markdown.includes("default-compat.js"), "Bare GET /api/handoff must preserve legacy 'default' compat");

      // Reserved/unsafe unconfirmed conversationId + bare unconfirmed agent must not infer workspace, read non-default checkpoints, or echo back reserved/unsafe conversationId
      for (const badConv of ["unknown", "../escape/bad"]) {
        const reservedHo = await httpJsonRequest(port, "/api/handoff", {
          method: "POST",
          headers: authHeaders,
          body: { scope: "conversation", conversationId: badConv, cwd: wsA, mode: "agent" }
        });
        assert.equal(reservedHo.status, 200);
        assert.equal(reservedHo.json.conversationId, "", `HTTP reserved/unsafe conversationId (${badConv}) must return empty conversationId (aligned with /api/watchdog)`);
        assert.equal(reservedHo.json.sessionId, "__unbound__");
        assert.equal(reservedHo.json.confirmedConversation, false);
        assert.ok(!reservedHo.json.markdown.includes("**Workspace**"), `Reserved/unsafe unconfirmed conversationId (${badConv}) must not infer/accept workspace`);

        const sdkReservedHo = getSdk(unboundRoutes, "/api/handoff")({
          scope: "conversation",
          conversationId: badConv,
          cwd: wsA,
          mode: "agent"
        });
        assert.equal(sdkReservedHo.conversationId, "", `SDK reserved/unsafe conversationId (${badConv}) must return empty conversationId`);
        assert.equal(sdkReservedHo.sessionId, "__unbound__");
        assert.equal(sdkReservedHo.confirmedConversation, false);

        const httpReservedWd = await httpJsonRequest(port, "/api/watchdog", {
          method: "POST",
          headers: authHeaders,
          body: { scope: "conversation", conversationId: badConv }
        });
        assert.equal(httpReservedWd.status, 200);
        assert.equal(reservedHo.json.conversationId, httpReservedWd.json.conversationId, `HTTP /api/handoff and /api/watchdog conversationId must align for ${badConv}`);

        // Aggregate scope with reserved/unsafe conversationId must also return "" (never echo unsafe path strings)
        const appBadHo = getSdk(unboundRoutes, "/api/handoff")({
          scope: "app",
          conversationId: badConv,
          mode: "agent"
        });
        const appBadWd = getSdk(unboundRoutes, "/api/watchdog")({
          scope: "app",
          conversationId: badConv
        });
        assert.equal(appBadHo.conversationId, "", `Aggregate /api/handoff must not echo unsafe/reserved conversationId (${badConv})`);
        assert.equal(appBadWd.conversationId, "", `Aggregate /api/watchdog must not echo unsafe/reserved conversationId (${badConv})`);
      }

      const bareAgentHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { mode: "agent" }
      });
      assert.equal(bareAgentHo.status, 200);
      assert.equal(bareAgentHo.json.confirmedConversation, false);
      assert.ok(!bareAgentHo.json.markdown.includes("**Workspace**"), "Bare unconfirmed agent handoff must not infer workspace");

      // sessionId-only on /api/resume, /api/watchdog, /api/watchdog/action must NOT read or mutate convB
      const httpResOnly = await httpJsonRequest(port, "/api/resume", {
        method: "POST",
        headers: authHeaders,
        body: { sessionId: convB }
      });
      assert.equal(httpResOnly.status, 200);
      assertNone(httpResOnly.raw, betaSecrets, "HTTP sessionId-only /api/resume");

      const sdkResOnly = getSdk(unboundRoutes, "/api/resume")({ sessionId: convB });
      assertNone(JSON.stringify(sdkResOnly), betaSecrets, "SDK sessionId-only /api/resume");

      const httpWdOnly = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { sessionId: convB }
      });
      assert.equal(httpWdOnly.status, 200);
      assert.equal(httpWdOnly.json.current, null);
      assertNone(httpWdOnly.raw, betaSecrets, "HTTP sessionId-only /api/watchdog");

      const httpActOnly = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { action: "ack", sessionId: convB }
      });
      assert.equal(httpActOnly.status, 400, "sessionId-only /api/watchdog/action ack must be rejected");

      // === State 2: Native-bound SDK (defaultConvId = convA) with explicit sessionId = convB (no conversationId) ===
      for (const mode of ["agent", "full"]) {
        const sdkBoundHo = getSdk(boundRoutes, "/api/handoff")({ sessionId: convB, mode });
        assert.equal(sdkBoundHo.ok, true);
        assert.equal(sdkBoundHo.conversationId, convA, `Native-bound SDK (${mode}) must stay on convA over spoofed sessionId=convB`);
        assert.equal(sdkBoundHo.sessionId, convA, `Native-bound SDK (${mode}) must reject unrelated sessionId=convB`);
        assert.ok(sdkBoundHo.markdown.includes("alpha.js"), `Native-bound SDK (${mode}) must read convA checkpoint`);
        assertNone(JSON.stringify(sdkBoundHo), betaSecrets, `Native-bound SDK /api/handoff (${mode})`);
      }
      const sdkBoundRes = getSdk(boundRoutes, "/api/resume")({ sessionId: convB });
      assert.equal(sdkBoundRes.sessionId, convA, "Native-bound SDK /api/resume must stay on convA");
      assertNone(JSON.stringify(sdkBoundRes), betaSecrets, "Native-bound SDK /api/resume");

      const sdkBoundWd = getSdk(boundRoutes, "/api/watchdog")({ sessionId: convB });
      assert.equal(sdkBoundWd.current?.conversationId, convA, "Native-bound SDK /api/watchdog must stay on convA");
      assertNone(JSON.stringify(sdkBoundWd), betaSecrets, "Native-bound SDK /api/watchdog");

      // === State 3: Explicitly unbound host tab (even when SDK has defaultConvId = convA AND sessionId = convB) ===
      const sdkUnboundTab = getSdk(boundRoutes, "/api/handoff")({
        fromSidecarHost: true,
        conversationId: "",
        sessionId: convB,
        mode: "agent"
      });
      assert.equal(sdkUnboundTab.confirmedConversation, false);
      assert.equal(sdkUnboundTab.sessionId, "__unbound__");
      assertNone(JSON.stringify(sdkUnboundTab), [...betaSecrets, "R2_QUOTE_ALPHA", "alpha.js"], "Unbound host tab /api/handoff");

      const httpUnboundTab = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { fromSidecarHost: true, conversationId: "", sessionId: convB, mode: "agent" }
      });
      assert.equal(httpUnboundTab.json.confirmedConversation, false);
      assert.equal(httpUnboundTab.json.sessionId, "__unbound__");
      assertNone(httpUnboundTab.raw, [...betaSecrets, "R2_QUOTE_ALPHA", "alpha.js"], "HTTP unbound host tab");

      // === State 4: User explicitly selects conversation (convB) -> overrides native convA cleanly ===
      const sdkSelectB = getSdk(boundRoutes, "/api/handoff")({
        conversationId: convB,
        conversationConfirmed: true,
        mode: "agent"
      });
      assert.equal(sdkSelectB.confirmedConversation, true);
      assert.equal(sdkSelectB.conversationId, convB);
      assert.equal(sdkSelectB.sessionId, convB);
      assert.ok(sdkSelectB.markdown.includes("R2_QUOTE_BETA") && sdkSelectB.markdown.includes("R2_BETA_EXCERPT_SECRET"));

      // === P2-03 parity check across rescueBrief, /api/handoff, /api/resume on the same 3-hop fixture ===
      const httpGrandHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: grandG, mode: "agent", conversationConfirmed: true }
      });
      const httpGrandRes = await httpJsonRequest(port, "/api/resume", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "conversation", conversationId: grandG, conversationConfirmed: true }
      });
      assert.equal(httpGrandHo.json.sessionId, rootG);
      assert.equal(httpGrandRes.json.sessionId, rootG);
      assert.equal(rescue.sessionId, httpGrandHo.json.sessionId);
      assert.equal(rescue.sessionId, httpGrandRes.json.sessionId);
      assert.equal(rescue.resumeCommand, httpGrandHo.json.resumeCommand);
      assert.ok(httpGrandHo.json.markdown.includes("R2_ROOT_VERIFICATION_EVIDENCE_77"));
      assert.ok(httpGrandHo.json.markdown.includes("R2_QUOTE_GRANDCHILD"));
      assert.ok(httpGrandRes.json.sessionCheckpoint?.lastTest?.failureExcerpt?.includes("R2_ROOT_VERIFICATION_EVIDENCE_77"));
      // Legitimate explicit sessionId=rootG on native-bound grandG SDK still works
      const grandSdkRoutes = [];
      registerSidecarRoutes({
        config: { conversationId: grandG },
        api(routePath, handler, method) {
          grandSdkRoutes.push({ routePath, handler, method });
        }
      });
      const sdkGrandHo = getSdk(grandSdkRoutes, "/api/handoff")({ sessionId: rootG, mode: "agent" });
      assert.equal(sdkGrandHo.sessionId, rootG);
      assert.ok(sdkGrandHo.markdown.includes("R2_ROOT_VERIFICATION_EVIDENCE_77"));
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      closeRuntimeStore();
    }
  } finally {
    try { store.close(); } catch {}
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-10: Round-2 P1-03 (stalled A->healthy B both arrival orders), P1-04 (app/lifetime epoch guard), P2-02 (loaded & loading full cycles), P2-01 (disabled & empty-lease confirmation)", async () => {
  const convA = "conv-r2-ui-alpha";
  const convB = "conv-r2-ui-beta";
  const makeStalledWd = (cid, scope = "conversation", phaseTs = 1000) => ({
    ok: true,
    enabled: true,
    scope,
    current: {
      conversationId: cid,
      phase: "TOOL_RUNNING",
      phaseChangedTs: phaseTs,
      severity: "stalled",
      rawSeverity: "stalled",
      silentSec: 330,
      suspectSec: 180,
      stalledSec: 300,
      incidentKey: `${cid}:${phaseTs}:TOOL_RUNNING:stalled:cmd_hang`,
      diagnosis: { causeId: "cmd_hang", label: "Tool stalled", labelZh: "工具卡死", tips: [], tipsZh: [] },
      rescueBrief: {
        mode: "agent",
        confirmedConversation: true,
        conversationId: cid,
        incidentKey: `${cid}:${phaseTs}:TOOL_RUNNING:stalled:cmd_hang`,
        markdown: `# RESCUE_${cid}_${phaseTs}`,
        summary: `stall=${cid}`,
        bytes: 28,
        truncated: false,
        anchors: {
          confirmed: true,
          conversationId: cid,
          stallSummary: `STALLED_${cid}_${phaseTs}`,
          nextTasks: [`[/] RESCUE_TASK_${cid}`],
          failingChecks: [],
          artifacts: [],
          recentSources: [],
          resumeSameWindow: "ctx_resume({})",
          resumeCrossWindow: ""
        }
      }
    },
    sessions: [],
    alertingSessions: []
  });
  const makeHealthyWd = (cid, scope = "conversation") => ({
    ok: true,
    enabled: true,
    scope,
    current: { conversationId: cid, phase: "IDLE", severity: "idle" },
    sessions: [],
    alertingSessions: []
  });
  const makeSuspectWd = (cid, phaseTs = 2000) => ({
    ok: true,
    enabled: true,
    scope: "conversation",
    current: {
      conversationId: cid,
      phase: "LLM_INFLIGHT",
      phaseChangedTs: phaseTs,
      severity: "suspect",
      rawSeverity: "suspect",
      silentSec: 160,
      suspectSec: 144,
      stalledSec: 240,
      incidentKey: `${cid}:${phaseTs}:LLM_INFLIGHT:suspect:llm_hang`,
      diagnosis: { causeId: "llm_hang", label: "LLM silent", labelZh: "LLM 无响应", tips: [], tipsZh: [] },
      rescueBrief: null
    },
    sessions: [],
    alertingSessions: []
  });
  const makeBriefPayload = (cid, tag, incidentKey = "") => ({
    ok: true,
    scope: "conversation",
    mode: "agent",
    confirmedConversation: true,
    conversationId: cid,
    incidentKey,
    markdown: `# BRIEF_${tag}`,
    summary: tag,
    bytes: 16,
    truncated: false,
    anchors: {
      confirmed: true,
      conversationId: cid,
      nextTasks: [`[/] TASK_${tag}`],
      failingChecks: [],
      artifacts: [],
      recentSources: [],
      resumeSameWindow: "ctx_resume({})",
      resumeCrossWindow: ""
    }
  });

  // === P1-03: Stalled A (drawer open) -> Healthy B under BOTH arrival orders + continuous late-A blocking ===
  for (const order of ["wd_first", "brief_first"]) {
    const copied = [];
    const deferredHandoffs = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          return new Promise((resolve) => {
            deferredHandoffs.push({
              body,
              resolve: (payload) => resolve({ ok: true, status: 200, json: async () => payload })
            });
          });
        }
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch,
      copiedOut: copied
    });

    // Stalled A with open drawer showing A's rescue brief
    vm.runInContext("renderWatchdogCard(wdA); toggleHandoffDrawer(true);", Object.assign(ctx, { wdA: makeStalledWd(convA) }));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`# RESCUE_${convA}`));
    // Also put a slow A refresh in flight so late A arrives after B finishes
    vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.equal(deferredHandoffs.length, 1);
    const lateA = deferredHandoffs.shift();

    // Native host switches A -> healthy B
    nativeHost.conversationId = convB;
    vm.runInContext("syncNativeHostConversation({ reloadIfOpen: true });", ctx);
    assert.equal(deferredHandoffs.length, 1, `(${order}) Host switch must issue B brief load`);
    assert.equal(deferredHandoffs[0].body.conversationId, convB);
    const reqB = deferredHandoffs.shift();

    if (order === "wd_first") {
      // B's healthy Watchdog returns FIRST, then B's brief returns
      vm.runInContext("renderWatchdogCard(wdB);", Object.assign(ctx, { wdB: makeHealthyWd(convB) }));
      reqB.resolve(makeBriefPayload(convB, "HEALTHY_B_ORDER1", ""));
      await new Promise((r) => setTimeout(r, 20));
    } else {
      // B's brief returns FIRST, then B's healthy Watchdog returns
      reqB.resolve(makeBriefPayload(convB, "HEALTHY_B_ORDER2", ""));
      await new Promise((r) => setTimeout(r, 20));
      vm.runInContext("renderWatchdogCard(wdB);", Object.assign(ctx, { wdB: makeHealthyWd(convB) }));
    }

    assert.equal(vm.runInContext("handoffLoading", ctx), false, `(${order}) Drawer must NOT deadlock in loading state`);
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("HEALTHY_B_"), `(${order}) Drawer must display B brief`);
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false, `(${order}) Copy Brief button must be enabled`);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false, `(${order}) Copy Prompt button must be enabled`);

    // Late A arrives AFTER B is displayed -> MUST remain blocked
    lateA.resolve(makeBriefPayload(convA, "LATE_A_STALE", makeStalledWd(convA).current.incidentKey));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("HEALTHY_B_"), `(${order}) Late A must NOT overwrite B`);

    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 2);
    assert.ok(copied[0].includes("HEALTHY_B_") && !copied[0].includes(convA));
    assert.ok(copied[1].includes("TASK_HEALTHY_B_") && !copied[1].includes(convA));
  }

  // === P1-03 active-request mismatch recovery: discarded active reqSeq must NEVER leave handoffLoading deadlocked ===
  {
    const deferredHandoffs = [];
    const nativeHost = {
      conversationId: convB,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          return new Promise((resolve) => {
            deferredHandoffs.push({
              body,
              resolve: (payload) => resolve({ ok: true, status: 200, json: async () => payload })
            });
          });
        }
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch
    });
    vm.runInContext("renderWatchdogCard(wdB); toggleHandoffDrawer(true);", Object.assign(ctx, { wdB: makeHealthyWd(convB) }));
    assert.equal(deferredHandoffs.length, 1);
    // Server returns a mismatched incidentKey while active request is still current -> triggers at most 1 retry
    deferredHandoffs.shift().resolve(makeBriefPayload(convB, "MISMATCHED_1", `${convB}:999:LLM:suspect:drift`));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deferredHandoffs.length, 1, "P1-03: Active-request mismatch must trigger 1 explicit retry");
    // Retry STILL mismatched -> MUST exit loading cleanly instead of infinite loop or deadlock
    deferredHandoffs.shift().resolve(makeBriefPayload(convB, "MISMATCHED_2", `${convB}:999:LLM:suspect:drift`));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deferredHandoffs.length, 0, "P1-03: Retry depth cap must prevent infinite retry loop");
    assert.equal(vm.runInContext("handoffLoading", ctx), false, "P1-03: Drawer must recover from mismatch without hanging in handoffLoading=true");
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, "Mismatched brief must not enable copy");
  }

  // === P1-03 / P2-02 Server-ahead-of-client incident transitions (both directions) before 5s Watchdog poll ===
  {
    // (a) Healthy -> Suspect on server ahead of 5s Watchdog poll: refreshes Watchdog, never resets drawer to placeholder, displays suspect brief
    const wdSusServer = makeSuspectWd(convA, 4100);
    let serverWdState = makeHealthyWd(convA);
    let serverHandoffTag = "INIT_HEALTHY";
    let serverHandoffKey = "";
    let wdFetches = 0;
    let hoFetches = 0;
    const copied = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: async (url) => {
        if (url === "/api/stats") return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (url === "/api/doctor") return { ok: true, status: 200, json: async () => ({ status: "HEALTHY" }) };
        if (url === "/api/cache-diag") return { ok: true, status: 200, json: async () => ({ ok: true, transcriptFound: false }) };
        if (url === "/api/resume") return { ok: true, status: 200, json: async () => ({ recentSources: [], recentEvents: [] }) };
        if (url === "/api/watchdog") {
          wdFetches += 1;
          return { ok: true, status: 200, json: async () => ({ ...serverWdState }) };
        }
        if (url === "/api/handoff") {
          hoFetches += 1;
          return { ok: true, status: 200, json: async () => makeBriefPayload(convA, serverHandoffTag, serverHandoffKey) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch,
      copiedOut: copied
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(vm.runInContext("getCurrentWatchdogIncidentKey()", ctx), "");

    // Server transitions to SUSPECT ahead of client's 5s Watchdog poll
    serverWdState = wdSusServer;
    serverHandoffTag = "SERVER_AHEAD_SUSPECT";
    serverHandoffKey = wdSusServer.current.incidentKey;
    wdFetches = 0;
    hoFetches = 0;
    vm.runInContext("handoffDrawerOpen = true;", ctx);
    const susRet = await vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.ok(wdFetches >= 1, "Server-ahead Healthy->Suspect must refresh Watchdog state immediately");
    assert.equal(hoFetches, 1, "Server-ahead Healthy->Suspect must reuse already-fetched aligned brief without redundant 2nd /api/handoff");
    assert.ok(susRet && susRet.markdown.includes("# BRIEF_SERVER_AHEAD_SUSPECT"), "await loadHandoffBrief() must resolve directly to the applied suspect snapshot");
    assert.equal(vm.runInContext("getCurrentWatchdogIncidentKey()", ctx), wdSusServer.current.incidentKey, "Client Watchdog must catch up to suspect incidentKey");
    assert.equal(vm.runInContext("handoffLoading", ctx), false);
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# BRIEF_SERVER_AHEAD_SUSPECT"), "Drawer must show aligned suspect brief without placeholder stall");
    assert.equal(vm.runInContext("cachedHandoffSnapshot?.incidentKey", ctx), wdSusServer.current.incidentKey);
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    await vm.runInContext("copyHandoffBrief();", ctx);
    assert.ok(copied.pop().includes("BRIEF_SERVER_AHEAD_SUSPECT"));

    // (b) Suspect -> Stalled (with prebuilt rescueBrief) on server ahead of 5s Watchdog poll: refreshes Watchdog & applies rescue with 1 /api/handoff call
    const wdStalledServer = makeStalledWd(convA, "conversation", 4200);
    serverWdState = wdStalledServer;
    serverHandoffTag = "SERVER_AHEAD_STALLED_API";
    serverHandoffKey = wdStalledServer.current.incidentKey;
    wdFetches = 0;
    hoFetches = 0;
    const stalledRet = await vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.ok(wdFetches >= 1, "Server-ahead Suspect->Stalled must refresh Watchdog state");
    assert.equal(hoFetches, 1, "Server-ahead transition to stalled rescue must apply rescueBrief without redundant /api/handoff retry");
    assert.ok(stalledRet && stalledRet.markdown.includes(`# RESCUE_${convA}_4200`), "await loadHandoffBrief() must resolve directly to the applied rescue snapshot");
    assert.equal(vm.runInContext("getCurrentWatchdogIncidentKey()", ctx), wdStalledServer.current.incidentKey);
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`# RESCUE_${convA}_4200`));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);

    // (c) Reverse direction: Stalled (client has stale rescueBrief & non-empty curIncident) -> Recovered Healthy (server returns dataIncident === "")
    serverWdState = makeHealthyWd(convA);
    serverHandoffTag = "SERVER_AHEAD_RECOVERED";
    serverHandoffKey = "";
    wdFetches = 0;
    hoFetches = 0;
    const recRet = await vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
    assert.ok(wdFetches >= 1, "Reverse server-ahead Stalled->Healthy must refresh Watchdog state");
    assert.equal(hoFetches, 1, "Reverse server-ahead Stalled->Healthy must reuse aligned recovered brief without redundant 2nd /api/handoff");
    assert.ok(recRet && recRet.markdown.includes("# BRIEF_SERVER_AHEAD_RECOVERED"), "await loadHandoffBrief() must resolve directly to the recovered healthy snapshot");
    assert.equal(vm.runInContext("getCurrentWatchdogIncidentKey()", ctx), "", "Client Watchdog must clear stale stalled incidentKey");
    assert.equal(vm.runInContext("handoffLoading", ctx), false);
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# BRIEF_SERVER_AHEAD_RECOVERED"), "Drawer must show recovered healthy brief, NOT stale rescueBrief");
    assert.equal(vm.runInContext("cachedHandoffSnapshot?.incidentKey", ctx), "", "Recovered healthy brief must NEVER be stamped with stale curIncident");
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    await vm.runInContext("copyHandoffBrief();", ctx);
    assert.ok(copied.pop().includes("BRIEF_SERVER_AHEAD_RECOVERED"));
  }

  // === Concurrency: in-flight stale refreshData(false) racing loadHandoffBrief() + drawer closed mid-await on 503 + copyWatchdogRescueBrief() reverse recovery & stale target switch ===
  {
    // (1) In-flight auto-refresh (started before transition, returning stale healthy) racing server-ahead suspect brief -> 1 /api/handoff, Watchdog catches up, snapshot returned
    const wdSusRace = makeSuspectWd(convA, 5100);
    let wdCallNum = 0;
    let hoRaceCount = 0;
    let resolveSlowStats = null;
    const raceHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url) => {
        if (url === "/api/stats") {
          if (wdCallNum === 1 && !resolveSlowStats) {
            return new Promise((resolve) => {
              resolveSlowStats = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
            });
          }
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        }
        if (url === "/api/doctor") return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "HEALTHY" }) });
        if (url === "/api/cache-diag") return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, transcriptFound: false }) });
        if (url === "/api/resume") return Promise.resolve({ ok: true, status: 200, json: async () => ({ recentSources: [], recentEvents: [] }) });
        if (url === "/api/watchdog") {
          wdCallNum += 1;
          const payload = wdCallNum <= 2 ? makeHealthyWd(convA) : wdSusRace;
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...payload }) });
        }
        if (url === "/api/handoff") {
          hoRaceCount += 1;
          return Promise.resolve({ ok: true, status: 200, json: async () => makeBriefPayload(convA, "RACE_SUSPECT", wdSusRace.current.incidentKey) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    };
    const { ctx: raceCtx } = createDashboardVmSandbox({ sidecarObj: raceHost, fetchImpl: raceHost.fetch });
    await new Promise((r) => setTimeout(r, 20));
    vm.runInContext("refreshData(false);", raceCtx);
    await new Promise((r) => setTimeout(r, 10));
    vm.runInContext("handoffDrawerOpen = true;", raceCtx);
    const loadP = vm.runInContext("loadHandoffBrief({ forceRefresh: true });", raceCtx);
    await new Promise((r) => setTimeout(r, 10));
    resolveSlowStats();
    const raceSnap = await loadP;
    assert.equal(wdCallNum, 3, "Race with stale in-flight auto-refresh must issue follow-up Watchdog refresh");
    assert.equal(hoRaceCount, 1, "Race reconciliation must apply already-fetched brief with only 1 /api/handoff call");
    assert.ok(raceSnap && raceSnap.markdown.includes("# BRIEF_RACE_SUSPECT"));
    assert.equal(vm.runInContext("getCurrentWatchdogIncidentKey()", raceCtx), wdSusRace.current.incidentKey);
    assert.equal(vm.runInContext("handoffLoading", raceCtx), false);

    // (2) Closing drawer mid-await refreshData(false) while /api/stats returns 503 -> clean reset, 0 extra retries
    let resolveFailStats = null;
    let hoCloseCount = 0;
    const wdSusClose = makeSuspectWd(convA, 5200);
    const closeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url) => {
        if (url === "/api/stats") {
          return new Promise((resolve) => {
            resolveFailStats = () => resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
          });
        }
        if (url === "/api/handoff") {
          hoCloseCount += 1;
          return Promise.resolve({ ok: true, status: 200, json: async () => makeBriefPayload(convA, "CLOSE_MID_AWAIT", wdSusClose.current.incidentKey) });
        }
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
    };
    const { ctx: closeCtx, elements: closeEls } = createDashboardVmSandbox({ sidecarObj: closeHost, fetchImpl: closeHost.fetch });
    resolveFailStats?.();
    resolveFailStats = null;
    await new Promise((r) => setTimeout(r, 20));
    vm.runInContext("renderWatchdogCard(wdH); handoffDrawerOpen = true;", Object.assign(closeCtx, { wdH: makeHealthyWd(convA) }));
    const closeLoadP = vm.runInContext("loadHandoffBrief({ forceRefresh: true });", closeCtx);
    await new Promise((r) => setTimeout(r, 15));
    // Close drawer while refreshData(false) is still pending, then fail /api/stats with 503
    vm.runInContext("toggleHandoffDrawer(false);", closeCtx);
    resolveFailStats();
    const closeSnap = await closeLoadP;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closeSnap, null);
    assert.equal(hoCloseCount, 1, "Closing drawer mid-await on 503 must NOT fire extra /api/handoff retries");
    assert.equal(vm.runInContext("handoffLoading", closeCtx), false);
    assert.equal(vm.runInContext("cachedHandoffSnapshot", closeCtx), null);
    assert.equal(closeEls.get("kv-handoff-copy-btn").disabled, true);

    // (3) copyWatchdogRescueBrief() reverse server-ahead recovery (client suspect, server recovered incidentKey: "") + stale target switch (convA -> convB)
    const wdSusCopy = makeSuspectWd(convA, 5300);
    let serverCopyWd = wdSusCopy;
    let copyWdFetches = 0;
    let copyRefreshCalls = 0;
    let deferCopyHo = null;
    const rescueCopied = [];
    const copyHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url) => {
        if (url === "/api/stats") {
          copyRefreshCalls += 1;
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        }
        if (url === "/api/doctor") return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "HEALTHY" }) });
        if (url === "/api/cache-diag") return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, transcriptFound: false }) });
        if (url === "/api/resume") return Promise.resolve({ ok: true, status: 200, json: async () => ({ recentSources: [], recentEvents: [] }) });
        if (url === "/api/watchdog") {
          copyWdFetches += 1;
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...serverCopyWd }) });
        }
        if (url === "/api/handoff") {
          if (deferCopyHo === "arm") {
            return new Promise((resolve) => {
              deferCopyHo = (payload) => resolve({ ok: true, status: 200, json: async () => payload });
            });
          }
          return Promise.resolve({ ok: true, status: 200, json: async () => makeBriefPayload(convA, "RECOVERED_RESCUE_CLICK", "") });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
    };
    const { ctx: copyCtx } = createDashboardVmSandbox({ sidecarObj: copyHost, fetchImpl: copyHost.fetch, copiedOut: rescueCopied });
    await new Promise((r) => setTimeout(r, 20));
    vm.runInContext("renderWatchdogCard(wdS);", Object.assign(copyCtx, { wdS: wdSusCopy }));
    serverCopyWd = makeHealthyWd(convA);
    copyWdFetches = 0;
    await vm.runInContext("copyWatchdogRescueBrief();", copyCtx);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rescueCopied.length, 0, "copyWatchdogRescueBrief() on recovered healthy response must NOT write stale-stamped snapshot to clipboard");
    assert.equal(vm.runInContext("cachedHandoffSnapshot", copyCtx), null);
    assert.ok(copyWdFetches >= 1, "copyWatchdogRescueBrief() reverse recovery must trigger Watchdog refresh");
    assert.equal(vm.runInContext("getCurrentWatchdogIncidentKey()", copyCtx), "", "Watchdog card must refresh to healthy");

    // Stale target switch convA -> convB mid-copyWatchdogRescueBrief() must NOT trigger spurious refreshData(false)
    vm.runInContext("renderWatchdogCard(wdS);", Object.assign(copyCtx, { wdS: wdSusCopy }));
    deferCopyHo = "arm";
    copyRefreshCalls = 0;
    const staleCopyP = vm.runInContext("copyWatchdogRescueBrief();", copyCtx);
    await new Promise((r) => setTimeout(r, 10));
    copyHost.conversationId = convB;
    vm.runInContext("syncNativeHostConversation({ reloadIfOpen: false }); renderWatchdogCard(wdB);", Object.assign(copyCtx, { wdB: makeHealthyWd(convB) }));
    deferCopyHo(makeBriefPayload(convA, "STALE_CONV_A", wdSusCopy.current.incidentKey));
    await staleCopyP;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(copyRefreshCalls, 0, "Stale copyWatchdogRescueBrief() response after A->B switch must NOT trigger spurious refreshData(false)");
    assert.equal(rescueCopied.length, 0);
  }

  // === Reverse direction when Watchdog refresh fails (503): NEVER stamp stale curIncident onto recovered healthy brief ===
  {
    const deferredHandoffs = [];
    const wdSusA = makeSuspectWd(convA, 4500);
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          return new Promise((resolve) => {
            deferredHandoffs.push({
              body,
              resolve: (payload) => resolve({ ok: true, status: 200, json: async () => payload })
            });
          });
        }
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch
    });
    await new Promise((r) => setTimeout(r, 20));
    vm.runInContext("renderWatchdogCard(wdS); toggleHandoffDrawer(true);", Object.assign(ctx, { wdS: wdSusA }));
    assert.equal(deferredHandoffs.length, 1);
    // Server returns explicit healthy incidentKey: "" while client Watchdog is stuck on suspect (and /api/stats returns 503)
    deferredHandoffs.shift().resolve(makeBriefPayload(convA, "RECOVERED_WHILE_WD_503_1", ""));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deferredHandoffs.length, 1, "Reverse mismatch with failing Watchdog refresh must trigger at most 1 bounded retry");
    deferredHandoffs.shift().resolve(makeBriefPayload(convA, "RECOVERED_WHILE_WD_503_2", ""));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deferredHandoffs.length, 0, "Reverse mismatch retry cap must prevent infinite loop");
    assert.equal(vm.runInContext("handoffLoading", ctx), false);
    assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null, "Must NEVER stamp stale suspect incidentKey onto recovered healthy brief");
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
  }

  // === P1-04: Aggregate `app` & `lifetime` views invalidate old card actions on host switch A->B, then allow post-refresh actions (even targeting A) ===
  for (const aggScope of ["app", "lifetime"]) {
    const actionCalls = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/watchdog/action") {
          actionCalls.push(body);
          const nextCur =
            body.action === "ack"
              ? { ...makeStalledWd(convA, aggScope).current, severity: "snoozed" }
              : { conversationId: convA, phase: "IDLE", severity: "idle" };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              conversationId: body.conversationId,
              status: { ok: true, enabled: true, scope: aggScope, current: nextCur, sessions: [], alertingSessions: [] }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch
    });
    vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
    vm.runInContext("renderWatchdogCard(wdAggA);", Object.assign(ctx, { wdAggA: makeStalledWd(convA, aggScope) }));
    assert.equal(elements.get("wd-snooze-btn").disabled, false);
    assert.equal(elements.get("wd-clear-btn").disabled, false);

    // Switch host A -> B BEFORE next poll arrives!
    nativeHost.conversationId = convB;
    // Language toggle before poll must NOT tamper with old epoch!
    vm.runInContext("syncNativeHostConversation({ reloadIfOpen: false }); setLanguage('zh');", ctx);
    assert.equal(elements.get("wd-snooze-btn").disabled, true, `(${aggScope}) Snooze must stay disabled after A->B switch before poll`);
    assert.equal(elements.get("wd-clear-btn").disabled, true, `(${aggScope}) Clear must stay disabled after A->B switch before poll`);
    await vm.runInContext("snoozeWatchdogAlert();", ctx);
    await vm.runInContext("markWatchdogIdle();", ctx);
    assert.equal(actionCalls.length, 0, `(${aggScope}) Old card snooze/clear after A->B must send 0 actions`);

    // New epoch aggregate poll arrives (top alert is STILL A!) -> buttons recover and snooze/clear BOTH apply cleanly!
    vm.runInContext("renderWatchdogCard(wdAggNext);", Object.assign(ctx, { wdAggNext: makeStalledWd(convA, aggScope) }));
    assert.equal(elements.get("wd-snooze-btn").disabled, false, `(${aggScope}) Fresh epoch poll must re-enable snooze`);
    assert.equal(elements.get("wd-clear-btn").disabled, false, `(${aggScope}) Fresh epoch poll must re-enable clear`);

    await vm.runInContext("snoozeWatchdogAlert();", ctx);
    assert.equal(actionCalls.length, 1);
    assert.equal(actionCalls[0].action, "ack");
    assert.equal(actionCalls[0].conversationId, convA);
    assert.equal(vm.runInContext("cachedWatchdog.current.severity", ctx), "snoozed", `(${aggScope}) Snooze response must be accepted when host is bound to B`);

    await vm.runInContext("markWatchdogIdle();", ctx);
    assert.equal(actionCalls.length, 2);
    assert.equal(actionCalls[1].action, "clear");
    assert.equal(actionCalls[1].conversationId, convA);
    assert.equal(vm.runInContext("cachedWatchdog.current.phase", ctx), "IDLE", `(${aggScope}) Clear response must be accepted when host is bound to B`);

    // Pre-stamped old-epoch payload arriving right after another host switch B->A must NOT forge the new epoch
    const stalePreStamped = { ...makeStalledWd(convA, aggScope), _hostEpoch: vm.runInContext("hostSwitchEpoch", ctx) };
    nativeHost.conversationId = convA;
    vm.runInContext("renderWatchdogCard(wdStalePre, { expectedEpoch: wdStalePre._hostEpoch });", Object.assign(ctx, { wdStalePre: stalePreStamped }));
    assert.equal(elements.get("wd-snooze-btn").disabled, true, `(${aggScope}) Stale pre-stamped Watchdog payload after host switch must keep snooze disabled`);
    assert.equal(elements.get("wd-clear-btn").disabled, true, `(${aggScope}) Stale pre-stamped Watchdog payload after host switch must keep clear disabled`);
    assert.ok(
      !elements.get("kv-handoff-warmth-hint").className.includes("is-danger"),
      `(${aggScope}) Unaligned stale Watchdog must not show is-danger stall warmth hint`
    );
  }

  // === P2-02: Both LOADED and LOADING states across full Healthy -> Suspect -> Stalled -> Recovered cycle ===
  for (const startMode of ["loaded", "loading"]) {
    const copied = [];
    const deferredHandoffs = [];
    const nativeHost = {
      conversationId: convA,
      ui: { toggleConversation() {} },
      fetch: (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/handoff") {
          return new Promise((resolve) => {
            deferredHandoffs.push({
              body,
              resolve: (payload) => resolve({ ok: true, status: 200, json: async () => payload })
            });
          });
        }
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ ok: false }) });
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch,
      copiedOut: copied
    });

    vm.runInContext("renderWatchdogCard(wdH); toggleHandoffDrawer(true);", Object.assign(ctx, { wdH: makeHealthyWd(convA) }));
    assert.equal(deferredHandoffs.length, 1);
    const healthyReq = deferredHandoffs.shift();
    if (startMode === "loaded") {
      healthyReq.resolve(makeBriefPayload(convA, "INIT_HEALTHY", ""));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
    }

    // 1. Healthy -> Suspect (no rescueBrief): MUST invalidate, disable BOTH buttons, and issue fresh suspect request!
    const wdSus = makeSuspectWd(convA, 3000);
    vm.runInContext("renderWatchdogCard(wdS);", Object.assign(ctx, { wdS: wdSus }));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, `(${startMode}) Copy Brief must disable during healthy->suspect`);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, `(${startMode}) Copy Prompt must disable during healthy->suspect`);
    assert.equal(deferredHandoffs.length, 1, `(${startMode}) Healthy->suspect must trigger 1 fresh /api/handoff`);
    if (startMode === "loading") {
      // Late healthy response must be rejected
      healthyReq.resolve(makeBriefPayload(convA, "LATE_HEALTHY", ""));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
    }
    const suspectReq = deferredHandoffs.shift();
    if (startMode === "loaded") {
      suspectReq.resolve(makeBriefPayload(convA, "SUSPECT_FRESH", wdSus.current.incidentKey));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
      await vm.runInContext("copyHandoffBrief();", ctx);
      assert.ok(copied.pop().includes("BRIEF_SUSPECT_FRESH"));
    }

    // 2. Suspect -> Stalled (with prebuilt rescueBrief): immediately switches & copies stalled rescue!
    const wdSt = makeStalledWd(convA, "conversation", 3000);
    vm.runInContext("renderWatchdogCard(wdSt);", Object.assign(ctx, { wdSt }));
    if (startMode === "loading") {
      suspectReq.resolve(makeBriefPayload(convA, "LATE_SUSPECT", wdSus.current.incidentKey));
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
    await vm.runInContext("copyHandoffBrief();", ctx);
    assert.ok(copied.pop().includes(`RESCUE_${convA}_3000`));

    // 3. Stalled -> Recovered Healthy (IDLE): disables while refetching healthy, auto-reloads, re-enables & copies healthy!
    vm.runInContext("renderWatchdogCard(wdRec);", Object.assign(ctx, { wdRec: makeHealthyWd(convA) }));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, `(${startMode}) Recovery must disable buttons while refetching healthy brief`);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
    assert.equal(deferredHandoffs.length, 1, `(${startMode}) Recovery must auto-reload healthy brief`);
    deferredHandoffs.shift().resolve(makeBriefPayload(convA, "RECOVERED_HEALTHY", ""));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
    await vm.runInContext("copyHandoffBrief();", ctx);
    assert.ok(copied.pop().includes("BRIEF_RECOVERED_HEALTHY"));
  }

  // === P2-01: Inferred conversation confirmation entry works when Watchdog is DISABLED AND when ENABLED with empty sessions ===
  for (const [label, wdEnabled] of [
    ["watchdog_disabled", false],
    ["watchdog_enabled_no_leases", true]
  ]) {
    const convInferred = `conv-r2-inferred-${label}`;
    const hoCalls = [];
    const copied = [];
    const { ctx, elements } = createDashboardVmSandbox({
      copiedOut: copied,
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/stats") return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (url === "/api/doctor") return { ok: true, status: 200, json: async () => ({ status: "HEALTHY" }) };
        if (url === "/api/cache-diag") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              transcriptFound: true,
              resolvedConversationId: convInferred,
              currentContextTokens: 64000,
              ttlKeepalive: { conversationId: convInferred, isSubagent: false }
            })
          };
        }
        if (url === "/api/watchdog") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              enabled: wdEnabled,
              current: null,
              sessions: [],
              alertingSessions: []
            })
          };
        }
        if (url === "/api/resume") return { ok: true, status: 200, json: async () => ({ recentSources: [], recentEvents: [] }) };
        if (url === "/api/watchdog/action" && body.action === "focusConversation") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              status: { ok: true, enabled: wdEnabled, current: null, sessions: [], alertingSessions: [] }
            })
          };
        }
        if (url === "/api/handoff") {
          hoCalls.push(body);
          const conf = body.conversationConfirmed === true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              scope: "conversation",
              mode: "agent",
              confirmedConversation: conf,
              conversationId: conf ? convInferred : "",
              markdown: conf ? `# RICH_BRIEF_${label}` : "# OVERVIEW_ONLY",
              summary: conf ? label : "overview",
              bytes: 30,
              truncated: false,
              anchors: conf
                ? {
                    confirmed: true,
                    conversationId: convInferred,
                    nextTasks: [`[/] CONFIRMED_TASK_${label}`],
                    failingChecks: [],
                    artifacts: [],
                    recentSources: [],
                    resumeSameWindow: "ctx_resume({})",
                    resumeCrossWindow: ""
                  }
                : { confirmed: false, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });

    await vm.runInContext("refreshData(true);", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const switcher = elements.get("wd-session-switcher");
    assert.equal(switcher.classList.contains("hidden"), false, `(${label}) Confirmation switcher must be visible`);
    assert.ok(switcher.innerHTML.includes(`data-jump-conv="${convInferred}"`), `(${label}) Switcher must expose clickable inferred session`);
    assert.ok(!switcher.innerHTML.includes('aria-current="true"'), `(${label}) Must not be marked current before user clicks`);

    // Before clicking confirmation: overview only
    vm.runInContext("toggleHandoffDrawer(true);", ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(hoCalls[0].conversationConfirmed, false, `(${label}) Before confirmation must request overview only`);
    assert.ok(elements.get("kv-handoff-preview").textContent.includes("# OVERVIEW_ONLY"));
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

    // Click confirmation entry -> sets selectedConvOverride, fetches confirmed rich brief!
    await vm.runInContext(`jumpToConversation(${JSON.stringify(convInferred)});`, ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(switcher.innerHTML.includes('aria-current="true"'), `(${label}) Must mark confirmed after click`);
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(`# RICH_BRIEF_${label}`));
    assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes(`CONFIRMED_TASK_${label}`));
  }

  // === Standalone auto-refresh discovering inferredFallbackConvId must not drop follow-up refresh while autoRefreshInFlight === true ===
  {
    let phase = 0;
    const statsConvIds = [];
    const { ctx } = createDashboardVmSandbox({
      fetchImpl: async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (url === "/api/stats") {
          statsConvIds.push(body.conversationId || "");
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === "/api/doctor") return { ok: true, status: 200, json: async () => ({ status: "HEALTHY" }) };
        if (url === "/api/cache-diag") {
          const cid = phase >= 1 ? "conv-auto-inferred-r2" : "";
          return { ok: true, status: 200, json: async () => ({ ok: true, transcriptFound: Boolean(cid), resolvedConversationId: cid }) };
        }
        if (url === "/api/watchdog") {
          return {
            ok: true,
            status: 200,
            json: async () => {
              await new Promise((r) => setTimeout(r, 10));
              return { ok: true, enabled: true, current: null, sessions: [], alertingSessions: [] };
            }
          };
        }
        if (url === "/api/resume") return { ok: true, status: 200, json: async () => ({ recentSources: [], recentEvents: [] }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });
    await new Promise((r) => setTimeout(r, 30));
    statsConvIds.length = 0;
    phase = 1;
    await vm.runInContext("refreshData(false);", ctx);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(vm.runInContext("inferredFallbackConvId", ctx), "conv-auto-inferred-r2");
    assert.ok(
      statsConvIds.includes("conv-auto-inferred-r2"),
      `Standalone auto-refresh must schedule follow-up refresh with discovered inferredFallbackConvId (got ${JSON.stringify(statsConvIds)})`
    );
  }
});

test("v1.7.3-11: Round-2 P2-07 (real CLI >2 MiB stdout/stderr Err / Error: / mid-body cuts), P2-08 (real Node v24 TAP block scalar), P2-05 (fs.readSync byte spy) & P3-01 (multi-root semantics)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-r2-io-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const cliFilterPath = path.join(ROOT, "hooks", "cli-filter.mjs");

  try {
    // === P2-07: Real CLI >2 MiB on BOTH stdout & stderr with boundary landing inside `Err`, right after `Error: `, and mid-body ===
    const secretTok = "ghp_99887766554433221100aabbccddeeff112233";
    const fullErrMsg = `Error: expected manifest version 2 token=${secretTok}`;
    for (const streamName of ["stdout", "stderr"]) {
      for (const [cutLabel, cutLen] of [
        ["mid_err", 3], // "Err" | "or: ..."
        ["after_colon_space", 7], // "Error: " | "expected ..."
        ["mid_body", 19] // "Error: expected man" | "ifest ..."
      ]) {
        const sid = `sess-r2-p207-${streamName}-${cutLabel}`;
        const scriptPath = path.join(tmpDir, `p207-${streamName}-${cutLabel}.mjs`);
        const part1 = fullErrMsg.slice(0, cutLen);
        const part2 = fullErrMsg.slice(cutLen) + "\n";
        fs.writeFileSync(
          scriptPath,
          [
            `const padBytes = 2 * 1024 * 1024 - ${Buffer.byteLength(part1, "utf8")};`,
            `const line = "ok_line_0123456789abcdef0123456789abcdef0123456789abcdef012345\\n";`,
            `const fullLines = Math.floor(padBytes / line.length);`,
            `const rem = padBytes - fullLines * line.length;`,
            `for (let i = 0; i < fullLines; i++) process.${streamName}.write(line);`,
            `if (rem > 0) process.${streamName}.write("a".repeat(rem - 1) + "\\n");`,
            `process.${streamName}.write(${JSON.stringify(part1)});`,
            `setTimeout(() => {`,
            `  process.${streamName}.write(${JSON.stringify(part2)});`,
            `  process.exit(1);`,
            `}, 10);`
          ].join("\n"),
          "utf8"
        );
        const run = spawnSync(
          process.execPath,
          [
            cliFilterPath,
            "--rule",
            "test-runner",
            "--b64",
            `b:${Buffer.from(`node ${JSON.stringify(scriptPath)}`, "utf8").toString("base64url")}`,
            "--session",
            `b:${Buffer.from(sid, "utf8").toString("base64url")}`
          ],
          { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
        );
        assert.equal(run.status, 1, `P2-07 (${streamName}/${cutLabel}) must exit 1`);
        const st = new ContextModeStore({ dbPath: tmpDb });
        const cp = st.getSessionCheckpoint(sid);
        st.close();
        const ex = cp.lastTest?.failureExcerpt || "";
        assert.ok(
          ex.includes("Error: expected manifest version 2"),
          `P2-07 (${streamName}/${cutLabel}) must capture complete error line, got: ${JSON.stringify(ex)}`
        );
        assert.ok(!ex.includes(secretTok), `P2-07 (${streamName}/${cutLabel}) must redact secret`);
        assert.ok(ex.includes("[REDACTED:"), `P2-07 (${streamName}/${cutLabel}) must retain redaction marker`);
        assert.ok(ex.split("\n").length <= 5, `P2-07 (${streamName}/${cutLabel}) must be <= 5 lines`);
        assert.ok(Buffer.byteLength(ex, "utf8") <= 500, `P2-07 (${streamName}/${cutLabel}) must be <= 500 B`);
      }
    }

    // Also verify P2-07 boundary-adjacent multi-line error: anchor finishes right before 2 MiB \n, detail line sits in overflow tail
    {
      const sidMulti = "sess-r2-p207-boundary-multiline";
      const multiScript = path.join(tmpDir, "p207-boundary-multiline.mjs");
      const anchorLine = "not ok 1 - checks manifest boundary\n";
      const padBytes = 2 * 1024 * 1024 - Buffer.byteLength(anchorLine, "utf8");
      fs.writeFileSync(
        multiScript,
        [
          `const padBytes = ${padBytes};`,
          `const line = "ok_line_0123456789abcdef0123456789abcdef0123456789abcdef012345\\n";`,
          `const fullLines = Math.floor(padBytes / line.length);`,
          `const rem = padBytes - fullLines * line.length;`,
          `for (let i = 0; i < fullLines; i++) process.stdout.write(line);`,
          `if (rem > 0) process.stdout.write("a".repeat(rem - 1) + "\\n");`,
          `process.stdout.write(${JSON.stringify(anchorLine)});`,
          `process.stdout.write("  ---\\n  error: |-\\n    BOUNDARY_CONTINUATION_DIAG_42\\n  ...\\n");`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const runMulti = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from("node p207-boundary-multiline.mjs", "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sidMulti, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(runMulti.status, 1);
      const stM = new ContextModeStore({ dbPath: tmpDb });
      const cpM = stM.getSessionCheckpoint(sidMulti);
      stM.close();
      assert.ok(
        (cpM.lastTest?.failureExcerpt || "").includes("BOUNDARY_CONTINUATION_DIAG_42"),
        `P2-07: Boundary-adjacent multi-line error must upgrade to complete tail version, got: ${JSON.stringify(cpM.lastTest?.failureExcerpt)}`
      );
    }

    // Also verify P2-07 ANSI-colored boundary-adjacent failure upgrades cleanly to tail (ANSI must not break tailWindow anchor match)
    {
      const sidAnsi = "sess-r2-p207-boundary-ansi";
      const ansiScript = path.join(tmpDir, "p207-boundary-ansi.mjs");
      const ansiHeader = "\x1b[31mFAIL\x1b[0m src/ansi-boundary.test.mjs\n";
      const padBytes = 2 * 1024 * 1024 - Buffer.byteLength(ansiHeader, "utf8");
      fs.writeFileSync(
        ansiScript,
        [
          `const padBytes = ${padBytes};`,
          `const line = "ok_line_0123456789abcdef0123456789abcdef0123456789abcdef012345\\n";`,
          `const fullLines = Math.floor(padBytes / line.length);`,
          `const rem = padBytes - fullLines * line.length;`,
          `for (let i = 0; i < fullLines; i++) process.stdout.write(line);`,
          `if (rem > 0) process.stdout.write("a".repeat(rem - 1) + "\\n");`,
          `process.stdout.write(${JSON.stringify(ansiHeader)});`,
          `process.stdout.write("\\x1b[31mAssertionError: ANSI_BOUNDARY_DETAIL_99\\x1b[0m\\n");`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const runAnsi = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from("node p207-boundary-ansi.mjs", "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sidAnsi, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(runAnsi.status, 1);
      const stA = new ContextModeStore({ dbPath: tmpDb });
      const cpA = stA.getSessionCheckpoint(sidAnsi);
      stA.close();
      assert.ok(
        (cpA.lastTest?.failureExcerpt || "").includes("ANSI_BOUNDARY_DETAIL_99"),
        `P2-07: ANSI-colored boundary-adjacent error must upgrade to complete tail version, got: ${JSON.stringify(cpA.lastTest?.failureExcerpt)}`
      );
    }

    // === P2-08: Real `node --test --test-reporter=tap` output through real cli-filter.mjs -> SQLite -> handoff & prompt ===
    const tapTestFile = path.join(tmpDir, "real-tap.test.mjs");
    fs.writeFileSync(
      tapTestFile,
      [
        `import test from "node:test";`,
        `import assert from "node:assert/strict";`,
        `test("handles error recovery cleanly", () => { assert.equal(1, 1); });`,
        `test("validates manifest version", () => { assert.equal(1, 2, "expected manifest version 2"); });`
      ].join("\n"),
      "utf8"
    );
    const tapSid = "sess-r2-p208-real-tap";
    const tapCmd = "node --test --test-reporter=tap real-tap.test.mjs";
    const tapChildEnv = { ...process.env, AGY_DART_DB_PATH: tmpDb };
    delete tapChildEnv.NODE_TEST_CONTEXT;
    const tapRun = spawnSync(
      process.execPath,
      [
        cliFilterPath,
        "--rule",
        "test-runner",
        "--b64",
        `b:${Buffer.from(tapCmd, "utf8").toString("base64url")}`,
        "--session",
        `b:${Buffer.from(tapSid, "utf8").toString("base64url")}`
      ],
      { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: tapChildEnv }
    );
    assert.equal(tapRun.status, 1, "Real node --test TAP failure must exit 1");
    const tapStore = new ContextModeStore({ dbPath: tmpDb });
    const tapCp = tapStore.getSessionCheckpoint(tapSid);
    const tapEx = tapCp.lastTest?.failureExcerpt || "";
    const tapExLines = tapEx.split("\n");
    assert.ok(tapExLines[0].startsWith("not ok "), `P2-08: Line 1 must be failing test name, got:\n${tapEx}`);
    assert.ok(tapEx.includes("validates manifest version"), `P2-08: Must keep failing case name:\n${tapEx}`);
    assert.ok(tapEx.includes("expected manifest version 2"), `P2-08: Must extract YAML block scalar diagnostic:\n${tapEx}`);
    assert.ok(!tapEx.includes("handles error recovery cleanly"), `P2-08: Must skip passing test with 'error' in title:\n${tapEx}`);
    assert.ok(!tapEx.includes("duration_ms:"), `P2-08: Must filter duration_ms noise:\n${tapEx}`);
    assert.ok(!tapEx.includes("failureType:"), `P2-08: Must filter failureType noise:\n${tapEx}`);
    assert.ok(!tapEx.includes("error: |-"), `P2-08: Must NOT waste a line on bare 'error: |-':\n${tapEx}`);
    assert.ok(tapExLines.length <= 5 && Buffer.byteLength(tapEx, "utf8") <= 500);

    const tapBrief = buildHandoffBrief({
      store: tapStore,
      mode: "agent",
      scope: "conversation",
      conversationId: tapSid,
      conversationConfirmed: true,
      sessionId: tapSid,
      cwd: tmpDir
    });
    tapStore.close();
    assert.ok(tapBrief.markdown.includes("expected manifest version 2"), "P2-08: Handoff Markdown must include real TAP error");
    assert.ok(
      tapBrief.anchors.failingChecks[0]?.firstErrorLine?.includes("validates manifest version") &&
        tapBrief.anchors.failingChecks[0]?.firstErrorLine?.includes("expected manifest version 2"),
      `P2-08: firstErrorLine must keep case name + actual diagnostic, got: ${JSON.stringify(tapBrief.anchors.failingChecks[0]?.firstErrorLine)}`
    );
    const { ctx: promptCtx } = createDashboardVmSandbox();
    const tapPromptZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(tapBrief)}, "zh");`, promptCtx);
    assert.ok(tapPromptZh.includes("expected manifest version 2"), "P2-08: Semantic prompt must include real TAP diagnostic");
    // Multiline quoted YAML scalar & inline stack fallback edge cases
    const multiQuotedTap = extractFailureExcerpt(
      "TAP version 13\nnot ok 1 - quoted fail\n  ---\n  duration_ms: 0.5\n  error: 'first quoted line\n    second quoted line'\n  code: 'ERR_ASSERTION'\n  ..."
    );
    assert.equal(
      multiQuotedTap,
      "not ok 1 - quoted fail\nerror: first quoted line\nsecond quoted line\ncode: 'ERR_ASSERTION'"
    );
    const inlineStackTap = extractFailureExcerpt(
      "TAP version 13\nnot ok 1 - stack only\n  ---\n  duration_ms: 0.5\n  stack: 'at checkFoo (foo.test.mjs:10:1)'\n  ..."
    );
    assert.equal(inlineStackTap, "not ok 1 - stack only\nat checkFoo (foo.test.mjs:10:1)");

    // === P2-05: Spy underlying fs.readSync physical bytes (<=64 KiB head / <=128 KiB tail, exact totalBytesRead) on full-line & mid-line tail boundaries ===
    const brainP205 = path.join(tmpDir, "brain-p205");
    const origReadSync = fs.readSync;
    const measurePhysicalRead = (filePath) => {
      let physicalBytes = 0;
      const calls = [];
      fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
        const n = origReadSync.call(fs, fd, buffer, offset, length, position);
        if (n > 0) {
          physicalBytes += n;
          calls.push({ length, position, n });
        }
        return n;
      };
      try {
        const res = readTranscriptHeadTailFixed(filePath);
        return { res, physicalBytes, calls };
      } finally {
        fs.readSync = origReadSync;
      }
    };

    // Case A: Large >220 KiB file where tailOffset lands on EXACT start of a complete JSONL line
    const txExact = path.join(brainP205, "exact.jsonl");
    fs.mkdirSync(brainP205, { recursive: true });
    const exactBoundaryRec =
      JSON.stringify({ type: "USER_INPUT", step_index: 50, user_input: "<USER_REQUEST>EXACT_START_MARKER</USER_REQUEST>" }) + "\n";
    const remTailExact = 131072 - Buffer.byteLength(exactBoundaryRec, "utf8");
    const padShell = JSON.stringify({ type: "TOOL_RESULT", step_index: 51, content: "" }) + "\n";
    const exactTailPad =
      JSON.stringify({ type: "TOOL_RESULT", step_index: 51, content: "T".repeat(remTailExact - Buffer.byteLength(padShell, "utf8")) }) + "\n";
    const headRec = JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>HEAD_REC</USER_REQUEST>" }) + "\n";
    const midPad = JSON.stringify({ type: "TOOL_RESULT", step_index: 2, content: "M".repeat(95 * 1024) }) + "\n";
    fs.writeFileSync(txExact, headRec + midPad + exactBoundaryRec + exactTailPad, "utf8");

    const mExact = measurePhysicalRead(txExact);
    assert.equal(mExact.res.overlapped, false);
    assert.ok(mExact.res.headBytesRead <= 65536, `headBytesRead must be <= 65536, got ${mExact.res.headBytesRead}`);
    assert.ok(mExact.res.tailBytesRead <= 131072, `tailBytesRead must be <= 131072, got ${mExact.res.tailBytesRead}`);
    assert.equal(mExact.physicalBytes, 196608, `P2-05: Physical fs.readSync bytes must be exactly 196608 (not 196609!), got ${mExact.physicalBytes}`);
    assert.equal(mExact.res.totalBytesRead, mExact.physicalBytes, "P2-05: totalBytesRead must match exact physical bytes read");
    assert.equal(mExact.calls.length, 2, "P2-05: Must execute strictly 2 readSync windows (head + tail), no 1-byte probe");
    assert.ok(
      JSON.stringify(mExact.res.tailSteps[0]).includes("EXACT_START_MARKER"),
      "P2-05: Exact record-start line must be preserved as tailSteps[0]"
    );

    // Case B: Large >220 KiB file where tailOffset lands MID-LINE (inside nested JSON object AND mid-UTF-8 CJK)
    for (const [midTag, midObj] of [
      ["nested_obj", { type: "TOOL_RESULT", step_index: 49, content: "A".repeat(120), nested: { ok: true } }],
      ["utf8_cjk", { type: "TOOL_RESULT", step_index: 49, content: "中文边界🚀".repeat(40) }]
    ]) {
      const txMid = path.join(brainP205, `mid-${midTag}.jsonl`);
      const nextComplete =
        JSON.stringify({ type: "USER_INPUT", step_index: 60, user_input: `<USER_REQUEST>NEXT_AFTER_${midTag}</USER_REQUEST>` }) + "\n";
      const midLine = JSON.stringify(midObj) + "\n";
      // Place tailOffset right in the middle of midLine (keep only the trailing half of midLine inside the 128 KiB tail)
      const tailSuffixBytes = Math.floor(Buffer.byteLength(midLine, "utf8") / 2);
      const padAfterBytes = 131072 - tailSuffixBytes - Buffer.byteLength(nextComplete, "utf8");
      const tailAfterPad =
        JSON.stringify({ type: "TOOL_RESULT", step_index: 61, content: "Z".repeat(padAfterBytes - Buffer.byteLength(padShell, "utf8")) }) + "\n";
      fs.writeFileSync(txMid, headRec + midPad + midLine + nextComplete + tailAfterPad, "utf8");

      const mMid = measurePhysicalRead(txMid);
      assert.equal(mMid.physicalBytes, 196608, `P2-05 (${midTag}): Physical bytes must be strictly 196608`);
      assert.equal(mMid.res.totalBytesRead, mMid.physicalBytes);
      assert.ok(
        JSON.stringify(mMid.res.tailSteps[0]).includes(`NEXT_AFTER_${midTag}`),
        `P2-05 (${midTag}): Partial leading line must be discarded and next complete line must be tailSteps[0]`
      );
      assert.ok(!JSON.stringify(mMid.res.tailSteps).includes("\uFFFD"), `P2-05 (${midTag}): No UTF-8 corruption`);
    }

    // === P3-01: Multi-root same-ID selection semantics ===
    const root1 = path.join(tmpDir, "brain-root-1");
    const root2 = path.join(tmpDir, "brain-root-2");
    fs.mkdirSync(root1, { recursive: true });
    fs.mkdirSync(root2, { recursive: true });
    const canon = (p) => (typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(p) : fs.realpathSync(p));

    // (1) First root has only empty conversation dir (even with empty .system_generated/logs) -> falls back to second root
    const cEmpty = "conv-p301-empty-first";
    fs.mkdirSync(path.join(root1, cEmpty, ".system_generated", "logs"), { recursive: true });
    fs.mkdirSync(path.join(root2, cEmpty, ".system_generated", "logs"), { recursive: true });
    const txEmptyR2 = path.join(root2, cEmpty, ".system_generated", "logs", "transcript.jsonl");
    fs.writeFileSync(
      txEmptyR2,
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>P301_ROOT2_QUOTE</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(root2, cEmpty, "task.md"), "- [/] P301_ROOT2_TASK\n", "utf8");
    assert.equal(canon(findPreferredTranscriptForConversation(cEmpty, { extraRoots: [root1, root2] })), canon(txEmptyR2));
    const bEmpty = buildHandoffBrief({
      mode: "agent",
      scope: "conversation",
      conversationId: cEmpty,
      conversationConfirmed: true,
      brainRoots: [root1, root2]
    });
    assert.ok(bEmpty.markdown.includes("P301_ROOT2_QUOTE") && bEmpty.markdown.includes("P301_ROOT2_TASK"));

    // (2) First root has owned transcript_full.jsonl -> LOCKS onto first root (does NOT jump to root2 transcript.jsonl or mix root2 task.md!)
    const cLockFull = "conv-p301-lock-full";
    fs.mkdirSync(path.join(root1, cLockFull, ".system_generated", "logs"), { recursive: true });
    fs.mkdirSync(path.join(root2, cLockFull, ".system_generated", "logs"), { recursive: true });
    const txLockR1 = path.join(root1, cLockFull, ".system_generated", "logs", "transcript_full.jsonl");
    fs.writeFileSync(
      txLockR1,
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>P301_ROOT1_FULL_QUOTE</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(root2, cLockFull, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>P301_ROOT2_SHOULD_NOT_MIX</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(root2, cLockFull, "task.md"), "- [/] P301_ROOT2_TASK_SHOULD_NOT_MIX\n", "utf8");
    assert.equal(canon(findPreferredTranscriptForConversation(cLockFull, { extraRoots: [root1, root2] })), canon(txLockR1));
    const bLockFull = buildHandoffBrief({
      mode: "agent",
      scope: "conversation",
      conversationId: cLockFull,
      conversationConfirmed: true,
      brainRoots: [root1, root2]
    });
    assert.ok(bLockFull.markdown.includes("P301_ROOT1_FULL_QUOTE"));
    assert.ok(!bLockFull.markdown.includes("P301_ROOT2_SHOULD_NOT_MIX"), "Must NOT switch to root2 transcript when root1 owns transcript_full.jsonl");
    assert.ok(!bLockFull.markdown.includes("P301_ROOT2_TASK_SHOULD_NOT_MIX"), "Must NOT cross-mix root2 task.md when root1 owns transcript");

    // (3) First root has owned task.md only -> LOCKS onto first root (does NOT cross-mix root2 transcript!)
    const cLockArt = "conv-p301-lock-artifact";
    fs.mkdirSync(path.join(root1, cLockArt), { recursive: true });
    fs.mkdirSync(path.join(root2, cLockArt, ".system_generated", "logs"), { recursive: true });
    fs.writeFileSync(path.join(root1, cLockArt, "task.md"), "- [/] P301_ROOT1_ONLY_TASK\n", "utf8");
    fs.writeFileSync(
      path.join(root2, cLockArt, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>P301_ROOT2_TX_SHOULD_NOT_MIX</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    const bLockArt = buildHandoffBrief({
      mode: "agent",
      scope: "conversation",
      conversationId: cLockArt,
      conversationConfirmed: true,
      brainRoots: [root1, root2]
    });
    assert.ok(bLockArt.markdown.includes("P301_ROOT1_ONLY_TASK"));
    assert.ok(!bLockArt.markdown.includes("P301_ROOT2_TX_SHOULD_NOT_MIX"), "Must NOT mix root2 transcript when root1 owns task.md");

    // (4) First root has escaping .system_generated junction (no valid owned files) -> locks onto first root (does NOT hop to root2)
    const cEsc = "conv-p301-escape-r1";
    const outsideEsc = path.join(tmpDir, "outside-p301-esc");
    fs.mkdirSync(path.join(outsideEsc, "logs"), { recursive: true });
    fs.writeFileSync(path.join(outsideEsc, "logs", "transcript.jsonl"), "{}\n", "utf8");
    fs.mkdirSync(path.join(root1, cEsc), { recursive: true });
    fs.symlinkSync(outsideEsc, path.join(root1, cEsc, ".system_generated"), process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(path.join(root2, cEsc, ".system_generated", "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(root2, cEsc, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>P301_SHOULD_NOT_HOP</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    assert.equal(
      findPreferredTranscriptForConversation(cEsc, { extraRoots: [root1, root2] }),
      null,
      "P3-01: Suspicious escaping junction in root1 must lock root1 and refuse fallback hop to root2"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-12: Enhancements 9 (Git snapshot state/drift/rescue/isolation/budgets), 10 (bilingual 3-window carryover) & 11 (optional Section-4 long-term rule + clipboard-only)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-enh-"));
  const repoDir = path.join(tmpDir, "repo");
  const unbornDir = path.join(tmpDir, "unborn");
  const nonGitDir = path.join(tmpDir, "non-git");
  const brainRoot = path.join(tmpDir, "brain");
  const tmpDb = path.join(tmpDir, "context.db");
  const convId = "conv-enh-main";

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(unbornDir, { recursive: true });
  fs.mkdirSync(nonGitDir, { recursive: true });
  fs.mkdirSync(path.join(brainRoot, convId, ".system_generated", "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(brainRoot, convId, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>Deliver v1.7.3 enhancements</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(brainRoot, convId, "task.md"), "- [/] Finish Items 9-11\n", "utf8");

  const store = new ContextModeStore({ dbPath: tmpDb });
  const fixedTs1 = Math.max(Date.parse("2026-11-25T12:00:00.000Z"), Date.now() + 3_600_000);
  const fixedTs2 = fixedTs1 + 300_000;
  const fixedIso1 = new Date(fixedTs1).toISOString();

  try {
    // 1. Clean Git repo
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["checkout", "-b", "main"]);
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "b.js"), "export const b = 1;\n", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "initial commit"]);
    const head1 = runGit(repoDir, ["rev-parse", "HEAD"]).trim();
    assert.match(head1, /^[0-9a-f]{40,64}$/);

    store.recordModifiedFiles(convId, [path.join(repoDir, "a.js")], { worktree: repoDir, tool: "apply_edits" });

    const cleanBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs1
    });
    assert.equal(cleanBrief.sampledAt, fixedIso1);
    assert.equal(cleanBrief.anchors.sampledAt, fixedIso1);
    assert.equal(cleanBrief.anchors.gitHeadStatus, "commit");
    assert.equal(cleanBrief.anchors.gitHead, head1);
    assert.equal(cleanBrief.anchors.gitDirtyEntries, 0, "Clean repo with complete status must report 0 dirty entries");
    assert.ok(cleanBrief.markdown.includes(fixedIso1));
    assert.ok(cleanBrief.markdown.includes(head1));
    assert.ok(cleanBrief.markdown.includes("git rev-parse HEAD"));
    assert.ok(cleanBrief.markdown.includes("现场已变更，先核对相关 diff 和未跟踪项，再继续"));

    // 2. Composite dirty state:
    //   (a) a.js staged AND modified in worktree (MM -> 1 entry)
    //   (b) b.js renamed to b-renamed.js (R -> 1 entry)
    //   (c) untracked folder newdir/ with 3 nested files (folded ?? newdir/ -> 1 entry)
    //   (d) untracked loose file loose.txt (?? loose.txt -> 1 entry)
    //   Total dirty entries MUST be 4!
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const a = 2;\n", "utf8");
    runGit(repoDir, ["add", "a.js"]);
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const a = 3;\n", "utf8");
    runGit(repoDir, ["mv", "b.js", "b-renamed.js"]);
    fs.mkdirSync(path.join(repoDir, "newdir"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(repoDir, "newdir", `f${i}.txt`), `f${i}\n`, "utf8");
    }
    fs.writeFileSync(path.join(repoDir, "loose.txt"), "loose\n", "utf8");

    const dirtyBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs1
    });
    assert.equal(dirtyBrief.anchors.gitHead, head1);
    assert.equal(dirtyBrief.anchors.gitDirtyEntries, 4, "Composite dirty state (MM + rename + folded untracked dir + loose file) must count as 4");

    // 3. Post-copy mutation scenarios:
    // (a) Same HEAD, modify already-dirty file in place -> same dirty count (4), both Fact & Semantic outputs warn uncommitted contents may still differ
    fs.writeFileSync(path.join(repoDir, "a.js"), "export const a = 999;\n", "utf8");
    const sameCountBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });
    assert.equal(sameCountBrief.anchors.gitHead, dirtyBrief.anchors.gitHead);
    assert.equal(sameCountBrief.anchors.gitDirtyEntries, dirtyBrief.anchors.gitDirtyEntries);
    assert.ok(dirtyBrief.markdown.includes("uncommitted contents may still differ"));

    // (b) Add only a new dirty item -> same HEAD, dirty count changes 4 -> 5
    fs.writeFileSync(path.join(repoDir, "extra-dirty.txt"), "x\n", "utf8");
    const moreDirtyBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });
    assert.equal(moreDirtyBrief.anchors.gitHead, head1);
    assert.equal(moreDirtyBrief.anchors.gitDirtyEntries, 5);

    // (c) Add a new commit -> HEAD changes!
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "second commit"]);
    const head2 = runGit(repoDir, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(head2, head1);
    const afterCommitBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });
    assert.equal(afterCommitBrief.anchors.gitHead, head2);
    assert.equal(afterCommitBrief.anchors.gitDirtyEntries, 0);

    // 4. Detached HEAD
    runGit(repoDir, ["checkout", "--detach", head1]);
    const detachedBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs1
    });
    assert.equal(detachedBrief.anchors.gitHeadStatus, "commit");
    assert.equal(detachedBrief.anchors.gitHead, head1);
    assert.equal(detachedBrief.anchors.branch, `detached@${head1.slice(0, 7)}`);
    assert.equal(detachedBrief.anchors.gitDirtyEntries, 0);

    // 5. Unborn repo (no commits yet)
    runGit(unbornDir, ["init"]);
    const unbornEmpty = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: unbornDir,
      nowFn: () => fixedTs1
    });
    assert.equal(unbornEmpty.anchors.gitHeadStatus, "unborn");
    assert.equal(unbornEmpty.anchors.gitHead, "");
    assert.equal(unbornEmpty.anchors.gitDirtyEntries, 0);
    assert.ok(unbornEmpty.markdown.includes("尚无提交") && unbornEmpty.markdown.includes("No commits yet"));

    // 6. Non-Git directory
    const nonGitBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: nonGitDir,
      nowFn: () => fixedTs1
    });
    assert.equal(nonGitBrief.anchors.gitHeadStatus, "unknown");
    assert.equal(nonGitBrief.anchors.gitHead, "");
    assert.equal(nonGitBrief.anchors.gitDirtyEntries, null);
    assert.ok(nonGitBrief.markdown.includes("Unknown / 未知"));
    assert.ok(!nonGitBrief.markdown.includes("## Git Workspace"));

    // 7. Partial timeout (status OK -> dirty=2, log times out -> head unknown) + incomplete status (never reports 0!)
    const partialTimeoutBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      nowFn: () => fixedTs1,
      gitExecFn: (args) => {
        if (args.includes("status")) return { status: 0, stdout: "## main\0 M a.js\0?? x.txt\0", stderr: "" };
        if (args.includes("diff")) return { status: 0, stdout: " a.js | 1 +\n", stderr: "" };
        return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) };
      }
    });
    assert.equal(partialTimeoutBrief.anchors.gitDirtyEntries, 2, "Complete status must retain dirty count even when log times out");
    assert.equal(partialTimeoutBrief.anchors.gitHeadStatus, "unknown", "Timed-out log must mark HEAD as unknown");

    const incompleteStatusBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convId,
      conversationConfirmed: true,
      sessionId: convId,
      cwd: repoDir,
      nowFn: () => fixedTs1,
      gitExecFn: (args) => {
        // Missing trailing NUL -> incomplete status must NEVER report 0!
        if (args.includes("status")) return { status: 0, stdout: "## main", stderr: "" };
        return { status: 1, stdout: "", stderr: "fail" };
      }
    });
    assert.equal(incompleteStatusBrief.anchors.gitDirtyEntries, null, "Incomplete status output must report null (Unknown), never 0");

    for (const [badLabel, badStatus] of [
      ["truncated_rename", "## main\0R  new-name.js\0"],
      ["malformed_token", "## main\0CORRUPT_TOKEN_NO_STATUS\0"],
      ["double_space_status", "## main\0   plain-unmodified.js\0"],
      ["half_untracked_status", "## main\0?  half-untracked.js\0"],
      ["empty_mid_nul_token", "## main\0\0 M a.js\0"]
    ]) {
      let diffCalledOnMalformed = false;
      const badStatusBrief = buildHandoffBrief({
        store,
        mode: "agent",
        scope: "conversation",
        conversationId: convId,
        conversationConfirmed: true,
        sessionId: convId,
        cwd: repoDir,
        nowFn: () => fixedTs1,
        gitExecFn: (args) => {
          if (args.includes("status")) return { status: 0, stdout: badStatus, stderr: "" };
          if (args.includes("diff")) {
            diffCalledOnMalformed = true;
            return { status: 0, stdout: " a.js | 1 +\n", stderr: "" };
          }
          if (args.includes("log")) return { status: 0, stdout: `${head1}\tinit\n`, stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
      });
      assert.equal(
        badStatusBrief.anchors.gitDirtyEntries,
        null,
        `Malformed/truncated status (${badLabel}) must report null (Unknown), never 0 or partial count`
      );
      assert.equal(
        diffCalledOnMalformed,
        true,
        `Incomplete/malformed status (${badLabel}) must still run git diff HEAD instead of trusting incomplete hasTrackedChanges=false`
      );
    }

    // 8. Overview / unconfirmed / aggregate isolation of Git Snapshot fields
    for (const [label, opts] of [
      ["unconfirmed", { scope: "conversation", conversationId: convId, conversationConfirmed: false }],
      ["aggregate_app", { scope: "app", conversationId: "", conversationConfirmed: false }],
      ["aggregate_lifetime", { scope: "lifetime", conversationId: "", conversationConfirmed: false }]
    ]) {
      const ov = buildHandoffBrief({ store, mode: "agent", cwd: repoDir, nowFn: () => fixedTs1, ...opts });
      assert.equal(ov.anchors.sampledAt, "", `${label} must not populate sampledAt`);
      assert.equal(ov.anchors.gitHead, "", `${label} must not populate gitHead`);
      assert.equal(ov.anchors.gitHeadStatus, "", `${label} must not populate gitHeadStatus`);
      assert.equal(ov.anchors.gitDirtyEntries, null, `${label} must not populate gitDirtyEntries`);
      assert.ok(!ov.markdown.includes("**Git Snapshot**"), `${label} markdown must not leak Git Snapshot`);
    }

    // 9. Budget matrix 5800/2400/1200/600/320/90 B + legacy full + ctx_resume <= 8500 B
    for (const cap of [5800, 2400, 1200, 600, 320, 90]) {
      const b = buildHandoffBrief({
        store,
        mode: "agent",
        scope: "conversation",
        conversationId: convId,
        conversationConfirmed: true,
        sessionId: convId,
        cwd: repoDir,
        maxBytes: cap,
        brainRoots: [brainRoot],
        nowFn: () => fixedTs1
      });
      assert.ok(Buffer.byteLength(b.markdown, "utf8") <= cap, `Enhancement 9 exceeded cap=${cap}`);
      assert.equal(hasUnclosedFence(b.markdown), false);
      if (cap >= 1200) {
        assert.ok(b.markdown.includes("**Git Snapshot**") && b.markdown.includes(head1), `cap=${cap} must retain full Git Snapshot`);
      }
      if (cap >= 600) {
        assert.ok(b.markdown.includes("ctx_resume({})") && b.markdown.includes(`ctx_resume({ sessionId: "${convId}" })`));
      }
    }
    const legacyFull = buildHandoffBrief({ store, sessionId: convId, cwd: repoDir });
    assert.equal(legacyFull.mode, undefined);
    assert.ok(!legacyFull.markdown.includes("**Git Snapshot**"), "Legacy full mode contract must stay unchanged");
    const tools = createTools({ store });
    const resumeToolRes = await tools.ctx_resume({ sessionId: convId });
    assert.ok(Buffer.byteLength(JSON.stringify(resumeToolRes), "utf8") <= 8500, "ctx_resume must remain <= 8500 B");

    // 10. Watchdog rescue cache + UI preview + language switch + both clipboard copies preserve exact sampledAt & Git Snapshot
    //     AND Items 10 & 11 bilingual template + clipboard-only Sidecar test!
    const enhTxPath = path.join(brainRoot, convId, ".system_generated", "logs", "transcript.jsonl");
    const txOldSec = (fixedTs1 - 1_200_000) / 1000;
    fs.utimesSync(enhTxPath, txOldSec, txOldSec);
    recordHookLeaseTransition(
      store,
      "PreInvocation",
      {
        conversationId: convId,
        cwd: repoDir,
        lastUserInput: "Check stall rescue snapshot",
        transcriptPath: enhTxPath
      },
      { nowMs: fixedTs1 - 950_000, model: "claude-opus-4-6", contextTokens: 150000 }
    );
    let currentMonitorNow = fixedTs1;
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      brainRoots: [brainRoot],
      findTranscriptFn: () => null,
      notifyFn: () => {},
      nowFn: () => currentMonitorNow,
      monoNsFn: () => 3_000_000_000_000n
    });
    const wd1 = monitor.getStatus({ conversationId: convId, scope: "conversation", refresh: true, includeRichRescue: true });
    assert.equal(wd1.current?.rescueBrief?.sampledAt, fixedIso1);
    assert.equal(wd1.current?.rescueBrief?.anchors?.gitHead, head1);
    assert.equal(wd1.current?.rescueBrief?.anchors?.gitDirtyEntries, 0);

    // Advance monitor wall clock 5 minutes later; reusing cached rescueBrief MUST keep original sampledAt!
    currentMonitorNow = fixedTs2;
    const wd2 = monitor.getStatus({ conversationId: convId, scope: "conversation", refresh: true, includeRichRescue: true });
    assert.equal(wd2.current?.rescueBrief?.sampledAt, fixedIso1, "Reused Watchdog rescue cache must retain original sampledAt");

    // Sidecar VM DOM: open rescue drawer, switch EN/ZH language, copy fact brief & semantic prompt -> exact same sampledAt, ZERO extra fetches!
    const copied = [];
    const fetchCalls = [];
    const nativeHost = {
      conversationId: convId,
      ui: { toggleConversation() {} },
      fetch: async (url, opts) => {
        fetchCalls.push({ url, opts });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    };
    const { ctx, elements } = createDashboardVmSandbox({
      sidecarObj: nativeHost,
      fetchImpl: nativeHost.fetch,
      copiedOut: copied
    });
    // Let initial dashboard boot refreshData() settle before testing clipboard-only copy actions
    await new Promise((r) => setTimeout(r, 20));
    vm.runInContext("renderWatchdogCard(wdRescue); openWatchdogRescueDrawer();", Object.assign(ctx, { wdRescue: wd2 }));
    assert.ok(elements.get("kv-handoff-preview").textContent.includes(fixedIso1));

    // Switch to ZH, then verify copyHandoffBrief() & copyHandoffPrompt() are strictly clipboard-only (0 fetches),
    // switch to EN, and verify EN copyHandoffPrompt() is also strictly clipboard-only with identical original sampledAt!
    await vm.runInContext("setLanguage('zh', false);", ctx);
    fetchCalls.length = 0;
    await vm.runInContext("copyHandoffBrief();", ctx);
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(fetchCalls.length, 0, "Item 11: ZH copyHandoffBrief & copyHandoffPrompt must be strictly clipboard-only (0 fetches)");
    await vm.runInContext("setLanguage('en', false);", ctx);
    fetchCalls.length = 0;
    await vm.runInContext("copyHandoffPrompt();", ctx);
    assert.equal(fetchCalls.length, 0, "Item 11: EN copyHandoffPrompt must be strictly clipboard-only (0 fetches)");
    assert.equal(copied.length, 3);
    const [factOut, promptZh, promptEn] = copied;
    for (const [lbl, txt] of [
      ["factOut", factOut],
      ["promptZh", promptZh],
      ["promptEn", promptEn]
    ]) {
      assert.ok(txt.includes(fixedIso1), `${lbl} must preserve original UTC sampledAt`);
      assert.ok(txt.includes(head1), `${lbl} must include full HEAD OID`);
      assert.ok(txt.includes("git rev-parse HEAD"), `${lbl} must instruct comparing git rev-parse HEAD`);
    }

    // Item 10 (3-window carryover rule) & Item 11 (optional max-1 durable long-term rule at end of Section 4) in BOTH ZH & EN
    // Positive & negative framing checks + standalone (no prior handoff) framing
    assert.ok(promptZh.includes("800 字以内") && promptZh.includes("四节") && promptZh.includes("1–3 个具体动作"));
    assert.ok(promptZh.includes("上一份交接单") && promptZh.includes("硬约束") && promptZh.includes("已否决方案与理由"));
    assert.ok(promptZh.includes("移除已闭环待办") && promptZh.includes("替换旧结论") && promptZh.includes("待验证") && promptZh.includes("引用材料"));
    assert.ok(promptZh.includes("若无上轮交接材料"));
    assert.ok(promptZh.includes("现场已变更，先核对相关 diff 和未跟踪项，再继续") && promptZh.includes("未提交内容仍可能改变"));
    assert.ok(
      promptZh.includes("第四节末尾") &&
        promptZh.includes("仍保持四节") &&
        promptZh.includes("最多 1 条") &&
        promptZh.includes("仓库证据") &&
        promptZh.includes("AGENTS.md") &&
        promptZh.includes("临时路径") &&
        promptZh.includes("无候选时省略")
    );

    assert.ok(promptEn.includes("under 800 words") && promptEn.includes("four sections") && promptEn.includes("1–3 concrete next actions"));
    assert.ok(promptEn.includes("prior handoff brief") && promptEn.includes("hard constraints") && promptEn.includes("rejected approaches with their reasons"));
    assert.ok(promptEn.includes("remove completed todos") && promptEn.includes("replace the old conclusion") && promptEn.includes("To Verify") && promptEn.includes("reference material"));
    assert.ok(promptEn.includes("If no prior handoff was provided"));
    assert.ok(
      promptEn.includes("Workspace state changed: review relevant diff and untracked items before continuing") &&
        promptEn.includes("uncommitted contents may still differ")
    );
    assert.ok(
      promptEn.includes("end of Section 4") &&
        promptEn.includes("keeping four sections total") &&
        promptEn.includes("at most 1 optional line") &&
        promptEn.includes("repository evidence") &&
        promptEn.includes("AGENTS.md") &&
        promptEn.includes("temporary paths") &&
        promptEn.includes("Omit this line")
    );

    // Also verify unborn & non-git semantic prompts render exact Chinese/English markers
    const unbornPromptZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(unbornEmpty)}, "zh");`, ctx);
    const unbornPromptEn = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(unbornEmpty)}, "en");`, ctx);
    assert.ok(unbornPromptZh.includes("HEAD 尚无提交") && unbornPromptZh.includes("`0`"));
    assert.ok(unbornPromptEn.includes("HEAD No commits yet") && unbornPromptEn.includes("`0`"));
    const nonGitPromptZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(nonGitBrief)}, "zh");`, ctx);
    const nonGitPromptEn = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(nonGitBrief)}, "en");`, ctx);
    assert.ok(nonGitPromptZh.includes("HEAD 未知") && nonGitPromptZh.includes("脏条目数（`status --porcelain=v1 -b -z --untracked-files=normal`）：未知"));
    assert.ok(nonGitPromptEn.includes("HEAD Unknown") && nonGitPromptEn.includes("Dirty Entries (`status --porcelain=v1 -b -z --untracked-files=normal`): Unknown"));

    // === 11. Plan Section 4 Item 10 explicit 3-window A->B->C sample fixture + standalone first-window path (BOTH ZH & EN) ===
    const seedConv = (cid, userMsgs, taskMd) => {
      const logDir = path.join(brainRoot, cid, ".system_generated", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const lines = userMsgs.map((msg, idx) =>
        JSON.stringify({
          type: "USER_INPUT",
          step_index: idx + 1,
          created_at: `2026-11-25T12:0${idx}:00.000Z`,
          user_input: `<USER_REQUEST>${msg}</USER_REQUEST>`
        })
      );
      fs.writeFileSync(path.join(logDir, "transcript.jsonl"), lines.join("\n") + "\n", "utf8");
      fs.writeFileSync(path.join(brainRoot, cid, "task.md"), taskMd, "utf8");
    };

    // Standalone first window (no prior handoff)
    const convFirst = "conv-item10-first";
    seedConv(
      convFirst,
      ["Bootstrap handoff module without prior handoff material"],
      "- [/] Implement first-window brief\n- [ ] Add unit coverage\n"
    );
    const firstBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convFirst,
      conversationConfirmed: true,
      sessionId: convFirst,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs1
    });
    const firstZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(firstBrief)}, "zh");`, ctx);
    const firstEn = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(firstBrief)}, "en");`, ctx);
    assert.ok(firstZh.includes("800 字以内") && firstZh.includes("四节") && firstZh.includes("1–3 个具体动作") && firstZh.includes("若无上轮交接材料"));
    assert.ok(firstEn.includes("under 800 words") && firstEn.includes("four sections") && firstEn.includes("1–3 concrete next actions") && firstEn.includes("If no prior handoff was provided"));
    assert.ok(firstZh.includes("Implement first-window brief") && firstEn.includes("Implement first-window brief"));

    // Window A: leaves a hard constraint and a rejected approach with rationale + 2 todos
    const convWinA = "conv-item10-winA";
    seedConv(
      convWinA,
      [
        "Hard constraint: keep Turn-0 tool catalog unchanged (0 new MCP tools). Rejected approach: in-memory Map cache because sidecar restarts lose checkpoints."
      ],
      "- [ ] TODO_A1_PARSER: Implement porcelain -b -z status parser\n- [ ] TODO_A2_PROMPT: Add bilingual carryover instructions\n"
    );
    const winABrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convWinA,
      conversationConfirmed: true,
      sessionId: convWinA,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs1
    });
    assert.ok(winABrief.markdown.includes("keep Turn-0 tool catalog unchanged") && winABrief.markdown.includes("Rejected approach"));
    assert.equal(winABrief.anchors.nextTasks.length, 2);
    const winAZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(winABrief)}, "zh");`, ctx);
    const winAEn = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(winABrief)}, "en");`, ctx);
    assert.ok(winAZh.includes("TODO_A1_PARSER") && winAZh.includes("TODO_A2_PROMPT"));
    assert.ok(winAEn.includes("TODO_A1_PARSER") && winAEn.includes("TODO_A2_PROMPT"));

    // Window B: receives Window A handoff, completes TODO_A1_PARSER, produces new verification evidence
    const convWinB = "conv-item10-winB";
    seedConv(
      convWinB,
      [
        "Prior handoff from Window A: Hard constraint keep Turn-0 tool catalog unchanged; Rejected in-memory Map cache because restarts lose checkpoints.",
        "Completed TODO_A1_PARSER and ran node --test porcelain.test.mjs with 12 passed."
      ],
      "- [x] TODO_A1_PARSER: Implement porcelain -b -z status parser\n- [/] TODO_A2_PROMPT: Add bilingual carryover instructions\n"
    );
    store.recordModifiedFiles(convWinB, [path.join(repoDir, "a.js")], { worktree: repoDir, tool: "apply_edits" });
    store.recordVerificationResult(convWinB, {
      kind: "test",
      command: "node --test porcelain.test.mjs",
      exitCode: 0,
      passed: true,
      summary: "12 passed (porcelain parser verified)",
      worktree: repoDir
    });
    const winBBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convWinB,
      conversationConfirmed: true,
      sessionId: convWinB,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });
    assert.ok(
      winBBrief.anchors.nextTasks.some((t) => t.includes("TODO_A2_PROMPT")) &&
        !winBBrief.anchors.nextTasks.some((t) => t.includes("TODO_A1_PARSER")),
      "Item 10 Window B: completed TODO_A1_PARSER must be removed from open nextTasks while TODO_A2_PROMPT remains"
    );
    assert.ok(winBBrief.markdown.includes("12 passed (porcelain parser verified)"), "Item 10 Window B: new verification evidence must appear in brief");
    assert.equal(winBBrief.anchors.modifiedFileCount, 1, "Window B: anchors must record modifiedFileCount");
    assert.ok(
      Array.isArray(winBBrief.anchors.modifiedFiles) && winBBrief.anchors.modifiedFiles.some((f) => f.includes("a.js")),
      "Window B: anchors.modifiedFiles must include modified file"
    );
    assert.ok(
      Array.isArray(winBBrief.anchors.passingChecks) &&
        winBBrief.anchors.passingChecks.some(
          (pc) => pc.kind === "test" && pc.command === "node --test porcelain.test.mjs" && pc.summary.includes("12 passed")
        ),
      "Window B: anchors.passingChecks must carry passing verification command & summary"
    );
    const overviewNoLeak = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "app",
      conversationId: convWinB,
      conversationConfirmed: false,
      sessionId: convWinB,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });
    assert.deepEqual(overviewNoLeak.anchors.modifiedFiles, [], "Overview mode must not expose session modifiedFiles in anchors");
    assert.equal(overviewNoLeak.anchors.modifiedFileCount, 0);
    assert.deepEqual(overviewNoLeak.anchors.passingChecks, [], "Overview mode must not expose session passingChecks in anchors");
    const winBZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(winBBrief)}, "zh");`, ctx);
    const winBEn = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(winBBrief)}, "en");`, ctx);
    assert.ok(
      winBZh.includes("上一份交接单") &&
        winBZh.includes("硬约束") &&
        winBZh.includes("已否决方案与理由") &&
        winBZh.includes("合并本轮新证据") &&
        winBZh.includes("移除已闭环待办") &&
        winBZh.includes("仅输出交接单正文（不要寒暄或解释）") &&
        winBZh.includes("非目标边界") &&
        winBZh.includes("已改关键文件/符号") &&
        winBZh.includes("精确验收命令") &&
        winBZh.includes("复述计划") &&
        winBZh.includes("本轮已改文件（1 个）") &&
        winBZh.includes("a.js") &&
        winBZh.includes("测试通过") &&
        winBZh.includes("node --test porcelain.test.mjs") &&
        winBZh.includes("12 passed (porcelain parser verified)") &&
        winBZh.includes("TODO_A2_PROMPT") &&
        !winBZh.includes("TODO_A1_PARSER")
    );
    assert.ok(
      winBEn.includes("prior handoff brief") &&
        winBEn.includes("hard constraints") &&
        winBEn.includes("rejected approaches with their reasons") &&
        winBEn.includes("merge new evidence") &&
        winBEn.includes("remove completed todos") &&
        winBEn.includes("Output only the handoff brief itself") &&
        winBEn.includes("out-of-scope boundaries") &&
        winBEn.includes("key modified files/symbols") &&
        winBEn.includes("exact verification commands") &&
        winBEn.includes("restate the plan") &&
        winBEn.includes("Modified Files (1)") &&
        winBEn.includes("a.js") &&
        winBEn.includes("Test PASS") &&
        winBEn.includes("node --test porcelain.test.mjs") &&
        winBEn.includes("12 passed (porcelain parser verified)") &&
        winBEn.includes("TODO_A2_PROMPT") &&
        !winBEn.includes("TODO_A1_PARSER")
    );

    // Window C: receives Window B handoff + explicit user revision to an earlier decision & unverified conflict
    const convWinC = "conv-item10-winC";
    seedConv(
      convWinC,
      [
        "Prior handoff from Window B: keep Turn-0 tool catalog unchanged; rejected in-memory Map cache because restarts lose checkpoints; old decision used 600ms git timeout.",
        "User revision: replace the 600ms git timeout decision with a shared 1200ms git deadline because Windows git spawns need headroom."
      ],
      "- [x] TODO_A1_PARSER: Implement porcelain -b -z status parser\n- [x] TODO_A2_PROMPT: Add bilingual carryover instructions\n- [/] TODO_C1_VERIFY: Verify 1200ms git deadline on Windows\n"
    );
    const winCBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convWinC,
      conversationConfirmed: true,
      sessionId: convWinC,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });
    assert.ok(
      winCBrief.markdown.includes("replace the 600ms git timeout decision with a shared 1200ms git deadline"),
      "Item 10 Window C: brief must capture the explicit user revision"
    );
    assert.ok(
      winCBrief.anchors.nextTasks.some((t) => t.includes("TODO_C1_VERIFY")) &&
        !winCBrief.anchors.nextTasks.some((t) => t.includes("TODO_A1_PARSER") || t.includes("TODO_A2_PROMPT")),
      "Item 10 Window C: completed Window A/B todos must not remain in open nextTasks"
    );
    const winCZh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(winCBrief)}, "zh");`, ctx);
    const winCEn = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(winCBrief)}, "en");`, ctx);
    assert.ok(
      winCZh.includes("硬约束") &&
        winCZh.includes("已否决方案与理由") &&
        winCZh.includes("移除已闭环待办") &&
        winCZh.includes("用户明确更改决定时，用新决定和依据替换旧结论") &&
        winCZh.includes("待验证") &&
        winCZh.includes("引用材料") &&
        winCZh.includes("TODO_C1_VERIFY")
    );
    assert.ok(
      winCEn.includes("hard constraints") &&
        winCEn.includes("rejected approaches with their reasons") &&
        winCEn.includes("remove completed todos") &&
        winCEn.includes("When the user explicitly revises an earlier decision, replace the old conclusion with the new decision and rationale") &&
        winCEn.includes("To Verify") &&
        winCEn.includes("reference material") &&
        winCEn.includes("TODO_C1_VERIFY")
    );

    // === 12. Plan Section 4 Item 11 explicit positive & negative fixtures, Sidecar clipboard-only, zero repo writes & zero Turn-0 dynamic content ===
    // Commit existing package.json script + AGENTS.md into repoDir so positive fixture points to verifiable repo evidence
    runGit(repoDir, ["checkout", "main"]);
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "item11-fixture", scripts: { "check:schema": "node scripts/check-schema.mjs" } }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "# Project Rules\n- Existing baseline rule.\n", "utf8");
    runGit(repoDir, ["add", "package.json", "AGENTS.md"]);
    runGit(repoDir, ["commit", "-m", "add package script and AGENTS.md for item 11 fixture"]);

    const snapshotDirState = (dir) => {
      const entries = [];
      const walk = (cur) => {
        for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (ent.name === ".git") continue;
          const full = path.join(cur, ent.name);
          const rel = path.relative(dir, full).replace(/\\/g, "/");
          if (ent.isDirectory()) {
            entries.push({ rel, kind: "dir" });
            walk(full);
          } else {
            entries.push({ rel, kind: "file", content: fs.readFileSync(full, "utf8") });
          }
        }
      };
      walk(dir);
      return { entries, gitStatus: runGit(dir, ["status", "--porcelain=v1", "-uall"]) };
    };

    const repoStateBefore = snapshotDirState(repoDir);

    // Positive fixture: cross-task constraint verifiable from existing package.json script (`npm run check:schema`)
    const convItem11Pos = "conv-item11-positive";
    seedConv(
      convItem11Pos,
      [
        "Cross-task rule evidenced by package.json scripts.check:schema: always run `npm run check:schema` after schema edits; consider recording in AGENTS.md."
      ],
      "- [/] Fix schema check failure from `npm run check:schema`\n"
    );
    store.recordVerificationResult(convItem11Pos, {
      kind: "build",
      command: "npm run check:schema",
      exitCode: 1,
      passed: false,
      summary: "schema mismatch in package.json check:schema",
      failureExcerpt: "Error: schema check failed (run npm run check:schema)",
      worktree: repoDir
    });
    const item11PosBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convItem11Pos,
      conversationConfirmed: true,
      sessionId: convItem11Pos,
      cwd: repoDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });

    // Negative fixture: window-only temporary directory + one-off transient failure + current todo
    const winOnlyTmpDir = path.join(tmpDir, "window-only-scratch");
    fs.mkdirSync(winOnlyTmpDir, { recursive: true });
    const convItem11Neg = "conv-item11-negative";
    seedConv(
      convItem11Neg,
      [
        `Temporary scratch path only valid in this window: ${winOnlyTmpDir.replace(/\\/g, "/")}; one-off ETIMEDOUT hiccup.`
      ],
      "- [/] Finish one-off scratch dump in temporary dir\n"
    );
    const item11NegBrief = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convItem11Neg,
      conversationConfirmed: true,
      sessionId: convItem11Neg,
      cwd: winOnlyTmpDir,
      brainRoots: [brainRoot],
      nowFn: () => fixedTs2
    });

    // Drive BOTH positive and negative fixtures through real Sidecar VM DOM copyHandoffPrompt() in ZH and EN -> strictly clipboard-only (0 fetches)!
    for (const [fixLabel, fixConv, fixBrief] of [
      ["positive", convItem11Pos, item11PosBrief],
      ["negative", convItem11Neg, item11NegBrief]
    ]) {
      const fixCopied = [];
      const fixFetches = [];
      const fixHost = {
        conversationId: fixConv,
        ui: { toggleConversation() {} },
        fetch: async (url, opts) => {
          fixFetches.push({ url, opts });
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
      };
      const { ctx: fixCtx } = createDashboardVmSandbox({
        sidecarObj: fixHost,
        fetchImpl: fixHost.fetch,
        copiedOut: fixCopied
      });
      await new Promise((r) => setTimeout(r, 20));
      vm.runInContext(
        "cachedWatchdog = { ok: true, enabled: true, scope: 'conversation', _hostEpoch: hostSwitchEpoch, current: { conversationId: cid, phase: 'IDLE', severity: 'idle' }, sessions: [], alertingSessions: [] }; applyHandoffSnapshot(briefObj, { source: 'api', scope: 'conversation' });",
        Object.assign(fixCtx, { cid: fixConv, briefObj: fixBrief })
      );
      await vm.runInContext("setLanguage('zh', false);", fixCtx);
      fixFetches.length = 0;
      await vm.runInContext("copyHandoffPrompt();", fixCtx);
      assert.equal(fixFetches.length, 0, `Item 11 (${fixLabel} ZH): copyHandoffPrompt must be strictly clipboard-only (0 fetches)`);
      await vm.runInContext("setLanguage('en', false);", fixCtx);
      fixFetches.length = 0;
      await vm.runInContext("copyHandoffPrompt();", fixCtx);
      assert.equal(fixFetches.length, 0, `Item 11 (${fixLabel} EN): copyHandoffPrompt must be strictly clipboard-only (0 fetches)`);
      assert.equal(fixCopied.length, 2);
      const [outZh, outEn] = fixCopied;

      // ZH/EN parity on optionality, evidence, max-1, 4-section structure (combined with Item 10), exclusion of temp paths/one-off failures/todos, user-only adoption
      assert.ok(
        outZh.includes("可选") &&
          outZh.includes("第四节末尾") &&
          outZh.includes("仍保持四节") &&
          outZh.includes("最多 1 条") &&
          outZh.includes("仓库证据") &&
          outZh.includes("AGENTS.md") &&
          outZh.includes("临时路径、单次故障和当前待办留在本次交接里") &&
          outZh.includes("无候选时省略该行") &&
          outZh.includes("不要直接修改仓库文件") &&
          outZh.includes("上一份交接单"),
        `Item 11 (${fixLabel} ZH) must enforce full Item 10+11 parity`
      );
      assert.ok(
        outEn.includes("optional") &&
          outEn.includes("end of Section 4") &&
          outEn.includes("keeping four sections total") &&
          outEn.includes("at most 1 optional line") &&
          outEn.includes("repository evidence") &&
          outEn.includes("AGENTS.md") &&
          outEn.includes("Keep temporary paths, one-off failures, and current todos in this handoff only") &&
          outEn.includes("Omit this line when there is no valid candidate") &&
          outEn.includes("do not edit repository files") &&
          outEn.includes("prior handoff brief"),
        `Item 11 (${fixLabel} EN) must enforce full Item 10+11 parity`
      );
      if (fixLabel === "positive") {
        assert.ok(outZh.includes("npm run check:schema") && outEn.includes("npm run check:schema"), "Positive fixture must carry verifiable build/package script evidence");
      } else {
        assert.ok(
          outZh.includes("window-only-scratch") && outEn.includes("window-only-scratch"),
          "Negative fixture must carry the window-only temporary dir workspace anchor while excluding it from durable rules"
        );
      }
    }

    // Zero repository writes check: repoDir files & git status must be byte-for-byte identical before & after
    const repoStateAfter = snapshotDirState(repoDir);
    assert.deepEqual(repoStateAfter, repoStateBefore, "Item 11: Handoff brief generation & Sidecar clipboard copy must perform ZERO repository writes");

    // Zero Turn-0 dynamic content check: static Turn-0 prompt files & SessionStart hook output contain zero Item 10/11 handoff or session-specific dynamic text
    const agentsMd = fs.readFileSync(path.join(ROOT, "rules", "AGENTS.md"), "utf8");
    const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");
    for (const [turn0Name, turn0Text] of [
      ["rules/AGENTS.md", agentsMd],
      ["skills/agy-dart/SKILL.md", skillMd]
    ]) {
      assert.ok(!turn0Text.includes("长期规则沉淀") && !turn0Text.includes("Multi-window carryover rule"), `${turn0Name} must not inject Item 10/11 prompt rules into Turn-0`);
    }
    const ssRun1 = spawnSync(process.execPath, [path.join(ROOT, "hooks", "session-start.mjs")], {
      cwd: repoDir,
      input: JSON.stringify({ workspace_roots: [repoDir] }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(ssRun1.status, 0, `session-start.mjs failed: ${ssRun1.stderr}`);
    assert.ok(
      !ssRun1.stdout.includes("长期规则沉淀") &&
        !ssRun1.stdout.includes("Multi-window carryover rule") &&
        !ssRun1.stdout.includes(convItem11Pos) &&
        !ssRun1.stdout.includes(convWinC),
      "Item 11: SessionStart Turn-0 hook output must contain zero dynamic handoff/Item-10/11 content"
    );
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-13: Review fixes Item 1 (Git env isolation across normal + rescue snapshots), Item 8 (lazy untracked formatting cap <=10 + scale parse) & Item 9 (valid U+FFFD vs corrupted UTF-8 bytes)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-rev-git-utf8-"));
  const repoA = path.join(tmpDir, "repo-a");
  const repoB = path.join(tmpDir, "repo-b");
  const nonGitDir = path.join(tmpDir, "non-git-dir");
  const brainRoot = path.join(tmpDir, "brain");
  const tmpDb = path.join(tmpDir, "context.db");
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  fs.mkdirSync(nonGitDir, { recursive: true });

  const store = new ContextModeStore({ dbPath: tmpDb });
  const envKeysToTest = [
    "GIT_DIR",
    "git_work_tree",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SUPER_PREFIX",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_QUARANTINE_PATH",
    "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_EXTERNAL_DIFF",
    "GIT_LITERAL_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS"
  ];
  const savedEnv = new Map();
  for (const k of envKeysToTest) {
    const existingKey = Object.keys(process.env).find((ek) => ek.toUpperCase() === k.toUpperCase());
    savedEnv.set(k, existingKey ? { key: existingKey, val: process.env[existingKey] } : null);
  }

  try {
    // === Item 1: Git snapshot attribution isolation ===
    // 1a. Direct unit verification of buildGitReadOnlyEnv() stripping all 17 repo/worktree/index/object/discovery overrides case-insensitively
    const mockEnv = {
      PATH: process.env.PATH || "/usr/bin",
      SystemRoot: process.env.SystemRoot || "C:\\Windows",
      HOME: os.homedir(),
      CUSTOM_KEEP_VAR: "keep-me",
      LC_ALL: "zh_CN.UTF-8",
      LANG: "zh_CN.UTF-8",
      LANGUAGE: "zh_CN",
      LC_MESSAGES: "zh_CN.UTF-8",
      GIT_DIR: "/repoA/.git",
      Git_Work_Tree: "/repoA",
      git_index_file: "/repoA/.git/index",
      GIT_COMMON_DIR: "/repoA/.git",
      GIT_OBJECT_DIRECTORY: "/repoA/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/repoA/alt",
      GIT_SUPER_PREFIX: "sub/",
      GIT_PREFIX: "sub/",
      GIT_NAMESPACE: "ns",
      GIT_IMPLICIT_WORK_TREE: "1",
      GIT_CEILING_DIRECTORIES: "/tmp",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_QUARANTINE_PATH: "/repoA/.git/objects/incoming",
      GIT_SHALLOW_FILE: "/repoA/.git/shallow",
      GIT_GRAFT_FILE: "/repoA/.git/info/grafts",
      GIT_REPLACE_REF_BASE: "refs/replace/",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG: "/repoA/.git/config",
      git_config_parameters: "'core.excludesFile=/tmp/ignore-all'",
      GIT_CONFIG_COUNT: "1",
      git_config_key_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "/repoA",
      GIT_EXTERNAL_DIFF: "/bin/false",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_GLOB_PATHSPECS: "1",
      GIT_NOGLOB_PATHSPECS: "1",
      GIT_ICASE_PATHSPECS: "1"
    };
    const sanitizedEnv = buildGitReadOnlyEnv(mockEnv);
    for (const k of envKeysToTest) {
      const leaked = Object.keys(sanitizedEnv).find((sk) => sk.toUpperCase() === k.toUpperCase());
      assert.equal(leaked, undefined, `Item 1: buildGitReadOnlyEnv must strip ${k}`);
    }
    assert.equal(sanitizedEnv.LC_ALL, "C");
    assert.equal(sanitizedEnv.LANG, "C");
    assert.equal(sanitizedEnv.LANGUAGE, "C");
    assert.equal(sanitizedEnv.CUSTOM_KEEP_VAR, "keep-me");
    assert.equal(sanitizedEnv.HOME, os.homedir());

    // 1b. Two controlled independent Git repos (A with 16 dirty entries, B with 2 dirty entries) + non-Git dir
    runGit(repoA, ["init"]);
    runGit(repoA, ["checkout", "-b", "branch-repo-a"]);
    fs.writeFileSync(path.join(repoA, "a-only.js"), "export const repo = 'A';\n", "utf8");
    runGit(repoA, ["add", "."]);
    runGit(repoA, ["commit", "-m", "COMMIT_FROM_REPO_A"]);
    const headA = runGit(repoA, ["rev-parse", "HEAD"]).trim();
    for (let i = 0; i < 16; i++) {
      fs.writeFileSync(path.join(repoA, `dirty-a-${i}.txt`), `a=${i}\n`, "utf8");
    }

    runGit(repoB, ["init"]);
    runGit(repoB, ["checkout", "-b", "feat/repo-b"]);
    fs.writeFileSync(path.join(repoB, "b-only.js"), "export const repo = 'B';\n", "utf8");
    runGit(repoB, ["add", "."]);
    runGit(repoB, ["commit", "-m", "COMMIT_FROM_REPO_B"]);
    const headB = runGit(repoB, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(headA, headB);
    fs.writeFileSync(path.join(repoB, "b-only.js"), "export const repo = 'B-modified';\n", "utf8");
    fs.writeFileSync(path.join(repoB, "b-untracked.txt"), "new-b\n", "utf8");

    // Pollute process.env with repoA pointers + parent `git -c` config propagation overrides (including mixed-case Windows keys!)
    const ignoreAllFile = path.join(tmpDir, "ignore-all-excludes");
    fs.writeFileSync(ignoreAllFile, "*\n", "utf8");
    process.env.GIT_DIR = path.join(repoA, ".git");
    process.env.git_work_tree = repoA;
    process.env.GIT_INDEX_FILE = path.join(repoA, ".git", "index");
    process.env.GIT_COMMON_DIR = path.join(repoA, ".git");
    process.env.GIT_OBJECT_DIRECTORY = path.join(repoA, ".git", "objects");
    process.env.GIT_CEILING_DIRECTORIES = tmpDir;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
    process.env.GIT_CONFIG_VALUE_0 = ignoreAllFile;
    process.env.GIT_CONFIG_PARAMETERS = `'core.excludesFile=${ignoreAllFile.replace(/\\/g, "/")}'`;

    const fixedNow = Math.max(Date.parse("2026-11-25T15:00:00.000Z"), Date.now() + 3_600_000);
    const convB = "conv-item1-repo-b";
    const convNonGit = "conv-item1-nongit";

    // Normal brief for repoB under polluted process.env
    const briefB = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convB,
      conversationConfirmed: true,
      sessionId: convB,
      cwd: repoB,
      nowFn: () => fixedNow
    });
    assert.equal(briefB.anchors.branch, "feat/repo-b", "Item 1: repoB brief must report repoB branch");
    assert.equal(briefB.anchors.gitHeadStatus, "commit");
    assert.equal(briefB.anchors.gitHead, headB, "Item 1: repoB brief must report repoB HEAD, not inherited repoA HEAD");
    assert.equal(briefB.anchors.gitDirtyEntries, 2, "Item 1: repoB brief must report repoB dirty count (2), not repoA (16)");
    assert.ok(briefB.markdown.includes("COMMIT_FROM_REPO_B") && briefB.markdown.includes("b-untracked.txt"));
    assert.ok(!briefB.markdown.includes(headA) && !briefB.markdown.includes("COMMIT_FROM_REPO_A"), "Item 1: repoA must not leak into repoB brief");

    // Normal brief for nonGitDir under polluted process.env
    const briefNonGit = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convNonGit,
      conversationConfirmed: true,
      sessionId: convNonGit,
      cwd: nonGitDir,
      nowFn: () => fixedNow
    });
    assert.equal(briefNonGit.anchors.gitHeadStatus, "unknown", "Item 1: non-Git dir must report unknown HEAD under polluted env");
    assert.equal(briefNonGit.anchors.gitHead, "");
    assert.equal(briefNonGit.anchors.gitDirtyEntries, null, "Item 1: non-Git dir must report null (Unknown) dirty entries, not repoA's 16");
    assert.ok(briefNonGit.markdown.includes("Unknown / 未知"));
    assert.ok(!briefNonGit.markdown.includes(headA) && !briefNonGit.markdown.includes("COMMIT_FROM_REPO_A") && !briefNonGit.markdown.includes("## Git Workspace"));

    // Watchdog rescue snapshots for both repoB and nonGitDir under the same polluted process.env
    for (const [cid, dir] of [
      [convB, repoB],
      [convNonGit, nonGitDir]
    ]) {
      const txDir = path.join(brainRoot, cid, ".system_generated", "logs");
      fs.mkdirSync(txDir, { recursive: true });
      const txFile = path.join(txDir, "transcript.jsonl");
      fs.writeFileSync(
        txFile,
        JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: `<USER_REQUEST>Rescue ${cid}</USER_REQUEST>` }) + "\n",
        "utf8"
      );
      const oldSec = (fixedNow - 1_200_000) / 1000;
      fs.utimesSync(txFile, oldSec, oldSec);
      recordHookLeaseTransition(
        store,
        "PreInvocation",
        { conversationId: cid, cwd: dir, lastUserInput: `Rescue ${cid}`, transcriptPath: txFile },
        { nowMs: fixedNow - 950_000, model: "claude-opus-4-6", contextTokens: 120000 }
      );
    }
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      brainRoots: [brainRoot],
      findTranscriptFn: () => null,
      notifyFn: () => {},
      nowFn: () => fixedNow,
      monoNsFn: () => 4_000_000_000_000n
    });
    const wdB = monitor.getStatus({ conversationId: convB, scope: "conversation", refresh: true, includeRichRescue: true });
    assert.equal(wdB.current?.rescueBrief?.anchors?.gitHead, headB, "Item 1: Watchdog rescue for repoB must use repoB HEAD");
    assert.equal(wdB.current?.rescueBrief?.anchors?.gitDirtyEntries, 2, "Item 1: Watchdog rescue for repoB must use repoB dirty count");
    assert.ok(!wdB.current?.rescueBrief?.markdown?.includes(headA), "Item 1: Watchdog rescue for repoB must not leak repoA");

    const wdNonGit = monitor.getStatus({ conversationId: convNonGit, scope: "conversation", refresh: true, includeRichRescue: true });
    assert.equal(wdNonGit.current?.rescueBrief?.anchors?.gitHeadStatus, "unknown", "Item 1: Watchdog rescue for non-Git dir must report unknown HEAD");
    assert.equal(wdNonGit.current?.rescueBrief?.anchors?.gitDirtyEntries, null, "Item 1: Watchdog rescue for non-Git dir must report unknown dirty count");
    assert.ok(!wdNonGit.current?.rescueBrief?.markdown?.includes(headA), "Item 1: Watchdog rescue for non-Git dir must not leak repoA");

    // === Item 8: Lazy redaction/formatting for large untracked counts ===
    const secretInName = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
    for (const totalUntracked of [1200, 12000]) {
      const parts = ["## main", " M tracked.js"];
      for (let i = 0; i < totalUntracked; i++) {
        const suffix = i === 2 ? `-${secretInName}` : i === 500 ? `-${secretInName}` : "";
        parts.push(`?? untracked_${String(i).padStart(5, "0")}${suffix}.txt`);
      }
      const porcelainStdout = parts.join("\0") + "\0";

      let formatCalls = 0;
      const parsedSpy = parseStatusPorcelainBZ(porcelainStdout, {
        formatUntrackedPath: (p) => {
          formatCalls += 1;
          return p.replace(/\\/g, "/");
        }
      });
      assert.equal(parsedSpy.isComplete, true);
      assert.equal(parsedSpy.dirtyEntryCount, totalUntracked + 1);
      assert.equal(parsedSpy.untrackedTotalCount, totalUntracked);
      assert.ok(parsedSpy.untracked.length > 0 && parsedSpy.untracked.length <= 10);
      assert.ok(
        formatCalls <= 10,
        `Item 8 (${totalUntracked} untracked): formatUntrackedPath must be invoked <= 10 times, got ${formatCalls}`
      );
      assert.equal(parsedSpy.untracked[0], "untracked_00000.txt");
      assert.equal(parsedSpy.untracked[1], "untracked_00001.txt");

      // Default formatter redacts secrets in displayed first 10 items
      const parsedDefault = parseStatusPorcelainBZ(porcelainStdout);
      assert.equal(parsedDefault.isComplete, true);
      assert.equal(parsedDefault.untrackedTotalCount, totalUntracked);
      assert.ok(parsedDefault.untracked.some((u) => u.includes("[REDACTED:")));
      assert.ok(!parsedDefault.untracked.join("\n").includes(secretInName));

      // Real buildHandoffBrief() with immediately-returning synthetic Git output completes within 1200 ms budget & still retrieves HEAD!
      const scaleBrief = buildHandoffBrief({
        store,
        mode: "agent",
        scope: "conversation",
        conversationId: convB,
        conversationConfirmed: true,
        sessionId: convB,
        cwd: repoB,
        nowFn: () => fixedNow,
        gitExecFn: (args) => {
          if (args.includes("status")) return { status: 0, stdout: porcelainStdout, stderr: "" };
          if (args.includes("diff")) return { status: 0, stdout: " tracked.js | 1 +\n 1 file changed, 1 insertion(+)\n", stderr: "" };
          if (args.includes("log")) return { status: 0, stdout: `${headB}\tCOMMIT_FROM_REPO_B\n`, stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
      });
      assert.equal(scaleBrief.gitTimedOut, false, `Item 8 (${totalUntracked}): must not time out Git budget`);
      assert.equal(scaleBrief.anchors.gitHeadStatus, "commit", `Item 8 (${totalUntracked}): must still fetch HEAD`);
      assert.equal(scaleBrief.anchors.gitHead, headB);
      assert.equal(scaleBrief.anchors.gitDirtyEntries, totalUntracked + 1);
      assert.ok(scaleBrief.markdown.includes(`Untracked (${totalUntracked})`));
      assert.ok(!scaleBrief.markdown.includes(secretInName));
    }

    // Item 8: 400 B display byte budget cap stops formatting early (<10 calls) AND malformed tail after 1200 valid items still marks isComplete=false
    {
      const longParts = ["## main"];
      for (let i = 0; i < 1200; i++) {
        longParts.push(`?? ${"deep_segment_".repeat(10)}${i}.txt`);
      }
      longParts.push("CORRUPT_TAIL_TOKEN");
      let longCalls = 0;
      const badParsed = parseStatusPorcelainBZ(longParts.join("\0") + "\0", {
        formatUntrackedPath: (p) => {
          longCalls += 1;
          return p;
        }
      });
      assert.equal(badParsed.isComplete, false, "Item 8: malformed token after 1200 untracked paths must mark isComplete=false");
      assert.ok(longCalls <= 10 && longCalls <= 4, `Item 8: 400 B cap must stop formatting early, got ${longCalls}`);
      assert.equal(badParsed.untrackedTotalCount, 1200);

      const missingNul = parseStatusPorcelainBZ("## main\0?? a.txt\0?? b.txt");
      assert.equal(missingNul.isComplete, false, "Item 8: missing trailing NUL must stay incomplete");
    }

    // === Item 9: Valid UTF-8 U+FFFD (EF BF BD) vs corrupted/split UTF-8 bytes in >220 KiB transcripts ===
    const brainUfffd = path.join(tmpDir, "brain-ufffd");
    const convCorrupt = "conv-item9-corrupt-utf8";
    const convValidFffd = "conv-item9-valid-ufffd";
    const origReadSync = fs.readSync;
    const spyReadTranscript = (filePath) => {
      let physicalBytes = 0;
      const calls = [];
      fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
        const n = origReadSync.call(fs, fd, buffer, offset, length, position);
        if (n > 0) {
          physicalBytes += n;
          calls.push({ length, position, n });
        }
        return n;
      };
      try {
        const res = readTranscriptHeadTailFixed(filePath);
        return { res, physicalBytes, calls };
      } finally {
        fs.readSync = origReadSync;
      }
    };

    const headBuf = Buffer.from(
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>HEAD_ITEM9</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    const midBuf = Buffer.from(
      JSON.stringify({ type: "TOOL_RESULT", step_index: 2, content: "M".repeat(95 * 1024) }) + "\n",
      "utf8"
    );
    const padShellBytes = Buffer.byteLength(JSON.stringify({ type: "TOOL_RESULT", step_index: 99, content: "" }) + "\n", "utf8");

    // Fixture A (corrupted UTF-8 bytes inside `{...}` line aligned at tailOffset, tested FIRST to also verify reusable fatal TextDecoder resets cleanly)
    const corruptDir = path.join(brainUfffd, convCorrupt, ".system_generated", "logs");
    fs.mkdirSync(corruptDir, { recursive: true });
    const corruptTxPath = path.join(corruptDir, "transcript.jsonl");
    const corruptFirstLineBuf = Buffer.concat([
      Buffer.from('{"type":"USER_INPUT","step_index":50,"user_input":"<USER_REQUEST>CORRUPT_MUST_DROP ', "utf8"),
      Buffer.from([0xe4, 0xb8, 0x80, 0x20, 0xe4, 0xb8, 0x80]), // valid "一 一" followed by invalid truncated 2-byte prefix + lone 0x80 + 0xFF
      Buffer.from([0xe4, 0xb8, 0x20, 0x80, 0xff]),
      Buffer.from('</USER_REQUEST>"}\n', "utf8")
    ]);
    const nextAfterCorruptBuf = Buffer.from(
      JSON.stringify({ type: "USER_INPUT", step_index: 51, user_input: "<USER_REQUEST>CLEAN_NEXT_AFTER_CORRUPT</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    const corruptTailPadLen = 131072 - corruptFirstLineBuf.length - nextAfterCorruptBuf.length - padShellBytes;
    const corruptTailPadBuf = Buffer.from(
      JSON.stringify({ type: "TOOL_RESULT", step_index: 99, content: "C".repeat(corruptTailPadLen) }) + "\n",
      "utf8"
    );
    fs.writeFileSync(corruptTxPath, Buffer.concat([headBuf, midBuf, corruptFirstLineBuf, nextAfterCorruptBuf, corruptTailPadBuf]));

    const mCorrupt = spyReadTranscript(corruptTxPath);
    assert.equal(mCorrupt.res.overlapped, false);
    assert.equal(mCorrupt.res.headBytesRead, 65536);
    assert.equal(mCorrupt.res.tailBytesRead, 131072);
    assert.equal(mCorrupt.physicalBytes, 196608, "Item 9 (corrupt): physical fs.readSync bytes must be strictly 196608");
    assert.equal(mCorrupt.calls.length, 2, "Item 9 (corrupt): strictly 2 readSync windows");
    assert.ok(
      JSON.stringify(mCorrupt.res.tailSteps[0]).includes("CLEAN_NEXT_AFTER_CORRUPT"),
      "Item 9 (corrupt): corrupted UTF-8 first tail line must be discarded cleanly"
    );
    assert.ok(
      !JSON.stringify(mCorrupt.res.tailSteps).includes("CORRUPT_MUST_DROP") &&
        !JSON.stringify(mCorrupt.res.tailSteps).includes("\uFFFD"),
      "Item 9 (corrupt): discarded corrupted bytes must not introduce U+FFFD or leaked line"
    );

    // Fixture B (legitimate UTF-8 U+FFFD = 0xEF 0xBF 0xBD aligned EXACTLY at tailOffset)
    const validDir = path.join(brainUfffd, convValidFffd, ".system_generated", "logs");
    fs.mkdirSync(validDir, { recursive: true });
    const validTxPath = path.join(validDir, "transcript.jsonl");
    const validFirstLineBuf = Buffer.concat([
      Buffer.from('{"type":"USER_INPUT","step_index":50,"user_input":"<USER_REQUEST>讨论合法替换字符 ', "utf8"),
      Buffer.from([0xef, 0xbf, 0xbd]),
      Buffer.from(' 的解码边界</USER_REQUEST>"}\n', "utf8")
    ]);
    assert.ok(validFirstLineBuf.includes(Buffer.from([0xef, 0xbf, 0xbd])), "Fixture B raw bytes must contain literal UTF-8 EF BF BD");
    const validTailPadLen = 131072 - validFirstLineBuf.length - padShellBytes;
    const validTailPadBuf = Buffer.from(
      JSON.stringify({ type: "TOOL_RESULT", step_index: 99, content: "V".repeat(validTailPadLen) }) + "\n",
      "utf8"
    );
    fs.writeFileSync(validTxPath, Buffer.concat([headBuf, midBuf, validFirstLineBuf, validTailPadBuf]));

    const mValid = spyReadTranscript(validTxPath);
    assert.equal(mValid.res.overlapped, false);
    assert.equal(mValid.res.headBytesRead, 65536);
    assert.equal(mValid.res.tailBytesRead, 131072);
    assert.equal(mValid.physicalBytes, 196608, "Item 9 (valid U+FFFD): physical fs.readSync bytes must be strictly 196608");
    assert.equal(mValid.calls.length, 2, "Item 9 (valid U+FFFD): strictly 2 readSync windows");
    assert.ok(mValid.res.tailSteps.length >= 1, "Item 9 (valid U+FFFD): valid aligned record must not be dropped");
    assert.ok(
      String(mValid.res.tailSteps[0]?.user_input || "").includes("讨论合法替换字符 \uFFFD 的解码边界"),
      `Item 9 (valid U+FFFD): tailSteps[0] must preserve legitimate U+FFFD, got: ${JSON.stringify(mValid.res.tailSteps[0])}`
    );

    const briefValidFffd = buildHandoffBrief({
      store,
      mode: "agent",
      scope: "conversation",
      conversationId: convValidFffd,
      conversationConfirmed: true,
      sessionId: convValidFffd,
      brainRoots: [brainUfffd]
    });
    assert.ok(
      briefValidFffd.markdown.includes("讨论合法替换字符 \uFFFD 的解码边界"),
      "Item 9: Handoff brief user intent must preserve legitimate user-typed U+FFFD"
    );

    // Item 9: truncateUtf8Safe cuts strictly on UTF-8 code-point boundaries without stripping legitimate trailing U+FFFD
    assert.equal(truncateUtf8Safe("abc\uFFFDxyz", 6), "abc\uFFFD", "truncateUtf8Safe must preserve legitimate U+FFFD at exact byte boundary");
    assert.equal(truncateUtf8Safe("abc\uFFFDxyz", 5), "abc", "truncateUtf8Safe must back up cleanly when cutting inside EF BF BD");
    assert.equal(truncateUtf8Safe("abc\uFFFDxyz", 4), "abc", "truncateUtf8Safe must back up cleanly right after 0xEF lead byte");
    assert.equal(truncateUtf8Safe("a\uFFFD\uFFFDz", 5), "a\uFFFD", "truncateUtf8Safe must keep first valid U+FFFD when cutting inside second U+FFFD");
    assert.equal(truncateTailUtf8Safe("xyz\uFFFDabc", 6), "\uFFFDabc", "filter-rules truncateTailUtf8Safe must preserve leading valid U+FFFD");
    const exFffdPrefix = "Error: valid char ";
    const exFffdFiller = 497 - Buffer.byteLength(exFffdPrefix, "utf8") - 3;
    const exFffd = extractFailureExcerpt(`${exFffdPrefix}${"a".repeat(exFffdFiller)}\uFFFDEXTRA_OVERFLOW`, { maxBytes: 500 });
    assert.ok(exFffd.endsWith("\uFFFD...") && Buffer.byteLength(exFffd, "utf8") === 500, `extractFailureExcerpt must preserve legitimate U+FFFD at exact truncation boundary, got ${JSON.stringify(exFffd.slice(-16))}`);
    store.recordVerificationResult("conv-item9-cp-ufffd", {
      kind: "test",
      command: "npm test",
      exitCode: 1,
      passed: false,
      summary: "fail",
      failureExcerpt: `Error: ${"b".repeat(490)}\uFFFDTAIL_CUT`,
      worktree: repoB
    });
    const cpFffd = store.getSessionCheckpoint("conv-item9-cp-ufffd");
    assert.ok(
      cpFffd?.lastTest?.failureExcerpt?.endsWith("\uFFFD") && Buffer.byteLength(cpFffd.lastTest.failureExcerpt, "utf8") === 500,
      "checkpoints.js must preserve legitimate U+FFFD at exact 500 B boundary"
    );
    for (let cap = 0; cap <= 16; cap++) {
      const s = truncateUtf8Safe("中文🚀测试", cap);
      assert.ok(Buffer.byteLength(s, "utf8") <= cap);
      assert.equal(s.includes("\uFFFD"), false, `truncateUtf8Safe must never synthesize U+FFFD at cap=${cap}`);
      assert.equal(hasLoneSurrogate(s), false, `truncateUtf8Safe must never emit lone surrogate at cap=${cap}`);
    }
  } finally {
    // Always restore process.env cleanly
    for (const [k, prev] of savedEnv.entries()) {
      for (const curKey of Object.keys(process.env)) {
        if (curKey.toUpperCase() === k.toUpperCase()) {
          delete process.env[curKey];
        }
      }
      if (prev) {
        process.env[prev.key] = prev.val;
      }
    }
    try { store.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-14: Review fixes Item 2 (unbound panel overview copy), Item 3 (app/lifetime session confirmation) & Item 4 (inferred session clickable entry within 8-item cap)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-rev-ui-"));
  const brainRoot = path.join(tmpDir, "brain");
  const tmpDb = path.join(tmpDir, "context.db");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;

  const seedConv = (cid, quote, taskText) => {
    const logDir = path.join(brainRoot, cid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: `<USER_REQUEST>${quote}</USER_REQUEST>` }) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(brainRoot, cid, "task.md"), `- [/] ${taskText}\n`, "utf8");
  };

  const convReal = "conv-item2-real";
  const convOtherStalled = "conv-item2-other-stalled";
  const convAggTarget = "conv-item3-agg-target";
  const convAggNative = "conv-item3-agg-native";
  const convInferredTarget = "conv-item4-inferred-target";

  seedConv(convReal, "QUOTE_ITEM2_REAL", "TASK_ITEM2_REAL");
  seedConv(convOtherStalled, "QUOTE_OTHER_STALLED", "TASK_OTHER_STALLED");
  seedConv(convAggTarget, "QUOTE_ITEM3_AGG_TARGET", "TASK_ITEM3_AGG_TARGET");
  seedConv(convAggNative, "QUOTE_ITEM3_AGG_NATIVE", "TASK_ITEM3_AGG_NATIVE");
  seedConv(convInferredTarget, "QUOTE_ITEM4_INFERRED", "TASK_ITEM4_INFERRED");

  let srv = null;
  try {
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.recordModifiedFiles(convReal, [path.join(tmpDir, "real.js")], { worktree: tmpDir, tool: "apply_edits" });
    store.recordModifiedFiles(convAggTarget, [path.join(tmpDir, "agg.js")], { worktree: tmpDir, tool: "apply_edits" });
    store.recordModifiedFiles(convAggNative, [path.join(tmpDir, "native.js")], { worktree: tmpDir, tool: "apply_edits" });
    store.close();

    process.env.AGY_DART_DB_PATH = tmpDb;
    closeRuntimeStore();
    const token = "v173-rev-ui-csrf-token-0123456789abcdef";
    srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        brainRoots: [brainRoot],
        findTranscriptFn: () => null,
        notifyFn: () => {},
        focusWindowFn: () => ({ dispatched: false, platform: process.platform })
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const authHeaders = { "X-Agy-Dart-Token": token };
    const waitForHandoffSettled = async (ctx, timeoutOrOpts = 4000) => {
      const opts = typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : (timeoutOrOpts || {});
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;
      const nowFn = typeof opts.nowFn === "function" ? opts.nowFn : Date.now;
      const sleepFn =
        typeof opts.sleepFn === "function" ? opts.sleepFn : (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = nowFn() + timeoutMs;
      while (nowFn() < deadline) {
        const busy = vm.runInContext(
          "Boolean(handoffLoading || handoffInFlightRequest || autoRefreshInFlight);",
          ctx
        );
        if (!busy) {
          await sleepFn(20);
          const stillBusy = vm.runInContext(
            "Boolean(handoffLoading || handoffInFlightRequest || autoRefreshInFlight);",
            ctx
          );
          if (!stillBusy) return;
        }
        await sleepFn(20);
      }
      const state = vm.runInContext(
        "({ scope: currentScope, handoffLoading: Boolean(handoffLoading), inFlight: Boolean(handoffInFlightRequest), autoRefresh: Boolean(autoRefreshInFlight) })",
        ctx
      );
      if (!(state.handoffLoading || state.inFlight || state.autoRefresh)) {
        return;
      }
      throw new Error(
        `waitForHandoffSettled timed out after ${timeoutMs}ms` +
          ` (scope=${opts.scope || state.scope}, scenario=${opts.scenario || "v1.7.3-14"},` +
          ` handoffLoading=${state.handoffLoading}, inFlight=${state.inFlight}, autoRefresh=${state.autoRefresh})`
      );
    };

    // === Item 2: ?conversationId=__unbound__ (and reserved/unsafe IDs) overview preview + Fact Copy enabled + Semantic Copy disabled + Watchdog poll stability + real conv switch ===
    {
      const copied = [];
      const hoReqs = [];
      const { ctx, elements } = createDashboardVmSandbox({
        initialSearch: "?conversationId=__unbound__",
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") {
            hoReqs.push(body);
          }
          const res = await httpJsonRequest(port, url, {
            method: opts.method || "POST",
            headers: authHeaders,
            body
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });

      assert.equal(vm.runInContext("getConfirmedConversationId();", ctx), "", "Item 2: __unbound__ must not be treated as confirmed conversation");
      assert.equal(vm.runInContext("isCurrentConversationConfirmed();", ctx), false);
      assert.equal(vm.runInContext("isSpecificConversationId('__unbound__');", ctx), false);
      assert.equal(vm.runInContext("isSpecificConversationId('../escape');", ctx), false);
      assert.equal(vm.runInContext("isSpecificConversationId('unknown');", ctx), false);
      assert.equal(vm.runInContext("isSpecificConversationId('conv-valid_1.2');", ctx), true);

      // Inject an unrelated stalled Watchdog alert -> must NOT align with __unbound__!
      const wdForeignStall = {
        ok: true,
        enabled: true,
        scope: "conversation",
        current: {
          conversationId: convOtherStalled,
          phase: "TOOL_RUNNING",
          severity: "stalled",
          rawSeverity: "stalled",
          incidentKey: "inc-foreign-stalled",
          silentSec: 200,
          rescueBrief: {
            mode: "agent",
            confirmedConversation: true,
            conversationId: convOtherStalled,
            incidentKey: "inc-foreign-stalled",
            markdown: "# FOREIGN_STALL_BRIEF_MUST_NOT_SHOW",
            anchors: { confirmed: true, conversationId: convOtherStalled }
          }
        },
        sessions: [
          { conversationId: convReal, workspaceLabel: "ws-real", convTitle: "Real Chat", phase: "IDLE", severity: "idle", isSubagent: false }
        ],
        alertingSessions: []
      };
      vm.runInContext("renderWatchdogCard(wdForeign);", Object.assign(ctx, { wdForeign: wdForeignStall }));
      assert.equal(
        vm.runInContext("isWatchdogIncidentAlignedWithTarget({ requireActive: false });", ctx),
        false,
        "Item 2: __unbound__ must not align with unrelated Watchdog incident"
      );

      // Open handoff drawer -> unconfirmed request -> overview returned -> Fact Copy enabled, Semantic Copy disabled
      vm.runInContext("toggleHandoffDrawer(true);", ctx);
      await waitForHandoffSettled(ctx);
      assert.ok(hoReqs.length >= 1);
      assert.equal(hoReqs[0].conversationConfirmed, false, "Item 2: __unbound__ drawer must send conversationConfirmed=false");
      assert.equal(hoReqs[0].scope, "conversation");
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("# agy-dart Handoff Brief"));
      assert.ok(!elements.get("kv-handoff-preview").textContent.includes("FOREIGN_STALL_BRIEF_MUST_NOT_SHOW"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false, "Item 2: Fact Copy button must be enabled for __unbound__ overview");
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, "Item 2: Semantic Prompt Copy must remain disabled for __unbound__ overview");

      await vm.runInContext("copyHandoffBrief();", ctx);
      await vm.runInContext("copyHandoffPrompt();", ctx);
      assert.equal(copied.length, 1, "Item 2: Fact Copy must succeed while Semantic Prompt Copy does nothing");
      assert.ok(copied[0].includes("# agy-dart Handoff Brief"));

      // Next Watchdog poll with active foreign stall -> overview MUST stay current (no refetch, Fact Copy stays enabled!)
      const reqCountBeforePoll = hoReqs.length;
      vm.runInContext("renderWatchdogCard(wdForeign2);", Object.assign(ctx, { wdForeign2: { ...wdForeignStall } }));
      await waitForHandoffSettled(ctx);
      assert.equal(hoReqs.length, reqCountBeforePoll, "Item 2: Next Watchdog poll must NOT invalidate or refetch __unbound__ overview");
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false, "Item 2: Fact Copy must remain enabled after next Watchdog poll");
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, "Item 2: Semantic Prompt Copy must remain disabled after poll");

      // User clicks a real conversation -> switches cleanly to confirmed rich brief + enables BOTH copy buttons!
      await vm.runInContext(`jumpToConversation(${JSON.stringify(convReal)});`, ctx);
      await waitForHandoffSettled(ctx);
      const lastHo = hoReqs[hoReqs.length - 1];
      assert.equal(lastHo.scope, "conversation");
      assert.equal(lastHo.conversationId, convReal);
      assert.equal(lastHo.conversationConfirmed, true);
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("QUOTE_ITEM2_REAL"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
      copied.length = 0;
      await vm.runInContext("copyHandoffBrief();", ctx);
      await vm.runInContext("copyHandoffPrompt();", ctx);
      assert.equal(copied.length, 2);
      assert.ok(copied[0].includes("QUOTE_ITEM2_REAL"));
      assert.ok(copied[1].includes("TASK_ITEM2_REAL"));
    }

    // Also verify reserved (`unknown`) & unsafe (`../evil`) query params never confirm
    for (const badSearch of ["?conversationId=unknown", "?conversationId=../evil"]) {
      const { ctx } = createDashboardVmSandbox({ initialSearch: badSearch });
      assert.equal(vm.runInContext("getConfirmedConversationId();", ctx), "", `Item 2: ${badSearch} must not confirm`);
      assert.equal(vm.runInContext("isCurrentConversationConfirmed();", ctx), false);
    }

    // === Item 3: Aggregate overview (`app` & `lifetime`) session confirmation + preserved aggregate Watchdog actions ===
    for (const aggScope of ["app", "lifetime"]) {
      // 3a. Standalone/general: click suggested session convAggTarget from app/lifetime overview
      const copied = [];
      const hoReqs = [];
      const wdActionReqs = [];
      const { ctx, elements } = createDashboardVmSandbox({
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") {
            hoReqs.push(body);
          } else if (url === "/api/watchdog/action") {
            wdActionReqs.push(body);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                status: {
                  ok: true,
                  enabled: true,
                  scope: body.scope,
                  current: { conversationId: body.conversationId || convAggTarget, phase: "IDLE", severity: "idle" },
                  sessions: [
                    { conversationId: convAggTarget, workspaceLabel: "ws-agg", convTitle: "Agg Target", phase: "IDLE", severity: "idle", isSubagent: false }
                  ],
                  alertingSessions: []
                }
              })
            };
          } else if (url === "/api/watchdog") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                enabled: true,
                scope: body.scope,
                current: {
                  conversationId: convOtherStalled,
                  phase: "TOOL_RUNNING",
                  severity: "stalled",
                  rawSeverity: "stalled",
                  incidentKey: `inc-${aggScope}-stall`,
                  silentSec: 180
                },
                sessions: [
                  { conversationId: convAggTarget, workspaceLabel: "ws-agg", convTitle: "Agg Target", phase: "IDLE", severity: "idle", isSubagent: false }
                ],
                alertingSessions: []
              })
            };
          }
          const res = await httpJsonRequest(port, url, {
            method: opts.method || "POST",
            headers: authHeaders,
            body
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });

      vm.runInContext(`setScope(${JSON.stringify(aggScope)}); toggleHandoffDrawer(true);`, ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("currentScope;", ctx), aggScope);
      assert.equal(hoReqs[hoReqs.length - 1].scope, aggScope);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

      // Existing aggregate Watchdog snooze & clear actions MUST stay in aggScope!
      await vm.runInContext("snoozeWatchdogAlert();", ctx);
      assert.equal(wdActionReqs[wdActionReqs.length - 1].action, "ack");
      assert.equal(wdActionReqs[wdActionReqs.length - 1].scope, aggScope, `Item 3 (${aggScope}): snooze must preserve aggregate scope`);
      assert.equal(vm.runInContext("currentScope;", ctx), aggScope);

      // Re-seed active stalled incident under aggScope, then verify clear action also preserves aggScope
      vm.runInContext(
        `renderWatchdogCard({ ok: true, enabled: true, scope: ${JSON.stringify(aggScope)}, _hostEpoch: hostSwitchEpoch, current: { conversationId: ${JSON.stringify(convOtherStalled)}, phase: 'TOOL_RUNNING', severity: 'stalled', rawSeverity: 'stalled', incidentKey: 'inc-clear-${aggScope}' }, sessions: [{ conversationId: ${JSON.stringify(convAggTarget)}, workspaceLabel: 'ws-agg', convTitle: 'Agg Target', phase: 'IDLE', severity: 'idle', isSubagent: false }], alertingSessions: [] });`,
        ctx
      );
      await vm.runInContext("markWatchdogIdle();", ctx);
      assert.equal(wdActionReqs[wdActionReqs.length - 1].action, "clear");
      assert.equal(wdActionReqs[wdActionReqs.length - 1].scope, aggScope, `Item 3 (${aggScope}): clear must preserve aggregate scope`);
      assert.equal(vm.runInContext("currentScope;", ctx), aggScope);

      // Single click on suggested session in aggregate overview -> switches to conversation scope + fetches & enables Fact + Semantic Copy!
      hoReqs.length = 0;
      wdActionReqs.length = 0;
      await vm.runInContext(`jumpToConversation(${JSON.stringify(convAggTarget)});`, ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("currentScope;", ctx), "conversation", `Item 3 (${aggScope}): clicking suggested session must switch scope to conversation`);
      assert.equal(elements.get("scope-conv-btn").className, "seg-btn is-active");
      const focusCall = wdActionReqs.find((r) => r.action === "focusConversation");
      assert.ok(focusCall && focusCall.scope === "conversation" && focusCall.conversationId === convAggTarget && focusCall.conversationConfirmed === true);
      assert.ok(
        hoReqs.some((r) => r.scope === "conversation" && r.conversationId === convAggTarget && r.conversationConfirmed === true),
        `Item 3 (${aggScope}): single click must fetch confirmed conversation brief for ${convAggTarget}, got ${JSON.stringify(hoReqs)}`
      );
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("QUOTE_ITEM3_AGG_TARGET"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
      copied.length = 0;
      await vm.runInContext("copyHandoffBrief();", ctx);
      await vm.runInContext("copyHandoffPrompt();", ctx);
      assert.equal(copied.length, 2);
      assert.ok(copied[0].includes("QUOTE_ITEM3_AGG_TARGET"));
      assert.ok(copied[1].includes("TASK_ITEM3_AGG_TARGET"));

      // 3b. Native host bound to convAggNative, switched to aggScope, clicks SAME convAggNative pill -> still confirms & reloads in one click!
      const nativeCopied = [];
      const nativeHoReqs = [];
      const { ctx: nCtx, elements: nEl } = createDashboardVmSandbox({
        initialSearch: `?conversationId=${convAggNative}`,
        copiedOut: nativeCopied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") nativeHoReqs.push(body);
          if (url === "/api/watchdog") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                enabled: true,
                scope: body.scope,
                current: { conversationId: convAggNative, phase: "IDLE", severity: "idle" },
                sessions: [{ conversationId: convAggNative, workspaceLabel: "ws-nat", convTitle: "Native Chat", phase: "IDLE", severity: "idle", isSubagent: false }],
                alertingSessions: []
              })
            };
          }
          if (url === "/api/watchdog/action") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                status: {
                  ok: true,
                  enabled: true,
                  scope: body.scope,
                  current: { conversationId: convAggNative, phase: "IDLE", severity: "idle" },
                  sessions: [{ conversationId: convAggNative, workspaceLabel: "ws-nat", convTitle: "Native Chat", phase: "IDLE", severity: "idle", isSubagent: false }],
                  alertingSessions: []
                }
              })
            };
          }
          const res = await httpJsonRequest(port, url, {
            method: opts.method || "POST",
            headers: authHeaders,
            body
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });
      vm.runInContext(
        `cachedWatchdog = { ok: true, enabled: true, scope: 'conversation', _hostEpoch: hostSwitchEpoch, current: { conversationId: ${JSON.stringify(convAggNative)}, phase: 'IDLE', severity: 'idle' }, sessions: [{ conversationId: ${JSON.stringify(convAggNative)}, workspaceLabel: 'ws-nat', convTitle: 'Native Chat', phase: 'IDLE', severity: 'idle', isSubagent: false }], alertingSessions: [] };
         setScope(${JSON.stringify(aggScope)});
         toggleHandoffDrawer(true);`,
        nCtx
      );
      await waitForHandoffSettled(nCtx);
      assert.equal(nEl.get("wd-session-switcher").classList.contains("hidden"), false, `Item 3 (${aggScope}/native): switcher must remain visible in aggregate scope even with 1 session`);
      assert.ok(nEl.get("wd-session-switcher").innerHTML.includes(`data-jump-conv="${convAggNative}"`));
      // Even when Watchdog reports 0 active leases (`sessions: []`), native-bound session stays clickable in aggregate scope
      vm.runInContext("renderSessionSwitcher({ ok: true, enabled: true, scope: currentScope, current: null, sessions: [], alertingSessions: [] });", nCtx);
      assert.equal(nEl.get("wd-session-switcher").classList.contains("hidden"), false, `Item 3 (${aggScope}/native-0-leases): switcher must still expose native-bound session when wd.sessions is empty`);
      assert.ok(nEl.get("wd-session-switcher").innerHTML.includes(`data-jump-conv="${convAggNative}"`));
      nativeHoReqs.length = 0;
      await vm.runInContext(`jumpToConversation(${JSON.stringify(convAggNative)});`, nCtx);
      await waitForHandoffSettled(nCtx);
      assert.equal(vm.runInContext("currentScope;", nCtx), "conversation");
      assert.ok(
        nativeHoReqs.some((r) => r.scope === "conversation" && r.conversationId === convAggNative && r.conversationConfirmed === true),
        `Item 3 (${aggScope}/native): clicking native-bound conv from aggregate scope must switch & fetch confirmed brief`
      );
      assert.ok(nEl.get("kv-handoff-preview").textContent.includes("QUOTE_ITEM3_AGG_NATIVE"));
      assert.equal(nEl.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(nEl.get("kv-handoff-prompt-btn").disabled, false);
      await vm.runInContext("copyHandoffBrief(); copyHandoffPrompt();", nCtx);
      assert.equal(nativeCopied.length, 2);
      assert.ok(nativeCopied[0].includes("QUOTE_ITEM3_AGG_NATIVE") && nativeCopied[1].includes("TASK_ITEM3_AGG_NATIVE"));
    }

    // === Item 4: Inferred session clickable entry within 8-item display cap across 0, 8, and >8 (10) other leases ===
    const makeLeases = (count) =>
      Array.from({ length: count }, (_, i) => ({
        conversationId: `conv-other-lease-${i}`,
        workspaceLabel: `ws-${i}`,
        convTitle: `Other ${i}`,
        cwd: tmpDir,
        phase: "IDLE",
        severity: "idle",
        isSubagent: false
      }));

    for (const [caseLabel, sessionsList, expectedMetaText] of [
      ["0_other_leases", [], convInferredTarget.slice(0, 8)],
      ["8_other_leases_candidate_unleased", makeLeases(8), convInferredTarget.slice(0, 8)],
      [
        "10_other_leases_candidate_unleased",
        makeLeases(10),
        convInferredTarget.slice(0, 8)
      ],
      [
        "10_leases_candidate_at_index_8_preserves_metadata",
        [
          ...makeLeases(8),
          {
            conversationId: convInferredTarget,
            workspaceLabel: "ws-rich-inferred",
            convTitle: "Rich Inferred Lease",
            cwd: tmpDir,
            phase: "TOOL_RUNNING",
            severity: "idle",
            contextTokens: 42000,
            isSubagent: false
          },
          ...makeLeases(2).map((x, idx) => ({ ...x, conversationId: `conv-tail-${idx}` }))
        ],
        "ws-rich-inferred · Rich Inferred Lease"
      ]
    ]) {
      const copied = [];
      const hoReqs = [];
      const { ctx, elements } = createDashboardVmSandbox({
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") hoReqs.push(body);
          if (url === "/api/cache-diag") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                transcriptFound: true,
                resolvedConversationId: convInferredTarget,
                currentContextTokens: 18000,
                watermark: "ok"
              })
            };
          }
          if (url === "/api/watchdog") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                enabled: true,
                scope: body.scope || "conversation",
                current: null,
                sessions: sessionsList,
                alertingSessions: []
              })
            };
          }
          if (url === "/api/watchdog/action") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                status: { ok: true, enabled: true, scope: "conversation", current: { conversationId: convInferredTarget, phase: "IDLE", severity: "idle" }, sessions: sessionsList, alertingSessions: [] }
              })
            };
          }
          const res = await httpJsonRequest(port, url, {
            method: opts.method || "POST",
            headers: authHeaders,
            body
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });

      await waitForHandoffSettled(ctx);
      vm.runInContext(
        `inferredFallbackConvId = ${JSON.stringify(convInferredTarget)};
         const wdCase = { ok: true, enabled: true, scope: 'conversation', current: null, sessions: sessList, alertingSessions: [] };
         renderWatchdogCard(wdCase);
         toggleHandoffDrawer(true);`,
        Object.assign(ctx, { sessList: sessionsList })
      );
      await waitForHandoffSettled(ctx);

      const switcherEl = elements.get("wd-session-switcher");
      const pillIds = [...switcherEl.innerHTML.matchAll(/data-jump-conv="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(switcherEl.classList.contains("hidden"), false, `Item 4 (${caseLabel}): switcher must be visible`);
      assert.ok(pillIds.length >= 1 && pillIds.length <= 8, `Item 4 (${caseLabel}): pill count must stay within <= 8 cap, got ${pillIds.length}`);
      assert.equal(new Set(pillIds).size, pillIds.length, `Item 4 (${caseLabel}): switcher pills must be deduplicated`);
      assert.equal(
        pillIds.filter((id) => id === convInferredTarget).length,
        1,
        `Item 4 (${caseLabel}): inferred candidate ${convInferredTarget} must appear exactly once, got ${JSON.stringify(pillIds)}`
      );
      assert.ok(
        switcherEl.innerHTML.includes(expectedMetaText),
        `Item 4 (${caseLabel}): expected pill text '${expectedMetaText}' in ${switcherEl.innerHTML}`
      );

      // Click the inferred candidate -> request, preview, Fact Copy & Semantic Prompt Copy all target convInferredTarget!
      hoReqs.length = 0;
      await vm.runInContext(`jumpToConversation(${JSON.stringify(convInferredTarget)});`, ctx);
      await waitForHandoffSettled(ctx);
      assert.ok(
        hoReqs.some((r) => r.scope === "conversation" && r.conversationId === convInferredTarget && r.conversationConfirmed === true),
        `Item 4 (${caseLabel}): clicking candidate must request confirmed brief for ${convInferredTarget}`
      );
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("QUOTE_ITEM4_INFERRED"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
      await vm.runInContext("copyHandoffBrief(); copyHandoffPrompt();", ctx);
      assert.equal(copied.length, 2);
      assert.ok(copied[0].includes("QUOTE_ITEM4_INFERRED") && copied[1].includes("TASK_ITEM4_INFERRED"));
    }

    // Item 4 extra: distinct selectedConvOverride + inferredFallbackConvId alongside 10 other leases -> both reserved within <=8 cap, deduplicated!
    {
      const { ctx, elements } = createDashboardVmSandbox();
      const tenLeases = makeLeases(10);
      vm.runInContext(
        `selectedConvOverride = ${JSON.stringify(convReal)};
         inferredFallbackConvId = ${JSON.stringify(convInferredTarget)};
         renderSessionSwitcher({ ok: true, enabled: true, scope: 'conversation', current: null, sessions: sessList, alertingSessions: [] });`,
        Object.assign(ctx, { sessList: tenLeases })
      );
      const pillIds = [...elements.get("wd-session-switcher").innerHTML.matchAll(/data-jump-conv="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(pillIds.length, 8);
      assert.equal(new Set(pillIds).size, 8);
      assert.ok(pillIds.includes(convReal) && pillIds.includes(convInferredTarget));
    }

    // Controlled-clock waitForHandoffSettled boundary tests (v1.7.3-14):
    // (a) Finishes in last poll interval before 2000ms deadline -> succeeds cleanly instead of false timeout
    {
      let nowMs = 10_000;
      let step = 0;
      const clockCtx = vm.createContext({
        currentScope: "conversation",
        handoffLoading: true,
        handoffInFlightRequest: { seq: 1 },
        autoRefreshInFlight: false
      });
      await waitForHandoffSettled(clockCtx, {
        timeoutMs: 2000,
        scope: "conversation",
        scenario: "v1.7.3-14 clock-finish-before-deadline",
        nowFn: () => nowMs,
        sleepFn: async () => {
          step += 1;
          if (step === 1) {
            nowMs = 11_990; // Still before 12_000 deadline; busy flags still true
          } else {
            // Finishes right before 12_000 deadline during final poll sleep, waking at 12_010
            clockCtx.handoffLoading = false;
            clockCtx.handoffInFlightRequest = null;
            clockCtx.autoRefreshInFlight = false;
            nowMs = 12_010;
          }
        }
      });
      assert.equal(step, 2, "v1.7.3-14 clock boundary: must exit cleanly after final poll completes before deadline");
    }

    // (b) Still busy at 2000ms deadline (each existing busy flag) -> rejects with diagnostic timeout
    for (const [label, flags, expectRe] of [
      ["handoffLoading", { handoffLoading: true, handoffInFlightRequest: null, autoRefreshInFlight: false }, /handoffLoading=true/],
      ["inFlight", { handoffLoading: false, handoffInFlightRequest: { seq: 2 }, autoRefreshInFlight: false }, /inFlight=true/],
      ["autoRefresh", { handoffLoading: false, handoffInFlightRequest: null, autoRefreshInFlight: true }, /autoRefresh=true/]
    ]) {
      let nowMs = 20_000;
      let step = 0;
      const busyCtx = vm.createContext({ currentScope: "conversation", ...flags });
      await assert.rejects(
        () =>
          waitForHandoffSettled(busyCtx, {
            timeoutMs: 2000,
            scope: "conversation",
            scenario: `v1.7.3-14 clock-still-busy-${label}`,
            nowFn: () => nowMs,
            sleepFn: async () => {
              step += 1;
              nowMs = step === 1 ? 21_990 : 22_010;
            }
          }),
        (err) => {
          assert.match(err.message, /waitForHandoffSettled timed out after 2000ms/);
          assert.match(err.message, new RegExp(`v1\\.7\\.3-14 clock-still-busy-${label}`));
          assert.match(err.message, expectRe);
          return true;
        }
      );
    }
  } finally {
    if (srv) {
      const closeP = new Promise((resolve) => srv.close(resolve));
      srv.closeAllConnections?.();
      await closeP;
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.3-15: Review fixes Item 5 (CLI >2 MiB half-line eviction on stdout/stderr), Item 6 (real Node TAP failing titles ending in PASSED / ... ok) & Item 7 (shared isFailureAnchorLine)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-rev-cli-tap-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const cliFilterPath = path.join(ROOT, "hooks", "cli-filter.mjs");

  try {
    // === Item 5: CLI truncated half-line fallback across BOTH stdout & stderr ===
    const secretTok = "sk-ant-api03-99887766554433221100aabbccddeeff1122";
    const fullErrLine = `Error: partial_complete_tail_marker token=${secretTok}\n`;
    const halfCutLen = "Error: partial".length; // Exactly "Error: partial" lands at 2 MiB boundary!

    for (const streamName of ["stdout", "stderr"]) {
      // Case 5a: Complete error stays inside 64 KiB overflow tail -> SQLite stores complete redacted excerpt
      const sidKept = `sess-item5-kept-${streamName}`;
      const keptScript = path.join(tmpDir, `item5-kept-${streamName}.mjs`);
      const padBytes = 2 * 1024 * 1024 - halfCutLen;
      fs.writeFileSync(
        keptScript,
        [
          `const padBytes = ${padBytes};`,
          `const okLine = "ok_pad_0123456789abcdef0123456789abcdef0123456789abcdef0123456\\n";`,
          `const count = Math.floor(padBytes / okLine.length);`,
          `const rem = padBytes - count * okLine.length;`,
          `for (let i = 0; i < count; i++) process.${streamName}.write(okLine);`,
          `if (rem > 0) process.${streamName}.write("p".repeat(rem - 1) + "\\n");`,
          `process.${streamName}.write(${JSON.stringify(fullErrLine)});`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const runKept = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(keptScript)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sidKept, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(runKept.status, 1, `Item 5 (${streamName}/kept) must exit 1`);
      const stKept = new ContextModeStore({ dbPath: tmpDb });
      let cpKept = null;
      try {
        cpKept = stKept.getSessionCheckpoint(sidKept);
      } finally {
        stKept.close();
      }
      assert.equal(cpKept.lastTest?.ok, false);
      assert.equal(cpKept.lastTest?.exitCode, 1);
      assert.ok(
        (cpKept.lastTest?.failureExcerpt || "").includes("Error: partial_complete_tail_marker"),
        `Item 5 (${streamName}/kept): must store complete redacted error from 64 KiB tail, got: ${JSON.stringify(cpKept.lastTest?.failureExcerpt)}`
      );
      assert.ok(!(cpKept.lastTest?.failureExcerpt || "").includes(secretTok), `Item 5 (${streamName}/kept): secret must be redacted`);
      assert.ok(
        !(cpKept.lastTest?.summary || "").endsWith("Error: partial"),
        `Item 5 (${streamName}/kept): summary must not be truncated half-line, got: ${JSON.stringify(cpKept.lastTest?.summary)}`
      );

      // Case 5b: >70 KiB normal logs follow the 2 MiB boundary error -> complete error is evicted from 64 KiB overflow tail!
      // SQLite MUST store empty failureExcerpt (omitted / "") and NEVER half-line "Error: partial" in excerpt or summary, while keeping ok: false & exitCode: 1!
      const sidEvicted = `sess-item5-evicted-${streamName}`;
      const evictedScript = path.join(tmpDir, `item5-evicted-${streamName}.mjs`);
      fs.writeFileSync(
        evictedScript,
        [
          `const padBytes = ${padBytes};`,
          `const okLine = "ok_pad_0123456789abcdef0123456789abcdef0123456789abcdef0123456\\n";`,
          `const count = Math.floor(padBytes / okLine.length);`,
          `const rem = padBytes - count * okLine.length;`,
          `for (let i = 0; i < count; i++) process.${streamName}.write(okLine);`,
          `if (rem > 0) process.${streamName}.write("p".repeat(rem - 1) + "\\n");`,
          `process.${streamName}.write(${JSON.stringify(fullErrLine)});`,
          `for (let j = 0; j < 1300; j++) process.${streamName}.write("normal_post_log_0123456789abcdef0123456789abcdef0123456789abc\\n");`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const runEvicted = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(evictedScript)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sidEvicted, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(runEvicted.status, 1, `Item 5 (${streamName}/evicted) must exit 1`);
      const stEv = new ContextModeStore({ dbPath: tmpDb });
      let cpEv = null;
      let briefEv = null;
      try {
        cpEv = stEv.getSessionCheckpoint(sidEvicted);
        briefEv = buildHandoffBrief({
          store: stEv,
          mode: "agent",
          scope: "conversation",
          conversationId: sidEvicted,
          conversationConfirmed: true,
          sessionId: sidEvicted,
          cwd: tmpDir
        });
      } finally {
        stEv.close();
      }
      assert.equal(cpEv.lastTest?.ok, false, `Item 5 (${streamName}/evicted) must retain failed status`);
      assert.equal(cpEv.lastTest?.exitCode, 1, `Item 5 (${streamName}/evicted) must retain exitCode 1`);
      assert.equal(
        cpEv.lastTest?.failureExcerpt || "",
        "",
        `Item 5 (${streamName}/evicted): half-line must NEVER be written to SQLite failureExcerpt, got: ${JSON.stringify(cpEv.lastTest?.failureExcerpt)}`
      );
      assert.ok(
        !(cpEv.lastTest?.summary || "").includes("Error: partial"),
        `Item 5 (${streamName}/evicted): half-line must NEVER be written to SQLite summary, got: ${JSON.stringify(cpEv.lastTest?.summary)}`
      );
      assert.ok(briefEv.markdown.includes("FAIL (exit 1)"), `Item 5 (${streamName}/evicted): brief must retain FAIL (exit 1)`);
      assert.ok(!briefEv.markdown.includes("Error: partial"), `Item 5 (${streamName}/evicted): brief must NOT include truncated half-line`);
      assert.equal(
        cpEv.lastTest?.summary,
        "failed (exit 1)",
        `Item 5 (${streamName}/evicted): summary must fall back cleanly without random noise or half-line, got ${JSON.stringify(cpEv.lastTest?.summary)}`
      );
    }

    // Item 5 extra: ANSI-colored passing-noise line before 2 MiB boundary + evicted half-line must NOT leak ANSI or passing test into summary,
    // AND mixed-stream (truncated stdout with evicted half-line + untruncated stderr error without trailing newline) must preserve stderr error.
    {
      const sidAnsi = "sess-item5-ansi-evicted";
      const ansiScript = path.join(tmpDir, "item5-ansi-evicted.mjs");
      const prefixPass = "\\x1b[32mok 1 - handles error gracefully\\x1b[0m\\n";
      const ansiPadBytes = 2 * 1024 * 1024 - halfCutLen - Buffer.byteLength("\x1b[32mok 1 - handles error gracefully\x1b[0m\n", "utf8");
      fs.writeFileSync(
        ansiScript,
        [
          `process.stdout.write("${prefixPass}");`,
          `const padBytes = ${ansiPadBytes};`,
          `const okLine = "ok_pad_0123456789abcdef0123456789abcdef0123456789abcdef0123456\\n";`,
          `const count = Math.floor(padBytes / okLine.length);`,
          `const rem = padBytes - count * okLine.length;`,
          `for (let i = 0; i < count; i++) process.stdout.write(okLine);`,
          `if (rem > 0) process.stdout.write("p".repeat(rem - 1) + "\\n");`,
          `process.stdout.write(${JSON.stringify(fullErrLine)});`,
          `for (let j = 0; j < 1300; j++) process.stdout.write("\\x1b[90mnormal_post_log_0123456789abcdef0123456789abcdef0123456789\\x1b[0m\\n");`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const runAnsi = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(ansiScript)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sidAnsi, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(runAnsi.status, 1);

      const sidMixed = "sess-item5-mixed-stderr";
      const mixedScript = path.join(tmpDir, "item5-mixed-stderr.mjs");
      fs.writeFileSync(
        mixedScript,
        [
          `const padBytes = ${2 * 1024 * 1024 - halfCutLen};`,
          `const okLine = "ok_pad_0123456789abcdef0123456789abcdef0123456789abcdef0123456\\n";`,
          `const count = Math.floor(padBytes / okLine.length);`,
          `const rem = padBytes - count * okLine.length;`,
          `for (let i = 0; i < count; i++) process.stdout.write(okLine);`,
          `if (rem > 0) process.stdout.write("p".repeat(rem - 1) + "\\n");`,
          `process.stdout.write(${JSON.stringify(fullErrLine)});`,
          `for (let j = 0; j < 1300; j++) process.stdout.write("normal_post_0123456789abcdef0123456789abcdef0123456789abcdef\\n");`,
          `process.stderr.write("TypeError: untruncated_stderr_no_newline");`,
          `process.exit(1);`
        ].join("\n"),
        "utf8"
      );
      const runMixed = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(mixedScript)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sidMixed, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(runMixed.status, 1);

      const stExtra5 = new ContextModeStore({ dbPath: tmpDb });
      try {
        const cpAnsi = stExtra5.getSessionCheckpoint(sidAnsi);
        assert.equal(cpAnsi.lastTest?.failureExcerpt || "", "");
        assert.equal(cpAnsi.lastTest?.summary, "failed (exit 1)", "Item 5: ANSI/passing-noise lines must not pollute summary on evicted truncation");
        const cpMixed = stExtra5.getSessionCheckpoint(sidMixed);
        assert.equal(cpMixed.lastTest?.failureExcerpt, "TypeError: untruncated_stderr_no_newline");
        assert.equal(cpMixed.lastTest?.summary, "TypeError: untruncated_stderr_no_newline");
      } finally {
        stExtra5.close();
      }
    }

    // === Item 6: Real Node TAP subprocess with failing case titles ending in `PASSED` and `... ok` + passing title containing `error` ===
    const { ctx: promptCtx } = createDashboardVmSandbox();
    for (const [tapTag, failTitle, failMsg] of [
      ["ends_passed", "marks a finished job PASSED", "job status stayed PENDING instead of PASSED"],
      ["ends_dots_ok", "prints summary ... ok", "summary line expected ok marker"]
    ]) {
      const tapFile = path.join(tmpDir, `tap-${tapTag}.test.mjs`);
      fs.writeFileSync(
        tapFile,
        [
          `import test from "node:test";`,
          `import assert from "node:assert/strict";`,
          `test("handles error case cleanly", () => { assert.equal(1, 1); });`,
          `test(${JSON.stringify(failTitle)}, () => { assert.equal("actual", "expected", ${JSON.stringify(failMsg)}); });`
        ].join("\n"),
        "utf8"
      );
      const tapSid = `sess-item6-tap-${tapTag}`;
      const tapEnv = { ...process.env, AGY_DART_DB_PATH: tmpDb };
      delete tapEnv.NODE_TEST_CONTEXT;
      const tapRun = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node --test --test-reporter=tap tap-${tapTag}.test.mjs`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(tapSid, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: tapEnv }
      );
      assert.equal(tapRun.status, 1, `Item 6 (${tapTag}): real Node TAP run must exit 1`);

      const tapSt = new ContextModeStore({ dbPath: tmpDb });
      let tapCp = null;
      let tapBrief = null;
      try {
        tapCp = tapSt.getSessionCheckpoint(tapSid);
        tapBrief = buildHandoffBrief({
          store: tapSt,
          mode: "agent",
          scope: "conversation",
          conversationId: tapSid,
          conversationConfirmed: true,
          sessionId: tapSid,
          cwd: tmpDir
        });
      } finally {
        tapSt.close();
      }
      const tapEx = tapCp.lastTest?.failureExcerpt || "";
      const tapExLines = tapEx.split("\n");
      assert.ok(
        tapExLines[0].startsWith("not ok ") && tapExLines[0].includes(failTitle),
        `Item 6 (${tapTag}): SQLite excerpt line 1 must preserve failing TAP title '${failTitle}', got:\n${tapEx}`
      );
      assert.ok(tapEx.includes(failMsg), `Item 6 (${tapTag}): SQLite excerpt must preserve real YAML diagnostic '${failMsg}', got:\n${tapEx}`);
      assert.ok(!tapEx.includes("handles error case cleanly"), `Item 6 (${tapTag}): must skip passing test containing 'error'`);

      assert.ok(tapBrief.markdown.includes(failTitle) && tapBrief.markdown.includes(failMsg), `Item 6 (${tapTag}): Markdown brief must retain failing title & diagnostic`);
      const anchorLine = tapBrief.anchors.failingChecks[0]?.firstErrorLine || "";
      assert.ok(
        anchorLine.includes(failTitle) && anchorLine.includes(failMsg),
        `Item 6 (${tapTag}): firstErrorLine must retain failing title & diagnostic, got: ${JSON.stringify(anchorLine)}`
      );
      const zhPrompt = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(tapBrief)}, "zh");`, promptCtx);
      const enPrompt = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(tapBrief)}, "en");`, promptCtx);
      assert.ok(zhPrompt.includes(failTitle) && zhPrompt.includes(failMsg), `Item 6 (${tapTag}): ZH semantic prompt must preserve failing title & diagnostic`);
      assert.ok(enPrompt.includes(failTitle) && enPrompt.includes(failMsg), `Item 6 (${tapTag}): EN semantic prompt must preserve failing title & diagnostic`);
    }

    // Item 6 extra: TAP `ok # SKIP ...` containing `error` must be skipped before real `not ok ... PASSED`
    const tapSkipExcerpt = extractFailureExcerpt(
      "ok # SKIP handles error gracefully\nnot ok 1 - marks job PASSED\n  ---\n  message: 'real boom'\n  ...\n"
    );
    assert.equal(tapSkipExcerpt, "not ok 1 - marks job PASSED\nmessage: real boom");

    // === Item 7: Shared isFailureAnchorLine() classification between hook & brief ===
    assert.equal(isFailureAnchorLine("window.onerror: handler ready"), false);
    assert.equal(isFailureAnchorLine("window.onerror: handler ready", { includeTimeout: true }), false);
    assert.equal(isFailureAnchorLine("TypeError: value is undefined"), true);
    assert.equal(isFailureAnchorLine("0 errors, 0 failed"), false);
    assert.equal(isFailureAnchorLine("Errors: 0"), false);
    assert.equal(isFailureAnchorLine("ℹ fail 0"), false);
    assert.equal(isFailureAnchorLine("0 errors, 1 failed"), true);
    assert.equal(isFailureAnchorLine("Error: 0 items matched"), true);
    assert.equal(isFailureAnchorLine("Error: 0.5s invalid"), true);
    assert.equal(isFailureAnchorLine("CustomDomainError: invariant violated"), true);
    assert.equal(isFailureAnchorLine("operation timed out after 500ms"), false);
    assert.equal(isFailureAnchorLine("operation timed out after 500ms", { includeTimeout: true }), true);

    const twoLineSample = "window.onerror: handler ready\nTypeError: value is undefined";
    const extractedTwoLine = extractFailureExcerpt(twoLineSample);
    assert.equal(extractedTwoLine, twoLineSample);

    const st7 = new ContextModeStore({ dbPath: tmpDb });
    let brief7 = null;
    let brief7Zero = null;
    try {
      const sid7 = "sess-item7-shared-anchor";
      st7.recordVerificationResult(sid7, {
        kind: "test",
        command: "npm test -- ui.spec.mjs",
        exitCode: 1,
        passed: false,
        summary: "1 failed",
        failureExcerpt: extractedTwoLine,
        worktree: tmpDir
      });
      brief7 = buildHandoffBrief({
        store: st7,
        mode: "agent",
        scope: "conversation",
        conversationId: sid7,
        conversationConfirmed: true,
        sessionId: sid7,
        cwd: tmpDir
      });

      const sid7Zero = "sess-item7-zero-summary";
      st7.recordVerificationResult(sid7Zero, {
        kind: "build",
        command: "npm run build",
        exitCode: 1,
        passed: false,
        summary: "build failed",
        failureExcerpt: "0 errors, 0 failed\nCustomWidgetError: missing manifest",
        worktree: tmpDir
      });
      brief7Zero = buildHandoffBrief({
        store: st7,
        mode: "agent",
        scope: "conversation",
        conversationId: sid7Zero,
        conversationConfirmed: true,
        sessionId: sid7Zero,
        cwd: tmpDir
      });
    } finally {
      st7.close();
    }
    assert.equal(
      brief7.anchors.failingChecks[0]?.firstErrorLine,
      "TypeError: value is undefined",
      "Item 7: firstErrorLine must skip lowercase window.onerror context line and point directly to TypeError"
    );
    const prompt7Zh = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(brief7)}, "zh");`, promptCtx);
    const prompt7En = vm.runInContext(`buildSemanticHandoffPrompt(${JSON.stringify(brief7)}, "en");`, promptCtx);
    assert.ok(prompt7Zh.includes("TypeError: value is undefined") && !prompt7Zh.includes("window.onerror: handler ready"));
    assert.ok(prompt7En.includes("TypeError: value is undefined") && !prompt7En.includes("window.onerror: handler ready"));
    assert.equal(brief7Zero.anchors.failingChecks[0]?.firstErrorLine, "CustomWidgetError: missing manifest");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("v1.7.3-16: Wrap-up Item 1 — Aggregate alert card Copy Rescue Brief / View Brief alignment, privacy isolation, ordinary drawer semantics & in-flight A->B race", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-wrap1-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const brainRoot = path.join(tmpDir, "brain");
  const wsA = path.join(tmpDir, "ws-alpha");
  const wsB = path.join(tmpDir, "ws-beta");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const convA = "conv-wrap1-bound-alpha";
  const convB = "conv-wrap1-newer-beta";

  const txADir = path.join(brainRoot, convA, ".system_generated", "logs");
  const txBDir = path.join(brainRoot, convB, ".system_generated", "logs");
  fs.mkdirSync(txADir, { recursive: true });
  fs.mkdirSync(txBDir, { recursive: true });
  const txAPath = path.join(txADir, "transcript.jsonl");
  const txBPath = path.join(txBDir, "transcript.jsonl");
  fs.writeFileSync(
    txAPath,
    JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>PRIVATE_QUOTE_A_SECRET</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    txBPath,
    JSON.stringify({ type: "USER_INPUT", step_index: 1, user_input: "<USER_REQUEST>PRIVATE_QUOTE_B_SECRET</USER_REQUEST>" }) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(brainRoot, convA, "task.md"), "- [/] PRIVATE_TASK_A_SECRET\n", "utf8");
  fs.writeFileSync(path.join(brainRoot, convB, "task.md"), "- [/] PRIVATE_TASK_B_SECRET\n", "utf8");

  const baseNow = Date.now();
  const oldMtimeSec = (baseNow - 600_000) / 1000;
  fs.utimesSync(txAPath, oldMtimeSec, oldMtimeSec);
  fs.utimesSync(txBPath, oldMtimeSec, oldMtimeSec);

  const store = new ContextModeStore({ dbPath: tmpDb });
  // Bound A: Claude 150k, earlier activity timestamp; Unbound B: Gemini 115k, NEWER activity timestamp so top alerting is B!
  recordHookLeaseTransition(
    store,
    "PreInvocation",
    {
      conversationId: convA,
      cwd: wsA,
      lastUserInput: "PRIVATE_INPUT_A_SECRET",
      transcriptPath: txAPath
    },
    { nowMs: baseNow + 10_000, model: "claude-opus-4-6", contextTokens: 150000 }
  );
  recordHookLeaseTransition(
    store,
    "PreInvocation",
    {
      conversationId: convB,
      cwd: wsB,
      lastUserInput: "PRIVATE_INPUT_B_SECRET",
      transcriptPath: txBPath
    },
    { nowMs: baseNow + 40_000, model: "gemini-2.5-pro", contextTokens: 115000 }
  );
  store.recordVerificationResult(convA, {
    kind: "test",
    command: "npm test -- alpha",
    exitCode: 1,
    passed: false,
    summary: "PRIVATE_SUMMARY_A_SECRET",
    failureExcerpt: "Error: PRIVATE_EXCERPT_A_SECRET",
    worktree: wsA
  });
  store.recordVerificationResult(convB, {
    kind: "test",
    command: "npm test -- beta",
    exitCode: 1,
    passed: false,
    summary: "PRIVATE_SUMMARY_B_SECRET",
    failureExcerpt: "Error: PRIVATE_EXCERPT_B_SECRET",
    worktree: wsB
  });
  store.close();

  const virtualNow = baseNow + 950_000; // Both A and B simultaneously STALLED
  const virtualMono = 5_000_000_000_000n;
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  process.env.AGY_DART_DB_PATH = tmpDb;
  closeRuntimeStore();

  const token = "v173-wrap1-csrf-token-0123456789abcdef";
  const srv = createStandaloneServer({
    csrfToken: token,
    watchdogOptions: {
      brainRoots: [brainRoot],
      nowFn: () => virtualNow,
      monoNsFn: () => virtualMono,
      findTranscriptFn: () => null,
      notifyFn: () => {},
      focusWindowFn: () => ({ dispatched: false, platform: process.platform })
    }
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const authHeaders = { "X-Agy-Dart-Token": token };

  const privateSecrets = [
    "PRIVATE_QUOTE_A_SECRET",
    "PRIVATE_QUOTE_B_SECRET",
    "PRIVATE_TASK_A_SECRET",
    "PRIVATE_TASK_B_SECRET",
    "PRIVATE_INPUT_A_SECRET",
    "PRIVATE_INPUT_B_SECRET",
    "PRIVATE_EXCERPT_A_SECRET",
    "PRIVATE_EXCERPT_B_SECRET",
    "PRIVATE_SUMMARY_A_SECRET",
    "PRIVATE_SUMMARY_B_SECRET"
  ];
  const assertNoPrivateLeak = (rawText, label) => {
    for (const secret of privateSecrets) {
      assert.ok(!rawText.includes(secret), `${label} must NOT leak ${secret}`);
    }
  };
  const waitForRequestSignal = (signalPromise, { scope, scenario, expectedRequest, timeoutMs = 2000 }) => {
    let timer = null;
    return Promise.race([
      signalPromise.finally(() => {
        if (timer !== null) clearTimeout(timer);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for expected request` +
                ` (scope=${scope}, scenario=${scenario}, missingRequest=${expectedRequest})`
            )
          );
        }, timeoutMs);
      })
    ]);
  };
  const waitForBoundedCompletion = (promise, { scope, scenario, operation, timeoutMs = 2000 }) => {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).finally(() => {
        if (timer !== null) clearTimeout(timer);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for completion` +
                ` (scope=${scope}, scenario=${scenario}, operation=${operation})`
            )
          );
        }, timeoutMs);
      })
    ]);
  };
  const waitForHandoffSettled = async (ctx, timeoutOrOpts = 2000) => {
    const opts = typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : (timeoutOrOpts || {});
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 2000;
    const nowFn = typeof opts.nowFn === "function" ? opts.nowFn : Date.now;
    const sleepFn =
      typeof opts.sleepFn === "function" ? opts.sleepFn : (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = nowFn() + timeoutMs;
    while (nowFn() < deadline) {
      if (!vm.runInContext("handoffLoading", ctx)) {
        await sleepFn(15);
        if (!vm.runInContext("handoffLoading", ctx)) return;
      }
      await sleepFn(15);
    }
    const state = vm.runInContext(
      "({ scope: currentScope, handoffLoading: Boolean(handoffLoading), inFlight: Boolean(handoffInFlightRequest), autoRefresh: Boolean(autoRefreshInFlight), drawerOpen: Boolean(handoffDrawerOpen), targeted: Boolean(handoffDrawerTargetedAlert), ended: Boolean(handoffDrawerTargetedEnded) })",
      ctx
    );
    if (!state.handoffLoading) {
      return;
    }
    throw new Error(
      `waitForHandoffSettled timed out after ${timeoutMs}ms` +
        ` (scope=${opts.scope || state.scope}, scenario=${opts.scenario || "v1.7.3-16"},` +
        ` handoffLoading=${state.handoffLoading}, inFlight=${state.inFlight}, autoRefresh=${state.autoRefresh},` +
        ` drawerOpen=${state.drawerOpen}, targeted=${state.targeted}, ended=${state.ended})`
    );
  };
  const waitForWatchdogCurrent = async (ctx, expectedConvId, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = vm.runInContext(
        `Boolean(cachedWatchdog?.current?.conversationId === ${JSON.stringify(expectedConvId)} && isWatchdogIncidentAlignedWithTarget() && getCurrentWatchdogIncidentKey())`,
        ctx
      );
      if (ready) return;
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  try {
    // 1. Direct API checks: targeted stallConversationId=A vs ordinary aggregate (top=B) vs non-existent/reserved/unsafe
    for (const aggScope of ["app", "lifetime"]) {
      const wdRes = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: convA, fromSidecarHost: true }
      });
      assert.equal(wdRes.status, 200);
      assert.equal(wdRes.json.current?.conversationId, convA, `${aggScope}: card must prioritize bound session A`);
      assert.equal(wdRes.json.current?.model, "claude-opus-4-6");
      assert.equal(wdRes.json.current?.contextTokens, 150000);
      assert.equal(wdRes.json.alertingSessions?.[0]?.conversationId, convB, `${aggScope}: top alerting session must be newer B`);

      // Ordinary aggregate (stallConversationId omitted) -> preserves existing getTopAlertingStallContext() = B
      const ordHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: "", mode: "agent", conversationConfirmed: false, fromSidecarHost: true }
      });
      assert.equal(ordHo.status, 200);
      assert.equal(ordHo.json.confirmedConversation, false);
      assert.equal(ordHo.json.hasStallContext, true);
      assert.equal(ordHo.json.stallConversationId, undefined, `${aggScope}: ordinary aggregate must not expose stallConversationId`);
      assert.ok(ordHo.json.markdown.includes("gemini-2.5-pro") && ordHo.json.markdown.includes("115k"), `${aggScope}: ordinary aggregate must retain top alert B`);
      assert.ok(!ordHo.json.markdown.includes("claude-opus-4-6"), `${aggScope}: ordinary aggregate must not mix A into B`);
      assertNoPrivateLeak(JSON.stringify(ordHo.json), `${aggScope} ordinary /api/handoff`);

      // Targeted aggregate (stallConversationId=convA) -> projects ONLY A's public stall overview
      const targHo = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: {
          scope: aggScope,
          conversationId: "",
          stallConversationId: convA,
          mode: "agent",
          includeStall: true,
          conversationConfirmed: false,
          fromSidecarHost: true
        }
      });
      assert.equal(targHo.status, 200);
      assert.equal(targHo.json.confirmedConversation, false);
      assert.equal(targHo.json.hasStallContext, true);
      assert.equal(targHo.json.stallConversationId, convA);
      assert.equal(targHo.json.incidentKey, wdRes.json.current.incidentKey);
      assert.ok(targHo.json.markdown.includes("claude-opus-4-6") && targHo.json.markdown.includes("150k"), `${aggScope}: targeted brief must show A (Claude 150k)`);
      assert.ok(!targHo.json.markdown.includes("gemini-2.5-pro") && !targHo.json.markdown.includes("115k"), `${aggScope}: targeted brief must NOT show B`);
      assertNoPrivateLeak(JSON.stringify(targHo.json), `${aggScope} targeted /api/handoff`);

      // Ended / missing / reserved / unsafe stallConversationId -> MUST return null stallContext, NEVER substitute B!
      for (const badStallId of ["conv-ended-missing", "default", "__unbound__", "../escape"]) {
        const missHo = await httpJsonRequest(port, "/api/handoff", {
          method: "POST",
          headers: authHeaders,
          body: {
            scope: aggScope,
            conversationId: "",
            stallConversationId: badStallId,
            mode: "agent",
            includeStall: true,
            conversationConfirmed: false,
            fromSidecarHost: true
          }
        });
        assert.equal(missHo.status, 200);
        assert.equal(missHo.json.hasStallContext, false, `${aggScope}/${badStallId}: must NOT substitute alert B`);
        assert.equal(missHo.json.incidentKey, "");
        assert.equal(missHo.json.stallConversationId, undefined);
        assert.ok(!missHo.json.markdown.includes("gemini-2.5-pro"), `${aggScope}/${badStallId}: must not leak B`);
        assert.ok(!missHo.json.markdown.includes("claude-opus-4-6"), `${aggScope}/${badStallId}: must not leak A`);
      }

      // Type check on Sidecar/HTTP: non-string stallConversationId -> 400
      const badType = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: "", stallConversationId: 123, mode: "agent" }
      });
      assert.equal(badType.status, 400);
    }

    // Unconfirmed conversation scope must NEVER leak stall context via stallConversationId
    const unconfProbe = await httpJsonRequest(port, "/api/handoff", {
      method: "POST",
      headers: authHeaders,
      body: {
        scope: "conversation",
        conversationId: "__unbound__",
        stallConversationId: convA,
        mode: "agent",
        conversationConfirmed: false,
        fromSidecarHost: true
      }
    });
    assert.equal(unconfProbe.status, 200);
    assert.equal(unconfProbe.json.hasStallContext, false);
    assert.equal(unconfProbe.json.incidentKey, "");
    assert.equal(unconfProbe.json.stallConversationId, undefined);

    // 2. Live HTTP + Sidecar VM DOM verification across BOTH `app` and `lifetime` scopes
    for (const aggScope of ["app", "lifetime"]) {
      const copied = [];
      const hoBodies = [];
      const hostObj = {
        conversationId: convA,
        ui: { toggleConversation() {} }
      };
      const { ctx, elements } = createDashboardVmSandbox({
        sidecarObj: hostObj,
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") hoBodies.push(body);
          const res = await httpJsonRequest(port, url, {
            method: opts.method || "POST",
            headers: authHeaders,
            body
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });

      await new Promise((r) => setTimeout(r, 30));
      vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
      const sec2Deadline = Date.now() + 2000;
      while (Date.now() < sec2Deadline) {
        if (
          vm.runInContext(
            `Boolean(cachedWatchdog && cachedWatchdog.scope === ${JSON.stringify(aggScope)} && cachedWatchdog.current?.conversationId === ${JSON.stringify(convA)} && cachedWatchdog.current?.phase !== 'IDLE')`,
            ctx
          )
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }

      // Verify Watchdog card renders bound A (150k) while B is in other alerts
      assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);
      assert.ok(elements.get("wd-bucket-badge").textContent.includes("150k"), `${aggScope}: card must show A's 150k`);

      // (a) Click "Copy Rescue Brief" on alert card -> clipboard gets A (Claude 150k), public-only
      hoBodies.length = 0;
      copied.length = 0;
      await vm.runInContext("copyWatchdogRescueBrief();", ctx);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].scope, aggScope);
      assert.equal(hoBodies[0].stallConversationId, convA);
      assert.equal(hoBodies[0].conversationConfirmed, false);
      assert.equal(copied.length, 1, `${aggScope}: Copy Rescue Brief must copy A`);
      assert.ok(copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"), `${aggScope}: clipboard must match card A`);
      assert.ok(!copied[0].includes("gemini-2.5-pro") && !copied[0].includes("115k"), `${aggScope}: clipboard must NOT copy B`);
      assertNoPrivateLeak(copied[0], `${aggScope} card clipboard`);

      // (b) Click "View Brief" on alert card -> drawer preview & drawer Copy Brief show A (Claude 150k), Prompt disabled
      hoBodies.length = 0;
      vm.runInContext("openWatchdogRescueDrawer();", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, convA);
      const previewA = elements.get("kv-handoff-preview").textContent;
      assert.ok(previewA.includes("claude-opus-4-6") && previewA.includes("150k"), `${aggScope}: View Brief preview must show A`);
      assert.ok(!previewA.includes("gemini-2.5-pro"), `${aggScope}: View Brief preview must NOT show B`);
      assertNoPrivateLeak(previewA, `${aggScope} View Brief preview`);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false, `${aggScope}: drawer Fact Copy must be enabled for A`);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, `${aggScope}: drawer Semantic Prompt must stay disabled in aggregate`);

      copied.length = 0;
      await vm.runInContext("copyHandoffBrief();", ctx);
      assert.equal(copied.length, 1);
      assert.ok(copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"));

      // (c) Close and open ORDINARY aggregate drawer (`toggleHandoffDrawer(true)`) -> omits stallConversationId -> top alert B preserved!
      hoBodies.length = 0;
      vm.runInContext("toggleHandoffDrawer(false); toggleHandoffDrawer(true);", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope}: ordinary drawer must omit stallConversationId`);
      const previewOrd = elements.get("kv-handoff-preview").textContent;
      assert.ok(previewOrd.includes("gemini-2.5-pro") && previewOrd.includes("115k"), `${aggScope}: ordinary drawer must keep top alert B`);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false, `${aggScope}: ordinary drawer Fact Copy must stay enabled even when card=A and top=B`);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
      copied.length = 0;
      await vm.runInContext("copyHandoffBrief();", ctx);
      assert.equal(copied.length, 1);
      assert.ok(copied[0].includes("gemini-2.5-pro") && copied[0].includes("115k"));
    }

    // 3. In-flight A -> B switch & matchingInFlight reuse race guard in `app` scope
    {
      const wdARes = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "app", conversationId: convA, fromSidecarHost: true }
      });
      const wdBRes = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "app", conversationId: convB, fromSidecarHost: true }
      });
      const hoARes = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "app", conversationId: "", stallConversationId: convA, mode: "agent", conversationConfirmed: false, fromSidecarHost: true }
      });
      const hoBRes = await httpJsonRequest(port, "/api/handoff", {
        method: "POST",
        headers: authHeaders,
        body: { scope: "app", conversationId: "", stallConversationId: convB, mode: "agent", conversationConfirmed: false, fromSidecarHost: true }
      });

      const copied = [];
      const pendingHandoffs = [];
      const hostObj = { conversationId: convA, ui: { toggleConversation() {} } };
      const { ctx, elements } = createDashboardVmSandbox({
        sidecarObj: hostObj,
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") {
            return await new Promise((resolve) => {
              pendingHandoffs.push({ body, resolve });
            });
          }
          if (url === "/api/watchdog") {
            return { ok: true, status: 200, json: async () => wdARes.json };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
      });

      await new Promise((r) => setTimeout(r, 20));
      vm.runInContext("setScope('app');", ctx);
      await new Promise((r) => setTimeout(r, 20));
      vm.runInContext("renderWatchdogCard(wdInitA);", Object.assign(ctx, { wdInitA: wdARes.json }));
      pendingHandoffs.length = 0;

      // Click View Brief for A AND Copy Rescue Brief for A while A is in-flight -> copy reuses matchingInFlight!
      vm.runInContext("openWatchdogRescueDrawer();", ctx);
      const copyReusingA = vm.runInContext("copyWatchdogRescueBrief();", ctx);
      assert.equal(pendingHandoffs.length, 1, "Copy Rescue Brief should reuse matching targeted A in-flight request");
      assert.equal(pendingHandoffs[0].body.stallConversationId, convA);
      const deferredA = pendingHandoffs.shift();

      // Before A resolves, Watchdog card switches A -> B!
      vm.runInContext("renderWatchdogCard(wdNextB);", Object.assign(ctx, { wdNextB: wdBRes.json }));
      assert.equal(pendingHandoffs.length, 1, "Open alert drawer must auto-switch to fetch new card event B");
      assert.equal(pendingHandoffs[0].body.stallConversationId, convB);
      const deferredB = pendingHandoffs.shift();

      // Resolve B first -> preview displays B (Gemini 115k)
      deferredB.resolve({ ok: true, status: 200, json: async () => hoBRes.json });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));

      // Now late A resolves -> MUST NOT overwrite B's preview AND MUST NOT write A to clipboard!
      deferredA.resolve({ ok: true, status: 200, json: async () => hoARes.json });
      await copyReusingA;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(copied.length, 0, "Stale in-flight A must NEVER copy to clipboard after switch to B");
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"), "Stale A must NEVER overwrite B preview");
      assert.ok(!elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6"));

      // Fresh Copy Rescue Brief for B while B is displayed, interrupted by recovery to IDLE -> must NOT copy B!
      const copyBPromise = vm.runInContext("copyWatchdogRescueBrief();", ctx);
      assert.equal(pendingHandoffs.length, 1);
      assert.equal(pendingHandoffs[0].body.stallConversationId, convB);
      const deferredCopyB = pendingHandoffs.shift();
      const wdIdle = {
        ...wdBRes.json,
        current: { ...wdBRes.json.current, phase: "IDLE", severity: "idle", rawSeverity: "idle", incidentKey: "" },
        alertingSessions: []
      };
      vm.runInContext("renderWatchdogCard(wdIdle);", Object.assign(ctx, { wdIdle }));
      assert.equal(pendingHandoffs.length, 0, "Targeted drawer on IDLE recovery must NOT auto-fetch ordinary aggregate");
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), true);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
      deferredCopyB.resolve({ ok: true, status: 200, json: async () => hoBRes.json });
      await copyBPromise;
      assert.equal(copied.length, 0, "Stale B copy must NOT write to clipboard after recovery to IDLE");

      // Server-ahead recovery in aggregate scope: client still displays A, server returns recovered (hasStallContext=false, incidentKey='', no stallConversationId) -> MUST NOT copy!
      vm.runInContext("toggleHandoffDrawer(false); renderWatchdogCard(wdAgainA);", Object.assign(ctx, { wdAgainA: wdARes.json }));
      pendingHandoffs.length = 0;
      const serverRecoveredCopyP = vm.runInContext("copyWatchdogRescueBrief();", ctx);
      assert.equal(pendingHandoffs.length, 1);
      const deferredRecovered = pendingHandoffs.shift();
      deferredRecovered.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          scope: "app",
          conversationId: "",
          mode: "agent",
          confirmedConversation: false,
          hasStallContext: false,
          incidentKey: "",
          markdown: "# agy-dart Handoff Brief (Overview)\n\nNo active stall.",
          bytes: 54,
          truncated: false
        })
      });
      await serverRecoveredCopyP;
      assert.equal(copied.length, 0, "Server-ahead recovered aggregate response must NOT write stale/mismatched brief to clipboard");

      // Refresh button inside drawer keeps targeted alert A vs ordinary drawer omits stallConversationId;
      // matchingInFlight does NOT reuse ordinary drawer (B) for targeted card Copy (A);
      // server-ahead recovery & A->B promotion settle in <=2 fetches without loop;
      // jumpToConversation resets handoffDrawerTargetedAlert cleanly.
      {
        const hoBodies = [];
        const copiedJump = [];
        const { ctx: liveCtx, elements: liveEls } = createDashboardVmSandbox({
          sidecarObj: { conversationId: convA, ui: { toggleConversation() {} }, workspace: { folders: [wsA, wsB] } },
          copiedOut: copiedJump,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") hoBodies.push(body);
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });
        await new Promise((r) => setTimeout(r, 30));
        vm.runInContext("setScope('app');", liveCtx);
        await waitForWatchdogCurrent(liveCtx, convA);
        hoBodies.length = 0;

        vm.runInContext("openWatchdogRescueDrawer();", liveCtx);
        await waitForHandoffSettled(liveCtx);
        vm.runInContext("loadHandoffBrief({ forceRefresh: true });", liveCtx);
        await waitForHandoffSettled(liveCtx);
        assert.equal(hoBodies[1]?.stallConversationId, convA, "Refresh inside targeted drawer must keep stallConversationId=A");
        assert.ok(liveEls.get("kv-handoff-preview").textContent.includes("claude-opus-4-6"));

        await vm.runInContext(`jumpToConversation(${JSON.stringify(convB)}, { cwd: ${JSON.stringify(wsB)} });`, liveCtx);
        await waitForHandoffSettled(liveCtx);
        assert.equal(vm.runInContext("currentScope", liveCtx), "conversation");
        assert.equal(
          vm.runInContext("handoffDrawerTargetedAlert", liveCtx),
          false,
          "jumpToConversation must reset handoffDrawerTargetedAlert cleanly"
        );
      }

      // Server-ahead A->B promotion while openWatchdogRescueDrawer() is opening settles cleanly on targeted B in <=2 fetches
      {
        const promoBodies = [];
        let serverPromotedB = false;
        const { ctx: promoCtx, elements: promoEls } = createDashboardVmSandbox({
          sidecarObj: { conversationId: "", ui: { toggleConversation() {} } },
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/watchdog") {
              return { ok: true, status: 200, json: async () => (serverPromotedB ? wdBRes.json : wdARes.json) };
            }
            if (url === "/api/handoff") {
              promoBodies.push(body);
              if (body.stallConversationId === convA && serverPromotedB) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    scope: "app",
                    conversationId: "",
                    mode: "agent",
                    confirmedConversation: false,
                    hasStallContext: false,
                    incidentKey: "",
                    markdown: "# agy-dart Handoff Brief (Overview)",
                    bytes: 36,
                    truncated: false
                  })
                };
              }
              return { ok: true, status: 200, json: async () => hoBRes.json };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
          }
        });
        await new Promise((r) => setTimeout(r, 25));
        vm.runInContext("setScope('app');", promoCtx);
        await waitForWatchdogCurrent(promoCtx, convA);
        promoBodies.length = 0;
        serverPromotedB = true;
        vm.runInContext("openWatchdogRescueDrawer();", promoCtx);
        await waitForHandoffSettled(promoCtx);
        assert.equal(promoBodies.length, 2, "Server-ahead A->B drawer sync must settle in 2 fetches without loop");
        assert.equal(promoBodies[0].stallConversationId, convA);
        assert.equal(promoBodies[1].stallConversationId, convB);
        assert.equal(vm.runInContext("handoffDrawerTargetedAlert", promoCtx), true);
        assert.ok(promoEls.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));
      }
    }

    // 4. SidecarApp IPC route parity (`registerSidecarRoutes`) for stallConversationId validation & targeted projection
    {
      const routes = new Map();
      const fakeApp = {
        config: { conversationId: convA },
        api(p, fn) {
          routes.set(p, fn);
        }
      };
      registerSidecarRoutes(fakeApp);
      const handoffRoute = routes.get("/api/handoff");
      assert.equal(typeof handoffRoute, "function");
      const ipcOk = handoffRoute({
        scope: "app",
        conversationId: "",
        stallConversationId: convA,
        mode: "agent",
        conversationConfirmed: false,
        fromSidecarHost: true
      });
      assert.equal(ipcOk.ok, true);
      assert.equal(ipcOk.confirmedConversation, false);
      assert.equal(ipcOk.stallConversationId, convA);
      assert.ok(ipcOk.markdown.includes("claude-opus-4-6") && ipcOk.markdown.includes("150k"));
      assert.ok(!ipcOk.markdown.includes("gemini-2.5-pro"));
      assertNoPrivateLeak(JSON.stringify(ipcOk), "Sidecar IPC targeted /api/handoff");
      const ipcBadType = handoffRoute({ scope: "app", stallConversationId: ["bad"], mode: "agent" });
      assert.equal(ipcBadType.ok, false);
    }

    const clickBoundButton = (html, ctx, elements, buttonId) => {
      const escapedId = buttonId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tagMatch = html.match(new RegExp(`<button\\b[^>]*\\bid="${escapedId}"[^>]*>`, "i"));
      assert.ok(tagMatch, `index.html must contain <button id="${buttonId}">`);
      const onclickMatch = tagMatch[0].match(/\bonclick="([^"]+)"/i);
      assert.ok(onclickMatch, `<button id="${buttonId}"> must have an onclick attribute`);
      assert.equal(
        Boolean(elements.get(buttonId)?.disabled),
        false,
        `button #${buttonId} must not be disabled when clicked`
      );
      return vm.runInContext(onclickMatch[1], ctx);
    };

    const reseedStalledA = () => {
      const s = new ContextModeStore({ dbPath: tmpDb });
      try {
        s.deleteMeta(`watchdog_lease:${convA}`);
        recordHookLeaseTransition(
          s,
          "PreInvocation",
          {
            conversationId: convA,
            cwd: wsA,
            lastUserInput: "PRIVATE_INPUT_A_SECRET",
            transcriptPath: txAPath
          },
          { nowMs: baseNow + 10_000, model: "claude-opus-4-6", contextTokens: 150000 }
        );
      } finally {
        s.close();
      }
    };

    // 5. Drawer Fix Scenario 1: Interleaved Card Copy A + Ordinary Drawer (B) across BOTH `app` and `lifetime` scopes & ALL 3 orders (including reused View-Brief A request + stale card-switch / incident-ended controls)
    for (const aggScope of ["app", "lifetime"]) {
      reseedStalledA();
      // Order 1: Click card Copy A (defer A's response) -> open ordinary drawer (loads B) -> A's copy resolves -> clipboard gets A, ordinary drawer keeps B & omits stallConversationId on Refresh -> then explicit View Brief A switches to A & carries stallConversationId=A
      {
        const copied = [];
        const hoBodies = [];
        let deferNextCardCopyA = false;
        let deferredCardCopyA = null;
        let signalDeferredReady = null;
        const deferredReadyPromise = new Promise((r) => {
          signalDeferredReady = r;
        });
        const { ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") {
              hoBodies.push(body);
              const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
              if (deferNextCardCopyA && body.stallConversationId === convA) {
                deferNextCardCopyA = false;
                return await new Promise((resolve) => {
                  deferredCardCopyA = () =>
                    resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json });
                  signalDeferredReady();
                });
              }
              return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });

        await new Promise((r) => setTimeout(r, 30));
        vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
        await waitForWatchdogCurrent(ctx, convA);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);

        hoBodies.length = 0;
        copied.length = 0;
        deferNextCardCopyA = true;
        const copyAPromise = vm.runInContext("copyWatchdogRescueBrief();", ctx);
        await waitForRequestSignal(deferredReadyPromise, {
          scope: aggScope,
          scenario: "Order 1 (card Copy A)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        assert.equal(typeof deferredCardCopyA, "function", `${aggScope} Order 1: card Copy A request must be deferred`);
        assert.equal(hoBodies[0].stallConversationId, convA);

        // Open ordinary aggregate drawer while A's copy is still pending -> loads B (Gemini, 115k)
        vm.runInContext("toggleHandoffDrawer(true);", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 2);
        assert.equal(hoBodies[1].stallConversationId, undefined, `${aggScope} Order 1: ordinary drawer must omit stallConversationId`);
        assert.ok(
          elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") &&
            elements.get("kv-handoff-preview").textContent.includes("115k"),
          `${aggScope} Order 1: ordinary drawer must display B before A resolves`
        );

        // Now A's deferred copy response arrives!
        deferredCardCopyA();
        await copyAPromise;
        await waitForHandoffSettled(ctx);

        // (1) Clipboard gets A (Claude, 150k)
        assert.equal(copied.length, 1, `${aggScope} Order 1: clipboard must receive A`);
        assert.ok(copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"), `${aggScope} Order 1: clipboard must be A (Claude 150k)`);
        assert.ok(!copied[0].includes("gemini-2.5-pro") && !copied[0].includes("115k"));
        assertNoPrivateLeak(copied[0], `${aggScope} Order 1 clipboard A`);

        // (2) Ordinary drawer preview MUST stay on B (Gemini, 115k) and mode stays ordinary
        const previewAfterCopy = elements.get("kv-handoff-preview").textContent;
        assert.ok(previewAfterCopy.includes("gemini-2.5-pro") && previewAfterCopy.includes("115k"), `${aggScope} Order 1: ordinary preview must stay B after late Copy A`);
        assert.ok(!previewAfterCopy.includes("claude-opus-4-6") && !previewAfterCopy.includes("150k"), `${aggScope} Order 1: late Copy A must NOT overwrite ordinary preview`);
        assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), false, `${aggScope} Order 1: late Copy A must NOT flip drawer to targeted mode`);

        // (3) Copy button states: Fact Copy enabled (copies B), Prompt disabled
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

        // (4) Next Refresh request MUST omit stallConversationId and keep showing B
        hoBodies.length = 0;
        vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope} Order 1: ordinary drawer Refresh must omit stallConversationId`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));

        // Follow-up: Explicitly click A's "View Brief" -> preview switches to A & Refresh carries stallConversationId=A
        hoBodies.length = 0;
        vm.runInContext("openWatchdogRescueDrawer();", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA, `${aggScope} Order 1: explicit View Brief A must request convA`);
        assert.ok(
          elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6") &&
            elements.get("kv-handoff-preview").textContent.includes("150k"),
          `${aggScope} Order 1: explicit View Brief A must display A`
        );
        assert.ok(!elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

        hoBodies.length = 0;
        vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA, `${aggScope} Order 1: targeted A Refresh must carry stallConversationId=A`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6") && elements.get("kv-handoff-preview").textContent.includes("150k"));
      }

      // Order 2: Ordinary drawer ALREADY open showing B -> click card Copy A -> clipboard gets A, ordinary drawer stays B & omits stallConversationId on Refresh -> then explicit View Brief A switches to A & carries stallConversationId=A
      {
        const copied = [];
        const hoBodies = [];
        const { ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") hoBodies.push(body);
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });

        await new Promise((r) => setTimeout(r, 30));
        vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
        await new Promise((r) => setTimeout(r, 50));

        // Open ordinary drawer first -> shows B (Gemini, 115k)
        hoBodies.length = 0;
        vm.runInContext("toggleHandoffDrawer(true);", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, undefined);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));

        // Click card Copy A directly while ordinary drawer is open
        hoBodies.length = 0;
        copied.length = 0;
        await vm.runInContext("copyWatchdogRescueBrief();", ctx);
        await waitForHandoffSettled(ctx);

        // (1) Clipboard gets A (Claude, 150k)
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA);
        assert.equal(copied.length, 1, `${aggScope} Order 2: clipboard must receive A`);
        assert.ok(copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"), `${aggScope} Order 2: clipboard must be A`);
        assert.ok(!copied[0].includes("gemini-2.5-pro") && !copied[0].includes("115k"));
        assertNoPrivateLeak(copied[0], `${aggScope} Order 2 clipboard A`);

        // (2) Ordinary drawer preview MUST remain B (Gemini, 115k)
        const previewStillB = elements.get("kv-handoff-preview").textContent;
        assert.ok(previewStillB.includes("gemini-2.5-pro") && previewStillB.includes("115k"), `${aggScope} Order 2: open ordinary drawer must remain B`);
        assert.ok(!previewStillB.includes("claude-opus-4-6") && !previewStillB.includes("150k"));
        assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), false);

        // (3) Drawer Copy button enabled and copies B, Prompt disabled
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
        copied.length = 0;
        await vm.runInContext("copyHandoffBrief();", ctx);
        assert.equal(copied.length, 1);
        assert.ok(copied[0].includes("gemini-2.5-pro") && copied[0].includes("115k"));

        // (4) Next Refresh request MUST omit stallConversationId and remain B
        hoBodies.length = 0;
        vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope} Order 2: ordinary Refresh must omit stallConversationId`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));

        // Follow-up: Explicitly click A's "View Brief" -> preview switches to A & Refresh carries stallConversationId=A
        hoBodies.length = 0;
        vm.runInContext("openWatchdogRescueDrawer();", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6") && elements.get("kv-handoff-preview").textContent.includes("150k"));
        assert.ok(!elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

        hoBodies.length = 0;
        vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA, `${aggScope} Order 2: targeted A Refresh must carry stallConversationId=A`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6") && elements.get("kv-handoff-preview").textContent.includes("150k"));
      }

      // Order 3 (Reused View-Brief A request): Click A's View Brief (defer A) -> click drawer × -> click card Copy A (reuses pending A request) -> click top-right Handoff Brief (opens ordinary drawer showing B) -> release A -> clipboard receives A ONCE, ordinary preview stays B, buttons & next ordinary refresh stay correct!
      {
        reseedStalledA();
        const copied = [];
        const hoBodies = [];
        let deferNextTargetedA = false;
        let deferredTargetedA = null;
        let signalDeferredReady = null;
        const resetDeferredA = () => {
          deferNextTargetedA = true;
          deferredTargetedA = null;
          return new Promise((r) => {
            signalDeferredReady = r;
          });
        };
        const { html, ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") {
              hoBodies.push(body);
              const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
              if (deferNextTargetedA && body.stallConversationId === convA) {
                deferNextTargetedA = false;
                return await new Promise((resolve) => {
                  deferredTargetedA = () =>
                    resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json });
                  signalDeferredReady?.();
                });
              }
              return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });

        await new Promise((r) => setTimeout(r, 30));
        vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
        await waitForWatchdogCurrent(ctx, convA);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);

        // Step 1: Click A's "View Brief" via bound button handler, defer A's HTTP response
        hoBodies.length = 0;
        copied.length = 0;
        let deferredReady = resetDeferredA();
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(deferredReady, {
          scope: aggScope,
          scenario: "Order 3 (View Brief A)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        assert.equal(typeof deferredTargetedA, "function", `${aggScope} Order 3: View Brief A request must be deferred`);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA);

        // Step 2: Click drawer × to close it, then click card's "Copy Rescue Brief" (must reuse in-flight A request!)
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        assert.equal(vm.runInContext("handoffDrawerOpen", ctx), false);
        assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), true);
        const copyAPromise = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(hoBodies.length, 1, `${aggScope} Order 3: card Copy A must reuse pending View Brief A request`);

        // Step 3: Click top-right "Handoff Brief" to open ordinary drawer -> wait for B (Gemini, 115k)
        clickBoundButton(html, ctx, elements, "kv-handoff-btn");
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 2);
        assert.equal(hoBodies[1].stallConversationId, undefined, `${aggScope} Order 3: ordinary drawer must omit stallConversationId`);
        assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true);
        assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), false);
        assert.ok(
          elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") &&
            elements.get("kv-handoff-preview").textContent.includes("115k"),
          `${aggScope} Order 3: ordinary drawer must show B before A resolves`
        );

        // Step 4: Release A's deferred HTTP response
        deferredTargetedA();
        await copyAPromise;
        await waitForHandoffSettled(ctx);

        // Verify: clipboard gets A ONCE; ordinary preview stays B; Fact Copy enabled / Prompt disabled; next ordinary refresh omits stallConversationId
        assert.equal(copied.length, 1, `${aggScope} Order 3: reused A request must write A to clipboard exactly once`);
        assert.ok(
          copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"),
          `${aggScope} Order 3: clipboard content must be A (Claude 150k)`
        );
        assert.ok(!copied[0].includes("gemini-2.5-pro") && !copied[0].includes("115k"));
        assertNoPrivateLeak(copied[0], `${aggScope} Order 3 clipboard A`);

        const previewStayB = elements.get("kv-handoff-preview").textContent;
        assert.ok(
          previewStayB.includes("gemini-2.5-pro") && previewStayB.includes("115k"),
          `${aggScope} Order 3: ordinary preview must stay B after late reused A resolves`
        );
        assert.ok(!previewStayB.includes("claude-opus-4-6") && !previewStayB.includes("150k"));
        assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), false);
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
        copied.length = 0;
        await clickBoundButton(html, ctx, elements, "kv-handoff-copy-btn");
        assert.equal(copied.length, 1, `${aggScope} Order 3: ordinary Fact Copy must copy B`);
        assert.ok(copied[0].includes("gemini-2.5-pro") && copied[0].includes("115k"));

        hoBodies.length = 0;
        clickBoundButton(html, ctx, elements, "kv-handoff-refresh-btn");
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope} Order 3: next ordinary refresh must omit stallConversationId`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));

        // Control 3a: While waiting for reused A (after opening ordinary drawer B), Watchdog card switches to active B -> stale A copy must write 0 times!
        const wdActiveBRes = await httpJsonRequest(port, "/api/watchdog", {
          method: "POST",
          headers: authHeaders,
          body: { scope: aggScope, conversationId: convB, fromSidecarHost: true }
        });
        assert.equal(wdActiveBRes.status, 200);
        assert.equal(wdActiveBRes.json.current?.conversationId, convB);

        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        hoBodies.length = 0;
        copied.length = 0;
        deferredReady = resetDeferredA();
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(deferredReady, {
          scope: aggScope,
          scenario: "Control 3a (View Brief A before card switch to B)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA);

        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        const staleCardSwitchCopyP = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(hoBodies.length, 1, `${aggScope} Control 3a: card Copy A must reuse pending A request`);

        clickBoundButton(html, ctx, elements, "kv-handoff-btn");
        await waitForHandoffSettled(ctx);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));

        // Card genuinely switches to active B before A resolves
        vm.runInContext("renderWatchdogCard(wdActiveB);", Object.assign(ctx, { wdActiveB: wdActiveBRes.json }));
        await waitForHandoffSettled(ctx);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convB);

        deferredTargetedA();
        await staleCardSwitchCopyP;
        await waitForHandoffSettled(ctx);
        assert.equal(copied.length, 0, `${aggScope} Control 3a: stale reused A copy must write 0 times after card switches to B`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

        // Control 3b: While waiting for reused A (after opening ordinary drawer B), A's incident ends (A -> IDLE) -> stale A copy must write 0 times!
        await vm.runInContext("toggleHandoffDrawer(false); refreshData(false);", ctx);
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.severity", ctx), "stalled");

        hoBodies.length = 0;
        copied.length = 0;
        deferredReady = resetDeferredA();
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(deferredReady, {
          scope: aggScope,
          scenario: "Control 3b (View Brief A before A ends)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, convA);

        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        const staleEndedCopyP = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(hoBodies.length, 1, `${aggScope} Control 3b: card Copy A must reuse pending A request`);

        clickBoundButton(html, ctx, elements, "kv-handoff-btn");
        await waitForHandoffSettled(ctx);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));

        // Mark A IDLE before A's deferred response arrives
        await clickBoundButton(html, ctx, elements, "wd-clear-btn");
        await waitForHandoffSettled(ctx);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.phase", ctx), "IDLE");

        deferredTargetedA();
        await staleEndedCopyP;
        await waitForHandoffSettled(ctx);
        assert.equal(copied.length, 0, `${aggScope} Control 3b: stale reused A copy must write 0 times after A incident ends`);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
        hoBodies.length = 0;
        clickBoundButton(html, ctx, elements, "kv-handoff-refresh-btn");
        await waitForHandoffSettled(ctx);
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope} Control 3b: ordinary refresh after A ended must omit stallConversationId`);
      }

      // Control 3c: Reused A resolves WHILE ordinary drawer B is STILL loading (handoffLoading === true) -> clipboard still gets A once & B finishes rendering!
      {
        reseedStalledA();
        const copied = [];
        const hoBodies = [];
        let deferredA = null;
        let deferredB = null;
        let sigA = null;
        let sigB = null;
        const readyA = new Promise((r) => {
          sigA = r;
        });
        const readyB = new Promise((r) => {
          sigB = r;
        });
        let deferA = false;
        let deferB = false;
        const { html, ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") {
              hoBodies.push(body);
              const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
              if (deferA && body.stallConversationId === convA) {
                deferA = false;
                return await new Promise((resolve) => {
                  deferredA = () => resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json });
                  sigA();
                });
              }
              if (deferB && body.stallConversationId === undefined) {
                deferB = false;
                return await new Promise((resolve) => {
                  deferredB = () => resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json });
                  sigB();
                });
              }
              return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });

        await new Promise((r) => setTimeout(r, 30));
        vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
        await waitForWatchdogCurrent(ctx, convA);

        hoBodies.length = 0;
        copied.length = 0;
        deferA = true;
        deferB = true;
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(readyA, {
          scope: aggScope,
          scenario: "Control 3c (View Brief A)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        const copyAPromise = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(hoBodies.length, 1);

        // Open ordinary drawer B (keep B pending so handoffLoading === true!)
        clickBoundButton(html, ctx, elements, "kv-handoff-btn");
        await waitForRequestSignal(readyB, {
          scope: aggScope,
          scenario: "Control 3c (ordinary overview B)",
          expectedRequest: "POST /api/handoff (ordinary overview, stallConversationId=undefined)"
        });
        assert.equal(vm.runInContext("handoffLoading", ctx), true);

        // Release A FIRST while B is still loading!
        deferredA();
        await waitForBoundedCompletion(copyAPromise, {
          scope: aggScope,
          scenario: "Control 3c",
          operation: `reused A copy completion (copyWatchdogRescueBrief for ${convA} before releasing ordinary overview B)`
        });
        assert.equal(copied.length, 1, `${aggScope} Control 3c: reused A must still copy while ordinary B is loading`);
        assert.ok(copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"));
        assert.equal(vm.runInContext("handoffLoading", ctx), true, `${aggScope} Control 3c: superseded A must not clear B's loading state`);

        // Now release B -> ordinary drawer displays B!
        deferredB();
        await waitForHandoffSettled(ctx);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
      }

      // Control 3d: Reused rawPromise server-ahead A->IDLE recovery, HTTP 500/network rejection, rapid double-click, closed-drawer isolation, rawFetch settle cleanup & anchors.confirmed parity
      {
        reseedStalledA();
        const copied = [];
        const hoBodies = [];
        let modeA = "normal";
        let deferA = false;
        let releaseA = null;
        let sigA = null;
        const resetDeferredA = (nextMode = "normal") => {
          modeA = nextMode;
          deferA = true;
          releaseA = null;
          return new Promise((r) => {
            sigA = r;
          });
        };
        let deferWd = false;
        let releaseWd = null;
        let sigWd = null;
        const resetDeferredWd = () => {
          deferWd = true;
          releaseWd = null;
          return new Promise((r) => {
            sigWd = r;
          });
        };
        const { html, ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/watchdog" && deferWd) {
              deferWd = false;
              return await new Promise((resolve) => {
                releaseWd = async () => {
                  const res = await httpJsonRequest(port, url, { method: "POST", headers: authHeaders, body });
                  resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json });
                };
                sigWd();
              });
            }
            if (url === "/api/handoff") {
              hoBodies.push(body);
              if (modeA === "leakConfirmedAnchor" && body.stallConversationId === convA) {
                modeA = "normal";
                const curKey = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    scope: aggScope,
                    stallConversationId: convA,
                    incidentKey: curKey,
                    anchors: { confirmed: true },
                    markdown: "# LEAKED_CONFIRMED_ANCHOR"
                  })
                };
              }
              if (modeA === "leakConfirmedFlag" && body.stallConversationId === convA) {
                modeA = "normal";
                const curKey = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    mode: "agent",
                    scope: aggScope,
                    stallConversationId: convA,
                    incidentKey: curKey,
                    confirmedConversation: true,
                    anchors: { confirmed: false },
                    markdown: "# LEAKED_AGG_CONFIRMED_FLAG"
                  })
                };
              }
              if (modeA === "wrongScopeTargeted" && body.stallConversationId === convA) {
                modeA = "normal";
                const curKey = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    mode: "agent",
                    scope: aggScope === "app" ? "conversation" : "app",
                    stallConversationId: convA,
                    incidentKey: curKey,
                    confirmedConversation: false,
                    anchors: { confirmed: false },
                    markdown: "# WRONG_SCOPE_TARGETED"
                  })
                };
              }
              if (modeA === "missingScopeTargeted" && body.stallConversationId === convA) {
                modeA = "normal";
                const curKey = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    mode: "agent",
                    stallConversationId: convA,
                    incidentKey: curKey,
                    confirmedConversation: false,
                    anchors: { confirmed: false },
                    markdown: "# MISSING_SCOPE_TARGETED"
                  })
                };
              }
              if (modeA === "serverAheadBadAttr" && body.stallConversationId === convA) {
                modeA = "normal";
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    mode: "agent",
                    scope: aggScope,
                    stallConversationId: convA,
                    incidentKey: `${convA}:999999:TOOL_RUNNING:stalled:ahead`,
                    anchors: { confirmed: true },
                    markdown: "# LEAKED_SERVER_AHEAD_CONFIRMED_ANCHOR"
                  })
                };
              }
              if (modeA === "overviewLeakConfirmedAnchor" && body.stallConversationId === undefined) {
                modeA = "normal";
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    scope: aggScope,
                    anchors: { confirmed: true },
                    markdown: "# LEAKED_OVERVIEW_CONFIRMED_ANCHOR"
                  })
                };
              }
              if (modeA === "overviewWrongScope" && body.stallConversationId === undefined) {
                modeA = "normal";
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    mode: "agent",
                    scope: aggScope === "app" ? "lifetime" : "conversation",
                    confirmedConversation: false,
                    anchors: { confirmed: false },
                    markdown: "# WRONG_SCOPE_OVERVIEW"
                  })
                };
              }
              if (modeA === "overviewMissingScope" && body.stallConversationId === undefined) {
                modeA = "normal";
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({
                    ok: true,
                    mode: "agent",
                    confirmedConversation: false,
                    anchors: { confirmed: false },
                    markdown: "# MISSING_SCOPE_OVERVIEW"
                  })
                };
              }
              if (deferA && body.stallConversationId === convA) {
                deferA = false;
                const capturedMode = modeA;
                return await new Promise((resolve, reject) => {
                  releaseA = async () => {
                    if (capturedMode === "http500") {
                      resolve({ ok: false, status: 500, json: async () => ({ ok: false }) });
                    } else if (capturedMode === "netErr") {
                      reject(new Error("ECONNRESET"));
                    } else {
                      const res = await httpJsonRequest(port, url, { method: "POST", headers: authHeaders, body });
                      resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json });
                    }
                  };
                  sigA();
                });
              }
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });

        await new Promise((r) => setTimeout(r, 30));
        vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
        const deadline = Date.now() + 2000;
        let wdReady = false;
        while (Date.now() < deadline) {
          if (vm.runInContext(`Boolean(cachedWatchdog && cachedWatchdog.scope === ${JSON.stringify(aggScope)} && cachedWatchdog.current?.phase !== 'IDLE')`, ctx)) {
            wdReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!wdReady) {
          throw new Error(`Timed out waiting for initial Watchdog state (scope=${aggScope}, scenario=Control 3d setup)`);
        }
        assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);

        // (d1) Closing drawer via × mid-flight cancels drawer handoffLoading immediately, keeps rawPromise reusable for Copy A, and prevents closed-drawer snapshot writes
        hoBodies.length = 0;
        copied.length = 0;
        let readyA = resetDeferredA("normal");
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(readyA, {
          scope: aggScope,
          scenario: "Control 3d1 (View Brief A before close)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        assert.equal(vm.runInContext("handoffLoading", ctx), false, `${aggScope} Control 3d1: closing drawer must clear handoffLoading immediately`);
        const closedCopy1 = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        const closedCopy2 = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(hoBodies.length, 1, `${aggScope} Control 3d1: rapid double-click must reuse single in-flight rawPromise`);
        await releaseA();
        await Promise.all([closedCopy1, closedCopy2]);
        await waitForHandoffSettled(ctx, { scope: aggScope, scenario: "Control 3d1" });
        assert.equal(copied.length, 1, `${aggScope} Control 3d1: rapid double-click reusing rawPromise must write A exactly once`);
        assert.ok(copied[0].includes("claude-opus-4-6") && copied[0].includes("150k"));
        assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null, `${aggScope} Control 3d1: closed drawer must not receive late A snapshot`);
        assert.ok(!elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6"));

        // (d2) Reused rawPromise HTTP 500 & network error while ordinary drawer B is open -> 0 clipboard writes, B uncorrupted
        for (const errMode of ["http500", "netErr"]) {
          hoBodies.length = 0;
          copied.length = 0;
          readyA = resetDeferredA(errMode);
          clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
          await waitForRequestSignal(readyA, {
            scope: aggScope,
            scenario: `Control 3d2 (${errMode})`,
            expectedRequest: `POST /api/handoff stallConversationId=${convA}`
          });
          clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
          const errCopyP = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
          assert.equal(hoBodies.length, 1);
          clickBoundButton(html, ctx, elements, "kv-handoff-btn");
          await waitForHandoffSettled(ctx, { scope: aggScope, scenario: `Control 3d2 (${errMode}) ordinary B` });
          const previewBefore = elements.get("kv-handoff-preview").textContent;
          const metaBefore = elements.get("kv-handoff-meta").textContent;
          assert.ok(previewBefore.includes("gemini-2.5-pro") && previewBefore.includes("115k"));
          await releaseA();
          await errCopyP;
          await waitForHandoffSettled(ctx, { scope: aggScope, scenario: `Control 3d2 (${errMode}) settle` });
          assert.equal(copied.length, 0, `${aggScope} Control 3d2 (${errMode}): error must write 0 times`);
          assert.equal(elements.get("kv-handoff-preview").textContent, previewBefore);
          assert.equal(elements.get("kv-handoff-meta").textContent, metaBefore);
          assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
          assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
          clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        }

        // (d3) Unified attribution parity in unconfirmed aggregate scope: card copy, bound View Brief, server-ahead sync & ordinary overview all reject contradictory flags, wrong scope & missing modern HTTP scope
        for (const [badMode, forbiddenText] of [
          ["leakConfirmedAnchor", "LEAKED_CONFIRMED_ANCHOR"],
          ["leakConfirmedFlag", "LEAKED_AGG_CONFIRMED_FLAG"],
          ["wrongScopeTargeted", "WRONG_SCOPE_TARGETED"],
          ["missingScopeTargeted", "MISSING_SCOPE_TARGETED"],
          ["serverAheadBadAttr", "LEAKED_SERVER_AHEAD_CONFIRMED_ANCHOR"]
        ]) {
          copied.length = 0;
          modeA = badMode;
          await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
          assert.equal(copied.length, 0, `${aggScope} Control 3d3 (${badMode}): card copy must write 0 times`);

          copied.length = 0;
          modeA = badMode;
          clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
          await waitForHandoffSettled(ctx, { scope: aggScope, scenario: `Control 3d3 (${badMode}) View Brief` });
          assert.ok(
            !elements.get("kv-handoff-preview").textContent.includes(forbiddenText),
            `${aggScope} Control 3d3 (${badMode}): View Brief preview must NOT display rejected markdown`
          );
          assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null, `${aggScope} Control 3d3 (${badMode}): rejected snapshot must not be cached`);
          assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, `${aggScope} Control 3d3 (${badMode}): Fact Copy must stay disabled`);
          assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, `${aggScope} Control 3d3 (${badMode}): Prompt Copy must stay disabled`);
          await vm.runInContext("copyHandoffBrief();", ctx);
          assert.equal(copied.length, 0, `${aggScope} Control 3d3 (${badMode}): drawer copyHandoffBrief must write 0 times`);
          clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        }

        for (const [ovMode, forbiddenText] of [
          ["overviewLeakConfirmedAnchor", "LEAKED_OVERVIEW_CONFIRMED_ANCHOR"],
          ["overviewWrongScope", "WRONG_SCOPE_OVERVIEW"],
          ["overviewMissingScope", "MISSING_SCOPE_OVERVIEW"]
        ]) {
          copied.length = 0;
          modeA = ovMode;
          clickBoundButton(html, ctx, elements, "kv-handoff-btn");
          await waitForHandoffSettled(ctx, { scope: aggScope, scenario: `Control 3d3 (${ovMode}) ordinary overview` });
          assert.ok(
            !elements.get("kv-handoff-preview").textContent.includes(forbiddenText),
            `${aggScope} Control 3d3 (${ovMode}): ordinary overview preview must NOT display rejected markdown`
          );
          assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null);
          assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
          assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
          await vm.runInContext("copyHandoffBrief();", ctx);
          assert.equal(copied.length, 0);
          clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        }

        // Targeted server-ahead sync retry (_retryDepth===1) receiving contradictory payload must also reject cleanly
        {
          const wdRetryBRes = await httpJsonRequest(port, "/api/watchdog", {
            method: "POST",
            headers: authHeaders,
            body: { scope: aggScope, conversationId: convB, fromSidecarHost: true }
          });
          const wdRetryARes = await httpJsonRequest(port, "/api/watchdog", {
            method: "POST",
            headers: authHeaders,
            body: { scope: aggScope, conversationId: convA, fromSidecarHost: true }
          });
          assert.equal(wdRetryBRes.status, 200);
          assert.equal(wdRetryARes.status, 200);
          const retryCopied = [];
          const retryHoBodies = [];
          let serverSwitchedToB = false;
          const { html: rHtml, ctx: rCtx, elements: rEls } = createDashboardVmSandbox({
            sidecarObj: { conversationId: "", ui: { toggleConversation() {} } },
            copiedOut: retryCopied,
            fetchImpl: async (url, opts = {}) => {
              const body = opts.body ? JSON.parse(opts.body) : {};
              if (url === "/api/watchdog") {
                return { ok: true, status: 200, json: async () => (serverSwitchedToB ? wdRetryBRes.json : wdRetryARes.json) };
              }
              if (url === "/api/handoff") {
                retryHoBodies.push(body);
                if (body.stallConversationId === convA && serverSwitchedToB) {
                  return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                      ok: true,
                      scope: aggScope,
                      conversationId: "",
                      mode: "agent",
                      confirmedConversation: false,
                      hasStallContext: false,
                      incidentKey: "",
                      markdown: "# agy-dart Handoff Brief (Overview)",
                      bytes: 36,
                      truncated: false
                    })
                  };
                }
                if (body.stallConversationId === convB) {
                  return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                      ok: true,
                      scope: aggScope,
                      stallConversationId: convB,
                      incidentKey: wdRetryBRes.json.current.incidentKey,
                      anchors: { confirmed: true },
                      markdown: "# LEAKED_RETRY_CONFIRMED_ANCHOR"
                    })
                  };
                }
              }
              return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
          });
          await new Promise((r) => setTimeout(r, 25));
          vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, rCtx);
          const rDeadline = Date.now() + 2000;
          let rWdReady = false;
          while (Date.now() < rDeadline) {
            if (vm.runInContext(`Boolean(cachedWatchdog && cachedWatchdog.scope === ${JSON.stringify(aggScope)} && cachedWatchdog.current?.conversationId === ${JSON.stringify(convA)})`, rCtx)) {
              rWdReady = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 15));
          }
          if (!rWdReady) {
            throw new Error(`Timed out waiting for retry fixture Watchdog (scope=${aggScope}, scenario=Control 3d3 retry)`);
          }
          retryHoBodies.length = 0;
          serverSwitchedToB = true;
          clickBoundButton(rHtml, rCtx, rEls, "wd-open-rescue-btn");
          await waitForHandoffSettled(rCtx, { scope: aggScope, scenario: "Control 3d3 server-ahead retry" });
          assert.equal(retryHoBodies.length, 2, `${aggScope} Control 3d3 retry: expected initial A + synced retry B`);
          assert.equal(retryHoBodies[0].stallConversationId, convA);
          assert.equal(retryHoBodies[1].stallConversationId, convB);
          assert.ok(!rEls.get("kv-handoff-preview").textContent.includes("LEAKED_RETRY_CONFIRMED_ANCHOR"));
          assert.equal(vm.runInContext("cachedHandoffSnapshot", rCtx), null);
          assert.equal(rEls.get("kv-handoff-copy-btn").disabled, true);
          assert.equal(rEls.get("kv-handoff-prompt-btn").disabled, true);
          await vm.runInContext("copyHandoffBrief();", rCtx);
          assert.equal(retryCopied.length, 0);
        }

        // (d4) Reused rawPromise server-ahead A->IDLE recovery while ordinary drawer B is open -> 0 writes, card updates to IDLE, ordinary drawer keeps B without flickering to ended-alert mode
        hoBodies.length = 0;
        copied.length = 0;
        readyA = resetDeferredA("normal");
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(readyA, {
          scope: aggScope,
          scenario: "Control 3d4 (server-ahead A->IDLE recovery)",
          expectedRequest: `POST /api/handoff stallConversationId=${convA}`
        });
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        const srvAheadCopyP = clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(hoBodies.length, 1);
        clickBoundButton(html, ctx, elements, "kv-handoff-btn");
        await waitForHandoffSettled(ctx, { scope: aggScope, scenario: "Control 3d4 ordinary B" });
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));
        await httpJsonRequest(port, "/api/watchdog/action", {
          method: "POST",
          headers: authHeaders,
          body: { scope: aggScope, conversationId: convA, conversationConfirmed: false, fromSidecarHost: true, action: "clear" }
        });
        await releaseA();
        await srvAheadCopyP;
        const d4Deadline = Date.now() + 2000;
        let d4Settled = false;
        while (Date.now() < d4Deadline) {
          if (!vm.runInContext("Boolean(autoRefreshInFlight || handoffLoading)", ctx)) {
            await new Promise((r) => setTimeout(r, 15));
            if (!vm.runInContext("Boolean(autoRefreshInFlight || handoffLoading)", ctx)) {
              d4Settled = true;
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        if (!d4Settled) {
          throw new Error(`Timed out waiting for Control 3d4 refreshData/handoffLoading settle (scope=${aggScope})`);
        }
        assert.equal(copied.length, 0, `${aggScope} Control 3d4: server-ahead recovered reused A must write 0 times`);
        assert.equal(vm.runInContext("cachedWatchdog?.current?.phase", ctx), "IDLE");
        assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), false);
        assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), false);
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
        hoBodies.length = 0;
        clickBoundButton(html, ctx, elements, "kv-handoff-refresh-btn");
        await waitForHandoffSettled(ctx, { scope: aggScope, scenario: "Control 3d4 ordinary refresh" });
        assert.equal(hoBodies.length, 1);
        assert.equal(hoBodies[0].stallConversationId, undefined);
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");

        // (d5) handoffInFlightRequest clears immediately when rawFetch settles (NOT held during runFetch's post-fetch await refreshData(false))
        reseedStalledA();
        await vm.runInContext("refreshData(false);", ctx);
        await waitForHandoffSettled(ctx, { scope: aggScope, scenario: "Control 3d5 pre-refresh" });
        await httpJsonRequest(port, "/api/watchdog/action", {
          method: "POST",
          headers: authHeaders,
          body: { scope: aggScope, conversationId: convA, conversationConfirmed: false, fromSidecarHost: true, action: "clear" }
        });
        const readyWd = resetDeferredWd();
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForRequestSignal(readyWd, {
          scope: aggScope,
          scenario: "Control 3d5 (server-ahead Watchdog refresh)",
          expectedRequest: "POST /api/watchdog"
        });
        assert.equal(
          vm.runInContext("Boolean(handoffInFlightRequest)", ctx),
          false,
          `${aggScope} Control 3d5: handoffInFlightRequest must clear as soon as rawFetch settles, before await refreshData(false)`
        );
        await releaseWd();
        await waitForHandoffSettled(ctx, { scope: aggScope, scenario: "Control 3d5 post-refresh" });
      }
    }

    // Control 3e (confirmed conversation scope + unconfirmed overview + Watchdog cache + legacy anchorless compat):
    // Consistent raw attribution validation across card copy, bound View Brief, ordinary drawer, server-ahead sync & Watchdog rescueBrief cache
    {
      reseedStalledA();
      const copied = [];
      let hoOverride = null;
      let wdRescueOverride = "strip";
      let wdIncidentOverride = "";
      const { html, ctx, elements } = createDashboardVmSandbox({
        sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/watchdog") {
            const res = await httpJsonRequest(port, url, { method: "POST", headers: authHeaders, body });
            const j = structuredClone(res.json);
            if (j.current) {
              if (wdIncidentOverride) {
                j.current.incidentKey = wdIncidentOverride;
              }
              if (wdRescueOverride === "strip") {
                delete j.current.rescueBrief;
              } else if (wdRescueOverride && typeof wdRescueOverride === "object") {
                j.current.rescueBrief = structuredClone(wdRescueOverride);
              }
            }
            return { ok: true, status: 200, json: async () => j };
          }
          if (url === "/api/handoff") {
            if (hoOverride) {
              const curKey = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);
              const payload = typeof hoOverride === "function" ? hoOverride(curKey) : hoOverride;
              return { ok: true, status: 200, json: async () => payload };
            }
          }
          const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });
      const convDeadline = Date.now() + 2000;
      let convWdReady = false;
      while (Date.now() < convDeadline) {
        if (vm.runInContext("Boolean(isCurrentConversationConfirmed() && cachedWatchdog?.current?.phase && cachedWatchdog.current.phase !== 'IDLE')", ctx)) {
          convWdReady = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      if (!convWdReady) {
        throw new Error("Timed out waiting for confirmed conversation Watchdog state (scope=conversation, scenario=Control 3e)");
      }
      assert.equal(vm.runInContext("isCurrentConversationConfirmed()", ctx), true);

      // (e1) Confirmed HTTP payloads with contradictory flags, wrong scope, mismatched conversationId, or mismatched anchors.conversationId -> rejected identically by Card Copy, Bound View Brief & Ordinary Drawer
      const badConfirmedCases = [
        [
          "anchorsConfirmedFalse",
          "LEAKED_UNCONFIRMED_ANCHOR",
          (curKey) => ({
            ok: true,
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: false },
            incidentKey: curKey,
            markdown: "# LEAKED_UNCONFIRMED_ANCHOR"
          })
        ],
        [
          "confirmedFlagFalse",
          "LEAKED_CONTRADICTORY_FLAG",
          (curKey) => ({
            ok: true,
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: false,
            anchors: { confirmed: true, conversationId: convA },
            incidentKey: curKey,
            markdown: "# LEAKED_CONTRADICTORY_FLAG"
          })
        ],
        [
          "wrongScopeApp",
          "LEAKED_WRONG_SCOPE_CONV",
          (curKey) => ({
            ok: true,
            mode: "agent",
            scope: "app",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convA },
            incidentKey: curKey,
            markdown: "# LEAKED_WRONG_SCOPE_CONV"
          })
        ],
        [
          "wrongConvId",
          "LEAKED_WRONG_CONV_ID",
          (curKey) => ({
            ok: true,
            mode: "agent",
            scope: "conversation",
            conversationId: convB,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convB },
            incidentKey: curKey,
            markdown: "# LEAKED_WRONG_CONV_ID"
          })
        ],
        [
          "wrongAnchorConvId",
          "LEAKED_WRONG_ANCHOR_CONV",
          (curKey) => ({
            ok: true,
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convB },
            incidentKey: curKey,
            markdown: "# LEAKED_WRONG_ANCHOR_CONV"
          })
        ],
        [
          "serverAheadBadConfirmed",
          "LEAKED_SERVER_AHEAD_UNCONFIRMED",
          () => ({
            ok: true,
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: false },
            incidentKey: `${convA}:999999:TOOL_RUNNING:stalled:ahead`,
            markdown: "# LEAKED_SERVER_AHEAD_UNCONFIRMED"
          })
        ],
        [
          "missingScopeConfirmedHttp",
          "LEAKED_MISSING_SCOPE_HTTP",
          (curKey) => ({
            ok: true,
            mode: "agent",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convA },
            incidentKey: curKey,
            markdown: "# LEAKED_MISSING_SCOPE_HTTP"
          })
        ],
        [
          "missingTopConvIdHttp",
          "LEAKED_ANCHOR_ONLY_HTTP",
          (curKey) => ({
            ok: true,
            mode: "agent",
            scope: "conversation",
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convA },
            incidentKey: curKey,
            markdown: "# LEAKED_ANCHOR_ONLY_HTTP"
          })
        ]
      ];

      for (const [caseName, forbiddenText, makePayload] of badConfirmedCases) {
        hoOverride = makePayload;

        copied.length = 0;
        await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(copied.length, 0, `Control 3e (${caseName}): card copy must reject and write 0 times`);

        for (const [entryLabel, btnId] of [
          ["View Brief", "wd-open-rescue-btn"],
          ["Ordinary Drawer", "kv-handoff-btn"]
        ]) {
          copied.length = 0;
          clickBoundButton(html, ctx, elements, btnId);
          await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `Control 3e (${caseName}) ${entryLabel}` });
          assert.ok(
            !elements.get("kv-handoff-preview").textContent.includes(forbiddenText),
            `Control 3e (${caseName}) ${entryLabel}: preview must NOT show rejected markdown`
          );
          assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null, `Control 3e (${caseName}) ${entryLabel}: invalid snapshot must not be cached`);
          assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, `Control 3e (${caseName}) ${entryLabel}: Fact Copy must stay disabled`);
          assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, `Control 3e (${caseName}) ${entryLabel}: Prompt Copy must stay disabled`);
          await vm.runInContext("copyHandoffBrief(); copyHandoffPrompt();", ctx);
          assert.equal(copied.length, 0, `Control 3e (${caseName}) ${entryLabel}: drawer copy must write 0 times`);
          clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        }
      }

      // (e2) Watchdog cached rescueBrief in confirmed conversation: contradictory flags, wrong scope, or mismatched conversationId/anchors.conversationId -> getMatchingRescueBrief() returns null; neither card copy nor drawer shows/copies cache
      hoOverride = badConfirmedCases[0][2];
      const baseCurKey = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);
      const badCachedRescueCases = [
        [
          "cachedAnchorsConfirmedFalse",
          "CACHED_LEAKED_UNCONFIRMED_ANCHOR",
          {
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: false },
            incidentKey: baseCurKey,
            markdown: "# CACHED_LEAKED_UNCONFIRMED_ANCHOR"
          }
        ],
        [
          "cachedConfirmedFlagFalse",
          "CACHED_LEAKED_CONTRADICTORY",
          {
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: false,
            anchors: { confirmed: true, conversationId: convA },
            incidentKey: baseCurKey,
            markdown: "# CACHED_LEAKED_CONTRADICTORY"
          }
        ],
        [
          "cachedWrongScope",
          "CACHED_LEAKED_WRONG_SCOPE",
          {
            mode: "agent",
            scope: "app",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convA },
            incidentKey: baseCurKey,
            markdown: "# CACHED_LEAKED_WRONG_SCOPE"
          }
        ],
        [
          "cachedWrongConvId",
          "CACHED_LEAKED_WRONG_CONV",
          {
            mode: "agent",
            scope: "conversation",
            conversationId: convB,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convB },
            incidentKey: baseCurKey,
            markdown: "# CACHED_LEAKED_WRONG_CONV"
          }
        ],
        [
          "cachedWrongAnchorConvId",
          "CACHED_LEAKED_WRONG_ANCHOR_CONV",
          {
            mode: "agent",
            scope: "conversation",
            conversationId: convA,
            confirmedConversation: true,
            anchors: { confirmed: true, conversationId: convB },
            incidentKey: baseCurKey,
            markdown: "# CACHED_LEAKED_WRONG_ANCHOR_CONV"
          }
        ]
      ];
      for (const [cacheName, forbiddenCacheText, badRescue] of badCachedRescueCases) {
        wdRescueOverride = badRescue;
        await vm.runInContext("refreshData(false);", ctx);
        assert.equal(
          vm.runInContext("getMatchingRescueBrief()", ctx),
          null,
          `Control 3e (${cacheName}): getMatchingRescueBrief must reject invalid cached agent brief`
        );
        copied.length = 0;
        await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(copied.length, 0, `Control 3e (${cacheName}): card copy must not copy invalid cached brief`);

        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `Control 3e (${cacheName}) View Brief` });
        assert.ok(!elements.get("kv-handoff-preview").textContent.includes(forbiddenCacheText));
        assert.ok(!elements.get("kv-handoff-preview").textContent.includes("LEAKED_UNCONFIRMED_ANCHOR"));
        assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null);
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
      }

      // (e2b) Server-ahead incident sync in confirmed conversation: poisoned Watchdog rescueBrief during refreshData(false) is rejected in favor of valid HTTP snapshot
      {
        const aheadKey = `${convA}:777777:TOOL_RUNNING:stalled:ahead_sync`;
        wdIncidentOverride = "";
        wdRescueOverride = "strip";
        await vm.runInContext("refreshData(false);", ctx);
        wdIncidentOverride = aheadKey;
        wdRescueOverride = {
          mode: "agent",
          scope: "conversation",
          conversationId: convA,
          confirmedConversation: true,
          anchors: { confirmed: false },
          incidentKey: aheadKey,
          markdown: "# POISONED_SYNC_RESCUE_CACHE"
        };
        hoOverride = () => ({
          ok: true,
          mode: "agent",
          scope: "conversation",
          conversationId: convA,
          confirmedConversation: true,
          anchors: { confirmed: true, conversationId: convA, resumeSameWindow: "ctx_resume({})", resumeCrossWindow: "" },
          incidentKey: aheadKey,
          markdown: "# VALID_SYNC_HTTP_BRIEF",
          summary: "ahead",
          bytes: 23,
          truncated: false
        });
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForHandoffSettled(ctx, { scope: "conversation", scenario: "Control 3e server-ahead poisoned cache" });
        assert.ok(elements.get("kv-handoff-preview").textContent.includes("VALID_SYNC_HTTP_BRIEF"));
        assert.ok(!elements.get("kv-handoff-preview").textContent.includes("POISONED_SYNC_RESCUE_CACHE"));
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
        wdIncidentOverride = "";
      }

      // (e3) Positive confirmed conversation control: valid Watchdog cache & valid HTTP both pass and enable Fact Copy + Semantic Prompt Copy
      wdRescueOverride = null; // keep real server rescueBrief
      hoOverride = null;
      await vm.runInContext("refreshData(false);", ctx);
      const validCached = vm.runInContext("getMatchingRescueBrief()", ctx);
      assert.ok(validCached && validCached.confirmedConversation === true && validCached.markdown.includes("PRIVATE_QUOTE_A_SECRET"));
      copied.length = 0;
      await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
      assert.equal(copied.length, 1, "Control 3e positive cache: valid confirmed rescueBrief must copy once");
      assert.ok(copied[0].includes("PRIVATE_QUOTE_A_SECRET"));

      clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
      await waitForHandoffSettled(ctx, { scope: "conversation", scenario: "Control 3e positive cache View Brief" });
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("PRIVATE_QUOTE_A_SECRET"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
      clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");

      // Valid HTTP path (no cache)
      wdRescueOverride = "strip";
      await vm.runInContext("refreshData(false);", ctx);
      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      await waitForHandoffSettled(ctx, { scope: "conversation", scenario: "Control 3e positive HTTP drawer" });
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("PRIVATE_QUOTE_A_SECRET"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
      copied.length = 0;
      await clickBoundButton(html, ctx, elements, "kv-handoff-copy-btn");
      assert.equal(copied.length, 1);
      clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");

      // (e4) Unconfirmed conversation ordinary overview (?conversationId=__unbound__) rejects wrong scope & confirmed anchors, then succeeds on normal overview
      {
        const uCopied = [];
        let uMode = "wrongScope";
        const { html: uHtml, ctx: uCtx, elements: uEls } = createDashboardVmSandbox({
          initialSearch: "?conversationId=__unbound__",
          copiedOut: uCopied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff" && uMode !== "normal") {
              const m = uMode;
              uMode = "normal";
              return {
                ok: true,
                status: 200,
                json: async () =>
                    m === "wrongScope"
                      ? {
                          ok: true,
                          mode: "agent",
                          scope: "app",
                          confirmedConversation: false,
                          anchors: { confirmed: false },
                          markdown: "# UNCONF_WRONG_SCOPE"
                        }
                      : m === "missingScope"
                        ? {
                            ok: true,
                            mode: "agent",
                            confirmedConversation: false,
                            anchors: { confirmed: false },
                            markdown: "# UNCONF_MISSING_SCOPE"
                          }
                        : {
                            ok: true,
                            scope: "conversation",
                            anchors: { confirmed: true },
                            markdown: "# UNCONF_LEAKED_ANCHOR"
                          }
              };
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
          }
        });
        await new Promise((r) => setTimeout(r, 30));
        for (const [m, badTxt] of [
          ["wrongScope", "UNCONF_WRONG_SCOPE"],
          ["missingScope", "UNCONF_MISSING_SCOPE"],
          ["leakAnchor", "UNCONF_LEAKED_ANCHOR"]
        ]) {
          uMode = m;
          uCopied.length = 0;
          clickBoundButton(uHtml, uCtx, uEls, "kv-handoff-btn");
          await waitForHandoffSettled(uCtx, { scope: "conversation", scenario: `Control 3e unbound (${m})` });
          assert.ok(!uEls.get("kv-handoff-preview").textContent.includes(badTxt));
          assert.equal(vm.runInContext("cachedHandoffSnapshot", uCtx), null);
          assert.equal(uEls.get("kv-handoff-copy-btn").disabled, true);
          assert.equal(uEls.get("kv-handoff-prompt-btn").disabled, true);
          await vm.runInContext("copyHandoffBrief();", uCtx);
          assert.equal(uCopied.length, 0);
          clickBoundButton(uHtml, uCtx, uEls, "kv-handoff-close-btn");
        }
        uMode = "normal";
        clickBoundButton(uHtml, uCtx, uEls, "kv-handoff-btn");
        await waitForHandoffSettled(uCtx, { scope: "conversation", scenario: "Control 3e unbound normal" });
        assert.ok(uEls.get("kv-handoff-preview").textContent.includes("# agy-dart Handoff Brief"));
        assert.equal(uEls.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(uEls.get("kv-handoff-prompt-btn").disabled, true);
      }

      // (e5) Legacy v1.4 standalone anchorless rescueBrief compatibility preserved (and still enforces scope when present)
      {
        const legCopied = [];
        const { html: lHtml, ctx: lCtx, elements: lEls } = createDashboardVmSandbox({
          copiedOut: legCopied,
          fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
        });
        const makeLegacyWd = (extraRescue = {}) => ({
          ok: true,
          enabled: true,
          current: {
            conversationId: convA,
            phase: "TOOL_RUNNING",
            severity: "stalled",
            rawSeverity: "stalled",
            incidentKey: `${convA}:legacy:TOOL_RUNNING:stalled:cmd`,
            rescueBrief: {
              markdown: "# LEGACY_ANCHORLESS_OK",
              summary: "stall=stalled",
              bytes: 22,
              truncated: false,
              ...extraRescue
            }
          },
          sessions: [],
          alertingSessions: []
        });
        vm.runInContext("renderWatchdogCard(legBadScope);", Object.assign(lCtx, { legBadScope: makeLegacyWd({ scope: "app" }) }));
        assert.equal(vm.runInContext("getMatchingRescueBrief()", lCtx), null, "Legacy anchorless brief with mismatched scope must be rejected");

        vm.runInContext("renderWatchdogCard(legOk);", Object.assign(lCtx, { legOk: makeLegacyWd() }));
        assert.ok(vm.runInContext("getMatchingRescueBrief()?.markdown", lCtx)?.includes("LEGACY_ANCHORLESS_OK"));
        await clickBoundButton(lHtml, lCtx, lEls, "wd-copy-rescue-btn");
        assert.equal(legCopied.length, 1);
        assert.ok(legCopied[0].includes("LEGACY_ANCHORLESS_OK"));
        clickBoundButton(lHtml, lCtx, lEls, "wd-open-rescue-btn");
        assert.ok(lEls.get("kv-handoff-preview").textContent.includes("LEGACY_ANCHORLESS_OK"));
        assert.equal(lEls.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(lEls.get("kv-handoff-prompt-btn").disabled, true);
      }
    }

    // 6. Drawer Fix Scenario 2: Open targeted A View Brief -> mark A IDLE (card stays A/IDLE, B still alerting) -> mark ended, clear old preview, disable copy, NEVER auto-substitute B; one-click top-right Handoff Brief button switches ended drawer to ordinary B; ordinary toggle & × close preserved; genuine card switch to active B re-validates & shows B; server-ahead A recovery in loadHandoffBrief retry branch also marks ended without ordinary fallback. Covered in BOTH `app` and `lifetime`.
    for (const aggScope of ["app", "lifetime"]) {
      reseedStalledA();
      const copied = [];
      const hoBodies = [];
      const { html, ctx, elements } = createDashboardVmSandbox({
        sidecarObj: { conversationId: convA, ui: { toggleConversation() {} } },
        copiedOut: copied,
        fetchImpl: async (url, opts = {}) => {
          const body = opts.body ? JSON.parse(opts.body) : {};
          if (url === "/api/handoff") hoBodies.push(body);
          const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
        }
      });

      await new Promise((r) => setTimeout(r, 30));
      vm.runInContext(`setScope(${JSON.stringify(aggScope)});`, ctx);
      await waitForWatchdogCurrent(ctx, convA);

      // Open A's View Brief -> shows A (Claude 150k), Copy enabled
      hoBodies.length = 0;
      vm.runInContext("openWatchdogRescueDrawer();", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, convA);
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6") && elements.get("kv-handoff-preview").textContent.includes("150k"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

      // Mark A idle via real HTTP /api/watchdog/action (`clear`): card remains A/IDLE while B is still alerting!
      hoBodies.length = 0;
      copied.length = 0;
      await vm.runInContext("markWatchdogIdle();", ctx);
      await waitForHandoffSettled(ctx);

      assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA, `${aggScope}: card must still be A after markIdle`);
      assert.equal(vm.runInContext("cachedWatchdog?.current?.phase", ctx), "IDLE", `${aggScope}: card A must be IDLE`);
      assert.equal(vm.runInContext("cachedWatchdog?.alertingSessions?.[0]?.conversationId", ctx), convB, `${aggScope}: B must still be alerting`);

      // (1) ZERO /api/handoff requests emitted (no automatic fallback to ordinary B!)
      assert.equal(hoBodies.length, 0, `${aggScope}: A->IDLE must NOT emit automatic ordinary /api/handoff`);
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true);
      assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), true);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), true);

      // (2) Old A preview cleared, marked as incident ended, B NOT substituted (and i18n switch preserves ended notice)
      const endedMetaEn = elements.get("kv-handoff-meta").textContent;
      const endedPreviewEn = elements.get("kv-handoff-preview").textContent;
      assert.ok(endedMetaEn.includes("Incident ended"), `${aggScope}: meta must mark incident ended (got: ${endedMetaEn})`);
      assert.ok(endedPreviewEn.includes("ended"), `${aggScope}: preview must show incident ended notice`);
      assert.ok(!endedPreviewEn.includes("claude-opus-4-6") && !endedPreviewEn.includes("150k"), `${aggScope}: old A preview must be cleared`);
      assert.ok(!endedPreviewEn.includes("gemini-2.5-pro") && !endedPreviewEn.includes("115k"), `${aggScope}: must NOT substitute B while card is A/IDLE`);
      vm.runInContext("setLanguage('zh', false);", ctx);
      assert.ok(elements.get("kv-handoff-meta").textContent.includes("事件已结束"));
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("已结束"));
      vm.runInContext("setLanguage('en', false);", ctx);
      assert.ok(elements.get("kv-handoff-meta").textContent.includes("Incident ended"));

      // (3) Copy buttons disabled & copyHandoffBrief() writes nothing to clipboard
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, `${aggScope}: Copy Fact Brief must be disabled when targeted A ended`);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
      await vm.runInContext("copyHandoffBrief();", ctx);
      assert.equal(copied.length, 0, `${aggScope}: copyHandoffBrief must not copy ended brief`);

      // (4) Refresh & subsequent Watchdog poll while card is still A/IDLE MUST NOT emit ordinary /api/handoff or substitute B
      hoBodies.length = 0;
      await vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
      await vm.runInContext("refreshData(false);", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 0, `${aggScope}: Refresh & poll while card is A/IDLE must NOT fetch B`);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
      assert.ok(!elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));

      // (5a) Clicking top-right "Handoff Brief" button ONCE via its actual bound onclick handler switches ended drawer straight to ordinary overview (B) without closing first; ordinary toggle & × close stay intact
      hoBodies.length = 0;
      copied.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true, `${aggScope}: clicking Handoff Brief once from ended state must keep drawer open`);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), false, `${aggScope}: drawer must remain visible after one-click switch to overview`);
      assert.equal(hoBodies.length, 1, `${aggScope}: one click from ended state must emit exactly 1 ordinary /api/handoff request`);
      assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope}: explicit ordinary overview must omit stallConversationId`);
      assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), false);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), false);
      assert.ok(
        elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") &&
          elements.get("kv-handoff-preview").textContent.includes("115k"),
        `${aggScope}: explicit ordinary overview must display B`
      );
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
      await clickBoundButton(html, ctx, elements, "kv-handoff-copy-btn");
      assert.equal(copied.length, 1);
      assert.ok(copied[0].includes("gemini-2.5-pro") && copied[0].includes("115k"));

      // Ordinary drawer Refresh omits stallConversationId
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-refresh-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, undefined, `${aggScope}: ordinary Refresh after one-click switch must omit stallConversationId`);

      // Ordinary drawer toggle via #kv-handoff-btn still closes (0 requests) and reopens (1 ordinary request)
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), false, `${aggScope}: clicking Handoff Brief on open ordinary drawer must close it`);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), true);
      assert.equal(hoBodies.length, 0, `${aggScope}: closing ordinary drawer must emit 0 requests`);

      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true, `${aggScope}: clicking Handoff Brief on closed drawer must reopen ordinary overview`);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), false);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, undefined);
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));

      // Ordinary drawer × button still closes cleanly (0 requests)
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), false, `${aggScope}: clicking × on ordinary drawer must close it`);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), true);
      assert.equal(hoBodies.length, 0);

      // (5a-close) Clicking × directly from ended targeted state closes drawer cleanly with 0 requests
      reseedStalledA();
      await vm.runInContext("refreshData(false);", ctx);
      await waitForHandoffSettled(ctx);
      clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
      await waitForHandoffSettled(ctx);
      await clickBoundButton(html, ctx, elements, "wd-clear-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), true);
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), false, `${aggScope}: clicking × from ended state must close drawer`);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), true);
      assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), false);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), false);
      assert.equal(hoBodies.length, 0, `${aggScope}: clicking × from ended state must emit 0 requests`);

      // (5b) From A's ended targeted drawer, card genuinely switches to B's active alerting event -> re-validates with stallConversationId=B & displays B
      reseedStalledA();
      await vm.runInContext("refreshData(false);", ctx);
      await waitForHandoffSettled(ctx);
      hoBodies.length = 0;
      vm.runInContext("openWatchdogRescueDrawer();", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies[0].stallConversationId, convA);
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6"));

      hoBodies.length = 0;
      await vm.runInContext("markWatchdogIdle();", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 0);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), true);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);

      const wdActiveBRes = await httpJsonRequest(port, "/api/watchdog", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: convB, fromSidecarHost: true }
      });
      assert.equal(wdActiveBRes.status, 200);
      assert.equal(wdActiveBRes.json.current?.conversationId, convB);
      hoBodies.length = 0;
      copied.length = 0;
      vm.runInContext("renderWatchdogCard(wdActiveB);", Object.assign(ctx, { wdActiveB: wdActiveBRes.json }));
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1, `${aggScope}: card switch to active B must fetch targeted B once`);
      assert.equal(hoBodies[0].stallConversationId, convB, `${aggScope}: card switch to active B must re-validate with stallConversationId=B`);
      assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), true);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), false);
      assert.ok(
        elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") &&
          elements.get("kv-handoff-preview").textContent.includes("115k"),
        `${aggScope}: re-validated active B card must display B`
      );
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);
      await vm.runInContext("copyHandoffBrief();", ctx);
      assert.equal(copied.length, 1);
      assert.ok(copied[0].includes("gemini-2.5-pro") && copied[0].includes("115k"));

      hoBodies.length = 0;
      vm.runInContext("loadHandoffBrief({ forceRefresh: true });", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, convB, `${aggScope}: Refresh after active B switch must carry stallConversationId=B`);

      // (5c) Server-ahead A->IDLE recovery inside loadHandoffBrief() retry branch -> marks ended, clears preview, disables copy, NEVER falls back to ordinary B
      reseedStalledA();
      await vm.runInContext("toggleHandoffDrawer(false); refreshData(false);", ctx);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);
      assert.equal(vm.runInContext("cachedWatchdog?.current?.severity", ctx), "stalled");

      // Mark A idle on server behind the client's back (server-ahead recovery while B still alerts)
      const clearAheadRes = await httpJsonRequest(port, "/api/watchdog/action", {
        method: "POST",
        headers: authHeaders,
        body: { scope: aggScope, conversationId: convA, conversationConfirmed: false, fromSidecarHost: true, action: "clear" }
      });
      assert.equal(clearAheadRes.status, 200);
      assert.equal(clearAheadRes.json.status?.current?.phase, "IDLE");

      hoBodies.length = 0;
      copied.length = 0;
      vm.runInContext("openWatchdogRescueDrawer();", ctx);
      await waitForHandoffSettled(ctx);
      assert.equal(hoBodies.length, 1, `${aggScope}: server-ahead A->IDLE retry branch must NOT issue ordinary fallback /api/handoff`);
      assert.equal(hoBodies[0].stallConversationId, convA);
      assert.equal(vm.runInContext("cachedWatchdog?.current?.conversationId", ctx), convA);
      assert.equal(vm.runInContext("cachedWatchdog?.current?.phase", ctx), "IDLE");
      assert.equal(vm.runInContext("handoffDrawerTargetedAlert", ctx), true);
      assert.equal(vm.runInContext("handoffDrawerTargetedEnded", ctx), true);
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, true);
      assert.ok(elements.get("kv-handoff-meta").textContent.includes("Incident ended"));
      assert.ok(!elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro"));
      assert.ok(!elements.get("kv-handoff-preview").textContent.includes("claude-opus-4-6"));
      await vm.runInContext("copyHandoffBrief();", ctx);
      assert.equal(copied.length, 0);

      // (5c-click) One-click #kv-handoff-btn from server-ahead ended state also transitions straight to ordinary B (1 untargeted request)
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), false);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, undefined);
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));
      assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
      assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true);

      // (5d) Active (non-ended) targeted drawer: clicking #kv-handoff-btn closes with 0 requests, second click opens ordinary B
      reseedStalledA();
      await vm.runInContext("toggleHandoffDrawer(false); refreshData(false);", ctx);
      await waitForHandoffSettled(ctx);
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("handoffDrawerTargetedAlert && !handoffDrawerTargetedEnded", ctx), true);
      hoBodies.length = 0;
      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), false, `${aggScope}: #kv-handoff-btn on active targeted drawer must close`);
      assert.equal(elements.get("kv-handoff-drawer").classList.contains("hidden"), true);
      assert.equal(hoBodies.length, 0);
      clickBoundButton(html, ctx, elements, "kv-handoff-btn");
      await waitForHandoffSettled(ctx);
      assert.equal(vm.runInContext("handoffDrawerOpen", ctx), true);
      assert.equal(hoBodies.length, 1);
      assert.equal(hoBodies[0].stallConversationId, undefined);
      assert.ok(elements.get("kv-handoff-preview").textContent.includes("gemini-2.5-pro") && elements.get("kv-handoff-preview").textContent.includes("115k"));
    }

    // 7. Long conversation IDs (96, 97, 128 ASCII chars + redacted display anchor) using REAL generator, REAL /api/handoff & REAL Watchdog rescueBrief cache,
    //    plus shared 93-char prefix collision rejection, direct builder attribution retention & modern HTTP missing-scope vs Watchdog inner-scope omission parity.
    {
      const convLen96 = `conv-len96-${"a".repeat(85)}`;
      const sharedPrefix93 = `conv-long-shared-prefix-${"x".repeat(69)}`;
      const convLen97A = `${sharedPrefix93}AAAA`;
      const convLen97B = `${sharedPrefix93}BBBB`;
      const convLen128A = `${sharedPrefix93}${"A".repeat(35)}`;
      const convLen128B = `${sharedPrefix93}${"B".repeat(35)}`;
      const convRedacted96 = `${"r".repeat(75)}-AKIA0123456789ABCDEF`; // 96 chars raw -> 101 bytes redacted -> truncated to 93 + "..."
      assert.equal(convLen96.length, 96);
      assert.equal(sharedPrefix93.length, 93);
      assert.equal(convLen97A.length, 97);
      assert.equal(convLen97B.length, 97);
      assert.equal(convLen128A.length, 128);
      assert.equal(convLen128B.length, 128);
      assert.equal(convRedacted96.length, 96);

      const longCases = [
        { id: convLen96, tag: "LONG96", expectedAnchor: convLen96 },
        { id: convLen97A, tag: "LONG97_A", expectedAnchor: `${sharedPrefix93}...` },
        { id: convLen97B, tag: "LONG97_B", expectedAnchor: `${sharedPrefix93}...` },
        { id: convLen128A, tag: "LONG128_A", expectedAnchor: `${sharedPrefix93}...` },
        { id: convLen128B, tag: "LONG128_B", expectedAnchor: `${sharedPrefix93}...` },
        {
          id: convRedacted96,
          tag: "LONG96_REDACTED",
          expectedAnchor: `${`${"r".repeat(75)}-[REDACTED:AWS_ACCESS_KEY]`.slice(0, 93)}...`
        }
      ];

      const longStore = new ContextModeStore({ dbPath: tmpDb });
      try {
        for (const item of longCases) {
          const dir = path.join(brainRoot, item.id, ".system_generated", "logs");
          fs.mkdirSync(dir, { recursive: true });
          const txPath = path.join(dir, "transcript.jsonl");
          fs.writeFileSync(
            txPath,
            JSON.stringify({
              type: "USER_INPUT",
              step_index: 1,
              user_input: `<USER_REQUEST>QUOTE_${item.tag}_UNIQUE</USER_REQUEST>`
            }) + "\n",
            "utf8"
          );
          fs.utimesSync(txPath, oldMtimeSec, oldMtimeSec);
          fs.writeFileSync(path.join(brainRoot, item.id, "task.md"), `- [/] TASK_${item.tag}_UNIQUE\n`, "utf8");
          recordHookLeaseTransition(
            longStore,
            "PreInvocation",
            {
              conversationId: item.id,
              cwd: wsA,
              lastUserInput: `INPUT_${item.tag}_UNIQUE`,
              transcriptPath: txPath
            },
            { nowMs: baseNow + 5_000, model: "claude-opus-4-6", contextTokens: 120000 }
          );
          longStore.recordVerificationResult(item.id, {
            kind: "test",
            command: `npm test -- ${item.tag}`,
            exitCode: 0,
            passed: true,
            summary: `PASS_${item.tag}`,
            worktree: wsA
          });
        }

        // Direct buildHandoffBrief({ mode: "agent" }) preserves full verifiable conversationId + scope alongside 96-byte display anchor
        const direct97A = buildHandoffBrief({
          store: longStore,
          mode: "agent",
          scope: "conversation",
          conversationId: convLen97A,
          conversationConfirmed: true,
          sessionId: convLen97A,
          cwd: wsA,
          brainRoots: [brainRoot]
        });
        const direct97B = buildHandoffBrief({
          store: longStore,
          mode: "agent",
          scope: "conversation",
          conversationId: convLen97B,
          conversationConfirmed: true,
          sessionId: convLen97B,
          cwd: wsA,
          brainRoots: [brainRoot]
        });
        assert.equal(direct97A.scope, "conversation");
        assert.equal(direct97A.confirmedConversation, true);
        assert.equal(direct97A.conversationId, convLen97A, "Direct builder must retain full 97-char conversationId");
        assert.equal(direct97B.conversationId, convLen97B, "Direct builder must distinguish sibling 97-char conversationId");
        assert.equal(direct97A.anchors.conversationId, `${sharedPrefix93}...`);
        assert.equal(direct97B.anchors.conversationId, `${sharedPrefix93}...`);
        assert.notEqual(direct97A.conversationId, direct97B.conversationId);

        assert.equal(direct97A.secretRedactionEnabled, true);
        assert.equal(direct97A.anchors.resumeCrossWindow, `ctx_resume({ sessionId: ${JSON.stringify(convLen97A)} })`);
        assert.equal(direct97A.resumeCommand, `ctx_resume({ sessionId: ${JSON.stringify(convLen97A)} })`);

        const directRedacted = buildHandoffBrief({
          store: longStore,
          mode: "agent",
          scope: "conversation",
          conversationId: convRedacted96,
          conversationConfirmed: true,
          sessionId: convRedacted96,
          cwd: wsA,
          brainRoots: [brainRoot]
        });
        assert.equal(directRedacted.conversationId, convRedacted96);
        assert.equal(directRedacted.secretRedactionEnabled, true);
        assert.equal(
          directRedacted.anchors.conversationId,
          `${`${"r".repeat(75)}-[REDACTED:AWS_ACCESS_KEY]`.slice(0, 93)}...`
        );
        assert.equal(directRedacted.anchors.resumeCrossWindow, "", "Redacted checkpoint ID must downgrade cross-window resume to empty");
        assert.equal(directRedacted.resumeCommand, "ctx_resume({})", "Redacted checkpoint ID must fall back to same-window resumeCommand");
        assert.ok(directRedacted.markdown.includes("ctx_resume({})"), "Redacted checkpoint brief must still include same-window resume");
        assert.ok(!directRedacted.markdown.includes("AKIA0123456789ABCDEF"), "Redacted checkpoint brief markdown must not leak raw secret ID");
        assert.ok(!directRedacted.markdown.includes("ctx_resume({ sessionId:"), "Redacted checkpoint brief must not emit placeholder/raw cross-window sessionId");

        // Parent-mapped checkpoint ID checks:
        // (a) Safe child conversation + secret-bearing parent checkpoint sessionId -> downgrade to same-window only
        const safeChildConv = "conv-child-safe-parent-redacted";
        const secretParentSid = "parent-session-AKIA0123456789ABCDEF";
        longStore.recordVerificationResult(secretParentSid, {
          kind: "test",
          command: "npm test -- PARENT_SECRET",
          exitCode: 0,
          passed: true,
          summary: "PASS_PARENT_SECRET",
          worktree: wsA
        });
        const briefSecretParent = buildHandoffBrief({
          store: longStore,
          mode: "agent",
          scope: "conversation",
          conversationId: safeChildConv,
          conversationConfirmed: true,
          sessionId: secretParentSid,
          cwd: wsA,
          brainRoots: [brainRoot]
        });
        assert.equal(briefSecretParent.anchors.conversationId, safeChildConv);
        assert.equal(briefSecretParent.anchors.sessionId, "parent-session-[REDACTED:AWS_ACCESS_KEY]");
        assert.equal(briefSecretParent.anchors.resumeCrossWindow, "", "Secret-bearing parent checkpoint ID must not emit cross-window resume");
        assert.equal(briefSecretParent.resumeCommand, "ctx_resume({})");
        assert.ok(!briefSecretParent.markdown.includes("AKIA0123456789ABCDEF"), "Parent-mapped secret checkpoint brief must not leak raw secret");
        assert.ok(!briefSecretParent.markdown.includes("ctx_resume({ sessionId:"));

        // (b) Secret-bearing child conversation + safe parent checkpoint sessionId -> child redacted, safe parent keeps executable cross-window resume
        const secretChildConv = "conv-child-AKIA0123456789ABCDEF";
        const safeParentSid = "parent-session-safe-cp-001";
        longStore.recordVerificationResult(safeParentSid, {
          kind: "test",
          command: "npm test -- PARENT_SAFE",
          exitCode: 0,
          passed: true,
          summary: "PASS_PARENT_SAFE",
          worktree: wsA
        });
        const briefSafeParent = buildHandoffBrief({
          store: longStore,
          mode: "agent",
          scope: "conversation",
          conversationId: secretChildConv,
          conversationConfirmed: true,
          sessionId: safeParentSid,
          cwd: wsA,
          brainRoots: [brainRoot]
        });
        assert.equal(briefSafeParent.anchors.conversationId, "conv-child-[REDACTED:AWS_ACCESS_KEY]");
        assert.equal(briefSafeParent.anchors.sessionId, safeParentSid);
        assert.equal(briefSafeParent.anchors.resumeCrossWindow, `ctx_resume({ sessionId: ${JSON.stringify(safeParentSid)} })`);
        assert.equal(briefSafeParent.resumeCommand, `ctx_resume({ sessionId: ${JSON.stringify(safeParentSid)} })`);
        assert.ok(!briefSafeParent.markdown.includes("AKIA0123456789ABCDEF"), "Secret child conv with safe parent checkpoint must not leak child secret");
        assert.ok(briefSafeParent.markdown.includes(`ctx_resume({ sessionId: ${JSON.stringify(safeParentSid)} })`));
      } finally {
        longStore.close();
      }

      // Verify 96, 97, 128 & redacted-96 IDs over BOTH real HTTP /api/handoff and real Watchdog rescueBrief cache
      for (const item of [longCases[0], longCases[1], longCases[3], longCases[5]]) {
        const directHttpRes = await httpJsonRequest(port, "/api/handoff", {
          method: "POST",
          headers: authHeaders,
          body: {
            scope: "conversation",
            conversationId: item.id,
            mode: "agent",
            conversationConfirmed: true,
            fromSidecarHost: true
          }
        });
        assert.equal(directHttpRes.status, 200);
        assert.equal(directHttpRes.json.scope, "conversation");
        assert.equal(directHttpRes.json.conversationId, item.id);
        assert.equal(directHttpRes.json.confirmedConversation, true);
        assert.equal(directHttpRes.json.anchors?.confirmed, true);
        assert.equal(directHttpRes.json.anchors?.conversationId, item.expectedAnchor);
        assert.ok(directHttpRes.json.markdown.includes(`QUOTE_${item.tag}_UNIQUE`));

        const copied = [];
        let stripWdRescue = true;
        let hoCount = 0;
        let lastServerHoJson = null;
        const { html, ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: item.id, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") hoCount += 1;
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            const j = structuredClone(res.json);
            if (url === "/api/handoff") {
              lastServerHoJson = structuredClone(j);
            }
            if (url === "/api/watchdog" && stripWdRescue && j.current) {
              delete j.current.rescueBrief;
            }
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => j };
          }
        });
        const initDeadline = Date.now() + 2000;
        while (Date.now() < initDeadline) {
          if (
            vm.runInContext(
              `Boolean(isCurrentConversationConfirmed() && cachedWatchdog?.current?.conversationId === ${JSON.stringify(item.id)} && cachedWatchdog.current.phase !== 'IDLE')`,
              ctx
            )
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(
          vm.runInContext(
            `Boolean(isCurrentConversationConfirmed() && cachedWatchdog?.current?.conversationId === ${JSON.stringify(item.id)} && cachedWatchdog.current.phase !== 'IDLE')`,
            ctx
          ),
          true,
          `${item.tag}: initial Watchdog state must load before testing HTTP/cache paths`
        );

        // Path 1: Real HTTP /api/handoff via toolbar #kv-handoff-btn
        const isRedactedCase = item.tag === "LONG96_REDACTED";
        const expectedCrossCmd = isRedactedCase ? "" : `ctx_resume({ sessionId: ${JSON.stringify(item.id)} })`;
        const expectedResumeCmd = expectedCrossCmd || "ctx_resume({})";
        hoCount = 0;
        lastServerHoJson = null;
        copied.length = 0;
        clickBoundButton(html, ctx, elements, "kv-handoff-btn");
        await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `${item.tag} HTTP toolbar` });
        assert.equal(hoCount, 1, `${item.tag}: HTTP path must call /api/handoff once`);
        assert.ok(lastServerHoJson && typeof lastServerHoJson === "object", `${item.tag}: must capture live HTTP /api/handoff response`);
        assert.equal(lastServerHoJson.scope, "conversation");
        assert.equal(lastServerHoJson.conversationId, item.id);
        assert.equal(lastServerHoJson.confirmedConversation, true);
        assert.equal(lastServerHoJson.secretRedactionEnabled, true);
        assert.equal(lastServerHoJson.anchors?.conversationId, item.expectedAnchor);
        assert.equal(lastServerHoJson.anchors?.resumeCrossWindow, expectedCrossCmd);
        assert.equal(lastServerHoJson.resumeCommand, expectedResumeCmd);
        assert.ok(lastServerHoJson.markdown.includes(`QUOTE_${item.tag}_UNIQUE`));
        assert.equal(
          elements.get("kv-handoff-preview").textContent,
          lastServerHoJson.markdown,
          `${item.tag}: HTTP preview must match server markdown exactly`
        );
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false, `${item.tag}: HTTP Fact Copy must be enabled`);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false, `${item.tag}: HTTP Prompt Copy must be enabled`);
        await clickBoundButton(html, ctx, elements, "kv-handoff-copy-btn");
        assert.equal(copied.length, 1, `${item.tag}: HTTP Fact Copy must write exactly once`);
        assert.equal(copied[0], lastServerHoJson.markdown);
        await clickBoundButton(html, ctx, elements, "kv-handoff-prompt-btn");
        assert.equal(copied.length, 2, `${item.tag}: HTTP Semantic Prompt Copy must write once`);
        const httpPromptText = copied[1];
        assert.ok(httpPromptText.includes(item.expectedAnchor), `${item.tag}: HTTP Semantic Prompt must include display anchor`);
        assert.ok(httpPromptText.includes("ctx_resume({})"), `${item.tag}: HTTP Semantic Prompt must include same-window resume`);
        if (isRedactedCase) {
          assert.ok(!copied[0].includes("AKIA0123456789ABCDEF"), "LONG96_REDACTED HTTP Fact Copy must not contain raw secret ID");
          assert.ok(!copied[0].includes("ctx_resume({ sessionId:"), "LONG96_REDACTED HTTP Fact Copy must not emit cross-window sessionId");
          assert.ok(!httpPromptText.includes("AKIA0123456789ABCDEF"), "LONG96_REDACTED HTTP Semantic Prompt must not contain raw secret ID");
          assert.ok(!httpPromptText.includes("ctx_resume({ sessionId:"), "LONG96_REDACTED HTTP Semantic Prompt must not emit cross-window sessionId");
        } else {
          assert.ok(copied[0].includes(expectedCrossCmd), `${item.tag}: HTTP Fact Copy must preserve full cross-window resume`);
          assert.ok(httpPromptText.includes(expectedCrossCmd), `${item.tag}: HTTP Semantic Prompt must preserve full cross-window resume`);
        }
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");

        // Path 2: Real Watchdog rescueBrief cache (inner rescueBrief omits scope, outer cachedWatchdog carries scope)
        stripWdRescue = false;
        await vm.runInContext("refreshData(false);", ctx);
        await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `${item.tag} Watchdog refresh` });
        const rawInnerRescue = vm.runInContext("cachedWatchdog?.current?.rescueBrief", ctx);
        assert.ok(rawInnerRescue && typeof rawInnerRescue === "object", `${item.tag}: server must pre-generate Watchdog rescueBrief`);
        assert.equal(rawInnerRescue.scope, undefined, `${item.tag}: real Watchdog inner rescueBrief omits scope`);
        assert.equal(rawInnerRescue.conversationId, item.id);
        assert.equal(rawInnerRescue.secretRedactionEnabled, true);
        assert.equal(rawInnerRescue.anchors?.conversationId, item.expectedAnchor);
        assert.equal(rawInnerRescue.anchors?.resumeCrossWindow, expectedCrossCmd);
        assert.equal(rawInnerRescue.resumeCommand, expectedResumeCmd);

        const matchedRescue = vm.runInContext("getMatchingRescueBrief()", ctx);
        assert.ok(matchedRescue && matchedRescue.markdown === rawInnerRescue.markdown, `${item.tag}: panel must accept valid Watchdog rescueBrief`);

        hoCount = 0;
        copied.length = 0;
        clickBoundButton(html, ctx, elements, "wd-open-rescue-btn");
        await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `${item.tag} Watchdog View Brief` });
        assert.equal(hoCount, 0, `${item.tag}: Watchdog cache View Brief must not fall back to HTTP`);
        assert.equal(elements.get("kv-handoff-preview").textContent, rawInnerRescue.markdown);
        assert.equal(elements.get("kv-handoff-copy-btn").disabled, false);
        assert.equal(elements.get("kv-handoff-prompt-btn").disabled, false);
        await clickBoundButton(html, ctx, elements, "kv-handoff-copy-btn");
        assert.equal(copied.length, 1, `${item.tag}: Watchdog preview Fact Copy must write exactly once`);
        assert.equal(copied[0], rawInnerRescue.markdown);
        await clickBoundButton(html, ctx, elements, "kv-handoff-prompt-btn");
        assert.equal(copied.length, 2, `${item.tag}: Watchdog preview Semantic Prompt Copy must write once`);
        const wdPromptText = copied[1];
        assert.ok(wdPromptText.includes(item.expectedAnchor));
        assert.ok(wdPromptText.includes("ctx_resume({})"));
        if (isRedactedCase) {
          assert.ok(!copied[0].includes("AKIA0123456789ABCDEF"), "LONG96_REDACTED Watchdog Fact Copy must not contain raw secret ID");
          assert.ok(!copied[0].includes("ctx_resume({ sessionId:"), "LONG96_REDACTED Watchdog Fact Copy must not emit cross-window sessionId");
          assert.ok(!wdPromptText.includes("AKIA0123456789ABCDEF"), "LONG96_REDACTED Watchdog Semantic Prompt must not contain raw secret ID");
          assert.ok(!wdPromptText.includes("ctx_resume({ sessionId:"), "LONG96_REDACTED Watchdog Semantic Prompt must not emit cross-window sessionId");
        } else {
          assert.ok(copied[0].includes(expectedCrossCmd));
          assert.ok(wdPromptText.includes(expectedCrossCmd));
        }

        copied.length = 0;
        await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
        assert.equal(copied.length, 1, `${item.tag}: Watchdog Card Copy must write exactly once`);
        assert.equal(copied[0], rawInnerRescue.markdown);
        if (isRedactedCase) {
          assert.ok(!copied[0].includes("AKIA0123456789ABCDEF"), "LONG96_REDACTED Watchdog Card Copy must not contain raw secret ID");
          assert.ok(!copied[0].includes("ctx_resume({ sessionId:"));
        }
        clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
      }

      // Redaction policy enforcement on panel display anchors + Redaction OFF parity for LONG96_REDACTED
      {
        const redItem = longCases[5];
        // (a) When secretRedaction is ON (default / true), panel must reject an unredacted raw display anchor,
        //     and buildSemanticHandoffPrompt must never leak raw secret or redacted placeholder inside resumeCrossWindow.
        const realRedHttp = (
          await httpJsonRequest(port, "/api/handoff", {
            method: "POST",
            headers: authHeaders,
            body: { scope: "conversation", conversationId: redItem.id, mode: "agent", conversationConfirmed: true, fromSidecarHost: true }
          })
        ).json;
        const tamperedRawAnchorPayload = {
          ...structuredClone(realRedHttp),
          anchors: { ...structuredClone(realRedHttp.anchors), conversationId: redItem.id }
        };
        const copiedTampered = [];
        const { html: tHtml, ctx: tCtx, elements: tEls } = createDashboardVmSandbox({
          sidecarObj: { conversationId: redItem.id, ui: { toggleConversation() {} } },
          copiedOut: copiedTampered,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff") {
              return { ok: true, status: 200, json: async () => structuredClone(tamperedRawAnchorPayload) };
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            const j = structuredClone(res.json);
            if (url === "/api/watchdog" && j.current) delete j.current.rescueBrief;
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => j };
          }
        });
        const tDeadline = Date.now() + 2000;
        while (Date.now() < tDeadline) {
          if (vm.runInContext(`Boolean(!autoRefreshInFlight && isCurrentConversationConfirmed() && cachedWatchdog?.current?.conversationId === ${JSON.stringify(redItem.id)})`, tCtx)) {
            break;
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        clickBoundButton(tHtml, tCtx, tEls, "kv-handoff-btn");
        await waitForHandoffSettled(tCtx, { scope: "conversation", scenario: "LONG96_REDACTED unredacted anchor rejected when redaction ON" });
        assert.equal(vm.runInContext("cachedHandoffSnapshot", tCtx), null, "Panel must reject raw unredacted display anchor when secretRedactionEnabled is true");
        assert.equal(tEls.get("kv-handoff-copy-btn").disabled, true);
        assert.equal(tEls.get("kv-handoff-prompt-btn").disabled, true);
        await vm.runInContext("Promise.all([copyHandoffBrief(), copyHandoffPrompt()]);", tCtx);
        assert.equal(copiedTampered.length, 0);

        const defensePromptRawCross = vm.runInContext(
          "buildSemanticHandoffPrompt({ confirmedConversation: true, secretRedactionEnabled: true, conversationId: redId, anchors: { confirmed: true, conversationId: redAnchor, resumeSameWindow: 'ctx_resume({})', resumeCrossWindow: `ctx_resume({ sessionId: \"${redId}\" })` } }, 'en')",
          Object.assign(tCtx, { redId: redItem.id, redAnchor: redItem.expectedAnchor })
        );
        assert.ok(defensePromptRawCross.includes("ctx_resume({})"));
        assert.ok(!defensePromptRawCross.includes("AKIA0123456789ABCDEF"), "buildSemanticHandoffPrompt must strip raw secret resumeCrossWindow when redaction ON");
        assert.ok(!defensePromptRawCross.includes("ctx_resume({ sessionId:"));

        const defensePromptPlaceholderCross = vm.runInContext(
          "buildSemanticHandoffPrompt({ confirmedConversation: true, secretRedactionEnabled: true, conversationId: redId, anchors: { confirmed: true, conversationId: redAnchor, resumeSameWindow: 'ctx_resume({})', resumeCrossWindow: 'ctx_resume({ sessionId: \"conv-[REDACTED:AWS_ACCESS_KEY]\" })' } }, 'en')",
          tCtx
        );
        assert.ok(!defensePromptPlaceholderCross.includes("ctx_resume({ sessionId:"), "buildSemanticHandoffPrompt must never emit redacted placeholder as executable sessionId");

        // (b) When secretRedaction is OFF (AGY_DART_DISABLE_SECRET_REDACTION=1), both HTTP & Watchdog preserve
        //     configured unredacted display anchor and executable cross-window resume across Fact Copy & Semantic Prompt Copy.
        const prevDisableRedaction = process.env.AGY_DART_DISABLE_SECRET_REDACTION;
        process.env.AGY_DART_DISABLE_SECRET_REDACTION = "1";
        resetConfigCache();
        try {
          const expectedRawCross = `ctx_resume({ sessionId: ${JSON.stringify(redItem.id)} })`;
          const offCopied = [];
          let stripOffWdRescue = true;
          let lastOffHoJson = null;
          const { html: offHtml, ctx: offCtx, elements: offEls } = createDashboardVmSandbox({
            sidecarObj: { conversationId: redItem.id, ui: { toggleConversation() {} } },
            copiedOut: offCopied,
            fetchImpl: async (url, opts = {}) => {
              const body = opts.body ? JSON.parse(opts.body) : {};
              const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
              const j = structuredClone(res.json);
              if (url === "/api/handoff") lastOffHoJson = structuredClone(j);
              if (url === "/api/watchdog" && stripOffWdRescue && j.current) delete j.current.rescueBrief;
              return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => j };
            }
          });
          const offDeadline = Date.now() + 2000;
          while (Date.now() < offDeadline) {
            if (vm.runInContext(`Boolean(!autoRefreshInFlight && isCurrentConversationConfirmed() && cachedWatchdog?.current?.conversationId === ${JSON.stringify(redItem.id)} && cachedWatchdog.current.phase !== 'IDLE')`, offCtx)) {
              break;
            }
            await new Promise((r) => setTimeout(r, 15));
          }
          clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-btn");
          await waitForHandoffSettled(offCtx, { scope: "conversation", scenario: "LONG96_REDACTED HTTP redaction OFF" });
          assert.equal(lastOffHoJson.secretRedactionEnabled, false);
          assert.equal(lastOffHoJson.anchors?.conversationId, redItem.id);
          assert.equal(lastOffHoJson.anchors?.resumeCrossWindow, expectedRawCross);
          assert.equal(lastOffHoJson.resumeCommand, expectedRawCross);
          await clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-copy-btn");
          await clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-prompt-btn");
          assert.equal(offCopied.length, 2, "Redaction OFF HTTP must support both Fact Copy and Semantic Prompt Copy");
          assert.ok(offCopied[0].includes(expectedRawCross), "Redaction OFF HTTP Fact Copy must include configured cross-window resume");
          assert.ok(offCopied[1].includes(redItem.id), "Redaction OFF HTTP Semantic Prompt must include configured raw display anchor");
          assert.ok(offCopied[1].includes(expectedRawCross), "Redaction OFF HTTP Semantic Prompt must include configured cross-window resume");
          // Verify mismatched redacted anchor is rejected when secretRedactionEnabled === false
          assert.equal(
            vm.runInContext(
              `isConversationDisplayAnchorValid(${JSON.stringify(redItem.expectedAnchor)}, ${JSON.stringify(redItem.id)}, false)`,
              offCtx
            ),
            false,
            "When redaction is OFF, display anchor must match raw ID rather than redacted placeholder"
          );
          clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-close-btn");

          // Watchdog rescueBrief cache refreshes with secretRedactionEnabled === false (must not reuse prior redacted cache)
          stripOffWdRescue = false;
          await vm.runInContext("refreshData(false);", offCtx);
          await waitForHandoffSettled(offCtx, { scope: "conversation", scenario: "LONG96_REDACTED Watchdog redaction OFF" });
          const offWdRescue = vm.runInContext("cachedWatchdog?.current?.rescueBrief", offCtx);
          assert.ok(offWdRescue && offWdRescue.secretRedactionEnabled === false, "Watchdog rescueBrief must regenerate when redaction setting flips OFF");
          assert.equal(offWdRescue.anchors?.conversationId, redItem.id);
          assert.equal(offWdRescue.anchors?.resumeCrossWindow, expectedRawCross);
          offCopied.length = 0;
          clickBoundButton(offHtml, offCtx, offEls, "wd-open-rescue-btn");
          await waitForHandoffSettled(offCtx, { scope: "conversation", scenario: "LONG96_REDACTED Watchdog view redaction OFF" });
          await clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-copy-btn");
          await clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-prompt-btn");
          assert.equal(offCopied.length, 2);
          assert.ok(offCopied[0].includes(expectedRawCross));
          assert.ok(offCopied[1].includes(redItem.id) && offCopied[1].includes(expectedRawCross));
          clickBoundButton(offHtml, offCtx, offEls, "kv-handoff-close-btn");
        } finally {
          if (prevDisableRedaction === undefined) delete process.env.AGY_DART_DISABLE_SECRET_REDACTION;
          else process.env.AGY_DART_DISABLE_SECRET_REDACTION = prevDisableRedaction;
          resetConfigCache();
        }
      }

      // Shared long-prefix collision isolation (97-char & 128-char pairs sharing identical 93-char prefix + "...")
      for (const [label, idA, idB, tagB] of [
        ["97-char", convLen97A, convLen97B, "LONG97_B"],
        ["128-char", convLen128A, convLen128B, "LONG128_B"]
      ]) {
        const realHoA = (
          await httpJsonRequest(port, "/api/handoff", {
            method: "POST",
            headers: authHeaders,
            body: { scope: "conversation", conversationId: idA, mode: "agent", conversationConfirmed: true, fromSidecarHost: true }
          })
        ).json;
        const realHoB = (
          await httpJsonRequest(port, "/api/handoff", {
            method: "POST",
            headers: authHeaders,
            body: { scope: "conversation", conversationId: idB, mode: "agent", conversationConfirmed: true, fromSidecarHost: true }
          })
        ).json;
        assert.equal(realHoA.anchors.conversationId, realHoB.anchors.conversationId, `${label}: A & B must share identical abbreviated display anchor`);
        assert.notEqual(realHoA.conversationId, realHoB.conversationId);

        const copied = [];
        let hoPayloadOverride = null;
        let wdRescueOverride = "strip";
        const { html, ctx, elements } = createDashboardVmSandbox({
          sidecarObj: { conversationId: idA, ui: { toggleConversation() {} } },
          copiedOut: copied,
          fetchImpl: async (url, opts = {}) => {
            const body = opts.body ? JSON.parse(opts.body) : {};
            if (url === "/api/handoff" && hoPayloadOverride) {
              return { ok: true, status: 200, json: async () => structuredClone(hoPayloadOverride) };
            }
            const res = await httpJsonRequest(port, url, { method: opts.method || "POST", headers: authHeaders, body });
            const j = structuredClone(res.json);
            if (url === "/api/watchdog" && j.current) {
              if (wdRescueOverride === "strip") delete j.current.rescueBrief;
              else if (wdRescueOverride && typeof wdRescueOverride === "object") j.current.rescueBrief = structuredClone(wdRescueOverride);
            }
            return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => j };
          }
        });
        const colDeadline = Date.now() + 2000;
        while (Date.now() < colDeadline) {
          if (
            vm.runInContext(
              `Boolean(!autoRefreshInFlight && isCurrentConversationConfirmed() && cachedWatchdog?.current?.conversationId === ${JSON.stringify(idA)} && cachedWatchdog.current.phase !== 'IDLE')`,
              ctx
            )
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(
          vm.runInContext(
            `Boolean(!autoRefreshInFlight && isCurrentConversationConfirmed() && cachedWatchdog?.current?.conversationId === ${JSON.stringify(idA)} && cachedWatchdog.current.phase !== 'IDLE')`,
            ctx
          ),
          true,
          `${label}: initial Watchdog state must load before collision checks`
        );
        const curKeyA = vm.runInContext("getCurrentWatchdogIncidentKey()", ctx);

        const hoBAlignedKey = { ...structuredClone(realHoB), incidentKey: curKeyA };
        const hoAnchorOnlyNoTopId = { ...structuredClone(realHoB), incidentKey: curKeyA };
        delete hoAnchorOnlyNoTopId.conversationId;
        const hoBadUnicodeEllipsis = {
          ...structuredClone(realHoA),
          incidentKey: curKeyA,
          anchors: { ...structuredClone(realHoA.anchors), conversationId: `${sharedPrefix93}…` }
        };
        const hoBadShortPrefix = {
          ...structuredClone(realHoA),
          incidentKey: curKeyA,
          anchors: { ...structuredClone(realHoA.anchors), conversationId: sharedPrefix93.slice(0, 40) }
        };
        const hoMissingScope = { ...structuredClone(realHoA), incidentKey: curKeyA };
        delete hoMissingScope.scope;

        for (const [subName, badPayload] of [
          ["samePrefixSiblingB", hoBAlignedKey],
          ["abbreviatedAnchorOnlyWithoutFullId", hoAnchorOnlyNoTopId],
          ["unicodeEllipsisAnchor", hoBadUnicodeEllipsis],
          ["shortPrefixAnchor", hoBadShortPrefix],
          ["modernHttpMissingScope", hoMissingScope]
        ]) {
          hoPayloadOverride = badPayload;
          copied.length = 0;
          await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
          assert.equal(copied.length, 0, `${label} HTTP (${subName}): Card Copy must write 0 times`);

          for (const btnId of ["kv-handoff-btn", "wd-open-rescue-btn"]) {
            copied.length = 0;
            clickBoundButton(html, ctx, elements, btnId);
            await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `${label} HTTP (${subName}) ${btnId}` });
            assert.ok(!elements.get("kv-handoff-preview").textContent.includes(`QUOTE_${tagB}_UNIQUE`));
            assert.equal(vm.runInContext("cachedHandoffSnapshot", ctx), null, `${label} HTTP (${subName}) ${btnId}: must not cache`);
            assert.equal(elements.get("kv-handoff-copy-btn").disabled, true, `${label} HTTP (${subName}) ${btnId}: Fact Copy must stay disabled`);
            assert.equal(elements.get("kv-handoff-prompt-btn").disabled, true, `${label} HTTP (${subName}) ${btnId}: Prompt Copy must stay disabled`);
            await vm.runInContext("Promise.all([copyHandoffBrief(), copyHandoffPrompt()]);", ctx);
            assert.equal(copied.length, 0);
            clickBoundButton(html, ctx, elements, "kv-handoff-close-btn");
          }
        }

        // Watchdog cache collision, omitted inner full ID, omitted outer scope & tampered anchor checks
        hoPayloadOverride = hoBAlignedKey;
        const wdNoTopIdSiblingB = { ...structuredClone(realHoB), incidentKey: curKeyA };
        delete wdNoTopIdSiblingB.conversationId;
        const badWdRescues = [
          ["wdSamePrefixSiblingB", { ...structuredClone(realHoB), incidentKey: curKeyA }],
          ["wdAbbreviatedAnchorOnlyWithoutFullId", wdNoTopIdSiblingB],
          ["wdBadUnicodeEllipsis", { ...structuredClone(realHoA), incidentKey: curKeyA, anchors: { ...structuredClone(realHoA.anchors), conversationId: `${sharedPrefix93}…` } }],
          ["wdWrongInnerScope", { ...structuredClone(realHoA), scope: "app", incidentKey: curKeyA }]
        ];
        for (const [wdCaseName, badRescue] of badWdRescues) {
          if (wdCaseName !== "wdWrongInnerScope") delete badRescue.scope;
          wdRescueOverride = badRescue;
          await vm.runInContext("refreshData(false);", ctx);
          await waitForHandoffSettled(ctx, { scope: "conversation", scenario: `${label} ${wdCaseName} refresh` });
          assert.equal(vm.runInContext("getMatchingRescueBrief()", ctx), null, `${label} (${wdCaseName}): getMatchingRescueBrief must return null`);
          copied.length = 0;
          await clickBoundButton(html, ctx, elements, "wd-copy-rescue-btn");
          assert.equal(copied.length, 0, `${label} (${wdCaseName}): Card Copy must write 0 times`);
        }

        // Mismatched outer cachedWatchdog.scope must be rejected by both getMatchingRescueBrief() and isWatchdogIncidentAlignedWithTarget(),
        // and a poisoned rescueBrief.incidentKey must not hijack computeWatchdogIncidentKey() when cur.incidentKey is present.
        {
          const validInnerNoScope = { ...structuredClone(realHoA), incidentKey: curKeyA };
          delete validInnerNoScope.scope;
          vm.runInContext(
            `cachedWatchdog = { ok: true, enabled: true, scope: 'app', _hostEpoch: hostSwitchEpoch, current: { conversationId: ${JSON.stringify(idA)}, phase: 'LLM_INFLIGHT', severity: 'stalled', rawSeverity: 'stalled', incidentKey: ${JSON.stringify(curKeyA)}, rescueBrief: outerWrongScopeBrief } };`,
            Object.assign(ctx, { outerWrongScopeBrief: validInnerNoScope })
          );
          assert.equal(
            vm.runInContext("getMatchingRescueBrief()", ctx),
            null,
            `${label}: mismatched outer cachedWatchdog.scope must be rejected by getMatchingRescueBrief()`
          );
          assert.equal(
            vm.runInContext("isWatchdogIncidentAlignedWithTarget({ requireActive: true })", ctx),
            false,
            `${label}: mismatched outer cachedWatchdog.scope must be rejected by isWatchdogIncidentAlignedWithTarget()`
          );
          vm.runInContext(
            `cachedWatchdog = { ok: true, enabled: true, scope: 'conversation', _hostEpoch: hostSwitchEpoch, current: { conversationId: ${JSON.stringify(idA)}, phase: 'LLM_INFLIGHT', severity: 'stalled', rawSeverity: 'stalled', incidentKey: ${JSON.stringify(curKeyA)}, rescueBrief: { ...outerWrongScopeBrief, conversationId: ${JSON.stringify(idB)}, incidentKey: 'poisoned-foreign-key' } } };`,
            ctx
          );
          assert.equal(vm.runInContext("getMatchingRescueBrief()", ctx), null);
          assert.equal(
            vm.runInContext("getCurrentWatchdogIncidentKey()", ctx),
            curKeyA,
            `${label}: poisoned rescueBrief.incidentKey must not hijack cur.incidentKey`
          );
        }
      }

      // Short 25-char redacted-ID sibling collision (both redact to `conv-[REDACTED:AWS_ACCESS_KEY]`)
      {
        const shortRedA = "conv-AKIA0123456789ABCDEF";
        const shortRedB = "conv-AKIA9999999999ZYXWVU";
        const shortStore = new ContextModeStore({ dbPath: tmpDb });
        try {
          const briefRedA = buildHandoffBrief({
            store: shortStore,
            mode: "agent",
            scope: "conversation",
            conversationId: shortRedA,
            conversationConfirmed: true,
            sessionId: shortRedA,
            cwd: wsA,
            brainRoots: [brainRoot]
          });
          const briefRedB = buildHandoffBrief({
            store: shortStore,
            mode: "agent",
            scope: "conversation",
            conversationId: shortRedB,
            conversationConfirmed: true,
            sessionId: shortRedB,
            cwd: wsA,
            brainRoots: [brainRoot]
          });
          assert.equal(briefRedA.conversationId, shortRedA);
          assert.equal(briefRedB.conversationId, shortRedB);
          assert.equal(briefRedA.anchors.conversationId, "conv-[REDACTED:AWS_ACCESS_KEY]");
          assert.equal(briefRedB.anchors.conversationId, "conv-[REDACTED:AWS_ACCESS_KEY]");

          const { ctx } = createDashboardVmSandbox({
            sidecarObj: { conversationId: shortRedA, ui: { toggleConversation() {} } }
          });
          const noTopIdRedB = { ...structuredClone(briefRedB) };
          delete noTopIdRedB.conversationId;
          delete noTopIdRedB.scope;
          vm.runInContext(
            `cachedWatchdog = { ok: true, enabled: true, scope: 'conversation', _hostEpoch: hostSwitchEpoch, current: { conversationId: ${JSON.stringify(shortRedA)}, phase: 'LLM_INFLIGHT', severity: 'stalled', rawSeverity: 'stalled', incidentKey: 'inc-short-red', rescueBrief: redBrief } };`,
            Object.assign(ctx, { redBrief: noTopIdRedB })
          );
          assert.equal(
            vm.runInContext("getMatchingRescueBrief()", ctx),
            null,
            "Short redacted-ID sibling missing inner conversationId must be rejected by Watchdog cache"
          );
          const validRedA = { ...structuredClone(briefRedA) };
          delete validRedA.scope;
          vm.runInContext(
            `cachedWatchdog.current.rescueBrief = validRedA;`,
            Object.assign(ctx, { validRedA })
          );
          assert.ok(
            vm.runInContext("getMatchingRescueBrief()", ctx),
            "Short redacted-ID with matching full conversationId and redacted display anchor must pass"
          );
        } finally {
          shortStore.close();
        }
      }
    }

    // 8. Controlled-clock waitForHandoffSettled boundary tests (v1.7.3-16):
    // (a) Finishes in last poll interval before 2000ms deadline -> succeeds cleanly
    {
      let nowMs = 30_000;
      let step = 0;
      const clockCtx = vm.createContext({
        currentScope: "app",
        handoffLoading: true,
        handoffInFlightRequest: null,
        autoRefreshInFlight: false,
        handoffDrawerOpen: true,
        handoffDrawerTargetedAlert: false,
        handoffDrawerTargetedEnded: false
      });
      await waitForHandoffSettled(clockCtx, {
        timeoutMs: 2000,
        scope: "app",
        scenario: "v1.7.3-16 clock-finish-before-deadline",
        nowFn: () => nowMs,
        sleepFn: async () => {
          step += 1;
          if (step === 1) {
            nowMs = 31_990;
          } else {
            clockCtx.handoffLoading = false;
            nowMs = 32_005;
          }
        }
      });
      assert.equal(step, 2, "v1.7.3-16 clock boundary: must succeed when handoffLoading clears before deadline");
    }

    // (b) Still busy (handoffLoading === true) at 2000ms deadline -> throws diagnostic timeout
    {
      let nowMs = 40_000;
      let step = 0;
      const busyCtx = vm.createContext({
        currentScope: "lifetime",
        handoffLoading: true,
        handoffInFlightRequest: { seq: 9 },
        autoRefreshInFlight: false,
        handoffDrawerOpen: true,
        handoffDrawerTargetedAlert: true,
        handoffDrawerTargetedEnded: false
      });
      await assert.rejects(
        () =>
          waitForHandoffSettled(busyCtx, {
            timeoutMs: 2000,
            scope: "lifetime",
            scenario: "v1.7.3-16 clock-still-busy",
            nowFn: () => nowMs,
            sleepFn: async () => {
              step += 1;
              nowMs = step === 1 ? 41_990 : 42_005;
            }
          }),
        (err) => {
          assert.match(err.message, /waitForHandoffSettled timed out after 2000ms/);
          assert.match(err.message, /scope=lifetime/);
          assert.match(err.message, /v1\.7\.3-16 clock-still-busy/);
          assert.match(err.message, /handoffLoading=true/);
          return true;
        }
      );
    }
  } finally {
    const closeP = new Promise((resolve) => srv.close(resolve));
    srv.closeAllConnections?.();
    await closeP;
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("v1.7.3-17: Wrap-up Items 2, 3, 4 & 5 — CLI 64 KiB exact newline boundary, Node TAP TODO/SKIP blocks, strict per-line UTF-8 fixed windows & Git shared deadline on status===0 late return", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v173-wrap2345-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const cliFilterPath = path.join(ROOT, "hooks", "cli-filter.mjs");

  try {
    // === Item 2: CLI 64 KiB overflow tail buffer exact newline boundary (stdout & stderr x 3 states) ===
    const exactErrLine = "Error: exact_65536_boundary_sentinel_line\n";
    const exactErrBytes = Buffer.byteLength(exactErrLine, "utf8");
    const postErrTailBytes = 65536 - exactErrBytes; // Places exactErrLine starting at exact last 65,536 bytes!
    assert.ok(postErrTailBytes > 0);
    const padNormalLine = "ok_tail_pad_0123456789abcdef0123456789abcdef0123456789abcdef012\n"; // 64 bytes

    const runCliOverflow = (tag, streamName, scriptBody) => {
      const scriptPath = path.join(tmpDir, `wrap2-${tag}-${streamName}.mjs`);
      fs.writeFileSync(scriptPath, scriptBody, "utf8");
      const sid = `sess-wrap2-${tag}-${streamName}`;
      const run = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(scriptPath)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sid, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(run.status, 1, `Item 2 (${tag}/${streamName}): must preserve exit code 1`);
      const st = new ContextModeStore({ dbPath: tmpDb });
      try {
        const cp = st.getSessionCheckpoint(sid);
        const brief = buildHandoffBrief({
          store: st,
          mode: "agent",
          scope: "conversation",
          conversationId: sid,
          conversationConfirmed: true,
          sessionId: sid,
          cwd: tmpDir
        });
        return { cp, brief };
      } finally {
        st.close();
      }
    };

    const makePadChunkCode = (streamExpr, totalBytes, endsWithNl) => [
      `{`,
      `  const target = ${totalBytes};`,
      `  const line = ${JSON.stringify(padNormalLine)};`,
      `  const full = Math.floor(target / line.length);`,
      `  const rem = target - full * line.length;`,
      `  const block = line.repeat(256);`,
      `  let left = full;`,
      `  while (left >= 256) { ${streamExpr}.write(block); left -= 256; }`,
      `  if (left > 0) ${streamExpr}.write(line.repeat(left));`,
      `  if (rem > 0) ${streamExpr}.write(${endsWithNl ? `"p".repeat(rem - 1) + "\\n"` : `"X".repeat(rem)`});`,
      `}`
    ].join("\n");

    for (const streamName of ["stdout", "stderr"]) {
      const streamExpr = `process.${streamName}`;
      // State A: Complete error line (including leading valid UTF-8 U+FFFD `EF BF BD`) starts at exact last 65,536 bytes AND preceding byte is `\n` (0x0a) -> MUST KEEP!
      const exactFffdLine = "\uFFFDError: exact_65536_boundary_sentinel_line\n";
      const exactFffdPostBytes = 65536 - Buffer.byteLength(exactFffdLine, "utf8");
      const resExact = runCliOverflow(
        "exact_nl",
        streamName,
        [
          makePadChunkCode(streamExpr, 2 * 1024 * 1024 + 128, true),
          `${streamExpr}.write(${JSON.stringify(exactFffdLine)});`,
          makePadChunkCode(streamExpr, exactFffdPostBytes, true),
          `process.exit(1);`
        ].join("\n")
      );
      assert.ok(
        (resExact.cp.lastTest?.failureExcerpt || "").includes("\uFFFDError: exact_65536_boundary_sentinel_line"),
        `Item 2 (${streamName}/exact_nl): SQLite must retain complete first line (and leading legitimate U+FFFD) at exact 65,536-byte tail start, got ${JSON.stringify(resExact.cp.lastTest?.failureExcerpt)}`
      );
      assert.ok(
        resExact.brief.markdown.includes("\uFFFDError: exact_65536_boundary_sentinel_line"),
        `Item 2 (${streamName}/exact_nl): handoff brief must include exact boundary error`
      );

      // State B: Error line starts mid-line at exact last 65,536 bytes (preceding byte is non-`\n`, e.g. 'X') -> MUST DROP partial line!
      const midLinePrefix = "mid_prefix_before_cut_X";
      const midLineTail = "Error: mid_line_partial_must_drop\n";
      const postMidTailBytes = 65536 - Buffer.byteLength(midLineTail, "utf8");
      const resMid = runCliOverflow(
        "mid_line",
        streamName,
        [
          makePadChunkCode(streamExpr, 2 * 1024 * 1024 + 128, true),
          `${streamExpr}.write(${JSON.stringify(midLinePrefix)});`,
          `${streamExpr}.write(${JSON.stringify(midLineTail)});`,
          makePadChunkCode(streamExpr, postMidTailBytes, true),
          `process.exit(1);`
        ].join("\n")
      );
      assert.equal(
        resMid.cp.lastTest?.failureExcerpt || "",
        "",
        `Item 2 (${streamName}/mid_line): partial leading line preceded by non-\\n must be dropped, got ${JSON.stringify(resMid.cp.lastTest?.failureExcerpt)}`
      );
      assert.equal(resMid.cp.lastTest?.summary, "failed (exit 1)");
      assert.ok(resMid.brief.markdown.includes("FAIL (exit 1)") && !resMid.brief.markdown.includes("mid_line_partial_must_drop"));

      // State C: Complete error evicted strictly past 64 KiB tail cap (65,536 bytes of normal logs AFTER error) -> MUST NOT appear!
      const resEvicted = runCliOverflow(
        "evicted_64k",
        streamName,
        [
          makePadChunkCode(streamExpr, 2 * 1024 * 1024 + 128, true),
          `${streamExpr}.write("Error: evicted_past_64kib_cap\\n");`,
          makePadChunkCode(streamExpr, 65536 + 64, true),
          `process.exit(1);`
        ].join("\n")
      );
      assert.equal(
        resEvicted.cp.lastTest?.failureExcerpt || "",
        "",
        `Item 2 (${streamName}/evicted_64k): error evicted past 64 KiB cap must stay empty, got ${JSON.stringify(resEvicted.cp.lastTest?.failureExcerpt)}`
      );
      assert.equal(resEvicted.cp.lastTest?.summary, "failed (exit 1)");
      assert.ok(resEvicted.brief.markdown.includes("FAIL (exit 1)") && !resEvicted.brief.markdown.includes("evicted_past_64kib_cap"));
    }

    // Extra Item 2 boundary: CRLF split between `\r` (last dropped byte) and `\n` (first kept byte) + exact 2 MiB + 1 B arming transition
    {
      const crlfErr = "Error: crlf_split_boundary_complete_line\r\n";
      const crlfPost = 65536 - 1 - Buffer.byteLength(crlfErr, "utf8");
      const resCrlf = runCliOverflow(
        "crlf_split",
        "stdout",
        [
          `const blk = Buffer.alloc(65536, 0x61);`,
          `for (let i = 0; i < 32; i++) process.stdout.write(blk);`,
          `process.stdout.write("\\r");`,
          `process.stdout.write("\\n");`,
          `process.stdout.write(${JSON.stringify(crlfErr)});`,
          `process.stdout.write(Buffer.alloc(${crlfPost}, 0x70));`,
          `process.exit(1);`
        ].join("\n")
      );
      assert.ok(
        (resCrlf.cp.lastTest?.failureExcerpt || "").includes("Error: crlf_split_boundary_complete_line"),
        `Item 2 (crlf_split): complete line after \\r|\\n split must survive`
      );

      const armErr = "Error: exact_2mib_plus_1_arming_line\n";
      const armPost = 65536 - Buffer.byteLength(armErr, "utf8");
      const resArm = runCliOverflow(
        "arm_2mib_plus_1",
        "stdout",
        [
          `const blk = Buffer.alloc(65536, 0x58);`,
          `for (let i = 0; i < 31; i++) process.stdout.write(blk);`, // 2,031,616 B = overflowTailArmBytes
          `process.stdout.write("\\n");`,
          `process.stdout.write(${JSON.stringify(armErr)});`,
          `process.stdout.write(Buffer.alloc(${armPost}, 0x70));`,
          `process.exit(1);`
        ].join("\n")
      );
      assert.ok(
        (resArm.cp.lastTest?.failureExcerpt || "").includes("Error: exact_2mib_plus_1_arming_line"),
        `Item 2 (arm_2mib_plus_1): exact 2 MiB + 1 B arming boundary must keep first line`
      );
    }

    // === Item 3: Real Node TAP `# TODO` / `# SKIP` directive & YAML diagnostic block skipping (3 orders + regressions) ===
    const runRealTap = (tag, testFileSource, expectedExit) => {
      const tapFile = path.join(tmpDir, `wrap3-tap-${tag}.test.mjs`);
      fs.writeFileSync(tapFile, testFileSource, "utf8");
      const sid = `sess-wrap3-tap-${tag}`;
      const tapEnv = { ...process.env, AGY_DART_DB_PATH: tmpDb };
      delete tapEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node --test --test-reporter=tap wrap3-tap-${tag}.test.mjs`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(sid, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: tapEnv }
      );
      assert.equal(run.status, expectedExit, `Item 3 (${tag}): expected exit ${expectedExit}, got ${run.status}`);
      const st = new ContextModeStore({ dbPath: tmpDb });
      try {
        const cp = st.getSessionCheckpoint(sid);
        const brief = buildHandoffBrief({
          store: st,
          mode: "agent",
          scope: "conversation",
          conversationId: sid,
          conversationConfirmed: true,
          sessionId: sid,
          cwd: tmpDir
        });
        return { cp, brief, stdout: run.stdout };
      } finally {
        st.close();
      }
    };

    // Order A: TODO before real failure (including failing title ending in `PASSED` to also protect Item 6!)
    {
      const src = [
        `import test from "node:test";`,
        `import assert from "node:assert/strict";`,
        `test("expected todo failure", { todo: "tracked in #77" }, () => { assert.equal(1, 2, "TODO_ONLY_DIAGNOSTIC"); });`,
        `test("skipped with error word", { skip: "env error disabled" }, () => {});`,
        `test("marks real job PASSED", () => { assert.equal("pending", "PASSED", "REAL_FAILURE_DIAG_A"); });`
      ].join("\n");
      const { cp, brief } = runRealTap("todo_before_real", src, 1);
      const ex = cp.lastTest?.failureExcerpt || "";
      assert.ok(ex.startsWith("not ok 3 - marks real job PASSED"), `Item 3 (before): excerpt must point to real failure, got:\n${ex}`);
      assert.ok(ex.includes("REAL_FAILURE_DIAG_A"));
      assert.ok(!ex.includes("expected todo failure") && !ex.includes("TODO_ONLY_DIAGNOSTIC"));
      assert.ok(brief.markdown.includes("marks real job PASSED") && brief.markdown.includes("REAL_FAILURE_DIAG_A"));
      assert.ok(!brief.markdown.includes("TODO_ONLY_DIAGNOSTIC"));
      const firstErr = brief.anchors.failingChecks[0]?.firstErrorLine || "";
      assert.ok(firstErr.includes("marks real job PASSED") && firstErr.includes("REAL_FAILURE_DIAG_A"), `got: ${firstErr}`);
      assert.ok(!firstErr.includes("TODO_ONLY_DIAGNOSTIC"));
    }

    // Order B: TODO after real failure (title ending in `... ok` to also protect Item 6!)
    {
      const src = [
        `import test from "node:test";`,
        `import assert from "node:assert/strict";`,
        `test("prints real summary ... ok", () => { assert.equal("bad", "ok", "REAL_FAILURE_DIAG_B"); });`,
        `test("trailing todo failure", { todo: true }, () => { assert.equal(1, 2, "TRAILING_TODO_DIAG"); });`
      ].join("\n");
      const { cp, brief } = runRealTap("todo_after_real", src, 1);
      const ex = cp.lastTest?.failureExcerpt || "";
      assert.ok(ex.startsWith("not ok 1 - prints real summary ... ok"), `Item 3 (after): got:\n${ex}`);
      assert.ok(ex.includes("REAL_FAILURE_DIAG_B"));
      assert.ok(!ex.includes("trailing todo failure") && !ex.includes("TRAILING_TODO_DIAG"));
      const firstErr = brief.anchors.failingChecks[0]?.firstErrorLine || "";
      assert.ok(firstErr.includes("prints real summary ... ok") && firstErr.includes("REAL_FAILURE_DIAG_B"));
      assert.ok(!firstErr.includes("TRAILING_TODO_DIAG"));
    }

    // Order C: TODO-only (exit 0 + direct extractFailureExcerpt on raw TODO-only TAP -> "")
    {
      const src = [
        `import test from "node:test";`,
        `import assert from "node:assert/strict";`,
        `test("only todo failure", { todo: true }, () => { assert.equal(1, 2, "ONLY_TODO_DIAG"); });`
      ].join("\n");
      const { cp, brief } = runRealTap("todo_only", src, 0);
      assert.equal(cp.lastTest?.ok, true);
      assert.equal(cp.lastTest?.exitCode, 0);
      assert.equal(cp.lastTest?.failureExcerpt || "", "");
      assert.deepEqual(brief.anchors.failingChecks, []);
      assert.ok(brief.markdown.includes("PASS (exit 0)"));

      // Direct extractFailureExcerpt() against raw real Node TAP output of TODO-only test
      const tapEnv = { ...process.env };
      delete tapEnv.NODE_TEST_CONTEXT;
      const rawTodoRun = spawnSync(
        process.execPath,
        ["--test", "--test-reporter=tap", path.join(tmpDir, "wrap3-tap-todo_only.test.mjs")],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: tapEnv }
      );
      assert.equal(rawTodoRun.status, 0);
      assert.equal(
        extractFailureExcerpt(rawTodoRun.stdout),
        "",
        `Item 3 (todo_only direct): extractFailureExcerpt must return "", got:\n${extractFailureExcerpt(rawTodoRun.stdout)}`
      );
    }

    // Extra regression: real failing test whose title contains literal `# TODO` (Node TAP escapes as `\# TODO`) must NOT be skipped!
    {
      const src = [
        `import test from "node:test";`,
        `import assert from "node:assert/strict";`,
        `test("handles # TODO literal in title", () => { assert.equal(1, 2, "LITERAL_HASH_TODO_REAL_FAIL"); });`
      ].join("\n");
      const { cp, brief } = runRealTap("literal_hash_todo", src, 1);
      assert.ok((cp.lastTest?.failureExcerpt || "").includes("LITERAL_HASH_TODO_REAL_FAIL"));
      assert.ok((brief.anchors.failingChecks[0]?.firstErrorLine || "").includes("LITERAL_HASH_TODO_REAL_FAIL"));
    }

    // Extra Item 3 regressions: nested Node TAP subtests (TODO subtest & TODO outer suite), TAP 13/14 variants, unclosed YAML & verdict summary isolation
    {
      const nestedSrc = [
        `import test from "node:test";`,
        `import assert from "node:assert/strict";`,
        `test("todo outer suite", { todo: "wip" }, async (t) => {`,
        `  await t.test("inner under todo suite", () => { assert.equal(1, 2, "INNER_TODO_SUITE_DIAG"); });`,
        `});`,
        `test("outer real suite", async (t) => {`,
        `  await t.test("todo sibling", { todo: true }, () => { assert.equal(1, 2, "SUB_TODO_SIBLING"); });`,
        `  await t.test("real failing subtest", () => { assert.equal(1, 3, "SUB_REAL_FAIL_DIAG"); });`,
        `});`
      ].join("\n");
      const { cp, brief } = runRealTap("nested_subtests_todo", nestedSrc, 1);
      const ex = cp.lastTest?.failureExcerpt || "";
      assert.ok(ex.includes("SUB_REAL_FAIL_DIAG"), `Item 3 (nested): expected SUB_REAL_FAIL_DIAG, got:\n${ex}`);
      assert.ok(!ex.includes("INNER_TODO_SUITE_DIAG") && !ex.includes("SUB_TODO_SIBLING"));
      assert.ok((brief.anchors.failingChecks[0]?.firstErrorLine || "").includes("SUB_REAL_FAIL_DIAG"));

      // TAP 13/14 directive syntax variants: numberless/dashless, compact `1#TODO`, escaped backslash `\\# TODO` vs `\\\# TODO`, unclosed same-indent YAML & fallback prevLine isolation
      assert.ok(
        extractFailureExcerpt(
          "not ok broken feature # TODO tracked\n  ---\n  error: 'TODO_NONUM'\n  ...\nnot ok real fail\n  ---\n  error: 'REAL_NONUM'\n  ..."
        ).includes("REAL_NONUM")
      );
      assert.ok(
        extractFailureExcerpt(
          "not ok 1#TODO compact\n  ---\n  error: 'TODO_COMPACT'\n  ...\nnot ok 2 - real\n  ---\n  error: 'REAL_COMPACT'\n  ..."
        ).includes("REAL_COMPACT")
      );
      assert.ok(
        extractFailureExcerpt(
          "not ok 1 - foo \\\\# TODO tracked\n  ---\n  error: 'TODO_ESC_BS'\n  ...\nnot ok 2 - real\n  ---\n  error: 'REAL_ESC_BS'\n  ..."
        ).includes("REAL_ESC_BS")
      );
      assert.ok(
        extractFailureExcerpt("not ok 1 - foo \\\\\\# TODO\n  ---\n  error: 'REAL_ESC_HASH'\n  ...").includes("REAL_ESC_HASH")
      );
      const unclosedZero = extractFailureExcerpt(
        "not ok 1 - todo zero # TODO\n---\nerror: 'TODO_ZERO'\nnot ok 2 - real zero\n---\nerror: 'REAL_ZERO'\n..."
      );
      assert.ok(unclosedZero.includes("REAL_ZERO") && !unclosedZero.includes("TODO_ZERO"));
      const fallbackPrev = extractFailureExcerpt(
        "not ok 1 - todo case # TODO\n  ---\n  error: 'TODO_PREV_NO_LEAK'\nAssertionError: REAL_UNCAUGHT"
      );
      assert.ok(fallbackPrev.includes("REAL_UNCAUGHT") && !fallbackPrev.includes("TODO_PREV_NO_LEAK"));

      // Trailing TAP # TODO YAML block WITHOUT `# fail N` footer must NOT pollute SQLite summary or Handoff Brief!
      const rawTapEmit = path.join(tmpDir, "wrap3-trailing-todo-nofooter.mjs");
      fs.writeFileSync(
        rawTapEmit,
        [
          'console.log("TAP version 13");',
          'console.log("not ok 1 - real fail case");',
          'console.log("  ---");',
          'console.log("  error: \'REAL_FAIL_NOFOOTER\'");',
          'console.log("  ...");',
          'console.log("not ok 2 - trailing todo # TODO");',
          'console.log("  ---");',
          'console.log("  error: \'TRAILING_TODO_NOFOOTER_MUST_NOT_POLLUTE\'");',
          'console.log("  ...");',
          'console.log("1..2");',
          "process.exit(1);"
        ].join("\n"),
        "utf8"
      );
      const noFooterSid = "sess-wrap3-nofooter";
      const noFooterRun = spawnSync(
        process.execPath,
        [
          cliFilterPath,
          "--rule",
          "test-runner",
          "--b64",
          `b:${Buffer.from(`node ${JSON.stringify(rawTapEmit)}`, "utf8").toString("base64url")}`,
          "--session",
          `b:${Buffer.from(noFooterSid, "utf8").toString("base64url")}`
        ],
        { cwd: tmpDir, encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DB_PATH: tmpDb } }
      );
      assert.equal(noFooterRun.status, 1);
      const stNf = new ContextModeStore({ dbPath: tmpDb });
      try {
        const cpNf = stNf.getSessionCheckpoint(noFooterSid);
        const briefNf = buildHandoffBrief({
          store: stNf,
          mode: "agent",
          scope: "conversation",
          conversationId: noFooterSid,
          conversationConfirmed: true,
          sessionId: noFooterSid,
          cwd: tmpDir
        });
        assert.ok(!(cpNf.lastTest?.summary || "").includes("TRAILING_TODO_NOFOOTER_MUST_NOT_POLLUTE"));
        assert.ok((cpNf.lastTest?.summary || "").includes("REAL_FAIL_NOFOOTER"));
        assert.ok(!briefNf.markdown.includes("TRAILING_TODO_NOFOOTER_MUST_NOT_POLLUTE"));
        assert.ok(!(briefNf.anchors.failingChecks[0]?.summary || "").includes("TRAILING_TODO_NOFOOTER_MUST_NOT_POLLUTE"));
      } finally {
        stNf.close();
      }
    }

    // === Item 4: Strict per-line UTF-8 decoding across ALL fixed-window transcript paths ===
    const brainUtf8 = path.join(tmpDir, "brain-wrap4");
    const origReadSync = fs.readSync;
    const spyReadFixed = (filePath) => {
      let physicalBytes = 0;
      const calls = [];
      fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
        const n = origReadSync.call(fs, fd, buffer, offset, length, position);
        if (n > 0) {
          physicalBytes += n;
          calls.push({ length, position, n });
        }
        return n;
      };
      try {
        const res = readTranscriptHeadTailFixed(filePath);
        return { res, physicalBytes, calls };
      } finally {
        fs.readSync = origReadSync;
      }
    };
    const makeCorruptUserLine = (stepIdx, label) =>
      Buffer.concat([
        Buffer.from(`{"type":"USER_INPUT","step_index":${stepIdx},"user_input":"<USER_REQUEST>${label} `, "utf8"),
        Buffer.from([0x80, 0xff, 0xe4, 0xb8]),
        Buffer.from('</USER_REQUEST>"}\n', "utf8")
      ]);
    const makeValidFffdUserLine = (stepIdx, label) =>
      Buffer.concat([
        Buffer.from(`{"type":"USER_INPUT","step_index":${stepIdx},"user_input":"<USER_REQUEST>${label} `, "utf8"),
        Buffer.from([0xef, 0xbf, 0xbd]),
        Buffer.from('</USER_REQUEST>"}\n', "utf8")
      ]);
    const makeCleanUserLine = (stepIdx, label) =>
      Buffer.from(
        JSON.stringify({ type: "USER_INPUT", step_index: stepIdx, user_input: `<USER_REQUEST>${label}</USER_REQUEST>` }) + "\n",
        "utf8"
      );

    const stUtf8 = new ContextModeStore({ dbPath: tmpDb });
    try {
      // (a) Small file (< 64 KiB): corrupted lines at head & tail must be dropped; valid EF BF BD & adjacent good lines kept
      const convSmall = "conv-wrap4-small";
      const smallDir = path.join(brainUtf8, convSmall, ".system_generated", "logs");
      fs.mkdirSync(smallDir, { recursive: true });
      const smallTx = path.join(smallDir, "transcript.jsonl");
      fs.writeFileSync(
        smallTx,
        Buffer.concat([
          makeCorruptUserLine(1, "SMALL_HEAD_CORRUPT_DROP"),
          makeValidFffdUserLine(2, "SMALL_HEAD_VALID_FFFD"),
          makeCleanUserLine(3, "SMALL_MID_GOOD"),
          makeValidFffdUserLine(4, "SMALL_TAIL_VALID_FFFD"),
          makeCorruptUserLine(5, "SMALL_TAIL_CORRUPT_DROP")
        ])
      );
      const smallSpy = spyReadFixed(smallTx);
      assert.equal(smallSpy.res.overlapped, true);
      assert.equal(smallSpy.res.headSteps.length, 3);
      assert.equal(smallSpy.res.tailSteps.length, 3);
      const smallBrief = buildHandoffBrief({
        store: stUtf8,
        mode: "agent",
        scope: "conversation",
        conversationId: convSmall,
        conversationConfirmed: true,
        sessionId: convSmall,
        cwd: tmpDir,
        brainRoots: [brainUtf8]
      });
      assert.ok(smallBrief.markdown.includes("SMALL_HEAD_VALID_FFFD \uFFFD"), "Item 4 (small): valid EF BF BD head must survive");
      assert.ok(smallBrief.markdown.includes("SMALL_TAIL_VALID_FFFD \uFFFD"), "Item 4 (small): valid EF BF BD tail must survive");
      assert.ok(!smallBrief.markdown.includes("SMALL_HEAD_CORRUPT_DROP"), "Item 4 (small): corrupted head must NEVER enter User Intent");
      assert.ok(!smallBrief.markdown.includes("SMALL_TAIL_CORRUPT_DROP"), "Item 4 (small): corrupted tail must NEVER enter User Intent");

      // (b) Large file (> 220 KiB): corrupted + valid EF BF BD in head window, tail window 1st line, AND tail window subsequent lines!
      const convLarge = "conv-wrap4-large";
      const largeDir = path.join(brainUtf8, convLarge, ".system_generated", "logs");
      fs.mkdirSync(largeDir, { recursive: true });
      const largeTx = path.join(largeDir, "transcript.jsonl");

      const largeHeadBuf = Buffer.concat([
        makeCorruptUserLine(1, "LARGE_HEAD_CORRUPT_DROP"),
        makeValidFffdUserLine(2, "LARGE_HEAD_VALID_FFFD"),
        makeCleanUserLine(3, "LARGE_HEAD_GOOD_NEXT")
      ]);
      const middlePadBuf = Buffer.from(
        JSON.stringify({ type: "TOOL_RESULT", step_index: 10, content: "M".repeat(100 * 1024) }) + "\n",
        "utf8"
      );
      // Tail window exact 131,072 bytes:
      // - Line 1 at tailOffset: corrupted UTF-8 line -> MUST DROP
      // - Line 2 (restBuf): valid EF BF BD user goal -> MUST KEEP
      // - Line 3 (restBuf): corrupted UTF-8 user goal at the very end -> MUST DROP (so Line 2 stays latest intent!)
      const tailLine1Corrupt = makeCorruptUserLine(50, "LARGE_TAIL_FIRST_CORRUPT_DROP");
      const tailLine2ValidFffd = makeValidFffdUserLine(51, "LARGE_TAIL_REST_VALID_FFFD");
      const tailLine3Corrupt = makeCorruptUserLine(52, "LARGE_TAIL_REST_CORRUPT_DROP");
      const padShellBytes = Buffer.byteLength(JSON.stringify({ type: "TOOL_RESULT", step_index: 99, content: "" }) + "\n", "utf8");
      const tailPadLen = 131072 - tailLine1Corrupt.length - tailLine2ValidFffd.length - tailLine3Corrupt.length - padShellBytes;
      assert.ok(tailPadLen > 0);
      const tailPadBuf = Buffer.from(
        JSON.stringify({ type: "TOOL_RESULT", step_index: 99, content: "T".repeat(tailPadLen) }) + "\n",
        "utf8"
      );
      assert.equal(
        tailLine1Corrupt.length + tailPadBuf.length + tailLine2ValidFffd.length + tailLine3Corrupt.length,
        131072
      );
      fs.writeFileSync(
        largeTx,
        Buffer.concat([largeHeadBuf, middlePadBuf, tailLine1Corrupt, tailPadBuf, tailLine2ValidFffd, tailLine3Corrupt])
      );

      const largeSpy = spyReadFixed(largeTx);
      assert.equal(largeSpy.res.overlapped, false);
      assert.equal(largeSpy.calls.length, 2, "Item 4 (large): must perform strictly 2 reads (head + tail), zero extra probe");
      assert.ok(largeSpy.res.headBytesRead <= 65536 && largeSpy.res.tailBytesRead <= 131072);
      assert.ok(largeSpy.physicalBytes <= 65536 + 131072, `Item 4 (large): physical read exceeded cap: ${largeSpy.physicalBytes}`);

      const largeBrief = buildHandoffBrief({
        store: stUtf8,
        mode: "agent",
        scope: "conversation",
        conversationId: convLarge,
        conversationConfirmed: true,
        sessionId: convLarge,
        cwd: tmpDir,
        brainRoots: [brainUtf8]
      });
      assert.ok(largeBrief.markdown.includes("LARGE_HEAD_VALID_FFFD \uFFFD"), "Item 4 (large head): valid EF BF BD must survive");
      assert.ok(largeBrief.markdown.includes("LARGE_TAIL_REST_VALID_FFFD \uFFFD"), "Item 4 (large tail rest): valid EF BF BD must survive");
      assert.ok(!largeBrief.markdown.includes("LARGE_HEAD_CORRUPT_DROP"), "Item 4 (large head): corrupted line must be dropped");
      assert.ok(!largeBrief.markdown.includes("LARGE_TAIL_FIRST_CORRUPT_DROP"), "Item 4 (large tail first): corrupted line must be dropped");
      assert.ok(!largeBrief.markdown.includes("LARGE_TAIL_REST_CORRUPT_DROP"), "Item 4 (large tail rest): corrupted subsequent line must be dropped");

      // (c) Medium overlapped file (~150 KiB: headCap < fileSize <= headCap + tailCap) covering parseHeadSlice(reachedEof=false) & parseTailSliceExact(offset>0)
      const convMed = "conv-wrap4-medium";
      const medDir = path.join(brainUtf8, convMed, ".system_generated", "logs");
      fs.mkdirSync(medDir, { recursive: true });
      const medTx = path.join(medDir, "transcript.jsonl");
      const medPadBuf = Buffer.from(
        JSON.stringify({ type: "TOOL_RESULT", step_index: 20, content: "Q".repeat(145 * 1024) }) + "\n",
        "utf8"
      );
      fs.writeFileSync(
        medTx,
        Buffer.concat([
          makeCorruptUserLine(1, "MED_HEAD_CORRUPT_DROP"),
          makeValidFffdUserLine(2, "MED_HEAD_VALID_FFFD"),
          medPadBuf,
          makeValidFffdUserLine(3, "MED_TAIL_VALID_FFFD"),
          makeCorruptUserLine(4, "MED_TAIL_CORRUPT_DROP")
        ])
      );
      const medSpy = spyReadFixed(medTx);
      assert.equal(medSpy.res.overlapped, true);
      assert.ok(medSpy.res.fileSize > 65536 && medSpy.res.fileSize <= 65536 + 131072);
      const medBrief = buildHandoffBrief({
        store: stUtf8,
        mode: "agent",
        scope: "conversation",
        conversationId: convMed,
        conversationConfirmed: true,
        sessionId: convMed,
        cwd: tmpDir,
        brainRoots: [brainUtf8]
      });
      assert.ok(medBrief.markdown.includes("MED_HEAD_VALID_FFFD \uFFFD"));
      assert.ok(medBrief.markdown.includes("MED_TAIL_VALID_FFFD \uFFFD"));
      assert.ok(!medBrief.markdown.includes("MED_HEAD_CORRUPT_DROP"));
      assert.ok(!medBrief.markdown.includes("MED_TAIL_CORRUPT_DROP"));
    } finally {
      stUtf8.close();
    }

    // === Item 5: Shared Git deadline honored even on status===0 late return (controlled monoNsFn + gitExecFn) ===
    const gitRepo = path.join(tmpDir, "git-deadline-repo");
    fs.mkdirSync(gitRepo, { recursive: true });
    const fakeHead = "deadbeef0123456789abcdef0123456789abcdef";
    const stGit = new ContextModeStore({ dbPath: tmpDb });
    try {
      const sidGit = "sess-wrap5-git-deadline";
      stGit.recordVerificationResult(sidGit, {
        kind: "test",
        command: "npm test",
        exitCode: 0,
        passed: true,
        summary: "checkpoint_timely_preserved",
        worktree: gitRepo
      });

      const runDeadlineCase = (durationsNs, thirdReturnsTimeout = false) => {
        let nowNs = 10_000_000_000n;
        let idx = 0;
        const timeouts = [];
        const brief = buildHandoffBrief({
          store: stGit,
          mode: "agent",
          scope: "conversation",
          conversationId: sidGit,
          conversationConfirmed: true,
          sessionId: sidGit,
          cwd: gitRepo,
          gitBudgetMs: 1200,
          monoNsFn: () => nowNs,
          gitExecFn: (args, opts) => {
            timeouts.push(opts.timeout);
            nowNs += durationsNs[idx++] ?? 0n;
            if (args.includes("status")) {
              return { status: 0, stdout: "## feature/deadline-test\0 M app.js\0", stderr: "" };
            }
            if (args.includes("diff")) {
              return { status: 0, stdout: " app.js | 3 +++\n 1 file changed, 3 insertions(+)\n", stderr: "" };
            }
            if (thirdReturnsTimeout) {
              return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) };
            }
            return { status: 0, stdout: `${fakeHead}\tLATE_COMMIT_SUBJECT\n`, stderr: "" };
          }
        });
        return { brief, timeouts };
      };

      // (a) 450 + 450 + 290 = 1,190 ms control -> normal completion, HEAD kept
      const ctrl = runDeadlineCase([450_000_000n, 450_000_000n, 290_000_000n]);
      assert.deepEqual(ctrl.timeouts, [500, 500, 300]);
      assert.equal(ctrl.brief.gitTimedOut, false);
      assert.equal(ctrl.brief.anchors.gitHeadStatus, "commit");
      assert.equal(ctrl.brief.anchors.gitHead, fakeHead);
      assert.equal(ctrl.brief.anchors.gitDirtyEntries, 1);
      assert.ok(ctrl.brief.markdown.includes("feature/deadline-test") && ctrl.brief.markdown.includes("app.js | 3 +++") && ctrl.brief.markdown.includes("checkpoint_timely_preserved"));

      // (a2) 450 + 450 + 299.5 = 1,199.5 ms fractional boundary -> nanosecond isExpired() stays false, HEAD kept
      const subMs = runDeadlineCase([450_000_000n, 450_000_000n, 299_500_000n]);
      assert.equal(subMs.brief.gitTimedOut, false, "Item 5: 1199.5ms must NOT falsely expire via integer truncation");
      assert.equal(subMs.brief.anchors.gitHeadStatus, "commit");
      assert.equal(subMs.brief.anchors.gitHead, fakeHead);

      // (b) 450 + 450 + 301 = 1,201 ms late return with status===0 -> MUST report gitTimedOut=true, discard HEAD, keep timely facts!
      const lateOk = runDeadlineCase([450_000_000n, 450_000_000n, 301_000_000n], false);
      assert.deepEqual(lateOk.timeouts, [500, 500, 300]);
      assert.equal(lateOk.brief.gitTimedOut, true, "Item 5: 1201ms status===0 late return must mark gitTimedOut=true");
      assert.equal(lateOk.brief.anchors.gitHeadStatus, "unknown", "Item 5: post-deadline HEAD must be discarded");
      assert.equal(lateOk.brief.anchors.gitHead, "");
      assert.equal(lateOk.brief.anchors.gitDirtyEntries, 1, "Item 5: timely dirty entry count must be preserved");
      assert.ok(!lateOk.brief.markdown.includes(fakeHead) && !lateOk.brief.markdown.includes("LATE_COMMIT_SUBJECT"), "Item 5: late commit must NOT appear in brief");
      assert.ok(lateOk.brief.markdown.includes("feature/deadline-test"), "Item 5: timely branch must be preserved");
      assert.ok(lateOk.brief.markdown.includes("app.js | 3 +++"), "Item 5: timely diffStat must be preserved");
      assert.ok(lateOk.brief.markdown.includes("checkpoint_timely_preserved"), "Item 5: SQLite checkpoint must be preserved");
      assert.ok(lateOk.brief.markdown.includes("timed out after 1200ms budget"));

      // (c) Explicit ETIMEDOUT -> identical degradation with timely prior facts preserved
      const expTo = runDeadlineCase([450_000_000n, 450_000_000n, 300_000_000n], true);
      assert.deepEqual(expTo.timeouts, [500, 500, 300]);
      assert.equal(expTo.brief.gitTimedOut, true);
      assert.equal(expTo.brief.anchors.gitHeadStatus, "unknown");
      assert.equal(expTo.brief.anchors.gitHead, "");
      assert.equal(expTo.brief.anchors.gitDirtyEntries, 1);
      assert.ok(expTo.brief.markdown.includes("feature/deadline-test") && expTo.brief.markdown.includes("app.js | 3 +++") && expTo.brief.markdown.includes("checkpoint_timely_preserved"));

      // (d) Sub-millisecond late return (1,200.1 ms) & Step 2 late status===0 (450 + 751 = 1,201 ms: discards diffStat, skips log, preserves Step 1 status)
      const subMsLate = runDeadlineCase([450_000_000n, 450_000_000n, 300_100_000n], false);
      assert.equal(subMsLate.brief.gitTimedOut, true, "Item 5: 1200.1ms must be caught by nanosecond isExpired()");
      assert.equal(subMsLate.brief.anchors.gitHeadStatus, "unknown");
      assert.ok(!subMsLate.brief.markdown.includes("LATE_COMMIT_SUBJECT"));

      const step2Late = runDeadlineCase([450_000_000n, 751_000_000n, 100_000_000n], false);
      assert.deepEqual(step2Late.timeouts, [500, 500], "Item 5: Step 2 late return must skip spawning Step 3");
      assert.equal(step2Late.brief.gitTimedOut, true);
      assert.equal(step2Late.brief.anchors.gitHeadStatus, "unknown");
      assert.equal(step2Late.brief.anchors.gitDirtyEntries, 1);
      assert.ok(step2Late.brief.markdown.includes("feature/deadline-test"), "Step 1 branch preserved");
      assert.ok(!step2Late.brief.markdown.includes("app.js | 3 +++"), "Late Step 2 diffStat discarded");
      assert.ok(step2Late.brief.markdown.includes("checkpoint_timely_preserved"), "SQLite checkpoint preserved");
    } finally {
      stGit.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("v1.7.3-18: focusDesktopConversationWindow suppresses real OS spawn under node --test unless spawnFn is injected", () => {
  const defaultRes = focusDesktopConversationWindow({
    conversationId: "conv-no-steal-focus",
    cwd: "e:\\work\\agy-dart",
    workspaceLabel: "agy-dart",
    convTitle: "Should Not Steal Focus",
    platform: "win32"
  });
  assert.equal(defaultRes.dispatched, false, "Default spawnFn must be suppressed under node --test");
  assert.equal(defaultRes.suppressed, true);

  const disabledRes = focusDesktopConversationWindow({
    conversationId: "conv-disable-env",
    platform: "win32",
    baseEnv: { AGY_DART_DISABLE_OS_FOCUS: "1" }
  });
  assert.equal(disabledRes.dispatched, false);
  assert.equal(disabledRes.suppressed, true);

  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { on() {}, unref() {}, kill() {} };
  };
  const injectedRes = focusDesktopConversationWindow({
    conversationId: "conv-injected-spawn",
    cwd: "e:\\work\\agy-dart",
    platform: "win32",
    spawnFn: fakeSpawn
  });
  assert.equal(injectedRes.dispatched, true, "Explicitly injected spawnFn must still dispatch");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "powershell.exe");
});
