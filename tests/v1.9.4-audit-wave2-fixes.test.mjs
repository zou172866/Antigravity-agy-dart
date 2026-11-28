import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

import {
  getConfigSnapshot,
  getConfigStatCount,
  resetConfigCache,
  withConfigSnapshot
} from "../context/lib/config.js";
import {
  computeKeepalivePingTokenSplit,
  resolveModelProfile,
  scheduleKeepAlivePings
} from "../context/lib/cache/profiles.js";
import { simulateCachePolicies } from "../context/lib/cache-simulator.js";
import { ContextModeStore } from "../context/lib/store.js";
import { WatchdogMonitor } from "../context/lib/watchdog.js";
import { WATCHDOG_PHASES, writeWatchdogLease } from "../context/lib/watchdog-lease.js";
import {
  CONTEXT_MCP_TOOL_NAMES,
  DEVTOOLS_FILES,
  FAST_MCP_TOOL_NAMES,
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  RUNTIME_FILES
} from "../scripts/install.mjs";
import { verifyPackageManifest } from "../scripts/verify-package-graph.mjs";
import { computeBriefMetrics, syncBriefFile } from "../scripts/gen-review-brief.mjs";
import {
  closeRuntimeStore,
  handleCutoffMutation,
  registerSidecarRoutes
} from "../sidecars/dashboard/server.mjs";
import { RELEASES_URL } from "../sidecars/dashboard/version-check.mjs";
import { UpdateError } from "../sidecars/dashboard/update-archive.mjs";
import {
  createPluginUpdater,
  extractFrozenStringListStrict,
  readPackageManifestFromArchive,
  selectFallbackRuntimeFiles
} from "../sidecars/dashboard/version-update.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTarHeader(name, size, typeByte = 48) {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name, "utf8").copy(header, 0, 0, 100);
  Buffer.from((typeByte === 53 ? 0o755 : 0o644).toString(8).padStart(7, "0") + "\0", "latin1").copy(header, 100);
  Buffer.from("0000000\0", "latin1").copy(header, 108);
  Buffer.from("0000000\0", "latin1").copy(header, 116);
  Buffer.from(size.toString(8).padStart(11, "0") + "\0", "latin1").copy(header, 124);
  Buffer.from("00000000000\0", "latin1").copy(header, 136);
  Buffer.from("        ", "latin1").copy(header, 148);
  header[156] = typeByte;
  Buffer.from("ustar\0", "latin1").copy(header, 257);
  Buffer.from("00", "latin1").copy(header, 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "latin1").copy(header, 148);
  return header;
}

function buildTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contentBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || "", "utf8");
    blocks.push(makeTarHeader(entry.name, contentBuf.length, 48));
    if (contentBuf.length > 0) {
      blocks.push(contentBuf);
      const pad = (512 - (contentBuf.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function makeMockStreamRes(status, buffer, url = "") {
  let consumed = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: {
      cancel: async () => {},
      getReader: () => ({
        read: async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: new Uint8Array(buffer) };
        },
        releaseLock: () => {}
      })
    }
  };
}

function setupMockPluginInstall(rootDir, version = "1.9.3") {
  const sidecarDir = path.join(rootDir, "sidecars", "dashboard");
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "plugin.json"), JSON.stringify({ name: "agy-dart", version }));
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "agy-dart", version }));
  fs.writeFileSync(
    path.join(sidecarDir, "sidecar.json"),
    fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8")
  );
  fs.writeFileSync(path.join(sidecarDir, "server.mjs"), "// old server\n");
  return sidecarDir;
}

function makeMinimalArchiveEntries(version, { manifestContent = undefined, installScriptContent = null } = {}) {
  const prefix = `Antigravity-agy-dart-${version}/`;
  const sidecarJson = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8");
  const baseFiles = [
    "plugin.json",
    "package.json",
    "mcp_config.json",
    "hooks.json",
    "sidecars/dashboard/sidecar.json",
    "sidecars/dashboard/server.mjs",
    "sidecars/dashboard/index.html",
    "scripts/install.mjs",
    "context/server.js",
    "fast/mcp-server.mjs"
  ];
  const entries = [
    { name: `${prefix}plugin.json`, content: JSON.stringify({ name: "agy-dart", version }) },
    { name: `${prefix}package.json`, content: JSON.stringify({ name: "agy-dart", version, type: "module" }) },
    { name: `${prefix}mcp_config.json`, content: fs.readFileSync(path.join(ROOT, "mcp_config.json"), "utf8") },
    { name: `${prefix}hooks.json`, content: fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8") },
    { name: `${prefix}sidecars/dashboard/sidecar.json`, content: sidecarJson },
    { name: `${prefix}sidecars/dashboard/server.mjs`, content: `// server ${version}\n` },
    { name: `${prefix}sidecars/dashboard/index.html`, content: `<html>${version}</html>` },
    { name: `${prefix}context/server.js`, content: "// ctx\n" },
    { name: `${prefix}fast/mcp-server.mjs`, content: "// fast\n" },
    {
      name: `${prefix}scripts/install.mjs`,
      content: installScriptContent ?? `export const RUNTIME_FILES = Object.freeze(${JSON.stringify(baseFiles)});\n`
    }
  ];
  if (manifestContent !== undefined) {
    entries.push({ name: `${prefix}scripts/package-manifest.json`, content: manifestContent });
  }
  return entries;
}

// ============================================================================
// M10: Watchdog idle polling shares 1 config snapshot per tick (<= 40 stats / 40 ticks)
// ============================================================================
test("Wave2-M10: WatchdogMonitor shares one config snapshot per tick (40 idle ticks <= 40 config stats) and preserves hot config reload", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-m10-"));
  const dbPath = path.join(tmpDir, "ctx.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}\n", "utf8");

  const prevCfgPath = process.env.AGY_DART_CONFIG_PATH;
  const prevWatchdogEnv = process.env.AGY_DART_STALL_WATCHDOG;
  const prevDisableWatchdogEnv = process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  delete process.env.AGY_DART_STALL_WATCHDOG;
  delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
  resetConfigCache();

  const store = new ContextModeStore({ dbPath });
  const origStatSync = fs.statSync;
  t.after(() => {
    fs.statSync = origStatSync;
    try {
      store.close();
    } catch {}
    if (prevCfgPath === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgPath;
    if (prevWatchdogEnv === undefined) delete process.env.AGY_DART_STALL_WATCHDOG;
    else process.env.AGY_DART_STALL_WATCHDOG = prevWatchdogEnv;
    if (prevDisableWatchdogEnv === undefined) delete process.env.AGY_DART_DISABLE_STALL_WATCHDOG;
    else process.env.AGY_DART_DISABLE_STALL_WATCHDOG = prevDisableWatchdogEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Seed 8 IDLE leases (matching audit M10 reproduction)
  let wallMs = Date.parse("2026-11-27T10:00:00Z");
  let monoNs = 1_000_000_000_000n;
  for (let i = 0; i < 8; i++) {
    writeWatchdogLease(store, {
      conversationId: `idle-conv-${i}`,
      phase: WATCHDOG_PHASES.IDLE,
      model: "Gemini 4 Carbon (High)",
      contextTokens: 80000,
      updatedTs: wallMs - 10_000,
      lastHeartbeatTs: wallMs - 10_000,
      phaseChangedTs: wallMs - 10_000
    });
  }

  // Verify withConfigSnapshot shares 1 stat across repeated getConfigSnapshot calls
  const beforeScopeCount = getConfigStatCount();
  withConfigSnapshot(() => {
    for (let i = 0; i < 20; i++) getConfigSnapshot();
  });
  assert.equal(getConfigStatCount() - beforeScopeCount, 1, "withConfigSnapshot must stat config.json only once");

  const monitor = new WatchdogMonitor({
    getStore: () => store,
    nowFn: () => wallMs,
    monoNsFn: () => monoNs,
    lookupSummaryFn: () => ({ found: false, isSubagent: false, archived: false })
  });

  const normalizedCfg = path.resolve(cfgPath).toLowerCase();
  let realConfigStatCalls = 0;
  let realTranscriptStatCalls = 0;
  fs.statSync = function wrappedStatSync(target, ...rest) {
    const resolved = typeof target === "string" ? path.resolve(target).toLowerCase() : "";
    if (resolved === normalizedCfg) realConfigStatCalls += 1;
    else if (resolved.endsWith("transcript.jsonl")) realTranscriptStatCalls += 1;
    return origStatSync.call(fs, target, ...rest);
  };

  for (let tickIdx = 0; tickIdx < 40; tickIdx++) {
    wallMs += 5000;
    monoNs += 5_000_000_000n;
    const res = monitor.tick();
    assert.equal(res.enabled, true);
  }

  assert.equal(realTranscriptStatCalls, 0, "IDLE polling must perform 0 transcript fs.statSync calls");
  assert.equal(monitor.statSyncCount, 0, "monitor.statSyncCount (transcript stats) must stay 0 when all leases are IDLE");
  assert.ok(
    realConfigStatCalls <= 40,
    `40 idle ticks must perform <= 40 config.json fs.statSync calls (was 1,440), got ${realConfigStatCalls}`
  );
  assert.equal(
    monitor.configStatCount,
    realConfigStatCalls,
    "monitor.configStatCount must accurately account for config.json stats"
  );

  // Hot-reload check: external write to config.json takes effect immediately on the next tick without resetConfigCache()
  fs.writeFileSync(cfgPath, JSON.stringify({ stallWatchdog: false }, null, 2), "utf8");
  const futureDate = new Date(Date.now() + 5000);
  fs.utimesSync(cfgPath, futureDate, futureDate);
  wallMs += 5000;
  monoNs += 5_000_000_000n;
  const afterEdit = monitor.tick();
  assert.equal(afterEdit.enabled, false, "External edit to config.json must take effect on the very next tick");
});

// ============================================================================
// M11: Offline keepalive simulator interval endpoints & Gemini 4 2,050-token tail reprocess
// ============================================================================
test("Wave2-M11: Keep-alive scheduler aligns 1x/unlimited endpoints (1s/254s/255s/256s/270s/300s) and Carbon 120K 2,050-token tail reprocess ($0.031854)", () => {
  // 1. Direct single-source scheduler checks
  for (const sec of [0, 1, 254]) {
    assert.equal(scheduleKeepAlivePings(sec, { pingIntervalSec: 255, maxPings: 1 }).pings, 0);
    assert.equal(scheduleKeepAlivePings(sec, { pingIntervalSec: 255, maxPings: 24 }).pings, 0);
  }
  for (const sec of [255, 256, 270, 300]) {
    assert.equal(scheduleKeepAlivePings(sec, { pingIntervalSec: 255, maxPings: 1 }).pings, 1);
    assert.equal(scheduleKeepAlivePings(sec, { pingIntervalSec: 255, maxPings: 24 }).pings, 1);
  }
  assert.equal(scheduleKeepAlivePings(510, { pingIntervalSec: 255, maxPings: 1 }).pings, 1);
  assert.equal(scheduleKeepAlivePings(510, { pingIntervalSec: 255, maxPings: 24 }).pings, 2);

  // 2. Single-source Gemini 4 tail reprocess split math:
  //    Carbon ($4/1M, 95% discount, 2,050 tail) @ 120k + 16 overhead:
  //    cached = 117,950 @ 0.05x (5,897.5 equiv) + uncached = 2,066 @ 1.0x -> 7,963.5 * $4 / 1e6 = $0.031854
  const carbonProfile = resolveModelProfile("Gemini 4 Carbon (High)");
  const split = computeKeepalivePingTokenSplit(120000, { pingOverheadTokens: 16, profile: carbonProfile });
  assert.deepEqual(split, {
    cachedReadTokens: 117950,
    uncachedTokens: 2066,
    reprocessedTailTokens: 2050
  });
  const exactPingUsd = (split.uncachedTokens + (1 - carbonProfile.cacheDiscountRate) * split.cachedReadTokens) * (carbonProfile.inputPer1M / 1e6);
  assert.equal(Number(exactPingUsd.toFixed(6)), 0.031854);

  // Non-Gemini-4 model (tail = 0) does not reprocess tail tokens
  const claudeProfile = resolveModelProfile("claude-sonnet-4-6");
  assert.deepEqual(computeKeepalivePingTokenSplit(120000, { pingOverheadTokens: 16, profile: claudeProfile }), {
    cachedReadTokens: 120000,
    uncachedTokens: 16,
    reprocessedTailTokens: 0
  });

  // 3. End-to-end simulateCachePolicies endpoint verification on synthetic Carbon 120K sessions
  const t0 = Date.parse("2026-11-27T10:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();
  const singleTurnCarbon = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "Gemini 4 Carbon (High)",
      input_tokens: 120000,
      cache_read_tokens: 0
    }
  ];

  // Tail 1s & 254s: 0 pings for BOTH 1x and unlimited
  for (const tailSec of [1, 254]) {
    const rep = simulateCachePolicies([singleTurnCarbon], { keepaliveTailSec: tailSec });
    for (const id of ["keepalive-1x", "keepalive-unlimited"]) {
      const p = rep.policies.find((x) => x.id === id);
      assert.equal(p.tailPings, 0, `${id} must fire 0 tail pings at ${tailSec}s (< 255s)`);
      assert.equal(p.deltaUsdVsObserved, 0);
    }
  }

  // Tail 255s & 256s: 1 ping for BOTH 1x and unlimited, priced with 2,050-token tail reprocess ($0.0319 rounded from $0.031854)
  for (const tailSec of [255, 256]) {
    const rep = simulateCachePolicies([singleTurnCarbon], { keepaliveTailSec: tailSec });
    for (const id of ["keepalive-1x", "keepalive-unlimited"]) {
      const p = rep.policies.find((x) => x.id === id);
      assert.equal(p.tailPings, 1, `${id} must fire 1 tail ping at ${tailSec}s`);
      assert.equal(p.wastedPings, 1);
      assert.equal(p.deltaUsdVsObserved, 0.0319, `${id} single Carbon 120K ping must reflect $0.031854 -> $0.0319`);
    }
  }

  // Inter-turn 270s warm gap (< 300s TTL, >= 255s pingIntervalSec): BOTH policies fire 1 preemptive (wasted) ping
  const gap270Session = [
    ...singleTurnCarbon,
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(270),
      model: "Gemini 4 Carbon (High)",
      input_tokens: 3000,
      cache_read_tokens: 120000
    }
  ];
  const rep270 = simulateCachePolicies([gap270Session], { keepaliveTailSec: 0 });
  for (const id of ["keepalive-1x", "keepalive-unlimited"]) {
    const p = rep270.policies.find((x) => x.id === id);
    assert.equal(p.interTurnPings, 1, `${id} must count the preemptive ping fired at 255s during a 270s gap`);
    assert.equal(p.wastedPings, 1, `${id} preemptive ping before TTL expiry must count as wasted`);
    assert.equal(p.avoidedIdleBusts, 0);
    assert.equal(p.deltaUsdVsObserved, 0.0319);
  }

  // Inter-turn 300s cold bust gap (>= 300s TTL): BOTH policies bridge with 1 ping & avoid 1 idle bust
  const gap300Session = [
    ...singleTurnCarbon,
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(300),
      model: "Gemini 4 Carbon (High)",
      input_tokens: 123000,
      cache_read_tokens: 0
    }
  ];
  const rep300 = simulateCachePolicies([gap300Session], { keepaliveTailSec: 0 });
  const obs300 = rep300.policies.find((x) => x.id === "observed");
  for (const id of ["keepalive-1x", "keepalive-unlimited"]) {
    const p = rep300.policies.find((x) => x.id === id);
    assert.equal(p.interTurnPings, 1);
    assert.equal(p.wastedPings, 0);
    assert.equal(p.avoidedIdleBusts, 1);
    assert.ok(p.projectedInputCostUsd < obs300.projectedInputCostUsd);
  }
});

// ============================================================================
// M18: Declarative scripts/package-manifest.json, strict legacy parser & zero-devtools fallback
// ============================================================================
test("Wave2-M18: Declarative package-manifest.json is single source of truth; fallback leaks 0 devtools; malformed manifests/expressions fail closed", async (t) => {
  const manifestPath = path.join(ROOT, "scripts", "package-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(PACKAGE_MANIFEST_SCHEMA_VERSION, 1);
  assert.ok(manifest.runtimeFiles.includes("scripts/package-manifest.json"));
  assert.deepEqual([...RUNTIME_FILES], manifest.runtimeFiles);
  assert.deepEqual([...DEVTOOLS_FILES], manifest.devtoolsFiles);
  assert.deepEqual([...FAST_MCP_TOOL_NAMES], manifest.fastMcpTools);
  assert.deepEqual([...CONTEXT_MCP_TOOL_NAMES], manifest.contextMcpTools);

  const pkgReport = verifyPackageManifest(ROOT);
  assert.equal(pkgReport.ok, true, JSON.stringify(pkgReport, null, 2));
  assert.equal(pkgReport.manifestSchemaVersion, 1);
  assert.deepEqual(pkgReport.manifestErrors, []);

  // Direct test of selectFallbackRuntimeFiles on full 65 runtime + 7 devtools archive: ZERO devtools leaked
  const fullArchive = new Map();
  for (const rel of [...RUNTIME_FILES, ...DEVTOOLS_FILES]) {
    fullArchive.set(rel, fs.readFileSync(path.join(ROOT, rel)));
  }
  const fallbackSelected = selectFallbackRuntimeFiles(fullArchive);
  const leakedDevtools = fallbackSelected.filter((rel) => DEVTOOLS_FILES.includes(rel));
  assert.deepEqual(leakedDevtools, [], `selectFallbackRuntimeFiles must exclude all DEVTOOLS_FILES, leaked: ${leakedDevtools.join(", ")}`);
  assert.deepEqual([...fallbackSelected].sort(), [...RUNTIME_FILES].sort());

  // readPackageManifestFromArchive diagnostic rejections
  assert.throws(
    () =>
      readPackageManifestFromArchive(
        new Map([["scripts/package-manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 99, runtimeFiles: ["plugin.json"] }))]])
      ),
    (err) => err instanceof UpdateError && err.reason === "incomplete" && err.diagnostics?.code === "MANIFEST_SCHEMA_UNSUPPORTED"
  );
  assert.throws(
    () => readPackageManifestFromArchive(new Map([["scripts/package-manifest.json", Buffer.from("{bad json")]])),
    (err) => err instanceof UpdateError && err.reason === "incomplete" && err.diagnostics?.code === "MANIFEST_INVALID_JSON"
  );
  assert.throws(
    () =>
      readPackageManifestFromArchive(
        new Map([
          ["scripts/package-manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 1, runtimeFiles: ["../escape.js"] }))],
          ["../escape.js", Buffer.from("x")]
        ])
      ),
    (err) => err instanceof UpdateError && err.reason === "incomplete" && err.diagnostics?.code === "MANIFEST_INVALID_PATH"
  );

  // Strict legacy frozen-array extractor rejects mixed expressions instead of returning partial lists
  const validLegacy = extractFrozenStringListStrict(
    `export const RUNTIME_FILES = Object.freeze([\n  // "ignored.js"\n  "plugin.json",\n  'package.json',\n]);`,
    "RUNTIME_FILES"
  );
  assert.deepEqual(validLegacy, { status: "ok", values: ["plugin.json", "package.json"] });

  for (const mixedSrc of [
    `export const RUNTIME_FILES = Object.freeze(["plugin.json", ...EXTRA_FILES]);`,
    `export const RUNTIME_FILES = Object.freeze(["plugin.json", buildPath("a")]);`,
    `export const RUNTIME_FILES = Object.freeze(["plugin.json", \`template.js\`]);`
  ]) {
    assert.equal(extractFrozenStringListStrict(mixedSrc, "RUNTIME_FILES").status, "invalid");
  }

  // End-to-end createPluginUpdater: mixed expression in legacy archive & unsupported schemaVersion both abort cleanly
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-m18-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const pluginsDir = path.join(tmpDir, "plugins");
  const installedRoot = path.join(pluginsDir, "agy-dart");
  const sidecarDir = setupMockPluginInstall(installedRoot, "1.9.3");

  const makeUpdater = (tgz) =>
    createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "1.9.3",
        latestVersion: "1.9.9",
        releaseTag: "v1.9.9",
        releaseUrl: `${RELEASES_URL}/tag/v1.9.9`
      }),
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz) }
    });

  const unsupportedSchemaTgz = buildTarGz(
    makeMinimalArchiveEntries("1.9.9", {
      manifestContent: JSON.stringify({ schemaVersion: 2, runtimeFiles: ["plugin.json"] })
    })
  );
  const badSchemaRes = await makeUpdater(unsupportedSchemaTgz)("1.9.9");
  assert.equal(badSchemaRes.status, "error");
  assert.equal(badSchemaRes.reason, "incomplete");

  const mixedLegacyTgz = buildTarGz(
    makeMinimalArchiveEntries("1.9.9", {
      installScriptContent: `export const RUNTIME_FILES = Object.freeze(["plugin.json", ...EXTRA]);\n`
    })
  );
  const mixedLegacyRes = await makeUpdater(mixedLegacyTgz)("1.9.9");
  assert.equal(mixedLegacyRes.status, "error");
  assert.equal(mixedLegacyRes.reason, "incomplete");
});

// ============================================================================
// L01: Review brief full source coverage, auto-synced version/baseline & SECURITY.md matrix
// ============================================================================
test("Wave2-L01: AI_REVIEW_BRIEF.md covers all workspace source files, syncs intro/baseline to package version, and SECURITY.md covers 1.9.x/1.8.x", (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  assert.equal(pkg.version, pluginJson.version);

  const metrics = computeBriefMetrics(ROOT);
  assert.deepEqual(metrics.untrackedSourceFiles, []);
  assert.ok(metrics.totalTrackedFiles >= 55, `Expected >= 55 tracked source files, got ${metrics.totalTrackedFiles}`);

  const brief = fs.readFileSync(path.join(ROOT, "AI_REVIEW_BRIEF.md"), "utf8");
  assert.ok(brief.includes(`\`v${pkg.version}\``), "AI_REVIEW_BRIEF.md must reference current package version");
  assert.equal(brief.includes("正式发布标签 `v1.6.0`"), false, "Stale v1.6.0 intro tag must be removed");
  assert.equal(brief.includes("184/184 PASS"), false, "Stale 184/184 baseline must be replaced by AUTO block");
  assert.ok(brief.includes(`${metrics.testCases}/${metrics.testCases} PASS`), "§7 baseline must reflect live testCases");
  assert.equal(syncBriefFile(ROOT, { write: false }).inSync, true, "AI_REVIEW_BRIEF.md must pass drift check");

  const securityMd = fs.readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
  assert.match(securityMd, /\|\s*`1\.9\.x`\s*\|\s*Yes\s*\|/);
  assert.match(securityMd, /\|\s*`1\.8\.x`\s*\|\s*Yes\s*\|/);
  assert.match(securityMd, /\|\s*`< 1\.8\.0`\s*\|\s*Upgrade recommended\s*\|/);

  // Negative check: adding an untracked JS source file causes syncBriefFile to report inSync: false
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-l01-"));
  t.after(() => fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmpRepo, "package.json"));
  fs.copyFileSync(path.join(ROOT, "AI_REVIEW_BRIEF.md"), path.join(tmpRepo, "AI_REVIEW_BRIEF.md"));
  syncBriefFile(tmpRepo, { write: true });
  assert.equal(syncBriefFile(tmpRepo, { write: false }).inSync, true);
  fs.writeFileSync(path.join(tmpRepo, "orphan-untracked.mjs"), "export const x = 1;\n", "utf8");
  const drifted = syncBriefFile(tmpRepo, { write: false });
  assert.equal(drifted.inSync, false);
  assert.deepEqual(drifted.metrics.untrackedSourceFiles, ["orphan-untracked.mjs"]);
});

// ============================================================================
// L02 & L03: Dashboard i18n aria-label localization & cutoff override transparency
// ============================================================================
function createDashboardVm(htmlSource) {
  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainUiScript = scriptBlocks[scriptBlocks.length - 1][1];

  const elements = new Map();
  const makeEl = (id, attrs = {}) => {
    const attrMap = new Map(Object.entries(attrs));
    return {
      id,
      value: id === "cutoff-select" ? "46080" : "",
      innerText: "",
      textContent: "",
      innerHTML: "",
      className: "",
      title: "",
      href: "",
      placeholder: "",
      hidden: false,
      disabled: false,
      style: {},
      dataset: {},
      options:
        id === "cutoff-select"
          ? [
              { value: "16384", textContent: "16 KB", dataset: {} },
              { value: "32768", textContent: "32 KB", dataset: {} },
              { value: "46080", textContent: "45 KB (host cap)", dataset: {} },
              { value: "65536", textContent: "64 KB", dataset: {} },
              { value: "0", textContent: "none", dataset: {} }
            ]
          : [],
      classList: {
        _s: new Set(id === "cutoff-override-badge" ? ["meta-tag", "is-warn", "hidden"] : []),
        add(c) {
          this._s.add(c);
        },
        remove(c) {
          this._s.delete(c);
        },
        contains(c) {
          return this._s.has(c);
        }
      },
      getAttribute(name) {
        if (name === "content" && id === "meta-csrf") return "vm-csrf";
        return attrMap.has(name) ? attrMap.get(name) : null;
      },
      setAttribute(name, val) {
        attrMap.set(name, String(val));
      },
      querySelector() {
        return null;
      },
      appendChild(child) {
        if (Array.isArray(this.options) && !this.options.includes(child)) this.options.push(child);
      },
      removeChild(child) {
        if (Array.isArray(this.options)) {
          const idx = this.options.indexOf(child);
          if (idx >= 0) this.options.splice(idx, 1);
        }
      }
    };
  };

  // Parse actual [data-i18n-aria-label] elements from index.html so test validates real markup
  const ariaNodes = [];
  for (const m of htmlSource.matchAll(/<([a-z0-9-]+)\b([^>]*\bdata-i18n-aria-label="([^"]+)"[^>]*)>/gi)) {
    const attrsStr = m[2];
    const key = m[3];
    const idMatch = attrsStr.match(/\bid="([^"]+)"/i);
    const initialAria = attrsStr.match(/\baria-label="([^"]*)"/i)?.[1] || "";
    const nodeId = idMatch ? idMatch[1] : `anon-${ariaNodes.length}`;
    const el = makeEl(nodeId, { "data-i18n-aria-label": key, "aria-label": initialAria });
    elements.set(nodeId, el);
    ariaNodes.push(el);
  }

  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  let fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({}) });

  const sandbox = {
    window: { location: { search: "", reload() {} }, addEventListener() {}, sidecar: null },
    document: {
      title: "",
      hidden: false,
      documentElement: { lang: "en" },
      getElementById: getEl,
      querySelector: (sel) => (sel.includes("csrf") ? getEl("meta-csrf") : null),
      querySelectorAll: (sel) => (sel === "[data-i18n-aria-label]" ? ariaNodes : []),
      createElement: (tag) => makeEl(`${tag}-dyn`),
      addEventListener: () => {}
    },
    navigator: { language: "en-US" },
    localStorage: { getItem: () => "en", setItem: () => {} },
    URLSearchParams,
    Headers,
    Intl,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
    console,
    fetch: (url, opts) => fetchHandler(url, opts)
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${mainUiScript}\n;globalThis.__w2Inspect = { I18N, applyStaticTranslations, updateCutoffDropdown, changeCutoff, setLang: (l) => { currentLang = l; applyStaticTranslations(); }, setScope: (sc) => { currentScope = sc; }, setCachedStats: (s) => { cachedStats = s; } };`,
    sandbox,
    { filename: "sidecars/dashboard/index.html" }
  );
  return {
    sandbox,
    getEl,
    ariaNodes,
    setFetchHandler: (fn) => {
      fetchHandler = fn;
    }
  };
}

test("Wave2-L02: Dashboard EN/ZH dictionaries maintain exact key parity and localize region aria-labels when switched to Chinese", () => {
  const htmlSource = readDashboardHtml();
  const { sandbox, getEl, ariaNodes } = createDashboardVm(htmlSource);
  const { I18N, setLang } = sandbox.__w2Inspect;

  const enKeys = Object.keys(I18N.en).sort();
  const zhKeys = Object.keys(I18N.zh).sort();
  assert.deepEqual(enKeys, zhKeys, "I18N.en and I18N.zh must have identical key sets");

  assert.ok(ariaNodes.length >= 3, "Expected star banner, safety audit card, and nav strip to carry data-i18n-aria-label");
  const starEl = getEl("star-milestone-banner");
  const safetyEl = getEl("safety-audit-card");

  setLang("zh");
  assert.equal(sandbox.document.documentElement.lang, "zh-CN");
  assert.match(starEl.getAttribute("aria-label"), /[\u4e00-\u9fff]/, "Star banner aria-label must be Chinese in zh UI");
  assert.match(safetyEl.getAttribute("aria-label"), /[\u4e00-\u9fff]/, "Safety card aria-label must be Chinese in zh UI");
  for (const node of ariaNodes) {
    assert.match(
      node.getAttribute("aria-label"),
      /[\u4e00-\u9fff]/,
      `Every [data-i18n-aria-label] region (${node.id}) must localize to Chinese`
    );
  }

  setLang("en");
  assert.equal(starEl.getAttribute("aria-label"), "GitHub Star Milestone");
  assert.equal(safetyEl.getAttribute("aria-label"), "Safety Monitor Audit");
});

test("Wave2-L03: Global cutoff mutation reports config/env override provenance while app/conversation overrides win and UI badge explains override", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-l03-"));
  const dbPath = path.join(tmpDir, "ctx.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ maxReadBytes: 32768 }, null, 2), "utf8");

  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const prevMaxRead = process.env.AGY_DART_MAX_READ_BYTES;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  delete process.env.AGY_DART_MAX_READ_BYTES;
  closeRuntimeStore();
  resetConfigCache();

  t.after(() => {
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    if (prevMaxRead === undefined) delete process.env.AGY_DART_MAX_READ_BYTES;
    else process.env.AGY_DART_MAX_READ_BYTES = prevMaxRead;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // 1. Global write while config.json pins maxReadBytes=32768
  const globalMut = handleCutoffMutation({ cutoff: 131072, scope: "lifetime", conversationId: "conv-l03" });
  assert.equal(globalMut.ok, true);
  assert.equal(globalMut.cutoffBytes, 131072);
  assert.equal(globalMut.savedCutoffBytes, 131072);
  assert.equal(globalMut.effectiveCutoffBytes, 32768);
  assert.equal(globalMut.effectiveSource, "config");
  assert.equal(globalMut.overriddenBy, "config");
  assert.equal(globalMut.globalCutoffBytes, 32768);
  assert.equal(globalMut.savedGlobalCutoffBytes, 131072);

  // 2. App scope override takes precedence over config.json (overriddenBy === null)
  const appMut = handleCutoffMutation({ cutoff: 65536, scope: "app", conversationId: "conv-l03" });
  assert.equal(appMut.ok, true);
  assert.equal(appMut.savedCutoffBytes, 65536);
  assert.equal(appMut.effectiveCutoffBytes, 65536);
  assert.equal(appMut.effectiveSource, "sqlite:session");
  assert.equal(appMut.overriddenBy, null);
  assert.equal(appMut.appCutoffBytes, 65536);

  // 3. Env override reports overriddenBy === "env" on global scope
  process.env.AGY_DART_MAX_READ_BYTES = "16384";
  resetConfigCache();
  const envMut = handleCutoffMutation({ cutoff: 131072, scope: "lifetime", conversationId: "conv-l03" });
  assert.equal(envMut.effectiveCutoffBytes, 16384);
  assert.equal(envMut.effectiveSource, "env");
  assert.equal(envMut.overriddenBy, "env");

  // 4. Sidecar /api/stats exposes cutoffSource & cutoffOverriddenBy
  const routes = new Map();
  registerSidecarRoutes({
    config: { conversationId: "conv-l03" },
    api(route, handler) {
      routes.set(route, handler);
    }
  });
  const lifetimeStats = await routes.get("/api/stats")({ scope: "lifetime", conversationId: "conv-l03" });
  assert.equal(lifetimeStats.globalCutoffBytes, 16384);
  assert.equal(lifetimeStats.globalCutoffSource, "env");
  assert.equal(lifetimeStats.cutoffOverriddenBy, "env");
  assert.equal(lifetimeStats.savedGlobalCutoffBytes, 131072);

  // 5. Dashboard UI reflects override badge on lifetime scope & hides it when overridden in app scope
  const htmlSource = readDashboardHtml();
  const { sandbox, getEl, setFetchHandler } = createDashboardVm(htmlSource);
  const ui = sandbox.__w2Inspect;

  setFetchHandler(async (url) => {
    if (url === "/api/cutoff") {
      return { ok: true, status: 200, json: async () => globalMut };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        scope: "lifetime",
        cutoffBytes: 32768,
        globalCutoffBytes: 32768,
        globalCutoffSource: "config",
        savedGlobalCutoffBytes: 131072,
        cutoffSource: "config",
        cutoffOverriddenBy: "config",
        appCutoffBytes: 65536,
        appCutoffSource: "sqlite:session",
        conversationCutoffBytes: 65536,
        conversationCutoffSource: "sqlite:app"
      })
    };
  });

  ui.setScope("lifetime");
  ui.setCachedStats({
    cutoffBytes: 32768,
    globalCutoffBytes: 32768,
    globalCutoffSource: "config",
    savedGlobalCutoffBytes: 131072,
    cutoffSource: "config",
    cutoffOverriddenBy: "config",
    appCutoffBytes: 65536,
    appCutoffSource: "sqlite:session",
    conversationCutoffBytes: 65536,
    conversationCutoffSource: "sqlite:app"
  });
  await ui.changeCutoff("131072");

  const selectEl = getEl("cutoff-select");
  const badgeEl = getEl("cutoff-override-badge");
  assert.equal(selectEl.value, "32768", "Dropdown must settle on effective config-overridden cutoff");
  assert.equal(badgeEl.classList.contains("hidden"), false, "Override badge must be visible when overridden by config.json");
  assert.ok(badgeEl.textContent.includes("config.json"), `Expected config.json label, got: ${badgeEl.textContent}`);
  assert.match(badgeEl.title, /128(?:\.0)?\s*KB/, `Expected saved value in tooltip, got: ${badgeEl.title}`);

  // Switching to app scope (where sqlite:session wins) hides the override badge
  ui.setScope("app");
  ui.updateCutoffDropdown({
    cutoffBytes: 65536,
    globalCutoffBytes: 32768,
    globalCutoffSource: "config",
    appCutoffBytes: 65536,
    appCutoffSource: "sqlite:session",
    conversationCutoffBytes: 65536,
    conversationCutoffSource: "sqlite:app",
    cutoffOverriddenBy: null
  });
  assert.equal(selectEl.value, "65536");
  assert.equal(badgeEl.classList.contains("hidden"), true, "Override badge must hide when app scope override is active");
});
