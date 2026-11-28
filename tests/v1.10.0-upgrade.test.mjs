import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as leaseCore from "../context/lib/watchdog-lease-core.js";
import * as leaseFacade from "../context/lib/watchdog-lease.js";
import {
  clearConversationSummaryCache,
  getConversationSummaryCacheStats,
  lookupConversationSummary
} from "../context/lib/watchdog-summaries.js";
import * as cacheAnalyzer from "../context/lib/cache-analyzer.js";
import * as watchdog from "../context/lib/watchdog.js";
import { ContextModeStore } from "../context/lib/store.js";
import { resetConfigCache } from "../context/lib/config.js";
import { getHeader } from "../sidecars/dashboard/http-helpers.mjs";
import {
  closeRuntimeStore,
  createStandaloneServer,
  getStaticUiAsset,
  registerSidecarUiAssets,
  UI_STATIC_ASSETS
} from "../sidecars/dashboard/server.mjs";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";
import {
  auditEnvironmentCache,
  formatCacheAuditMarkdown,
  parseCliArgs
} from "../scripts/cache-audit.mjs";
import { fetchDashboardHtml, readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// Wave 1: Hot-path lease split, true LRU summary cache, SQLite storage health & settingsInfo
// ============================================================================

test("v1.10.0-W1.1: watchdog-lease-core is zero-FS/zero-SQLite and hooks import it directly on hot path", () => {
  const coreSrc = fs.readFileSync(path.join(ROOT, "context", "lib", "watchdog-lease-core.js"), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(coreSrc), false, "watchdog-lease-core must not import node:fs");
  assert.equal(/from\s+["']node:sqlite["']/.test(coreSrc), false, "watchdog-lease-core must not import node:sqlite");

  const preHookSrc = fs.readFileSync(path.join(ROOT, "hooks", "pre-tool-use.mjs"), "utf8");
  const postHookSrc = fs.readFileSync(path.join(ROOT, "hooks", "post-tool-use.mjs"), "utf8");
  assert.ok(preHookSrc.includes("watchdog-lease-core.js"), "pre-tool-use hot path must load watchdog-lease-core.js");
  assert.ok(postHookSrc.includes("watchdog-lease-core.js"), "post-tool-use hot path must load watchdog-lease-core.js");

  // Backward-compatible facade re-exports all core symbols
  assert.equal(leaseFacade.WATCHDOG_PHASES, leaseCore.WATCHDOG_PHASES);
  assert.equal(leaseFacade.writeWatchdogLease, leaseCore.writeWatchdogLease);
  assert.equal(leaseFacade.readWatchdogLease, leaseCore.readWatchdogLease);
  assert.equal(typeof leaseFacade.lookupConversationSummary, "function");
  assert.equal(typeof leaseFacade.classifyTranscriptGenesisFile, "function");
});

test("v1.10.0-W1.2: watchdog-summaries lookup cache implements true O(1) LRU eviction", (t) => {
  const tmpDir = makeTempDir("agy-v110-lru-");
  const prevSummaryDb = process.env.AGY_DART_SUMMARY_DB_PATH;
  delete process.env.AGY_DART_SUMMARY_DB_PATH;
  t.after(() => {
    clearConversationSummaryCache();
    if (prevSummaryDb === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevSummaryDb;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const makeTx = (id) => {
    const dir = path.join(tmpDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const tx = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(tx, "{}\n", "utf8");
    return tx;
  };

  clearConversationSummaryCache();
  const tx0 = makeTx("lru-conv-000");
  lookupConversationSummary("lru-conv-000", { transcriptPath: tx0, allowDefaultDb: false });

  // Fill remaining 255 slots (capacity = 256)
  for (let i = 1; i < 256; i++) {
    const id = `lru-conv-${String(i).padStart(3, "0")}`;
    lookupConversationSummary(id, { transcriptPath: makeTx(id), allowDefaultDb: false });
  }
  const beforeTouch = getConversationSummaryCacheStats();
  assert.equal(beforeTouch.size, 256);
  assert.equal(beforeTouch.maxEntries, 256);
  assert.equal(beforeTouch.oldestKey?.startsWith("lru-conv-000\0"), true);

  // Touch lru-conv-000 so it moves to MRU position; lru-conv-001 becomes oldest
  lookupConversationSummary("lru-conv-000", { transcriptPath: tx0, allowDefaultDb: false });
  const afterTouch = getConversationSummaryCacheStats();
  assert.equal(afterTouch.oldestKey?.startsWith("lru-conv-001\0"), true, "LRU hit must refresh entry recency");

  // Insert 257th entry -> lru-conv-001 evicted, lru-conv-000 retained
  const tx256 = makeTx("lru-conv-256");
  lookupConversationSummary("lru-conv-256", { transcriptPath: tx256, allowDefaultDb: false });
  const afterEvict = getConversationSummaryCacheStats();
  assert.equal(afterEvict.size, 256);
  assert.equal(afterEvict.oldestKey?.startsWith("lru-conv-002\0"), true, "Oldest untouched key must be evicted first");
});

test("v1.10.0-W1.3: SQLite getStorageHealth, threshold-gated maybeAutoVacuum & getCoreSettingsInfo overrides", (t) => {
  const tmpDir = makeTempDir("agy-v110-store-");
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const store = new ContextModeStore({ dbPath });

  const prevEnv = {
    AGY_DART_CONFIG_PATH: process.env.AGY_DART_CONFIG_PATH,
    AGY_DART_MAX_READ_BYTES: process.env.AGY_DART_MAX_READ_BYTES,
    CONTEXT_MODE_MAX_READ_BYTES: process.env.CONTEXT_MODE_MAX_READ_BYTES,
    AGY_DART_STALL_WATCHDOG: process.env.AGY_DART_STALL_WATCHDOG,
    AGY_DART_DISABLE_STALL_WATCHDOG: process.env.AGY_DART_DISABLE_STALL_WATCHDOG,
    AGY_DART_DISABLE_CLI_FILTER: process.env.AGY_DART_DISABLE_CLI_FILTER,
    AGY_DART_DISABLE_READ_DEDUP: process.env.AGY_DART_DISABLE_READ_DEDUP,
    AGY_DART_TTL_KEEPALIVE: process.env.AGY_DART_TTL_KEEPALIVE,
    AGY_DART_DISABLE_TTL_KEEPALIVE: process.env.AGY_DART_DISABLE_TTL_KEEPALIVE,
    AGY_DART_TTL_KEEPALIVE_MAX_COUNT: process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT
  };

  t.after(() => {
    store.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // 1. Seed large sources then purge to create real SQLite freelist fragmentation
  const bigText = ("# Section\n" + "x".repeat(2048) + "\n").repeat(60);
  for (let i = 0; i < 6; i++) {
    store.indexContent({
      title: `big-${i}`,
      content: `${bigText}\nunique-${i}`,
      sourceType: "doc",
      sessionId: "frag-sess"
    });
  }
  store.purge({ scope: "session", sessionId: "frag-sess" });

  const healthBefore = store.getStorageHealth();
  assert.ok(healthBefore.pageSize > 0);
  assert.ok(healthBefore.freelistPages > 0, "Purging large content must produce SQLite freelist pages");
  assert.ok(healthBefore.reclaimableBytes > 0);
  assert.ok(healthBefore.reclaimablePct > 0);

  const docBefore = store.doctor();
  assert.equal(docBefore.freelistPages, healthBefore.freelistPages);
  assert.equal(docBefore.reclaimableBytes, healthBefore.reclaimableBytes);
  assert.deepEqual(docBefore.storageHealth, healthBefore);

  // 2. Threshold gate skips when minReclaimableBytes is higher than current freelist
  const skipped = store.maybeAutoVacuum({ minReclaimableBytes: 500 * 1024 * 1024, minReclaimablePct: 99 });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.vacuumed, false);
  assert.equal(skipped.reason, "below_threshold");

  // 3. Lower threshold triggers VACUUM and records cooldown
  const vacuumed = store.maybeAutoVacuum({ minReclaimableBytes: 4096, minReclaimablePct: 5 });
  assert.equal(vacuumed.ok, true);
  assert.equal(vacuumed.vacuumed, true);
  assert.equal(vacuumed.reason, "threshold_met");
  assert.equal(vacuumed.storageHealth.freelistPages, 0);
  assert.ok(vacuumed.storageHealth.lastVacuumTs > 0);

  // 4. Immediate repeat hits cooldown, while force=true bypasses cooldown
  const cooled = store.maybeAutoVacuum({ minReclaimableBytes: 0, minReclaimablePct: 0, cooldownMs: 60_000 });
  assert.equal(cooled.vacuumed, false);
  assert.equal(cooled.reason, "cooldown");

  const forced = store.maybeAutoVacuum({ force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.vacuumed, true);
  assert.equal(forced.reason, "forced");

  // 5. getCoreSettingsInfo reports env & config overrides accurately (and labels app scope accurately)
  fs.writeFileSync(cfgPath, JSON.stringify({ maxReadBytes: 32768, readDedup: false }), "utf8");
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  process.env.AGY_DART_DISABLE_CLI_FILTER = "1";
  process.env.AGY_DART_STALL_WATCHDOG = "0";
  process.env.AGY_DART_TTL_KEEPALIVE_MAX_COUNT = "3";
  delete process.env.AGY_DART_MAX_READ_BYTES;
  delete process.env.CONTEXT_MODE_MAX_READ_BYTES;
  delete process.env.AGY_DART_DISABLE_READ_DEDUP;
  delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
  delete process.env.AGY_DART_TTL_KEEPALIVE;
  delete process.env.AGY_DART_DISABLE_TTL_KEEPALIVE;
  resetConfigCache();

  store.setCutoff(16384, null);
  store.setCliFilterEnabled(true, null);
  store.setReadDedupEnabled(true, null);
  store.setWatchdogEnabled(true);
  store.setGlobalTtlKeepaliveMaxCount(0);

  const info = store.getCoreSettingsInfo(null);
  assert.equal(info.cutoff.cutoffBytes, 32768);
  assert.equal(info.cutoff.overriddenBy, "config");
  assert.equal(info.cliFilter.effective, false);
  assert.equal(info.cliFilter.overriddenBy, "env");
  assert.equal(info.readDedup.effective, false);
  assert.equal(info.readDedup.overriddenBy, "config");
  assert.equal(info.watchdog.effective, false);
  assert.equal(info.watchdog.overriddenBy, "env");
  assert.equal(info.ttlKeepalive.effectiveMaxCount, 3);
  assert.equal(info.ttlKeepalive.overriddenBy, "env");

  // App-scope SQLite toggle must report scope="app" and effectiveSource="sqlite:app"
  delete process.env.AGY_DART_DISABLE_CLI_FILTER;
  resetConfigCache();
  store.setCliFilterEnabled(false, "app");
  const appInfo = store.getCoreSettingsInfo("app");
  assert.equal(appInfo.cliFilter.effective, false);
  assert.equal(appInfo.cliFilter.scope, "app");
  assert.equal(appInfo.cliFilter.effectiveSource, "sqlite:app");
});

// ============================================================================
// Wave 2: Core backend modularization & zero-SQLite cache-analyzer invariant
// ============================================================================

test("v1.10.0-W2: split backend modules preserve facade exports, deduplicate getHeader, and keep cache-analyzer SQLite-free", () => {
  // cache-analyzer invariant: zero direct node:sqlite or ./store imports
  for (const rel of [
    "context/lib/cache-analyzer.js",
    "context/lib/cache/transcript-locator.js",
    "context/lib/cache/usage-normalizer.js"
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/["']node:sqlite["']/.test(src), false, `${rel} must not import node:sqlite`);
    assert.equal(/from\s+["']\.\/store/.test(src), false, `${rel} must not import ./store`);
  }

  // Facade exports intact
  for (const fn of [
    "findTranscriptForConversation",
    "readTranscriptTail",
    "extractStepTokenUsage",
    "extractStepMaxTokenLimit",
    "estimateCalibratedTtl",
    "parseTranscriptLines",
    "analyzeTranscriptCache"
  ]) {
    assert.equal(typeof cacheAnalyzer[fn], "function", `cache-analyzer must re-export ${fn}`);
  }
  for (const fn of [
    "WatchdogMonitor",
    "sendDesktopNotification",
    "computeEffectiveKeepaliveMinRemainSec",
    "hasPendingKeepaliveColdCheck",
    "isKeepalivePendingAckActive"
  ]) {
    assert.equal(typeof watchdog[fn], "function", `watchdog must re-export ${fn}`);
  }

  // Deduplicated getHeader
  assert.equal(getHeader({ "Content-Type": "application/json" }, "content-type"), "application/json");
  assert.equal(getHeader(new Headers({ "X-Test": "ok" }), "x-test"), "ok");
  for (const rel of ["sidecars/dashboard/update-archive.mjs", "sidecars/dashboard/version-check.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/\bfunction\s+getHeader\b/.test(src), false, `${rel} should import getHeader from http-helpers.mjs`);
  }
});

// ============================================================================
// Wave 3: Modular Dashboard UI, static serving (Standalone + SidecarApp), CSP & 4 UX upgrades
// ============================================================================

test("v1.10.0-W3.1: Standalone HTTP & SidecarApp serve /ui/* assets with nosniff/no-store and tightened CSP", async (t) => {
  const tmpDir = makeTempDir("agy-v110-ui-");
  const prevDb = process.env.AGY_DART_DB_PATH;
  process.env.AGY_DART_DB_PATH = path.join(tmpDir, "context.db");
  closeRuntimeStore();

  const srv = createStandaloneServer({ csrfToken: "test-token-v110" });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // 1. Modular index.html shell + strengthened CSP
  const rawIndex = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  assert.ok(rawIndex.split(/\r?\n/).length < 900, "index.html should stay a slim semantic HTML shell");
  assert.ok(rawIndex.includes('href="/ui/styles.css"'));
  assert.ok(rawIndex.includes('src="/ui/app.js"'));

  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  const csp = htmlRes.headers.get("content-security-policy") || "";
  assert.ok(csp.includes("default-src 'self'"), `Expected default-src 'self' in CSP, got: ${csp}`);
  assert.ok(csp.includes("base-uri 'none'"), `Expected base-uri 'none' in CSP, got: ${csp}`);
  assert.ok(csp.includes("frame-ancestors 'none'"), `Expected frame-ancestors 'none' in CSP, got: ${csp}`);

  // 2. All 6 /ui/* assets served cleanly over HTTP
  for (const [routePath, spec] of Object.entries(UI_STATIC_ASSETS)) {
    const res = await fetch(`${baseUrl}${routePath}`);
    assert.equal(res.status, 200, `GET ${routePath} must return 200`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-type"), spec.contentType);
    const body = await res.text();
    assert.ok(body.length > 50, `Expected non-empty body for ${routePath}`);
  }

  // 3. Traversal / unlisted /ui/* routes rejected with 404
  const badRes = await fetch(`${baseUrl}/ui/nonexistent.js`);
  assert.equal(badRes.status, 404);
  assert.equal(getStaticUiAsset("/ui/../server.mjs"), null);

  // 4. fetchDashboardHtml resolves live assets into inline HTML
  const inlined = await fetchDashboardHtml(baseUrl);
  assert.ok(inlined.includes("<style>"));
  assert.ok(inlined.includes("function renderCoreSettingsOverrides("));
  assert.ok(inlined.includes("function renderStorageHealth("));

  // 5. SidecarApp helper registers all 6 /ui/* routes via app.page(...)
  const pages = new Map();
  class FakeSidecarResponse {
    constructor(body, opts) {
      this.body = body;
      this.opts = opts;
    }
  }
  registerSidecarUiAssets(
    {
      page(route, handler) {
        pages.set(route, handler);
      }
    },
    FakeSidecarResponse
  );
  for (const routePath of Object.keys(UI_STATIC_ASSETS)) {
    assert.ok(pages.has(routePath), `SidecarApp must register ${routePath}`);
    const out = pages.get(routePath)();
    assert.equal(out.opts.status, 200);
    assert.equal(out.opts.headers["Cache-Control"], "no-store");
    assert.equal(out.opts.headers["X-Content-Type-Options"], "nosniff");
    assert.ok(out.body.length > 50);
  }
});

test("v1.10.0-W3.2: Dashboard VM verifies ResizeObserver cache reuse, 4 override badges, storage compact UI, i18n parity & pagehide/pageshow", async () => {
  const html = readDashboardHtml();
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScript = scriptMatches[scriptMatches.length - 1][1];

  const listeners = new Map();
  const addWinListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  const removeWinListener = (type, fn) => {
    listeners.get(type)?.delete(fn);
  };

  let resizeCb = null;
  let disconnectCount = 0;
  class MockResizeObserver {
    constructor(cb) {
      resizeCb = cb;
    }
    observe() {}
    disconnect() {
      disconnectCount += 1;
    }
  }

  let stripSetAttrDensityCalls = 0;
  let rowWidth = 600;
  let winWidth = 600;
  const elements = new Map();
  const makeEl = (id, initClasses = []) => {
    const classes = new Set(initClasses);
    const attrs = new Map();
    const el = {
      id,
      value: id === "cutoff-select" ? "46080" : "",
      textContent: "",
      innerText: "",
      innerHTML: "",
      title: "",
      hidden: false,
      disabled: false,
      dataset: {},
      style: {},
      options: [],
      offsetWidth: 40,
      offsetLeft: 0,
      scrollWidth: 40,
      clientWidth: 600,
      children: [],
      classList: {
        add(...cs) {
          for (const c of cs) classes.add(c);
        },
        remove(...cs) {
          for (const c of cs) classes.delete(c);
        },
        contains(c) {
          return classes.has(c);
        }
      },
      getAttribute(k) {
        return attrs.get(k) || "";
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      addEventListener() {},
      removeEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getBoundingClientRect() {
        return { top: 100, height: 80 };
      }
    };
    elements.set(id, el);
    return el;
  };

  const brandEl = { offsetWidth: 200, scrollWidth: 200, children: [] };
  const rowEl = {
    get clientWidth() {
      return rowWidth;
    },
    querySelector(sel) {
      return sel === ".brand-group" ? brandEl : null;
    }
  };
  const stripEl = {
    style: {},
    offsetWidth: 160,
    scrollWidth: 160,
    _density: "medium",
    closest(sel) {
      return sel === ".topbar-row" ? rowEl : null;
    },
    getAttribute(k) {
      return k === "data-density" ? this._density : "";
    },
    setAttribute(k, v) {
      if (k === "data-density") {
        stripSetAttrDensityCalls += 1;
        this._density = String(v);
      }
    }
  };
  const chip1 = makeEl("chip-1");
  chip1.setAttribute("data-nav-target", "kv-cache-card");
  makeEl("kv-cache-card");
  for (const id of [
    "cli-filter-override-badge",
    "read-dedup-override-badge",
    "wd-override-badge",
    "ka-override-badge",
    "db-reclaimable-sub",
    "vacuum-only-btn"
  ]) {
    makeEl(id, ["hidden"]);
  }

  const fetchCalls = [];
  let intervalId = 1;
  const activeIntervals = new Set();

  const sandbox = {
    console,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Promise,
    Headers,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    queueMicrotask,
    ResizeObserver: MockResizeObserver,
    setTimeout: (fn) => {
      if (typeof fn === "function") return 1;
      return 1;
    },
    clearTimeout: () => {},
    setInterval: () => {
      const id = intervalId++;
      activeIntervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      activeIntervals.delete(id);
    },
    alert: () => {},
    confirm: () => true,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, vacuumed: true, reclaimedBytes: 2 * 1024 * 1024 })
      };
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {
      get innerWidth() {
        return winWidth;
      },
      innerHeight: 900,
      scrollY: 0,
      location: { search: "" },
      requestAnimationFrame: (fn) => fn(),
      addEventListener: addWinListener,
      removeEventListener: removeWinListener,
      matchMedia: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {}
      })
    },
    document: {
      hidden: false,
      documentElement: { lang: "en", dataset: {}, setAttribute() {}, getAttribute: () => "light", scrollHeight: 2000 },
      title: "",
      addEventListener() {},
      removeEventListener() {},
      getElementById(id) {
        return elements.get(id) || makeEl(id);
      },
      querySelector(sel) {
        if (sel === "[data-section-jump-strip]") return stripEl;
        if (sel === 'meta[name="agy-dart-token"]') return { getAttribute: () => "vm-csrf" };
        return null;
      },
      querySelectorAll(sel) {
        if (sel === "[data-section-jump-strip] [data-nav-target]") return [chip1];
        return [];
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${mainScript}
    globalThis.__testApi = {
      I18N,
      renderCoreSettingsOverrides,
      renderStorageHealth,
      runStorageVacuumOnly,
      teardownDashboardLifecycle,
      resumeDashboardLifecycle,
      getPollTimer: () => pollTimer,
      setLang: (l) => { currentLang = l; }
    };`,
    sandbox,
    { filename: "sidecars/dashboard/index.html" }
  );

  // 1. Strict EN/ZH i18n dictionary key parity
  const enKeys = Object.keys(sandbox.__testApi.I18N.en).sort();
  const zhKeys = Object.keys(sandbox.__testApi.I18N.zh).sort();
  assert.deepEqual(zhKeys, enKeys, "EN and ZH I18N dictionaries must have identical key sets");

  // 2. ResizeObserver does NOT thrash width cache on 1px drags within >390px breakpoint
  assert.ok(typeof resizeCb === "function", "ResizeObserver callback must be registered");
  stripSetAttrDensityCalls = 0;
  for (let w = 599; w >= 550; w--) {
    rowWidth = w;
    winWidth = w;
    resizeCb();
  }
  assert.equal(
    stripSetAttrDensityCalls,
    0,
    `1px resize drags within same breakpoint must reuse cachedJumpWidths (0 forced measurements, got ${stripSetAttrDensityCalls})`
  );

  // Crossing <= 390px breakpoint DOES invalidate cache and re-measure
  rowWidth = 360;
  winWidth = 360;
  resizeCb();
  assert.ok(stripSetAttrDensityCalls >= 2, "Crossing <=390px breakpoint must re-measure jump strip widths");

  // 3. All 4 core setting override badges render in EN and ZH
  const settingsPayload = {
    settingsInfo: {
      cliFilter: { effective: false, saved: true, overriddenBy: "env" },
      readDedup: { effective: false, saved: true, overriddenBy: "config" },
      watchdog: { effective: false, saved: true, overriddenBy: "env" },
      ttlKeepalive: { effective: true, effectiveMaxCount: 4, savedMaxCount: 0, overriddenBy: "env" }
    }
  };
  sandbox.__testApi.renderCoreSettingsOverrides(settingsPayload);
  for (const id of [
    "cli-filter-override-badge",
    "read-dedup-override-badge",
    "wd-override-badge",
    "ka-override-badge"
  ]) {
    const el = elements.get(id);
    assert.equal(el.classList.contains("hidden"), false, `${id} must be visible when overridden`);
    assert.ok(el.textContent.includes("Override:"), `${id} EN label missing`);
  }
  sandbox.__testApi.setLang("zh");
  sandbox.__testApi.renderCoreSettingsOverrides(settingsPayload);
  assert.ok(elements.get("cli-filter-override-badge").textContent.includes("环境变量"));
  assert.ok(elements.get("read-dedup-override-badge").textContent.includes("config.json"));

  // 4. Storage health fragmentation subtext & one-click vacuum_only action
  sandbox.__testApi.renderStorageHealth({ reclaimableBytes: 8 * 1024 * 1024, reclaimablePct: 42.3 });
  assert.equal(elements.get("db-reclaimable-sub").classList.contains("hidden"), false);
  assert.ok(elements.get("db-reclaimable-sub").textContent.includes("42%"));
  assert.equal(elements.get("vacuum-only-btn").classList.contains("hidden"), false);

  await sandbox.__testApi.runStorageVacuumOnly();
  const maintCall = fetchCalls.find((c) => c.url === "/api/maintenance");
  assert.ok(maintCall, "Compact DB button must POST /api/maintenance");
  assert.deepEqual(JSON.parse(maintCall.opts.body), { action: "vacuum_only" });

  // Healthy low-fragmentation hides reclaimable badge & compact button
  sandbox.__testApi.renderStorageHealth({ reclaimableBytes: 4096, reclaimablePct: 1.0 });
  assert.equal(elements.get("db-reclaimable-sub").classList.contains("hidden"), true);
  assert.equal(elements.get("vacuum-only-btn").classList.contains("hidden"), true);

  // 5. pagehide tears down polling/observer; persisted pageshow restores cleanly without duplicate listeners
  assert.ok(listeners.get("pagehide")?.size >= 1, "pagehide listener must be bound");
  assert.ok(listeners.get("pageshow")?.size >= 1, "pageshow listener must be bound");
  for (const fn of listeners.get("pagehide")) fn();
  assert.equal(sandbox.__testApi.getPollTimer(), null, "pagehide must clear pollTimer");
  assert.ok(disconnectCount >= 1, "pagehide must disconnect ResizeObserver");

  const scrollCountBefore = listeners.get("scroll")?.size || 0;
  assert.equal(scrollCountBefore, 0, "pagehide must remove scroll listener");
  for (const fn of listeners.get("pageshow")) fn({ persisted: true });
  assert.notEqual(sandbox.__testApi.getPollTimer(), null, "persisted pageshow must restart pollTimer");
  assert.equal(listeners.get("scroll")?.size, 1, "persisted pageshow must rebind scroll listener once");
});

// ============================================================================
// Wave 4: Prefix budget metadata accounting & cache-audit workspace scoping
// ============================================================================

test("v1.10.0-W4.1: prefix-budget accounts for live MCP instructions and agents/*.md discovery metadata", async () => {
  const report = await auditPrefixBudget(ROOT);
  assert.equal(report.blocks.tools.canonical, true);
  assert.ok(report.blocks.mcpInstructions, "prefix-budget must include blocks.mcpInstructions");
  assert.ok(report.blocks.mcpInstructions.context.tokens > 0, "context MCP instructions must be measured live");
  assert.ok(report.blocks.agentMetadata, "prefix-budget must include blocks.agentMetadata");
  assert.equal(report.blocks.agentMetadata.agentCount, 2);
  assert.ok(report.blocks.agentMetadata.tokens > 0);
  assert.equal(
    report.metadataTokens,
    report.blocks.mcpInstructions.tokens + report.blocks.agentMetadata.tokens
  );
  assert.equal(report.totalTokensWithMetadata, report.totalTokens + report.metadataTokens);
  assert.equal(
    report.configuredStartup.estimatedTokensWithMetadata,
    report.configuredStartup.estimatedTokens + report.metadataTokens
  );
});

test("v1.10.0-W4.2: cache-audit tags workspace vs global findings and supports --workspace-only", async (t) => {
  const tmpDir = makeTempDir("agy-v110-audit-");
  const cfgDir = path.join(tmpDir, "global-config");
  const wsDir = path.join(tmpDir, "workspace");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  // Global config has an oversized rule (>1500 tok) AND an invalid-frontmatter skill
  fs.mkdirSync(path.join(cfgDir, "rules"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "rules", "huge-global.md"), "word ".repeat(2200), "utf8");
  fs.mkdirSync(path.join(cfgDir, "skills", "bad-global-skill"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "skills", "bad-global-skill", "SKILL.md"), "# No YAML header\n", "utf8");

  // Workspace has its own missing-frontmatter skill
  fs.mkdirSync(path.join(wsDir, ".agents", "skills", "bad-ws-skill"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, ".agents", "skills", "bad-ws-skill", "SKILL.md"), "# Workspace skill without FM\n", "utf8");

  // Full audit sees both workspace and global findings
  const full = await auditEnvironmentCache({ workspace: wsDir, configDir: cfgDir, live: false });
  assert.ok(full.findingsByScope.global >= 2, `Expected >= 2 global findings, got ${JSON.stringify(full.findingsByScope)}`);
  assert.ok(full.findingsByScope.workspace >= 1, `Expected >= 1 workspace finding, got ${JSON.stringify(full.findingsByScope)}`);
  for (const f of full.findings) {
    assert.ok(f.scopeGroup === "workspace" || f.scopeGroup === "global");
  }
  const fullMd = formatCacheAuditMarkdown(full);
  assert.ok(fullMd.includes(`(workspace: ${full.findingsByScope.workspace}, global: ${full.findingsByScope.global})`));

  // Workspace-only audit excludes all global config findings
  const wsOnly = await auditEnvironmentCache({
    workspace: wsDir,
    configDir: cfgDir,
    live: false,
    workspaceOnly: true
  });
  assert.equal(wsOnly.options.workspaceOnly, true);
  assert.equal(wsOnly.findingsByScope.global, 0, "workspaceOnly must emit 0 global findings");
  assert.ok(wsOnly.findingsByScope.workspace >= 1, "workspaceOnly must retain workspace findings");
  const wsOnlyMd = formatCacheAuditMarkdown(wsOnly);
  assert.ok(wsOnlyMd.includes("scopeFilter=workspace-only"));

  // CLI argument parser recognizes --workspace-only
  const parsed = parseCliArgs(["node", "cache-audit.mjs", "--workspace", wsDir, "--workspace-only", "--no-live"]);
  assert.equal(parsed.workspaceOnly, true);
  assert.equal(parsed.live, false);
});
