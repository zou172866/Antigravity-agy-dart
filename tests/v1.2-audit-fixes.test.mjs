import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runProcess, executeCode } from "../context/lib/executor.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  detectSensitiveFile,
  isPrivateOrReservedIp,
  sanitizeUrlForDisplay,
  validateFetchTarget
} from "../context/lib/security.js";
import { getEffectiveConfig, resetConfigCache } from "../context/lib/config.js";
import { buildHandoffBrief, inferWorkspaceFromStore } from "../context/lib/handoff.js";
import { stableSortObject, stableStringify } from "../context/lib/stable-json.js";
import { smartCrushJson } from "../context/lib/json-crusher.js";
import { resolveModelProfile } from "../context/lib/cache/profiles.js";
import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  extractStepTokenUsage,
  readTranscriptTail
} from "../context/lib/cache-analyzer.js";
import { simulateCachePolicies } from "../context/lib/cache-simulator.js";
import { buildRepoHotspots } from "../context/lib/repo-skeleton.js";
import {
  applyFilterRule,
  hasUnsafeShellSyntax,
  isSafeRegex,
  parseGitSubcommand
} from "../hooks/filter-rules.mjs";
import {
  createStandaloneServer,
  isAllowedOriginHeader,
  resolveAllowedHandoffCwd
} from "../sidecars/dashboard/server.mjs";
import {
  auditEnvironmentCache,
  estimateTokens as cacheAuditEstimateTokens,
  inspectHookSource
} from "../scripts/cache-audit.mjs";
import { estimateTokens as prefixBudgetEstimateTokens } from "../scripts/prefix-budget.mjs";
import { countTestCasesInSource } from "../scripts/gen-review-brief.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function mcpSession(scriptPath, requests, extraEnv = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...extraEnv }
    });
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`MCP timeout (${scriptPath}); stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      const messages = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed));
        } catch {
          // ignore non-json
        }
      }
      resolve({ code, messages, stdout, stderr });
    });

    for (const req of requests) {
      if (typeof req === "string") {
        child.stdin.write(req.endsWith("\n") ? req : req + "\n");
      } else {
        child.stdin.write(JSON.stringify(req) + "\n");
      }
    }
    child.stdin.end();
  });
}

function runHook(hookFile, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", hookFile)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, AGY_DART_DB_PATH: dbPath, ...extraEnv }
  });
  return res;
}

function httpReq(port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== null) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test("Audit P0/P1/P2 (C-2, H-10, M-21): executor stdin error safety, full stdout close, and safe cmd/args execution", async () => {
  // C-2: Large stdin written to immediately-exiting child must NOT throw uncaught EPIPE/EOF
  const bigInput = "x".repeat(512 * 1024);
  const resEpipe = await runProcess({
    cmd: process.execPath,
    args: ["-e", "process.exit(0)"],
    stdinData: bigInput,
    timeoutMs: 5000
  });
  assert.equal(resEpipe.ok, true);
  assert.equal(resEpipe.exitCode, 0);

  // H-10: Trailing stdout must never be dropped by early 'exit' race (10 iterations)
  const payloadScript = 'process.stdout.write("A".repeat(8192) + "\\nTAIL_MARKER_END\\n");';
  for (let i = 0; i < 10; i++) {
    const res = await runProcess({
      cmd: process.execPath,
      args: ["-e", payloadScript],
      timeoutMs: 5000
    });
    assert.equal(res.ok, true, `Run ${i} failed`);
    assert.ok(res.stdout.endsWith("TAIL_MARKER_END\n"), `Run ${i} dropped stdout tail`);
  }

  // M-21: executeCode handles args: null, nodejs file mode with args, and Windows cmd file mode safely
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-exec-"));
  try {
    const jsFile = path.join(tmpDir, "echo args.js");
    fs.writeFileSync(jsFile, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
    const rNullArgs = await executeCode({ language: "nodejs", file: jsFile, args: null, cwd: tmpDir });
    assert.equal(rNullArgs.ok, true);
    assert.deepEqual(JSON.parse(rNullArgs.stdout.trim()), []);

    const rJsArgs = await executeCode({ language: "nodejs", file: jsFile, args: ["a b", "c&d"], cwd: tmpDir });
    assert.equal(rJsArgs.ok, true);
    assert.deepEqual(JSON.parse(rJsArgs.stdout.trim()), ["a b", "c&d"]);

    if (process.platform === "win32") {
      const batFile = path.join(tmpDir, "safe & script.cmd");
      fs.writeFileSync(batFile, "@echo off\r\necho A1=%1 A2=%2\r\n", "utf8");
      const rBat = await executeCode({
        language: "cmd",
        file: batFile,
        args: ["foo & echo PWNED", "bar baz"],
        cwd: tmpDir
      });
      assert.equal(rBat.ok, true, `cmd file failed: ${rBat.stderr}`);
      assert.ok(rBat.stdout.includes('A1="foo & echo PWNED"'));
      assert.ok(rBat.stdout.includes('A2="bar baz"'));
      assert.ok(!/\r?\nPWNED\r?\n/.test(rBat.stdout), "Shell injection occurred in cmd file mode");

      const rBadQuote = await executeCode({
        language: "cmd",
        file: batFile,
        args: ['bad"arg'],
        cwd: tmpDir
      });
      assert.equal(rBadQuote.ok, false);
      assert.match(rBadQuote.stderr, /Invalid script file path or argument/);

      // M-21 PowerShell -Command + safeArgs must pass literal $args and never execute shell metacharacters
      const rPsSafe = await executeCode({
        language: "powershell",
        code: 'Write-Output "CNT=$($args.Count) A0=$($args[0]) A1=$($args[1])"',
        args: ["; Write-Output 'INJECTED_PS'", 'val "q" $HOME'],
        cwd: tmpDir
      });
      assert.equal(rPsSafe.ok, true, `PowerShell -Command safeArgs failed: ${rPsSafe.stderr}`);
      assert.ok(rPsSafe.stdout.includes("CNT=2"), `Expected 2 literal args: ${rPsSafe.stdout}`);
      assert.ok(!/\r?\nINJECTED_PS\r?\n/.test(rPsSafe.stdout), `PowerShell command injection occurred: ${rPsSafe.stdout}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P0/P1/P2 (C-1, H-11, H-12, M-15, M-16): fast/mcp-server apply_edits rollback, case-folding, EOL preservation, NaN guard", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-fast-edits-"));
  const fastServer = path.join(ROOT, "fast", "mcp-server.mjs");

  try {
    // Prepare files
    const mixedEolPath = path.join(tmpDir, "mixed.txt");
    const lfLines = Array.from({ length: 12 }, (_, i) => `line_${i}`).join("\n") + "\r\ntrailing_crlf\n";
    fs.writeFileSync(mixedEolPath, lfLines, "utf8");

    const caseFile = path.join(tmpDir, "App.ts");
    fs.writeFileSync(caseFile, "export const v = 1;\nexport const w = 2;\n", "utf8");

    const existingProtected = path.join(tmpDir, "keep.txt");
    fs.writeFileSync(existingProtected, "ORIGINAL_KEEP_CONTENT\n", "utf8");

    const dirAsFile = path.join(tmpDir, "a_dir");
    fs.mkdirSync(dirAsFile);

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      // M-15: Edit single line in predominantly-LF file with one CRLF line
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "apply_edits",
          arguments: {
            cwd: tmpDir,
            edits: [{ path: "mixed.txt", hunks: [{ target: "line_5", replacement: "line_5_edited\nline_5b" }] }],
            verifyTimeoutSec: "not-a-number",
            maxVerifyChars: "nan"
          }
        }
      },
      // H-11: Same batch targeting App.ts and app.ts with overlapping target on win32
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "apply_edits",
          arguments: {
            cwd: tmpDir,
            edits: [
              { path: "App.ts", hunks: [{ target: "export const v = 1;", replacement: "export const v = 10;" }] },
              { path: "app.ts", hunks: [{ target: "export const v = 1;", replacement: "export const v = 20;" }] }
            ]
          }
        }
      },
      // H-12: create overwrite:false on existing file & directory target must fail without destroying original
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "apply_edits",
          arguments: {
            cwd: tmpDir,
            edits: [
              { path: "keep.txt", create: "OVERWRITTEN", overwrite: false },
              { path: "a_dir", create: "NOPE", overwrite: true }
            ]
          }
        }
      },
      // M-16: read_slices with non-numeric maxChars should fall back to default (not NaN / 0 chars)
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: tmpDir,
            slices: [{ path: "App.ts", ranges: [[1, 2]] }],
            maxChars: "not-a-number"
          }
        }
      }
    ];

    const res = await mcpSession(fastServer, requests, { AGY_DART_DB_PATH: path.join(tmpDir, "fast-audit.db") });

    // M-15 check
    const r2 = res.messages.find((m) => m.id === 2);
    assert.ok(r2 && !r2.result?.isError, `M-15 apply_edits failed: ${JSON.stringify(r2)}`);
    const editedMixed = fs.readFileSync(mixedEolPath, "utf8");
    assert.ok(editedMixed.includes("line_5_edited\nline_5b\n"), "Replaced hunk should use dominant LF");
    assert.ok(editedMixed.includes("\r\ntrailing_crlf\n"), "Untouched CRLF line should be preserved verbatim");
    const crlfCount = (editedMixed.match(/\r\n/g) || []).length;
    assert.equal(crlfCount, 1, `Expected only the 1 original CRLF, got ${crlfCount}`);

    // H-11 check (on win32, App.ts and app.ts fold to the same path key and trigger overlap rejection!)
    const r3 = res.messages.find((m) => m.id === 3);
    if (process.platform === "win32") {
      assert.equal(r3?.result?.isError, true, "Expected overlapping case-variant hunks to be rejected on win32");
      assert.equal(fs.readFileSync(caseFile, "utf8"), "export const v = 1;\nexport const w = 2;\n");
    }

    // H-12 check
    const r4 = res.messages.find((m) => m.id === 4);
    assert.equal(r4?.result?.isError, true);
    assert.equal(fs.readFileSync(existingProtected, "utf8"), "ORIGINAL_KEEP_CONTENT\n");

    // M-16 check
    const r5 = res.messages.find((m) => m.id === 5);
    assert.ok(r5 && !r5.result?.isError);
    const sliceText = r5.result.content[0].text;
    assert.ok(sliceText.includes("export const v = 1;"), "read_slices with NaN maxChars must still return content");

    // C-1 rollback check: verify commitPlannedWrites source invariants + rollback on read-only target dir/file failure
    const fastSrc = fs.readFileSync(fastServer, "utf8");
    const commitIdx = fastSrc.indexOf("async function commitPlannedWrites(");
    const commitBlock = fastSrc.slice(commitIdx, commitIdx + 2400);
    assert.ok(commitBlock.includes('EXDEV') && commitBlock.includes('EBUSY'), "C-1: direct-write fallback must be restricted to rename error codes");
    assert.ok(
      commitBlock.indexOf("written.push(plan);") < commitBlock.indexOf("await fs2.writeFile(target, plan.newContent"),
      "C-1: plan must be recorded in `written` BEFORE direct fallback write so rollback always restores original"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-1, H-7, M-9, M-10, M-11, M-12, M-13, M-14, P3-6, P3-7): fast/mcp-server git whitelist, ReDoS, outlines & cache", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-fast-search-"));
  const fastServer = path.join(ROOT, "fast", "mcp-server.mjs");

  try {
    // Init tiny git repo for H-1
    spawnSync("git", ["init"], { cwd: tmpDir, windowsHide: true });
    spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: tmpDir, windowsHide: true });
    spawnSync("git", ["config", "user.name", "t"], { cwd: tmpDir, windowsHide: true });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# test\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: tmpDir, windowsHide: true });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmpDir, windowsHide: true });

    // Create >25 files so M-10 empty-match cache test exercises the >24-file repo branch
    fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".hidden"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".github", "workflows"), { recursive: true });
    for (let i = 0; i < 26; i++) {
      fs.writeFileSync(path.join(tmpDir, "sub", `f${i}.txt`), `normal file ${i}\n`, "utf8");
    }
    fs.writeFileSync(path.join(tmpDir, ".hidden", "secret_note.txt"), "HIDDEN_MARKER_123\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".github", "workflows", "ci.yml"), "name: GITHUB_HIDDEN_456\n", "utf8");

    // M-9: file with 60 matches + deep file with before/after context to catch rg perFileCap truncation dropping before-context
    fs.writeFileSync(
      path.join(tmpDir, "many.txt"),
      Array.from({ length: 60 }, (_, i) => `NEEDLE_MATCH_${i}`).join("\n") + "\n",
      "utf8"
    );
    const deepCtxDir = path.join(tmpDir, "d1", "d2", "d3", "d4");
    fs.mkdirSync(deepCtxDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepCtxDir, "ctx_file.txt"),
      "CTX_BEFORE_LINE_1\nCTX_BEFORE_LINE_2\nNEEDLE_MATCH_DEEP\nCTX_AFTER_LINE_1\n",
      "utf8"
    );

    // H-7: CSS & Vue SFC with 200-char pathological decoration comment (would take seconds under old ReDoS)
    const deco = "=".repeat(190);
    fs.writeFileSync(path.join(tmpDir, "style.css"), `/* ${deco} */\n.btn { color: red; }\n`, "utf8");
    fs.writeFileSync(
      path.join(tmpDir, "Comp.vue"),
      `<template>\n<!-- ${deco} -->\n<div/>\n</template>\n<script>\nexport default {};\n</script>\n`,
      "utf8"
    );

    // M-12: Python multiline signature
    fs.writeFileSync(
      path.join(tmpDir, "multi.py"),
      "def multiline_fn(\n    alpha: int,\n    beta: str,\n) -> int:\n    x = alpha + 1\n    return x\n",
      "utf8"
    );

    // M-13: UTF-8 BOM on line 1 + M-14 template fake function + P3-6 multiline generic constraint
    fs.writeFileSync(
      path.join(tmpDir, "bom_ts.ts"),
      "\uFEFFexport function bomFirst() {\n  const tpl = `\nfunction fakeInsideTemplate() {}\n`;\n  return tpl;\n}\n\n" +
        "export function withGeneric<T extends {\n  id: string;\n}>(item: T) {\n  const out = item.id;\n  return out;\n}\n",
      "utf8"
    );

    // M-14: Go raw string containing backslash
    fs.writeFileSync(
      path.join(tmpDir, "raw.go"),
      'package main\n\nfunc firstGo() string {\n\treturn `\\`\n}\n\nfunc secondGo() int {\n\treturn 42\n}\n',
      "utf8"
    );

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      // H-1: rejected git branch/tag bypasses
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "batch_search",
          arguments: {
            cwd: tmpDir,
            queries: [
              { type: "git", pattern: "branch --color new-branch" },
              { type: "git", pattern: "branch --color -D --color main" },
              { type: "git", pattern: "branch --contains -D main" },
              { type: "git", pattern: "tag --color -d --color v1.0" },
              { type: "git", pattern: "branch --color=never --list" },
              { type: "git", pattern: "branch --sort -committerdate --list" }
            ]
          }
        }
      },
      // H-7 + M-12 + M-13 + M-14 + P3-6: outlines
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: tmpDir,
            outlines: ["style.css", "Comp.vue", "multi.py", "bom_ts.ts", "raw.go"]
          }
        }
      },
      // M-9 + M-11: truncation sentinel, before-context preservation after perFileCap hit, & backslash/hidden globs
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "batch_search",
          arguments: {
            cwd: tmpDir,
            queries: [
              { type: "text", pattern: "NEEDLE_MATCH_", path: "many.txt", maxResults: 40 },
              { type: "text", pattern: "normal file 1", glob: "sub\\*.txt" },
              { type: "text", pattern: "HIDDEN_MARKER_123", glob: "**\\.hidden\\**" },
              { type: "text", pattern: "GITHUB_HIDDEN_456", glob: "**\\.github\\**" },
              { type: "text", pattern: "NEEDLE_MATCH_", maxResults: 120, contextLines: 2 }
            ]
          }
        }
      }
    ];

    const t0 = Date.now();
    const res = await mcpSession(fastServer, requests, { AGY_DART_DB_PATH: path.join(tmpDir, "fast-search.db") });
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 8000, `H-7: MCP batch took suspiciously long (${elapsedMs}ms)`);

    // Verify H-1: first 4 rejected, last 2 allowed, and NO branch named "new-branch" created
    const branches = spawnSync("git", ["branch", "--list"], { cwd: tmpDir, encoding: "utf8", windowsHide: true }).stdout;
    assert.ok(!branches.includes("new-branch"), "H-1 bypass created new-branch!");
    const r2Text = res.messages.find((m) => m.id === 2)?.result?.content?.[0]?.text || "";
    assert.ok(r2Text.includes("Query 1") && r2Text.includes("ERROR:") && r2Text.includes("Positional branch argument"), `Query 1 (branch --color new-branch) must error: ${r2Text}`);
    assert.ok(r2Text.includes("Query 2") && r2Text.includes("not allowed"), "Query 2 (branch --color -D) must error");
    assert.ok(r2Text.includes("Query 4") && r2Text.includes("not allowed"), "Query 4 (tag --color -d) must error");
    assert.ok(!r2Text.split("Query 5")[1].split("Query 6")[0].includes("ERROR:"), `Query 5 (--color=never --list) should succeed: ${r2Text}`);
    assert.ok(!r2Text.split("Query 6")[1].includes("ERROR:"), `Query 6 (--sort -committerdate --list) should succeed: ${r2Text}`);

    // Verify H-7, M-12, M-13, M-14, P3-6 outlines
    const r3Text = res.messages.find((m) => m.id === 3)?.result?.content?.[0]?.text || "";
    assert.ok(/L1-L6\s+\[function\]\s+multiline_fn/.test(r3Text), `M-12 Python multiline endLine wrong: ${r3Text}`);
    assert.ok(r3Text.includes("bomFirst"), `M-13 BOM line-1 function missed: ${r3Text}`);
    assert.ok(!r3Text.includes("fakeInsideTemplate"), `M-14 template fake function leaked: ${r3Text}`);
    assert.ok(/L8-L13\s+\[function\]\s+withGeneric/.test(r3Text), `P3-6 multiline generic endLine wrong: ${r3Text}`);
    assert.ok(/L3-L5\s+\[function\]\s+firstGo/.test(r3Text) && /L7-L9\s+\[function\]\s+secondGo/.test(r3Text), `M-14 Go raw backtick broke endLine: ${r3Text}`);

    // Verify M-9 & M-11 (assert actual file paths, not just echoed query headers!)
    const r4Text = res.messages.find((m) => m.id === 4)?.result?.content?.[0]?.text || "";
    assert.ok(r4Text.includes("truncated"), `M-9 expected truncation marker on 60-match file: ${r4Text}`);
    assert.ok(r4Text.includes("sub/f1.txt"), `M-11 backslash glob sub\\*.txt missed: ${r4Text}`);
    assert.ok(r4Text.includes(".hidden/secret_note.txt"), `M-11 hidden backslash glob missed actual file: ${r4Text}`);
    assert.ok(r4Text.includes(".github/workflows/ci.yml"), `M-11 **\\.github\\** hidden glob missed in rg mode: ${r4Text}`);
    assert.ok(
      r4Text.includes("NEEDLE_MATCH_DEEP") && r4Text.includes("CTX_BEFORE_LINE_1") && r4Text.includes("CTX_BEFORE_LINE_2"),
      `M-9 before-context was dropped after perFileCap truncation: ${r4Text}`
    );

    // Verify M-10: 0-hit query on >24-file repo is NOT cached stale after external edit
    // Spawn a single persistent MCP server and send query -> write file -> send same query
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fastServer], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let buf = "";
      let stage = 0;
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("M-10 timeout")); }, 8000);
      child.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          const msg = JSON.parse(l);
          if (msg.id === 10 && stage === 0) {
            stage = 1;
            const t1 = msg.result?.content?.[0]?.text || "";
            assert.ok(t1.includes("(no matches)"));
            // Externally mutate a file on disk
            fs.writeFileSync(path.join(tmpDir, "sub", "f0.txt"), "FRESH_TOKEN_AFTER_MISS\n", "utf8");
            child.stdin.write(JSON.stringify({
              jsonrpc: "2.0",
              id: 11,
              method: "tools/call",
              params: { name: "batch_search", arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "FRESH_TOKEN_AFTER_MISS" }] } }
            }) + "\n");
          } else if (msg.id === 11) {
            clearTimeout(timer);
            const t2 = msg.result?.content?.[0]?.text || "";
            child.stdin.end();
            try {
              assert.ok(t2.includes("FRESH_TOKEN_AFTER_MISS"), `M-10 returned stale cached miss: ${t2}`);
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "batch_search", arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "FRESH_TOKEN_AFTER_MISS" }] } }
      }) + "\n");
    });

    // P3-7: Verify fast/benchmark.mjs GIT_BRANCH_VALUE_FLAGS does not include --color/--column/--abbrev
    const benchSrc = fs.readFileSync(path.join(ROOT, "fast", "benchmark.mjs"), "utf8");
    const mFlags = benchSrc.match(/GIT_BRANCH_VALUE_FLAGS\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?new Set\(\[([^\]]*)\]\)/);
    assert.ok(mFlags, "GIT_BRANCH_VALUE_FLAGS not found in benchmark.mjs");
    assert.ok(!mFlags[1].includes("--color") && !mFlags[1].includes("--column") && !mFlags[1].includes("--abbrev"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-4, H-5, H-8, H-15, M-18, M-19, M-20, P3-8, P3-9): context MCP server, tools & security", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-ctx-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const ctxServer = path.join(ROOT, "context", "server.js");

  const store = new ContextModeStore({ dbPath: tmpDb });
  try {
    // H-8, H-15, M-18: live JSON-RPC protocol tests on context/server.js
    const res = await mcpSession(
      ctxServer,
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
        "null", // H-8: must return -32600 and NOT crash!
        "[]",   // H-8: non-object array must return -32600
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "toString", arguments: {} } }, // M-18
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "constructor", arguments: {} } }, // M-18
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "ctx_index",
            arguments: { content: "meta session isolation token ALPHA_META_99", label: "meta-note", sessionId: "" }, // H-15 empty string
            _meta: { rootConversationId: "meta-conv-42" }
          }
        },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "ctx_search",
            arguments: { queries: ["ALPHA_META_99"], scope: "session", sessionId: "" },
            _meta: { rootConversationId: "meta-conv-42" }
          }
        },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "ctx_search",
            arguments: { queries: ["ALPHA_META_99"], scope: "session", sessionId: "default", cwd: tmpDir }
          }
        }
      ],
      { AGY_DART_DB_PATH: tmpDb }
    );

    assert.equal(res.code, 0, `context/server.js crashed: ${res.stderr}`);
    const invalidReqs = res.messages.filter((m) => m.error?.code === -32600);
    assert.ok(invalidReqs.length >= 2, `H-8: expected >=2 -32600 errors for null/[], got ${JSON.stringify(res.messages)}`);
    assert.equal(res.messages.find((m) => m.id === 2)?.error?.code, -32601, "M-18: toString must return -32601");
    assert.equal(res.messages.find((m) => m.id === 3)?.error?.code, -32601, "M-18: constructor must return -32601");

    const r5Payload = JSON.parse(res.messages.find((m) => m.id === 5)?.result?.content?.[0]?.text || "{}");
    const r6Payload = JSON.parse(res.messages.find((m) => m.id === 6)?.result?.content?.[0]?.text || "{}");
    assert.ok(r5Payload.totalMatches >= 1, `H-15: empty sessionId should fall back to _meta.rootConversationId: ${JSON.stringify(r5Payload)}`);
    assert.equal(r6Payload.totalMatches, 0, "H-15: content indexed under _meta.rootConversationId must not leak to default");

    // H-5: detectSensitiveFile Windows NTFS trailing dot/space, ADS, drive-relative, POSIX colon, and relative paths
    for (const sample of [
      "server.pem.",
      "id_rsa.",
      ".npmrc ",
      ".env::$DATA",
      "C:.env",
      "C:server.pem",
      "C:.aws\\credentials",
      "prod:server.pem",
      ".aws/credentials",
      ".kube/config",
      ".ssh/id_custom"
    ]) {
      const det = detectSensitiveFile(sample);
      assert.equal(det.sensitive, true, `H-5: expected sensitive=true for '${sample}'`);
    }

    // H-4: ctx_index respects AGY_DART_SENSITIVE_FILE_GUARD=deny
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "API_KEY=secret123\n", "utf8");
    const tools = createTools({ store });
    const prevGuard = process.env.AGY_DART_SENSITIVE_FILE_GUARD;
    process.env.AGY_DART_SENSITIVE_FILE_GUARD = "deny";
    try {
      await assert.rejects(
        () => tools.ctx_index({ path: envFile, sessionId: "s-deny" }),
        /Blocked indexing sensitive file/i,
        "H-4: ctx_index must deny sensitive files when guard=deny"
      );
    } finally {
      if (prevGuard === undefined) delete process.env.AGY_DART_SENSITIVE_FILE_GUARD;
      else process.env.AGY_DART_SENSITIVE_FILE_GUARD = prevGuard;
    }

    // M-19: ctx_search strict outer JSON byte cap (<= 8600 bytes) even with 25 dense hits + oversized queries
    for (let i = 0; i < 25; i++) {
      store.indexContent({
        sessionId: "s-cap",
        worktree: tmpDir,
        kind: "file",
        label: `big_source_document_number_${i}_with_long_name.log`,
        content: `CAP_NEEDLE_${i} CAP_NEEDLE_COMMON ${"long_payload_word_".repeat(40)}\n`.repeat(12)
      });
    }
    const longQueries = Array.from({ length: 30 }, (_, i) => (i === 0 ? "CAP_NEEDLE_COMMON" : `extra_${i}_${"q".repeat(300)}`));
    const searchRes = await tools.ctx_search({ queries: longQueries, sessionId: "s-cap", limit: 25 });
    const serializedBytes = Buffer.byteLength(JSON.stringify(searchRes, null, 2), "utf8");
    assert.ok(serializedBytes <= 8600, `M-19: ctx_search serialized output exceeded 8600 B: ${serializedBytes}`);
    assert.ok(searchRes.queries.length <= 20, "M-19: echoed queries must be capped <= 20");

    // M-20: sanitizeUrlForDisplay & ctx_index label redaction
    const sanitized = sanitizeUrlForDisplay("https://alice:hunter2@api.example.com/v1?api_key=sk-abcdefghijklmnopqrstuv&q=hello#access_token=tok_secret999");
    assert.ok(!sanitized.includes("hunter2"), "M-20: password leaked");
    assert.ok(!sanitized.includes("sk-abcdefghijklmnopqrstuv"), "M-20: api_key query param leaked");
    assert.ok(!sanitized.includes("tok_secret999"), "M-20: fragment access_token leaked");
    assert.ok(sanitized.includes("q=hello"), "M-20: safe query param should be kept");

    const idxSecretLabel = await tools.ctx_index({
      content: "harmless body",
      label: "https://api.example.com/data?token=my_super_secret_token_value",
      sessionId: "s-sec"
    });
    assert.ok(!idxSecretLabel.label.includes("my_super_secret_token_value"), "M-20: ctx_index leaked URL token in label");

    // P3-9: IPv6 0000::/8 & fe00::/8 blocked; explicit allowPrivate:false overrides config
    assert.equal(isPrivateOrReservedIp("::1234"), true, "P3-9: 0000::/8 should be reserved");
    assert.equal(isPrivateOrReservedIp("fe00::1"), true, "P3-9: fe00::/8 should be reserved");
    const prevAllowPriv = process.env.AGY_DART_ALLOW_PRIVATE_URLS;
    process.env.AGY_DART_ALLOW_PRIVATE_URLS = "1";
    resetConfigCache();
    try {
      await assert.rejects(
        () => validateFetchTarget("http://127.0.0.1/admin", { allowPrivate: false }),
        /Blocked SSRF/i,
        "P3-9: explicit allowPrivate:false must override AGY_DART_ALLOW_PRIVATE_URLS=1"
      );
    } finally {
      if (prevAllowPriv === undefined) delete process.env.AGY_DART_ALLOW_PRIVATE_URLS;
      else process.env.AGY_DART_ALLOW_PRIVATE_URLS = prevAllowPriv;
      resetConfigCache();
    }

    // P3-8: fetchUrlText exact-maxBodyBytes-chunk-boundary UTF-8 split must not emit U+FFFD
    const { fetchUrlText } = await import("../context/lib/tools.js");
    const cjkUtf8 = Buffer.from("中", "utf8");
    const exactBoundaryChunk = Buffer.concat([Buffer.alloc(99, 0x61), cjkUtf8.subarray(0, 1)]);
    const splitSrv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.write(exactBoundaryChunk);
      setTimeout(() => { try { res.end(cjkUtf8.subarray(1)); } catch {} }, 15);
    });
    await new Promise((r) => splitSrv.listen(0, "127.0.0.1", r));
    try {
      const splitBody = await fetchUrlText(`http://127.0.0.1:${splitSrv.address().port}/split`, {
        allowPrivate: true,
        maxBodyBytes: 100,
        timeoutMs: 3000
      });
      assert.equal(splitBody.includes("\uFFFD"), false, "P3-8: exact-boundary multi-byte UTF-8 split emitted U+FFFD");
      assert.equal(splitBody.length, 99);
    } finally {
      splitSrv.close();
    }

  } finally {
    try { store.close(); } catch {}
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-13, H-14, H-16, H-17, H-18, M-22..M-27, P3-5, P3-10, P3-11): SQLite store, config & handoff", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-store-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });

  try {
    // Seed default session so we can detect accidental purge fallthrough (H-13)
    store.indexContent({ sessionId: "default", worktree: tmpDir, kind: "file", label: "keep.txt", content: "DEFAULT_KEEP_99" });

    // H-13: invalid scope or missing required params must throw and NOT wipe default session
    assert.throws(() => store.purge({ scope: "invalid_scope" }), /Invalid purge scope/i);
    assert.throws(() => store.purge({ scope: "worktree", worktree: "" }), /worktree/i);
    assert.throws(() => store.purge({ scope: "app" }), /sinceTs/i);
    assert.equal(store.search({ queries: ["DEFAULT_KEEP_99"], sessionId: "default", scope: "session" }).hits.length, 1);

    // H-14: setExemptExtensions([".json"]) must NOT exempt entire 'code' category (.ts/.js)
    store.setExemptExtensions([".json"], "s-ex");
    const exCats = store.getExemptCategories("s-ex");
    assert.ok(!exCats.includes("code"), `H-14: .json wrongly exempted entire code category: ${JSON.stringify(exCats)}`);
    const exExts = store.getExemptExtensions("s-ex");
    assert.ok(exExts.includes(".json") && !exExts.includes(".ts"), `H-14: .ts wrongly exempted: ${JSON.stringify(exExts)}`);

    // H-16: cross-session getEventBySeq & search(sourceId + sessionId) isolation
    const evA = store.recordEvent({ sessionId: "sess-A", worktree: tmpDir, kind: "note", path: "a.txt", body: "SECRET_EVENT_A" });
    assert.equal(store.getEventBySeq(evA.seq, "sess-B"), null, "H-16: getEventBySeq leaked across sessions");
    assert.equal(store.getEventBySeq(evA.seq, "sess-A")?.body, "SECRET_EVENT_A");

    const srcA = store.indexContent({ sessionId: "sess-A", worktree: tmpDir, kind: "file", label: "a.md", content: "CROSS_SESSION_TOKEN_A" });
    assert.equal(
      store.search({ queries: ["CROSS_SESSION_TOKEN_A"], sourceId: srcA.sourceId, sessionId: "sess-B", scope: "session" }).hits.length,
      0,
      "H-16: sourceId bypassed session scope filter"
    );
    assert.equal(
      store.search({ queries: ["CROSS_SESSION_TOKEN_A"], sourceId: srcA.sourceId, sessionId: "sess-A", scope: "session" }).hits.length,
      1
    );

    // H-17: explicit sourceId replace cleans old chunks & dedup respects worktree
    store.indexContent({ sourceId: "explicit-1", sessionId: "sess-H17", worktree: "/wt1", kind: "file", label: "v1", content: "OLD_V1_ONLY_TOKEN" });
    store.indexContent({ sourceId: "explicit-1", sessionId: "sess-H17", worktree: "/wt1", kind: "file", label: "v2", content: "NEW_V2_ONLY_TOKEN" });
    assert.equal(store.search({ queries: ["OLD_V1_ONLY_TOKEN"], sessionId: "sess-H17", scope: "session" }).hits.length, 0, "H-17: stale chunk survived sourceId overwrite");
    assert.equal(store.search({ queries: ["NEW_V2_ONLY_TOKEN"], sessionId: "sess-H17", scope: "session" }).hits.length, 1);

    const d1 = store.indexContent({ sessionId: "sess-H17", worktree: "/wtA", kind: "file", label: "dup", content: "IDENTICAL_DEDUP_BODY", dedup: true });
    const d2 = store.indexContent({ sessionId: "sess-H17", worktree: "/wtB", kind: "file", label: "dup", content: "IDENTICAL_DEDUP_BODY", dedup: true });
    assert.notEqual(d1.sourceId, d2.sourceId, "H-17: dedup must not reuse sourceId across different worktrees");

    // H-18: purge({ scope: "worktree" }) must delete chunks_tri rows too
    const wtPurge = path.join(tmpDir, "wt-to-purge");
    const sp = store.indexContent({ sessionId: "sess-wt", worktree: wtPurge, kind: "file", label: "p.txt", content: "TRIGRAM_ORPHAN_CHECK_XYZ" });
    const beforeTri = store.db.prepare("SELECT COUNT(*) AS cnt FROM chunks_tri WHERE source_id = ?").get(sp.sourceId).cnt;
    assert.ok(beforeTri > 0);
    store.purge({ scope: "worktree", worktree: wtPurge });
    const afterTri = store.db.prepare("SELECT COUNT(*) AS cnt FROM chunks_tri WHERE source_id = ?").get(sp.sourceId).cnt;
    assert.equal(afterTri, 0, "H-18: purge(worktree) left orphan chunks_tri rows");

    // M-23: armReadBypass normalizes endLine: null -> -1
    const fakeFile = path.join(tmpDir, "read_target.ts");
    store.recordFileRead({ sessionId: "sess-m23", filePath: fakeFile, startLine: 1, endLine: null, mtimeMs: 1000, fileSize: 500 });
    store.armReadBypass({ sessionId: "sess-m23", filePath: fakeFile, startLine: 1, endLine: null });
    const dupRow = store.findDuplicateRead({ sessionId: "sess-m23", filePath: fakeFile, startLine: 1, endLine: null, mtimeMs: 1000, fileSize: 500 });
    assert.equal(Number(dupRow?.bypass_armed), 1, "M-23: armReadBypass failed to arm full-file row (endLine: null)");

    // M-24: setExemptCategories(..., "lifetime") writes to :global so new sessions inherit
    store.setExemptCategories(["documents"], "lifetime");
    assert.deepEqual(store.getExemptCategories("brand-new-session-99"), ["documents"], "M-24: lifetime exempt categories must persist globally");

    // P3-10: doctor().sqliteVersion is SQLite version (not Node version), getCutoff rejects NaN meta, LRU prune
    const doc = store.doctor();
    assert.notEqual(doc.sqliteVersion, process.versions.node, "P3-10: sqliteVersion must not return Node version");
    assert.match(String(doc.sqliteVersion), /^\d+\.\d+\.\d+/, `P3-10: unexpected sqliteVersion: ${doc.sqliteVersion}`);
    store.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("cutoff:global", "corrupted_nan");
    assert.equal(store.getCutoff(null), 46080, "P3-10: non-numeric cutoff:global meta must fall back to default 46080");

    // M-25: purge({ scope: "all" }) succeeds cleanly
    const purgeAll = store.purge({ scope: "all" });
    assert.equal(purgeAll.ok, true);

    // M-26 & P3-5: config.json UTF-8 BOM + reject blank/boolean/fractional-zero values
    const cfgPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      "\uFEFF" + JSON.stringify({
        maxReadBytes: "   ",
        diffReadMaxTurns: 0.5,
        maxLineRange: false,
        cacheTtlSec: 600
      }),
      "utf8"
    );
    resetConfigCache();
    const cfg = getEffectiveConfig({ configPath: cfgPath, env: {}, reload: true });
    assert.equal(cfg.maxReadBytes, null, "M-26: blank string maxReadBytes must not become 0");
    assert.equal(cfg.diffReadMaxTurns, 12, "M-26: 0.5 diffReadMaxTurns must not floor to 0");
    assert.equal(cfg.maxLineRange, null, "M-26: false maxLineRange must not become 0");
    assert.equal(cfg.cacheTtlSec, 600, "P3-5: BOM-prefixed config.json valid field must load");
    resetConfigCache();

    // M-27 & H-3: handoff null numerics & mixed-slash UNC blocking
    store.recordVerificationResult("sess-handoff", {
      kind: "test",
      command: "npm test",
      exitCode: null,
      passed: false,
      summary: "timed out"
    });
    const brief = buildHandoffBrief({
      store,
      sessionId: "sess-handoff",
      cwd: "/\\evil-host\\share",
      cacheDiag: {
        currentModel: "claude-sonnet-4",
        currentContextTokens: 50000,
        weightedHitRate: null,
        ttlRemainingSec: null,
        estimatedSavedUsd: null
      }
    });
    assert.ok(!brief.markdown.includes("(exit 0)"), `M-27: null exitCode printed as (exit 0): ${brief.markdown}`);
    assert.ok(!brief.markdown.includes("0.0%"), `M-27: null hitRate printed as 0.0%: ${brief.markdown}`);
    assert.ok(!brief.markdown.includes("0s left"), `M-27: null ttlRemainingSec printed as 0s left: ${brief.markdown}`);

    store.recordModifiedFiles("sess-unc", ["foo.js"], { worktree: "\\/evil-unc/share", tool: "edit_file" });
    assert.equal(inferWorkspaceFromStore(store, "sess-unc"), "", "H-3: mixed-slash UNC worktree must be rejected");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-6, H-19, H-20, H-21, H-22, M-1..M-6, P3-4): hooks & filter-rules", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-hooks-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const openStores = [];
  const openStore = () => {
    const s = new ContextModeStore({ dbPath: tmpDb });
    openStores.push(s);
    return s;
  };

  try {
    // H-6: inspectCommand bypasses & false positives
    const smallFile = path.join(tmpDir, "small.txt");
    const bigFile = path.join(tmpDir, "big.log");
    fs.writeFileSync(smallFile, "small\n", "utf8");
    fs.writeFileSync(bigFile, "x".repeat(25 * 1024), "utf8");

    const denyCases = [
      "curl https://example.com/api 2>/dev/null",
      "curl -o - https://example.com/api",
      "wget -O - https://example.com/api",
      `cat "${smallFile}" "${bigFile}"`
    ];
    for (const cmd of denyCases) {
      const r = runHook("pre-tool-use.mjs", { toolCall: { name: "run_command", args: { CommandLine: cmd } }, cwd: tmpDir }, tmpDb);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout.trim()).decision, "deny", `H-6: expected deny for '${cmd}'`);
    }

    const allowCases = [
      `cat -n "${smallFile}"`,
      "curl -o out.txt https://example.com/api"
    ];
    for (const cmd of allowCases) {
      const r = runHook("pre-tool-use.mjs", { toolCall: { name: "run_command", args: { CommandLine: cmd } }, cwd: tmpDir }, tmpDb);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout.trim()).decision, "allow", `H-6: expected allow for '${cmd}'`);
    }

    // H-21 & M-2: EndLine <= 0 on large file + literal %20 filename + file:// URI to .env
    const rEndZero = runHook("pre-tool-use.mjs", { toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 1, EndLine: 0 } } }, tmpDb);
    assert.equal(JSON.parse(rEndZero.stdout.trim()).decision, "deny", "M-2: EndLine: 0 must not bypass large-file guard");

    const pctFile = path.join(tmpDir, "report%20v1.log");
    fs.writeFileSync(pctFile, "y".repeat(25 * 1024), "utf8");
    const rPct = runHook("pre-tool-use.mjs", { toolCall: { name: "read_file", args: { Path: pctFile } } }, tmpDb);
    assert.equal(JSON.parse(rPct.stdout.trim()).decision, "deny", "H-21: literal %20 filename must not be URL-decoded away");

    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "SECRET=1\n", "utf8");
    const envUri = new URL(`file:///${envFile.replace(/\\/g, "/").replace(/^\/+/, "")}`).href;
    const rEnvUri = runHook(
      "pre-tool-use.mjs",
      { toolCall: { name: "read_file", args: { Path: envUri } } },
      tmpDb,
      { AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
    );
    assert.equal(JSON.parse(rEnvUri.stdout.trim()).decision, "deny", "H-21: file:// URI to .env must be denied");

    // H-19: End-to-end diffRead survives atomic-rename edit (new stat.ino!)
    const diffTarget = path.join(tmpDir, "service.js");
    const origLines = Array.from({ length: 120 }, (_, i) => `export const line_${i} = ${i}; // padding_text_here`);
    fs.writeFileSync(diffTarget, origLines.join("\n") + "\n", "utf8");
    const convDiff = "conv-h19-diff";
    const rRead1 = runHook(
      "pre-tool-use.mjs",
      { conversationId: convDiff, toolCall: { name: "read_file", args: { Path: diffTarget } } },
      tmpDb,
      { AGY_DART_ENABLE_DIFF_READ: "1" }
    );
    assert.equal(JSON.parse(rRead1.stdout.trim()).decision, "allow");

    // Atomic-rename edit (changes stat.ino on NTFS & POSIX!)
    const updatedLines = [...origLines];
    updatedLines[50] = "export const line_50 = 999999; // atomically edited";
    const tmpRename = path.join(tmpDir, "service.js.tmp");
    fs.writeFileSync(tmpRename, updatedLines.join("\n") + "\n", "utf8");
    fs.renameSync(tmpRename, diffTarget);

    const rRead2 = runHook(
      "pre-tool-use.mjs",
      { conversationId: convDiff, toolCall: { name: "read_file", args: { Path: diffTarget } } },
      tmpDb,
      { AGY_DART_ENABLE_DIFF_READ: "1" }
    );
    const outRead2 = JSON.parse(rRead2.stdout.trim());
    assert.equal(outRead2.decision, "deny", "H-19: atomic-rename edit should hit State-3 diffRead");
    assert.ok(outRead2.reason.includes("[agy-dart diff-read]"), `H-19: expected diff-read notice, got: ${outRead2.reason}`);
    assert.ok(outRead2.reason.includes("999999"), "H-19: unified diff should include changed line");

    // M-4: post-tool-use.mjs invalidates even when verify output contains "Dry run validated"
    const m4File = path.join(tmpDir, "m4.js");
    fs.writeFileSync(m4File, "export const a = 1;\n", "utf8");
    const stM4 = fs.statSync(m4File);
    const stStore = openStore();
    stStore.recordFileRead({
      sessionId: "conv-m4",
      filePath: m4File,
      startLine: 1,
      endLine: null,
      mtimeMs: stM4.mtimeMs,
      fileSize: stM4.size
    });
    stStore.close();

    const rPost = runHook(
      "post-tool-use.mjs",
      {
        conversationId: "conv-m4",
        cwd: tmpDir,
        toolCall: { name: "apply_edits", args: { cwd: tmpDir, edits: [{ path: "m4.js", hunks: [] }] } },
        toolResponse: "Applied edits to 1 file(s):\n- m4.js\n\nVerify output:\nTest passed: Dry run validated ok"
      },
      tmpDb
    );
    assert.equal(rPost.status, 0, rPost.stderr);
    const checkStore = openStore();
    assert.equal(
      checkStore.findDuplicateRead({ sessionId: "conv-m4", filePath: m4File, startLine: 1, endLine: null, mtimeMs: stM4.mtimeMs, fileSize: stM4.size }),
      null,
      "M-4: post-tool-use failed to invalidate file_reads when verify text contained 'Dry run validated'"
    );

    // H-20: Subagent session-start must NOT wipe session overrides; subagent pre-invocation must NOT clear parent file_reads
    checkStore.setPaused(true, "parent-h20");
    checkStore.recordFileRead({
      sessionId: "parent-h20",
      filePath: m4File,
      startLine: 1,
      endLine: null,
      mtimeMs: stM4.mtimeMs,
      fileSize: stM4.size
    });
    checkStore.close();

    const rSubStart = runHook(
      "session-start.mjs",
      { conversationId: "child-h20", rootConversationId: "parent-h20", cwd: tmpDir },
      tmpDb,
      { USERPROFILE: fakeHome, HOME: fakeHome }
    );
    assert.equal(rSubStart.status, 0, rSubStart.stderr);

    // Seed compacted transcript ONLY for child-h20
    const childLogDir = path.join(fakeHome, ".gemini", "antigravity", "brain", "child-h20", ".system_generated", "logs");
    fs.mkdirSync(childLogDir, { recursive: true });
    const t0 = Date.now() - 20000;
    fs.writeFileSync(
      path.join(childLogDir, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(t0).toISOString(), model: "claude-sonnet-4", input_tokens: 120000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(t0 + 5000).toISOString(), model: "claude-sonnet-4", input_tokens: 15000, cache_read_tokens: 0, output_tokens: 100 })
      ].join("\n") + "\n",
      "utf8"
    );

    const rSubInv = runHook(
      "pre-invocation.mjs",
      { conversationId: "child-h20", rootConversationId: "parent-h20", cwd: tmpDir },
      tmpDb,
      { USERPROFILE: fakeHome, HOME: fakeHome }
    );
    assert.equal(rSubInv.status, 0, rSubInv.stderr);

    const verifyH20 = openStore();
    assert.equal(verifyH20.isPaused("parent-h20"), true, "H-20: subagent session-start wiped parent paused override!");
    assert.ok(
      verifyH20.findDuplicateRead({ sessionId: "parent-h20", filePath: m4File, startLine: 1, endLine: null, mtimeMs: stM4.mtimeMs, fileSize: stM4.size }),
      "H-20: subagent compaction cleared parent file_reads!"
    );

    // M-1: compaction bust followed by later TTL bust still invalidates; missing created_at does not re-invalidate
    const m1Conv = "conv-m1-comp";
    const m1LogDir = path.join(fakeHome, ".gemini", "antigravity", "brain", m1Conv, ".system_generated", "logs");
    fs.mkdirSync(m1LogDir, { recursive: true });
    const m1Base = Date.now() - 900000;
    fs.writeFileSync(
      path.join(m1LogDir, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(m1Base).toISOString(), model: "claude-sonnet-4", input_tokens: 120000, cache_read_tokens: 100000, output_tokens: 100 }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(m1Base + 10000).toISOString(), model: "claude-sonnet-4", input_tokens: 15000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", created_at: new Date(m1Base + 600000).toISOString(), model: "claude-sonnet-4", input_tokens: 20000, cache_read_tokens: 0, output_tokens: 100 })
      ].join("\n") + "\n",
      "utf8"
    );
    verifyH20.recordFileRead({ sessionId: m1Conv, filePath: m4File, startLine: 1, endLine: null, mtimeMs: stM4.mtimeMs, fileSize: stM4.size });
    verifyH20.close();

    runHook("pre-invocation.mjs", { conversationId: m1Conv, cwd: tmpDir }, tmpDb, { USERPROFILE: fakeHome, HOME: fakeHome });
    const checkM1 = openStore();
    assert.equal(
      checkM1.findDuplicateRead({ sessionId: m1Conv, filePath: m4File, startLine: 1, endLine: null, mtimeMs: stM4.mtimeMs, fileSize: stM4.size }),
      null,
      "M-1: compaction bust masked by subsequent TTL bust failed to invalidate file_reads"
    );
    checkM1.close();

    // H-22, M-5, M-6, P3-4: filter-rules unit tests
    assert.equal(hasUnsafeShellSyntax("git status # comment"), true, "H-22: unquoted # must be flagged unsafe");
    assert.equal(hasUnsafeShellSyntax('git commit -m "fix #123"'), false, "H-22: quoted # should remain safe");

    const diffInput = [
      "diff --git a/a.sql b/a.sql",
      "--- a/a.sql",
      "+++ b/a.sql",
      "@@ -1,2 +1,2 @@",
      "--- old sql comment",
      "+++ added plus line",
      " SELECT 1;"
    ].join("\n");
    const filteredDiff = applyFilterRule("git-diff", diffInput, "", 0);
    assert.ok(filteredDiff.filteredText.includes("--- old sql comment"), `M-5: hunk line starting with '--- ' was swallowed: ${filteredDiff.filteredText}`);
    assert.ok(filteredDiff.filteredText.includes("+++ added plus line"), `M-5: hunk line starting with '+++ ' was swallowed: ${filteredDiff.filteredText}`);

    const parsedGit = parseGitSubcommand('git -C "a\\" log " status');
    assert.ok(parsedGit === null || parsedGit.subcommand === "status", `M-6: misparsed escaped quote as '${parsedGit?.subcommand}'`);

    assert.equal(isSafeRegex("一+丁+"), true, "P3-4: distinct CJK chars must not collide in single bucket");
    assert.equal(isSafeRegex("一+一+"), false, "P3-4: identical CJK repeated chars should still be flagged");
    const supportsRegexModifiers = (() => {
      try {
        new RegExp("(?-i:a)", "i");
        return true;
      } catch {
        return false;
      }
    })();
    if (supportsRegexModifiers) {
      assert.equal(isSafeRegex("(?-i:A|a)+"), true, "P3-4: ES2025 (?-i:A|a)+ is case-sensitive and unambiguous");
      assert.equal(isSafeRegex("(?i:A|a)+"), false, "P3-4: ES2025 (?i:A|a)+ is case-insensitive and ambiguous");
    } else {
      assert.equal(isSafeRegex("(?-i:A|a)+"), false, "P3-4: unsupported ES2025 modifier syntax must fail closed on Node 22");
    }
  } finally {
    for (const s of openStores) {
      try { s.close(); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-3, H-23, M-29, M-30, P3-1, P3-2, P3-3): Sidecar dashboard server & index.html client", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-sidecar-"));
  const tmpDb = path.join(tmpDir, "context.db");

  // H-3: mixed-slash UNC rejection
  assert.equal(resolveAllowedHandoffCwd("/\\evil-host\\share", [tmpDir]), "");
  assert.equal(resolveAllowedHandoffCwd("\\/evil-host/share", [tmpDir]), "");

  // P3-2: origin header without hostHeader must reject https://
  assert.equal(isAllowedOriginHeader("https://127.0.0.1"), false);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:47821"), true);

  const store = new ContextModeStore({ dbPath: tmpDb });
  store.setCutoff(32768, null);
  store.close();

  const port = 39920 + Math.floor(Math.random() * 400);
  const serverProc = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: tmpDb,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      SIDECAR_FORCE_HTTP: "1",
      PORT: String(port)
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sidecar startup timed out")), 6000);
      serverProc.stdout.on("data", (d) => {
        if (d.toString("utf8").includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited prematurely: ${code}`));
      });
    });

    const entryResp = await httpReq(port, "GET", "/", { Host: `127.0.0.1:${port}` });
    const token = entryResp.text.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");

    const baseHeaders = {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": token
    };

    // M-29: /api/search rejects >20 queries and non-string sourceId with HTTP 400
    const rTooMany = await httpReq(port, "POST", "/api/search", baseHeaders, {
      queries: Array.from({ length: 25 }, (_, i) => `q${i}`)
    });
    assert.equal(rTooMany.status, 400, `M-29: expected 400 for >20 queries, got ${rTooMany.status}`);

    const rBadType = await httpReq(port, "POST", "/api/search", baseHeaders, {
      queries: ["ok"],
      sourceId: { nested: "bad" }
    });
    assert.equal(rBadType.status, 400, `M-29: expected 400 for object sourceId, got ${rBadType.status}`);

    const rBadConv = await httpReq(port, "POST", "/api/paused", baseHeaders, {
      conversationId: ["not-a-string"],
      paused: true
    });
    assert.equal(rBadConv.status, 400, `M-29: expected 400 for array conversationId, got ${rBadConv.status}`);

    const rBadCwd = await httpReq(port, "POST", "/api/handoff", baseHeaders, {
      cwd: { nested: "bad" }
    });
    assert.equal(rBadCwd.status, 400, `M-29: expected 400 for object cwd on /api/handoff, got ${rBadCwd.status}`);

    // P3-1: scope=all normalizes to lifetime and returns globalCutoffBytes
    const rStatsAll = await httpReq(port, "GET", "/api/stats?scope=all", { Host: `127.0.0.1:${port}`, "X-Agy-Dart-Token": token });
    assert.equal(rStatsAll.status, 200);
    assert.equal(rStatsAll.json?.cutoffBytes, 32768, "P3-1: scope=all must read global cutoff");

    // H-23, M-30, P3-3: VM sandbox checks on sidecars/dashboard/index.html
    const html = readDashboardHtml();
    assert.ok(html.includes("!event.isComposing"), "P3-3: IME composition guard missing");
    assert.ok(html.includes("ch?.body"), "P3-3: null-safe ch?.body missing");

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch);

    const mockElements = new Map();
    const makeEl = (id) => {
      const classes = new Set();
      const el = {
        id,
        className: "",
        textContent: "",
        innerText: "",
        innerHTML: "",
        title: "",
        value: "16384",
        options: [],
        dataset: {},
        style: {},
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        removeChild() {},
        setAttribute() {},
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c)
        }
      };
      mockElements.set(id, el);
      return el;
    };

    let fetchMode = "fail500";
    let nativeFetchCount = 0;
    let lastPostedBody = null;
    const sandbox = {
      window: {
        location: { search: "" },
        addEventListener: () => {}
      },
      document: {
        getElementById: (id) => mockElements.get(id) || makeEl(id),
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => makeEl("tmp"),
        body: { appendChild: () => {}, removeChild: () => {} },
        execCommand: () => true
      },
      navigator: { clipboard: { writeText: async () => {} } },
      URLSearchParams,
      Headers: class { set() {} has() { return false; } },
      fetch: async (url, opts = {}) => {
        nativeFetchCount += 1;
        if (opts.body) {
          try { lastPostedBody = JSON.parse(opts.body); } catch {}
        }
        if (fetchMode === "fail500") {
          return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      console: { error: () => {}, log: () => {} },
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {}
    };
    vm.runInNewContext(scriptMatch[1], sandbox);

    // H-23(1): toggleActiveState rolls back isProtectionPaused on 500
    sandbox.updateActiveBadge(false);
    await sandbox.toggleActiveState();
    assert.equal(vm.runInNewContext("isProtectionPaused", sandbox), false, "H-23: toggleActiveState failed to roll back on HTTP 500");

    // H-23(2): changeCutoff rolls back select value on HTTP 500 (both with cachedStats and when cachedStats is null)
    const cutoffEl = sandbox.document.getElementById("cutoff-select");
    cutoffEl.options = [{ value: "0" }, { value: "16384" }, { value: "32768" }];
    sandbox.updateCutoffDropdown({ cutoffBytes: 16384 });
    vm.runInNewContext('cachedStats = { cutoffBytes: 16384 };', sandbox);
    cutoffEl.value = "32768";
    await sandbox.changeCutoff("32768");
    assert.equal(cutoffEl.value, "16384", "H-23: changeCutoff failed to roll back select value on HTTP 500");

    vm.runInNewContext('cachedStats = null;', sandbox);
    cutoffEl.value = "32768";
    await sandbox.changeCutoff("32768");
    assert.equal(cutoffEl.value, "16384", "H-23: changeCutoff failed to roll back select value on HTTP 500 when cachedStats is null");

    // H-23(3) & M-30: toggleCategory sends explicit enabled boolean and rolls back on HTTP 500
    vm.runInNewContext('cachedStats = { activeCategories: ["documents"], exemptCategories: ["documents"], exemptExtensions: [".pdf"], categoryMap: { documents: [".pdf"], code: [".js"] } };', sandbox);
    await sandbox.toggleCategory("code");
    assert.equal(lastPostedBody?.enabled, true, "M-30: toggleCategory must send explicit enabled boolean");
    assert.deepEqual(
      Array.from(vm.runInNewContext("cachedStats.activeCategories || cachedStats.exemptCategories", sandbox)),
      ["documents"],
      "H-23: toggleCategory failed to roll back on HTTP 500"
    );

    // M-30: apiFetch must NOT fall back to native fetch when window.sidecar.fetch throws
    nativeFetchCount = 0;
    sandbox.window.sidecar = {
      fetch: async () => { throw new Error("sidecar error"); }
    };
    await assert.rejects(() => sandbox.apiFetch("/api/config", { method: "POST" }), /sidecar error/);
    assert.equal(nativeFetchCount, 0, "M-30: apiFetch double-fired native fetch after window.sidecar.fetch threw");
    delete sandbox.window.sidecar;

    // M-30: syncKvTtlState caches _clockOffsetMs so re-render doesn't shift offset
    const kvObj = {
      transcriptFound: true,
      turnsWithUsage: 3,
      currentContextTokens: 25000,
      lastPlannerAt: new Date(Date.now() - 60000).toISOString(),
      cacheTtlSec: 300,
      serverNowMs: Date.now() + 2000
    };
    sandbox.syncKvTtlState(kvObj);
    const offset1 = kvObj._clockOffsetMs;
    assert.equal(typeof offset1, "number");
    sandbox.syncKvTtlState(kvObj);
    assert.equal(kvObj._clockOffsetMs, offset1, "M-30: _clockOffsetMs should stay cached on re-render");

    // M-30: loadHandoffBrief clears lastHandoffMarkdown on error
    vm.runInNewContext('lastHandoffMarkdown = "STALE_BRIEF";', sandbox);
    await sandbox.loadHandoffBrief();
    assert.equal(vm.runInNewContext("lastHandoffMarkdown", sandbox), "", "M-30: loadHandoffBrief must clear stale markdown on error");
  } finally {
    try { serverProc.kill(); } catch {}
    await new Promise((resolve) => serverProc.once("close", resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-24, H-25, M-17, M-28, P3-12, P3-13): cache analyzer, simulator, crusher, stable-json & repo-skeleton", () => {
  // H-24: OpenAI Responses API inclusive cached_tokens + top-level 0 not shadowing usage.*
  const u1 = extractStepTokenUsage({
    model: "gpt-4.1",
    cache_read_tokens: 0,
    usage: {
      input_tokens: 10000,
      input_tokens_details: { cached_tokens: 8000 },
      output_tokens: 500
    }
  });
  assert.equal(u1.cacheReadTokens, 8000, "H-24: Responses API input_tokens_details.cached_tokens missed");
  assert.equal(u1.inputTokens, 2000, "H-24: inclusive input_tokens was not subtracted by cached_tokens");

  const u2 = extractStepTokenUsage({
    model: "claude-sonnet-4",
    cache_read_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    usage: {
      input_tokens: 500,
      cache_read_input_tokens: 12000,
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 250 }
    }
  });
  assert.equal(u2.cacheReadTokens, 12000, "H-24: top-level 0 shadowed usage.cache_read_input_tokens");
  assert.equal(u2.outputTokens, 100, "H-24: top-level 0 shadowed usage.output_tokens");
  assert.equal(u2.thinkingTokens, 250, "H-24: top-level 0 shadowed usage.output_tokens_details.reasoning_tokens");

  // M-28: Opus 4.5 / 4.6 underscore model name pricing ($5.00, not $15.00)
  const opus46 = resolveModelProfile("claude_opus_4_6_thinking");
  assert.equal(opus46.inputPer1M, 5.0, `M-28: expected $5.00 for claude_opus_4_6_thinking, got ${opus46.inputPer1M}`);

  // H-25: Claude 0-bust trace without explicit cache_creation_tokens -> ttl-5m matches observed (0% delta)
  const tBase = Date.now() - 120000;
  const claudeSteps = [
    { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tBase).toISOString(), model: "claude-sonnet-4", input_tokens: 20000, cache_read_tokens: 0, output_tokens: 200 },
    { step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tBase + 15000).toISOString(), model: "claude-sonnet-4", input_tokens: 4000, cache_read_tokens: 20000, output_tokens: 200 },
    { step_index: 3, type: "PLANNER_RESPONSE", created_at: new Date(tBase + 30000).toISOString(), model: "claude-sonnet-4", input_tokens: 4000, cache_read_tokens: 24000, output_tokens: 200 }
  ];
  const sim = simulateCachePolicies([{ sessionId: "s-h25", steps: claudeSteps }]);
  assert.equal(sim.sessions, 1, "H-25: must simulate 1 non-empty session");
  const ttl5m = sim.policies.find((s) => s.id === "ttl-5m");
  assert.ok(ttl5m, "ttl-5m policy missing");
  assert.equal(ttl5m.deltaPctVsObserved, 0, `H-25: expected 0% delta for equivalent ttl-5m, got ${ttl5m.deltaPctVsObserved}%`);

  // M-28: multi-session avgTurnHitRate weighted by cacheableTurns
  const multi = analyzeMultipleSessionsCache([
    claudeSteps, // 2 warm hits + 1 cold >=4k -> ~0.563 avgTurnHitRate
    [
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tBase).toISOString(), model: "claude-sonnet-4", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 100 }
    ] // < 4000 tokens -> 0 cacheable turns (must NOT dilute avgTurnHitRate!)
  ]);
  const singleDiag = analyzeTranscriptCache(claudeSteps);
  assert.equal(multi.avgTurnHitRate, singleDiag.avgTurnHitRate, `M-28: 0-cacheable-turn session diluted avgTurnHitRate: ${multi.avgTurnHitRate} vs ${singleDiag.avgTurnHitRate}`);

  // P3-13: followingResults matched by tool_call_id when parallel results arrive out of order
  const oooSteps = [
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: new Date(tBase).toISOString(),
      model: "claude-sonnet-4",
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 200,
      tool_calls: [
        { id: "call-1", name: "read_file", args: { Path: "a.js" } },
        { id: "call-2", name: "run_command", args: { CommandLine: "npm test" } }
      ]
    },
    { step_index: 2, type: "TOOL_RESULT", tool_call_id: "call-2", status: "error", content: "BIG_FAIL_OUTPUT_".repeat(120) },
    { step_index: 3, type: "TOOL_RESULT", tool_call_id: "call-1", status: "ok", content: "tiny" },
    {
      step_index: 4,
      type: "PLANNER_RESPONSE",
      created_at: new Date(tBase + 10000).toISOString(),
      model: "claude-sonnet-4",
      input_tokens: 20000,
      cache_read_tokens: 10000,
      output_tokens: 200
    }
  ];
  const diagOoo = analyzeTranscriptCache(oooSteps);
  const deltaEntry = diagOoo.topContextDeltas?.[0];
  assert.ok(deltaEntry, "P3-13: expected topContextDeltas entry");
  assert.equal(
    deltaEntry.tool,
    "run_command",
    `P3-13: out-of-order tool_call_id attribution attributed delta to wrong tool: ${JSON.stringify(deltaEntry)}`
  );

  // M-1: readTranscriptTail expands past trailing huge non-usage tool result
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-ana-"));
  try {
    const bigTr = path.join(tmpDir, "tr.jsonl");
    const lines = [
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", model: "claude-sonnet-4", input_tokens: 10000, cache_read_tokens: 5000, output_tokens: 100 }),
      JSON.stringify({ step_index: 2, type: "TOOL_RESULT", content: "Z".repeat(140000) })
    ];
    fs.writeFileSync(bigTr, lines.join("\n") + "\n", "utf8");
    const tailSteps = readTranscriptTail(bigTr, 131072);
    assert.ok(tailSteps.some((s) => s.type === "PLANNER_RESPONSE"), "M-1: readTranscriptTail failed to expand past huge non-usage step");

    // M-28 & P3-12: stableSortObject circular refs + __proto__
    const circ = { a: 1 };
    circ.self = circ;
    assert.equal(stableSortObject(circ).self, "[Circular]", "P3-12: circular ref must not stack overflow");

    const protoObj = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const sortedProto = stableSortObject(protoObj);
    assert.ok(Object.hasOwn(sortedProto, "__proto__"), "M-28: stableSortObject dropped __proto__ key");
    assert.ok(stableStringify(protoObj).includes('"__proto__"'));

    // M-28 & P3-12: smartCrushJson _crushed override guard, __proto__, tiny maxBytes valid JSON, root array anomalies
    const crafted = JSON.stringify({ _crushed: false, items: Array.from({ length: 80 }, (_, i) => ({ id: i, msg: "x".repeat(80) })) });
    const crushed = smartCrushJson(crafted, { maxBytes: 1200 });
    assert.equal(crushed.crushed, true);
    const parsedCrushed = JSON.parse(crushed.text);
    assert.equal(typeof parsedCrushed._crushed, "object", "M-28: input '_crushed: false' overwrote metadata");

    const tinyCrushed = smartCrushJson(crafted, { maxBytes: 40 });
    assert.doesNotThrow(() => JSON.parse(tinyCrushed.text), `P3-12: tiny maxBytes produced invalid JSON: ${tinyCrushed.text}`);
    assert.ok(Buffer.byteLength(tinyCrushed.text, "utf8") <= 40);

    const arrWithNestedErr = JSON.stringify(
      Array.from({ length: 40 }, (_, i) =>
        i === 5
          ? { id: i, nested: { status: "error", detail: "boom" } }
          : { id: i, ok: true, pad: "p".repeat(60) }
      )
    );
    const crushedArr = smartCrushJson(arrWithNestedErr, { maxBytes: 800 });
    assert.doesNotThrow(() => JSON.parse(crushedArr.text));

    // M-17: repo-skeleton Python `from . import foo`, JS `"src/*"`, BOM tsconfig, `$` alias (`$$layout`)
    const repoDir = path.join(tmpDir, "skel-repo");
    fs.mkdirSync(path.join(repoDir, "pkg"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src", "$$layout"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "tsconfig.json"), '\uFEFF{ "compilerOptions": { "paths": { "$lib/*": ["src/*"] } } }\n', "utf8");
    fs.writeFileSync(path.join(repoDir, "src", "$$layout", "core.ts"), "export const core = 1;\n", "utf8");
    fs.writeFileSync(
      path.join(repoDir, "src", "entry.ts"),
      'const glob = "src/*";\nimport { core } from "$lib/$$layout/core";\nexport const x = [glob, core];\n',
      "utf8"
    );
    fs.writeFileSync(path.join(repoDir, "pkg", "helper.py"), "def h(): return 1\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "pkg", "app.py"), "from . import helper\n", "utf8");

    const skel = buildRepoHotspots(repoDir);
    const coreHub = skel.hubs.find((h) => h.path.endsWith("core.ts"));
    const pyHelperHub = skel.hubs.find((h) => h.path.endsWith("helper.py"));
    assert.ok(coreHub && coreHub.refs >= 1, `M-17: TS alias with $$layout and 'src/*' failed: ${JSON.stringify(skel.hubs)}`);
    assert.ok(pyHelperHub && pyHelperHub.refs >= 1, `M-17: Python 'from . import helper' failed: ${JSON.stringify(skel.hubs)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit P1/P2/P3 (H-2, H-26, M-31, M-32, M-33, P3-14, P3-15): install.mjs, cache-audit, prefix-budget & gen-review-brief", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-scripts-"));

  try {
    // H-2: install & uninstall reject repo root (including Windows uppercase drive variant), subdirs, and non-plugin dirs
    const installScript = path.join(ROOT, "scripts", "install.mjs");
    const repoCaseVariant = process.platform === "win32" ? ROOT.toUpperCase() : ROOT;

    const rInstSelf = spawnSync(process.execPath, [installScript, "install", "--target", repoCaseVariant], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rInstSelf.status, 0, "H-2: install must refuse targeting REPO_ROOT (case variant)");

    const rInstSub = spawnSync(process.execPath, [installScript, "install", "--target", path.join(ROOT, "fast")], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rInstSub.status, 0, "H-2: install must refuse targeting subdirectory of REPO_ROOT");

    const rInstDotDotName = spawnSync(process.execPath, [installScript, "install", "--target", path.join(ROOT, "..weird-subdir")], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rInstDotDotName.status, 0, "H-2: install must refuse targeting '..weird-subdir' inside REPO_ROOT");

    const rUninstParent = spawnSync(process.execPath, [installScript, "uninstall", "--target", path.dirname(ROOT)], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rUninstParent.status, 0, "H-2: uninstall must refuse targeting ancestor directory of REPO_ROOT");

    const rUninstSelf = spawnSync(process.execPath, [installScript, "uninstall", "--target", repoCaseVariant], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rUninstSelf.status, 0, "H-2: uninstall must refuse targeting REPO_ROOT (case variant)");
    assert.ok(fs.existsSync(path.join(ROOT, "package.json")), "H-2: repo must stay intact!");

    const randomDir = path.join(tmpDir, "not-a-plugin");
    fs.mkdirSync(randomDir, { recursive: true });
    fs.writeFileSync(path.join(randomDir, "important.txt"), "keep", "utf8");
    const rUninstRandom = spawnSync(process.execPath, [installScript, "uninstall", "--target", randomDir], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rUninstRandom.status, 0, "H-2: uninstall must refuse directory without agy-dart plugin.json");
    assert.ok(fs.existsSync(path.join(randomDir, "important.txt")));

    // M-31 & M-32: isolated install -> doctor passes -> delete critical file -> doctor fails (exit 1) -> restore -> uninstall
    const targetDir = path.join(tmpDir, "installed-plugin");
    const rInst = spawnSync(process.execPath, [installScript, "install", "--target", targetDir], { encoding: "utf8", windowsHide: true });
    assert.equal(rInst.status, 0, `Isolated install failed: ${rInst.stdout}\n${rInst.stderr}`);

    const rDocOk = spawnSync(process.execPath, [installScript, "doctor", "--target", targetDir], { encoding: "utf8", windowsHide: true });
    assert.equal(rDocOk.status, 0, `Doctor should pass on fresh install: ${rDocOk.stdout}`);

    const uiIndex = path.join(targetDir, "sidecars", "dashboard", "index.html");
    const savedUi = readDashboardHtml();
    fs.unlinkSync(uiIndex);
    const rDocMissing = spawnSync(process.execPath, [installScript, "doctor", "--target", targetDir], { encoding: "utf8", windowsHide: true });
    assert.notEqual(rDocMissing.status, 0, "M-31: doctor must fail when sidecars/dashboard/index.html is missing");
    fs.writeFileSync(uiIndex, savedUi, "utf8");

    const rUninstOk = spawnSync(process.execPath, [installScript, "uninstall", "--target", targetDir], { encoding: "utf8", windowsHide: true });
    assert.equal(rUninstOk.status, 0, `Uninstall failed: ${rUninstOk.stdout}\n${rUninstOk.stderr}`);
    assert.equal(fs.existsSync(targetDir), false);

    // H-26: static hook lexer accuracy
    const sLit = inspectHookSource('const doc = "systemMessage: Date.now()"; console.log("{}");', ".mjs");
    assert.equal(sLit.injectsDynamicSystemMessage, false, "H-26(1): string literal mention of systemMessage/Date.now must NOT trigger dynamic injection");
    assert.equal(sLit.writesNonEmptySystemMessage, false, "H-26(1): string literal must NOT count as non-empty systemMessage write");

    const sTpl = inspectHookSource('const x = `prefix ${(() => { return { a: 1 }; })().a}`;\nconst msg = "hi " + Date.now();\nconsole.log(JSON.stringify({ systemMessage: msg }));', ".mjs");
    assert.equal(sTpl.injectsDynamicSystemMessage, true, "H-26(2): nested template ${ { a: 1 } } must not blind scanner to trailing dynamic injection");

    const sMulti = inspectHookSource('const msg = "hello"\n  + Date.now();\nconsole.log(JSON.stringify({ systemMessage: msg }));', ".mjs");
    assert.equal(sMulti.injectsDynamicSystemMessage, true, "H-26(3): multiline expression with + Date.now() must be detected");

    const sMultiCrlf = inspectHookSource('const msg = "hello" +\r\n  Date.now();\r\nconsole.log(JSON.stringify({ systemMessage: msg }));', ".mjs");
    assert.equal(sMultiCrlf.injectsDynamicSystemMessage, true, "H-26(3): Windows CRLF multiline expression with +\\r\\n Date.now() must be detected");

    const sPs1 = inspectHookSource('$p = "C:\\temp\\" # systemMessage = Get-Date\nWrite-Output "{}"', ".ps1");
    assert.equal(sPs1.injectsDynamicSystemMessage, false, "H-26(4): PS1 trailing backslash inside string must not escape quote");

    const sPs1HereVerbatim = inspectHookSource("$banner = @'\n# systemMessage = Get-Date\n'@\nWrite-Output '{}'\n", ".ps1");
    assert.equal(sPs1HereVerbatim.injectsDynamicSystemMessage, false, "H-26(4): PS1 verbatim here-string must not false-positive");

    const sPs1HereUnbalanced = inspectHookSource('$banner = @"\nunbalanced " quote\n"@\n$ts = Get-Date\nWrite-Output "{\\"systemMessage\\": \\"$ts\\"}"\n', ".ps1");
    assert.equal(sPs1HereUnbalanced.injectsDynamicSystemMessage, true, "H-26(4): PS1 expandable here-string with inner quote must not blind trailing Get-Date");

    const sDefaultParam = inspectHookSource('function build(ts = Date.now()) { return String(ts); }\nconsole.log(JSON.stringify({ systemMessage: build() }));', ".mjs");
    assert.equal(sDefaultParam.injectsDynamicSystemMessage, true, "H-26(5): default param Date.now() in fn declaration must be detected");

    const sDefaultParamNoLeak = inspectHookSource('function f(ts = Date.now()) { return "static"; }\nfunction g(ts = "fixed") { return ts; }\nconsole.log(JSON.stringify({ systemMessage: g() }));', ".mjs");
    assert.equal(sDefaultParamNoLeak.injectsDynamicSystemMessage, false, "H-26(5): unused default param in f() must not taint unrelated g(ts)");

    const sInline = inspectHookSource('bash -c \'echo "{\\"systemMessage\\": \\"\'$(date)\'\\"}"\'', ".inline");
    assert.equal(sInline.injectsDynamicSystemMessage, true, "H-26(.inline): inline shell command injecting $(date) into systemMessage must be detected");

    // M-33: uninspected hook events (e.g. Stop) get status "not_inspected" using real { workspace, configDir } options
    const fakeWs = path.join(tmpDir, "audit-ws");
    fs.mkdirSync(path.join(fakeWs, ".gemini"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeWs, ".gemini", "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ command: "node -e \"console.log(1)\"" }] } }),
      "utf8"
    );
    const fakeCfgHome = path.join(tmpDir, "empty-home");
    fs.mkdirSync(fakeCfgHome, { recursive: true });
    const auditRep = await auditEnvironmentCache({
      workspace: fakeWs,
      configDir: fakeCfgHome,
      live: false
    });
    const stopEntry = auditRep.hooks.entries.find((e) => e.event === "Stop");
    assert.ok(stopEntry, "Stop hook entry missing from isolated workspace audit");
    assert.equal(stopEntry.status, "not_inspected", `M-33: expected not_inspected for Stop hook, got ${stopEntry.status}`);

    // M-33 live Windows .cmd MCP shim test: spaces, &, literal %OS% (no expansion), and quote rejection
    if (process.platform === "win32") {
      const shimDir = path.join(tmpDir, "mcp & shim dir");
      fs.mkdirSync(shimDir, { recursive: true });
      const argsLog = path.join(tmpDir, "shim_args.json");
      const echoMcp = path.join(shimDir, "echo-mcp.mjs");
      fs.writeFileSync(
        echoMcp,
        `import fs from "node:fs"; import readline from "node:readline";\n` +
          `fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\n` +
          `const rl = readline.createInterface({ input: process.stdin });\n` +
          `rl.on("line", (l) => { const m = JSON.parse(l); if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "shim" }, capabilities: {} } }) + "\\n"); else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "ok", inputSchema: { type: "object" } }] } }) + "\\n"); });\n`,
        "utf8"
      );
      const cmdShim = path.join(shimDir, "run mcp.cmd");
      fs.writeFileSync(cmdShim, `@echo off\r\n"${process.execPath}" "${echoMcp}" %*\r\n`, "utf8");
      fs.writeFileSync(
        path.join(fakeWs, ".gemini", "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            "win-shim-ok": { command: cmdShim, args: ["hello & world", "%OS%"] },
            "win-shim-bad-quote": { command: cmdShim, args: ['bad"quote'] }
          }
        }),
        "utf8"
      );
      const liveRep = await auditEnvironmentCache({
        workspace: fakeWs,
        configDir: fakeCfgHome,
        live: true,
        timeoutMs: 6000
      });
      const okSrv = liveRep.mcp.servers.find((s) => s.name === "win-shim-ok");
      const badSrv = liveRep.mcp.servers.find((s) => s.name === "win-shim-bad-quote");
      assert.equal(okSrv?.status, "ok", `M-33 live .cmd shim failed: ${JSON.stringify(okSrv)}`);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(argsLog, "utf8")),
        ["hello & world", "%OS%"],
        "M-33: .cmd shim must preserve & and NOT expand %OS%"
      );
      assert.equal(badSrv?.status, "error", "M-33: .cmd shim with embedded quote must be rejected");
    }

    // P3-14: cache-audit and prefix-budget estimateTokens are identical across EN/CJK/mixed
    for (const sample of ["", "Hello world!", "中文测试内容与代码混合 fooBar(123)", "a".repeat(97) + "中".repeat(13)]) {
      assert.equal(
        cacheAuditEstimateTokens(sample),
        prefixBudgetEstimateTokens(sample),
        `P3-14: token estimator divergence on '${sample.slice(0, 20)}'`
      );
    }

    // P3-15: countTestCasesInSource counts tests nested inside describe()/suite()
    const nestedTestSrc = `
      function helper() { test("not a top level test", () => {}); }
      describe("outer", () => {
        test("one", () => {});
        it("two", () => {
          test("inner call inside test body should not count", () => {});
        });
      });
      test("three", () => {});
    `;
    assert.equal(countTestCasesInSource(nestedTestSrc), 3, "P3-15: countTestCasesInSource must count describe()-nested tests");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit Edge Cases (C-1 live rollback, M-1 no-timestamp idempotency, M-3 stdin non-hang, H-22 cli-filter win32 quotes/CJK, M-32 --project DB isolation, P3-10 LRU prune)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-edge-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const openStores = [];
  const openStore = (dbPath = tmpDb) => {
    const s = new ContextModeStore({ dbPath });
    openStores.push(s);
    return s;
  };

  try {
    // 1. C-1 live rollback: File 1 edits existing file, File 2 fails inside commitPlannedWrites (parent is a regular file)
    const fastServer = path.join(ROOT, "fast", "mcp-server.mjs");
    const file1 = path.join(tmpDir, "first.txt");
    const blocker = path.join(tmpDir, "blocker.txt");
    fs.writeFileSync(file1, "ORIGINAL_FIRST_CONTENT\n", "utf8");
    fs.writeFileSync(blocker, "I am a regular file, not a dir\n", "utf8");

    const rollbackRes = await mcpSession(fastServer, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "apply_edits",
          arguments: {
            cwd: tmpDir,
            edits: [
              { path: "first.txt", hunks: [{ target: "ORIGINAL_FIRST_CONTENT", replacement: "MODIFIED_BEFORE_ROLLBACK" }] },
              { path: "blocker.txt/child.txt", create: "SHOULD_FAIL" }
            ]
          }
        }
      }
    ]);
    const rbMsg = rollbackRes.messages.find((m) => m.id === 2);
    assert.equal(rbMsg?.result?.isError, true, "C-1: batch with impossible nested create must fail");
    assert.equal(fs.readFileSync(file1, "utf8"), "ORIGINAL_FIRST_CONTENT\n", "C-1: File 1 was NOT rolled back to original bytes!");

    // 2. M-1: transcript compaction WITHOUT created_at invalidates once and does NOT re-invalidate on next turn
    const m1NoTsConv = "conv-m1-nots";
    const m1LogDir = path.join(fakeHome, ".gemini", "antigravity", "brain", m1NoTsConv, ".system_generated", "logs");
    fs.mkdirSync(m1LogDir, { recursive: true });
    fs.writeFileSync(
      path.join(m1LogDir, "transcript.jsonl"),
      [
        JSON.stringify({ type: "PLANNER_RESPONSE", model: "claude-sonnet-4", input_tokens: 120000, cache_read_tokens: 90000, output_tokens: 100 }),
        JSON.stringify({ type: "PLANNER_RESPONSE", model: "claude-sonnet-4", input_tokens: 16000, cache_read_tokens: 0, output_tokens: 100 })
      ].join("\n") + "\n",
      "utf8"
    );
    const st1 = fs.statSync(file1);
    const s1 = openStore();
    s1.recordFileRead({ sessionId: m1NoTsConv, filePath: file1, startLine: 1, endLine: null, mtimeMs: st1.mtimeMs, fileSize: st1.size });
    s1.close();

    runHook("pre-invocation.mjs", { conversationId: m1NoTsConv, cwd: tmpDir }, tmpDb, { USERPROFILE: fakeHome, HOME: fakeHome });
    const s2 = openStore();
    assert.equal(
      s2.findDuplicateRead({ sessionId: m1NoTsConv, filePath: file1, startLine: 1, endLine: null, mtimeMs: st1.mtimeMs, fileSize: st1.size }),
      null,
      "M-1: first turn after no-timestamp compaction must invalidate"
    );
    // Re-record file read, then invoke pre-invocation again on same transcript (no new compaction)
    s2.recordFileRead({ sessionId: m1NoTsConv, filePath: file1, startLine: 1, endLine: null, mtimeMs: st1.mtimeMs, fileSize: st1.size });
    s2.close();

    runHook("pre-invocation.mjs", { conversationId: m1NoTsConv, cwd: tmpDir }, tmpDb, { USERPROFILE: fakeHome, HOME: fakeHome });
    const s3 = openStore();
    assert.ok(
      s3.findDuplicateRead({ sessionId: m1NoTsConv, filePath: file1, startLine: 1, endLine: null, mtimeMs: st1.mtimeMs, fileSize: st1.size }),
      "M-1: second turn without new compaction must NOT re-invalidate file_reads!"
    );

    // 3. P3-10: pruneStaleSources evicts by accessed_ts (LRU), keeping recently accessed older source
    const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const srcKeep = s3.indexContent({ sessionId: "lru-s", worktree: tmpDir, kind: "file", label: "old-but-hot", content: "LRU_HOT_KEEP_TOKEN" });
    const srcEvict = s3.indexContent({ sessionId: "lru-s", worktree: tmpDir, kind: "file", label: "old-and-cold", content: "LRU_COLD_EVICT_TOKEN" });
    s3.db.prepare("UPDATE sources SET created_ts = ?, accessed_ts = ? WHERE id = ?").run(oldTs, Date.now(), srcKeep.sourceId);
    s3.db.prepare("UPDATE sources SET created_ts = ?, accessed_ts = ? WHERE id = ?").run(oldTs + 1000, oldTs + 1000, srcEvict.sourceId);
    s3.pruneStaleSources({ maxSourcesPerSession: 1, maxTotalSources: 10 });
    assert.equal(s3.search({ queries: ["LRU_HOT_KEEP_TOKEN"], sessionId: "lru-s", scope: "session" }).hits.length, 1, "P3-10: recently accessed source was wrongly pruned");
    assert.equal(s3.search({ queries: ["LRU_COLD_EVICT_TOKEN"], sessionId: "lru-s", scope: "session" }).hits.length, 0, "P3-10: cold stale source was not pruned");
    s3.close();

    // 4. M-3: post-tool-use.mjs exits cleanly when stdin stays open (never closed) instead of hanging forever
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, "hooks", "post-tool-use.mjs")], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
      });
      let out = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("M-3: hook hung with unclosed stdin!"));
      }, 5000);
      child.stdout.on("data", (d) => (out += d.toString("utf8")));
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          assert.equal(code, 0);
          assert.equal(out.trim(), "{}");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      // Deliberately do NOT call child.stdin.end()!
    });

    // 5. H-22: cli-filter.mjs preserves embedded double quotes inside single quotes (including quoted * and ?) & UTF-8 CJK on Windows
    const filterCmd = `node -e 'console.log("hi \\"quoted\\" *? 中文输出")'`;
    const b64Cmd = Buffer.from(filterCmd, "utf8").toString("base64");
    const rCli = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "cli-filter.mjs"), "--rule", "generic-pass", "--b64", b64Cmd, "--orig-b64", b64Cmd],
      {
        cwd: tmpDir,
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
      }
    );
    assert.equal(rCli.status, 0, `H-22 cli-filter failed: ${rCli.stderr}`);
    assert.ok(rCli.stdout.includes('hi "quoted" *? 中文输出'), `H-22 cli-filter mangled quotes/glob/CJK: ${JSON.stringify(rCli.stdout)}`);

    // 6. M-32: install.mjs --project sets skipDb=true and does NOT touch pre-existing DB cutoff
    const projDir = path.join(tmpDir, "my-proj");
    fs.mkdirSync(projDir, { recursive: true });
    const isoDb = path.join(tmpDir, "global-iso.db");
    const preDb = openStore(isoDb);
    preDb.setCutoff(8192, null);
    preDb.close();

    const rProj = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--project", projDir, "--mode", "fast-32k"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: isoDb }
      }
    );
    assert.equal(rProj.status, 0, `M-32 --project install failed: ${rProj.stdout}\n${rProj.stderr}`);
    const afterDb = openStore(isoDb);
    assert.equal(afterDb.getCutoff(null), 8192, "M-32: --project install overwrote global DB cutoff!");
    afterDb.close();
  } finally {
    for (const s of openStores) {
      try { s.close(); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test("Audit Verification Follow-ups (H-2 runInstall ancestor/root/non-empty guard, H-1 branch/tag optional-value flags, sidecar isPathInsideRoot '..foo')", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-followup-"));
  const installScript = path.join(ROOT, "scripts", "install.mjs");
  const fastServer = path.join(ROOT, "fast", "mcp-server.mjs");

  try {
    // 1. H-2: runInstall must refuse filesystem root, ancestor of REPO_ROOT, home/ancestor, non-empty non-plugin dir, and regular files
    const fsRoot = path.parse(ROOT).root;
    const rInstRoot = spawnSync(process.execPath, [installScript, "install", "--target", fsRoot], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstRoot.status, 0, "H-2: install must refuse filesystem root path");
    assert.match(rInstRoot.stderr, /protected directory/i);

    const repoParent = path.dirname(ROOT);
    const repoParentVariant = process.platform === "win32" ? repoParent.toUpperCase() : repoParent;
    const rInstAncestor = spawnSync(process.execPath, [installScript, "install", "--target", repoParentVariant], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstAncestor.status, 0, "H-2: install must refuse ancestor directory of REPO_ROOT");
    assert.match(rInstAncestor.stderr, /protected directory/i);
    assert.ok(fs.existsSync(path.join(ROOT, "package.json")), "H-2: REPO_ROOT must remain intact after refused ancestor install");

    const rInstHome = spawnSync(process.execPath, [installScript, "install", "--target", os.homedir()], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstHome.status, 0, "H-2: install must refuse os.homedir()");
    assert.match(rInstHome.stderr, /protected directory/i);

    const globalPluginsDir = path.join(os.homedir(), ".gemini", "config", "plugins");
    const rInstPluginsRoot = spawnSync(process.execPath, [installScript, "install", "--target", globalPluginsDir], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstPluginsRoot.status, 0, "H-2: install must refuse global plugins root directory");
    assert.match(rInstPluginsRoot.stderr, /protected directory/i);

    // H-2 symlink/junction escapes & broken symlinks
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const linkToRepo = path.join(tmpDir, "link-to-repo");
    const linkToParent = path.join(tmpDir, "link-to-parent");
    fs.symlinkSync(ROOT, linkToRepo, linkType);
    fs.symlinkSync(repoParent, linkToParent, linkType);
    for (const [label, linkPath] of [["REPO_ROOT", linkToRepo], ["REPO_ROOT parent", linkToParent]]) {
      for (const cmd of ["install", "uninstall"]) {
        const rLink = spawnSync(process.execPath, [installScript, cmd, "--target", linkPath], {
          encoding: "utf8",
          windowsHide: true
        });
        assert.notEqual(rLink.status, 0, `H-2: ${cmd} must refuse symlink/junction pointing to ${label}`);
        assert.match(rLink.stderr, /protected directory/i);
      }
    }

    const danglingTarget = path.join(tmpDir, "dangling-dir-target");
    const danglingLink = path.join(tmpDir, "dangling-link");
    fs.mkdirSync(danglingTarget, { recursive: true });
    fs.symlinkSync(danglingTarget, danglingLink, linkType);
    fs.rmdirSync(danglingTarget);
    const rInstDangling = spawnSync(process.execPath, [installScript, "install", "--target", danglingLink], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstDangling.status, 0, "H-2: install must refuse broken symlink / dangling junction");
    assert.match(rInstDangling.stderr, /broken symlink/i);

    // H-2 Windows-specific extended-length (\\?\), device (\\.\), UNC share root, GLOBALROOT, and 8.3 short-name guards
    if (process.platform === "win32") {
      const winProtectedTargets = [
        ["\\\\?\\REPO_ROOT", `\\\\?\\${ROOT}`],
        ["\\\\.\\REPO_ROOT", `\\\\.\\${ROOT}`],
        ["//?/REPO_ROOT", `//?/${ROOT.replace(/\\/g, "/")}`],
        ["\\\\?\\REPO_PARENT", `\\\\?\\${repoParent}`],
        ["\\\\.\\REPO_PARENT", `\\\\.\\${repoParent}`],
        ["\\\\?\\REPO_SUB", `\\\\?\\${path.join(ROOT, "nonexistent-subdir")}`],
        ["\\\\?\\home", `\\\\?\\${os.homedir()}`],
        ["\\\\.\\home", `\\\\.\\${os.homedir()}`],
        ["\\\\?\\C:\\", "\\\\?\\C:\\"],
        ["\\\\?\\C:", "\\\\?\\C:"],
        ["\\\\.\\C:\\", "\\\\.\\C:\\"],
        ["\\\\?\\UNC\\nonexistent-host-xyz\\share\\", "\\\\?\\UNC\\nonexistent-host-xyz\\share\\"],
        ["\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1"],
        ["\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\", "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\"]
      ];
      const tmpPrefixHome = os.tmpdir().split(path.sep).slice(0, 3).join(path.sep);
      if (tmpPrefixHome.includes("~") && fs.existsSync(tmpPrefixHome)) {
        try {
          if (fs.realpathSync.native(tmpPrefixHome).toLowerCase() === fs.realpathSync.native(os.homedir()).toLowerCase()) {
            winProtectedTargets.push(["8.3 short homedir", tmpPrefixHome]);
          }
        } catch {}
      }
      for (const [label, target] of winProtectedTargets) {
        for (const cmd of ["install", "uninstall"]) {
          const rWin = spawnSync(process.execPath, [installScript, cmd, "--target", target], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 8000
          });
          assert.notEqual(rWin.status, 0, `H-2 Windows: ${cmd} must refuse ${label}`);
          assert.match(rWin.stderr, /protected directory/i, `H-2 Windows: ${cmd} on ${label} must be stopped by protected-dir guard, got: ${rWin.stderr}`);
        }
      }
      assert.ok(fs.existsSync(path.join(ROOT, ".git")), "H-2 Windows: REPO_ROOT/.git must remain intact");
      assert.ok(fs.existsSync(path.join(ROOT, "package.json")), "H-2 Windows: REPO_ROOT/package.json must remain intact");
    }

    const nonEmptyOther = path.join(tmpDir, "unrelated-project");
    fs.mkdirSync(nonEmptyOther, { recursive: true });
    const keepFile = path.join(nonEmptyOther, "important.txt");
    fs.writeFileSync(keepFile, "do-not-delete", "utf8");
    const rInstNonEmpty = spawnSync(process.execPath, [installScript, "install", "--target", nonEmptyOther], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstNonEmpty.status, 0, "H-2: install must refuse non-empty directory without agy-dart plugin.json");
    assert.match(rInstNonEmpty.stderr, /non-empty directory/i);
    assert.equal(fs.readFileSync(keepFile, "utf8"), "do-not-delete", "H-2: refused install must not modify or delete existing files");

    const regularFile = path.join(tmpDir, "not-a-dir.txt");
    fs.writeFileSync(regularFile, "file-content", "utf8");
    const rInstFile = spawnSync(process.execPath, [installScript, "install", "--target", regularFile], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(rInstFile.status, 0, "H-2: install must refuse regular file target");
    assert.equal(fs.readFileSync(regularFile, "utf8"), "file-content");

    // Pre-created empty directory MUST still succeed, and in-place upgrade on existing agy-dart install must prune stale files
    const emptyTarget = path.join(tmpDir, "empty-target");
    fs.mkdirSync(emptyTarget, { recursive: true });
    const rInstEmpty = spawnSync(process.execPath, [installScript, "install", "--target", emptyTarget], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    assert.equal(rInstEmpty.status, 0, `H-2: install into empty dir failed: ${rInstEmpty.stdout}\n${rInstEmpty.stderr}`);
    const staleFile = path.join(emptyTarget, "stale-old-file.tmp");
    fs.writeFileSync(staleFile, "old", "utf8");
    const outsideVictimDir = path.join(tmpDir, "outside-victim");
    fs.mkdirSync(outsideVictimDir, { recursive: true });
    const victimFile = path.join(outsideVictimDir, "must-survive.txt");
    fs.writeFileSync(victimFile, "intact", "utf8");
    const staleLink = path.join(emptyTarget, "stale-link-to-outside");
    fs.symlinkSync(outsideVictimDir, staleLink, linkType);
    const rInstUpgrade = spawnSync(process.execPath, [installScript, "install", "--target", emptyTarget], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    assert.equal(rInstUpgrade.status, 0, `H-2: in-place upgrade failed: ${rInstUpgrade.stdout}\n${rInstUpgrade.stderr}`);
    assert.equal(fs.existsSync(staleFile), false, "H-2: in-place upgrade must prune stale file inside valid agy-dart dir");
    assert.equal(fs.existsSync(staleLink), false, "H-2: in-place upgrade must unlink stale symlink/junction");
    assert.equal(fs.readFileSync(victimFile, "utf8"), "intact", "H-2: pruning a stale symlink/junction must NEVER delete contents of its external target");

    // 2. H-1: fast/mcp-server git branch/tag optional-value flags vs optarg flags vs bypass rejection
    const gitRepo = path.join(tmpDir, "git-repo");
    fs.mkdirSync(gitRepo, { recursive: true });
    spawnSync("git", ["init"], { cwd: gitRepo, windowsHide: true });
    spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: gitRepo, windowsHide: true });
    spawnSync("git", ["config", "user.name", "t"], { cwd: gitRepo, windowsHide: true });
    fs.writeFileSync(path.join(gitRepo, "README.md"), "# follow-up\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: gitRepo, windowsHide: true });
    spawnSync("git", ["commit", "-m", "init"], { cwd: gitRepo, windowsHide: true });
    spawnSync("git", ["branch", "extra-branch"], { cwd: gitRepo, windowsHide: true });
    spawnSync("git", ["tag", "v1.0"], { cwd: gitRepo, windowsHide: true });

    const validBranchQueries = [
      "branch --merged",
      "branch --merged HEAD",
      "branch --no-merged",
      "branch --no-merged HEAD",
      "branch --contains",
      "branch --contains HEAD",
      "branch --no-contains",
      "branch --no-contains HEAD",
      "branch --points-at HEAD",
      "branch -a --merged",
      "branch --merged HEAD -a",
      "branch --merged=HEAD",
      "branch --merged HEAD --no-merged HEAD",
      "branch --list --merged HEAD extra*",
      "branch --color --list",
      "branch --color=never --merged HEAD",
      "branch --sort -committerdate --merged HEAD",
      "branch --list -- -D extra-branch",
      "branch --format -D --list"
    ];
    const validTagQueries = [
      "tag --merged",
      "tag --merged HEAD",
      "tag --no-merged",
      "tag --no-merged HEAD",
      "tag --contains",
      "tag --contains HEAD",
      "tag --no-contains",
      "tag --no-contains HEAD",
      "tag --points-at",
      "tag --points-at HEAD",
      "tag --merged=HEAD",
      "tag --list --merged HEAD v*",
      "tag --list -- -d v1.0"
    ];
    const noArgFlagFollowQueries = [
      "branch --merged -a",
      "branch --contains -a",
      "branch --merged --list -- -D extra-branch",
      "branch --sort -D --list"
    ];
    const rejectedBranchBypasses = [
      { pattern: "branch --merged -D extra-branch", expect: /not allowed/ },
      { pattern: "branch --no-merged -D extra-branch", expect: /not allowed/ },
      { pattern: "branch --merged --delete extra-branch", expect: /not allowed/ },
      { pattern: "branch --contains -D extra-branch", expect: /not allowed/ },
      { pattern: "branch --points-at -D extra-branch", expect: /not allowed/ },
      { pattern: "branch --points-at=HEAD new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --merged HEAD -D extra-branch", expect: /not allowed/ },
      { pattern: "branch --merged HEAD new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --merged=HEAD new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --merged -a new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --merged -- new-branch", expect: /Positional branch arguments/ },
      { pattern: "branch --color new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --color -D --color extra-branch", expect: /not allowed/ },
      { pattern: "branch --abbrev 7", expect: /Positional branch argument/ },
      { pattern: "branch --column never", expect: /Positional branch argument/ },
      { pattern: "branch --all=foo", expect: /not allowed/ },
      { pattern: "branch --sort=-committerdate new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --format=%(refname) new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --sort --list new-branch", expect: /Positional branch argument/ },
      { pattern: "branch --format -D extra-branch", expect: /Positional branch argument/ }
    ];
    const rejectedTagBypasses = [
      { pattern: "tag --merged -d v1.0", expect: /not allowed/ },
      { pattern: "tag --no-merged -d v1.0", expect: /not allowed/ },
      { pattern: "tag --merged --delete v1.0", expect: /not allowed/ },
      { pattern: "tag --contains -d v1.0", expect: /not allowed/ },
      { pattern: "tag --points-at -d v1.0", expect: /not allowed/ },
      { pattern: "tag --points-at=HEAD new-tag", expect: /Positional tag argument/ },
      { pattern: "tag --merged HEAD -d v1.0", expect: /not allowed/ },
      { pattern: "tag --merged HEAD new-tag", expect: /Positional tag argument/ },
      { pattern: "tag --merged=HEAD new-tag", expect: /Positional tag argument/ },
      { pattern: "tag --color new-tag", expect: /Positional tag argument/ },
      { pattern: "tag --color -d --color v1.0", expect: /not allowed/ },
      { pattern: "tag --column never", expect: /Positional tag argument/ },
      { pattern: "tag -n -d v1.0", expect: /not allowed/ },
      { pattern: "tag --list=foo", expect: /not allowed/ },
      { pattern: "tag --sort=-creatordate new-tag", expect: /Positional tag argument/ },
      { pattern: "tag --format=%(refname) new-tag", expect: /Positional tag argument/ }
    ];

    const mcpReqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "batch_search", arguments: { cwd: gitRepo, maxChars: 8800, queries: validBranchQueries.map((p) => ({ type: "git", pattern: p })) } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "batch_search", arguments: { cwd: gitRepo, maxChars: 8800, queries: validTagQueries.map((p) => ({ type: "git", pattern: p })) } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "batch_search", arguments: { cwd: gitRepo, maxChars: 8800, queries: noArgFlagFollowQueries.map((p) => ({ type: "git", pattern: p })) } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "batch_search", arguments: { cwd: gitRepo, maxChars: 8800, queries: rejectedBranchBypasses.map((q) => ({ type: "git", pattern: q.pattern })) } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "batch_search", arguments: { cwd: gitRepo, maxChars: 8800, queries: rejectedTagBypasses.map((q) => ({ type: "git", pattern: q.pattern })) } } }
    ];

    const mcpRes = await mcpSession(fastServer, mcpReqs, { AGY_DART_DB_PATH: path.join(gitRepo, "fast-git.db") });
    const getResultText = (id) => mcpRes.messages.find((m) => m.id === id)?.result?.content?.[0]?.text || "";
    const splitQuerySections = (text) => text.split(/^## Query /m).slice(1);

    const rValidBranch = getResultText(2);
    const validBranchSections = splitQuerySections(rValidBranch);
    assert.equal(validBranchSections.length, validBranchQueries.length, `Unexpected validBranch sections: ${rValidBranch}`);
    for (let i = 0; i < validBranchQueries.length; i++) {
      assert.ok(!validBranchSections[i].includes("ERROR:"), `H-1 valid query '${validBranchQueries[i]}' failed:\n${validBranchSections[i]}`);
    }
    assert.ok(validBranchSections[1].includes("extra-branch"), `branch --merged HEAD should list extra-branch:\n${validBranchSections[1]}`);

    const rValidTag = getResultText(3);
    const validTagSections = splitQuerySections(rValidTag);
    assert.equal(validTagSections.length, validTagQueries.length, `Unexpected validTag sections: ${rValidTag}`);
    for (let i = 0; i < validTagQueries.length; i++) {
      assert.ok(!validTagSections[i].includes("ERROR:"), `H-1 valid query '${validTagQueries[i]}' failed:\n${validTagSections[i]}`);
    }
    assert.ok(validTagSections[1].includes("v1.0"), `tag --merged HEAD should list v1.0:\n${validTagSections[1]}`);
    assert.ok(validTagSections[9].includes("v1.0"), `tag --points-at HEAD should list v1.0:\n${validTagSections[9]}`);

    const rNoArgFollow = getResultText(4);
    const noArgSections = splitQuerySections(rNoArgFollow);
    assert.equal(noArgSections.length, noArgFlagFollowQueries.length);
    for (let i = 0; i < noArgFlagFollowQueries.length; i++) {
      assert.ok(
        !/not allowed|Positional branch argument/i.test(noArgSections[i]),
        `H-1 '${noArgFlagFollowQueries[i]}' must not be falsely rejected by read-only flag validator:\n${noArgSections[i]}`
      );
    }

    const rRejBranch = getResultText(5);
    const rejBranchSections = splitQuerySections(rRejBranch);
    assert.equal(rejBranchSections.length, rejectedBranchBypasses.length);
    for (let i = 0; i < rejectedBranchBypasses.length; i++) {
      assert.ok(rejBranchSections[i].includes("ERROR:"), `H-1 bypass '${rejectedBranchBypasses[i].pattern}' must fail:\n${rejBranchSections[i]}`);
      assert.match(rejBranchSections[i], rejectedBranchBypasses[i].expect, `H-1 bypass '${rejectedBranchBypasses[i].pattern}' unexpected error:\n${rejBranchSections[i]}`);
    }

    const rRejTag = getResultText(6);
    const rejTagSections = splitQuerySections(rRejTag);
    assert.equal(rejTagSections.length, rejectedTagBypasses.length);
    for (let i = 0; i < rejectedTagBypasses.length; i++) {
      assert.ok(rejTagSections[i].includes("ERROR:"), `H-1 bypass '${rejectedTagBypasses[i].pattern}' must fail:\n${rejTagSections[i]}`);
      assert.match(rejTagSections[i], rejectedTagBypasses[i].expect, `H-1 bypass '${rejectedTagBypasses[i].pattern}' unexpected error:\n${rejTagSections[i]}`);
    }

    // Confirm zero repo mutation occurred (extra-branch & v1.0 intact, no new branches/tags created)
    const finalBranches = spawnSync("git", ["branch", "--list"], { cwd: gitRepo, encoding: "utf8", windowsHide: true }).stdout;
    assert.ok(finalBranches.includes("extra-branch"), `extra-branch was deleted! Branches: ${finalBranches}`);
    for (const forbidden of ["new-branch", "7", "never"]) {
      assert.ok(!finalBranches.includes(forbidden), `Forbidden branch '${forbidden}' was created! Branches: ${finalBranches}`);
    }
    const finalTags = spawnSync("git", ["tag", "--list"], { cwd: gitRepo, encoding: "utf8", windowsHide: true }).stdout;
    assert.ok(finalTags.includes("v1.0"), `v1.0 tag was deleted! Tags: ${finalTags}`);
    for (const forbidden of ["new-tag", "never"]) {
      assert.ok(!finalTags.includes(forbidden), `Forbidden tag '${forbidden}' was created! Tags: ${finalTags}`);
    }

    // 3. sidecars/dashboard/server.mjs isPathInsideRoot: allow valid '..foo' subdirectory, reject sibling '../..foo' and parent '..'
    const repoRoot = path.join(tmpDir, "ws-repo");
    const dotDotSub = path.join(repoRoot, "..foo");
    const dotDotNested = path.join(dotDotSub, "bar");
    const dotDotSibling = path.join(tmpDir, "..foo");
    fs.mkdirSync(dotDotNested, { recursive: true });
    fs.mkdirSync(dotDotSibling, { recursive: true });

    assert.equal(
      resolveAllowedHandoffCwd(dotDotSub, [repoRoot]),
      fs.realpathSync(dotDotSub),
      "isPathInsideRoot must allow valid subdirectory starting with '..' (e.g. '..foo')"
    );
    assert.equal(
      resolveAllowedHandoffCwd(dotDotNested, [repoRoot]),
      fs.realpathSync(dotDotNested),
      "isPathInsideRoot must allow nested directory under '..foo'"
    );
    assert.equal(
      resolveAllowedHandoffCwd(dotDotSibling, [repoRoot]),
      "",
      "isPathInsideRoot must reject sibling directory named '..foo' outside root"
    );
    assert.equal(
      resolveAllowedHandoffCwd(tmpDir, [repoRoot]),
      "",
      "isPathInsideRoot must reject parent directory ('..')"
    );
    assert.equal(
      resolveAllowedHandoffCwd(path.join(repoRoot, "..", "..foo"), [repoRoot]),
      "",
      "isPathInsideRoot must reject path traversal into sibling '..foo'"
    );

    const escapeFromDotDot = path.join(dotDotSub, "escape-outside");
    fs.symlinkSync(dotDotSibling, escapeFromDotDot, linkType);
    assert.equal(
      resolveAllowedHandoffCwd(escapeFromDotDot, [repoRoot]),
      "",
      "isPathInsideRoot must still reject symlink/junction inside '..foo' escaping root"
    );

    if (process.platform === "win32") {
      // Cross-format Windows 8.3 short-name vs canonical long-name path matching + short-name homedir block
      const longRepoRoot = fs.realpathSync.native(repoRoot);
      const longDotDotSub = fs.realpathSync.native(dotDotSub);
      assert.equal(
        resolveAllowedHandoffCwd(dotDotSub, [longRepoRoot]),
        fs.realpathSync(dotDotSub),
        "resolveAllowedHandoffCwd must allow valid '..foo' when candidate uses 8.3 short alias and root uses canonical long path"
      );
      assert.equal(
        resolveAllowedHandoffCwd(longDotDotSub, [repoRoot]),
        fs.realpathSync(longDotDotSub),
        "resolveAllowedHandoffCwd must allow valid '..foo' when candidate uses canonical long path and root uses 8.3 short alias"
      );
      assert.equal(
        resolveAllowedHandoffCwd(escapeFromDotDot, [longRepoRoot]),
        "",
        "resolveAllowedHandoffCwd must reject escaping junction inside '..foo' even under mixed 8.3/long root formats"
      );
      assert.equal(
        resolveAllowedHandoffCwd("Z:\\..foo", [repoRoot]),
        "",
        "isPathInsideRoot must reject path on different Windows drive"
      );
      const tmpPrefixHome = os.tmpdir().split(path.sep).slice(0, 3).join(path.sep);
      if (tmpPrefixHome.includes("~") && fs.existsSync(tmpPrefixHome)) {
        try {
          if (fs.realpathSync.native(tmpPrefixHome).toLowerCase() === fs.realpathSync.native(os.homedir()).toLowerCase()) {
            assert.equal(
              resolveAllowedHandoffCwd(tmpPrefixHome, [tmpPrefixHome]),
              "",
              "isUnsafeBroadRoot must reject Windows 8.3 short-name alias of os.homedir()"
            );
            assert.equal(
              resolveAllowedHandoffCwd(dotDotSub, [tmpPrefixHome]),
              "",
              "isUnsafeBroadRoot must reject Windows 8.3 short-name alias of os.homedir() as wildcard knownRoot"
            );
            const handoffDb = path.join(tmpDir, "handoff-short-home.db");
            const hStore = new ContextModeStore({ dbPath: handoffDb });
            try {
              hStore.indexContent({ sessionId: "s-short", worktree: tmpPrefixHome, kind: "note", label: "x", content: "hello" });
              assert.equal(
                inferWorkspaceFromStore(hStore, "s-short"),
                "",
                "handoff.js inferWorkspaceFromStore must reject Windows 8.3 short-name alias of os.homedir()"
              );
            } finally {
              hStore.close();
            }
          }
        } catch {}
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
