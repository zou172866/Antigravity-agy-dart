import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import { analyzeTranscriptCache } from "../context/lib/cache-analyzer.js";
import { simulateCachePolicies } from "../context/lib/cache-simulator.js";
import { getEffectiveConfig } from "../context/lib/config.js";
import { executeCode, isLikelyEsmCode, resolveExecTimeoutMs, runProcess } from "../context/lib/executor.js";
import { buildRepoHotspots } from "../context/lib/repo-skeleton.js";
import { detectSensitiveFile, sanitizeUrlForDisplay } from "../context/lib/security.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  isSafeRegex,
  matchFilterRule,
  resolveWindowsExeOnPath,
  tryParseSimpleCommand
} from "../hooks/filter-rules.mjs";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { inspectCommand } from "../hooks/pre-tool-use.mjs";
import { countTestCasesInSource } from "../scripts/gen-review-brief.mjs";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";
import { extractLocalSpecifiers, verifyPackageManifest } from "../scripts/verify-package-graph.mjs";
import { createStandaloneServer, registerSidecarRoutes } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(relHookPath, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, relHookPath)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `Hook ${relHookPath} exited ${res.status}: ${res.stderr}`);
  assert.equal(res.stderr, "", `Hook ${relHookPath} emitted stderr: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

function createNdjsonMcpClient(scriptPath, { cwd = ROOT, env = {} } = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  let buf = "";
  const pending = new Map();
  let nextId = 1;

  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed && parsed.id !== undefined && pending.has(parsed.id)) {
        const { resolve, rawLine } = pending.get(parsed.id);
        pending.delete(parsed.id);
        resolve({ msg: parsed, rawBytes: Buffer.byteLength(rawLine ? line : line, "utf8"), rawLine: line });
      }
    }
  });

  return {
    child,
    getStderr: () => stderr,
    request(method, params = {}, timeoutMs = 10000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms (stderr=${stderr})`));
        }, timeoutMs);
        pending.set(id, {
          rawLine: true,
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.stdin.end();
      } catch {}
      await new Promise((r) => {
        let killTimer = null;
        const hardTimer = setTimeout(() => {
          r();
        }, 3500);
        const onClose = () => {
          if (killTimer) clearTimeout(killTimer);
          clearTimeout(hardTimer);
          r();
        };
        child.once("close", onClose);
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill();
            } catch {
              child.off("close", onClose);
              clearTimeout(hardTimer);
              r();
            }
          }
        }, 500);
      });
    }
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

test("Long-Task 1: AGENTS.md & SKILL.md remove mid-task /compact prompt and expose long-command routing + cwd/timeoutSec schemas", async () => {
  const agentsMd = fs.readFileSync(path.join(ROOT, "rules", "AGENTS.md"), "utf8");
  const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");

  // Must NOT instruct proactive mid-task compaction at phase/cold boundaries
  assert.equal(/compact at cold\/phase boundaries/i.test(agentsMd), false);
  assert.equal(/compact at cold\/phase boundaries/i.test(skillMd), false);

  // Must forbid mid-task compaction pauses and document >60s / WaitMsBeforeAsync <= 2000 native run_command + timeoutSec
  assert.match(agentsMd, /Never pause mid-task/i);
  assert.match(agentsMd, /WaitMsBeforeAsync <= 2000/);
  assert.match(agentsMd, />60s/);
  assert.match(agentsMd, /timeoutSec\?: 1\.\.300/);
  assert.match(skillMd, /WaitMsBeforeAsync <= 2000/);
  assert.match(skillMd, /timeoutSec/);

  const budget = await auditPrefixBudget(ROOT);
  assert.equal(budget.blocks.tools.canonical, true);
  assert.ok(budget.totalTokens < 3150, `Turn-0 budget must stay lean (<3150), got ${budget.totalTokens}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lt-schema-"));
  const client = createNdjsonMcpClient(path.join(ROOT, "context", "server.js"), {
    env: { AGY_DART_DB_PATH: path.join(tmpDir, "context.db") }
  });
  try {
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    const { msg } = await client.request("tools/list", {});
    const byName = Object.fromEntries(msg.result.tools.map((t) => [t.name, t]));
    for (const toolName of ["ctx_batch", "ctx_doctor", "ctx_execute", "ctx_index", "ctx_purge", "ctx_search"]) {
      assert.equal(byName[toolName].inputSchema.properties.cwd.type, "string", `${toolName} must expose cwd`);
    }
    assert.equal(byName.ctx_execute.inputSchema.properties.timeoutSec.type, "integer");
    assert.equal(byName.ctx_execute.inputSchema.properties.timeoutSec.minimum, 1);
    assert.equal(byName.ctx_execute.inputSchema.properties.timeoutSec.maximum, 300);
    assert.equal(client.getStderr(), "");
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Long-Task 2: ctx_execute 120s default, timeoutSec 1..300 clamping, timedOut guidance, workspaceFolders CWD, ESM import, PS exitCode & UTF-8 slicing", async () => {
  assert.equal(getEffectiveConfig({ env: {}, configPath: path.join(os.tmpdir(), "nonexistent-cfg-xyz.json") }).execTimeoutMs, 120000);
  assert.equal(resolveExecTimeoutMs(undefined), 120000);
  assert.equal(resolveExecTimeoutMs(50), 1000);
  assert.equal(resolveExecTimeoutMs(999999), 300000);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lt-exec-"));
  const pluginFakeCwd = path.join(tmpDir, "fake-plugin-cwd");
  const workspaceDir = path.join(tmpDir, "real-workspace");
  fs.mkdirSync(pluginFakeCwd, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "docs", "guide.md"), "# Architecture\nWorkspace relative resolution works.\n", "utf8");
  const dbPath = path.join(tmpDir, "context.db");

  const client = createNdjsonMcpClient(path.join(ROOT, "context", "server.js"), {
    cwd: pluginFakeCwd,
    env: {
      AGY_DART_DB_PATH: dbPath,
      ANTIGRAVITY_WORKSPACE_ROOT: "",
      VSCODE_CWD: ""
    }
  });

  try {
    // 1. initialize with workspaceFolders URI aligns CWD away from pluginFakeCwd
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(workspaceDir).href, name: "real-workspace" }]
    });

    const idxRes = JSON.parse(
      (await client.request("tools/call", { name: "ctx_index", arguments: { path: "docs/guide.md" } })).msg.result.content[0].text
    );
    assert.equal(idxRes.chunkCount, 1, `Relative ctx_index failed: ${JSON.stringify(idxRes)}`);
    assert.equal(idxRes.label, "docs/guide.md");

    // 2. Top-level ESM import in ctx_execute + workspace CWD verification
    const esmRes = JSON.parse(
      (
        await client.request("tools/call", {
          name: "ctx_execute",
          arguments: {
            language: "javascript",
            code: "import path from 'node:path'; console.log('ESM_CWD=' + path.basename(process.cwd()));"
          }
        })
      ).msg.result.content[0].text
    );
    assert.equal(esmRes.ok, true, `ESM ctx_execute failed: ${esmRes.output}`);
    assert.match(esmRes.output, /ESM_CWD=real-workspace/);

    // 2b. Adversarial CJS scripts with regex quotes & nested/multiline templates containing `import ...` at col 0
    assert.equal(isLikelyEsmCode("const fs = require('node:fs'); const re = /'/; console.log('import x from \"y\"');"), false);
    assert.equal(isLikelyEsmCode("const fs = require('node:fs'); const s = `a ${\"`\"}\nimport x from 'y'`;"), false);
    assert.equal(isLikelyEsmCode("const fs = require('node:fs'); const tpl = `\nimport foo from 'bar'\nexport default 1\n`;"), false);
    assert.equal(isLikelyEsmCode("\uFEFF#!/usr/bin/env node\nimport path from 'node:path';"), true);

    const cjsTplRes = JSON.parse(
      (
        await client.request("tools/call", {
          name: "ctx_execute",
          arguments: {
            language: "nodejs",
            code: "const fs = require('node:fs'); const re = /'/; const tpl = `a ${\"`\"}\\nimport foo from 'bar'`; console.log('CJS_OK=' + typeof fs.readFileSync + ':' + re.test(\"'\") + ':' + tpl.length);"
          }
        })
      ).msg.result.content[0].text
    );
    assert.equal(cjsTplRes.ok, true, `CJS with regex/template must not inject --input-type=module: ${cjsTplRes.output}`);
    assert.match(cjsTplRes.output, /CJS_OK=function:true:/);

    // 2c. Pipelined NDJSON tools/call + immediate stdin EOF drains cleanly before store.close()
    const pipeRes = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(ROOT, "context", "server.js")], {
        cwd: workspaceDir,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (c) => { out += c.toString("utf8"); });
      p.stderr.on("data", (c) => { err += c.toString("utf8"); });
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, out, err }));
      p.stdin.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 77,
          method: "tools/call",
          params: {
            name: "ctx_execute",
            arguments: { cwd: workspaceDir, language: "nodejs", code: "setTimeout(() => console.log('EOF_DRAIN_OK'), 60);" }
          }
        }) + "\n"
      );
    });
    assert.equal(pipeRes.err, "");
    assert.match(pipeRes.out, /EOF_DRAIN_OK/);

    // 3. Explicit timeoutSec=1 terminates child + grandchild tree and returns timedOut: true + run_command hint
    const pidFile = path.join(tmpDir, "grandchild.pid");
    const slowCode = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), "utf8");
      setInterval(() => {}, 1000);
    `;
    const t0 = Date.now();
    const timeoutRes = JSON.parse(
      (
        await client.request(
          "tools/call",
          {
            name: "ctx_execute",
            arguments: { language: "nodejs", code: slowCode, timeoutSec: 1 }
          },
          15000
        )
      ).msg.result.content[0].text
    );
    const elapsed = Date.now() - t0;
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.timedOut, true);
    assert.ok(elapsed < 8000, `Expected timeout ~1s, took ${elapsed}ms`);
    assert.match(timeoutRes.output, /run_command/);
    assert.match(timeoutRes.output, /WaitMsBeforeAsync/);

    if (fs.existsSync(pidFile)) {
      const grandPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      for (let w = 0; w < 25 && isPidAlive(grandPid); w++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(isPidAlive(grandPid), false, `Grandchild PID ${grandPid} must be terminated on timeout`);
    }

    // 4. Multi-byte CJK + Emoji output crossing maxBytes preserves exact UTF-8 without U+FFFD
    const utf8Exec = await runProcess({
      cmd: process.execPath,
      args: ["-e", 'for (let i = 0; i < 40; i++) process.stdout.write("中文🚀边界".repeat(40));'],
      cwd: workspaceDir,
      maxBytes: 2048
    });
    assert.equal(utf8Exec.ok, true);
    assert.equal(utf8Exec.stdout.includes("\uFFFD"), false, "Must never emit U+FFFD replacement char");
    const bodyBeforeNotice = utf8Exec.stdout.split("\n... [stdout truncated")[0];
    assert.ok(
      Buffer.byteLength(bodyBeforeNotice, "utf8") >= 2044 && Buffer.byteLength(bodyBeforeNotice, "utf8") <= 2048,
      `Expected slice within 4 bytes of maxBytes=2048, got ${Buffer.byteLength(bodyBeforeNotice, "utf8")}`
    );

    // 5. Windows PowerShell args exitCode fidelity + zero __AGY_PS_* env leak + .bat execution
    if (process.platform === "win32") {
      const psRes = await executeCode({
        language: "powershell",
        code: 'Write-Output ("ARG=" + $args[0] + ";LEAK=" + $env:__AGY_PS_CODE + $env:__AGY_PS_ARG_0); exit 42',
        args: ["hello world"],
        cwd: workspaceDir
      });
      assert.equal(psRes.exitCode, 42);
      assert.equal(psRes.ok, false);
      assert.match(psRes.stdout, /ARG=hello world;LEAK=\r?\n?$/m);

      const batPath = path.join(tmpDir, "check-exit.bat");
      fs.writeFileSync(batPath, "@echo off\r\necho BAT_OK_%~1\r\nexit /b 17\r\n", "utf8");
      const batRes = await executeCode({
        language: "shell",
        file: batPath,
        args: ["PASS"],
        cwd: workspaceDir
      });
      assert.equal(batRes.exitCode, 17);
      assert.match(batRes.stdout, /BAT_OK_PASS/);
    }

    assert.equal(client.getStderr(), "");
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Long-Task 3: PreToolUse skips cli-filter on WaitMsBeforeAsync <= 2000, attaches read-only permissionOverrides on sync overwrite, kills signal trees & blocks flood bypasses", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lt-pretool-"));
  const dbPath = path.join(tmpDir, "context.db");
  const bigLog = path.join(tmpDir, "huge.log");
  fs.writeFileSync(bigLog, "x".repeat(25000), "utf8");

  try {
    // 1. WaitMsBeforeAsync <= 2000 bypasses cli-filter overwrite
    for (const waitMs of [500, 1500, 2000]) {
      const asyncRes = runHook(
        "hooks/pre-tool-use.mjs",
        {
          conversationId: "s-async",
          cwd: tmpDir,
          toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: waitMs } }
        },
        dbPath
      );
      assert.equal(asyncRes.decision, "allow");
      assert.equal(asyncRes.overwrite, undefined, `WaitMsBeforeAsync=${waitMs} must bypass cli-filter overwrite`);
    }

    // 2. WaitMsBeforeAsync > 2000 rewrites with strictly read-only plugin permissionOverrides (never ~/.agy-dart)
    const syncRes = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "s-async",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 8000 } }
      },
      dbPath
    );
    assert.equal(syncRes.decision, "allow");
    assert.ok(syncRes.overwrite?.CommandLine?.includes("cli-filter.mjs"));
    assert.ok(Array.isArray(syncRes.permissionOverrides) && syncRes.permissionOverrides.length === 1);
    assert.match(syncRes.permissionOverrides[0], /^read_file\(/);
    assert.equal(syncRes.permissionOverrides.some((p) => p.includes(".agy-dart")), false);

    // AGY_DART_CLI_FILTER_ASYNC_BYPASS_MS=0 disables async bypass
    const disabledBypass = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "s-async",
        cwd: tmpDir,
        toolCall: { name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 500 } }
      },
      dbPath,
      { AGY_DART_CLI_FILTER_ASYNC_BYPASS_MS: "0" }
    );
    assert.ok(disabledBypass.overwrite?.CommandLine?.includes("cli-filter.mjs"));

    // 3. Step 2b flood guards STILL block even when WaitMsBeforeAsync=500 + P1-08 bypasses
    const mustDenyCommands = [
      "git -c core.pager=cat log",
      "git --no-optional-locks log",
      `Get-Content -Delimiter "" "${bigLog}"`,
      `cd "${tmpDir}"; Get-Content "${bigLog}"`,
      `echo ready && cat "${bigLog}"`,
      'curl -s -H "X-Compare: a > b" https://example.com/huge.json'
    ];
    for (const cmd of mustDenyCommands) {
      const r = runHook(
        "hooks/pre-tool-use.mjs",
        {
          conversationId: "s-flood",
          cwd: tmpDir,
          toolCall: { name: "run_command", args: { CommandLine: cmd, WaitMsBeforeAsync: 500 } }
        },
        dbPath
      );
      assert.equal(r.decision, "deny", `Flood bypass command MUST be denied: ${cmd}`);
    }

    // Real unquoted output redirection on curl remains allowed
    const redirectedCurl = inspectCommand({
      commandLine: 'curl -s -H "X-Compare: a > b" https://example.com/huge.json > out.json',
      cwd: tmpDir,
      sessionId: "s-flood"
    });
    assert.equal(redirectedCurl.shouldDeny, false);

    // 4. P3-03: Single-line 46 KB minified file read with narrow StartLine=1, EndLine=5 is denied
    const minifiedJs = path.join(tmpDir, "bundle.min.js");
    fs.writeFileSync(minifiedJs, `var a="${"z".repeat(48000)}";\n`, "utf8");
    const rMinified = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "s-min",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: minifiedJs, StartLine: 1, EndLine: 5 } }
      },
      dbPath
    );
    assert.equal(rMinified.decision, "deny", "Single-line 48 KB narrow slice must be denied");

    // 5. P3-04: cli-filter.mjs --b64 execution & POSIX SIGTERM signal tree teardown
    const childPidFile = path.join(tmpDir, "filter-child.pid");
    const slowNodeScript = path.join(tmpDir, "slow-test.js");
    fs.writeFileSync(
      slowNodeScript,
      process.platform === "win32"
        ? `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); console.log("ok 1 - fast");\n`
        : `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
      "utf8"
    );
    const cmdB64 = Buffer.from(`"${process.execPath}" "${slowNodeScript}"`, "utf8").toString("base64");
    const sessB64 = `b:${Buffer.from("s-sig", "utf8").toString("base64url")}`;
    const filterProc = spawn(
      process.execPath,
      [path.join(ROOT, "hooks", "cli-filter.mjs"), "--rule", "test", "--session", sessB64, "--b64", cmdB64],
      {
        cwd: tmpDir,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(childPidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(fs.existsSync(childPidFile), true, "Child test script should have started");
    const spawnedTestPid = Number.parseInt(fs.readFileSync(childPidFile, "utf8").trim(), 10);
    if (process.platform !== "win32") {
      filterProc.kill("SIGTERM");
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      filterProc.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(isPidAlive(spawnedTestPid), false, "cli-filter child process must exit cleanly");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Long-Task 4: PreInvocation silences TTL & cold-compact banners during mid-turn tool loops (invocationNum >= 1) and scales 1M ttlMinContext to 300k", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lt-preinv-"));
  const dbPath = path.join(tmpDir, "context.db");
  const expiredAt = new Date(Date.now() - 600 * 1000).toISOString(); // 10 min ago

  try {
    // 1. Active tool-loop transcript (PLANNER_RESPONSE with tool_calls) at 130k on 200k model (warn + expired -> opportunistic_cold_compact)
    const toolLoopTranscript = path.join(tmpDir, "tool-loop.jsonl");
    fs.writeFileSync(
      toolLoopTranscript,
      [
        JSON.stringify({ type: "USER_INPUT", content: "Run full audit and fix everything" }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 2,
          created_at: expiredAt,
          model: "claude-sonnet-4-6",
          input_tokens: 130000,
          cache_read_tokens: 0,
          output_tokens: 500,
          tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }]
        }),
        JSON.stringify({ type: "TOOL_RESULT", content: "PASS" })
      ].join("\n") + "\n",
      "utf8"
    );

    // Mid-turn continuation (invocationNum: 1) -> MUST stay completely silent!
    const midTurnRes = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "lt-inv-mid", transcriptPath: toolLoopTranscript, invocationNum: 1 },
      dbPath,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(midTurnRes.injectSteps, undefined, "Mid-turn tool loop must suppress TTL & cold-compact handoff banners");

    // Turn entry (invocationNum: 0) on the same state -> emits warn + TTL alerts with empty systemMessage
    const entryRes = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "lt-inv-entry", transcriptPath: toolLoopTranscript, invocationNum: 0 },
      dbPath,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(entryRes.injectSteps?.length, 1);
    assert.equal(entryRes.injectSteps[0].systemMessage.systemMessage, "");
    const entryMd = entryRes.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(entryMd, /Handoff Brief/);
    assert.match(entryMd, /KV-cache TTL/);

    // Critical watermark (>= 85% = 170k on 200k model) STILL fires even during invocationNum >= 1!
    const critLoopTranscript = path.join(tmpDir, "crit-loop.jsonl");
    fs.writeFileSync(
      critLoopTranscript,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 5,
        created_at: expiredAt,
        model: "claude-sonnet-4-6",
        input_tokens: 180000,
        cache_read_tokens: 0,
        output_tokens: 400,
        tool_calls: [{ name: "read_file", args: { Path: "a.js" } }]
      }) + "\n",
      "utf8"
    );
    const critMidRes = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "lt-inv-crit", transcriptPath: critLoopTranscript, invocationNum: 3 },
      dbPath,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(critMidRes.injectSteps?.length, 1);
    const critMd = critMidRes.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(critMd, /critical watermark/);
    assert.equal(critMd.includes("Idle"), false, "TTL alert must still be suppressed at invocationNum=3");

    // 2. 1M window model (maxTokenLimit: 1,000,000 -> coldCompactTokens = 300,000):
    // 80k and 220k expired turns stay silent at invocationNum: 0; 320k triggers TTL alert!
    const store = new ContextModeStore({ dbPath });
    try {
      const diag80k = analyzeTranscriptCache([
        {
          type: "PLANNER_RESPONSE",
          created_at: expiredAt,
          model: "gemini-3-pro",
          maxTokenLimit: 1000000,
          input_tokens: 80000,
          cache_read_tokens: 0,
          output_tokens: 200
        }
      ]);
      assert.equal(diag80k.coldCompactTokens, 300000);
      assert.deepEqual(evaluateCacheAlerts(diag80k, { sessionId: "m1-80k", store, invocationNum: 0 }), []);

      const diag320k = analyzeTranscriptCache([
        {
          type: "PLANNER_RESPONSE",
          created_at: expiredAt,
          model: "gemini-3-pro",
          maxTokenLimit: 1000000,
          input_tokens: 320000,
          cache_read_tokens: 0,
          output_tokens: 200
        }
      ]);
      const alerts320k = evaluateCacheAlerts(diag320k, { sessionId: "m1-320k", store, invocationNum: 0 });
      assert.equal(alerts320k.length, 1);
      assert.match(alerts320k[0], /KV-cache TTL/);

      // 3. Aborted/cancelled turn or finish-only tool_calls sets inToolLoop=false so cumulative invocationNum >= 1 still alerts on next turn
      const diagFinish = analyzeTranscriptCache([
        {
          type: "PLANNER_RESPONSE",
          created_at: expiredAt,
          model: "claude-sonnet-4-6",
          input_tokens: 90000,
          cache_read_tokens: 0,
          output_tokens: 150,
          tool_calls: [{ name: "finish", args: {} }]
        }
      ]);
      assert.equal(diagFinish.inToolLoop, false, "finish pseudo-tool must not leave inToolLoop=true");
      const finishAlerts = evaluateCacheAlerts(diagFinish, { sessionId: "m-finish", store, invocationNum: 5 });
      assert.equal(finishAlerts.length, 1);
      assert.match(finishAlerts[0], /KV-cache TTL/);

      const diagCancelled = analyzeTranscriptCache([
        {
          type: "PLANNER_RESPONSE",
          created_at: expiredAt,
          model: "claude-sonnet-4-6",
          input_tokens: 90000,
          cache_read_tokens: 0,
          output_tokens: 150,
          tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }]
        },
        { type: "CANCELLED", content: "User cancelled mid-tool" }
      ]);
      assert.equal(diagCancelled.inToolLoop, false, "CANCELLED step must reset inToolLoop=false");
      const cancelAlerts = evaluateCacheAlerts(diagCancelled, { sessionId: "m-cancel", store, invocationNum: 8 });
      assert.equal(cancelAlerts.length, 1);
      assert.match(cancelAlerts[0], /KV-cache TTL/);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Long-Task 5: Step-decayed read deduplication (readDedupMaxSteps=40) & PostToolUse cross-session / subagent / ctx_resume(seq) precision", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lt-dedup-"));
  const dbPath = path.join(tmpDir, "context.db");
  const targetFile = path.join(tmpDir, "module.js");
  fs.writeFileSync(targetFile, "// module content\nexport const x = 1;\n".repeat(80), "utf8"); // ~3 KB (>= 1 KB)

  try {
    const stepDedupEnv = { AGY_DART_READ_DEDUP_MIN_BYTES: "1024" };

    // 1. Initial read at stepIdx=10 -> allow
    const r1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 10, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(r1.decision, "allow");

    // 2. Re-read at stepIdx=35 (gap 25 <= 40) -> 2-strike deny
    const r2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 35, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(r2.decision, "deny");
    assert.match(r2.reason, /read-dedup/);

    // 3. Retry at stepIdx=36 -> 2-strike bypass allow (refreshes read_step=36)
    const r3 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 36, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(r3.decision, "allow");

    // 4. Re-read at stepIdx=80 (80 - 36 = 44 > 40) -> auto-allows on FIRST try & refreshes read_step=80!
    const r4 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 80, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(r4.decision, "allow", "Read >40 steps after previous read must auto-allow without wasting a deny turn");

    // 5. Re-read at stepIdx=90 (90 - 80 = 10 <= 40) -> deduplicates again because read_step was refreshed to 80!
    const r5 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 90, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(r5.decision, "deny");
    // Reset confirm flag by completing 2nd strike at step 91
    assert.equal(
      runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-step", stepIdx: 91, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
        dbPath,
        stepDedupEnv
      ).decision,
      "allow"
    );

    // 6. P2-09: PostToolUse on read-only ctx_resume({ seq: 1 }) must NOT clear file_reads
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "s-step",
        cwd: tmpDir,
        toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_resume", Arguments: { seq: 1 } } }
      },
      dbPath
    );
    const afterSeqResume = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 95, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(afterSeqResume.decision, "deny", "Read-only ctx_resume({ seq }) must preserve session read cache");

    // 7. P2-09: Sibling subagent editing targetFile invalidates s-step's read cache across sessions
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "sibling-subagent-session",
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: targetFile } }
      },
      dbPath
    );
    const afterSiblingEdit = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-step", stepIdx: 96, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: targetFile } } },
      dbPath,
      stepDedupEnv
    );
    assert.equal(afterSiblingEdit.decision, "allow", "Sibling session edit must invalidate stale read-dedup entry");

    // 8. P2-09: metadata.isSubagent / role='subagent' isolates subagent reads from parent session
    const subRead = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "s-step",
        role: "subagent",
        metadata: { isSubagent: true },
        stepIdx: 97,
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: targetFile } }
      },
      dbPath,
      stepDedupEnv
    );
    assert.equal(subRead.decision, "allow", "Subagent first read must not collide with parent session read-dedup");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Audit Red-Team 6: Sensitive-file guard across symlinks/.envrc/*.env/ADS, git remote show SSRF block, and camelCase/SPA URL & checkpoint redaction", async () => {
  // 1. detectSensitiveFile extended device prefixes, ADS, .envrc & *.env
  assert.equal(detectSensitiveFile("/repo/.envrc").sensitive, true);
  assert.equal(detectSensitiveFile("/repo/prod.env").sensitive, true);
  assert.equal(detectSensitiveFile("/repo/.env.example").sensitive, false);
  if (process.platform === "win32") {
    assert.equal(detectSensitiveFile("\\\\?\\C:\\repo\\.env::$DATA").sensitive, true);
    assert.equal(detectSensitiveFile("\\\\.\\C:\\repo\\secrets.env:$DATA").sensitive, true);
  }

  // 2. sanitizeUrlForDisplay camelCase & SPA hash fragment tokens
  const cleanUrl = sanitizeUrlForDisplay(
    "https://api.example.com/oauth?clientSecret=my_sec_123&authToken=tok_abc#/callback?access_token=spa_secret_999&ok=1"
  );
  assert.equal(cleanUrl.includes("my_sec_123"), false);
  assert.equal(cleanUrl.includes("tok_abc"), false);
  assert.equal(cleanUrl.includes("spa_secret_999"), false);
  assert.ok(cleanUrl.includes("ok=1"));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-sec-"));
  const dbPath = path.join(tmpDir, "context.db");
  const envFile = path.join(tmpDir, ".env");
  fs.writeFileSync(envFile, "OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnop\n", "utf8");

  // Symlinked AGENTS.md -> .env (tests 0-SQLite fast-path bypass prevention!)
  const symlinkAgents = path.join(tmpDir, "AGENTS.md");
  let createdFileSymlink = false;
  try {
    fs.symlinkSync(envFile, symlinkAgents, "file");
    createdFileSymlink = true;
  } catch {}

  // Init git repo to test git remote show SSRF & --no-index blocks
  spawnSync("git", ["init", "-q"], { cwd: tmpDir, windowsHide: true });
  spawnSync("git", ["remote", "add", "origin", "https://127.0.0.1:1/unreachable-ssrf-probe.git"], {
    cwd: tmpDir,
    windowsHide: true
  });

  const fastClient = createNdjsonMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), {
    cwd: tmpDir,
    env: { AGY_DART_DB_PATH: dbPath, AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
  });

  try {
    if (createdFileSymlink) {
      const symRes = runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-sec", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: symlinkAgents } } },
        dbPath,
        { AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
      );
      assert.equal(symRes.decision, "deny", "Symlinked AGENTS.md -> .env MUST be blocked when sensitiveFileGuard=deny");
    }

    // Command dump of .env blocked under sensitiveFileGuard=deny even though .env is < 16 KB
    const catEnvRes = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-sec", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: "cat .env" } } },
      dbPath,
      { AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
    );
    assert.equal(catEnvRes.decision, "deny");

    // Adversarial command bypasses under sensitiveFileGuard=deny: Windows trailing path `\`, inline powershell/bash, & `$(...)` subshells
    const dirWithTrailingWinSlash = process.platform === "win32" ? `${tmpDir.replace(/[/\\]+$/, "")}\\` : tmpDir;
    const adversarialSecretCmds = [
      ...(process.platform === "win32"
        ? [
            `cd "${dirWithTrailingWinSlash}" ; Get-Content .env`,
            `cd "${dirWithTrailingWinSlash}" ; Get-Content ".env"`,
            'cmd /d /s /c "type .env"'
          ]
        : []),
      'powershell -NoProfile -Command "Write-Host `"a`"; Get-Content .env"',
      'powershell -Command "Get-Content .env"',
      "bash -c 'cat .env'",
      "echo $(cat .env)",
      'echo "$(cat .env)"',
      "Write-Output (Get-Content .env)"
    ];
    for (const advCmd of adversarialSecretCmds) {
      const rAdv = runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-sec-adv", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: advCmd } } },
        dbPath,
        { AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
      );
      assert.equal(rAdv.decision, "deny", `Adversarial secret dump MUST be denied: ${advCmd}`);
    }

    // Literal quoted text (no command substitution / no separate command segment) MUST NOT false-positive
    for (const safeLiteralCmd of ['powershell -Command "Write-Host `"a; cat .env`""', "echo '$(cat .env)'"]) {
      const rSafeLit = runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-sec-safe", cwd: tmpDir, toolCall: { name: "run_command", args: { CommandLine: safeLiteralCmd } } },
        dbPath,
        { AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
      );
      assert.equal(rSafeLit.decision, "allow", `Safe literal echo must not false-positive: ${safeLiteralCmd}`);
    }

    // ctx_execute({ file: ".env" }) blocked under sensitiveFileGuard=deny
    const store = new ContextModeStore({ dbPath });
    try {
      const prevGuard = process.env.AGY_DART_SENSITIVE_FILE_GUARD;
      process.env.AGY_DART_SENSITIVE_FILE_GUARD = "deny";
      try {
        const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "s-sec" });
        await assert.rejects(
          () => tools.ctx_execute({ language: "shell", file: envFile }),
          /sensitive file/i
        );
      } finally {
        if (prevGuard === undefined) delete process.env.AGY_DART_SENSITIVE_FILE_GUARD;
        else process.env.AGY_DART_SENSITIVE_FILE_GUARD = prevGuard;
      }
    } finally {
      store.close();
    }

    // fast/mcp-server.mjs blocks .env in read_slices & batch_search, blocks git remote show URL SSRF & diff --no-index
    await fastClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    const sliceEnv = (
      await fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, slices: [{ path: ".env", ranges: [[1, 5]] }] }
      })
    ).msg.result.content[0].text;
    assert.equal(sliceEnv.includes("sk-proj-"), false);
    assert.match(sliceEnv, /Blocked reading sensitive file/);

    const ssrfGit = (
      await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [
            { type: "git", pattern: "remote show https://127.0.0.1:1/ssrf.git" },
            { type: "git", pattern: "diff --no-index .env README.md" },
            { type: "git", pattern: "remote show origin" }
          ]
        }
      })
    ).msg.result.content[0].text;
    assert.match(ssrfGit, /Remote name 'https:\/\/127\.0\.0\.1:1\/ssrf\.git' is invalid or disallowed/);
    assert.match(ssrfGit, /Flag '--no-index' is not allowed/);
    // `remote show origin` is forced offline via `-n`, so it succeeds immediately without connecting to 127.0.0.1:1!
    assert.match(ssrfGit, /unreachable-ssrf-probe\.git/);

    // PostToolUse redacts inline secrets in verify command before writing to session_checkpoints
    const secretToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "s-redact-chk",
        cwd: tmpDir,
        toolCall: { name: "run_checks", args: { commands: [{ command: `npm test -- --token=${secretToken}` }] } },
        toolOutput: "Checks: 1/1 passed"
      },
      dbPath
    );
    const verifyStore = new ContextModeStore({ dbPath });
    try {
      const cp = verifyStore.getSessionCheckpoint("s-redact-chk");
      assert.equal(JSON.stringify(cp).includes(secretToken), false, "Checkpoint must redact secrets in verify command");
    } finally {
      verifyStore.close();
    }
  } finally {
    await fastClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Audit Red-Team 7: Cross-session isolation in MCP (ctx_search scope:null, sentinel sessionIds) & Sidecar (/api/search, null body, strict cutoff, /preload.js)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-iso-"));
  const dbPath = path.join(tmpDir, "context.db");
  const wsA = path.join(tmpDir, "ws-a");
  const wsB = path.join(tmpDir, "ws-b");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  process.env.AGY_DART_DB_PATH = dbPath;
  const store = new ContextModeStore({ dbPath });
  let standaloneSrv = null;
  try {
    store.indexContent({
      sessionId: "sess-alpha",
      worktree: wsA,
      title: "Alpha Secret Doc",
      content: "UNIQUE_ALPHA_CONFIDENTIAL_PAYLOAD_9911"
    });
    const evtAlpha = store.recordEvent({
      sessionId: "sess-alpha",
      worktree: wsA,
      kind: "exec",
      tool: "ctx_execute",
      ok: 1,
      exitCode: 0,
      bytes: 32,
      body: "ALPHA_EVENT_SECRET_BODY"
    });
    const seqAlpha = evtAlpha.seq;

    // 1. Store & MCP tools isolation: scope: null and sentinel sessionId='all'/'app'/'lifetime' must NOT leak sess-alpha
    assert.equal(store.search({ queries: ["UNIQUE_ALPHA_CONFIDENTIAL_PAYLOAD_9911"], scope: null, sessionId: "sess-beta" }).totalMatches, 0);
    assert.equal(store.getEventBySeq(seqAlpha, "app"), null);
    assert.equal(store.getEventBySeq(seqAlpha, "sess-beta"), null);

    const toolsBeta = createTools({ store, getCwd: () => wsB, getSessionId: () => "sess-beta" });
    const searchNullScope = await toolsBeta.ctx_search({ queries: ["UNIQUE_ALPHA_CONFIDENTIAL_PAYLOAD_9911"], scope: null });
    assert.equal(searchNullScope.totalMatches, 0, "scope: null must default to caller session, not global all");

    await assert.rejects(
      () => toolsBeta.ctx_resume({ sessionId: "all", seq: seqAlpha }),
      /not found/i
    );

    // 2. SidecarApp route handlers: null & array body safety across ALL 13 routes + conversation search isolation
    const registeredRoutes = new Map();
    const mockSidecarApp = {
      config: { conversationId: "sess-beta" },
      api(routePath, handler, method) {
        assert.equal(method, "POST", `SidecarApp route ${routePath} must be POST-only`);
        registeredRoutes.set(routePath, handler);
      }
    };
    registerSidecarRoutes(mockSidecarApp);
    assert.ok(registeredRoutes.size >= 13);
    for (const [routePath, handler] of registeredRoutes.entries()) {
      for (const badBody of [null, ["array-payload"], "primitive"]) {
        const res = await handler(badBody);
        assert.equal(res?.status, 400, `Route ${routePath} must return status 400 on ${JSON.stringify(badBody)}`);
      }
    }

    const betaConvHits = await registeredRoutes.get("/api/search")({
      query: "UNIQUE_ALPHA_CONFIDENTIAL_PAYLOAD_9911",
      scope: "conversation",
      conversationId: "sess-beta"
    });
    assert.equal(betaConvHits.hits.length, 0, "Sidecar /api/search scope='conversation' must isolate sess-beta");

    const alphaConvHits = await registeredRoutes.get("/api/search")({
      query: "UNIQUE_ALPHA_CONFIDENTIAL_PAYLOAD_9911",
      scope: "conversation",
      conversationId: "sess-alpha"
    });
    assert.equal(alphaConvHits.hits.length, 1);

    // 3. Standalone HTTP server: strict /api/cutoff validation, 0 cutoff persistence, and /preload.js 200 stub
    const csrfToken = "test-csrf-tok-999";
    standaloneSrv = createStandaloneServer({ csrfToken });
    await new Promise((resolve) => standaloneSrv.listen(0, "127.0.0.1", resolve));
    const port = standaloneSrv.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeaders = {
      "content-type": "application/json",
      "x-agy-dart-token": csrfToken
    };

    const nullHttpRes = await fetch(`${baseUrl}/api/search`, { method: "POST", headers: authHeaders, body: "null" });
    assert.equal(nullHttpRes.status, 400);

    for (const badCutoff of ["0x10", "0.5", [0], true, "16384px"]) {
      const badRes = await fetch(`${baseUrl}/api/cutoff`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ cutoff: badCutoff, scope: "conversation", conversationId: "sess-beta" })
      });
      assert.equal(badRes.status, 400, `Malformed cutoff ${JSON.stringify(badCutoff)} must return 400`);
    }

    const zeroRes = await fetch(`${baseUrl}/api/cutoff`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ cutoff: 0, scope: "conversation", conversationId: "sess-beta" })
    });
    assert.equal(zeroRes.status, 200);
    assert.equal((await zeroRes.json()).cutoffBytes, 0);

    const preloadResp = await fetch(`${baseUrl}/preload.js`);
    assert.equal(preloadResp.status, 200);
    assert.match(preloadResp.headers.get("content-type") || "", /javascript/);

    // /api/search, /api/stats, and /api/cutoff oversized >64 KB bodies return 413 cleanly via fetch() without ECONNRESET
    for (const ep of ["/api/search", "/api/stats", "/api/cutoff"]) {
      const hugeRes = await fetch(`${baseUrl}${ep}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ query: "x".repeat(70000) })
      });
      assert.equal(hugeRes.status, 413, `${ep} must return HTTP 413 without TCP RST`);
    }

    // 4. Frontend DOM & out-of-order polling/scope-switch race guards in sidecars/dashboard/index.html
    const htmlSource = readDashboardHtml();
    const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptBlocks.length >= 1, "index.html must contain main inline script");
    const mainUiScript = scriptBlocks[scriptBlocks.length - 1][1];

    const elements = new Map();
    const makeEl = (id) => ({
      id,
      value: id === "cutoff-select" ? "16384" : "",
      innerText: "",
      textContent: "",
      innerHTML: "",
      className: "",
      title: "",
      style: {},
      dataset: {},
      options:
        id === "cutoff-select"
          ? [{ value: "0" }, { value: "8192" }, { value: "16384" }, { value: "32768" }]
          : [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      getAttribute(attr) {
        return attr === "content" ? csrfToken : "";
      },
      scrollIntoView() {}
    });
    const getEl = (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    };

    const alertsSeen = [];
    const fetchLog = [];
    let customFetchHandler = null;
    const defaultStats = {
      isPaused: false,
      cutoffBytes: 0,
      conversationCutoffBytes: 0,
      appCutoffBytes: 16384,
      globalCutoffBytes: 16384,
      exemptCategories: ["images"],
      conversationExemptCategories: ["images"],
      appExemptCategories: ["images", "documents"],
      globalExemptCategories: ["images", "documents"],
      cliFilterEnabled: true,
      readDedupEnabled: true
    };
    const mockFetch = async (urlPath, opts = {}) => {
      fetchLog.push({ urlPath, opts });
      if (customFetchHandler) {
        const custom = await customFetchHandler(urlPath, opts);
        if (custom) return custom;
      }
      const mkJson = (obj, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => structuredClone(obj)
      });
      if (urlPath === "/api/stats") return mkJson(defaultStats);
      if (urlPath === "/api/doctor") return mkJson({ status: "HEALTHY", dbSizeBytes: 4096, walSizeBytes: 0 });
      if (urlPath === "/api/cache-diag") return mkJson({ transcriptFound: false, turnsWithUsage: 0 });
      if (urlPath === "/api/resume") return mkJson({ recentEvents: [], recentSources: [] });
      if (urlPath === "/api/search") return mkJson({ hits: [] });
      return mkJson({ ok: true });
    };

    const mockWin = {
      location: { search: "?conversationId=sess-ui-race" },
      addEventListener() {},
      sidecar: null
    };
    const sandbox = {
      window: mockWin,
      document: {
        title: "",
        documentElement: { lang: "en" },
        getElementById: getEl,
        querySelector: () => getEl("meta-csrf"),
        querySelectorAll: () => []
      },
      navigator: { language: "en-US", clipboard: { writeText: async () => {} } },
      localStorage: { getItem: () => "en", setItem: () => {} },
      URLSearchParams,
      Headers,
      fetch: mockFetch,
      alert: (m) => alertsSeen.push(m),
      confirm: () => true,
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      console: { log() {}, warn() {}, error() {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(
      `${mainUiScript}\nglobalThis.__uiTest = { refreshData, setScope, toggleActiveState, toggleCategory, addExemption, executeSearch, getState: () => ({ currentScope, refreshSeq, isProtectionPaused, cachedStats }) };`,
      sandbox
    );
    await new Promise((r) => setTimeout(r, 30));

    // Zero cutoff (0) must NOT fall back to 16384 in dropdown
    assert.equal(getEl("cutoff-select").value, "0", "Zero cutoff must render as '0', not fallback to '16384'");

    // Out-of-order stale poll started BEFORE toggleActiveState must NOT overwrite optimistic/confirmed pause state
    let resolveSlowStats = null;
    customFetchHandler = (urlPath) => {
      if (urlPath === "/api/stats" && !resolveSlowStats) {
        return new Promise((res) => {
          resolveSlowStats = () =>
            res({ ok: true, status: 200, json: async () => ({ ...defaultStats, isPaused: false }) });
        });
      }
      if (urlPath === "/api/toggle-active") {
        return { ok: true, status: 200, json: async () => ({ ok: true, isPaused: true }) };
      }
      return null;
    };
    const stalePollPromise = sandbox.__uiTest.refreshData(false);
    await new Promise((r) => setTimeout(r, 10));
    await sandbox.__uiTest.toggleActiveState();
    assert.equal(sandbox.__uiTest.getState().isProtectionPaused, true);
    resolveSlowStats();
    await stalePollPromise;
    assert.equal(
      sandbox.__uiTest.getState().isProtectionPaused,
      true,
      "Stale refreshData poll must be discarded when refreshSeq advanced during toggleActiveState"
    );
    customFetchHandler = null;

    // Cross-scope rollback isolation: toggleCategory('code') in 'lifetime' fails AFTER user switches to 'conversation'
    sandbox.__uiTest.setScope("lifetime");
    await new Promise((r) => setTimeout(r, 20));
    let rejectToggleCat = null;
    customFetchHandler = (urlPath) => {
      if (urlPath === "/api/exemptions") {
        return new Promise((_res, rej) => {
          rejectToggleCat = () => rej(new Error("Simulated 500 failure"));
        });
      }
      return null;
    };
    const toggleCatPromise = sandbox.__uiTest.toggleCategory("code");
    await new Promise((r) => setTimeout(r, 10));
    sandbox.__uiTest.setScope("conversation");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getEl("kv-handoff-meta").textContent, "--", "Closed handoff drawer resets meta to '--' on scope switch");
    rejectToggleCat();
    await toggleCatPromise;
    const afterRollbackStats = sandbox.__uiTest.getState().cachedStats;
    assert.deepEqual(
      afterRollbackStats.globalExemptCategories,
      ["images", "documents"],
      "Failed 'lifetime' toggleCategory must roll back globalExemptCategories"
    );
    assert.deepEqual(
      afterRollbackStats.conversationExemptCategories,
      ["images"],
      "Failed 'lifetime' rollback must NOT overwrite active 'conversation' scope categories"
    );
    customFetchHandler = null;

    // executeSearch sends { query, scope, conversationId } & addExemption rejects malformed extension
    getEl("search-input").value = "rate limit";
    fetchLog.length = 0;
    await sandbox.__uiTest.executeSearch();
    const searchCall = fetchLog.find((c) => c.urlPath === "/api/search");
    assert.ok(searchCall);
    assert.deepEqual(JSON.parse(searchCall.opts.body), {
      query: "rate limit",
      scope: "conversation",
      conversationId: "sess-ui-race"
    });

    getEl("new-exempt-input").value = "../evil/path";
    alertsSeen.length = 0;
    await sandbox.__uiTest.addExemption();
    assert.equal(alertsSeen.length, 1, "Invalid custom extension must trigger validation alert");
  } finally {
    if (standaloneSrv) {
      await new Promise((r) => standaloneSrv.close(() => r()));
    }
    store.close();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Audit Red-Team 8: fast/mcp-server.mjs <= 8,800 B escaped JSON-RPC cap, mixed LF/CRLF pipelining, ReDoS bounds & dangling symlink rollback", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-fast-"));
  const dbPath = path.join(tmpDir, "context.db");

  // File packed with JSON-escape-expanding quotes, backslashes, and astral emoji
  const escapeHeavyFile = path.join(tmpDir, "heavy.js");
  fs.writeFileSync(
    escapeHeavyFile,
    Array.from({ length: 260 }, (_, i) => `const s${i} = ${JSON.stringify('\\"'.repeat(30) + "🚀🔥")};`).join("\n") + "\n",
    "utf8"
  );

  const client = createNdjsonMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), {
    cwd: tmpDir,
    env: { AGY_DART_DB_PATH: dbPath }
  });

  try {
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

    // 1. P1-10: Escaped JSON-RPC frame MUST stay <= 8,800 UTF-8 bytes with zero lone surrogates
    const heavySlices = await client.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: tmpDir, maxChars: 8800, slices: [{ path: "heavy.js", ranges: [[1, 260]] }] }
    });
    assert.ok(
      heavySlices.rawBytes <= 8800,
      `Serialized JSON-RPC line must be <= 8800 B, got ${heavySlices.rawBytes} B`
    );
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(heavySlices.rawLine), false);

    // 50 validation errors in apply_edits must ALSO stay <= 8,800 B
    const manyErrors = await client.request("tools/call", {
      name: "apply_edits",
      arguments: {
        cwd: tmpDir,
        edits: Array.from({ length: 50 }, (_, idx) => ({
          path: `missing_${idx}_${"q".repeat(80)}.js`,
          hunks: [{ target: "a", replacement: "b" }]
        }))
      }
    });
    assert.ok(manyErrors.rawBytes <= 8800, `Error response exceeded 8800 B: ${manyErrors.rawBytes}`);

    // 2. P1-09: Adversarial brace-explosion glob & 40k-space Markdown heading complete in <250ms
    fs.writeFileSync(path.join(tmpDir, "aaaaaaaaaaaaaaaaaaaaaaaaaa.txt"), "hit\n", "utf8");
    const badMd = path.join(tmpDir, "heading.md");
    fs.writeFileSync(badMd, `# title${" ".repeat(40000)}x\n## Valid Section\nBody\n`, "utf8");

    const tGlob0 = performance.now();
    await client.request("tools/call", {
      name: "batch_search",
      arguments: {
        cwd: tmpDir,
        queries: [{ type: "glob", pattern: "{*a*,*a*}{*a*,*a*}{*a*,*a*}{*a*,*a*}{*a*,*a*}{*a*,*a*}z" }]
      }
    });
    const globElapsed = performance.now() - tGlob0;
    assert.ok(globElapsed < 500, `Adversarial glob took ${globElapsed.toFixed(1)}ms`);

    const tMd0 = performance.now();
    await client.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: tmpDir, outlines: ["heading.md"] }
    });
    assert.ok(performance.now() - tMd0 < 500);

    // Unanchored O(N^3) wildcard chain rejected by isSafeRegex
    assert.equal(isSafeRegex(".*a[^a]+b[^b]+c[^c]+d"), false);

    // 3. P1-13: Dangling symlink rollback in apply_edits restores original symlink when a later edit fails
    let canSymlink = false;
    const danglingLink = path.join(tmpDir, "dangling-cfg.txt");
    const missingTarget = path.join(tmpDir, "nonexistent-target-123.txt");
    try {
      fs.symlinkSync(missingTarget, danglingLink, "file");
      canSymlink = true;
    } catch {}
    if (canSymlink) {
      const blockedDir = path.join(tmpDir, "dir-collision");
      fs.mkdirSync(blockedDir, { recursive: true });
      const editResp = await client.request("tools/call", {
        name: "apply_edits",
        arguments: {
          cwd: tmpDir,
          edits: [
            { path: "dangling-cfg.txt", create: "overwritten text", overwrite: true },
            { path: "dir-collision", create: "will fail EISDIR", overwrite: true }
          ]
        }
      });
      assert.equal(editResp.msg.result.isError, true);
      const restoredLstat = fs.lstatSync(danglingLink);
      assert.equal(restoredLstat.isSymbolicLink(), true, "Rollback MUST restore dangling symlink, not leave file or delete it");
    }
  } finally {
    await client.close();
  }

  // 4. P1-12: Mixed Content-Length framing (\n\n followed immediately by \r\n\r\n in single chunk)
  const rawProc = spawn(process.execPath, [path.join(ROOT, "fast", "mcp-server.mjs")], {
    cwd: tmpDir,
    env: { ...process.env, AGY_DART_DB_PATH: dbPath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  try {
    const b1 = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "ping", params: {} }), "utf8");
    const b2 = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 102, method: "ping", params: {} }), "utf8");
    const combined = Buffer.concat([
      Buffer.from(`Content-Length: ${b1.length}\n\n`, "utf8"),
      b1,
      Buffer.from(`Content-Length: ${b2.length}\r\n\r\n`, "utf8"),
      b2
    ]);
    const collected = await new Promise((resolve, reject) => {
      let out = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error(`Mixed framing timed out; got: ${out.toString("utf8")}`)), 5000);
      rawProc.stdout.on("data", (chunk) => {
        out = Buffer.concat([out, chunk]);
        const s = out.toString("utf8");
        if (s.includes('"id":101') && s.includes('"id":102')) {
          clearTimeout(timer);
          resolve(s);
        }
      });
      rawProc.stdin.write(combined);
    });
    assert.ok(collected.includes('"id":101') && collected.includes('"id":102'));
  } finally {
    try {
      rawProc.stdin?.end();
    } catch {}
    if (rawProc.exitCode === null && rawProc.signalCode === null) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3500);
        rawProc.once("close", () => {
          clearTimeout(t);
          resolve();
        });
        try {
          rawProc.kill();
        } catch {
          clearTimeout(t);
          resolve();
        }
      });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
  }
});

test("Audit Red-Team 9: Windows PATH shim precedence, .cmd grandchild teardown, adversarial install.mjs, negative verify:pkg & simulator parity", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-sys-"));

  try {
    // 1. P1-07: tryParseSimpleCommand & Windows PATH shim precedence + cross-shell hazard bailout
    assert.deepEqual(tryParseSimpleCommand("echo 'don''t'"), { bin: "echo", args: ["don't"] });
    assert.deepEqual(tryParseSimpleCommand('node "E:\\repo\\"'), { bin: "node", args: ["E:\\repo\\"] });
    assert.deepEqual(tryParseSimpleCommand('node "\\\\server\\share"'), { bin: "node", args: ["\\\\server\\share"] });

    if (process.platform === "win32") {
      const dirEarly = path.join(tmpDir, "bin-early");
      const dirLate = path.join(tmpDir, "bin-late");
      fs.mkdirSync(dirEarly, { recursive: true });
      fs.mkdirSync(dirLate, { recursive: true });
      fs.writeFileSync(path.join(dirEarly, "mytool.cmd"), "@echo off\r\n", "utf8");
      fs.writeFileSync(path.join(dirLate, "mytool.exe"), "MZ", "utf8");
      const fakeEnv = { PATH: `${dirEarly};${dirLate}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" };
      assert.equal(
        resolveWindowsExeOnPath("mytool", tmpDir, fakeEnv),
        null,
        "Must NOT skip earlier directory's .cmd shim to run later directory's .exe"
      );
      assert.match(
        resolveWindowsExeOnPath("mytool", tmpDir, { PATH: `${dirLate};${dirEarly}`, PATHEXT: ".EXE;.CMD" }) || "",
        /bin-late[\\/]mytool\.exe$/i
      );

      // Unquoted comma, standalone `--`, and `'..."...'` bail out of matchFilterRule on Windows
      assert.equal(matchFilterRule("vitest run --project=chromium,firefox"), null);
      assert.equal(matchFilterRule("npm test -- --grep foo"), null);
      assert.equal(matchFilterRule("vitest run -t 'login \"admin\" flow'"), null);

      // P1-14: cache-audit.mjs probing a hanging .cmd MCP server terminates grandchild node.exe!
      const auditWs = path.join(tmpDir, "audit-ws");
      fs.mkdirSync(auditWs, { recursive: true });
      const grandPidPath = path.join(tmpDir, "mcp-grandchild.pid");
      const hangNodeJs = path.join(tmpDir, "hang-mcp.js");
      const hangCmd = path.join(tmpDir, "hang-mcp.cmd");
      fs.writeFileSync(
        hangNodeJs,
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(grandPidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
        "utf8"
      );
      fs.writeFileSync(hangCmd, `@echo off\r\n"${process.execPath}" "${hangNodeJs}"\r\n`, "utf8");
      const fakeCfgDir = path.join(tmpDir, "audit-cfg");
      fs.mkdirSync(fakeCfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(fakeCfgDir, "mcp_config.json"),
        JSON.stringify({ mcpServers: { hang_cmd_srv: { command: hangCmd, args: [] } } }),
        "utf8"
      );
      const auditStartNs = process.hrtime.bigint();
      const auditRun = spawnSync(
        process.execPath,
        [path.join(ROOT, "scripts", "cache-audit.mjs"), "--workspace", auditWs, "--config-dir", fakeCfgDir, "--timeout", "600", "--json"],
        { encoding: "utf8", windowsHide: true }
      );
      const auditElapsedMs = Number(process.hrtime.bigint() - auditStartNs) / 1e6;
      const grandExistsImmediately = fs.existsSync(grandPidPath);
      const leakedPid = grandExistsImmediately
        ? Number.parseInt(fs.readFileSync(grandPidPath, "utf8").trim(), 10)
        : NaN;
      const aliveAtExitMoment = Number.isInteger(leakedPid) && leakedPid > 0 ? isPidAlive(leakedPid) : null;
      const parsedAudit = JSON.parse(auditRun.stdout);
      assert.ok(parsedAudit && typeof parsedAudit === "object");
      assert.equal(
        grandExistsImmediately,
        true,
        `grandchild PID file must exist so P1-14 teardown is verified (not silently skipped); elapsed=${auditElapsedMs.toFixed(1)}ms`
      );
      assert.ok(Number.isInteger(leakedPid) && leakedPid > 0, `expected valid grandchild PID, got ${leakedPid}`);
      assert.equal(
        aliveAtExitMoment,
        false,
        `cache-audit.mjs must already have killed grandchild node.exe PID ${leakedPid} immediately on exit (0ms wait); elapsed=${auditElapsedMs.toFixed(1)}ms`
      );
      const hangServerProbe = parsedAudit?.mcp?.servers?.find?.((s) => s.name === "hang_cmd_srv");
      assert.equal(hangServerProbe?.status, "timeout", "hanging .cmd MCP probe must record timeout status");
      assert.ok(Number.isFinite(auditElapsedMs) && auditElapsedMs >= 0);
    }

    // 2. P1-05 & P1-06: install.mjs junction escape prevention, .git clone protection, --project doctor & self-uninstall
    const installScript = path.join(ROOT, "scripts", "install.mjs");
    const externalVictim = path.join(tmpDir, "external-victim");
    fs.mkdirSync(externalVictim, { recursive: true });
    const sentinelVictimFile = path.join(externalVictim, "DO_NOT_TOUCH.md");
    fs.writeFileSync(sentinelVictimFile, "precious external file", "utf8");

    const customPluginDir = path.join(tmpDir, "installed-plugin");
    const firstInstall = spawnSync(process.execPath, [installScript, "install", "--target", customPluginDir], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(firstInstall.status, 0, firstInstall.stderr);

    // Replace <customPluginDir>/rules with a symlink/junction pointing to externalVictim, then re-install!
    fs.rmSync(path.join(customPluginDir, "rules"), { recursive: true, force: true });
    fs.symlinkSync(externalVictim, path.join(customPluginDir, "rules"), process.platform === "win32" ? "junction" : "dir");

    const secondInstall = spawnSync(process.execPath, [installScript, "install", "--target", customPluginDir], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(secondInstall.status, 0, secondInstall.stderr);
    assert.equal(fs.existsSync(path.join(externalVictim, "AGENTS.md")), false, "Install must NOT write through junction into external dir");
    assert.equal(fs.existsSync(sentinelVictimFile), true, "pruneStaleEntries must NOT delete files inside external junction target");
    assert.equal(fs.lstatSync(path.join(customPluginDir, "rules")).isSymbolicLink(), false);

    // Secondary clone with .git + plugin.json MUST be refused on uninstall/install/mode
    const fakeSecondaryClone = path.join(tmpDir, "secondary-clone");
    fs.mkdirSync(path.join(fakeSecondaryClone, ".git"), { recursive: true });
    fs.writeFileSync(path.join(fakeSecondaryClone, "plugin.json"), JSON.stringify({ name: "agy-dart" }), "utf8");
    for (const subcmd of ["install", "uninstall", "mode"]) {
      const rClone = spawnSync(
        process.execPath,
        [installScript, subcmd, ...(subcmd === "mode" ? ["strict-8k"] : []), "--target", fakeSecondaryClone],
        { encoding: "utf8", windowsHide: true }
      );
      assert.notEqual(rClone.status, 0, `${subcmd} must refuse directory containing .git`);
    }

    // `--project doctor` must run doctor (not swallow 'doctor' as project path and install!)
    const emptyProj = path.join(tmpDir, "empty-proj");
    fs.mkdirSync(emptyProj, { recursive: true });
    const projDoctor = spawnSync(process.execPath, [installScript, "--project", "doctor"], {
      cwd: emptyProj,
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(projDoctor.status, 0);
    assert.equal(fs.existsSync(path.join(emptyProj, "doctor")), false, "--project doctor must NOT create ./doctor directory");

    // Self-uninstall from the installed copy (`node <customPluginDir>/scripts/install.mjs uninstall --target <customPluginDir>`)
    const selfUninstall = spawnSync(
      process.execPath,
      [path.join(customPluginDir, "scripts", "install.mjs"), "uninstall", "--target", customPluginDir],
      { cwd: customPluginDir, encoding: "utf8", windowsHide: true }
    );
    assert.equal(selfUninstall.status, 0, `Installed copy self-uninstall failed: ${selfUninstall.stderr}`);
    assert.equal(fs.existsSync(customPluginDir), false);

    // 3. P2-06: Negative verifyPackageManifest catches missing relative import & createRequire
    const crDir = path.join(tmpDir, "cr-test");
    fs.mkdirSync(crDir, { recursive: true });
    fs.writeFileSync(path.join(crDir, "depA.cjs"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(crDir, "depB.js"), "export default 2;\n", "utf8");
    const crFound = extractLocalSpecifiers(
      `import { createRequire } from "node:module";
       const customReq = createRequire(import.meta.url);
       const a = customReq("./depA");
       const b = createRequire(import.meta.url).resolve("./depB.js");`,
      path.join(crDir, "entry.mjs"),
      crDir
    );
    assert.deepEqual(crFound, ["depA.cjs", "depB.js"]);

    const brokenPkgRoot = path.join(tmpDir, "broken-pkg");
    for (const rel of ["hooks.json", "mcp_config.json", "sidecars/dashboard/sidecar.json", "scripts/install.mjs"]) {
      const dst = path.join(brokenPkgRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dst);
    }
    fs.writeFileSync(path.join(brokenPkgRoot, "scripts", "install.mjs"), 'import "./nonexistent-ghost.mjs";\n', "utf8");
    const brokenVerify = verifyPackageManifest(brokenPkgRoot);
    assert.equal(brokenVerify.ok, false);
    assert.ok(brokenVerify.unresolvedSpecifiers.some((s) => s.includes("./nonexistent-ghost.mjs")));

    // 4. P2-02 & P2-03: simulateCachePolicies wrapper support (sessions === 1), 1h implicit-write 0% delta & model_switch per-turn USD
    const tBase = Date.parse("2026-06-01T10:00:00Z");
    const iso = (sec) => new Date(tBase + sec * 1000).toISOString();
    const implicit1hSteps = [
      { type: "PLANNER_RESPONSE", created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 100000, cache_read_tokens: 0, output_tokens: 300 },
      { type: "PLANNER_RESPONSE", created_at: iso(900), model: "claude-sonnet-4-6", input_tokens: 5000, cache_read_tokens: 100000, output_tokens: 300 },
      { type: "PLANNER_RESPONSE", created_at: iso(1800), model: "claude-sonnet-4-6", input_tokens: 5000, cache_read_tokens: 105000, output_tokens: 300 }
    ];
    const sim = simulateCachePolicies([{ sessionId: "wrapped-1h", steps: implicit1hSteps }]);
    assert.equal(sim.sessions, 1, "Wrapper { sessionId, steps } object MUST be simulated, not filtered to 0");
    const ttl1hPolicy = Array.isArray(sim.policies)
      ? sim.policies.find((p) => p.id === "ttl-1h" || p.policyId === "ttl-1h")
      : sim.policies?.["ttl-1h"];
    assert.ok(ttl1hPolicy, `Missing ttl-1h policy in ${JSON.stringify(Object.keys(sim))}`);
    assert.equal(
      ttl1hPolicy.deltaUsdVsObserved,
      0,
      `Implicit 1h session replayed under ttl-1h must have 0 USD drift, got ${ttl1hPolicy.deltaUsdVsObserved}`
    );
    assert.equal(ttl1hPolicy.deltaPctVsObserved, 0);

    const switchDiag = analyzeTranscriptCache([
      { type: "PLANNER_RESPONSE", created_at: iso(0), model: "gemini-2.5-flash", input_tokens: 1000000, cache_read_tokens: 0, output_tokens: 100 },
      { type: "PLANNER_RESPONSE", created_at: iso(10), model: "claude-opus-4-6", input_tokens: 10000, cache_read_tokens: 0, output_tokens: 100 }
    ]);
    // 1M Flash tokens (~$0.30/1M) + 10k Opus tokens ($5-$15/1M) MUST stay < $1.00 (not $5-$15 as if all 1.01M were Opus!)
    assert.ok(
      switchDiag.estimatedInputCostUsd > 0 && switchDiag.estimatedInputCostUsd < 1.0,
      `model_switch must bill per-turn model price, got $${switchDiag.estimatedInputCostUsd}`
    );

    // P2-04: OpenAI-compatible gateway returning both input_tokens & prompt_tokens + cached_tokens must NOT double-count
    const oaiCompatDiag = analyzeTranscriptCache([
      {
        type: "PLANNER_RESPONSE",
        created_at: iso(0),
        model: "gpt-4.1",
        usage: {
          input_tokens: 50000,
          prompt_tokens: 50000,
          output_tokens: 200,
          prompt_tokens_details: { cached_tokens: 40000 }
        }
      }
    ]);
    assert.equal(oaiCompatDiag.currentContextTokens, 50000, "OpenAI gateway inclusive input_tokens must not double-count cached_tokens");

    // P2-05: loopWatch oscillations are NOT reset by read-only git diff / ctx_execute and ignore subagent steps
    const loopSteps = [
      { type: "PLANNER_RESPONSE", created_at: iso(0), input_tokens: 10000, output_tokens: 100, tool_calls: [{ id: "c1", name: "edit_file", args: { Path: "src/app.js" } }] },
      { type: "TOOL_RESULT", tool_call_id: "c1", content: "ok" },
      { type: "PLANNER_RESPONSE", created_at: iso(5), input_tokens: 10500, output_tokens: 100, tool_calls: [{ id: "c2", name: "run_command", args: { CommandLine: "npm test" } }] },
      { type: "TOOL_RESULT", tool_call_id: "c2", status: "ERROR", content: "Command exited with code 1" },
      { type: "PLANNER_RESPONSE", created_at: iso(10), input_tokens: 11000, output_tokens: 100, tool_calls: [{ id: "c3", name: "edit_file", args: { Path: "src/app.js" } }] },
      { type: "TOOL_RESULT", tool_call_id: "c3", content: "ok" },
      { type: "PLANNER_RESPONSE", created_at: iso(15), input_tokens: 11500, output_tokens: 100, tool_calls: [{ id: "c4", name: "run_command", args: { CommandLine: "git diff" } }] },
      { type: "TOOL_RESULT", tool_call_id: "c4", content: "diff --git a/src/app.js b/src/app.js" },
      { type: "PLANNER_RESPONSE", created_at: iso(20), input_tokens: 12000, output_tokens: 100, tool_calls: [{ id: "c5", name: "run_command", args: { CommandLine: "npm test" } }] },
      { type: "TOOL_RESULT", tool_call_id: "c5", status: "ERROR", content: "Command exited with code 1" }
    ];
    const loopDiag = analyzeTranscriptCache(loopSteps);
    assert.equal(loopDiag.loopWatch.editFailOscillations, 2, "git diff must NOT reset editFailOscillations");

    // 5. P3-07 & P3-08: repo-skeleton regex literal /[/*]/ + parameterized for-loop test counting + unknown CLI flag rejection + benchmark import guard
    const skelDir = path.join(tmpDir, "skel-regex");
    fs.mkdirSync(skelDir, { recursive: true });
    fs.writeFileSync(path.join(skelDir, "hub.js"), "export const h = 1;\n", "utf8");
    fs.writeFileSync(
      path.join(skelDir, "caller.js"),
      'const hasCommentChars = /[/*]/.test(str);\nimport { h } from "./hub.js";\nexport const c = h;\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(skelDir, "caller2.js"),
      'const re2 = /foo\\/[/*]+/g;\nimport { h } from "./hub.js";\nexport const c2 = h;\n',
      "utf8"
    );
    const hotspotRes = buildRepoHotspots(skelDir);
    assert.ok(hotspotRes.hubs.some((h) => h.path === "hub.js" && h.refs === 2), "Regex /[/*]/ must not swallow subsequent imports");

    const paramTestsCount = countTestCasesInSource(`
      for (const mode of ["a", "b"]) {
        test("param " + mode, () => {
          const fake = { test: () => {} };
        });
      }
      if (process.platform === "win32") {
        it("win case", () => {});
      } else {
        it("posix case", () => {});
      }
    `);
    assert.equal(paramTestsCount, 3);

    const badPrefixFlag = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--bogus-flag"], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(badPrefixFlag.status, 0);

    const badBriefFlag = spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-review-brief.mjs"), "--bogus-flag"], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(badBriefFlag.status, 0);

    const benchMod = await import("../fast/benchmark.mjs");
    const toolResMetrics = benchMod.analyzeTranscriptSessions([
      [
        {
          type: "PLANNER_RESPONSE",
          created_at: iso(0),
          input_tokens: 5000,
          output_tokens: 100,
          tool_calls: [{ name: "call_mcp_tool", args: { ServerName: "agy-dart_fast", ToolName: "batch_search" } }]
        },
        {
          type: "TOOL_RESULT",
          created_at: iso(1),
          content: "[truncated: showed 500 of 2000 chars]"
        }
      ]
    ]);
    assert.equal(toolResMetrics.agyTruncatedCalls, 1, "benchmark.mjs must recognize TOOL_RESULT steps");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
