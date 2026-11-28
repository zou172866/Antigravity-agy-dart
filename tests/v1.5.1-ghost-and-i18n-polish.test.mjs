import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { ContextModeStore } from "../context/lib/store.js";
import { GHOST_RECALL_WINDOW_MS } from "../context/lib/store/reads.js";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(relScript, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, relScript)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: path.join(path.dirname(dbPath), "nonexistent-config.json"),
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${relScript} exited ${res.status}: ${res.stderr}`);
  assert.equal(Buffer.byteLength(res.stderr || "", "utf8"), 0, `${relScript} emitted stderr: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

test("v1.5.1-1: Tight cutoff (<45 KB) immediate paged recalls (<10m) emit raise_to_host_45k and legacy DB upgrades recall_closed", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v151-tight-"));
  const dbPath = path.join(tmpDir, "context.db");

  try {
    // 1. Seed legacy ghost_interceptions without recall_closed column -> verify idempotent upgrade
    const initStore = new ContextModeStore({ dbPath });
    initStore.open();
    initStore.db.exec(`
      DROP TABLE ghost_interceptions;
      CREATE TABLE ghost_interceptions (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        cutoff_bytes INTEGER NOT NULL DEFAULT 46080,
        blocked_ts INTEGER NOT NULL,
        recall_reads INTEGER NOT NULL DEFAULT 0,
        recall_bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, file_path)
      );
    `);
    initStore.close();

    const store = new ContextModeStore({ dbPath });
    store.open();
    const cols = store.db.prepare("PRAGMA table_info(ghost_interceptions)").all().map((c) => c.name);
    assert.ok(cols.includes("recall_closed"), "initSchema must add recall_closed to legacy ghost_interceptions");

    const sid = "tight-cutoff-sess";
    store.setCutoff(16384, sid);
    store.close();

    for (let i = 1; i <= 3; i++) {
      const fp = path.join(tmpDir, `mod_${i}.ts`);
      const body = Array.from(
        { length: 600 },
        (_, ln) => `export const val_${i}_${ln} = "segment_payload_${String(ln).padStart(4, "0")}";`
      ).join("\n");
      fs.writeFileSync(fp, body, "utf8");

      const d = runHook("hooks/pre-tool-use.mjs", { conversationId: sid, toolCall: { name: "read_file", args: { Path: fp } } }, dbPath);
      assert.equal(d.decision, "deny");
      assert.equal(
        runHook("hooks/pre-tool-use.mjs", { conversationId: sid, toolCall: { name: "read_file", args: { Path: fp, StartLine: 1, EndLine: 300 } } }, dbPath).decision,
        "allow"
      );
      assert.equal(
        runHook("hooks/pre-tool-use.mjs", { conversationId: sid, toolCall: { name: "read_file", args: { Path: fp, StartLine: 301, EndLine: 600 } } }, dbPath).decision,
        "allow"
      );
    }

    const checkStore = new ContextModeStore({ dbPath });
    const stats = checkStore.getGhostStats(sid);
    assert.equal(stats.totalBlocked, 3);
    assert.equal(stats.ghostRecalls, 3);
    assert.equal(stats.evictionEfficiency, 0);
    assert.equal(stats.recommendationCode, "raise_to_host_45k");
    assert.equal(
      stats.recommendation,
      "Cutoff may be too tight for this repo; consider switching to 45 KB (host-45k)."
    );
    checkStore.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.1-2: >10m delayed slices, PostToolUse edits (edit_file & apply_edits), ctx_resume isolation, and re-interception zeroing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v151-lifecycle-"));
  const dbPath = path.join(tmpDir, "context.db");

  try {
    const store = new ContextModeStore({ dbPath });
    const sidTime = "window-expiry-sess";
    const fileDelayed = path.join(tmpDir, "delayed.js");
    fs.writeFileSync(fileDelayed, "x".repeat(60000), "utf8");

    // 1. 10-minute recall window bound
    const t0 = 1_760_000_000_000;
    store.recordGhostInterception({
      sessionId: sidTime,
      filePath: fileDelayed,
      fileSize: 60000,
      cutoffBytes: 46080,
      nowMs: t0
    });
    assert.equal(store.hasGhostInterception(sidTime, fileDelayed, { nowMs: t0 + 5 * 60 * 1000 }), true);
    assert.equal(
      store.recordGhostRecall({ sessionId: sidTime, filePath: fileDelayed, bytesRead: 30000, nowMs: t0 + 2 * 60 * 1000 }),
      1
    );
    // Slice at +10m + 1ms (> GHOST_RECALL_WINDOW_MS) MUST NOT count
    const expiredTs = t0 + GHOST_RECALL_WINDOW_MS + 1;
    assert.equal(store.hasGhostInterception(sidTime, fileDelayed, { nowMs: expiredTs }), false);
    assert.equal(
      store.recordGhostRecall({ sessionId: sidTime, filePath: fileDelayed, bytesRead: 30000, nowMs: expiredTs }),
      0
    );
    const timeStats = store.getGhostStats(sidTime);
    assert.equal(timeStats.totalBlocked, 1);
    assert.equal(timeStats.ghostRecalls, 0, "Delayed slice after 10m window must not trigger ghostRecall");
    assert.equal(timeStats.evictionEfficiency, 1);

    // 2. Re-interception resets recall_reads, recall_bytes, and recall_closed back to 0
    store.clearGhostInterception(sidTime, fileDelayed);
    assert.equal(store.hasGhostInterception(sidTime, fileDelayed, { nowMs: t0 + 1000 }), false);
    const tReblock = t0 + 20 * 60 * 1000;
    store.recordGhostInterception({
      sessionId: sidTime,
      filePath: fileDelayed,
      fileSize: 62000,
      cutoffBytes: 46080,
      nowMs: tReblock
    });
    const reblockedRow = store.db
      .prepare("SELECT recall_reads, recall_bytes, recall_closed, file_size FROM ghost_interceptions WHERE session_id = ?")
      .get(sidTime);
    assert.deepEqual(
      {
        recall_reads: reblockedRow.recall_reads,
        recall_bytes: reblockedRow.recall_bytes,
        recall_closed: reblockedRow.recall_closed,
        file_size: reblockedRow.file_size
      },
      { recall_reads: 0, recall_bytes: 0, recall_closed: 0, file_size: 62000 }
    );
    store.close();

    // 3. End-to-end PostToolUse edit resets pending recall window while keeping totalBlocked denominator intact
    const sidEdit = "post-edit-sess";
    const fileEdit1 = path.join(tmpDir, "edit_one.js");
    const fileEdit2 = path.join(tmpDir, "edit_two.js");
    const fileUnedited = path.join(tmpDir, "unedited.js");
    const make60k = (tag) =>
      Array.from({ length: 1000 }, (_, i) => `export const ${tag}_${i} = "${"a".repeat(42)}_${i}";`).join("\n");
    fs.writeFileSync(fileEdit1, make60k("e1"), "utf8");
    fs.writeFileSync(fileEdit2, make60k("e2"), "utf8");
    fs.writeFileSync(fileUnedited, make60k("un"), "utf8");

    for (const fp of [fileEdit1, fileEdit2, fileUnedited]) {
      assert.equal(
        runHook("hooks/pre-tool-use.mjs", { conversationId: sidEdit, toolCall: { name: "read_file", args: { Path: fp } } }, dbPath).decision,
        "deny"
      );
      // Pre-edit targeted slice (~25% of file, well below 70%)
      assert.equal(
        runHook("hooks/pre-tool-use.mjs", { conversationId: sidEdit, toolCall: { name: "read_file", args: { Path: fp, StartLine: 1, EndLine: 250 } } }, dbPath).decision,
        "allow"
      );
    }

    // ctx_resume (session-wide read invalidation) must NOT close active recall window on unedited files
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sidEdit,
        cwd: tmpDir,
        toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_resume", Arguments: {} } },
        response: "Resumed session context"
      },
      dbPath
    );

    // Edit fileEdit1 via edit_file and fileEdit2 via apply_edits
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sidEdit,
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: fileEdit1 } },
        response: "Edited file"
      },
      dbPath
    );
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sidEdit,
        cwd: tmpDir,
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "agy-dart_fast",
            ToolName: "apply_edits",
            Arguments: { cwd: tmpDir, edits: [{ path: "edit_two.js" }] }
          }
        },
        response: "Applied edits to 1 file(s):\n- edit_two.js: updated"
      },
      dbPath
    );

    // Post-edit verification slices covering the rest of fileEdit1 & fileEdit2 MUST NOT count as ghostRecalls
    for (const fp of [fileEdit1, fileEdit2]) {
      assert.equal(
        runHook("hooks/pre-tool-use.mjs", { conversationId: sidEdit, toolCall: { name: "read_file", args: { Path: fp, StartLine: 251, EndLine: 650 } } }, dbPath).decision,
        "allow"
      );
      assert.equal(
        runHook("hooks/pre-tool-use.mjs", { conversationId: sidEdit, toolCall: { name: "read_file", args: { Path: fp, StartLine: 651, EndLine: 1000 } } }, dbPath).decision,
        "allow"
      );
    }

    // Meanwhile, unedited file paged to 100% right away DOES count as 1 ghostRecall out of 3 totalBlocked (67% efficiency!)
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: sidEdit, toolCall: { name: "read_file", args: { Path: fileUnedited, StartLine: 251, EndLine: 850 } } }, dbPath).decision,
      "allow"
    );

    const verifyStore = new ContextModeStore({ dbPath });
    const editStats = verifyStore.getGhostStats(sidEdit);
    assert.equal(editStats.totalBlocked, 3, "Edited files must stay in totalBlocked denominator");
    assert.equal(editStats.ghostRecalls, 1, "Only the unedited immediately-paged file should count as a ghostRecall");
    assert.equal(editStats.evictionEfficiency, 0.6667);
    assert.equal(editStats.recommendation, null);
    assert.equal(editStats.recommendationCode, null);
    verifyStore.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.1-3: Host-cap cutoffs (45 KB & 64 KB) emit use_outlines_or_exempt and never suggest switching to 64 KB", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v151-hostcap-"));
  const dbPath = path.join(tmpDir, "context.db");

  try {
    const store = new ContextModeStore({ dbPath });
    for (const [sid, cutoff] of [
      ["host-45k-sess", 46080],
      ["above-host-64k-sess", 65536]
    ]) {
      store.setCutoff(cutoff, sid);
      for (let i = 1; i <= 3; i++) {
        const fp = path.join(tmpDir, `${sid}_${i}.js`);
        store.recordGhostInterception({ sessionId: sid, filePath: fp, fileSize: 90000, cutoffBytes: cutoff });
        store.recordGhostRecall({ sessionId: sid, filePath: fp, bytesRead: 40000 });
        store.recordGhostRecall({ sessionId: sid, filePath: fp, bytesRead: 40000 });
      }
      const gs = store.getGhostStats(sid);
      assert.equal(gs.totalBlocked, 3);
      assert.equal(gs.ghostRecalls, 3);
      assert.equal(gs.evictionEfficiency, 0);
      assert.equal(gs.recommendationCode, "use_outlines_or_exempt");
      assert.equal(gs.recommendation.includes("64 KB"), false, `Must never suggest 64 KB at cutoff=${cutoff}: ${gs.recommendation}`);
      assert.equal(gs.recommendation.includes("Cutoff may be too tight"), false);
      assert.ok(gs.recommendation.includes("45 KB host cap") && gs.recommendation.includes("read_slices"));
    }
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.1-4: Sidecar index.html Chinese mode ('zh') has zero residual English across ghost advice, cutoff options, TTL sources, loop watch & bust tooltips", async () => {
  const html = readDashboardHtml();
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length >= 1, "Expected inline <script> in index.html");
  const mainScript = scriptMatches[scriptMatches.length - 1][1];

  const elements = new Map();
  const makeClassList = (el) => ({
    add: (...names) => {
      const set = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const n of names) set.add(n);
      el.className = [...set].join(" ");
    },
    remove: (...names) => {
      const set = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const n of names) set.delete(n);
      el.className = [...set].join(" ");
    },
    contains: (name) => String(el.className || "").split(/\s+/).includes(name)
  });

  const makeOption = (value, text, i18nKey = null) => {
    const attrs = i18nKey ? { "data-i18n": i18nKey } : {};
    return {
      value: String(value),
      textContent: text,
      dataset: {},
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => {
        attrs[k] = String(v);
        if (k === "data-custom-cutoff") {
          // mirror dataset
        }
      }
    };
  };

  const cutoffOptions = [
    makeOption("16384", "16 KB"),
    makeOption("32768", "32 KB"),
    makeOption("46080", "45 KB (host cap)", "cutoffHostCap"),
    makeOption("65536", "64 KB"),
    makeOption("0", "none", "cutoffNone")
  ];

  const getEl = (id) => {
    if (!elements.has(id)) {
      const el = {
        id,
        className: "",
        style: {},
        dataset: { enabled: "0" },
        title: "",
        value: id === "cutoff-select" ? "46080" : "",
        innerHTML: "",
        _text: "",
        get textContent() {
          return this._text;
        },
        set textContent(v) {
          this._text = String(v ?? "");
        },
        get innerText() {
          return this._text;
        },
        set innerText(v) {
          this._text = String(v ?? "");
        }
      };
      el.classList = makeClassList(el);
      if (id === "cutoff-select") {
        el.options = cutoffOptions;
        el.querySelector = (sel) => {
          if (sel === 'option[data-custom-cutoff="1"]') {
            return el.options.find((o) => o.dataset?.customCutoff === "1") || null;
          }
          return null;
        };
        el.appendChild = (opt) => {
          if (!el.options.includes(opt)) el.options.push(opt);
        };
        el.removeChild = (opt) => {
          const idx = el.options.indexOf(opt);
          if (idx !== -1) el.options.splice(idx, 1);
        };
      }
      elements.set(id, el);
    }
    return elements.get(id);
  };

  for (const id of [
    "kv-ghost-row",
    "kv-ghost-efficiency",
    "kv-ghost-recalls",
    "kv-ghost-recommendation",
    "cutoff-select",
    "gate-read-cutoff",
    "kv-ttl-bar-row",
    "kv-ttl-bar-label",
    "kv-ttl-bar-text",
    "kv-ttl-bar-track",
    "kv-ttl-bar-fill",
    "kv-ttl-badge",
    "kv-temp-badge",
    "kv-ctx-tokens",
    "kv-watermark-badge",
    "kv-model-badge",
    "kv-loop-badge",
    "kv-loop-row",
    "kv-turns-chart-row",
    "kv-turns-chart-label",
    "kv-turns-bars",
    "new-exempt-input"
  ]) {
    getEl(id);
  }

  let lastAlertMsg = "";
  const ctx = vm.createContext({
    window: { location: { search: "" }, addEventListener: () => {} },
    document: {
      title: "",
      documentElement: { lang: "en" },
      getElementById: (id) => getEl(id),
      createElement: (tag) => {
        if (tag === "option") return makeOption("", "");
        return { dataset: {}, style: {}, setAttribute: () => {} };
      },
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel === "[data-i18n]") {
          return cutoffOptions.filter((o) => o.getAttribute("data-i18n"));
        }
        return [];
      },
      addEventListener: () => {}
    },
    localStorage: { getItem: () => "en", setItem: () => {} },
    navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
    URLSearchParams,
    Headers,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    alert: (msg) => {
      lastAlertMsg = String(msg);
    },
    setInterval: () => ({ unref: () => {} }),
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    console
  });

  vm.runInContext(mainScript, ctx);

  const nowIso = new Date(Date.now() - 90 * 1000).toISOString();
  const kvPayload = {
    transcriptFound: true,
    turnsWithUsage: 5,
    weightedHitRate: 0.88,
    currentContextTokens: 145000,
    bustCount: 1,
    wastedTokensTotal: 24000,
    watermark: "warn",
    warnTokens: 130000,
    criticalTokens: 160000,
    windowSource: "transcript",
    cacheTemperature: "warm",
    currentModel: "Gemini 4 Carbon (High)",
    modelProfile: { id: "gemini-4-512k", windowTokens: 512000, windowSource: "transcript" },
    cacheTtlSec: 900,
    idleSeconds: 90,
    ttlRemainingSec: 810,
    ttlStatus: "warm",
    ttlSource: "empirical",
    lastPlannerAt: nowIso,
    serverNowMs: Date.now(),
    maxWarmHitGapSec: 780,
    ttlCalibration: {
      origin: "history",
      profileId: "gemini-4-512k",
      warmSamples: 5,
      coldSamples: 1,
      maxWarmGapSec: 780,
      minColdMissGapSec: 960,
      estimatedTtlSec: 900,
      confidence: "high"
    },
    loopWatch: {
      status: "warn",
      reason: "repeat_loop",
      editFailOscillations: 0,
      maxRepeatCount: 4,
      repeatRate: 0.5,
      topRepeatedCall: "read_file"
    },
    recentTurns: [
      {
        turn: 2,
        hitRate: 0.12,
        ctxTokens: 145000,
        deltaTokens: 12000,
        isBust: true,
        bustCause: "ttl_idle_expiry",
        triggerTool: "read_file"
      }
    ]
  };

  // Render in English first, then switch to Chinese to test live re-rendering across all components
  vm.runInContext(
    `
    updateCutoffDropdown({ cutoffBytes: 50000, conversationCutoffBytes: 50000, noiseMaxReadBytes: 0, reviewMaxReadBytes: 131072 });
    renderGhostEfficiency({
      totalBlocked: 4,
      ghostRecalls: 2,
      evictionEfficiency: 0.5,
      currentCutoff: 46080,
      recommendationCode: "use_outlines_or_exempt",
      recommendation: "Already at 45 KB host cap; multi-slice reads on >45 KB files are normal (use read_slices outlines or exemptPaths if needed)."
    });
    renderKvCacheCard(${JSON.stringify(kvPayload)});
    setLanguage('zh');
    `,
    ctx
  );

  // 1. Ghost recommendation & gentle non-warn style at host cap
  const ghostRecText = getEl("kv-ghost-recommendation").innerText;
  assert.ok(ghostRecText.includes("已对齐 45 KB 宿主单次读取上限"), `Unexpected zh ghost advice: ${ghostRecText}`);
  assert.equal(ghostRecText.includes("Cutoff may be too tight"), false);
  assert.equal(ghostRecText.includes("Already at 45 KB host cap"), false);
  assert.equal(getEl("kv-ghost-recommendation").classList.contains("val-warn"), false, "Host-cap advice must be gentle muted-note, not val-warn");
  assert.equal(getEl("kv-ghost-efficiency").className, "val-ok");

  // Also check tight-cutoff (<45 KB) advice in Chinese uses val-warn
  vm.runInContext(
    `renderGhostEfficiency({
      totalBlocked: 3,
      ghostRecalls: 3,
      evictionEfficiency: 0,
      currentCutoff: 16384,
      recommendationCode: "raise_to_host_45k",
      recommendation: "Cutoff may be too tight for this repo; consider switching to 45 KB (host-45k)."
    });`,
    ctx
  );
  assert.ok(getEl("kv-ghost-recommendation").innerText.includes("建议切换至 45 KB（宿主上限）"));
  assert.equal(getEl("kv-ghost-recommendation").innerText.includes("Cutoff may be too tight"), false);
  assert.equal(getEl("kv-ghost-recommendation").classList.contains("val-warn"), true);

  // 2. Cutoff dropdown options (45 KB host cap + custom cutoff + off tier)
  const hostOpt = cutoffOptions.find((o) => o.value === "46080");
  const noneOpt = cutoffOptions.find((o) => o.value === "0");
  const customOpt = cutoffOptions.find((o) => o.dataset?.customCutoff === "1");
  assert.equal(hostOpt.textContent, "45 KB（宿主上限）");
  assert.equal(noneOpt.textContent, "不限制");
  assert.ok(customOpt && customOpt.textContent.includes("（自定义）") && !customOpt.textContent.includes("(custom)"), `Unexpected custom cutoff: ${customOpt?.textContent}`);
  assert.ok(getEl("gate-read-cutoff").innerText.includes("关闭") && !getEl("gate-read-cutoff").innerText.includes(" off"));

  // 3. TTL bar label & badge tooltips (empirical / transcript / history)
  const ttlBarLabel = getEl("kv-ttl-bar-label").textContent;
  assert.equal(ttlBarLabel, "提示词缓存 TTL（实证校准）");
  assert.equal(ttlBarLabel.includes("empirical"), false);

  const ttlTip = getEl("kv-ttl-badge").title;
  assert.ok(ttlTip.includes("来源：实证校准") && ttlTip.includes("实证校准（历史校准）"), `Unexpected ttlTip: ${ttlTip}`);
  assert.equal(/empirical|history|profile|explicit/.test(ttlTip), false, `Residual English enum in ttlTip: ${ttlTip}`);

  const ctxTip = getEl("kv-ctx-tokens").title;
  const wmTip = getEl("kv-watermark-badge").title;
  const modelTip = getEl("kv-model-badge").title;
  for (const tip of [ctxTip, wmTip, modelTip]) {
    assert.ok(tip.includes("会话轨迹"), `Expected localized transcript source in tooltip: ${tip}`);
    assert.equal(tip.includes("transcript"), false, `Residual 'transcript' in tooltip: ${tip}`);
  }

  // 4. Convergence watch status (预警 / 严重) & turn bar bust cause tooltip (TTL过期)
  const loopTextWarn = getEl("kv-loop-row").innerText;
  assert.ok(loopTextWarn.includes("收敛监控（预警）"), `Unexpected loopRow warn text: ${loopTextWarn}`);
  assert.equal(loopTextWarn.includes("WARN"), false);

  const critPayload = { ...kvPayload, loopWatch: { ...kvPayload.loopWatch, status: "critical" } };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(critPayload)});`, ctx);
  const loopTextCrit = getEl("kv-loop-row").innerText;
  assert.ok(loopTextCrit.includes("收敛监控（严重）"), `Unexpected loopRow critical text: ${loopTextCrit}`);
  assert.equal(loopTextCrit.includes("CRITICAL"), false);

  const turnsHtml = getEl("kv-turns-bars").innerHTML;
  assert.ok(turnsHtml.includes("失效：TTL过期"), `Expected localized bust cause in turn bar tooltip: ${turnsHtml}`);
  assert.equal(turnsHtml.includes("ttl_idle_expiry"), false);

  // 5. Invalid extension alert in Chinese
  getEl("new-exempt-input").value = "bad//ext";
  await vm.runInContext("addExemption();", ctx);
  assert.ok(lastAlertMsg.includes("扩展名格式无效") && !lastAlertMsg.includes("Invalid extension"), `Unexpected zh alert: ${lastAlertMsg}`);
});
