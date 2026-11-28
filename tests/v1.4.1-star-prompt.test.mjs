import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CACHE_AUDIT_PASSED_META_KEY,
  ContextModeStore,
  STAR_PROMPT_META_KEY,
  STAR_PROMPT_MIN_SAVED_BYTES,
  STAR_PROMPT_MIN_SESSIONS,
  normalizeStarPromptState
} from "../context/lib/store.js";
import { resetConfigCache } from "../context/lib/config.js";
import { createTools } from "../context/lib/tools.js";
import {
  GH_STAR_COMMAND,
  GITHUB_REPO_URL,
  isGhCliAuthenticated,
  printStarFollowupHint
} from "../scripts/install.mjs";
import {
  closeRuntimeStore,
  createStandaloneServer,
  registerSidecarRoutes
} from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function httpRawRequest(port, urlPath, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    if (body !== null && body !== undefined && reqHeaders["Content-Length"] === undefined) {
      reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: reqHeaders
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d.toString("utf8")));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function seedSavedBytes(store, sessionId, keptBytes, returnedBytes = 500) {
  const rawBytes = keptBytes + returnedBytes;
  store.recordEvent({
    sessionId,
    worktree: ROOT,
    agent: "main",
    kind: "cli_filter",
    tool: "run_command",
    key: "test_seed",
    ok: true,
    bytes: rawBytes,
    sandboxBytes: rawBytes,
    returnedBytes
  });
}

test("v1.4.1-1: Legacy DB / missing or malformed starPrompt defaults cleanly to pending", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-star-compat-"));
  const dbPath = path.join(tmpDir, "legacy.db");

  try {
    // Pure normalizer handles null, undefined, legacy objects, corrupt JSON, and unknown state
    const cases = [
      null,
      undefined,
      "",
      "{corrupt json",
      "[]",
      JSON.stringify({ cutoff: 16384 }),
      JSON.stringify({ starPrompt: {} }),
      JSON.stringify({ state: "unknown_evil_state", triggeredAt: 123, milestoneSavedBytes: -5 }),
      { starPrompt: "not-an-object" },
      { state: "pending", triggeredAt: "", resolvedAt: null, milestoneSavedBytes: "not-a-num" }
    ];
    for (const c of cases) {
      assert.deepEqual(normalizeStarPromptState(c), {
        state: "pending",
        triggeredAt: null,
        resolvedAt: null,
        milestoneSavedBytes: 0
      });
    }
    assert.deepEqual(normalizeStarPromptState(JSON.stringify({ starPrompt: { milestoneSavedBytes: 42 } })), {
      state: "pending",
      triggeredAt: null,
      resolvedAt: null,
      milestoneSavedBytes: 42
    });

    // Valid wrapper or direct object preserves valid state & fields
    assert.deepEqual(
      normalizeStarPromptState({
        starPrompt: {
          state: "dismissed",
          triggeredAt: "2026-11-20T00:00:00.000Z",
          resolvedAt: "2026-11-20T00:01:00.000Z",
          milestoneSavedBytes: 204800
        }
      }),
      {
        state: "dismissed",
        triggeredAt: "2026-11-20T00:00:00.000Z",
        resolvedAt: "2026-11-20T00:01:00.000Z",
        milestoneSavedBytes: 204800
      }
    );

    // Fresh/legacy SQLite store without star_prompt meta row returns pending cleanly
    const store = new ContextModeStore({ dbPath });
    try {
      assert.equal(store.getMeta(STAR_PROMPT_META_KEY, null), null);
      assert.deepEqual(store.getStarPromptState(), {
        state: "pending",
        triggeredAt: null,
        resolvedAt: null,
        milestoneSavedBytes: 0
      });

      // Even if a corrupt value was manually written in meta, read still fails open to pending
      store.setMeta(STAR_PROMPT_META_KEY, "{not-valid-json");
      assert.deepEqual(store.getStarPromptState(), {
        state: "pending",
        triggeredAt: null,
        resolvedAt: null,
        milestoneSavedBytes: 0
      });
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4.1-2: Milestone gating (<100 KB / <3 sessions stay hidden; >=100 KB & >=3 sessions or cache:audit pass triggers)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-star-gate-"));
  const dbSavingsPath = path.join(tmpDir, "savings.db");
  const dbAuditPath = path.join(tmpDir, "audit.db");
  const cfgDir = path.join(tmpDir, "cfg");
  const wsDir = path.join(tmpDir, "ws");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "mcp_config.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  fs.writeFileSync(path.join(wsDir, "AGENTS.md"), "# Concise Rules\nKeep prompt prefix lean.\n", "utf8");

  try {
    // A. Savings + distinct session count gating
    const store = new ContextModeStore({ dbPath: dbSavingsPath });
    try {
      // 3 distinct sessions, but total saved < 100 KB -> shouldShow: false
      seedSavedBytes(store, "sess-1", 30 * 1024);
      seedSavedBytes(store, "sess-2", 30 * 1024);
      seedSavedBytes(store, "sess-3", 20 * 1024); // 80 KB total
      let ev = store.evaluateStarPrompt({ markTriggered: true });
      assert.equal(ev.state, "pending");
      assert.equal(ev.sessionCount, 3);
      assert.ok(ev.lifetimeSavedBytes < STAR_PROMPT_MIN_SAVED_BYTES);
      assert.equal(ev.shouldShow, false);
      assert.equal(ev.triggeredAt, null);

      // >= 100 KB across only 2 sessions (separate DB) -> shouldShow: false
      const twoSessDb = path.join(tmpDir, "two-sess.db");
      const twoStore = new ContextModeStore({ dbPath: twoSessDb });
      try {
        seedSavedBytes(twoStore, "s-a", 80 * 1024);
        seedSavedBytes(twoStore, "s-b", 60 * 1024);
        const ev2 = twoStore.evaluateStarPrompt({ markTriggered: true });
        assert.equal(ev2.sessionCount, 2);
        assert.ok(ev2.lifetimeSavedBytes >= STAR_PROMPT_MIN_SAVED_BYTES);
        assert.equal(ev2.shouldShow, false, "Must require >= 3 distinct sessions");
      } finally {
        twoStore.close();
      }

      // Add another 30 KB (110 KB total) across the 3 sessions -> triggers & records triggeredAt
      seedSavedBytes(store, "sess-1", 30 * 1024);
      ev = store.evaluateStarPrompt({ markTriggered: true, nowIso: "2026-11-21T10:00:00.000Z" });
      assert.equal(ev.state, "pending");
      assert.equal(ev.shouldShow, true);
      assert.equal(ev.triggerReason, "savings_milestone");
      assert.equal(ev.triggeredAt, "2026-11-21T10:00:00.000Z");
      assert.ok(ev.lifetimeSavedBytes >= STAR_PROMPT_MIN_SAVED_BYTES);
      assert.equal(ev.sessionCount >= STAR_PROMPT_MIN_SESSIONS, true);
    } finally {
      store.close();
    }

    // Reopen DB: triggeredAt preserved and banner stays pending/visible until explicit action
    const reopened = new ContextModeStore({ dbPath: dbSavingsPath });
    try {
      const evReopen = reopened.evaluateStarPrompt({ markTriggered: true, nowIso: "2026-11-22T00:00:00.000Z" });
      assert.equal(evReopen.state, "pending");
      assert.equal(evReopen.shouldShow, true);
      assert.equal(evReopen.triggeredAt, "2026-11-21T10:00:00.000Z");
    } finally {
      reopened.close();
    }

    // B. cache:audit passing run flips shouldShow even with 0 saved bytes
    const auditRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "cache-audit.mjs"), "--workspace", wsDir, "--config-dir", cfgDir, "--no-live"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          AGY_DART_DB_PATH: dbAuditPath,
          AGY_DART_DISABLE_COMPILE_CACHE: "1"
        }
      }
    );
    assert.equal(auditRes.status, 0, auditRes.stderr);
    assert.equal(auditRes.stderr, "", "cache:audit must emit zero stderr");

    const auditStore = new ContextModeStore({ dbPath: dbAuditPath });
    try {
      assert.ok(auditStore.getMeta(CACHE_AUDIT_PASSED_META_KEY, null), "Passing cache:audit must record meta flag");
      const evAudit = auditStore.evaluateStarPrompt({ markTriggered: true });
      assert.equal(evAudit.cacheAuditPassed, true);
      assert.equal(evAudit.shouldShow, true);
      assert.equal(evAudit.triggerReason, "cache_audit");
    } finally {
      auditStore.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4.1-3: Terminal states persist permanently (survive purge/prune) and Sidecar UI renders & collapses cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-star-ui-"));
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;

  try {
    // 1. All 3 terminal states persist across purge("all"), pruneByTtl(0), and DB reopen
    for (const terminalState of ["clicked", "dismissed", "copied_cli"]) {
      const dbFile = path.join(tmpDir, `term-${terminalState}.db`);
      const st = new ContextModeStore({ dbPath: dbFile });
      try {
        seedSavedBytes(st, "s1", 50 * 1024);
        seedSavedBytes(st, "s2", 50 * 1024);
        seedSavedBytes(st, "s3", 50 * 1024);
        assert.equal(st.evaluateStarPrompt({ markTriggered: true }).shouldShow, true);

        const res = st.setStarPromptState(terminalState, { nowIso: "2026-11-21T12:00:00.000Z" });
        assert.equal(res.ok, true);
        assert.equal(res.starPrompt.state, terminalState);
        assert.equal(res.starPrompt.resolvedAt, "2026-11-21T12:00:00.000Z");

        // Survives purge("all") and pruneByTtl({ maxAgeDays: 0 })
        st.purge({ scope: "all" });
        st.pruneByTtl({ maxAgeDays: 0 });
        st.recordCacheAuditPassed();
        assert.equal(st.evaluateStarPrompt({ markTriggered: true }).shouldShow, false);

        // Once resolved, subsequent terminal mutation does NOT overwrite original state
        const second = st.setStarPromptState(terminalState === "clicked" ? "dismissed" : "clicked");
        assert.equal(second.alreadyResolved, true);
        assert.equal(second.starPrompt.state, terminalState);
      } finally {
        st.close();
      }

      const reopened = new ContextModeStore({ dbPath: dbFile });
      try {
        const check = reopened.evaluateStarPrompt({ markTriggered: true });
        assert.equal(check.state, terminalState);
        assert.equal(check.shouldShow, false);
      } finally {
        reopened.close();
      }
    }

    // 2. Frontend Sidecar UI VM test (index.html)
    const htmlSource = readDashboardHtml();
    assert.ok(htmlSource.includes('id="github-star-link"'));
    assert.ok(htmlSource.includes(`href="${GITHUB_REPO_URL}"`));
    assert.ok(htmlSource.includes('id="star-milestone-banner"'));

    const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptBlocks.length >= 1);
    const mainUiScript = scriptBlocks[scriptBlocks.length - 1][1];
    assert.equal(/apiFetch\([^)]*method:\s*['"]GET['"]/.test(mainUiScript), false);

    const runUiScenario = async (initialStarPrompt) => {
      const elements = new Map();
      const makeEl = (id) => ({
        id,
        value: id === "cutoff-select" ? "46080" : "",
        innerText: "",
        textContent: "",
        innerHTML: "",
        className: "",
        title: "",
        style: {},
        dataset: {},
        options: id === "cutoff-select" ? [{ value: "0" }, { value: "46080" }] : [],
        classList: {
          _s: new Set(id === "star-milestone-banner" || id === "star-banner-feedback" ? ["hidden"] : []),
          add(c) { this._s.add(c); },
          remove(c) { this._s.delete(c); },
          contains(c) { return this._s.has(c); }
        },
        getAttribute(attr) {
          return attr === "content" ? "vm-csrf-token" : "";
        },
        scrollIntoView() {}
      });
      const getEl = (id) => {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
      };

      const copiedTexts = [];
      const postedStarStates = [];
      let currentSp = structuredClone(initialStarPrompt);

      const mockFetch = async (urlPath, opts = {}) => {
        const mkJson = (obj, status = 200) => ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => structuredClone(obj)
        });
        if (urlPath === "/api/star-prompt") {
          assert.equal(opts.method, "POST");
          const body = JSON.parse(opts.body);
          postedStarStates.push(body.state);
          currentSp = {
            ...currentSp,
            state: body.state,
            shouldShow: false,
            resolvedAt: "2026-11-21T12:30:00.000Z"
          };
          return mkJson({ ok: true, starPrompt: currentSp });
        }
        if (urlPath === "/api/stats") {
          return mkJson({
            isPaused: false,
            cutoffBytes: 46080,
            conversationCutoffBytes: 46080,
            appCutoffBytes: 46080,
            globalCutoffBytes: 46080,
            exemptCategories: ["images"],
            cliFilterEnabled: true,
            readDedupEnabled: true,
            starPrompt: currentSp
          });
        }
        if (urlPath === "/api/doctor") return mkJson({ status: "HEALTHY", dbSizeBytes: 4096, walSizeBytes: 0 });
        if (urlPath === "/api/cache-diag") return mkJson({ transcriptFound: false, turnsWithUsage: 0 });
        if (urlPath === "/api/watchdog") return mkJson({ ok: true, enabled: true, current: { severity: "idle", phase: "IDLE" } });
        if (urlPath === "/api/resume") return mkJson({ recentEvents: [], recentSources: [] });
        return mkJson({ ok: true });
      };

      const timers = [];
      const sandbox = {
        window: { location: { search: "?conversationId=ui-star-conv" }, addEventListener() {}, sidecar: null },
        document: {
          title: "",
          documentElement: { lang: "en" },
          getElementById: getEl,
          querySelector: () => getEl("meta-csrf"),
          querySelectorAll: () => []
        },
        navigator: {
          language: "en-US",
          clipboard: {
            writeText: async (text) => {
              copiedTexts.push(text);
            }
          }
        },
        localStorage: { getItem: () => "en", setItem: () => {} },
        URLSearchParams,
        Headers,
        fetch: mockFetch,
        alert: () => {},
        confirm: () => true,
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: (fn) => {
          timers.push(fn);
          return timers.length;
        },
        clearTimeout: () => {},
        console: { log() {}, warn() {}, error() {} }
      };
      vm.createContext(sandbox);
      vm.runInContext(
        `${mainUiScript}\nglobalThis.__starTest = { refreshData, setLanguage, handleHeaderStarClick, handleStarBannerOpen, handleStarBannerDismiss, handleStarBannerCopyCli };`,
        sandbox
      );
      await new Promise((r) => setTimeout(r, 30));
      return { sandbox, getEl, copiedTexts, postedStarStates, timers };
    };

    // Hidden when below milestone
    const belowUi = await runUiScenario({
      state: "pending",
      shouldShow: false,
      lifetimeSavedBytes: 4096,
      sessionCount: 1
    });
    assert.equal(belowUi.getEl("star-milestone-banner").classList.contains("hidden"), true);

    // Visible when milestone reached; toggles EN <-> ZH cleanly; Dismiss hides & persists
    const aboveUi = await runUiScenario({
      state: "pending",
      shouldShow: true,
      lifetimeSavedBytes: 153600,
      sessionCount: 3
    });
    assert.equal(aboveUi.getEl("star-milestone-banner").classList.contains("hidden"), false);
    assert.ok(aboveUi.getEl("star-banner-msg").textContent.includes("Star or Watch releases"));

    aboveUi.sandbox.__starTest.setLanguage("zh");
    assert.ok(aboveUi.getEl("star-banner-msg").textContent.includes("已为你累计拦下"));

    aboveUi.sandbox.__starTest.handleStarBannerDismiss();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(aboveUi.postedStarStates, ["dismissed"]);
    assert.equal(aboveUi.getEl("star-milestone-banner").classList.contains("hidden"), true);
    await aboveUi.sandbox.__starTest.refreshData(false);
    assert.equal(aboveUi.getEl("star-milestone-banner").classList.contains("hidden"), true);

    // Copy CLI button copies safe command client-side only, shows notice, posts copied_cli, then collapses
    const copyUi = await runUiScenario({
      state: "pending",
      shouldShow: true,
      lifetimeSavedBytes: 0,
      cacheAuditPassed: true,
      sessionCount: 0
    });
    assert.equal(copyUi.getEl("star-milestone-banner").classList.contains("hidden"), false);
    await copyUi.sandbox.__starTest.handleStarBannerCopyCli();
    assert.deepEqual(copyUi.copiedTexts, [GH_STAR_COMMAND]);
    assert.deepEqual(copyUi.postedStarStates, ["copied_cli"]);
    assert.equal(copyUi.getEl("star-banner-feedback").classList.contains("hidden"), false);
    for (const fn of copyUi.timers) {
      try { fn(); } catch {}
    }
    assert.equal(copyUi.getEl("star-milestone-banner").classList.contains("hidden"), true);

    // Primary Open button & Header Star link both persist clicked & hide banner
    const openUi = await runUiScenario({
      state: "pending",
      shouldShow: true,
      lifetimeSavedBytes: 153600,
      sessionCount: 3
    });
    assert.equal(openUi.getEl("star-milestone-banner").classList.contains("hidden"), false);
    openUi.sandbox.__starTest.handleStarBannerOpen();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(openUi.postedStarStates, ["clicked"]);
    assert.equal(openUi.getEl("star-milestone-banner").classList.contains("hidden"), true);

    const headerUi = await runUiScenario({
      state: "pending",
      shouldShow: true,
      lifetimeSavedBytes: 153600,
      sessionCount: 3
    });
    assert.equal(headerUi.getEl("star-milestone-banner").classList.contains("hidden"), false);
    headerUi.sandbox.__starTest.handleHeaderStarClick();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(headerUi.postedStarStates, ["clicked"]);
    assert.equal(headerUi.getEl("star-milestone-banner").classList.contains("hidden"), true);
  } finally {
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4.1-4: /api/star-prompt enforces POST-only, CSRF, Origin/Referer/Host, Content-Type, body cap & strict field/state whitelist", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-star-sec-"));
  const dbPath = path.join(tmpDir, "sec.db");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;

  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "missing-cfg.json");
  resetConfigCache();

  try {
    const seed = new ContextModeStore({ dbPath });
    seedSavedBytes(seed, "sec-1", 60 * 1024);
    seedSavedBytes(seed, "sec-2", 60 * 1024);
    seedSavedBytes(seed, "sec-3", 60 * 1024);
    seed.close();

    // 1. SidecarApp route contract check
    const routes = new Map();
    const mockApp = {
      config: { conversationId: "sec-1" },
      api(routePath, handler, method) {
        assert.equal(method, "POST");
        routes.set(routePath, handler);
      }
    };
    registerSidecarRoutes(mockApp);
    const spHandler = routes.get("/api/star-prompt");
    assert.equal(typeof spHandler, "function");
    for (const bad of [null, [], "clicked", {}, { state: "pending" }, { state: "clicked", extra: 1 }]) {
      const r = await spHandler(bad);
      assert.equal(r?.status, 400, `SidecarApp /api/star-prompt must reject ${JSON.stringify(bad)} with 400`);
    }

    // 2. Standalone HTTP security check
    const token = "test-v141-star-csrf-token-0123456789abcdef";
    const srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: {
        findTranscriptFn: () => null,
        notifyFn: () => {}
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // GET -> 405 Allow: POST
      const getRes = await httpRawRequest(port, "/api/star-prompt", {
        method: "GET",
        headers: { "X-Agy-Dart-Token": token }
      });
      assert.equal(getRes.status, 405);
      assert.equal(getRes.headers.allow, "POST");

      // Missing / wrong CSRF token -> 403
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403
      );
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": "0".repeat(token.length) },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403
      );

      // Host / Origin / Referer / Sec-Fetch-Site rejections -> 403
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { Host: `evil.test:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403
      );
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-Agy-Dart-Token": token },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403
      );
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: {
              Referer: "https://evil.example/page",
              "Content-Type": "application/json",
              "X-Agy-Dart-Token": token
            },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403
      );
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: {
              Referer: `http://localhost:${port}/`,
              "Content-Type": "application/json",
              "X-Agy-Dart-Token": token
            },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403,
        "Cross-host localhost Referer when Host is 127.0.0.1 must be blocked"
      );
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: {
              "Sec-Fetch-Site": "same-site",
              "Content-Type": "application/json",
              "X-Agy-Dart-Token": token
            },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        403
      );

      // Non-JSON Content-Type -> 415
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "text/plain", "X-Agy-Dart-Token": token },
            body: JSON.stringify({ state: "clicked" })
          })
        ).status,
        415
      );

      // Oversized > 64 KB body -> 413
      assert.equal(
        (
          await httpRawRequest(port, "/api/star-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
            body: JSON.stringify({ state: "x".repeat(70000) })
          })
        ).status,
        413
      );

      // Invalid state values & injected extra fields -> 400
      for (const badBody of [
        {},
        { state: "" },
        { state: "pending" },
        { state: "auto_star" },
        { state: 123 },
        { state: "clicked", injected: true },
        { state: "dismissed", command: GH_STAR_COMMAND }
      ]) {
        const res = await httpRawRequest(port, "/api/star-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
          body: JSON.stringify(badBody)
        });
        assert.equal(res.status, 400, `Payload ${JSON.stringify(badBody)} must return 400`);
      }

      // Valid same-origin POST /api/stats shows pending & shouldShow=true
      const beforeStats = await httpRawRequest(port, "/api/stats", {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          Referer: `http://127.0.0.1:${port}/`,
          "Content-Type": "application/json",
          "X-Agy-Dart-Token": token
        },
        body: JSON.stringify({ scope: "conversation", conversationId: "sec-1" })
      });
      assert.equal(beforeStats.status, 200);
      assert.equal(beforeStats.json.starPrompt.state, "pending");
      assert.equal(beforeStats.json.starPrompt.shouldShow, true);

      // Valid same-origin POST /api/star-prompt -> 200 and permanent suppression
      const okMut = await httpRawRequest(port, "/api/star-prompt", {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          Referer: `http://127.0.0.1:${port}/`,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-Agy-Dart-Token": token
        },
        body: JSON.stringify({ state: "clicked" })
      });
      assert.equal(okMut.status, 200);
      assert.equal(okMut.json.ok, true);
      assert.equal(okMut.json.starPrompt.state, "clicked");
      assert.equal(okMut.json.starPrompt.shouldShow, false);

      const afterStats = await httpRawRequest(port, "/api/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: JSON.stringify({ scope: "conversation", conversationId: "sec-1" })
      });
      assert.equal(afterStats.status, 200);
      assert.equal(afterStats.json.starPrompt.state, "clicked");
      assert.equal(afterStats.json.starPrompt.shouldShow, false);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  } finally {
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.4.1-5: Non-interactive install/doctor tail hints, <=1.5s gh resilience, --json isolation & zero MCP context pollution", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-star-cli-"));
  const installDir = path.join(tmpDir, "installed");
  const missingDir = path.join(tmpDir, "missing-target");
  const projDir = path.join(tmpDir, "proj");
  const dbPath = path.join(tmpDir, "cli.db");

  try {
    // 1. isGhCliAuthenticated fail-open & strict <=1.5s timeout checks
    assert.equal(isGhCliAuthenticated({ bin: "definitely-missing-gh-binary-xyz-999" }), false);
    assert.equal(
      isGhCliAuthenticated({ bin: process.execPath, args: ["-e", "process.exit(1)"] }),
      false
    );
    assert.equal(
      isGhCliAuthenticated({ bin: process.execPath, args: ["-e", "process.exit(0)"] }),
      true
    );
    const t0 = Date.now();
    const slowRes = isGhCliAuthenticated({
      bin: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 250
    });
    const elapsed = Date.now() - t0;
    assert.equal(slowRes, false, "Timed-out gh check must fail open to false");
    assert.ok(elapsed < 1500, `Timed-out gh check must abort promptly (<1500ms, got ${elapsed}ms)`);

    // 2. printStarFollowupHint emits optional gh line strictly when ghAuthenticated=true
    const captureLog = (fn) => {
      const lines = [];
      const orig = console.log;
      console.log = (...a) => lines.push(a.join(" "));
      try {
        fn();
      } finally {
        console.log = orig;
      }
      return lines.join("\n");
    };
    const outNoGh = captureLog(() => printStarFollowupHint({ mode: "install", ghAuthenticated: false }));
    assert.ok(outNoGh.includes(GITHUB_REPO_URL));
    assert.equal(outNoGh.includes(GH_STAR_COMMAND), false);
    const outWithGh = captureLog(() => printStarFollowupHint({ mode: "install", ghAuthenticated: true }));
    assert.ok(outWithGh.includes(GITHUB_REPO_URL));
    assert.ok(outWithGh.includes(GH_STAR_COMMAND));

    // 3. Stripped PATH (no gh) install + doctor succeed with exit 0 and print repo link exactly once
    const strippedEnv = {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json"),
      AGY_DART_DISABLE_COMPILE_CACHE: "1"
    };
    delete strippedEnv.PATH;
    delete strippedEnv.Path;
    strippedEnv.PATH = path.dirname(process.execPath);
    if (process.platform === "win32") {
      strippedEnv.Path = path.dirname(process.execPath);
    }

    const insRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir],
      { encoding: "utf8", windowsHide: true, env: strippedEnv }
    );
    assert.equal(insRes.status, 0, `${insRes.stdout}\n${insRes.stderr}`);
    const urlMatches = insRes.stdout.split(GITHUB_REPO_URL).length - 1;
    assert.equal(urlMatches, 1, `install must print GitHub URL exactly once (got ${urlMatches})`);
    assert.equal(insRes.stdout.includes(GH_STAR_COMMAND), false);

    const docRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "doctor", "--target", installDir],
      { encoding: "utf8", windowsHide: true, env: strippedEnv }
    );
    assert.equal(docRes.status, 0, `${docRes.stdout}\n${docRes.stderr}`);
    assert.ok(docRes.stdout.includes(GITHUB_REPO_URL));
    assert.equal(docRes.stdout.includes(GH_STAR_COMMAND), false);
    assert.ok(Buffer.byteLength(docRes.stdout, "utf8") < 4096, "doctor output must remain compact (<4 KB)");

    // 4. doctor --json stays strictly parseable JSON with zero Star/GitHub prose
    const docJsonRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "doctor", "--target", installDir, "--json"],
      { encoding: "utf8", windowsHide: true, env: strippedEnv }
    );
    assert.equal(docJsonRes.status, 0, `${docJsonRes.stdout}\n${docJsonRes.stderr}`);
    const parsedDoc = JSON.parse(docJsonRes.stdout);
    assert.equal(parsedDoc.ok, true);
    assert.equal(parsedDoc.installed, true);
    assert.equal(docJsonRes.stdout.includes(GITHUB_REPO_URL), false);
    assert.equal(docJsonRes.stdout.includes(GH_STAR_COMMAND), false);

    // 5. Failing doctor omits Star hint and doctor --json emits valid JSON on missing install
    const failDocRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "doctor", "--target", missingDir],
      { encoding: "utf8", windowsHide: true, env: strippedEnv }
    );
    assert.equal(failDocRes.status, 1);
    assert.equal(failDocRes.stdout.includes(GITHUB_REPO_URL), false);

    const failJsonRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "doctor", "--target", missingDir, "--json"],
      { encoding: "utf8", windowsHide: true, env: strippedEnv }
    );
    assert.equal(failJsonRes.status, 1);
    const parsedFail = JSON.parse(failJsonRes.stdout);
    assert.equal(parsedFail.ok, false);
    assert.equal(parsedFail.installed, false);

    // 6. Windows PowerShell wrapper install.ps1 -Command doctor -Json -Project works non-interactively
    if (process.platform === "win32") {
      fs.mkdirSync(projDir, { recursive: true });
      const projInstall = spawnSync(
        process.execPath,
        [path.join(ROOT, "scripts", "install.mjs"), "install", "--project", projDir],
        { encoding: "utf8", windowsHide: true, env: strippedEnv }
      );
      assert.equal(projInstall.status, 0, `${projInstall.stdout}\n${projInstall.stderr}`);

      const powershellExe = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const psDocText = spawnSync(
        powershellExe,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(ROOT, "install.ps1"),
          "-Command",
          "doctor",
          "-Project",
          projDir
        ],
        { encoding: "utf8", windowsHide: true, env: strippedEnv }
      );
      assert.equal(psDocText.status, 0, `${psDocText.stdout}\n${psDocText.stderr}`);
      assert.ok(psDocText.stdout.includes(GITHUB_REPO_URL));

      const psDocJson = spawnSync(
        powershellExe,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(ROOT, "install.ps1"),
          "-Command",
          "doctor",
          "-Project",
          projDir,
          "-Json"
        ],
        { encoding: "utf8", windowsHide: true, env: strippedEnv }
      );
      assert.equal(psDocJson.status, 0, `${psDocJson.stdout}\n${psDocJson.stderr}`);
      const parsedPs = JSON.parse(psDocJson.stdout);
      assert.equal(parsedPs.ok, true);
      assert.equal(psDocJson.stdout.includes(GITHUB_REPO_URL), false);
    }

    // 7. Static & MCP red-line audits: zero interactive prompts, zero auto-Star execution, zero AI context pollution
    const ps1Src = fs.readFileSync(path.join(ROOT, "install.ps1"), "utf8");
    const shSrc = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
    const serverSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "server.mjs"), "utf8");
    assert.equal(/Read-Host/i.test(ps1Src), false, "install.ps1 must stay strictly non-interactive");
    assert.equal(/\bread\s+-p\b/i.test(shSrc), false, "install.sh must stay strictly non-interactive");
    assert.equal(/gh\s+api/i.test(serverSrc), false, "server.mjs must never execute gh api");
    assert.equal(/api\.github\.com/i.test(serverSrc), false, "server.mjs must never call GitHub APIs");

    const toolStore = new ContextModeStore({ dbPath });
    try {
      const tools = createTools({ store: toolStore });
      const mcpDoctor = JSON.stringify(await tools.ctx_doctor({ cwd: ROOT }));
      const mcpStats = JSON.stringify(await tools.ctx_stats({ sessionId: "all" }));
      assert.equal(mcpDoctor.includes("zou172866/Antigravity-agy-dart"), false);
      assert.equal(mcpDoctor.includes("gh api"), false);
      assert.equal(mcpStats.includes("zou172866/Antigravity-agy-dart"), false);
      assert.equal(mcpStats.includes("gh api"), false);
    } finally {
      toolStore.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
