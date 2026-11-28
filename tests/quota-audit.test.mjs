import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  auditQuota,
  clearQuotaBaseline,
  evaluateQuotaCalibration,
  formatQuotaAuditMarkdown,
  isBuiltinSubagentType,
  loadQuotaMarks,
  normalizeQuotaPool,
  recordQuotaMark,
  resetQuotaMarks,
  resolveModelPricing,
  resolveQuotaPool,
  setQuotaBaseline
} from "../scripts/quota-audit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function writeTranscript(brainRoot, convId, steps, mtimeMs = null) {
  const dir = path.join(brainRoot, convId, ".system_generated", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(fp, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  if (mtimeMs !== null) {
    const dt = new Date(mtimeMs);
    fs.utimesSync(fp, dt, dt);
  }
  return fp;
}

test("quota-audit: built-in allowlist, model pricing, windowed step filtering & transitive custom-agent lineage", () => {
  assert.equal(isBuiltinSubagentType("research"), true);
  assert.equal(isBuiltinSubagentType('"DeepCoder"'), true);
  assert.equal(isBuiltinSubagentType("DeepInvestigator"), true);
  assert.equal(isBuiltinSubagentType("DeepInvestigatorWorkerL0"), true);
  assert.equal(isBuiltinSubagentType("DeepInvestigatorImprovementWorker"), true);
  assert.equal(isBuiltinSubagentType("DeepCoderWorkerL0"), true);
  assert.equal(isBuiltinSubagentType("DeepCoderImprovementWorker"), true);
  assert.equal(isBuiltinSubagentType("self"), true);
  assert.equal(isBuiltinSubagentType("cmd-verifier"), false);
  assert.equal(isBuiltinSubagentType("dart-reviewer"), false);

  const neonPrice = resolveModelPricing("gemini-4-neon-xhigh", Date.parse("2026-11-28T10:00:00Z"));
  assert.equal(neonPrice.inputPer1M, 3.0);
  assert.equal(neonPrice.cacheReadPer1M, 0.15);
  assert.equal(neonPrice.outputPer1M, 15.0);

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-audit-"));
  try {
    const brainRoot = path.join(baseDir, "brain");
    const cfgDir = path.join(baseDir, "cfg");
    const wsDir = path.join(baseDir, "ws");
    const marksPath = path.join(baseDir, "quota-marks.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });

    const nowMs = Date.parse("2026-11-28T12:00:00Z");
    const oldTs = "2026-11-26T00:00:00Z"; // outside 24h window
    const t1 = "2026-11-28T10:00:00Z";
    const t2 = "2026-11-28T10:01:00Z";
    const t3 = "2026-11-28T10:02:00Z";

    // 1. Main conversation invokes built-in research + custom cmd-verifier; also has an out-of-window historical step
    writeTranscript(
      brainRoot,
      "main-conv-1111",
      [
        { step_index: 0, type: "USER_INPUT", created_at: oldTs, content: "old task" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: oldTs, model: "gemini-4-neon-xhigh", input_tokens: 500000, cache_read_tokens: 0, output_tokens: 1000 },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: t1,
          model: "gemini-4-neon-xhigh",
          input_tokens: 100000,
          cache_read_tokens: 100000,
          output_tokens: 1000,
          tool_calls: [{ name: "invoke_subagent", args: { TypeName: '"research"', Role: '"Reader"' } }]
        },
        { step_index: 3, type: "GENERIC", created_at: t1, content: 'Created subagent:\n{"conversationId":"builtin-child-2222"}' },
        {
          step_index: 4,
          type: "PLANNER_RESPONSE",
          created_at: t2,
          model: "gemini-4-neon-xhigh",
          input_tokens: 10000,
          cache_read_tokens: 0,
          output_tokens: 500,
          tool_calls: [{ name: "invoke_subagent", args: { TypeName: '"cmd-verifier"', Role: '"Verifier"' } }]
        },
        { step_index: 5, type: "GENERIC", created_at: t2, content: 'Created subagent:\n{"conversationId":"custom-child-3333"}' }
      ],
      nowMs
    );

    // 2. Built-in research child (1x)
    writeTranscript(
      brainRoot,
      "builtin-child-2222",
      [
        { step_index: 0, type: "SYSTEM_MESSAGE", created_at: t1, content: "[Message] sender=main-conv-1111 content=read file" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: t1, model: "gemini-4-neon-xhigh", input_tokens: 50000, cache_read_tokens: 0, output_tokens: 500 }
      ],
      nowMs
    );

    // 3. Custom agent child spawns a grandchild (`self`) -> grandchild must transitively inherit custom 4x lineage!
    writeTranscript(
      brainRoot,
      "custom-child-3333",
      [
        { step_index: 0, type: "SYSTEM_MESSAGE", created_at: t2, content: "[Message] sender=main-conv-1111 content=verify" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: t2,
          model: "gemini-4-neon-xhigh",
          input_tokens: 100000,
          cache_read_tokens: 0,
          output_tokens: 1000,
          tool_calls: [{ name: "invoke_subagent", args: { TypeName: '"self"', Role: '"Nested Helper"' } }]
        },
        { step_index: 2, type: "GENERIC", created_at: t2, content: 'Created subagent:\n{"conversationId":"grandchild-4444"}' }
      ],
      nowMs
    );

    writeTranscript(
      brainRoot,
      "grandchild-4444",
      [
        { step_index: 0, type: "SYSTEM_MESSAGE", created_at: t3, content: "[Message] sender=custom-child-3333 content=sub-check" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: t3, model: "gemini-4-neon-xhigh", input_tokens: 100000, cache_read_tokens: 0, output_tokens: 1000 }
      ],
      nowMs
    );

    const report = auditQuota({
      brainRoots: [brainRoot],
      workspace: wsDir,
      configDir: cfgDir,
      statePath: marksPath,
      hours: 24,
      nowMs,
      includeSafety: false
    });

    assert.equal(report.overallStatus, "alert_4x_risk");
    // Out-of-window 500k step must be excluded
    assert.equal(report.layer3Billing.buckets.main.inputTokens, 110000);
    assert.equal(report.layer3Billing.buckets.builtin_subagent.conversationCount, 1);
    // Both custom-child-3333 and its grandchild grandchild-4444 must be classified under custom_agent
    assert.equal(report.layer3Billing.buckets.custom_agent.conversationCount, 2);
    assert.equal(report.layer3Billing.buckets.custom_agent.inputTokens, 200000);
    assert.equal(report.layer1CustomAgents.builtinInvocationCount, 2); // research + nested self
    assert.equal(report.layer1CustomAgents.customInvocationCount, 1); // cmd-verifier
    assert.ok(
      report.layer1CustomAgents.alerts.some((a) => a.kind === "custom_agent_descendant" && a.childConvId === "grandchild-4444"),
      "Grandchild spawned by a custom agent must inherit custom 4x lineage alert"
    );
    assert.ok(report.layer1CustomAgents.customExtra3xUsd > 1.8);

    const md = formatQuotaAuditMarkdown(report);
    assert.ok(md.includes("ALERT"));
    assert.ok(md.includes("cmd-verifier"));
    assert.ok(md.includes("grandchild-4444"));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("quota-audit: weekly quota marks calibrate ~1x PASS, ~4x ALERT, and handle weekly resets cleanly", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-marks-"));
  try {
    const brainRoot = path.join(baseDir, "brain");
    const marksPath = path.join(baseDir, "quota-marks.json");
    const t0 = Date.parse("2026-11-28T08:00:00Z");
    const tMid = Date.parse("2026-11-28T09:00:00Z");
    const t1 = Date.parse("2026-11-28T10:00:00Z");
    const tReset = Date.parse("2026-11-28T11:00:00Z");

    // 2M input tokens on gemini-4-neon-xhigh ($3/1M) = exactly $6.000
    writeTranscript(
      brainRoot,
      "conv-clean-1x",
      [
        { step_index: 0, type: "USER_INPUT", created_at: new Date(tMid).toISOString(), content: "work" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tMid).toISOString(), model: "gemini-4-neon-xhigh", input_tokens: 2000000, cache_read_tokens: 0, output_tokens: 0 }
      ],
      t1
    );

    // 1. Mark 80% -> 79% (1% drop for $6.00 => 1.0x PASS)
    recordQuotaMark(80, { statePath: marksPath, nowMs: t0, note: "start" });
    const { marks: marks1x } = recordQuotaMark(79, { statePath: marksPath, nowMs: t1, note: "after work" });
    const cal1x = evaluateQuotaCalibration(marks1x, { brainRoots: [brainRoot], baselineUsdPerPct: 6.0 });
    assert.equal(cal1x.status, "pass_1x");
    assert.equal(cal1x.deltaPct, 1);
    assert.equal(cal1x.deltaUsd1x, 6);
    assert.equal(cal1x.impliedMultiplier, 1);

    // 2. Mark 80% -> 76% (4% drop for $6.00 => $1.50/1% => 4.0x ALERT)
    resetQuotaMarks(marksPath);
    recordQuotaMark(80, { statePath: marksPath, nowMs: t0 });
    const { marks: marks4x } = recordQuotaMark(76, { statePath: marksPath, nowMs: t1 });
    const cal4x = evaluateQuotaCalibration(marks4x, {
      brainRoots: [brainRoot],
      baselineUsdPerPct: 6.0,
      diskCustomAgents: { deprecatedCount: 1 }
    });
    assert.equal(cal4x.status, "alert_suspected_4x");
    assert.equal(cal4x.usdPerPct, 1.5);
    assert.equal(cal4x.impliedMultiplier, 4);
    assert.match(cal4x.verdictZh, /DEPRECATED 占位文件/);

    // 3. Weekly quota reset (76% -> 100%) detected without dividing by negative delta
    const { marks: marksReset } = recordQuotaMark(100, { statePath: marksPath, nowMs: tReset });
    const calReset = evaluateQuotaCalibration(marksReset, { brainRoots: [brainRoot] });
    assert.equal(calReset.status, "quota_reset_detected");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("quota-audit: bin/agy-dart.mjs audit quota --json runs end-to-end with clean 1x report", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-cli-"));
  try {
    const brainRoot = path.join(baseDir, "brain");
    const cfgDir = path.join(baseDir, "cfg");
    const wsDir = path.join(baseDir, "ws");
    const marksPath = path.join(baseDir, "marks.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });

    const nowIso = new Date().toISOString();
    writeTranscript(brainRoot, "conv-cli-clean", [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso, content: "hello" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: nowIso, model: "gemini-4-neon-xhigh", input_tokens: 20000, cache_read_tokens: 0, output_tokens: 50 }
    ]);

    const res = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "bin", "agy-dart.mjs"),
        "audit",
        "quota",
        "--hours",
        "12",
        "--brain-root",
        brainRoot,
        "--workspace",
        wsDir,
        "--config-dir",
        cfgDir,
        "--state-path",
        marksPath,
        "--no-safety",
        "--json"
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 }
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.overallStatus, "clean_1x");
    assert.equal(parsed.layer1CustomAgents.customInvocationCount, 0);
    assert.equal(parsed.layer3Billing.activeConversationCount, 1);
    assert.equal(parsed.calibration.status, "needs_two_marks");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("quota-audit: dual-pool (gemini vs claude-gpt) isolates concurrent model usage and inherits CHECKPOINT model", () => {
  assert.equal(resolveQuotaPool("gemini-4-neon-xhigh"), "gemini");
  assert.equal(resolveQuotaPool("gemini-4-hydrogen-tiered-high"), "gemini");
  assert.equal(resolveQuotaPool("gemini-3.5-flash-lite"), "gemini");
  assert.equal(resolveQuotaPool("claude-opus-5-5-high"), "claude-gpt");
  assert.equal(resolveQuotaPool("claude-sonnet-4-6"), "claude-gpt");
  assert.equal(resolveQuotaPool("gpt-5.4"), "claude-gpt");
  assert.equal(resolveQuotaPool("unknown"), "other");
  assert.equal(normalizeQuotaPool("claude"), "claude-gpt");
  assert.equal(normalizeQuotaPool("gpt"), "claude-gpt");
  assert.equal(normalizeQuotaPool("gemini"), "gemini");

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-pools-"));
  try {
    const brainRoot = path.join(baseDir, "brain");
    const cfgDir = path.join(baseDir, "cfg");
    const wsDir = path.join(baseDir, "ws");
    const marksPath = path.join(baseDir, "quota-marks.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });

    const tPre = Date.parse("2026-11-28T02:00:00Z");
    const t0 = Date.parse("2026-11-28T08:00:00Z");
    const tMid = Date.parse("2026-11-28T09:00:00Z");
    const t1 = Date.parse("2026-11-28T10:00:00Z");

    // Gemini conv: 1.5M explicit + 0.5M model-less CHECKPOINT inheriting gemini-4-neon-xhigh ($3/1M) => $6.000
    writeTranscript(
      brainRoot,
      "conv-gemini-mixed",
      [
        { step_index: 0, type: "PLANNER_RESPONSE", created_at: new Date(tPre).toISOString(), model: "gemini-4-neon-xhigh", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 10 },
        { step_index: 1, type: "CHECKPOINT", created_at: new Date(tMid).toISOString(), input_tokens: 500000, cache_read_tokens: 0, output_tokens: 0 },
        { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tMid + 1000).toISOString(), model: "gemini-4-neon-xhigh", input_tokens: 1500000, cache_read_tokens: 0, output_tokens: 0 }
      ],
      t1
    );

    // Claude conv running in the EXACT SAME window: 3M input on claude-opus-5-5-high ($4/1M) => $12.000
    writeTranscript(
      brainRoot,
      "conv-claude-mixed",
      [
        { step_index: 0, type: "USER_INPUT", created_at: new Date(tMid).toISOString(), content: "claude task" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tMid).toISOString(), model: "claude-opus-5-5-high", input_tokens: 3000000, cache_read_tokens: 0, output_tokens: 0 }
      ],
      t1
    );

    // Dual-pool start marks at t0: Gemini 68%, Claude/GPT 83%
    recordQuotaMark(68, { statePath: marksPath, nowMs: t0, pool: "gemini", note: "start" });
    recordQuotaMark(83, { statePath: marksPath, nowMs: t0, pool: "claude-gpt", note: "start" });

    // Dual-pool end marks at t1 BEFORE personal baselines are set => baseline_uncalibrated (no false $6/1% alert!)
    const uncalibrated = auditQuota({
      brainRoots: [brainRoot],
      workspace: wsDir,
      configDir: cfgDir,
      statePath: marksPath,
      markGeminiPct: 67,
      markClaudeGptPct: 81,
      markNote: "end",
      hours: 6,
      nowMs: t1,
      includeSafety: false
    });

    assert.equal(uncalibrated.overallStatus, "clean_1x");
    assert.equal(uncalibrated.layer3Billing.pools.gemini.usd1x, 6);
    assert.equal(uncalibrated.layer3Billing.pools["claude-gpt"].usd1x, 12);
    assert.equal(uncalibrated.layer3Billing.pools.other.steps, 0);
    assert.equal(uncalibrated.poolCalibrations.gemini.status, "baseline_uncalibrated");
    assert.equal(uncalibrated.poolCalibrations.gemini.usdPerPct, 6);
    assert.equal(uncalibrated.poolCalibrations.gemini.impliedMultiplier, null);
    assert.equal(uncalibrated.poolCalibrations["claude-gpt"].status, "baseline_uncalibrated");
    assert.equal(uncalibrated.poolCalibrations["claude-gpt"].usdPerPct, 6);

    // Auto-calibrate personal 1x baselines from the clean window => both pools lock at $6/1% and pass at 1.0x
    const report = auditQuota({
      brainRoots: [brainRoot],
      workspace: wsDir,
      configDir: cfgDir,
      statePath: marksPath,
      calibrateBaseline: true,
      hours: 6,
      nowMs: t1,
      includeSafety: false
    });

    assert.equal(report.overallStatus, "clean_1x");
    assert.equal(report.poolCalibrations.gemini.status, "pass_1x");
    assert.equal(report.poolCalibrations.gemini.baselineSource, "saved");
    assert.equal(report.poolCalibrations.gemini.deltaUsd1x, 6);
    assert.equal(report.poolCalibrations.gemini.impliedMultiplier, 1);
    assert.equal(report.poolCalibrations["claude-gpt"].status, "pass_1x");
    assert.equal(report.poolCalibrations["claude-gpt"].baselineSource, "saved");
    assert.equal(report.poolCalibrations["claude-gpt"].deltaUsd1x, 12);
    assert.equal(report.poolCalibrations["claude-gpt"].impliedMultiplier, 1);

    const md = formatQuotaAuditMarkdown(report);
    assert.ok(md.includes("Gemini 模型池"));
    assert.ok(md.includes("Claude 与 GPT 模型池"));
    assert.ok(md.includes("已标定个人 1× 基线"));

    // Resetting only gemini marks preserves claude-gpt marks AND preserves saved personal baselines by default
    resetQuotaMarks(marksPath, { pool: "gemini" });
    const afterPartialReset = loadQuotaMarks(marksPath);
    assert.equal(afterPartialReset.marks.filter((m) => m.pool === "gemini").length, 0);
    assert.equal(afterPartialReset.marks.filter((m) => m.pool === "claude-gpt").length, 2);
    assert.equal(afterPartialReset.baselines.gemini.usdPerPct, 6);
    assert.equal(afterPartialReset.baselines["claude-gpt"].usdPerPct, 6);

    // CLI dual-mark flags end-to-end
    const cliRes = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "bin", "agy-dart.mjs"),
        "audit",
        "quota",
        "--mark-gemini",
        "68",
        "--mark-claude-gpt",
        "83",
        "--brain-root",
        brainRoot,
        "--workspace",
        wsDir,
        "--config-dir",
        cfgDir,
        "--state-path",
        marksPath,
        "--no-safety",
        "--json"
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 }
    );
    assert.equal(cliRes.status, 0, cliRes.stderr || cliRes.stdout);
    const cliJson = JSON.parse(cliRes.stdout);
    assert.equal(cliJson.marks.countsByPool.gemini, 1);
    assert.equal(cliJson.marks.countsByPool["claude-gpt"], 3);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("quota-audit: per-pool personal baselines prevent Claude false alerts, catch Ultra Gemini 4x drops, and reject 4x-tainted calibration", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-baselines-"));
  try {
    const brainRoot = path.join(baseDir, "brain");
    const cfgDir = path.join(baseDir, "cfg");
    const wsDir = path.join(baseDir, "ws");
    const marksPath = path.join(baseDir, "quota-marks.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });

    const t0 = Date.parse("2026-11-28T08:00:00Z");
    const tMid = Date.parse("2026-11-28T09:00:00Z");
    const t1 = Date.parse("2026-11-28T10:00:00Z");

    // Gemini Ultra pool: $20.00 actual spend (would look 1.2x under old $6 baseline if dropped 4%, but 4.0x under $20 personal baseline!)
    // Input 6,666,667 tokens on gemini-4-neon-xhigh ($3/1M) = $20.00
    writeTranscript(
      brainRoot,
      "conv-ultra-gemini",
      [
        { step_index: 0, type: "USER_INPUT", created_at: new Date(tMid).toISOString(), content: "gemini work" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tMid).toISOString(), model: "gemini-4-neon-xhigh", input_tokens: 6666667, cache_read_tokens: 0, output_tokens: 0 }
      ],
      t1
    );
    // Claude pool: $1.80 spend (450,000 input on claude-opus-5-5-high at $4/1M) with 4% drop => $0.45/1%
    writeTranscript(
      brainRoot,
      "conv-claude-small-pool",
      [
        { step_index: 0, type: "USER_INPUT", created_at: new Date(tMid).toISOString(), content: "claude work" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tMid).toISOString(), model: "claude-opus-5-5-high", input_tokens: 450000, cache_read_tokens: 0, output_tokens: 0 }
      ],
      t1
    );

    // Persist realistic Ultra Gemini ($20/1%) and Claude ($0.45/1%) personal baselines
    setQuotaBaseline("gemini", 20.0, { statePath: marksPath, nowMs: t0 });
    setQuotaBaseline("claude-gpt", 0.45, { statePath: marksPath, nowMs: t0 });

    // Gemini drops 4% for $20 ($5/1% => 4.0x ALERT!), Claude drops 4% for $1.80 ($0.45/1% => 1.0x PASS!)
    recordQuotaMark(70, { statePath: marksPath, nowMs: t0, pool: "gemini" });
    recordQuotaMark(66, { statePath: marksPath, nowMs: t1, pool: "gemini" });
    recordQuotaMark(84, { statePath: marksPath, nowMs: t0, pool: "claude-gpt" });
    recordQuotaMark(80, { statePath: marksPath, nowMs: t1, pool: "claude-gpt" });

    const rep = auditQuota({
      brainRoots: [brainRoot],
      workspace: wsDir,
      configDir: cfgDir,
      statePath: marksPath,
      hours: 6,
      nowMs: t1,
      includeSafety: false
    });
    assert.equal(rep.poolCalibrations.gemini.status, "alert_suspected_4x");
    assert.equal(rep.poolCalibrations.gemini.impliedMultiplier, 4);
    assert.equal(rep.poolCalibrations["claude-gpt"].status, "pass_1x");
    assert.equal(rep.poolCalibrations["claude-gpt"].impliedMultiplier, 1);
    assert.equal(rep.overallStatus, "alert_4x_risk");

    // Clearing baselines + injecting a custom-agent 4x session: uncalibrated pool must STILL alert and refuse --calibrate-baseline
    clearQuotaBaseline(marksPath, { pool: "all" });
    writeTranscript(
      brainRoot,
      "conv-main-spawner",
      [
        { step_index: 0, type: "USER_INPUT", created_at: new Date(tMid).toISOString(), content: "spawn" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tMid).toISOString(), model: "gemini-4-neon-xhigh", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 10, tool_calls: [{ name: "invoke_subagent", args: { TypeName: '"cmd-verifier"', Role: '"Bad"' } }] },
        { step_index: 2, type: "GENERIC", created_at: new Date(tMid).toISOString(), content: '{"conversationId":"conv-custom-tainted"}' }
      ],
      t1
    );
    writeTranscript(
      brainRoot,
      "conv-custom-tainted",
      [
        { step_index: 0, type: "SYSTEM_MESSAGE", created_at: new Date(tMid).toISOString(), content: "[Message] sender=conv-main-spawner" },
        { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tMid).toISOString(), model: "gemini-4-neon-xhigh", input_tokens: 100000, cache_read_tokens: 0, output_tokens: 100 }
      ],
      t1
    );

    const taintedCal = auditQuota({
      brainRoots: [brainRoot],
      workspace: wsDir,
      configDir: cfgDir,
      statePath: marksPath,
      pool: "gemini",
      calibrateBaseline: true,
      hours: 6,
      nowMs: t1,
      includeSafety: false
    });
    assert.equal(taintedCal.poolCalibrations.gemini.status, "alert_suspected_4x");
    assert.equal(taintedCal.baselines.saved.gemini, undefined);
    assert.ok(
      taintedCal.baselines.actions.some((a) => a.pool === "gemini" && a.action === "rejected" && a.reason === "custom_agent_4x_detected")
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
