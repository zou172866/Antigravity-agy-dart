import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  auditSafetyMonitor,
  discoverSafetyLogSources,
  formatSafetyAuditCompactForDoctor,
  formatSafetyAuditMarkdown,
  parseDurationMs,
  parseGlogTimestampMs,
  parseSafetyLogLines,
  resetSafetyAuditCache,
  sanitizeSafetyText,
  splitInterleavedGlogLine
} from "../context/lib/safety-monitor-audit.js";
import { getConfigSnapshot, resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import { buildHandoffBrief } from "../context/lib/handoff.js";
import {
  closeRuntimeStore,
  createStandaloneServer,
  registerSidecarRoutes,
  resetSidecarSafetyAuditCache
} from "../sidecars/dashboard/server.mjs";
import { auditEnvironmentCache, auditSafetyMonitorOnly } from "../scripts/cache-audit.mjs";
import { fetchDashboardHtml, readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests", "fixtures", "safety-monitor-issue-1886.json"), "utf8")
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function formatGlogTs(ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const us = String(d.getMilliseconds() * 1000).padStart(6, "0");
  return `${mm}${dd} ${hh}:${mi}:${ss}.${us}`;
}

test("1. Golden Desktop fixtures: 3-stage funnel, shared-tid stream attribution, 300K false alarms & 429 false-positive defense", () => {
  const tmpDir = makeTempDir("agy-safety-golden-");
  try {
    resetSafetyAuditCache();
    const logPath = path.join(tmpDir, "language_server.log");
    const lines = [
      ...FIXTURES.desktop_sonar_and_main_stream,
      ...FIXTURES.desktop_allowed_tool_skip_chain,
      ...FIXTURES.desktop_normal_sir_flash_lite_pass,
      ...FIXTURES.desktop_zero_429_escalation_shell,
      ...FIXTURES.desktop_zero_429_escalation_300k_mcp,
      ...FIXTURES.desktop_noise_and_429_false_positives
    ];
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    // Align mtime & nowMs with the golden fixture timestamps (local 2026-11-27 01:25:00)
    const nowMs = new Date(2026, 10, 27, 1, 25, 0, 0).getTime();
    fs.utimesSync(logPath, nowMs / 1000, nowMs / 1000);

    const report = auditSafetyMonitor({
      logPaths: [logPath],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });

    assert.equal(report.status, "ok");
    assert.equal(report.severity, "ok");
    assert.equal(report.window.stage1Total, 4);
    assert.equal(report.window.stage1Allowed, 1);
    assert.equal(report.window.stage1Triggered, 3);
    assert.equal(report.window.precheckCount, 3);
    assert.equal(report.window.precheckTriggeredTrue, 2);
    assert.equal(report.window.precheckTriggeredFalse, 1);
    assert.equal(report.window.heavyReviewCount, 2);
    assert.equal(report.window.heavyTriggeredFalse, 2);
    assert.equal(report.window.heavyFalseAlarmRatePct, 100);
    assert.equal(report.window.heavyMaxChars, 299876);
    assert.equal(report.window.heavyTotalChars, 53796 + 299876);
    assert.equal(report.window.rateLimit429Count, 0, "Must ignore .429 timestamps, :2429 ports, hex UUIDs, csrf_interceptor, and runner.go prose");
    assert.equal(report.window.fallbackEscalationCount, 0);

    // Exact tid-correlated streamGenerateContent attribution:
    // 1 main + 3 sir_flash_lite + 2 severe_internal_risks_agy = 6 total (5 hidden = 83.3%)
    assert.equal(report.streamRequests.total, 6);
    assert.equal(report.streamRequests.mainOrOther, 1);
    assert.equal(report.streamRequests.hiddenPrecheck, 3);
    assert.equal(report.streamRequests.hiddenHeavy, 2);
    assert.equal(report.streamRequests.hiddenTotal, 5);
    assert.equal(report.streamRequests.hiddenSharePct, 83.3);

    assert.deepEqual(report.sonarTags, ["jetski_mode_turbo", "policy_guardian", "sonar_skip_tags"]);
    assert.ok(report.window.totalLatencySec > 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("2. Windows CLI interleaved lines, cli.log deduplication, trigger-reason catalog & Dec 31 -> Jan 1 year rollover", () => {
  // 2a. Interleaved splitter preserves Desktop google.Init lines and splits glued CLI lines
  const normalDesktop = FIXTURES.desktop_allowed_tool_skip_chain[0];
  assert.deepEqual(splitInterleavedGlogLine(normalDesktop), [normalDesktop]);

  const interleaved = FIXTURES.cli_normal_and_interleaved[10];
  const splitParts = splitInterleavedGlogLine(interleaved);
  assert.equal(splitParts.length, 2);
  assert.ok(splitParts[1].includes("streamGenerateContent"));

  // 2b. Duration parser
  assert.ok(Math.abs(parseDurationMs("19µs") - 0.019) < 0.001);
  assert.ok(Math.abs(parseDurationMs("51.4us") - 0.0514) < 0.001);
  assert.ok(Math.abs(parseDurationMs("5.56s") - 5560) < 0.1);

  // 2c. Glog year rollover: log line from Dec 31 23:55 scanned on Jan 1 00:10 -> previous year!
  const jan1Ms = new Date(2027, 0, 1, 0, 10, 0, 0).getTime();
  const dec31Parsed = parseGlogTimestampMs("1231", "23:55:00.123456", jan1Ms);
  assert.equal(new Date(dec31Parsed).getFullYear(), 2026);
  assert.equal(new Date(dec31Parsed).getMonth(), 11);
  assert.equal(new Date(dec31Parsed).getDate(), 31);

  // 2d. CLI fixture parsing recovers interleaved streamGenerateContent calls
  const cliRefMs = new Date(2026, 10, 23, 4, 35, 0, 0).getTime();
  const parsedCli = parseSafetyLogLines(FIXTURES.cli_normal_and_interleaved, {
    fileMtimeMs: cliRefMs,
    nowMs: cliRefMs
  });
  let totalMain = 0;
  let totalPre = 0;
  for (const b of Object.values(parsedCli.buckets)) {
    totalMain += b.streamMain;
    totalPre += b.streamPrecheck;
  }
  assert.equal(totalMain, 3, "Must recover 1 clean + 2 interleaved main streamGenerateContent lines");
  assert.equal(totalPre, 1);

  // 2e. Trigger reasons catalog (all 11 real reasons + categories)
  const tmpDir = makeTempDir("agy-safety-reasons-");
  try {
    const reasonsLog = path.join(tmpDir, "language_server.log");
    fs.writeFileSync(reasonsLog, FIXTURES.desktop_trigger_reasons_catalog.join("\n") + "\n", "utf8");
    const nowMs = new Date(2026, 10, 27, 1, 25, 0, 0).getTime();
    fs.utimesSync(reasonsLog, nowMs / 1000, nowMs / 1000);
    const report = auditSafetyMonitor({
      logPaths: [reasonsLog],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(report.window.stage1Triggered, 11);
    const byReason = new Map(report.triggerReasons.map((r) => [r.reason, r]));
    assert.equal(byReason.get("unquoted_shell_operators")?.category, "shell");
    assert.equal(byReason.get("unknown_command")?.category, "shell");
    assert.equal(byReason.get("unsupported_tool: mcp_agy-dart_fast_batch_search")?.category, "agy_dart_mcp");
    assert.equal(byReason.get("unsupported_tool: call_mcp_tool")?.category, "mcp");
    assert.equal(byReason.get("unsupported_tool: edit_file")?.category, "native_tool");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("3. Classifications: 429_avalanche, zero-429 heavy_burst_or_sticky, approaching_quota (5h window cutoff), not_detected & no_safety_events", () => {
  const tmpDir = makeTempDir("agy-safety-classify-");
  try {
    resetSafetyAuditCache();
    const nowMs = new Date(2026, 10, 27, 12, 0, 0, 0).getTime();

    // 3a. not_detected
    const noneRep = auditSafetyMonitor({
      logPaths: [path.join(tmpDir, "does-not-exist.log")],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(noneRep.status, "not_detected");
    assert.equal(noneRep.severity, "none");

    // 3b. no_safety_events
    const noiseOnly = path.join(tmpDir, "noise.log");
    fs.writeFileSync(noiseOnly, FIXTURES.desktop_noise_and_429_false_positives.slice(0, 3).join("\n") + "\n", "utf8");
    const idleRep = auditSafetyMonitor({
      logPaths: [noiseOnly],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(idleRep.status, "no_safety_events");
    assert.equal(idleRep.severity, "none");

    // 3c. 429_avalanche
    const ts1 = formatGlogTs(nowMs - 60_000);
    const avalanchePath = path.join(tmpDir, "avalanche.log");
    fs.writeFileSync(
      avalanchePath,
      [
        `ERROR: logging before google.Init: I${ts1}   1001 llm_monitor.go:712] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)`,
        `ERROR: logging before google.Init: E${ts1}   1001 llm_monitor.go:720] LLM Monitor sir_flash_lite: HTTP 429 RESOURCE_EXHAUSTED`,
        `ERROR: logging before google.Init: W${ts1}   1001 runner.go:612] parent sir_flash_lite failed, running it anyway`,
        `ERROR: logging before google.Init: I${ts1}   1002 llm_monitor.go:349] LLM Monitor severe_internal_risks_agy: Starting evaluation`,
        `ERROR: logging before google.Init: I${ts1}   1002 llm_monitor.go:636] LLM Monitor severe_internal_risks_agy: Trajectory formatted, length: 295400`,
        `ERROR: logging before google.Init: I${ts1}   1002 llm_monitor.go:712] LLM Monitor severe_internal_risks_agy: Calling LLM (model: gemini-4-hydrogen-sonar)`,
        `ERROR: logging before google.Init: I${ts1}   1002 llm_monitor.go:785] LLM Monitor severe_internal_risks_agy: Evaluation complete. Triggered: false, Severity: 0, Confidence: 0`
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(avalanchePath, nowMs / 1000, nowMs / 1000);
    const avRep = auditSafetyMonitor({
      logPaths: [avalanchePath],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(avRep.status, "429_avalanche");
    assert.equal(avRep.severity, "critical");
    assert.equal(avRep.window.rateLimit429Count, 1);
    assert.equal(avRep.window.fallbackEscalationCount, 1);
    assert.equal(avRep.window.heavyReviewCount, 1);
    assert.equal(avRep.window.heavyAvgChars, 295400);

    // 3d. Zero-429 heavy_burst_or_sticky (3 heavy reviews within 5 min, avg ~280K, 0 429s)
    const burstPath = path.join(tmpDir, "burst.log");
    const burstLines = [];
    for (let i = 0; i < 3; i++) {
      const t = formatGlogTs(nowMs - (3 - i) * 30_000);
      const tid = 2000 + i;
      burstLines.push(
        `ERROR: logging before google.Init: I${t}   ${tid} llm_monitor.go:349] LLM Monitor severe_internal_risks_agy: Starting evaluation`,
        `ERROR: logging before google.Init: I${t}   ${tid} llm_monitor.go:636] LLM Monitor severe_internal_risks_agy: Trajectory formatted, length: ${280000 + i * 5000}`,
        `ERROR: logging before google.Init: I${t}   ${tid} llm_monitor.go:712] LLM Monitor severe_internal_risks_agy: Calling LLM (model: gemini-4-hydrogen-sonar)`,
        `ERROR: logging before google.Init: I${t}   ${tid} llm_monitor.go:785] LLM Monitor severe_internal_risks_agy: Evaluation complete. Triggered: false, Severity: 0, Confidence: 0`,
        `ERROR: logging before google.Init: I${t}   ${tid} llm_monitor.go:785] LLM Monitor sir_flash_lite: Evaluation complete. Triggered: true, Severity: 5, Confidence: 9`
      );
    }
    fs.writeFileSync(burstPath, burstLines.join("\n") + "\n", "utf8");
    fs.utimesSync(burstPath, nowMs / 1000, nowMs / 1000);
    const burstRep = auditSafetyMonitor({
      logPaths: [burstPath],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(burstRep.status, "heavy_burst_or_sticky");
    assert.equal(burstRep.severity, "warn");
    assert.equal(burstRep.window.rateLimit429Count, 0);
    assert.equal(burstRep.window.recentHeavyBurst5m, 3);
    assert.equal(burstRep.window.consecutiveLargeFalseAlarms, 3);

    // 3e. approaching_quota (and excludes events older than 5h window)
    const quotaPath = path.join(tmpDir, "quota.log");
    const qLines = [];
    const oldTs = formatGlogTs(nowMs - 7 * 3600 * 1000); // outside 5h window
    for (let i = 0; i < 120; i++) {
      qLines.push(`I${oldTs}   3000 llm_monitor.go:706] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)`);
    }
    const recentTs = formatGlogTs(nowMs - 10 * 60 * 1000); // inside 5h window
    for (let i = 0; i < 120; i++) {
      qLines.push(`I${recentTs}   3001 llm_monitor.go:706] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)`);
    }
    fs.writeFileSync(quotaPath, qLines.join("\n") + "\n", "utf8");
    fs.utimesSync(quotaPath, nowMs / 1000, nowMs / 1000);
    const qRep = auditSafetyMonitor({
      logPaths: [quotaPath],
      disableDefaultDiscovery: true,
      persistState: false,
      precheckWarnCount: 100,
      precheckLimit: 200,
      nowMs
    });
    assert.equal(qRep.status, "approaching_quota");
    assert.equal(qRep.severity, "warn");
    assert.equal(qRep.window.precheckCount, 120, "Must exclude prechecks older than 5h rolling window");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("4. Restart-truncation persistence, cross-platform discovery, cli.log dedup, redaction & 10MB noise performance", () => {
  const tmpDir = makeTempDir("agy-safety-persist-");
  try {
    resetSafetyAuditCache();
    const nowMs = new Date(2026, 10, 27, 14, 0, 0, 0).getTime();
    const statePath = path.join(tmpDir, "safety-audit-state.json");
    const lsLog = path.join(tmpDir, "language_server.log");

    // 4a. First scan before restart (2 prechecks)
    const t1 = formatGlogTs(nowMs - 20 * 60 * 1000);
    const body1 = [
      `ERROR: logging before google.Init: I${t1}   101 llm_monitor.go:712] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)`,
      `ERROR: logging before google.Init: I${t1}   102 llm_monitor.go:712] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)`,
      "x".repeat(500)
    ].join("\n") + "\n";
    fs.writeFileSync(lsLog, body1, "utf8");
    fs.utimesSync(lsLog, nowMs / 1000, nowMs / 1000);

    const r1 = auditSafetyMonitor({ logPaths: [lsLog], disableDefaultDiscovery: true, statePath, nowMs });
    assert.equal(r1.window.precheckCount, 2);
    assert.equal(r1.sources.restartTruncationsDetected, 0);

    // Unchanged re-scan hits incremental cache (0 bytes scanned)
    const r1Cached = auditSafetyMonitor({ logPaths: [lsLog], disableDefaultDiscovery: true, statePath, nowMs });
    assert.equal(r1Cached.sources.bytesScanned, 0);
    assert.equal(r1Cached.sources.cacheHits, 1);
    assert.equal(r1Cached.window.precheckCount, 2);

    // Simulate Antigravity Desktop restart truncating language_server.log to a smaller file with 1 new precheck
    const t2 = formatGlogTs(nowMs - 2 * 60 * 1000);
    const body2 = `ERROR: logging before google.Init: I${t2}   201 llm_monitor.go:712] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)\n`;
    fs.writeFileSync(lsLog, body2, "utf8");
    fs.utimesSync(lsLog, (nowMs + 1000) / 1000, (nowMs + 1000) / 1000);

    const r2 = auditSafetyMonitor({ logPaths: [lsLog], disableDefaultDiscovery: true, statePath, nowMs: nowMs + 1000 });
    assert.equal(r2.window.precheckCount, 3, "Must preserve prior 2 prechecks across restart truncation and add 1 new");
    assert.equal(r2.sources.restartTruncationsDetected, 1);

    // 4b. Cross-platform discovery (Windows custom APPDATA + CLI cli.log dedup, macOS, Linux)
    const fakeHome = path.join(tmpDir, "home");
    const customAppData = path.join(tmpDir, "custom-roaming");
    fs.mkdirSync(path.join(customAppData, "Antigravity", "logs"), { recursive: true });
    fs.writeFileSync(path.join(customAppData, "Antigravity", "logs", "language_server.log"), body2, "utf8");
    fs.writeFileSync(
      path.join(customAppData, "Antigravity", "logs", "main.log"),
      "[2026-11-27 13:55:00.123] [info] Starting app (v2.35.2)\n",
      "utf8"
    );
    fs.mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli", "log"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".gemini", "antigravity-cli", "log", "cli-20261127_135000.log"), body2, "utf8");
    fs.writeFileSync(path.join(fakeHome, ".gemini", "antigravity-cli", "cli.log"), body2, "utf8");

    const winDisc = discoverSafetyLogSources({
      platform: "win32",
      homeDir: fakeHome,
      env: { APPDATA: customAppData, USERPROFILE: fakeHome },
      nowMs
    });
    const winBasenames = winDisc.files.map((f) => path.basename(f.path)).sort();
    assert.deepEqual(winBasenames, ["cli-20261127_135000.log", "language_server.log"], "Must discover custom APPDATA and skip duplicate cli.log");
    assert.equal(winDisc.lastDesktopRestart?.version, "v2.35.2");

    // macOS discovery
    const macHome = path.join(tmpDir, "mac-home");
    fs.mkdirSync(path.join(macHome, "Library", "Application Support", "Antigravity", "logs"), { recursive: true });
    fs.writeFileSync(path.join(macHome, "Library", "Application Support", "Antigravity", "logs", "language_server.log"), body2, "utf8");
    const macDisc = discoverSafetyLogSources({ platform: "darwin", homeDir: macHome, env: { HOME: macHome }, nowMs });
    assert.equal(macDisc.files.length, 1);

    // Linux discovery
    const linHome = path.join(tmpDir, "lin-home");
    const xdgCfg = path.join(tmpDir, "xdg-cfg");
    fs.mkdirSync(path.join(xdgCfg, "Antigravity", "logs"), { recursive: true });
    fs.writeFileSync(path.join(xdgCfg, "Antigravity", "logs", "language_server.log"), body2, "utf8");
    const linDisc = discoverSafetyLogSources({
      platform: "linux",
      homeDir: linHome,
      env: { HOME: linHome, XDG_CONFIG_HOME: xdgCfg },
      nowMs
    });
    assert.equal(linDisc.files.length, 1);

    // 4c. Sanitization & redaction (secrets, emails, ANSI, lone surrogates)
    const dirty = "User alice@example.com key=sk-ant-1234567890abcdefghij \x1b[31mRED\x1b[0m \ud800";
    const clean = sanitizeSafetyText(dirty, 200, fakeHome);
    assert.equal(clean.includes("alice@example.com"), false);
    assert.equal(clean.includes("sk-ant-"), false);
    assert.equal(clean.includes("\x1b"), false);
    assert.ok(clean.includes("[REDACTED:EMAIL]"));

    // 4d. 10 MB high-noise log cold scan + incremental cache speed
    const bigLog = path.join(tmpDir, "big-noisy.log");
    const noiseChunk =
      "ERROR: logging before google.Init: E1127 13:50:00.000000 1234 cascade_manager.go:2111] LoadTrajectory failed: file does not exist\n".repeat(
        1000
      );
    const fd = fs.openSync(bigLog, "w");
    try {
      for (let i = 0; i < 80; i++) {
        fs.writeSync(fd, noiseChunk);
      }
      fs.writeSync(fd, body2);
    } finally {
      fs.closeSync(fd);
    }
    const bigState = path.join(tmpDir, "big-state.json");
    const bigRep1 = auditSafetyMonitor({ logPaths: [bigLog], disableDefaultDiscovery: true, statePath: bigState, nowMs });
    assert.equal(bigRep1.window.precheckCount, 1);
    assert.ok(bigRep1.sources.bytesScanned > 9 * 1024 * 1024);
    assert.ok(bigRep1.sources.scanMs < 5000);

    const bigRep2 = auditSafetyMonitor({ logPaths: [bigLog], disableDefaultDiscovery: true, statePath: bigState, nowMs });
    assert.equal(bigRep2.sources.bytesScanned, 0);
    assert.equal(bigRep2.sources.cacheHits, 1);
    assert.ok(bigRep2.sources.scanMs < 100);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("5. Config overrides, ctx_doctor <= 8.4 KB cap, handoff.js Safety Monitor Advisory & outside-workspace pre-tool-use guardrail", async () => {
  const tmpDir = makeTempDir("agy-safety-wiring-");
  try {
    resetConfigCache();
    resetSafetyAuditCache();

    // 5a. Config env overrides precedence
    const snap = getConfigSnapshot({
      configPath: path.join(tmpDir, "missing.json"),
      env: {
        AGY_DART_SAFETY_AUDIT: "true",
        AGY_DART_SAFETY_WINDOW_HOURS: "3",
        AGY_DART_SAFETY_PRECHECK_WARN: "2500",
        AGY_DART_SAFETY_PRECHECK_LIMIT: "4000",
        AGY_DART_SAFETY_LOG_PATHS: `${path.join(tmpDir, "a.log")};${path.join(tmpDir, "b.log")}`
      }
    });
    assert.equal(snap.values.safetyAudit, true);
    assert.equal(snap.values.safetyWindowHours, 3);
    assert.equal(snap.values.safetyPrecheckWarnCount, 2500);
    assert.equal(snap.values.safetyPrecheckLimit, 4000);
    assert.equal(snap.values.safetyLogPaths.length, 2);

    // 5b. ctx_doctor includes compact safetyMonitor and strictly obeys <= 8,400 B cap even with hostile filters.json
    const dbPath = path.join(tmpDir, "doc.db");
    const store = new ContextModeStore({ dbPath });
    try {
      fs.mkdirSync(path.join(tmpDir, ".agy-dart"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".agy-dart", "filters.json"),
        JSON.stringify({
          rules: Array.from({ length: 20 }, (_, i) => ({ id: `bad_${i}`, match: "a".repeat(80) + "(a+)+" }))
        }),
        "utf8"
      );
      const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "doc-safety-s1" });
      const doc = await tools.ctx_doctor({ cwd: tmpDir });
      assert.ok(doc.safetyMonitor && typeof doc.safetyMonitor.status === "string");
      assert.equal(doc.features.safetyAuditEnabled, true);
      const serialized = JSON.stringify(doc, null, 2);
      assert.ok(Buffer.byteLength(serialized, "utf8") <= 8400, `ctx_doctor exceeded 8400 B: ${Buffer.byteLength(serialized, "utf8")}`);
    } finally {
      store.close();
    }

    // 5c. handoff.js Safety Monitor Advisory (only when alerting; byte-budget safe; identical when healthy/null)
    const normalFull = buildHandoffBrief({ cwd: tmpDir, sessionId: "s-norm", safetyContext: null });
    const okFull = buildHandoffBrief({ cwd: tmpDir, sessionId: "s-norm", safetyContext: { status: "ok", severity: "ok" } });
    assert.equal(normalFull.markdown, okFull.markdown, "Healthy safetyContext must produce byte-identical handoff brief");

    const alertCtx = {
      status: "heavy_burst_or_sticky",
      severity: "warn",
      summaryEn: "Zero-429 heavy safety review burst detected: 4 gemini-4-hydrogen-sonar calls.",
      window: { precheckCount: 180, precheckLimit: 4400, heavyReviewCount: 4, heavyAvgChars: 280000, heavyTriggeredFalse: 4 },
      streamRequests: { hiddenSharePct: 48.2 }
    };
    const alertAgent = buildHandoffBrief({
      mode: "agent",
      cwd: tmpDir,
      conversationId: "conv-1234",
      conversationConfirmed: true,
      safetyContext: alertCtx,
      maxBytes: 1800
    });
    assert.ok(alertAgent.markdown.includes("## Safety Monitor Advisory"));
    assert.ok(alertAgent.markdown.includes("heavy_burst_or_sticky"));
    assert.ok(Buffer.byteLength(alertAgent.markdown, "utf8") <= 1800);

    const alertFull = buildHandoffBrief({
      mode: "full",
      cwd: tmpDir,
      sessionId: "s-alert",
      safetyContext: alertCtx,
      maxBytes: 1400
    });
    assert.ok(alertFull.markdown.includes("## Safety Monitor Advisory"));
    assert.ok(Buffer.byteLength(alertFull.markdown, "utf8") <= 1400);

    // 5d. Outside-workspace pre-tool-use.mjs read_file guardrail: keeps agent on native read_file (NOT read_slices)
    const wsDir = path.join(tmpDir, "workspace");
    const extDir = path.join(tmpDir, "external-plugin");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    const bigSrc = Array.from({ length: 1600 }, (_, i) => `export function fn_${i}() { return ${i}; }`).join("\n") + "\n";
    const insideFile = path.join(wsDir, "inside.js");
    const outsideFile = path.join(extDir, "outside.js");
    fs.writeFileSync(insideFile, bigSrc, "utf8");
    fs.writeFileSync(outsideFile, bigSrc, "utf8");

    const hookScript = path.join(ROOT, "hooks", "pre-tool-use.mjs");
    const runHook = (filePath) =>
      spawnSync(process.execPath, [hookScript], {
        input: JSON.stringify({
          hookEventName: "PreToolUse",
          cwd: wsDir,
          workspacePaths: [wsDir],
          toolCall: { name: "read_file", args: { Path: filePath } }
        }),
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          AGY_DART_DB_PATH: path.join(tmpDir, "hook.db"),
          AGY_DART_CONFIG_PATH: path.join(tmpDir, "no-cfg.json")
        }
      });

    const outRes = JSON.parse(runHook(outsideFile).stdout.trim());
    assert.equal(outRes.decision, "deny");
    assert.ok(outRes.reason.includes("outside the active workspace"));
    assert.ok(outRes.reason.includes("allowed_tool"));
    assert.equal(outRes.reason.includes("read_slices"), false, "Outside-workspace read_file block MUST NOT push agent to read_slices");
    assert.equal(outRes.reason.includes("call_mcp_tool"), false, "Outside-workspace read_file block MUST NOT push agent to call_mcp_tool");
    assert.ok(outRes.reason.includes("## Outline:"), "Outside-workspace read_file block should still attach inline outline");

    const inRes = JSON.parse(runHook(insideFile).stdout.trim());
    assert.equal(inRes.decision, "deny");
    assert.ok(inRes.reason.includes("read_slices"), "Inside-workspace read_file block retains read_slices guidance");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. Sidecar /api/safety-audit (standalone CSRF + SidecarApp POST-only) and CLI --safety-audit / audit safety", async () => {
  const tmpDir = makeTempDir("agy-safety-e2e-");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  let srv = null;
  try {
    closeRuntimeStore();
    resetSidecarSafetyAuditCache();
    process.env.AGY_DART_DB_PATH = path.join(tmpDir, "sidecar.db");

    const nowMs = new Date(2026, 10, 27, 1, 25, 0, 0).getTime();
    const logFile = path.join(tmpDir, "language_server.log");
    fs.writeFileSync(
      logFile,
      [
        ...FIXTURES.desktop_sonar_and_main_stream,
        ...FIXTURES.desktop_zero_429_escalation_300k_mcp
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(logFile, nowMs / 1000, nowMs / 1000);

    const safetyAuditOptions = {
      logPaths: [logFile],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    };

    // 6a. Standalone HTTP server with CSRF token
    const token = "safety-csrf-token-v18";
    srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: { pollMs: 60000 },
      safetyAuditOptions
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address();

    // Missing token -> 403
    const unauth = await fetch(`http://127.0.0.1:${port}/api/safety-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(unauth.status, 403);

    // Invalid boolean -> 400
    const badReq = await fetch(`http://127.0.0.1:${port}/api/safety-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ forceRefresh: "yes" })
    });
    assert.equal(badReq.status, 400);

    // Valid request with includeMarkdown: true -> 200
    const okRes = await fetch(`http://127.0.0.1:${port}/api/safety-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ forceRefresh: true, includeMarkdown: true })
    });
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.window.heavyReviewCount, 1);
    assert.equal(body.window.heavyMaxChars, 299876);
    assert.ok(typeof body.markdown === "string" && body.markdown.includes("Safety Monitor Quota-Burn Audit"));

    // HTML includes Safety Monitor card and UI scripts call /api/safety-audit
    const html = await fetchDashboardHtml(`http://127.0.0.1:${port}`);
    assert.ok(html.includes('id="safety-audit-card"'));
    assert.ok(html.includes("/api/safety-audit"));

    // 6b. SidecarApp mode (`registerSidecarRoutes`, POST-only)
    const routes = new Map();
    registerSidecarRoutes(
      {
        config: { conversationId: "conv-sc-1" },
        api(routePath, handler, method) {
          routes.set(routePath, { handler, method });
        }
      },
      { safetyAuditOptions }
    );
    const saRoute = routes.get("/api/safety-audit");
    assert.ok(saRoute, "registerSidecarRoutes must register /api/safety-audit");
    assert.equal(saRoute.method, "POST");
    const scBad = saRoute.handler("not-an-object");
    assert.equal(scBad.status, 400);
    const scOk = saRoute.handler({ includeMarkdown: true });
    assert.equal(scOk.ok, true);
    assert.equal(scOk.window.heavyReviewCount, 1);

    // 6c. CLI scripts/cache-audit.mjs --safety-audit & bin/agy-dart.mjs audit safety
    const cliOut = auditSafetyMonitorOnly({
      safetyLogPaths: [logFile],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(cliOut.window.heavyMaxChars, 299876);
    assert.ok(formatSafetyAuditMarkdown(cliOut).includes("299,876"));

    const binRes = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "bin", "agy-dart.mjs"),
        "audit",
        "safety",
        "--safety-log-path",
        logFile,
        "--no-state",
        "--json"
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(binRes.status, 0, binRes.stderr);
    const binJson = JSON.parse(binRes.stdout);
    assert.equal(binJson.schemaVersion, "1.0");
    assert.equal(binJson.sources.filesScanned, 1);

    // Default auditEnvironmentCache remains hermetic (omits `safety` unless includeSafety=true)
    const emptyWs = path.join(tmpDir, "ws");
    const emptyCfg = path.join(tmpDir, "cfg");
    fs.mkdirSync(emptyWs, { recursive: true });
    fs.mkdirSync(emptyCfg, { recursive: true });
    const envNoSafety = await auditEnvironmentCache({ workspace: emptyWs, configDir: emptyCfg, live: false });
    assert.equal("safety" in envNoSafety, false);
    const envWithSafety = await auditEnvironmentCache({
      workspace: emptyWs,
      configDir: emptyCfg,
      live: false,
      includeSafety: true,
      safetyLogPaths: [logFile],
      disableDefaultDiscovery: true,
      persistState: false,
      nowMs
    });
    assert.equal(envWithSafety.safety.window.heavyReviewCount, 1);
  } finally {
    if (srv) {
      await new Promise((resolve) => srv.close(resolve));
    }
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("7. Dashboard Safety Monitor plain-language UX: narrow-header CSS, calm-recent vs active-burst severity, human duration & zero-truncation suppression", async () => {
  const vm = await import("node:vm");
  const html = readDashboardHtml();

  // Layout invariants: prevent 3-line vertical title squash & clipped badge in narrow sidebars
  assert.ok(html.includes(".safety-head-left .band-title"), "CSS must protect title/badge from flexing/clipping");
  assert.ok(html.includes('id="safety-advice-box"'), "HTML must include plain-language action callout box");
  assert.ok(!html.includes("var(--surface-elevated)"), "CSS must not reference undefined --surface-elevated variable");

  // Extract inline script & execute renderSafetyAuditCard against lightweight DOM mocks (no classList.toggle)
  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const mainScript = scriptMatches.map((m) => m[1]).find((s) => s.includes("function renderSafetyAuditCard"));
  assert.ok(mainScript, "Dashboard main script must define renderSafetyAuditCard");

  function makeEl(id, initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
      id,
      textContent: "",
      innerHTML: "",
      title: "",
      value: "",
      dataset: {},
      style: {},
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
      setAttribute() {},
      getAttribute() {
        return "";
      },
      addEventListener() {},
      querySelectorAll() {
        return [];
      }
    };
  }

  const els = new Map(
    [
      "safety-audit-card",
      "safety-status-badge",
      "safety-inline-summary",
      "safety-details-body",
      "safety-toggle-btn",
      "safety-advice-box",
      "safety-diagnosis-text",
      "safety-kpi-prechecks",
      "safety-kpi-prechecks-sub",
      "safety-kpi-heavy",
      "safety-kpi-heavy-sub",
      "safety-kpi-hidden",
      "safety-kpi-hidden-sub",
      "safety-kpi-429",
      "safety-kpi-429-sub",
      "safety-reasons-row",
      "safety-restart-note",
      "safety-handoff-btn"
    ].map((id) => [id, makeEl(id, id === "safety-details-body" || id === "safety-advice-box" || id === "safety-restart-note" || id === "safety-handoff-btn" ? ["hidden"] : [])])
  );

  const timers = [];
  const sandbox = {
    console,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    JSON,
    RegExp,
    Promise,
    Intl,
    Headers,
    URLSearchParams,
    setTimeout(fn) {
      const t = { fn };
      timers.push(t);
      return t;
    },
    clearTimeout() {},
    setInterval() {
      return { unref() {} };
    },
    clearInterval() {},
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => "zh", setItem() {}, removeItem() {} },
    location: { search: "", origin: "http://127.0.0.1:0", pathname: "/" },
    addEventListener() {},
    removeEventListener() {},
    document: {
      hidden: true,
      documentElement: { lang: "zh" },
      title: "",
      getElementById: (id) => els.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mainScript, sandbox);
  vm.runInContext("currentLang = 'zh'; safetyUserExpanded = null;", sandbox);

  // Case A: Past-5h heavy burst that is CALM right now (recentHeavyBurst5m = 0, truncs = 0)
  sandbox.renderSafetyAuditCard({
    status: "heavy_burst_or_sticky",
    severity: "critical",
    windowHours: 5,
    window: {
      precheckCount: 544,
      precheckLimit: 4400,
      precheckUtilizationPct: 12.4,
      heavyReviewCount: 43,
      heavyTriggeredFalse: 43,
      heavyFalseAlarmRatePct: 100,
      heavyAvgChars: 246000,
      recentHeavyBurst5m: 0,
      totalLatencySec: 855.46,
      rateLimit429Count: 0,
      fallbackEscalationCount: 0,
      estimatedHiddenInputTokensLow: 3900000,
      estimatedHiddenInputTokensHigh: 5100000
    },
    streamRequests: { hiddenSharePct: 48.3, hiddenTotal: 586, total: 1212 },
    triggerReasons: [{ reason: "unknown_command", count: 12, pct: 60 }],
    sources: { filesScanned: 2, restartTruncationsDetected: 0, lastDesktopRestart: { ts: "2026-11-26 23:51:59.536" } }
  });

  const card = els.get("safety-audit-card");
  assert.equal(card.classList.contains("is-warn"), true, "Calm-recent 5h heavy burst should soften to amber is-warn");
  assert.equal(card.classList.contains("is-critical"), false, "Calm-recent 5h heavy burst must not scream critical red");
  assert.equal(els.get("safety-status-badge").textContent, "刚有偷烧 · 已平稳");
  assert.equal(els.get("safety-inline-summary").classList.contains("hidden"), true, "Expanded card must hide inline summary to avoid duplicate text");
  assert.equal(els.get("safety-details-body").classList.contains("hidden"), false);
  assert.ok(els.get("safety-advice-box").textContent.includes("此刻已经平稳"));
  assert.ok(!els.get("safety-diagnosis-text").textContent.includes("gemini-4-hydrogen-sonar"), "Plain-language card should avoid internal model jargon");
  assert.equal(els.get("safety-kpi-429").textContent, "14 分 15 秒");
  assert.ok(els.get("safety-kpi-429-sub").textContent.includes("390万"));
  assert.ok(els.get("safety-reasons-row").innerHTML.includes("复杂终端命令"));
  assert.equal(els.get("safety-restart-note").classList.contains("hidden"), true, "Zero restart truncations must keep restart note hidden");

  // Case B: Active heavy burst right now (recentHeavyBurst5m = 4, truncs = 2) -> critical red + visible restart note
  sandbox.renderSafetyAuditCard({
    status: "heavy_burst_or_sticky",
    severity: "critical",
    windowHours: 5,
    window: {
      precheckCount: 600,
      precheckLimit: 4400,
      precheckUtilizationPct: 13.6,
      heavyReviewCount: 47,
      heavyTriggeredFalse: 47,
      heavyFalseAlarmRatePct: 100,
      heavyAvgChars: 250000,
      recentHeavyBurst5m: 4,
      totalLatencySec: 910,
      rateLimit429Count: 0,
      fallbackEscalationCount: 0,
      estimatedHiddenInputTokensLow: 4100000,
      estimatedHiddenInputTokensHigh: 5400000
    },
    streamRequests: { hiddenSharePct: 51.0, hiddenTotal: 620, total: 1216 },
    triggerReasons: [],
    sources: { filesScanned: 2, restartTruncationsDetected: 2 }
  });
  assert.equal(card.classList.contains("is-critical"), true, "Active burst right now must highlight is-critical");
  assert.equal(els.get("safety-status-badge").textContent, "正在偷烧额度");
  assert.equal(els.get("safety-restart-note").classList.contains("hidden"), false, "Non-zero restart truncations must show plain-language note");
  assert.ok(els.get("safety-restart-note").textContent.includes("2 次"));

  // Case C: English mode renders cleanly with human duration (14m 15s) and calm badge
  vm.runInContext("currentLang = 'en'; safetyUserExpanded = false;", sandbox);
  sandbox.renderSafetyAuditCard({
    status: "heavy_burst_or_sticky",
    severity: "critical",
    windowHours: 5,
    window: {
      precheckCount: 544,
      precheckLimit: 4400,
      precheckUtilizationPct: 12.4,
      heavyReviewCount: 43,
      heavyTriggeredFalse: 43,
      heavyFalseAlarmRatePct: 100,
      heavyAvgChars: 246000,
      recentHeavyBurst5m: 0,
      totalLatencySec: 855.46,
      rateLimit429Count: 0,
      fallbackEscalationCount: 0,
      estimatedHiddenInputTokensLow: 3900000,
      estimatedHiddenInputTokensHigh: 5100000
    },
    streamRequests: { hiddenSharePct: 48.3, hiddenTotal: 586, total: 1212 },
    triggerReasons: [],
    sources: { filesScanned: 2, restartTruncationsDetected: 0 }
  });
  assert.equal(els.get("safety-status-badge").textContent, "Past 5h · Calm");
  assert.equal(els.get("safety-inline-summary").classList.contains("hidden"), false, "Collapsed card must show 1-line summary");
  assert.equal(els.get("safety-kpi-429").textContent, "14m 15s");
});

test("8. v1.8.2 quota-saving optimizations: in-workspace zero-check inline outline, cross-poll inFlight tid/chars carry-over, opt-in safetyDesktopNotify cooldown & synergy/2-step handoff UI", async () => {
  const vm = await import("node:vm");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v182-opt-"));
  const dbPath = path.join(tmpDir, "context.db");
  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  let srv = null;
  try {
    process.env.AGY_DART_DB_PATH = dbPath;
    closeRuntimeStore();
    resetSidecarSafetyAuditCache();

    // 8a. PreToolUse in-workspace large source file attaches free outline and guides native read_file (0 cloud review) without extra read_slices/call_mcp_tool detour
    const wsDir = path.join(tmpDir, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    const bigSrc = path.join(wsDir, "engine.js");
    const lines = [];
    for (let i = 0; i < 1200; i++) {
      lines.push(`export function step_${i}(x) { return x + ${i}; } // padding_${"a".repeat(25)}`);
    }
    fs.writeFileSync(bigSrc, lines.join("\n") + "\n", "utf8");
    const hookRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
      input: JSON.stringify({
        conversationId: "v182-inws",
        cwd: wsDir,
        workspacePaths: [wsDir],
        toolCall: { name: "read_file", args: { Path: bigSrc } }
      }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    assert.equal(hookRes.status, 0, hookRes.stderr);
    const parsedHook = JSON.parse(hookRes.stdout.trim());
    assert.equal(parsedHook.decision, "deny");
    assert.ok(parsedHook.reason.includes("allowed_tool, 0 cloud safety review"), parsedHook.reason);
    assert.ok(parsedHook.reason.includes("without extra read_slices MCP calls"), parsedHook.reason);
    assert.ok(!parsedHook.reason.includes("call_mcp_tool"), "Inline-outlined source file must not nudge call_mcp_tool");

    // 8b. Cross-poll incremental scan preserves inFlight pendingByTid chars, trigger reason & activeMonitorByTid stream attribution
    const logPath = path.join(tmpDir, "language_server.log");
    const statePath = path.join(tmpDir, "safety-state.json");
    const poll1Ms = new Date(2026, 10, 27, 8, 10, 0, 0).getTime();
    fs.writeFileSync(
      logPath,
      [
        'ERROR: logging before google.Init: I1127 08:09:50.100000  777001 runner.go:957] Monitor agy_tool_safety FINISHED: triggered=true, reason="unknown_command", duration=18µs',
        "ERROR: logging before google.Init: I1127 08:09:51.000000  777002 llm_monitor.go:349] LLM Monitor severe_internal_risks_agy: Starting evaluation",
        "ERROR: logging before google.Init: I1127 08:09:51.100000  777002 llm_monitor.go:636] LLM Monitor severe_internal_risks_agy: Trajectory formatted, length: 288760",
        "ERROR: logging before google.Init: I1127 08:09:51.200000  777002 llm_monitor.go:650] LLM Monitor severe_internal_risks_agy: Calling LLM (model: gemini-4-hydrogen-sonar)"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(logPath, poll1Ms / 1000, poll1Ms / 1000);
    const r1 = auditSafetyMonitor({
      logPaths: [logPath],
      disableDefaultDiscovery: true,
      statePath,
      nowMs: poll1Ms
    });
    assert.equal(r1.window.heavyReviewCount, 1);
    assert.equal(r1.window.heavyTriggeredFalse, 0);
    assert.equal(r1.recentHeavyEvents.length, 0);

    // Poll 2 arrives 5 seconds later with streamGenerateContent + Evaluation complete
    const poll2Ms = poll1Ms + 6000;
    fs.appendFileSync(
      logPath,
      [
        "ERROR: logging before google.Init: I1127 08:09:52.000000  777002 http_helpers.go:108] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "ERROR: logging before google.Init: I1127 08:09:56.500000  777002 llm_monitor.go:690] LLM Monitor severe_internal_risks_agy: Evaluation complete. Triggered: false, Severity: 0, Confidence: 10"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.utimesSync(logPath, poll2Ms / 1000, poll2Ms / 1000);
    const r2 = auditSafetyMonitor({
      logPaths: [logPath],
      disableDefaultDiscovery: true,
      statePath,
      nowMs: poll2Ms
    });
    assert.equal(r2.window.heavyReviewCount, 1);
    assert.equal(r2.window.heavyMaxChars, 288760, "Cross-poll carry-over must preserve exact 288,760 chars");
    assert.equal(r2.streamRequests.hiddenHeavy, 1, "Cross-poll activeMonitorByTid must attribute streamGenerateContent");
    assert.equal(r2.recentHeavyEvents[0].chars, 288760);
    assert.equal(r2.recentHeavyEvents[0].reason, "unknown_command");

    // 8c. safetyDesktopNotify config defaults OFF, toggles via /api/safety-audit, fires once on active burst with 15m cooldown
    const cfgDefault = getConfigSnapshot({ configPath: path.join(tmpDir, "missing.json"), env: {} });
    assert.equal(cfgDefault.values.safetyDesktopNotify, false);
    const cfgEnvOn = getConfigSnapshot({
      configPath: path.join(tmpDir, "missing.json"),
      env: { AGY_DART_SAFETY_DESKTOP_NOTIFY: "1" }
    });
    assert.equal(cfgEnvOn.values.safetyDesktopNotify, true);

    const burstLog = path.join(tmpDir, "burst.log");
    const burstNow = new Date(2026, 10, 27, 8, 20, 0, 0).getTime();
    const burstLines = [];
    for (let k = 0; k < 3; k++) {
      const sec = 10 + k * 10;
      const tid = 888000 + k;
      burstLines.push(
        `ERROR: logging before google.Init: I1127 08:19:${sec}.100000  ${tid} llm_monitor.go:636] LLM Monitor severe_internal_risks_agy: Trajectory formatted, length: 260000`,
        `ERROR: logging before google.Init: I1127 08:19:${sec}.200000  ${tid} llm_monitor.go:650] LLM Monitor severe_internal_risks_agy: Calling LLM (model: gemini-4-hydrogen-sonar)`,
        `ERROR: logging before google.Init: I1127 08:19:${sec + 5}.100000  ${tid} llm_monitor.go:690] LLM Monitor severe_internal_risks_agy: Evaluation complete. Triggered: false, Severity: 0, Confidence: 10`
      );
    }
    fs.writeFileSync(burstLog, burstLines.join("\n") + "\n", "utf8");
    fs.utimesSync(burstLog, burstNow / 1000, burstNow / 1000);

    const sentAlerts = [];
    const token = "v182-notify-token";
    srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: { pollMs: 60000 },
      safetyAuditOptions: {
        logPaths: [burstLog],
        disableDefaultDiscovery: true,
        persistState: false,
        nowMs: burstNow,
        notifyFn: (payload) => sentAlerts.push(payload)
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address();

    // Default OFF -> 0 OS notifications
    const resOff = await fetch(`http://127.0.0.1:${port}/api/safety-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ forceRefresh: true })
    });
    assert.equal(resOff.status, 200);
    const bodyOff = await resOff.json();
    assert.equal(bodyOff.desktopNotify.enabled, false);
    assert.equal(sentAlerts.length, 0);

    // Enable via setDesktopNotify: true -> fires 1 alert immediately
    const resOn = await fetch(`http://127.0.0.1:${port}/api/safety-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ setDesktopNotify: true, forceRefresh: true })
    });
    assert.equal(resOn.status, 200);
    const bodyOn = await resOn.json();
    assert.equal(bodyOn.desktopNotify.enabled, true);
    assert.equal(bodyOn.desktopNotify.source, "sqlite");
    assert.equal(bodyOn.desktopNotify.notifiedNow, true);
    assert.equal(sentAlerts.length, 1);

    // Immediate re-scan stays inside 15m cooldown -> still 1 alert total
    const resCooldown = await fetch(`http://127.0.0.1:${port}/api/safety-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ forceRefresh: true })
    });
    const bodyCooldown = await resCooldown.json();
    assert.equal(bodyCooldown.desktopNotify.notifiedNow, false);
    assert.equal(sentAlerts.length, 1);

    // 8d. Dashboard synergy tip + desktop notify chip + 2-step guided handoff hint
    const html = readDashboardHtml();
    const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    const mainScript = scriptMatches.map((m) => m[1]).find((s) => s.includes("function renderSafetyContextSynergyTip"));
    assert.ok(mainScript, "Dashboard script must define renderSafetyContextSynergyTip");

    function makeEl(id, initialClasses = []) {
      const classes = new Set(initialClasses);
      return {
        id,
        textContent: "",
        innerHTML: "",
        className: "",
        title: "",
        value: "",
        disabled: false,
        dataset: {},
        style: {},
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
        setAttribute() {},
        getAttribute() {
          return "";
        },
        addEventListener() {},
        querySelectorAll() {
          return [];
        }
      };
    }

    const els = new Map(
      [
        "safety-audit-card",
        "safety-status-badge",
        "safety-inline-summary",
        "safety-details-body",
        "safety-toggle-btn",
        "safety-advice-box",
        "safety-diagnosis-text",
        "safety-kpi-prechecks",
        "safety-kpi-prechecks-sub",
        "safety-kpi-heavy",
        "safety-kpi-heavy-sub",
        "safety-kpi-hidden",
        "safety-kpi-hidden-sub",
        "safety-kpi-429",
        "safety-kpi-429-sub",
        "safety-reasons-row",
        "safety-restart-note",
        "safety-handoff-btn",
        "safety-notify-btn",
        "kv-safety-synergy-tip",
        "kv-handoff-warmth-hint"
      ].map((id) => [id, makeEl(id, id === "kv-safety-synergy-tip" ? ["hidden"] : [])])
    );

    const sandbox = {
      console,
      Math,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      JSON,
      RegExp,
      Promise,
      Intl,
      Headers,
      URLSearchParams,
      setTimeout: () => ({}),
      clearTimeout() {},
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
      localStorage: { getItem: () => "zh", setItem() {}, removeItem() {} },
      location: { search: "", origin: "http://127.0.0.1:0", pathname: "/" },
      addEventListener() {},
      removeEventListener() {},
      document: {
        hidden: true,
        documentElement: { lang: "zh" },
        title: "",
        getElementById: (id) => els.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
      },
      window: null
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);
    vm.runInContext(
      `currentLang = 'zh';
       cachedKv = { transcriptFound: true, currentContextTokens: 145000, modelProfile: { windowTokens: 200000 } };
       cachedSafetyAudit = {
         status: 'heavy_burst_or_sticky',
         severity: 'warn',
         windowHours: 5,
         window: { precheckCount: 400, precheckLimit: 4400, precheckUtilizationPct: 9.1, heavyReviewCount: 8, recentHeavyBurst5m: 0, totalLatencySec: 120 },
         streamRequests: { hiddenSharePct: 45, hiddenTotal: 400, total: 888 },
         desktopNotify: { enabled: true, source: 'sqlite' },
         sources: { filesScanned: 1, restartTruncationsDetected: 0 }
       };
       renderSafetyAuditCard(cachedSafetyAudit);`,
      sandbox
    );
    assert.equal(els.get("kv-safety-synergy-tip").classList.contains("hidden"), false, "Long chat + heavy safety must show synergy tip");
    assert.ok(els.get("kv-safety-synergy-tip").textContent.includes("145k"));
    assert.equal(els.get("safety-notify-btn").textContent, "偷烧弹窗提醒：开");
    assert.equal(els.get("safety-notify-btn").classList.contains("is-on"), true);

    vm.runInContext("safetyHandoffGuided = true; safetyHandoffAutoCopied = true; renderHandoffWarmthHint();", sandbox);
    assert.ok(els.get("kv-handoff-warmth-hint").textContent.includes("已自动帮你复制好交接进度"));

    // Short chat hides synergy tip
    vm.runInContext("cachedKv.currentContextTokens = 25000; renderSafetyContextSynergyTip();", sandbox);
    assert.equal(els.get("kv-safety-synergy-tip").classList.contains("hidden"), true, "Short chat must hide synergy tip");
  } finally {
    if (srv) await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    resetSidecarSafetyAuditCache();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
