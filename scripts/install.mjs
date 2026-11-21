#!/usr/bin/env node
import "../hooks/compile-cache.mjs";
import { spawn, spawnSync } from "node:child_process";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_NAME = "agy-dart";

const MODES = {
  "strict-8k": { cutoffBytes: 8192, readHook: true, label: "Strict (8 KB / 200 lines)" },
  "balanced-16k": { cutoffBytes: 16384, readHook: true, label: "Balanced Scheme A (16 KB / 410 lines, recommended)" },
  "fast-32k": { cutoffBytes: 32768, readHook: true, label: "Relaxed Scheme A (32 KB / 820 lines)" },
  "no-read-hook": { cutoffBytes: 16384, readHook: false, label: "Ultra-fast Scheme B (command guard only, no read_file hook)" }
};

export const RUNTIME_FILES = Object.freeze([
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "package.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.zh-CN.md",
  "assets/logo.svg",
  "rules/AGENTS.md",
  "skills/agy-dart/SKILL.md",
  "fast/mcp-server.mjs",
  "fast/session-start.mjs",
  "context/server.js",
  "context/lib/config.js",
  "context/lib/store.js",
  "context/lib/store/schema.js",
  "context/lib/store/fts.js",
  "context/lib/store/checkpoints.js",
  "context/lib/store/reads.js",
  "context/lib/store/settings-maintenance.js",
  "context/lib/executor.js",
  "context/lib/tools.js",
  "context/lib/cache/profiles.js",
  "context/lib/cache-analyzer.js",
  "context/lib/repo-skeleton.js",
  "context/lib/stable-json.js",
  "context/lib/security.js",
  "context/lib/text-diff.js",
  "context/lib/json-crusher.js",
  "context/lib/handoff.js",
  "hooks/compile-cache.mjs",
  "hooks/session-start.mjs",
  "hooks/pre-tool-use.mjs",
  "hooks/post-tool-use.mjs",
  "hooks/pre-invocation.mjs",
  "hooks/cli-filter.mjs",
  "hooks/filter-rules.mjs",
  "sidecars/dashboard/sidecar.json",
  "sidecars/dashboard/server.mjs",
  "sidecars/dashboard/index.html",
  "scripts/install.mjs"
]);

export const DEVTOOLS_FILES = Object.freeze([
  "fast/benchmark.mjs",
  "context/lib/cache-simulator.js",
  "scripts/cache-audit.mjs",
  "scripts/prefix-budget.mjs",
  "scripts/verify-package-graph.mjs",
  "scripts/gen-review-brief.mjs"
]);

export const FILES_TO_COPY = Object.freeze([...RUNTIME_FILES, ...DEVTOOLS_FILES]);

function getHomeDir() {
  return process.platform === "win32"
    ? process.env.USERPROFILE || process.env.HOME || os.homedir()
    : process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getGlobalPluginsRoot() {
  return path.join(getHomeDir(), ".gemini", "config", "plugins");
}

function checkNodeAndSqlite() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (major < 22) {
    throw new Error(`Node.js >= 22 (with built-in node:sqlite) is required. Current: v${process.versions.node}`);
  }
  return process.versions.node;
}

function hasCommand(bin, args = ["--version"]) {
  const res = spawnSync(bin, args, { stdio: "ignore", timeout: 3000, windowsHide: true });
  return !res.error && res.status === 0;
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "install";
  let targetDir = "";
  let projectDir = "";
  let mode = "balanced-16k";
  let installRg = false;
  let withDevtools = false;
  let showHelp = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      showHelp = true;
    } else if (a === "--install-rg") {
      installRg = true;
    } else if (a === "--with-devtools") {
      withDevtools = true;
    } else if (a === "--runtime-only") {
      withDevtools = false;
    } else if (a === "--mode") {
      const next = args[++i];
      if (!next || !MODES[next]) {
        throw new Error(`Invalid --mode '${next}'. Expected one of: ${Object.keys(MODES).join(", ")}`);
      }
      mode = next;
    } else if (a === "--target") {
      const next = args[++i];
      if (!next) throw new Error("Missing path after --target");
      targetDir = path.resolve(next);
    } else if (a === "--project") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        projectDir = path.resolve(args[++i]);
      } else {
        projectDir = process.cwd();
      }
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (positional.length >= 1) command = positional[0];
  if (command === "mode" && positional.length >= 2) {
    if (!MODES[positional[1]]) {
      throw new Error(`Unknown mode '${positional[1]}'. Expected one of: ${Object.keys(MODES).join(", ")}`);
    }
    mode = positional[1];
  }

  const isCustomTarget = Boolean(targetDir);
  if (!targetDir) {
    targetDir = projectDir
      ? path.join(projectDir, ".agents", "plugins", PLUGIN_NAME)
      : path.join(getGlobalPluginsRoot(), PLUGIN_NAME);
  }

  return { command, targetDir, isProject: Boolean(projectDir), isCustomTarget, mode, installRg, withDevtools, showHelp };
}

function printHelp() {
  console.log(`agy-dart installer & doctor

Usage:
  node scripts/install.mjs install [options]     Install agy-dart globally (default) or to a project
  node scripts/install.mjs doctor [options]      Verify both MCP servers, hooks, SQLite, Sidecar, config & rg
  node scripts/install.mjs mode <mode> [opts]    Switch protection mode (${Object.keys(MODES).join(" | ")})
  node scripts/install.mjs uninstall [options]   Remove installed agy-dart plugin

Options:
  --project [dir]        Install into <dir>/.agents/plugins/agy-dart
  --target <dir>         Install into a custom directory
  --mode <mode>          balanced-16k (default) | fast-32k | strict-8k | no-read-hook
  --with-devtools        Also copy offline CLI devtools (benchmark, cache-simulator, cache-audit, prefix-budget)
  --runtime-only         Install runtime files only (default)
  --install-rg           On Windows x64, download official ripgrep (rg.exe) to ~/.local/bin and add to PATH
  -h, --help             Show this help
`);
}

async function applyMode(targetDir, modeKey, skipDb = false) {
  const cfg = MODES[modeKey];
  const hooksPath = path.join(targetDir, "hooks.json");
  const hooksJson = {
    "agy-dart-lifecycle": {
      SessionStart: [
        {
          type: "command",
          command: "node ./hooks/session-start.mjs",
          timeout: 8
        }
      ],
      PreToolUse: [
        {
          matcher: cfg.readHook ? "run_command|read_file|view_file" : "run_command",
          hooks: [
            {
              type: "command",
              command: "node ./hooks/pre-tool-use.mjs",
              timeout: 10
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|.*apply_edits|.*run_checks|.*ctx_resume|call_mcp_tool",
          hooks: [
            {
              type: "command",
              command: "node ./hooks/post-tool-use.mjs",
              timeout: 5
            }
          ]
        }
      ],
      PreInvocation: [
        {
          type: "command",
          command: "node ./hooks/pre-invocation.mjs",
          timeout: 5
        }
      ]
    }
  };
  await fs.writeFile(hooksPath, JSON.stringify(hooksJson, null, 2) + "\n", "utf8");

  if (!skipDb) {
    const storeUrl = pathToFileURL(path.join(targetDir, "context", "lib", "store.js")).href;
    const { ContextModeStore } = await import(storeUrl);
    const store = new ContextModeStore();
    store.setCutoff(cfg.cutoffBytes, "lifetime");
    store.close();
  }
  return cfg;
}

function installRipgrepWindows() {
  if (hasCommand("rg", ["--version"])) {
    console.log("  - ripgrep (rg): already installed on PATH");
    return true;
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log("  - ripgrep (rg): please install via your package manager (brew install ripgrep / apt install ripgrep)");
    return false;
  }
  console.log("  - Installing official ripgrep (rg.exe) to ~/.local/bin ...");
  const psScript = `
$ErrorActionPreference = "Stop"
$tags = git ls-remote --tags --refs https://github.com/BurntSushi/ripgrep.git | ForEach-Object { ($_ -split "\`t")[1] -replace '^refs/tags/', '' } | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+$' }
$ver = ($tags | Sort-Object { [version]$_ } | Select-Object -Last 1)
if (-not $ver) { $ver = "15.2.0" }
$url = "https://github.com/BurntSushi/ripgrep/releases/download/$ver/ripgrep-$ver-x86_64-pc-windows-msvc.zip"
$tmp = Join-Path $env:TEMP ("agy-dart-rg-" + [guid]::NewGuid().ToString("N"))
$bin = Join-Path $env:USERPROFILE ".local\\bin"
New-Item -ItemType Directory -Force -Path $tmp, $bin | Out-Null
try {
  curl.exe -fsSL -o (Join-Path $tmp "rg.zip") $url
  Expand-Archive -Path (Join-Path $tmp "rg.zip") -DestinationPath (Join-Path $tmp "out") -Force
  $exe = Get-ChildItem (Join-Path $tmp "out") -Filter "rg.exe" -Recurse | Select-Object -First 1
  Copy-Item $exe.FullName (Join-Path $bin "rg.exe") -Force
  $up = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($up -split ";" | Where-Object { $_ -and $_.Trim() -ne "" })
  if (-not ($parts | Where-Object { $_.TrimEnd("\\") -ieq $bin.TrimEnd("\\") })) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $bin) -join ";"), "User")
  }
  Write-Output "Installed rg $ver to $bin\\rg.exe"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true
  });
  if (res.error || res.status !== 0) {
    console.log(`  - Warning: automatic ripgrep install failed (${res.stderr?.trim() || res.error?.message || "unknown"}). Node.js fallback remains active.`);
    return false;
  }
  console.log(`  - ${res.stdout.trim()}`);
  const localBin = path.join(os.homedir(), ".local", "bin");
  const curPath = process.env.PATH || process.env.Path || "";
  const hasBin = curPath
    .split(";")
    .some((p) => p.trim().replace(/[\\/]+$/, "").toLowerCase() === localBin.replace(/[\\/]+$/, "").toLowerCase());
  if (!hasBin) {
    process.env.PATH = curPath ? `${curPath};${localBin}` : localBin;
  }
  return true;
}

async function verifyMcpServer(scriptPath, extraEnv = {}) {
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
      child.kill("SIGKILL");
      reject(new Error(`MCP smoke test timed out: ${scriptPath}`));
    }, 6000);
    timer.unref();

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const msgs = [];
      for (const l of lines) {
        try {
          const parsed = JSON.parse(l);
          if (parsed && typeof parsed === "object") msgs.push(parsed);
        } catch {}
      }
      const initResp = msgs.find((m) => m.id === 1);
      const listResp = msgs.find((m) => m.id === 2);
      const tools = listResp?.result?.tools;
      if (!initResp?.result?.serverInfo || !Array.isArray(tools)) {
        return reject(new Error(`Incomplete or invalid MCP response (exit ${code}): ${stderr || stdout}`));
      }
      resolve({
        serverName: initResp.result.serverInfo.name,
        tools: tools.map((t) => t.name)
      });
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agy-dart-doctor", version: "1.0" } }
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });
}

async function verifySessionStart(hookScript, sampleDir, dbPath) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify({ cwd: sampleDir, workspacePaths: [sampleDir], hookEventName: "SessionStart" }),
    encoding: "utf8",
    timeout: 6000,
    windowsHide: true,
    env: { ...process.env, AGY_DART_DB_PATH: dbPath }
  });
  if (res.error || res.status !== 0) {
    throw new Error(`SessionStart failed: ${res.stderr || res.error?.message}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
  return { durationMs: Date.now() - t0, bytes: Buffer.byteLength(msg, "utf8") };
}

async function runDoctor(targetDir) {
  const nodeVer = checkNodeAndSqlite();
  await import("node:sqlite");
  const exists = await pathExists(targetDir);
  if (!exists) {
    console.log(`agy-dart is not installed at: ${targetDir}`);
    return false;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dart-doctor-"));
  const tmpDb = path.join(tmpDir, "doctor.db");

  try {
    const fastCheck = await verifyMcpServer(path.join(targetDir, "fast", "mcp-server.mjs"));
    const ctxCheck = await verifyMcpServer(path.join(targetDir, "context", "server.js"), { AGY_DART_DB_PATH: tmpDb });
    const hookCheck = await verifySessionStart(path.join(targetDir, "hooks", "session-start.mjs"), targetDir, tmpDb);
    const hasPluginJson = await pathExists(path.join(targetDir, "plugin.json"));
    const hasMcpConfig = await pathExists(path.join(targetDir, "mcp_config.json"));
    const hasSidecarJson = await pathExists(path.join(targetDir, "sidecars", "dashboard", "sidecar.json"));
    const hasSidecarServer = await pathExists(path.join(targetDir, "sidecars", "dashboard", "server.mjs"));
    const hasSidecarHtml = await pathExists(path.join(targetDir, "sidecars", "dashboard", "index.html"));
    const hasSidecar = hasSidecarJson && hasSidecarServer && hasSidecarHtml;
    const hasPreHook = await pathExists(path.join(targetDir, "hooks", "pre-tool-use.mjs"));
    const hasCliFilter = await pathExists(path.join(targetDir, "hooks", "cli-filter.mjs"));
    const hasPostHook = await pathExists(path.join(targetDir, "hooks", "post-tool-use.mjs"));
    const hasPreInvHook = await pathExists(path.join(targetDir, "hooks", "pre-invocation.mjs"));
    const hasCompileCacheHelper = await pathExists(path.join(targetDir, "hooks", "compile-cache.mjs"));
    const hasDevtools = await pathExists(path.join(targetDir, "fast", "benchmark.mjs"));
    const hasRg = hasCommand("rg", ["--version"]);
    const nodeModule = await import("node:module");
    const hasCompileCache = typeof nodeModule?.enableCompileCache === "function";

    let configLines = [];
    try {
      const cfgModPath = path.join(targetDir, "context", "lib", "config.js");
      const cfgMod = await import(pathToFileURL((await pathExists(cfgModPath)) ? cfgModPath : path.join(REPO_ROOT, "context", "lib", "config.js")).href);
      configLines = cfgMod.formatEffectiveConfigLines(cfgMod.getConfigSnapshot());
    } catch {}

    let filterDiag = null;
    try {
      const frModPath = path.join(targetDir, "hooks", "filter-rules.mjs");
      const frMod = await import(pathToFileURL((await pathExists(frModPath)) ? frModPath : path.join(REPO_ROOT, "hooks", "filter-rules.mjs")).href);
      if (typeof frMod.inspectProjectFilterRules === "function") {
        const cwdDiag = frMod.inspectProjectFilterRules(process.cwd());
        if (cwdDiag.exists) {
          filterDiag = cwdDiag;
        } else if (path.resolve(targetDir) !== path.resolve(process.cwd())) {
          const targetDiag = frMod.inspectProjectFilterRules(targetDir);
          if (targetDiag.exists) filterDiag = targetDiag;
        }
      }
    } catch {}

    const hooksRaw = JSON.parse(await fs.readFile(path.join(targetDir, "hooks.json"), "utf8"));
    const matcher = hooksRaw?.["agy-dart-lifecycle"]?.PreToolUse?.[0]?.matcher || "";
    const hasPostCfg = Array.isArray(hooksRaw?.["agy-dart-lifecycle"]?.PostToolUse);
    const hasPreInvCfg = Array.isArray(hooksRaw?.["agy-dart-lifecycle"]?.PreInvocation);

    console.log("agy-dart health check:");
    console.log(`  - Plugin path   : ${targetDir}`);
    console.log(`  - Profile       : ${hasDevtools ? "runtime + devtools" : "runtime-only (use --with-devtools for offline audit/benchmark CLIs)"}`);
    console.log(`  - Node / SQLite : v${nodeVer} (OK)`);
    console.log(`  - V8 CompileCache : ${hasCompileCache ? "available" : "unavailable"}${hasCompileCache && hasCompileCacheHelper ? " (versioned hook cache active)" : ""}`);
    console.log(`  - ripgrep (rg)  : ${hasRg ? "available (fast search active)" : "not found (Node.js fallback active; rerun with --install-rg on Windows)"}`);
    console.log(`  - MCP [fast]    : OK (${fastCheck.tools.length} tools: ${fastCheck.tools.join(", ")})`);
    console.log(`  - MCP [context] : OK (${ctxCheck.tools.length} tools: ${ctxCheck.tools.join(", ")})`);
    console.log(`  - SessionStart  : OK (${hookCheck.durationMs}ms, ${hookCheck.bytes} bytes)`);
    console.log(`  - PreToolUse    : ${hasPreHook ? "OK" : "MISSING"} (matcher: ${matcher}; cli-filter: ${hasCliFilter ? "OK" : "MISSING"})`);
    console.log(`  - PostToolUse   : ${hasPostHook && hasPostCfg ? "OK (edit/compaction read-dedup invalidation)" : "MISSING"}`);
    console.log(`  - PreInvocation : ${hasPreInvHook && hasPreInvCfg ? "OK (UI-only KV-cache watermark/TTL watch)" : "MISSING"}`);
    console.log(`  - Sidecar UI    : ${hasSidecar ? "OK (sidecars/dashboard present)" : "MISSING"}`);
    console.log(`  - Manifests     : ${hasPluginJson && hasMcpConfig ? "OK (plugin.json + mcp_config.json)" : "MISSING"}`);
    for (const line of configLines) {
      console.log(line);
    }
    const sanitizeTerminalText = (val, maxBytes = 120) => {
      let s = String(val ?? "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[@-Z\\-_]/g, "");
      if (typeof s.toWellFormed === "function") s = s.toWellFormed();
      s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
      if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
      return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
    };
    if (filterDiag && filterDiag.exists) {
      const safeFilterPath = sanitizeTerminalText(filterDiag.path, 240);
      if (filterDiag.error) {
        console.log(`  - Project filters : ERROR (${sanitizeTerminalText(filterDiag.error, 80)}) at ${safeFilterPath}`);
      } else {
        console.log(`  - Project filters : ${filterDiag.loadedCount} loaded, ${filterDiag.rejectedCount} rejected (${safeFilterPath})`);
        for (const rej of filterDiag.rejected) {
          console.log(
            `      ! rejected [${sanitizeTerminalText(rej.id, 48)}] (${sanitizeTerminalText(rej.field, 24)}: ${sanitizeTerminalText(rej.reason, 48)})`
          );
        }
      }
    }

    // Friendly warning if standalone legacy plugins coexist globally
    const globalRoot = getGlobalPluginsRoot();
    if (path.resolve(targetDir) === path.resolve(globalRoot, PLUGIN_NAME)) {
      const legacy = [];
      if (await pathExists(path.join(globalRoot, "agy-fast"))) legacy.push("agy-fast");
      if (await pathExists(path.join(globalRoot, "antigravity-plugin-context-mode"))) legacy.push("antigravity-plugin-context-mode");
      if (legacy.length > 0) {
        console.log(`  - Notice        : Found standalone plugin(s): ${legacy.join(", ")}. Disable or remove them in Customizations -> Installed to avoid duplicate MCP/hooks.`);
      }
    }

    return (
      fastCheck.tools.length === 4 &&
      ctxCheck.tools.length === 8 &&
      hookCheck.bytes > 0 &&
      hasPluginJson &&
      hasMcpConfig &&
      hasSidecar &&
      hasPreHook &&
      hasCliFilter &&
      hasPostHook &&
      hasPostCfg &&
      hasPreInvHook &&
      hasPreInvCfg &&
      hasCompileCacheHelper
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pruneStaleEntries(dstRoot, keepRelSet) {
  const lockedDirs = [];
  async function walk(dir, relPrefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPosix);
        try {
          const remaining = await fs.readdir(fullPath);
          if (remaining.length === 0) {
            await fs.rmdir(fullPath);
          }
        } catch (err) {
          if (err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOTEMPTY")) {
            lockedDirs.push(relPosix);
          }
        }
      } else if (!keepRelSet.has(process.platform === "win32" ? relPosix.toLowerCase() : relPosix)) {
        try {
          await fs.rm(fullPath, { force: true });
        } catch (err) {
          if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
            lockedDirs.push(relPosix);
          }
        }
      }
    }
  }
  await walk(dstRoot, "");
  return lockedDirs;
}

function stripWinExtendedPrefix(p) {
  if (process.platform !== "win32" || typeof p !== "string") return p;
  const uncMatch = p.match(/^[\\/]{2}\?[\\/]UNC[\\/](.+)$/i);
  if (uncMatch) {
    return `\\\\${uncMatch[1].replace(/\//g, "\\")}`;
  }
  const driveMatch = p.match(/^[\\/]{2}[?.][\\/]([a-zA-Z]:)([\\/].*)?$/);
  if (driveMatch) {
    return `${driveMatch[1]}${driveMatch[2] || "\\"}`;
  }
  return p;
}

function isWinDeviceNamespacePath(p) {
  if (process.platform !== "win32" || typeof p !== "string") return false;
  const trimmed = p.trim();
  const stripped = stripWinExtendedPrefix(trimmed);
  if (/^[\\/]{2}[?.][\\/]/.test(stripped)) return true;
  // Bare UNC server path with no share segment (e.g. \\server or \\server\)
  if (/^[\\/]{2}[^\\/]+[\\/]?$/.test(stripped)) return true;
  return false;
}

function isLexicalFilesystemRoot(p) {
  if (typeof p !== "string" || !p.trim()) return false;
  const stripped = stripWinExtendedPrefix(p.trim());
  const resolved = path.resolve(stripped);
  const root = path.parse(resolved).root;
  if (!root) return false;
  const trimSep = (s) => (s.length > 1 ? s.replace(/[\\/]+$/, "") : s);
  return process.platform === "win32"
    ? trimSep(resolved).toLowerCase() === trimSep(root).toLowerCase()
    : resolved === root;
}

function realpathCanonicalSync(p) {
  const real = typeof fsSync.realpathSync.native === "function"
    ? fsSync.realpathSync.native(p)
    : fsSync.realpathSync(p);
  return stripWinExtendedPrefix(real);
}

function normalizeComparePath(p) {
  const stripped = stripWinExtendedPrefix(String(p || ""));
  const resolved = path.resolve(stripped);
  if (isWinDeviceNamespacePath(p) || isLexicalFilesystemRoot(stripped)) {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
  let cur = resolved;
  const tail = [];
  while (true) {
    try {
      const real = realpathCanonicalSync(cur);
      const joined = tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      return process.platform === "win32" ? joined.toLowerCase() : joined;
    } catch {
      const parent = path.dirname(cur);
      if (!parent || parent === cur) {
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isPathSameOrInside(candidate, ancestor) {
  const nc = normalizeComparePath(candidate);
  const na = normalizeComparePath(ancestor);
  const rel = path.relative(na, nc);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel));
}

function isFilesystemRootPath(p) {
  if (isLexicalFilesystemRoot(p)) return true;
  const normalized = normalizeComparePath(p);
  const root = path.parse(normalized).root;
  if (!root) return false;
  const trimSep = (s) => (s.length > 1 ? s.replace(/[\\/]+$/, "") : s);
  return process.platform === "win32"
    ? trimSep(normalized).toLowerCase() === trimSep(root).toLowerCase()
    : normalized === root;
}

function isProtectedTargetDir(targetPath, srcRoot) {
  if (isWinDeviceNamespacePath(targetPath) || isFilesystemRootPath(targetPath)) {
    return true;
  }
  const home = path.resolve(os.homedir());
  const effectiveHome = path.resolve(getHomeDir());
  const globalPluginsRoot = path.resolve(getGlobalPluginsRoot());
  return (
    isPathSameOrInside(srcRoot, targetPath) ||
    isPathSameOrInside(targetPath, srcRoot) ||
    isPathSameOrInside(home, targetPath) ||
    isPathSameOrInside(effectiveHome, targetPath) ||
    isPathSameOrInside(globalPluginsRoot, targetPath)
  );
}

async function hasValidPluginManifest(dir) {
  const manifestPath = path.join(dir, "plugin.json");
  try {
    const parsedManifest = JSON.parse((await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
    return Boolean(parsedManifest && parsedManifest.name === PLUGIN_NAME);
  } catch {
    return false;
  }
}

async function runInstall(opts) {
  checkNodeAndSqlite();
  await import("node:sqlite");

  const srcRoot = path.resolve(REPO_ROOT);
  const dstRoot = path.resolve(opts.targetDir);
  const manifest = opts.withDevtools ? FILES_TO_COPY : RUNTIME_FILES;

  if (isProtectedTargetDir(dstRoot, srcRoot)) {
    throw new Error(`Refusing to install into protected directory: ${dstRoot}`);
  }
  let dstStat = null;
  try {
    dstStat = await fs.stat(dstRoot);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
    if (await pathExists(dstRoot)) {
      throw new Error(`Refusing to install into broken symlink path: ${dstRoot}`);
    }
  }
  if (dstStat) {
    if (!dstStat.isDirectory()) {
      throw new Error(`Refusing to install into non-directory path: ${dstRoot}`);
    }
    const entries = await fs.readdir(dstRoot);
    if (entries.length > 0 && !(await hasValidPluginManifest(dstRoot))) {
      throw new Error(
        `Refusing to install into non-empty directory ${dstRoot}: directory does not contain an '${PLUGIN_NAME}' plugin.json manifest.`
      );
    }
  }

  // Pre-validate all manifest source files BEFORE modifying destination so partial broken installs never occur
  const missingSources = [];
  for (const rel of manifest) {
    const src = path.join(srcRoot, rel);
    if (!(await pathExists(src))) {
      missingSources.push(rel);
    }
  }
  if (missingSources.length > 0) {
    throw new Error(`Missing required source file(s): ${missingSources.join(", ")}`);
  }

  // Copy/overwrite all manifest files in-place FIRST, then prune stale entries.
  // On Windows, running Antigravity MCP/Sidecar processes hold CWD handles on dstRoot
  // (causing `fs.rm(dstRoot, { recursive: true })` to throw EBUSY after partially deleting files).
  // In-place sync + stale pruning is atomic-safe for live upgrades while Antigravity is running.
  await fs.mkdir(dstRoot, { recursive: true });
  const keepRelSet = new Set();
  for (const rel of manifest) {
    const src = path.join(srcRoot, rel);
    const dst = path.join(dstRoot, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    const normRel = rel.replace(/\\/g, "/");
    keepRelSet.add(process.platform === "win32" ? normRel.toLowerCase() : normRel);
  }
  const locked = await pruneStaleEntries(dstRoot, keepRelSet);
  console.log(`Installed agy-dart (${opts.withDevtools ? "runtime+devtools" : "runtime-only"}, ${manifest.length} files) to ${dstRoot}`);
  if (locked.length > 0) {
    console.log(`  - Note          : Skipped removing busy path(s) held by a running process (${locked.join(", ")}); restart Antigravity to complete cleanup.`);
  }

  const skipDb = Boolean(opts.isCustomTarget || opts.isProject);
  const modeCfg = await applyMode(dstRoot, opts.mode, skipDb);
  console.log(`Configured mode: ${opts.mode} — ${modeCfg.label}`);

  if (opts.installRg) {
    installRipgrepWindows();
  }

  const ok = await runDoctor(dstRoot);
  if (!ok) throw new Error("Post-install health check failed.");

  console.log("\nDone! Restart Antigravity (or reload window) and open a new conversation to activate agy-dart.");
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.showHelp) {
    printHelp();
    return;
  }
  switch (opts.command) {
    case "install":
      await runInstall(opts);
      break;
    case "mode": {
      if (!(await pathExists(opts.targetDir))) {
        throw new Error(`agy-dart is not installed at ${opts.targetDir}. Run 'install' first.`);
      }
      const skipDb = Boolean(opts.isCustomTarget || opts.isProject);
      const cfg = await applyMode(opts.targetDir, opts.mode, skipDb);
      console.log(`Switched agy-dart mode at ${opts.targetDir} -> ${opts.mode} (${cfg.label})`);
      break;
    }
    case "doctor":
    case "status": {
      const ok = await runDoctor(opts.targetDir);
      if (!ok) process.exitCode = 1;
      break;
    }
    case "uninstall": {
      const targetResolved = path.resolve(opts.targetDir);
      if (isProtectedTargetDir(targetResolved, REPO_ROOT)) {
        throw new Error(`Refusing to delete protected directory: ${targetResolved}`);
      }
      if (await pathExists(targetResolved)) {
        // Verify target actually contains an agy-dart plugin.json manifest before recursive deletion
        if (!(await hasValidPluginManifest(targetResolved))) {
          throw new Error(`Refusing to delete ${targetResolved}: directory does not contain an '${PLUGIN_NAME}' plugin.json manifest.`);
        }
        try {
          await fs.rm(targetResolved, { recursive: true, force: true });
          console.log(`Removed agy-dart from ${targetResolved}`);
        } catch (err) {
          if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
            throw new Error(
              `Cannot remove ${targetResolved} because a running Antigravity process holds a lock (${err.code}). ` +
                `Disable agy-dart or close Antigravity first, then re-run 'npm run uninstall:plugin'.`
            );
          }
          throw err;
        }
      } else {
        console.log(`Not installed at ${targetResolved}`);
      }
      break;
    }
    default:
      throw new Error(`Unknown command: ${opts.command}`);
  }
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

if (isDirectRun) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
