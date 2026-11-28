import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContextModeStore, DEFAULT_CUTOFF_BYTES, FILE_CATEGORIES } from "../context/lib/store.js";
import { getConfigSnapshot, resetConfigCache } from "../context/lib/config.js";
import { createTools } from "../context/lib/tools.js";
import {
  DEFAULT_MAX_READ_BYTES,
  HOST_READ_MAX_LINES,
  buildConfirmScope,
  classifyFileTier,
  getMaxLineRange,
  inspectCommand,
  isSubagentReadPayload,
  matchesExemptPath,
  parseLineArg
} from "../hooks/pre-tool-use.mjs";
import { isSubagentPayload } from "../hooks/session-start.mjs";
import { applyFilterRule, matchFilterRule } from "../hooks/filter-rules.mjs";
import { createStandaloneServer } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, scriptRel);
  const env = {
    ...process.env,
    AGY_DART_DB_PATH: dbPath,
    AGY_DART_DISABLE_COMPILE_CACHE: "1",
    AGY_DART_CONFIG_PATH: extraEnv.AGY_DART_CONFIG_PATH || path.join(path.dirname(dbPath), "missing-cfg.json"),
    ...extraEnv
  };
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  delete env.ANTIGRAVITY_PARENT_CONVERSATION_ID;
  delete env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
  delete env.ANTIGRAVITY_SUBAGENT;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env
  });
  assert.equal(res.status, 0, `${scriptRel} exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

function createFramedMcpClient(scriptPath, extraEnv = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1", ...extraEnv }
  });
  let buf = Buffer.alloc(0);
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderr += d;
  });

  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const idxCrLf = buf.indexOf("\r\n\r\n");
      const idxLf = buf.indexOf("\n\n");
      let sepIdx = -1;
      let sepLen = 0;
      if (idxCrLf !== -1 && (idxLf === -1 || idxCrLf < idxLf)) {
        sepIdx = idxCrLf;
        sepLen = 4;
      } else if (idxLf !== -1) {
        sepIdx = idxLf;
        sepLen = 2;
      }
      if (sepIdx === -1) break;
      const headerStr = buf.subarray(0, sepIdx).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(headerStr);
      if (!m) break;
      const bodyLen = Number(m[1]);
      if (buf.length < sepIdx + sepLen + bodyLen) break;
      const body = buf.subarray(sepIdx + sepLen, sepIdx + sepLen + bodyLen).toString("utf8");
      buf = buf.subarray(sepIdx + sepLen + bodyLen);
      const msg = JSON.parse(body);
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const send = (obj) => {
    const json = JSON.stringify(obj);
    const frame = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    child.stdin.write(frame);
  };

  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP request timeout: ${method}`)), 8000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params = {}) {
      send({ jsonrpc: "2.0", method, params });
    },
    getStderr() {
      return stderr;
    },
    async close() {
      try {
        child.stdin.end();
      } catch {}
      await new Promise((r) => {
        child.once("close", r);
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
          r();
        }, 500);
      });
    }
  };
}

test("v1.3-1: 4-tier read guard matrix, minified head probe, >2MB slice blind-spot fix, wide-prose split & readGuardMode", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v13-tiers-"));
  const dbPath = path.join(tmpDir, "context.db");

  try {
    assert.equal(DEFAULT_MAX_READ_BYTES, 46080);
    assert.equal(DEFAULT_CUTOFF_BYTES, 46080);
    assert.equal(getMaxLineRange(46080), HOST_READ_MAX_LINES);
    assert.equal(getMaxLineRange(65536), HOST_READ_MAX_LINES);
    assert.equal(getMaxLineRange(16384), 410);

    // Tier 1: high-noise log (25 KB), lockfile (25 KB), minified bundle (25 KB), un-suffixed minified JSON (25 KB single line)
    const bigLog = path.join(tmpDir, "server.log");
    const lockJson = path.join(tmpDir, "package-lock.json");
    const minJs = path.join(tmpDir, "app.min.js");
    const unSuffixedMinJson = path.join(tmpDir, "dense_payload.json");
    fs.writeFileSync(bigLog, Array.from({ length: 650 }, (_, i) => `INFO line ${i} ${"x".repeat(30)}`).join("\n"), "utf8");
    fs.writeFileSync(lockJson, Array.from({ length: 650 }, (_, i) => `  "pkg-${i}": "1.0.${i}", ${" ".repeat(18)}`).join("\n"), "utf8");
    fs.writeFileSync(minJs, `var m="${"a".repeat(25000)}";\n`, "utf8");
    fs.writeFileSync(unSuffixedMinJson, `{"blob":"${"z".repeat(25000)}"}\n`, "utf8");

    assert.equal(classifyFileTier(unSuffixedMinJson, ".json", 25020, 16384).tier, "noise");
    assert.equal(classifyFileTier(unSuffixedMinJson, ".json", 25020, 16384).isMinifiedContent, true);

    // Primary agent hitting Tier 1 -> hard deny on BOTH strike 1 AND strike 2
    for (const f of [bigLog, lockJson, minJs, unSuffixedMinJson]) {
      const s1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t1-pri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: f } } }, dbPath);
      const s2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t1-pri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: f } } }, dbPath);
      assert.equal(s1.decision, "deny", `Tier 1 ${path.basename(f)} strike 1 must deny`);
      assert.equal(s2.decision, "deny", `Tier 1 ${path.basename(f)} strike 2 must stay hard-deny for primary agent`);
    }

    // Tier 2: normal source <= 45 KiB (35 KB) allowed immediately; > 45 KiB (60 KB) is 2-strike soft guard with exact line count
    const src35k = path.join(tmpDir, "medium.ts");
    const src60k = path.join(tmpDir, "large_module.ts");
    fs.writeFileSync(src35k, Array.from({ length: 500 }, (_, i) => `export const m_${i} = "${"a".repeat(45)}";`).join("\n"), "utf8");
    fs.writeFileSync(src60k, Array.from({ length: 900 }, (_, i) => `export const row_${i} = "${"b".repeat(45)}";`).join("\n"), "utf8");

    const r35 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t2-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: src35k } } }, dbPath);
    assert.equal(r35.decision, "allow", "35 KB source file (<=45 KiB) must be allowed on 1st call");

    const r60s1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t2-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: src60k } } }, dbPath);
    assert.equal(r60s1.decision, "deny", "60 KB source file (>45 KiB) must soft-deny on strike 1");
    assert.match(r60s1.reason, /900 lines/, `Expected exact line count in soft-deny reason: ${r60s1.reason}`);
    assert.match(r60s1.reason, /once more to proceed/i, `Expected 2-strike retry guidance: ${r60s1.reason}`);

    const r60s2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t2-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: src60k } } }, dbPath);
    assert.equal(r60s2.decision, "allow", "60 KB source file strike 2 must allow");

    // Tier 3: .patch/.diff <= 128 KB (90 KB) allowed immediately; > 128 KB (150 KB) is 2-strike soft guard with Diff Outline hint
    const patch90k = path.join(tmpDir, "pr-42.patch");
    const diff150k = path.join(tmpDir, "pr-99.diff");
    fs.writeFileSync(patch90k, "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n" + "+const x = 'patch_line_padding_01234567890123456789';\n".repeat(1700), "utf8");
    fs.writeFileSync(diff150k, "diff --git a/b.ts b/b.ts\n@@ -1,2 +1,2 @@\n" + "+const y = 'large_diff_padding_01234567890123456789';\n".repeat(2900), "utf8");

    const rp90 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: patch90k } } }, dbPath);
    assert.equal(rp90.decision, "allow", "90 KB .patch (<=128 KB) must be allowed immediately");

    const rd150s1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: diff150k } } }, dbPath);
    assert.equal(rd150s1.decision, "deny", "150 KB .diff (>128 KB) must soft-deny on strike 1");
    assert.match(rd150s1.reason, /Outline changed files & hunks/i);
    const rd150s2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "t3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: diff150k } } }, dbPath);
    assert.equal(rd150s2.decision, "allow", "150 KB .diff strike 2 must allow");

    // Multi-line wide prose (<= 512 B/line, > maxPagedSliceBytes under 16 KB cutoff) must NOT be mislabeled as "minified"
    const wideProse = path.join(tmpDir, "wide_cjk.md");
    fs.writeFileSync(
      wideProse,
      Array.from({ length: 350 }, (_, i) => `第${i + 1}段：${"这是一段正常的中文技术文档长段落说明内容，绝不是压缩的单行代码。".repeat(3)}`).join("\n"),
      "utf8"
    );
    const rWideSlice = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "wide-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: wideProse, StartLine: 1, EndLine: 250 } } },
      dbPath,
      { AGY_DART_MAX_READ_BYTES: "16384" }
    );
    assert.equal(rWideSlice.decision, "deny");
    assert.ok(!rWideSlice.reason.includes("minified"), `Wide multi-line prose must NOT be mislabeled as minified: ${rWideSlice.reason}`);
    assert.match(rWideSlice.reason, /smaller StartLine\/EndLine window/i);

    // >2 MB minified blind-spot fix: line 1 banner + line 2 is 2.3 MB single line -> StartLine=2, EndLine=5 MUST deny
    const hugeMin = path.join(tmpDir, "huge_banner_min.js");
    fs.writeFileSync(hugeMin, `/* banner */\nvar payload="${"q".repeat(2300000)}";\n`, "utf8");
    const rHugeSlice = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "huge-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: hugeMin, StartLine: 2, EndLine: 5 } } },
      dbPath
    );
    assert.equal(rHugeSlice.decision, "deny", ">2 MB file with StartLine=2 minified content must NOT bypass slice guard");
    assert.match(rHugeSlice.reason, /minified/i);

    // readGuardMode=strict turns Tier 2 into hard-deny; readGuardMode=off disables read size guard while keeping readDedup & cat guard
    const rStrict1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "strict-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: src60k } } }, dbPath, { AGY_DART_READ_GUARD_MODE: "strict" });
    const rStrict2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "strict-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: src60k } } }, dbPath, { AGY_DART_READ_GUARD_MODE: "strict" });
    assert.equal(rStrict1.decision, "deny");
    assert.equal(rStrict2.decision, "deny", "readGuardMode=strict must hard-deny without 2-strike bypass");

    const rOff1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "off-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigLog } } }, dbPath, { AGY_DART_READ_GUARD_MODE: "off" });
    const rOff2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "off-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigLog } } }, dbPath, { AGY_DART_READ_GUARD_MODE: "off" });
    const rOffCat = runHook("hooks/pre-tool-use.mjs", { conversationId: "off-c", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: `cat "${bigLog}"` } } }, dbPath, { AGY_DART_READ_GUARD_MODE: "off" });
    assert.equal(rOff1.decision, "allow", "readGuardMode=off allows read_file size");
    assert.equal(rOff2.decision, "deny", "readGuardMode=off must KEEP readDedup active");
    assert.match(rOff2.reason, /read-dedup/);
    assert.equal(rOffCat.decision, "deny", "readGuardMode=off must KEEP run_command cat guard active");

    // parseLineArg strictness: reject scientific notation, hex, floats, trailing garbage, booleans (blocks StartLine="1e5" EndLine="2e5" Tier 1 bypass)
    for (const badArg of ["1e5", "2e5", "46080px", "12.9", "0x10", 12.5, true]) {
      assert.equal(parseLineArg(badArg), null, `parseLineArg must reject non-integer ${JSON.stringify(badArg)}`);
    }
    assert.equal(parseLineArg("100"), 100);
    assert.equal(parseLineArg("-5"), -5);
    const rSciLog = runHook("hooks/pre-tool-use.mjs", { conversationId: "sci-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigLog, StartLine: "1e5", EndLine: "2e5" } } }, dbPath);
    assert.equal(rSciLog.decision, "deny", "Scientific notation StartLine/EndLine must NOT bypass Tier 1 log guard");

    // Multi-window minified probe: >4 KB license banner + 30 KB minified body classifies as Tier 1 noise & denies;
    // normal 35 KB source file with ONE 4.5 KB embedded fixture in middle stays Tier 2 source & allows.
    const vendorJs = path.join(tmpDir, "vendor.js");
    const banner = Array.from({ length: 90 }, (_, i) => `// License line ${i}: ${"copyright ".repeat(5)}`).join("\n") + "\n";
    fs.writeFileSync(vendorJs, banner + `var bundle="${"m".repeat(30000)}";\n`, "utf8");
    const normalFixtureTs = path.join(tmpDir, "normal_fixture.ts");
    const normalBlock = Array.from({ length: 220 }, (_, i) => `export const line_${i} = "normal source code line ${i}";`).join("\n");
    fs.writeFileSync(normalFixtureTs, `${normalBlock}\nexport const ICON = "${"A".repeat(4500)}";\n${normalBlock}\n`, "utf8");
    assert.equal(classifyFileTier(vendorJs, ".js", fs.statSync(vendorJs).size, 16384).tier, "noise");
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: "ven-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: vendorJs } } }, dbPath).decision, "deny");
    assert.equal(classifyFileTier(normalFixtureTs, ".ts", fs.statSync(normalFixtureTs).size, 16384).tier, "source");
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: "norm-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: normalFixtureTs } } }, dbPath).decision, "allow");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3-2: ByteOffset & open-ended StartLine continuations, pre-1a read cache priority (no 3-strike trap), and narrow-slice token cleanup", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v13-cont-"));
  const dbPath = path.join(tmpDir, "context.db");

  try {
    const bigSrc = path.join(tmpDir, "big_service.ts");
    const lines = Array.from({ length: 1400 }, (_, i) => `export const svc_${i + 1} = "${"v".repeat(52)}";`);
    fs.writeFileSync(bigSrc, lines.join("\n") + "\n", "utf8"); // ~100 KB, 1400 lines

    // 1. Strike 1 -> Strike 2 allow -> records file_reads (lines 1..effectiveEndLine)
    const s1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "cont-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    const s2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "cont-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    assert.equal(s1.decision, "deny");
    assert.equal(s2.decision, "allow");

    // 2. Host ByteOffset (PascalCase & snake_case) continuation -> allowed!
    const contB1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "cont-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, ByteOffset: 46080 } } }, dbPath);
    const contB2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "cont-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, byte_offset: 92160 } } }, dbPath);
    assert.equal(contB1.decision, "allow", "ByteOffset continuation must be allowed");
    assert.equal(contB2.decision, "allow", "snake_case byte_offset continuation must be allowed");

    // 3. Open-ended StartLine continuation (omitting EndLine) after prior read -> allowed!
    const contOpen = runHook("hooks/pre-tool-use.mjs", { conversationId: "cont-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, StartLine: 801 } } }, dbPath);
    assert.equal(contOpen.decision, "allow", "Open-ended StartLine=801 continuation after prior read must be allowed");

    // 4. Cold StartLine=2 (no EndLine) and ByteOffset=1 (even after a narrow slice!) on Tier 1 .log -> MUST deny
    const coldLog = path.join(tmpDir, "cold.log");
    fs.writeFileSync(coldLog, Array.from({ length: 1200 }, (_, i) => `LOG ${i} ${"m".repeat(45)}`).join("\n"), "utf8");
    const coldOpen = runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: coldLog, StartLine: 2 } } }, dbPath);
    const coldByte1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: coldLog, ByteOffset: 1 } } }, dbPath);
    assert.equal(coldOpen.decision, "deny", "Cold StartLine=2 without EndLine on large .log must deny");
    assert.equal(coldByte1.decision, "deny", "Cold ByteOffset=1 on large .log must NOT bypass Tier 1 guard");
    // Even after reading a compliant slice (lines 1-50), ByteOffset=1 on Tier 1 .log must STILL deny!
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: coldLog, StartLine: 1, EndLine: 50 } } }, dbPath).decision, "allow");
    const postSliceByte1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: coldLog, ByteOffset: 1 } } }, dbPath);
    assert.equal(postSliceByte1.decision, "deny", "ByteOffset=1 on Tier 1 .log after narrow slice must STILL deny");

    // 5. Anti-3-Strike Trap (readDedup): Call 3 unchanged full read -> read-dedup deny directly; Call 4 retry -> allow (NEVER 3 denies!)
    const big60k = path.join(tmpDir, "dedup_60k.ts");
    const dLines = Array.from({ length: 750 }, (_, i) => `export const d_${i + 1} = "${"k".repeat(60)}";`);
    fs.writeFileSync(big60k, dLines.join("\n") + "\n", "utf8"); // ~60 KB, < 800 lines
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: "anti3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath).decision, "deny");
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: "anti3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath).decision, "allow");
    const call3 = runHook("hooks/pre-tool-use.mjs", { conversationId: "anti3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath);
    assert.equal(call3.decision, "deny");
    assert.match(call3.reason, /read-dedup/, `Call 3 must hit read-dedup directly, got: ${call3.reason}`);
    const call4 = runHook("hooks/pre-tool-use.mjs", { conversationId: "anti3-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath);
    assert.equal(call4.decision, "allow", "Call 4 armed dedup bypass must skip large-file strike 1 (no 3-strike trap)");

    // 6. Anti-3-Strike Trap (diffRead): edit 1 line -> Call 5 returns compact diff-read directly -> Call 6 retry allows verbatim
    const dLinesMod = [...dLines];
    dLinesMod[10] = 'export const d_11 = "MODIFIED_SINGLE_LINE_MARKER";';
    fs.writeFileSync(big60k, dLinesMod.join("\n") + "\n", "utf8");
    const futureSec = Math.floor(Date.now() / 1000) + 10;
    fs.utimesSync(big60k, futureSec, futureSec);
    // Re-anchor with diffRead=1 first on a fresh conv
    const diffConv = "anti3-diff";
    fs.writeFileSync(big60k, dLines.join("\n") + "\n", "utf8");
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: diffConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath, { AGY_DART_ENABLE_DIFF_READ: "1" }).decision, "deny");
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: diffConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath, { AGY_DART_ENABLE_DIFF_READ: "1" }).decision, "allow");
    fs.writeFileSync(big60k, dLinesMod.join("\n") + "\n", "utf8");
    fs.utimesSync(big60k, futureSec + 5, futureSec + 5);
    const diffHit = runHook("hooks/pre-tool-use.mjs", { conversationId: diffConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath, { AGY_DART_ENABLE_DIFF_READ: "1" });
    assert.equal(diffHit.decision, "deny");
    assert.match(diffHit.reason, /diff-read/, `Modified 60 KB file must hit diff-read directly: ${diffHit.reason}`);
    const diffRetry = runHook("hooks/pre-tool-use.mjs", { conversationId: diffConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: big60k } } }, dbPath, { AGY_DART_ENABLE_DIFF_READ: "1" });
    assert.equal(diffRetry.decision, "allow", "Retry after diff-read must allow verbatim without large-file re-block");

    // 7. Dirty token cleanup: Strike 1 -> agent obeys with narrow slice -> clears :full token -> later full read re-guards
    const cleanConv = "clean-token-c";
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: cleanConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath).decision, "deny");
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: cleanConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, StartLine: 1, EndLine: 100 } } }, dbPath).decision, "allow");
    const laterFull = runHook("hooks/pre-tool-use.mjs", { conversationId: cleanConv, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    assert.equal(laterFull.decision, "deny", "Compliant narrow slice must clear stale :full confirm token");

    // 8. Cold ByteOffset & post-narrow-slice continuation hardening (no bypass in soft OR strict mode!)
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-bo-strict", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, ByteOffset: 4096 } } }, dbPath, { AGY_DART_READ_GUARD_MODE: "strict" }).decision,
      "deny",
      "Cold ByteOffset=4096 must NOT bypass strict mode"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-bo-soft", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, ByteOffset: 4096 } } }, dbPath).decision,
      "deny",
      "Cold ByteOffset=4096 must NOT bypass soft mode Strike 1"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "cold-bo-45k", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, ByteOffset: 46080 } } }, dbPath).decision,
      "deny",
      "Cold ByteOffset=46080 without prior read/confirm must NOT bypass Strike 1"
    );
    for (const [tag, nextArgs, extraEnv] of [
      ["strict-open-2", { Path: bigSrc, StartLine: 2 }, { AGY_DART_READ_GUARD_MODE: "strict" }],
      ["soft-open-2", { Path: bigSrc, StartLine: 2 }, {}],
      ["soft-open-51", { Path: bigSrc, StartLine: 51 }, {}],
      ["soft-bo-1", { Path: bigSrc, ByteOffset: 1 }, {}],
      ["soft-bo-46080", { Path: bigSrc, ByteOffset: 46080 }, {}]
    ]) {
      const cid = `post-narrow-${tag}`;
      assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: cid, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc, StartLine: 1, EndLine: 50 } } }, dbPath, extraEnv).decision, "allow");
      assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: cid, cwd: tmpDir, toolCall: { name: "read_file", args: nextArgs } }, dbPath, extraEnv).decision, "deny", `Narrow 1..50 slice must NOT unlock ${tag}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3-3: 5-branch confirm isolation, TTL expiry, pruneByTtl, subagent deadlock fix, detector sync & sensitive_read_confirm TTL", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v13-iso-"));
  const dbPath = path.join(tmpDir, "context.db");

  try {
    // 1. Subagent detector alignment & NO false positive on Planning Mode ("planner" / "guide")
    for (const nonSub of [{ role: "planner" }, { role: "plan" }, { role: "guide" }, { role: "coordinator" }]) {
      assert.equal(isSubagentReadPayload(nonSub, {}), false, `pre-tool-use must NOT flag ${JSON.stringify(nonSub)} as subagent`);
      assert.equal(isSubagentPayload(nonSub, {}), false, `session-start must NOT flag ${JSON.stringify(nonSub)} as subagent`);
    }
    for (const yesSub of [
      { role: "reviewer" },
      { agentType: "code-review" },
      { agent_role: "explorer" },
      { role: "auditor" },
      { role: "investigator" },
      { subagentId: "sub-42" },
      { metadata: { isSubagent: true } },
      { metadata: { subagent_id: "s-9" } }
    ]) {
      assert.equal(isSubagentReadPayload(yesSub, {}), true, `pre-tool-use must detect ${JSON.stringify(yesSub)}`);
      assert.equal(isSubagentPayload(yesSub, {}), true, `session-start must detect ${JSON.stringify(yesSub)}`);
    }

    // 2. Unit-verify all 5 branches of buildConfirmScope
    const b1 = buildConfirmScope({ directConvId: "c1", sessionId: "c1", hasExplicitConvId: true, subagentSharesParentContext: false, subagentId: "", agentName: "antigravity", cwd: tmpDir });
    const b2 = buildConfirmScope({ directConvId: "c1", sessionId: "c1", hasExplicitConvId: true, subagentSharesParentContext: true, subagentId: "rev-A", agentName: "reviewer", cwd: tmpDir });
    const b3 = buildConfirmScope({ directConvId: "c1", sessionId: "c1", hasExplicitConvId: true, subagentSharesParentContext: true, subagentId: "", agentName: "reviewer", cwd: tmpDir });
    const b4 = buildConfirmScope({ directConvId: "default", sessionId: "p1", hasExplicitConvId: false, subagentSharesParentContext: false, subagentId: "rev-B", agentName: "reviewer", cwd: tmpDir });
    const b5 = buildConfirmScope({ directConvId: "default", sessionId: "default", hasExplicitConvId: false, subagentSharesParentContext: false, subagentId: "", agentName: "antigravity", cwd: tmpDir });
    assert.equal(b1.scopeKey, "conv:c1");
    assert.equal(b1.ttlMs, 120000);
    assert.ok(b2.scopeKey.startsWith("sub:c1:") && b2.scopeKey !== b3.scopeKey);
    assert.equal(b2.ttlMs, 120000);
    assert.equal(b3.ttlMs, 30000);
    assert.equal(b3.consumeOnAllow, false);
    assert.ok(b4.scopeKey.startsWith("sub:p1:"));
    assert.equal(b4.consumeOnAllow, true);
    assert.ok(b5.scopeKey.startsWith("anon:"));
    assert.equal(b5.consumeOnAllow, true);

    // 3. Parent vs sibling subagent isolation on 60 KB source file + TTL expiry
    const bigSrc = path.join(tmpDir, "iso_60k.ts");
    fs.writeFileSync(bigSrc, Array.from({ length: 900 }, (_, i) => `export const iso_${i} = "${"p".repeat(48)}";`).join("\n"), "utf8");

    // Parent strike 1 arms conv:p-main, must NOT unlock subagent A or B sharing p-main
    assert.equal(runHook("hooks/pre-tool-use.mjs", { conversationId: "p-main", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath).decision, "deny");
    const subA1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "p-main", subagent: true, subagentId: "sub-A", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    assert.equal(subA1.decision, "deny", "Parent confirm must NOT leak to child subagent A");
    const subB1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "p-main", subagent: true, subagentId: "sub-B", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    assert.equal(subB1.decision, "deny", "Subagent A confirm must NOT leak to sibling subagent B");
    const subA2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "p-main", subagent: true, subagentId: "sub-A", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    assert.equal(subA2.decision, "allow", "Subagent A strike 2 must allow");

    // Backdate conv:p-main confirm key past 120s TTL -> must expire and re-deny!
    const store = new ContextModeStore({ dbPath });
    try {
      store.open();
      const staleTs = Date.now() - 180 * 1000;
      const rows = store.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'large_read_confirm:conv:p-main:%'").all();
      assert.ok(rows.length >= 1, "Expected large_read_confirm meta entry for conv:p-main");
      for (const r of rows) {
        const parsed = JSON.parse(r.value);
        parsed.ts = staleTs;
        store.setMeta(r.key, JSON.stringify(parsed));
      }
      // Also test getTimedMeta TTL lazy eviction + pruneByTtl 10-minute cleanup (including corrupted ts=0)
      store.setMeta("large_read_confirm:corrupt:1", "plain_legacy_no_ts");
      store.setMeta("large_read_confirm:old:1", JSON.stringify({ v: "1", ts: Date.now() - 15 * 60 * 1000 }));
      store.setMeta("sensitive_read_confirm:old:1", JSON.stringify({ v: "1", ts: Date.now() - 15 * 60 * 1000 }));
      store.setTimedMeta("large_read_confirm:fresh:1", "ok");
      store.pruneByTtl({ maxAgeDays: 14, vacuum: false });
      assert.equal(store.getMeta("large_read_confirm:corrupt:1", null), null, "pruneByTtl must evict corrupted large_read_confirm");
      assert.equal(store.getMeta("large_read_confirm:old:1", null), null, "pruneByTtl must evict >10m large_read_confirm");
      assert.equal(store.getMeta("sensitive_read_confirm:old:1", null), null, "pruneByTtl must evict >10m sensitive_read_confirm");
      assert.equal(store.getTimedMeta("large_read_confirm:fresh:1", null, 60000), "ok");
    } finally {
      store.close();
    }
    const afterExpiry = runHook("hooks/pre-tool-use.mjs", { conversationId: "p-main", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigSrc } } }, dbPath);
    assert.equal(afterExpiry.decision, "deny", "Expired large_read_confirm TTL (>120s) must re-trigger Strike 1");

    // 4. Subagent deadlock elimination (#1311): subagent reading 25 KB .log (Tier 1 noise) gets native-slice-first 2-strike!
    const subLog = path.join(tmpDir, "ci_output.log");
    fs.writeFileSync(subLog, Array.from({ length: 650 }, (_, i) => `WARN step ${i} ${"x".repeat(32)}`).join("\n"), "utf8");
    const subLog1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "sub-log-c", role: "reviewer", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: subLog } } }, dbPath);
    assert.equal(subLog1.decision, "deny");
    assert.match(subLog1.reason, /StartLine\/EndLine/i, "Subagent guidance must prioritize native StartLine/EndLine");
    assert.match(subLog1.reason, /once more to proceed/i, "Subagent must have 2-strike escape hatch even on Tier 1 noise");
    const subLog2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "sub-log-c", role: "reviewer", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: subLog } } }, dbPath);
    assert.equal(subLog2.decision, "allow", "Subagent strike 2 on Tier 1 noise must allow (no deadlock)");

    // 5. sensitive_read_confirm TTL & parent/subagent isolation fix
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "API_KEY=secret_test_value\n", "utf8");
    const sensP1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "sens-iso", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: envFile } } }, dbPath, { AGY_DART_SENSITIVE_FILE_GUARD: "warn" });
    assert.equal(sensP1.decision, "deny");
    // Child subagent sharing conversationId "sens-iso" MUST NOT inherit parent's sensitive warn confirmation
    const sensSub1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "sens-iso", subagent: true, subagentId: "child-1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: envFile } } }, dbPath, { AGY_DART_SENSITIVE_FILE_GUARD: "warn" });
    assert.equal(sensSub1.decision, "deny", "Parent sensitive_read_confirm must NOT leak to child subagent");
    // Backdate parent's sensitive_read_confirm past 120s -> parent must be warned again
    const s2 = new ContextModeStore({ dbPath });
    try {
      s2.open();
      const sRows = s2.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'sensitive_read_confirm:conv:sens-iso:%'").all();
      assert.ok(sRows.length >= 1);
      for (const r of sRows) {
        const p = JSON.parse(r.value);
        p.ts = Date.now() - 180 * 1000;
        s2.setMeta(r.key, JSON.stringify(p));
      }
    } finally {
      s2.close();
    }
    const sensExpired = runHook("hooks/pre-tool-use.mjs", { conversationId: "sens-iso", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: envFile } } }, dbPath, { AGY_DART_SENSITIVE_FILE_GUARD: "warn" });
    assert.equal(sensExpired.decision, "deny", "Expired sensitive_read_confirm TTL must re-warn");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3-4: Decoupled exemptions (exemptPaths ReDoS-free, readDedup preserved, run_command independent shellDumpMaxBytes) & getExemptExtensions split-state fix", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v13-exempt-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");

  try {
    // 1. FILE_CATEGORIES.code must NOT include .json or .sql
    assert.equal(FILE_CATEGORIES.code.extensions.includes(".json"), false);
    assert.equal(FILE_CATEGORIES.code.extensions.includes(".sql"), false);

    // 2. Linear matchesExemptPath unit + ReDoS resistance (<5ms on adversarial input)
    assert.equal(matchesExemptPath(path.join(tmpDir, "reviews", "pr-1", "a.patch"), tmpDir, "reviews/**"), true);
    assert.equal(matchesExemptPath(path.join(tmpDir, "src", "reviews", "a.patch"), tmpDir, "reviews/**"), false);
    assert.equal(matchesExemptPath(path.join(tmpDir, "src", "reviews", "a.patch"), tmpDir, "**/reviews/**"), true);
    assert.equal(matchesExemptPath(path.join(tmpDir, "patches", "fix.diff"), tmpDir, "patches/*.diff"), true);
    assert.equal(matchesExemptPath(path.join(tmpDir, "patches", "sub", "fix.diff"), tmpDir, "patches/*.diff"), false);
    assert.equal(matchesExemptPath("C:\\Work\\Reviews\\PR.PATCH", "C:\\Work", "reviews/**", "win32"), true);
    assert.equal(matchesExemptPath("/work/reviews/pr.patch", "/work", "reviews/**", "linux"), true);
    assert.equal(matchesExemptPath(path.join(tmpDir, "..foo", "bar.patch"), tmpDir, "..foo/**"), true);
    const t0 = performance.now();
    const evilPath = path.join(tmpDir, `${"a".repeat(180)}!`);
    assert.equal(matchesExemptPath(evilPath, tmpDir, "*a*a*a*a*a*a*a*a*a*b"), false);
    assert.equal(matchesExemptPath(path.join(tmpDir, "a/b/c/d/e/f/g/h/i/j"), tmpDir, "**/**/**/**/**/**/**/nope"), false);
    assert.ok(performance.now() - t0 < 50, "matchesExemptPath must stay strictly linear (zero ReDoS)");

    // 3. exemptPaths skips Section 1a size guard, KEEPS readDedup & sensitiveFileGuard, and NEVER weakens run_command
    const reviewDir = path.join(tmpDir, "reviews");
    fs.mkdirSync(reviewDir, { recursive: true });
    const hugeReviewPatch = path.join(reviewDir, "huge_pr.patch");
    fs.writeFileSync(hugeReviewPatch, "diff --git a/x.ts b/x.ts\n@@ -1,2 +1,2 @@\n" + "+const z = '0123456789abcdef0123456789abcdef';\n".repeat(3200), "utf8"); // ~160 KB (>128 KB)
    const reviewEnvFile = path.join(reviewDir, ".env");
    fs.writeFileSync(reviewEnvFile, "SECRET_TOKEN=top_secret_123\n", "utf8");
    const hugePng = path.join(tmpDir, "diagram.png");
    fs.writeFileSync(hugePng, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32768, 0x41)]));
    const hugeLog = path.join(tmpDir, "huge_50k.log");
    fs.writeFileSync(hugeLog, "log payload line\n".repeat(3200), "utf8");

    fs.writeFileSync(cfgPath, JSON.stringify({ exemptPaths: ["reviews/**"], exemptExtensions: [".customtxt"] }), "utf8");

    const r1 = runHook("hooks/pre-tool-use.mjs", { conversationId: "ex-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: hugeReviewPatch } } }, dbPath, { AGY_DART_CONFIG_PATH: cfgPath });
    assert.equal(r1.decision, "allow", "exemptPaths must allow 160 KB .patch under reviews/**");
    const r2 = runHook("hooks/pre-tool-use.mjs", { conversationId: "ex-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: hugeReviewPatch } } }, dbPath, { AGY_DART_CONFIG_PATH: cfgPath });
    assert.equal(r2.decision, "deny", "exemptPaths MUST still trigger readDedup on 2nd unchanged read");
    assert.match(r2.reason, /read-dedup/);

    // sensitiveFileGuard=deny MUST still block reviews/.env even though reviews/** is in exemptPaths!
    const rSens = runHook("hooks/pre-tool-use.mjs", { conversationId: "ex-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: reviewEnvFile } } }, dbPath, {
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_SENSITIVE_FILE_GUARD: "deny"
    });
    assert.equal(rSens.decision, "deny", "sensitiveFileGuard=deny must ALWAYS run before exemptPaths");

    // run_command decoupling: cat huge.png, curl archive.zip, cat huge.patch, AND cat huge.log with cutoff=0 MUST all deny!
    const store = new ContextModeStore({ dbPath });
    try {
      store.setCutoff(0, "lifetime"); // Disable read_file cutoff completely
      store.addCustomExemptExtension(".patch", "lifetime");
    } finally {
      store.close();
    }
    for (const cmd of [
      `cat "${hugePng}"`,
      `cat "${hugeReviewPatch}"`,
      `cat "${hugeLog}"`,
      "curl https://example.com/archive.zip",
      "curl https://example.com/screenshot.png"
    ]) {
      const rCmd = runHook("hooks/pre-tool-use.mjs", { conversationId: "ex-c", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: cmd } } }, dbPath, { AGY_DART_CONFIG_PATH: cfgPath });
      assert.equal(rCmd.decision, "deny", `Decoupled run_command guard must deny '${cmd}' even when cutoff=0 or ext is exempt`);
    }

    // Symlink escape hardening: symlink inside reviews/** pointing outside to huge_50k.log MUST deny
    // (blocks BOTH exemptPaths AND exemptExtensions spoofing via .patch symlink -> .log);
    // symlink SKILL.md -> huge_50k.log MUST deny `cat SKILL.md`.
    const symEscape = path.join(reviewDir, "escaped.patch");
    const symEscapeTxt = path.join(reviewDir, "escaped.txt");
    const symSkill = path.join(tmpDir, "SKILL.md");
    let createdSymlinks = false;
    try {
      fs.symlinkSync(hugeLog, symEscape);
      fs.symlinkSync(hugeLog, symEscapeTxt);
      fs.symlinkSync(hugeLog, symSkill);
      createdSymlinks = true;
    } catch {}
    if (createdSymlinks) {
      const rSymRead = runHook("hooks/pre-tool-use.mjs", { conversationId: "sym-c", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: symEscape } } }, dbPath, { AGY_DART_CONFIG_PATH: cfgPath, AGY_DART_MAX_READ_BYTES: "46080" });
      assert.equal(rSymRead.decision, "deny", "Symlink .patch inside exemptPaths escaping to outside .log must deny");
      const rSymTxt = runHook("hooks/pre-tool-use.mjs", { conversationId: "sym-c2", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: symEscapeTxt } } }, dbPath, { AGY_DART_CONFIG_PATH: cfgPath, AGY_DART_MAX_READ_BYTES: "46080" });
      assert.equal(rSymTxt.decision, "deny", "Symlink .txt inside exemptPaths escaping to outside .log must deny");
      const rSymCat = runHook("hooks/pre-tool-use.mjs", { conversationId: "sym-c", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: `cat "${symSkill}"` } } }, dbPath, { AGY_DART_CONFIG_PATH: cfgPath });
      assert.equal(rSymCat.decision, "deny", "Symlink SKILL.md pointing to outside .log must NOT bypass shell dump guard");
    }

    // 4. getExemptExtensions split-state bug fix & legacy compat
    const splitDb = path.join(tmpDir, "split.db");
    const st = new ContextModeStore({ dbPath: splitDb });
    try {
      st.addCustomExemptExtension(".patch", "s-split");
      assert.ok(st.getExemptExtensions("s-split").includes(".pdf"), "Initially inherits global documents");
      assert.ok(st.getExemptExtensions("s-split").includes(".patch"), "Includes session custom .patch");
      // Now remove 'documents' globally -> s-split MUST reflect updated global categories while keeping .patch!
      st.toggleExemptCategory("documents", false, "lifetime");
      const updated = st.getExemptExtensions("s-split");
      assert.equal(updated.includes(".pdf"), false, "Split-state fix: removing global category must reflect in session with custom ext");
      assert.equal(updated.includes(".patch"), true, "Split-state fix: session custom ext must be preserved");
      // Legacy-only raw exempt_ext:<scope> (no structured keys) still honored
      st.setMeta("exempt_ext:session:s-legacy", JSON.stringify([".legacy"]));
      assert.deepEqual(st.getExemptExtensions("s-legacy"), [".legacy"]);
    } finally {
      st.close();
    }
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3-5: Native .patch/.diff outlines (fast MCP), 3-stage context-preserving filterGitDiff, mailbox patches & filterGhCli pr view fix", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v13-diff-"));
  try {
    // 1. fast/mcp-server.mjs read_slices({ outlines }) natively parses .patch and .diff files
    const patchPath = path.join(tmpDir, "review.patch");
    const samplePatch = [
      "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH] Add tiered guard",
      "",
      "- bullet point in commit message must not count as deleted code",
      "---",
      'diff --git "a/src/my file.ts" "b/src/my file.ts"',
      "index 1111111..2222222 100644",
      '--- "a/src/my file.ts"',
      '+++ "b/src/my file.ts"',
      "@@ -10,4 +10,5 @@ export function check() {",
      " const keep = true;",
      "-const oldVal = 1;",
      "+const newVal = 2;",
      "+const extra = 3;",
      "diff --git a/src/util.js b/src/util.js",
      "index 3333333..4444444 100644",
      "--- a/src/util.js",
      "+++ b/src/util.js",
      "@@ -1,3 +1,2 @@ function helper() {",
      "-return 0;",
      " return 1;"
    ].join("\n");
    fs.writeFileSync(patchPath, samplePatch, "utf8");

    const plainDiffPath = path.join(tmpDir, "plain.diff");
    fs.writeFileSync(
      plainDiffPath,
      [
        "--- a/legacy.txt\t2026-01-01",
        "+++ b/legacy.txt\t2026-01-02",
        "@@ -1,2 +1,2 @@",
        "-before",
        "+after"
      ].join("\n"),
      "utf8"
    );

    const client = createFramedMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), { AGY_DART_DB_PATH: path.join(tmpDir, "diff-outline-1.db") });
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } });
      client.notify("notifications/initialized");
      const res = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["review.patch", "plain.diff"] }
      });
      const text = res?.result?.content?.[0]?.text || "";
      assert.equal(client.getStderr(), "", "fast MCP stderr must stay 0 bytes");
      assert.ok(text.includes("[file] src/my file.ts (+2/-1)"), `Expected quoted file outline with +2/-1, got:\n${text}`);
      assert.ok(text.includes("[hunk] @@ -10,4 +10,5 @@ export function check() {"), `Expected hunk outline, got:\n${text}`);
      assert.ok(text.includes("[file] src/util.js (+0/-1)"), `Expected second file outline, got:\n${text}`);
      assert.ok(text.includes("[file] legacy.txt (+1/-1)"), `Expected diff -u file outline, got:\n${text}`);
      assert.ok(Buffer.byteLength(text, "utf8") <= 8800);
    } finally {
      await client.close();
    }

    // 2. filterGitDiff Stage 1: lossless context within budget + mailbox commit message '- ' bullet NOT miscounted
    const stage1Out = applyFilterRule("git-diff", samplePatch, "", 0, { command: "git diff" });
    assert.ok(stage1Out.filteredText.includes(" const keep = true;"), "Stage 1 must preserve ' ' context lines");
    assert.ok(stage1Out.filteredText.includes("src/my file.ts (+2 / -1)"), "Mailbox commit bullet must NOT inflate removed count");
    assert.ok(stage1Out.filteredText.includes("Patches: 1"), "Mailbox subject summary should be retained");

    // 3. filterGitDiff Stage 2: over-budget + explicit -U10 preserves context, caps <= 7900 B, never skips cli-filter
    assert.equal(matchFilterRule("git diff -U10 HEAD~1")?.rule.id, "git-diff");
    assert.equal(matchFilterRule("git diff -W HEAD~1")?.rule.id, "git-diff");
    const wdMatch = matchFilterRule("git diff --word-diff=color HEAD~1");
    assert.equal(wdMatch?.rule.id, "git-diff");
    assert.ok(wdMatch?.effectiveCommand.includes("--word-diff=plain"), "Must normalize --word-diff=color to --word-diff=plain");

    const hugeContextDiff = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,220 +1,220 @@",
      ...Array.from({ length: 180 }, (_, i) => ` const ctx_${i} = "${"c".repeat(45)}";`),
      "-const target = 'old';",
      "+const target = 'new';",
      ...Array.from({ length: 40 }, (_, i) => ` const tail_${i} = "${"t".repeat(45)}";`)
    ].join("\n");

    const stage2Out = applyFilterRule("git-diff", hugeContextDiff, "", 0, { command: "git diff -U10", sourceId: "src-u10" });
    assert.equal(stage2Out.wasFiltered, true);
    assert.ok(Buffer.byteLength(stage2Out.filteredText, "utf8") <= 7900);
    assert.ok(stage2Out.filteredText.includes(" const ctx_0 ="), "Stage 2 (-U10) must preserve context lines");
    assert.ok(stage2Out.filteredText.includes("context-preserved, capped"), `Stage 2 note missing: ${stage2Out.filteredText}`);
    assert.ok(stage2Out.filteredText.includes('ctx_search(sourceId:"src-u10")'));

    // 4. filterGitDiff Stage 3a (1-line context trim) & Stage 3b (compact +/-)
    const stage3aOut = applyFilterRule("git-diff", hugeContextDiff, "", 0, { command: "git diff" });
    assert.equal(stage3aOut.wasFiltered, true);
    assert.ok(Buffer.byteLength(stage3aOut.filteredText, "utf8") <= 7900);
    assert.ok(stage3aOut.filteredText.includes("context trimmed to 1 line"), `Expected Stage 3a 1-line context trim: ${stage3aOut.filteredText}`);
    assert.ok(stage3aOut.filteredText.includes(" const ctx_179 ="), "Stage 3a must retain 1 adjacent context line before change");
    assert.ok(!stage3aOut.filteredText.includes(" const ctx_50 ="), "Stage 3a must drop distant context lines");

    const hugeChangesDiff = [
      "diff --git a/massive.ts b/massive.ts",
      "--- a/massive.ts",
      "+++ b/massive.ts",
      "@@ -1,400 +1,400 @@",
      ...Array.from({ length: 260 }, (_, i) => ` const pad_${i} = "${"p".repeat(35)}";\n-const a_${i} = 1;\n+const a_${i} = 2;`)
    ].join("\n");
    const stage3bOut = applyFilterRule("git-diff", hugeChangesDiff, "", 0, { command: "git diff" });
    assert.equal(stage3bOut.wasFiltered, true);
    assert.ok(Buffer.byteLength(stage3bOut.filteredText, "utf8") <= 7900);
    assert.ok(stage3bOut.filteredText.includes("context compacted"), `Expected Stage 3b compact note: ${stage3bOut.filteredText}`);

    // 5. filterGhCli: `gh pr view` with fenced ```diff block in PR body MUST NOT be wiped by filterGitDiff!
    const prViewRaw = [
      "title:\tFix memory leak in worker pool",
      "state:\tOPEN",
      "author:\talice",
      "url:\thttps://github.com/org/repo/pull/42",
      "--",
      "Summary of the fix:",
      "```diff",
      "diff --git a/worker.js b/worker.js",
      "@@ -1,2 +1,2 @@",
      "-oldLeak()",
      "+cleanClose()",
      "```",
      "Verified locally."
    ].join("\n");
    const ghViewOut = applyFilterRule("gh-cli", prViewRaw, "", 0, { command: "gh pr view 42" });
    assert.ok(ghViewOut.filteredText.includes("Fix memory leak in worker pool"), `gh pr view title wiped:\n${ghViewOut.filteredText}`);
    assert.ok(ghViewOut.filteredText.includes("author:\talice"), `gh pr view author wiped:\n${ghViewOut.filteredText}`);

    const ghDiffOut = applyFilterRule("gh-cli", samplePatch, "", 0, { command: "gh pr diff 42" });
    assert.ok(ghDiffOut.filteredText.includes("Files changed: 2"), "gh pr diff must still route through filterGitDiff");
    const ghCompoundOut = applyFilterRule("gh-cli", samplePatch, "", 0, { command: "cd repo && gh pr diff 42" });
    assert.ok(ghCompoundOut.filteredText.includes("Files changed: 2"), "cd repo && gh pr diff must route through filterGitDiff");

    // 6. Diff parser edge cases: CRLF + commit-body `diff --git` + one-sided/space paths + `---`/`+++` inside hunk + >2048-char line + `--word-diff=plain`
    const trickyPatchPath = path.join(tmpDir, "tricky.patch");
    const trickyPatch = [
      "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH] Tricky diff edge cases",
      "",
      "diff --git a/phantom.js b/phantom.js",
      "---",
      'diff --git a/old.txt "b/new file.txt"',
      "index 111..222 100644",
      "--- a/old.txt",
      '+++ "b/new file.txt"',
      "@@ -1,5 +1,5 @@ function f() {",
      " int x = 1;",
      "--- x;",
      "+++ x;",
      `+const longLine = "${"L".repeat(2500)}";`,
      " return x;",
      "diff --git a/my space.js b/my space.js",
      "index 333..444 100644",
      "--- a/my space.js",
      "+++ b/my space.js",
      "@@ -1,2 +1,2 @@",
      "-oldVal",
      "+newVal",
      "-- ",
      "2.45.0.windows.1"
    ].join("\r\n");
    fs.writeFileSync(trickyPatchPath, trickyPatch, "utf8");
    const quotedDiffUPath = path.join(tmpDir, "quoted_u.diff");
    fs.writeFileSync(
      quotedDiffUPath,
      [
        '--- "a/src/space file.ts"\t2026-01-01',
        '+++ "b/src/space file.ts"\t2026-01-02',
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new"
      ].join("\n"),
      "utf8"
    );
    const client2 = createFramedMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), { AGY_DART_DB_PATH: path.join(tmpDir, "diff-outline-2.db") });
    try {
      await client2.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } });
      client2.notify("notifications/initialized");
      const res2 = await client2.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["tricky.patch", "quoted_u.diff"] }
      });
      const out2 = res2?.result?.content?.[0]?.text || "";
      assert.ok(!out2.includes("phantom.js"), `Commit body diff --git must NOT create phantom file:\n${out2}`);
      assert.ok(!out2.includes("[file] x;"), `---/+++ inside git hunk must NOT create phantom file:\n${out2}`);
      assert.ok(out2.includes("[file] new file.txt (+2/-1)"), `One-sided quote & >2048-char line must parse accurately:\n${out2}`);
      assert.ok(out2.includes("[file] my space.js (+1/-1)"), `Unquoted space path must parse accurately:\n${out2}`);
      assert.ok(out2.includes("[file] src/space file.ts (+1/-1)"), `Quoted diff -u path must strip b/ after unquoting:\n${out2}`);
    } finally {
      await client2.close();
    }

    const crlfFilterOut = applyFilterRule("git-diff", trickyPatch, "", 0, { command: "git diff" });
    assert.ok(!crlfFilterOut.filteredText.includes("phantom.js"), "CRLF commit body diff --git must be ignored");
    assert.ok(crlfFilterOut.filteredText.includes("Files changed: 2"), `Expected 2 files in CRLF diff:\n${crlfFilterOut.filteredText}`);
    assert.ok(crlfFilterOut.filteredText.includes("new file.txt (+2 / -1)"));
    assert.ok(crlfFilterOut.filteredText.includes("my space.js (+1 / -1)"));

    const wdRaw = [
      "diff --git a/doc.md b/doc.md",
      "index 111..222 100644",
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,4 +1,4 @@",
      "- unchanged bullet 1",
      "- unchanged bullet 2",
      "hello [-old-]{+new+} world"
    ].join("\n");
    const wdOut = applyFilterRule("git-diff", wdRaw, "", 0, { command: "git diff --word-diff=plain" });
    assert.ok(wdOut.filteredText.includes("doc.md (+1 / -1)"), `word-diff must NOT count unchanged '-' bullets:\n${wdOut.filteredText}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3-6: Installer bidirectional upgrade migration, Sidecar /api/purge 'conversation' fix, custom cutoff dropdown & doctor provenance", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v13-ops-"));
  const fakeHome = path.join(tmpDir, "home");
  const migDb = path.join(tmpDir, "migrate.db");
  const sidecarDb = path.join(tmpDir, "sidecar.db");
  fs.mkdirSync(fakeHome, { recursive: true });

  const runInstallInFakeHome = (extraArgs = []) => {
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      AGY_DART_DB_PATH: migDb,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json")
    };
    const res = spawnSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), ...extraArgs], {
      encoding: "utf8",
      windowsHide: true,
      env
    });
    assert.equal(res.status, 0, `install.mjs ${extraArgs.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
    return res.stdout;
  };

  let srv = null;
  try {
    // 1A. Legacy DB with cutoff:global=16384 (no cutoff:source) -> default install migrates to 46080 (host-45k)
    let st = new ContextModeStore({ dbPath: migDb });
    st.setMeta("cutoff:global", "16384");
    st.close();
    const outMig = runInstallInFakeHome(["install"]);
    assert.match(outMig, /Migrated legacy default cutoff 16384 B -> 46080 B/);
    assert.match(outMig, /Read guard\s*:/);
    st = new ContextModeStore({ dbPath: migDb });
    assert.equal(st.getCutoff(null), 46080);
    assert.equal(st.getMeta("cutoff:source"), "installer_default");
    st.close();

    // 1B. User sets custom cutoff 32768 -> subsequent default install MUST preserve 32768!
    st = new ContextModeStore({ dbPath: migDb });
    st.setCutoff(32768, "lifetime");
    st.close();
    const outPreserve = runInstallInFakeHome(["install"]);
    assert.match(outPreserve, /Preserved existing custom global cutoff \(32768 B/);
    st = new ContextModeStore({ dbPath: migDb });
    assert.equal(st.getCutoff(null), 32768);
    assert.equal(st.getMeta("cutoff:source"), "user");
    st.close();

    // 1C. Explicit --mode balanced-16k sets 16384 (source=user), and subsequent default install preserves 16384
    runInstallInFakeHome(["install", "--mode", "balanced-16k"]);
    runInstallInFakeHome(["install"]);
    st = new ContextModeStore({ dbPath: migDb });
    assert.equal(st.getCutoff(null), 16384, "User-chosen balanced-16k must NOT be overwritten on default upgrade");
    st.close();

    // 2. ctx_doctor exposes readGuard provenance & stays <= 8.4 KB
    const docStore = new ContextModeStore({ dbPath: migDb });
    try {
      const tools = createTools({ store: docStore, getCwd: () => tmpDir, getSessionId: () => "doc-s" });
      const doc = await tools.ctx_doctor({ cwd: tmpDir });
      assert.equal(doc.readGuard.mode, "soft");
      assert.equal(doc.readGuard.sourceCutoffBytes, 16384);
      assert.equal(doc.readGuard.sourceCutoffSource, "sqlite:user");
      assert.equal(doc.readGuard.noiseMaxReadBytes, 16384);
      assert.equal(doc.readGuard.reviewMaxReadBytes, 131072);
      assert.equal(doc.readGuard.shellDumpMaxBytes, 16384);
      assert.ok(Buffer.byteLength(JSON.stringify(doc, null, 2), "utf8") <= 8400);
    } finally {
      docStore.close();
    }

    // 3. Sidecar /api/purge with scope="conversation" succeeds (no longer throws Invalid purge scope) and isolates sessions
    const scStore = new ContextModeStore({ dbPath: sidecarDb });
    scStore.indexContent({ sessionId: "conv-purge-1", worktree: tmpDir, kind: "file", label: "a.txt", content: "PURGE_ME_TOKEN_V13" });
    scStore.indexContent({ sessionId: "conv-keep-2", worktree: tmpDir, kind: "file", label: "b.txt", content: "KEEP_ME_TOKEN_V13" });
    scStore.close();

    const prevDbEnv = process.env.AGY_DART_DB_PATH;
    process.env.AGY_DART_DB_PATH = sidecarDb;
    const token = "v13-csrf-token-test";
    try {
      srv = createStandaloneServer({ csrfToken: token });
      await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
      const { port } = srv.address();
      const purgeRes = await fetch(`http://127.0.0.1:${port}/api/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: JSON.stringify({ scope: "conversation", conversationId: "conv-purge-1" })
      });
      assert.equal(purgeRes.status, 200, "Sidecar /api/purge scope=conversation must return 200");
      const purgeJson = await purgeRes.json();
      assert.equal(purgeJson.ok, true);
      assert.equal(purgeJson.purged, "session");
      assert.equal(purgeJson.sessionId, "conv-purge-1");
    } finally {
      if (srv) {
        await new Promise((r) => srv.close(r));
        srv = null;
      }
      if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
      else process.env.AGY_DART_DB_PATH = prevDbEnv;
    }

    const verifyStore = new ContextModeStore({ dbPath: sidecarDb });
    try {
      assert.equal(verifyStore.search({ queries: ["PURGE_ME_TOKEN_V13"], sessionId: "conv-purge-1", scope: "session" }).hits.length, 0);
      assert.equal(verifyStore.search({ queries: ["KEEP_ME_TOKEN_V13"], sessionId: "conv-keep-2", scope: "session" }).hits.length, 1);
      // SQLite LIKE wildcard safety: purging "s_1" must NOT delete sibling session "sX1" confirm keys!
      verifyStore.setTimedMeta("large_read_confirm:conv:s_1:/a:full", "sig1");
      verifyStore.setTimedMeta("large_read_confirm:conv:sX1:/a:full", "sig2");
      verifyStore.purge({ scope: "session", sessionId: "s_1" });
      assert.equal(verifyStore.getMeta("large_read_confirm:conv:s_1:/a:full", null), null);
      assert.equal(verifyStore.getTimedMeta("large_read_confirm:conv:sX1:/a:full", null), "sig2");
    } finally {
      verifyStore.close();
    }

    // 4. Sidecar index.html: 45 KB option, <= 800-line clamp, and dynamic custom cutoff option echo
    const htmlSource = readDashboardHtml();
    assert.match(htmlSource, /<option\b[^>]*value="46080"[^>]*data-i18n="cutoffHostCap"[^>]*>45 KB \(host cap\)<\/option>/);
    const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    const mainScript = scriptBlocks[scriptBlocks.length - 1][1];

    const customChildren = [];
    const makeDomEl = (id) => {
      const attrs = {};
      const el = {
        id,
        value: id === "cutoff-select" ? "46080" : "",
        innerText: "",
        textContent: "",
        innerHTML: "",
        title: "",
        dataset: {},
        style: {},
        options:
          id === "cutoff-select"
            ? [{ value: "0" }, { value: "16384" }, { value: "32768" }, { value: "46080" }, { value: "65536" }]
            : [],
        setAttribute(k, v) { attrs[k] = v; },
        getAttribute(k) { return attrs[k] || ""; },
        appendChild(child) { customChildren.push(child); return child; },
        removeChild(child) {
          const i = customChildren.indexOf(child);
          if (i !== -1) customChildren.splice(i, 1);
          const oi = this.options.indexOf(child);
          if (oi !== -1) this.options.splice(oi, 1);
        },
        querySelector(sel) {
          if (sel === 'option[data-custom-cutoff="1"]') {
            return customChildren.find((c) => c.dataset?.customCutoff === "1") || null;
          }
          return null;
        },
        querySelectorAll() { return []; },
        classList: { add() {}, remove() {}, contains() { return false; } }
      };
      return el;
    };
    const els = new Map();
    const getEl = (id) => {
      if (!els.has(id)) els.set(id, makeDomEl(id));
      return els.get(id);
    };
    const sandbox = {
      window: { location: { search: "" }, addEventListener() {} },
      document: {
        title: "",
        documentElement: { lang: "en" },
        getElementById: getEl,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => makeDomEl(tag)
      },
      navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
      localStorage: { getItem: () => "en", setItem: () => {} },
      URLSearchParams,
      Headers,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      console: { log() {}, warn() {}, error() {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(
      `${mainScript}\nglobalThis.__v13 = { calculateMaxLineRange, updateCutoffDropdown };`,
      sandbox
    );
    assert.equal(sandbox.__v13.calculateMaxLineRange(46080), 800);
    assert.equal(sandbox.__v13.calculateMaxLineRange(65536), 800);
    assert.equal(sandbox.__v13.calculateMaxLineRange(16384), 410);

    // Custom cutoff 49152 must render as 49152 (custom), NOT fall back to 16384
    sandbox.__v13.updateCutoffDropdown({ cutoffBytes: 49152 });
    const selEl = getEl("cutoff-select");
    assert.equal(selEl.value, "49152", "Custom cutoff 49152 must NOT be mis-echoed as 16384");
    assert.ok(selEl.options.some((o) => o.value === "49152" && o.dataset?.customCutoff === "1"));

    // Switching back to built-in 46080 cleans up the dynamic custom option & reflects readGuardMode in gate-read-cutoff
    sandbox.__v13.updateCutoffDropdown({ cutoffBytes: 46080, readGuardMode: "strict", noiseMaxReadBytes: 8192, reviewMaxReadBytes: 262144 });
    assert.equal(selEl.value, "46080");
    assert.equal(selEl.options.some((o) => o.dataset?.customCutoff === "1"), false);
    const gateEl = getEl("gate-read-cutoff");
    assert.match(gateEl.innerText, /Strict-blocks/i);
    assert.match(gateEl.innerText, /8 KB/);
    assert.match(gateEl.innerText, /256 KB/);
    sandbox.__v13.updateCutoffDropdown({ cutoffBytes: 46080, readGuardMode: "off" });
    assert.match(gateEl.innerText, /disabled/i);
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
