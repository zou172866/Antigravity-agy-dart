#!/usr/bin/env node
import "../hooks/compile-cache.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardPath, read, writeFileAtomicSync } from "./targets/shared.mjs";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_NAME = "agy-dart";

export const GITHUB_REPO_URL = "https://github.com/zou172866/Antigravity-agy-dart";
export const GH_STAR_COMMAND = "gh api -X PUT /user/starred/zou172866/Antigravity-agy-dart";
export const GH_AUTH_CHECK_TIMEOUT_MS = 1500;

export function isGhCliAuthenticated({
  bin = "gh",
  args = ["auth", "status"],
  timeoutMs = GH_AUTH_CHECK_TIMEOUT_MS,
  env = process.env
} = {}) {
  const rawTimeout = Number(timeoutMs);
  const effectiveTimeout =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(GH_AUTH_CHECK_TIMEOUT_MS, Math.max(50, Math.floor(rawTimeout)))
      : GH_AUTH_CHECK_TIMEOUT_MS;
  try {
    const res = spawnSync(bin, args, {
      stdio: "ignore",
      timeout: effectiveTimeout,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
    });
    return Boolean(res && !res.error && !res.signal && res.status === 0);
  } catch {
    return false;
  }
}

export function printStarFollowupHint({
  mode = "install",
  ghAuthenticated = isGhCliAuthenticated()
} = {}) {
  if (mode === "doctor") {
    console.log(`[agy-dart] All checks passed. Track compatibility fixes & releases: ${GITHUB_REPO_URL}`);
    if (ghAuthenticated) {
      console.log(`[agy-dart] GitHub CLI logged in (optional manual star): ${GH_STAR_COMMAND}`);
    }
    return;
  }
  console.log("[agy-dart] Antigravity updates fast -- Star / Watch Releases on GitHub for compatibility fixes:");
  console.log(`           ${GITHUB_REPO_URL}`);
  if (ghAuthenticated) {
    console.log("[agy-dart] GitHub CLI detected (logged in). You can also star manually anytime:");
    console.log(`           ${GH_STAR_COMMAND}`);
  }
}

const MODES = {
  "strict-8k": { cutoffBytes: 8192, readHook: true, label: "Strict (8 KB / 205 lines)" },
  "balanced-16k": { cutoffBytes: 16384, readHook: true, label: "Classic Balanced (16 KB / 410 lines)" },
  "fast-32k": { cutoffBytes: 32768, readHook: true, label: "Relaxed (32 KB / 800 lines)" },
  "host-45k": { cutoffBytes: 46080, readHook: true, label: "Host-Aligned Default (45 KiB / 800 lines, 2-strike soft guard, recommended)" },
  "no-read-hook": { cutoffBytes: 46080, readHook: false, label: "Ultra-fast Scheme B (command guard only, no read_file hook)" }
};

const PACKAGE_MANIFEST_URL = new URL("./package-manifest.json", import.meta.url);
const PACKAGE_MANIFEST = JSON.parse(fsSync.readFileSync(PACKAGE_MANIFEST_URL, "utf8"));
if (PACKAGE_MANIFEST?.schemaVersion !== 1) {
  throw new Error(`Unsupported scripts/package-manifest.json schemaVersion: ${PACKAGE_MANIFEST?.schemaVersion}`);
}

export const PACKAGE_MANIFEST_SCHEMA_VERSION = PACKAGE_MANIFEST.schemaVersion;
export const TOOL_LOADING_MODES = Object.freeze(["fast-eager", "lazy", "eager"]);
export const FAST_MCP_TOOL_NAMES = Object.freeze([...PACKAGE_MANIFEST.fastMcpTools]);
export const CONTEXT_MCP_TOOL_NAMES = Object.freeze([...PACKAGE_MANIFEST.contextMcpTools]);

function buildEagerToolsConfig(toolNames) {
  const tools = {};
  for (const name of toolNames) {
    tools[name] = { eager: true };
  }
  return tools;
}

export function hasEagerToolsInServerEntry(serverEntry) {
  if (!serverEntry || typeof serverEntry !== "object") return false;
  if (serverEntry.eager === true) return true;
  if (serverEntry.tools && typeof serverEntry.tools === "object") {
    return Object.values(serverEntry.tools).some((cfg) => Boolean(cfg && typeof cfg === "object" && cfg.eager === true));
  }
  return false;
}

export function normalizeToolLoadingMode(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "fast-eager" || s === "fast_eager" || s === "fasteager" || s === "hybrid" || s === "default") {
    return "fast-eager";
  }
  if (s === "lazy" || s === "on-demand" || s === "ondemand") return "lazy";
  if (s === "eager" || s === "all-eager" || s === "alleager" || s === "all") return "eager";
  return null;
}

export function buildMcpConfigObject(toolLoading = "fast-eager") {
  const normalized = normalizeToolLoadingMode(toolLoading) || "fast-eager";
  const fastEntry = {
    command: "node",
    args: ["${PLUGIN_ROOT}/fast/mcp-server.mjs"],
    ...(normalized === "fast-eager" || normalized === "eager"
      ? { tools: buildEagerToolsConfig(FAST_MCP_TOOL_NAMES) }
      : {})
  };
  const contextEntry = {
    command: "node",
    args: ["${PLUGIN_ROOT}/context/server.js"],
    timeoutSeconds: 310,
    ...(normalized === "eager" ? { tools: buildEagerToolsConfig(CONTEXT_MCP_TOOL_NAMES) } : {})
  };
  return {
    mcpServers: {
      fast: fastEntry,
      context: contextEntry
    }
  };
}

export function buildHookBootstrapCommand(pluginName = PLUGIN_NAME, relScriptPath = "") {
  const safePlugin = String(pluginName || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(safePlugin)) {
    throw new Error(`Invalid plugin name for hook bootstrap: '${pluginName}'`);
  }
  const cleanRel = String(relScriptPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  const parts = cleanRel.split("/").filter(Boolean);
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+\.(?:m?js|cjs)$/.test(parts[1]) ||
    cleanRel.includes("..")
  ) {
    throw new Error(`Invalid relative hook script path: '${relScriptPath}'`);
  }
  // Universal polyglot JS bootstrapper (`node -e /\''/;...;//'`):
  // - Zero double quotes, zero spaces, zero &, |, <, >, $, `, %, !
  // - Executes identically under POSIX `sh -c`, Windows `cmd /d /s /c` (`shell: true`),
  //   AND non-verbatim `spawnSync("cmd", ["/c", cmd])` without `windowsVerbatimArguments`.
  // - Injects `process.argv[1] = targetScript` BEFORE dynamic `import()` so all hooks'
  //   `isDirectRun` guards execute `main()`, failing open to `{}` on missing/broken files.
  const js =
    `Promise.all([import(/node:fs/.source),import(/node:path/.source),import(/node:os/.source),import(/node:url/.source)])` +
    `.then(function(a,f,p,o,u,e,n,s0,s1,g,cg,pl,ag,h,cs,w,tg){` +
    `f=a[0];p=a[1];o=a[2];u=a[3];e=process.env;n=/${safePlugin}/.source;s0=/${parts[0]}/.source;s1=/${parts[1]}/.source;` +
    `g=/.gemini/.source;cg=/config/.source;pl=/plugins/.source;ag=/.agents/.source;` +
    `h=e.USERPROFILE?e.USERPROFILE:e.HOME?e.HOME:o.homedir();` +
    `cs=[e.PLUGIN_ROOT,e.AGY_PLUGIN_ROOT,/./.source];w=process.cwd();` +
    `[0,1,2,3,4,5,6,7].forEach(function(x,up){if(w){cs.push(p.join(w,ag,pl,n));up=p.dirname(w);w=up===w?0:up}});` +
    `cs.push(e.ANTIGRAVITY_CONFIG_DIR?p.join(e.ANTIGRAVITY_CONFIG_DIR,pl,n):0,` +
    `e.GEMINI_CONFIG_DIR?p.join(e.GEMINI_CONFIG_DIR,pl,n):0,` +
    `e.GEMINI_HOME?p.join(e.GEMINI_HOME,g,cg,pl,n):0,` +
    `e.GEMINI_HOME?p.join(e.GEMINI_HOME,cg,pl,n):0,` +
    `h?p.join(h,g,cg,pl,n):0);` +
    `cs.forEach(function(c,d,s,m){if(tg){}else{if(c){d=p.resolve(c);s=p.join(d,s0,s1);m=p.join(d,/plugin.json/.source);` +
    `try{if(f.existsSync(s)){if(f.existsSync(m)){if(JSON.parse(f.readFileSync(m,/utf8/.source).trim()).name===n){tg=s}}}}catch{}}}});` +
    `tg?(process.argv[1]=tg,import(u.pathToFileURL(tg).href).catch(function(){console.log(JSON.stringify({}))})):console.log(JSON.stringify({}))` +
    `}).catch(function(){console.log(JSON.stringify({}))})`;
  return `node -e /\\''/;${js};//'`;
}

export const RUNTIME_FILES = Object.freeze([...PACKAGE_MANIFEST.runtimeFiles]);

export const DEVTOOLS_FILES = Object.freeze([...PACKAGE_MANIFEST.devtoolsFiles]);

export const FILES_TO_COPY = Object.freeze([...RUNTIME_FILES, ...DEVTOOLS_FILES]);

function getHomeDir() {
  return process.platform === "win32"
    ? process.env.USERPROFILE || process.env.HOME || os.homedir()
    : process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getGlobalPluginsRoot() {
  return path.join(getHomeDir(), ".gemini", "config", "plugins");
}

export async function checkNodeAndSqlite() {
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize='trigram')");
  } catch (error) {
    throw new Error(`agy-dart requires node:sqlite with FTS5 and its trigram tokenizer. Install Node.js 22.16+ (22.x) or 24+. Current: v${process.versions.node} (${error.message})`, { cause: error });
  } finally {
    db?.close();
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

const KNOWN_COMMANDS = new Set(["install", "doctor", "status", "mode", "tool-loading", "uninstall"]);

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "install";
  let targetDir = "";
  let projectDir = "";
  let mode = "host-45k";
  let explicitMode = false;
  let toolLoading = "fast-eager";
  let explicitToolLoading = false;
  let syncHosts = true;
  let installRg = false;
  let withDevtools = false;
  let json = false;
  let showHelp = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      showHelp = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--install-rg") {
      installRg = true;
    } else if (a === "--with-devtools") {
      withDevtools = true;
    } else if (a === "--runtime-only") {
      withDevtools = false;
    } else if (a === "--no-sync-hosts") {
      syncHosts = false;
    } else if (a === "--tool-loading" || a.startsWith("--tool-loading=")) {
      const next = a === "--tool-loading" ? args[++i] : a.slice("--tool-loading=".length);
      const parsed = normalizeToolLoadingMode(next);
      if (!parsed) {
        throw new Error(`Invalid --tool-loading '${next}'. Expected one of: ${TOOL_LOADING_MODES.join(", ")}`);
      }
      toolLoading = parsed;
      explicitToolLoading = true;
    } else if (a === "--mode") {
      const next = args[++i];
      if (!next || !MODES[next]) {
        throw new Error(`Invalid --mode '${next}'. Expected one of: ${Object.keys(MODES).join(", ")}`);
      }
      mode = next;
      explicitMode = true;
    } else if (a === "--target") {
      const next = args[++i];
      if (!next || next.startsWith("-")) throw new Error("Missing path after --target");
      targetDir = path.resolve(next);
    } else if (a === "--project") {
      const next = args[i + 1];
      if (next && !next.startsWith("-") && !KNOWN_COMMANDS.has(next)) {
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
    explicitMode = true;
  }
  if (command === "tool-loading" && positional.length >= 2) {
    const parsed = normalizeToolLoadingMode(positional[1]);
    if (!parsed) {
      throw new Error(`Unknown tool-loading mode '${positional[1]}'. Expected one of: ${TOOL_LOADING_MODES.join(", ")}`);
    }
    toolLoading = parsed;
    explicitToolLoading = true;
  }

  const isCustomTarget = Boolean(targetDir);
  if (!targetDir) {
    targetDir = projectDir
      ? path.join(projectDir, ".agents", "plugins", PLUGIN_NAME)
      : path.join(getGlobalPluginsRoot(), PLUGIN_NAME);
  }

  return {
    command,
    targetDir,
    projectDir,
    isProject: Boolean(projectDir),
    isCustomTarget,
    mode,
    explicitMode,
    toolLoading,
    explicitToolLoading,
    syncHosts,
    installRg,
    withDevtools,
    json,
    showHelp
  };
}

function printHelp() {
  console.log(`agy-dart installer & doctor

Usage:
  node scripts/install.mjs install [options]     Install agy-dart globally (default) or to a project
  node scripts/install.mjs doctor [options]      Verify both MCP servers, hooks, SQLite, Sidecar, config & rg
  node scripts/install.mjs mode <mode> [opts]    Switch protection mode (${Object.keys(MODES).join(" | ")})
  node scripts/install.mjs tool-loading <mode>   Switch MCP tool loading (${TOOL_LOADING_MODES.join(" | ")})
  node scripts/install.mjs uninstall [options]   Remove installed agy-dart plugin

Options:
  --project [dir]        Install into <dir>/.agents/plugins/agy-dart
  --target <dir>         Install into a custom directory
  --mode <mode>          host-45k (default) | fast-32k | balanced-16k | strict-8k | no-read-hook
  --tool-loading <mode>  fast-eager (default: 4 fast eager + 8 context lazy) | lazy | eager
  --no-sync-hosts        Skip auto-syncing secondary GEMINI_HOME / T3 Code ACP plugin dirs
  --with-devtools        Also copy offline CLI devtools (benchmark, cache-simulator, cache-audit, prefix-budget, verify-package-graph, gen-review-brief)
  --runtime-only         Install runtime files only (default)
  --install-rg           On Windows x64, download official ripgrep (rg.exe) to ~/.local/bin and add to PATH
  --json                 Output machine-readable JSON (for 'doctor')
  -h, --help             Show this help
`);
}

function resolveUserConfigFilePath(env = process.env) {
  const custom = typeof env?.AGY_DART_CONFIG_PATH === "string" ? env.AGY_DART_CONFIG_PATH.trim() : "";
  if (custom) return path.resolve(custom);
  return path.join(getHomeDir(), ".agy-dart", "config.json");
}

async function resolveAndPersistToolLoading(
  requestedMode,
  { explicitToolLoading = false, persist = true, env = process.env } = {}
) {
  const cfgPath = resolveUserConfigFilePath(env);
  let existingObj = {};
  let canWrite = true;
  try {
    const st = await fs.lstat(cfgPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to read/write config.json through symlink: ${cfgPath}`);
    }
    if (st.isFile()) {
      const raw = (await fs.readFile(cfgPath, "utf8")).replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingObj = parsed;
      } else {
        canWrite = false;
      }
    }
  } catch (err) {
    if (err && String(err.message || "").includes("symlink")) throw err;
    if (err && err.code !== "ENOENT") {
      canWrite = false;
    }
  }

  let effective = normalizeToolLoadingMode(requestedMode) || "fast-eager";
  if (!explicitToolLoading) {
    const saved = normalizeToolLoadingMode(existingObj.toolLoading);
    if (saved) effective = saved;
  }

  if (persist && canWrite && (explicitToolLoading || existingObj.toolLoading !== undefined)) {
    const nextObj = { ...existingObj, toolLoading: effective };
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(nextObj, null, 2) + "\n", "utf8");
  }
  return effective;
}

async function applyToolLoading(targetDir, toolLoadingMode = "fast-eager") {
  const effective = normalizeToolLoadingMode(toolLoadingMode) || "fast-eager";
  const mcpPath = path.join(targetDir, "mcp_config.json");
  try {
    const st = await fs.lstat(mcpPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write mcp_config.json through symlink: ${mcpPath}`);
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  const mcpObj = buildMcpConfigObject(effective);
  await fs.writeFile(mcpPath, JSON.stringify(mcpObj, null, 2) + "\n", "utf8");
  return effective;
}

async function applyMode(targetDir, modeKey, skipDb = false, { explicitMode = true } = {}) {
  const cfg = MODES[modeKey];
  const hooksPath = path.join(targetDir, "hooks.json");
  const hooksJson = {
    "agy-dart-lifecycle": {
      SessionStart: [
        {
          type: "command",
          command: buildHookBootstrapCommand(PLUGIN_NAME, "./hooks/session-start.mjs"),
          timeout: 8
        }
      ],
      PreToolUse: [
        {
          matcher: cfg.readHook ? "run_command|read_file|view_file" : "run_command",
          hooks: [
            {
              type: "command",
              command: buildHookBootstrapCommand(PLUGIN_NAME, "./hooks/pre-tool-use.mjs"),
              timeout: 10
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "run_command|edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|.*apply_edits|.*run_checks|.*ctx_resume|.*ctx_execute|.*ctx_index|.*ctx_batch|call_mcp_tool",
          hooks: [
            {
              type: "command",
              command: buildHookBootstrapCommand(PLUGIN_NAME, "./hooks/post-tool-use.mjs"),
              timeout: 5
            }
          ]
        }
      ],
      PreInvocation: [
        {
          type: "command",
          command: buildHookBootstrapCommand(PLUGIN_NAME, "./hooks/pre-invocation.mjs"),
          timeout: 5
        }
      ],
      Stop: [
        {
          type: "command",
          command: buildHookBootstrapCommand(PLUGIN_NAME, "./hooks/stop.mjs"),
          timeout: 5
        }
      ]
    }
  };
  try {
    const hooksLstat = await fs.lstat(hooksPath);
    if (hooksLstat.isSymbolicLink()) {
      throw new Error(`Refusing to write hooks.json through symlink: ${hooksPath}`);
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  await fs.writeFile(hooksPath, JSON.stringify(hooksJson, null, 2) + "\n", "utf8");

  if (!skipDb) {
    const storeUrl = pathToFileURL(path.join(targetDir, "context", "lib", "store.js")).href;
    const { ContextModeStore } = await import(storeUrl);
    const store = new ContextModeStore();
    try {
      if (explicitMode) {
        store.setCutoff(cfg.cutoffBytes, "lifetime", { source: "user" });
      } else {
        const existingGlobal = store.getMeta("cutoff:global", null);
        const existingSource = store.getMeta("cutoff:source", null);
        if (existingGlobal === null) {
          store.setCutoff(cfg.cutoffBytes, "lifetime", { source: "installer_default" });
        } else if (
          existingSource === "installer_default" ||
          (existingGlobal === "16384" && existingSource === null)
        ) {
          store.setCutoff(cfg.cutoffBytes, "lifetime", { source: "installer_default" });
          if (existingGlobal !== String(cfg.cutoffBytes)) {
            console.log(`  - Migrated legacy default cutoff ${existingGlobal} B -> ${cfg.cutoffBytes} B (${modeKey})`);
          }
        } else {
          console.log(`  - Preserved existing custom global cutoff (${existingGlobal} B; pass --mode ${modeKey} to override)`);
        }
      }
      if (typeof store.sanitizeModelTtlState === "function") {
        store.sanitizeModelTtlState();
      }
    } finally {
      store.close();
    }
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

export async function verifyMcpServer(scriptPath, extraEnv = {}) {
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

async function verifySessionStart(hookScript, sampleDir, dbPath, { hooksJsonPath = "", foreignCwd = "" } = {}) {
  const t0 = Date.now();
  const payload = JSON.stringify({ cwd: sampleDir, workspacePaths: [sampleDir], hookEventName: "SessionStart" });
  const res = spawnSync(process.execPath, [hookScript], {
    input: payload,
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
  if (hooksJsonPath && foreignCwd) {
    const hooksRaw = JSON.parse(await fs.readFile(hooksJsonPath, "utf8"));
    const bootCmd = hooksRaw?.["agy-dart-lifecycle"]?.SessionStart?.[0]?.command || "";
    if (bootCmd) {
      const pluginDir = path.dirname(hooksJsonPath);
      const bootRes = spawnSync(bootCmd, {
        shell: true,
        cwd: foreignCwd,
        input: payload,
        encoding: "utf8",
        timeout: 6000,
        windowsHide: true,
        env: { ...process.env, PLUGIN_ROOT: pluginDir, AGY_DART_DB_PATH: dbPath }
      });
      if (bootRes.error || bootRes.status !== 0) {
        throw new Error(`hooks.json cross-CWD bootstrap failed: ${bootRes.stderr || bootRes.error?.message}`);
      }
      const bootParsed = JSON.parse((bootRes.stdout || "").trim() || "{}");
      const bootMsg = bootParsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
      if (!bootMsg) {
        throw new Error("hooks.json cross-CWD bootstrap returned empty SessionStart output");
      }
    }
  }
  return { durationMs: Date.now() - t0, bytes: Buffer.byteLength(msg, "utf8") };
}

async function runDoctor(targetDir, { json = false, showStarHint = true } = {}) {
  const nodeVer = await checkNodeAndSqlite();
  const exists = await pathExists(targetDir);
  if (!exists) {
    if (json) {
      console.log(JSON.stringify({ ok: false, installed: false, targetDir }, null, 2));
    } else {
      console.log(`agy-dart is not installed at: ${targetDir}`);
    }
    return false;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dart-doctor-"));
  const tmpDb = path.join(tmpDir, "doctor.db");

  try {
    const fastCheck = await verifyMcpServer(path.join(targetDir, "fast", "mcp-server.mjs"));
    const ctxCheck = await verifyMcpServer(path.join(targetDir, "context", "server.js"), { AGY_DART_DB_PATH: tmpDb });
    const hookCheck = await verifySessionStart(path.join(targetDir, "hooks", "session-start.mjs"), targetDir, tmpDb, {
      hooksJsonPath: path.join(targetDir, "hooks.json"),
      foreignCwd: tmpDir
    });
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
    const hasStopHook = await pathExists(path.join(targetDir, "hooks", "stop.mjs"));
    const hasWatchdog =
      (await pathExists(path.join(targetDir, "context", "lib", "watchdog.js"))) &&
      (await pathExists(path.join(targetDir, "context", "lib", "watchdog-lease.js")));
    const hasCompileCacheHelper = await pathExists(path.join(targetDir, "hooks", "compile-cache.mjs"));
    const hasDevtools = await pathExists(path.join(targetDir, "fast", "benchmark.mjs"));
    const hasRg = hasCommand("rg", ["--version"]);
    const nodeModule = await import("node:module");
    const hasCompileCache = typeof nodeModule?.enableCompileCache === "function";

    let configLines = [];
    let configSnapshotSummary = null;
    try {
      const cfgModPath = path.join(targetDir, "context", "lib", "config.js");
      const cfgMod = await import(pathToFileURL((await pathExists(cfgModPath)) ? cfgModPath : path.join(REPO_ROOT, "context", "lib", "config.js")).href);
      let extraReadGuard = {};
      try {
        const storeModPath = path.join(targetDir, "context", "lib", "store.js");
        const storeMod = await import(pathToFileURL((await pathExists(storeModPath)) ? storeModPath : path.join(REPO_ROOT, "context", "lib", "store.js")).href);
        const liveStore = new storeMod.ContextModeStore({ hookMode: true });
        try {
          const info = typeof liveStore.getCutoffInfo === "function" ? liveStore.getCutoffInfo(null) : null;
          if (info) {
            extraReadGuard = { sourceCutoffBytes: info.cutoffBytes, sourceCutoffSource: info.source };
          }
        } finally {
          liveStore.close();
        }
      } catch {}
      const snapshot = cfgMod.getConfigSnapshot();
      configLines = cfgMod.formatEffectiveConfigLines(snapshot, extraReadGuard);
      configSnapshotSummary = {
        configPath: snapshot.configPath,
        fileExists: snapshot.fileExists,
        configError: snapshot.configError || null,
        values: snapshot.values
      };
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
    const hasStopCfg = Array.isArray(hooksRaw?.["agy-dart-lifecycle"]?.Stop);
    let mcpToolLoading = "lazy";
    if (hasMcpConfig) {
      try {
        const mcpRaw = JSON.parse(await fs.readFile(path.join(targetDir, "mcp_config.json"), "utf8"));
        const fastEager = hasEagerToolsInServerEntry(mcpRaw?.mcpServers?.fast);
        const ctxEager = hasEagerToolsInServerEntry(mcpRaw?.mcpServers?.context);
        mcpToolLoading = fastEager && ctxEager ? "eager" : fastEager ? "fast-eager" : "lazy";
      } catch {}
    }

    const legacy = [];
    const globalRoot = getGlobalPluginsRoot();
    if (path.resolve(targetDir) === path.resolve(globalRoot, PLUGIN_NAME)) {
      if (await pathExists(path.join(globalRoot, "agy-fast"))) legacy.push("agy-fast");
      if (await pathExists(path.join(globalRoot, "antigravity-plugin-context-mode"))) legacy.push("antigravity-plugin-context-mode");
    }

    const allOk =
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
      hasStopHook &&
      hasStopCfg &&
      hasWatchdog &&
      hasCompileCacheHelper;

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: allOk,
            installed: true,
            targetDir,
            profile: hasDevtools ? "runtime+devtools" : "runtime-only",
            nodeVersion: nodeVer,
            compileCache: hasCompileCache,
            compileCacheHelper: hasCompileCacheHelper,
            ripgrep: hasRg,
            mcpFast: { ok: fastCheck.tools.length === 4, tools: fastCheck.tools },
            mcpContext: { ok: ctxCheck.tools.length === 8, tools: ctxCheck.tools },
            toolLoading: mcpToolLoading,
            sessionStart: { ok: hookCheck.bytes > 0, ...hookCheck },
            hooks: {
              preToolUse: hasPreHook,
              preToolUseMatcher: matcher,
              cliFilter: hasCliFilter,
              postToolUse: hasPostHook && hasPostCfg,
              preInvocation: hasPreInvHook && hasPreInvCfg,
              stop: hasStopHook && hasStopCfg && hasWatchdog
            },
            sidecar: hasSidecar,
            manifests: hasPluginJson && hasMcpConfig,
            config: configSnapshotSummary,
            projectFilters: filterDiag,
            legacyPlugins: legacy
          },
          null,
          2
        )
      );
      return allOk;
    }

    console.log("agy-dart health check:");
    console.log(`  - Plugin path   : ${targetDir}`);
    console.log(`  - Profile       : ${hasDevtools ? "runtime + devtools" : "runtime-only (use --with-devtools for offline audit/benchmark CLIs)"}`);
    console.log(`  - Node / SQLite : v${nodeVer} (OK)`);
    console.log(`  - V8 CompileCache : ${hasCompileCache ? "available" : "unavailable"}${hasCompileCache && hasCompileCacheHelper ? " (versioned hook cache active)" : ""}`);
    console.log(`  - ripgrep (rg)  : ${hasRg ? "available (fast search active)" : "not found (Node.js fallback active; rerun with --install-rg on Windows)"}`);
    console.log(`  - MCP [fast]    : OK (${fastCheck.tools.length} tools: ${fastCheck.tools.join(", ")})`);
    console.log(`  - MCP [context] : OK (${ctxCheck.tools.length} tools: ${ctxCheck.tools.join(", ")})`);
    console.log(`  - Tool loading  : ${mcpToolLoading}`);
    console.log(`  - SessionStart  : OK (${hookCheck.durationMs}ms, ${hookCheck.bytes} bytes)`);
    console.log(`  - PreToolUse    : ${hasPreHook ? "OK" : "MISSING"} (matcher: ${matcher}; cli-filter: ${hasCliFilter ? "OK" : "MISSING"})`);
    console.log(`  - PostToolUse   : ${hasPostHook && hasPostCfg ? "OK (edit/compaction read-dedup & watchdog lease update)" : "MISSING"}`);
    console.log(`  - PreInvocation : ${hasPreInvHook && hasPreInvCfg ? "OK (UI-only KV-cache watermark/TTL & watchdog lease)" : "MISSING"}`);
    console.log(`  - Stop          : ${hasStopHook && hasStopCfg && hasWatchdog ? "OK (Sidecar Stall Watchdog IDLE lease transition)" : "MISSING"}`);
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
    if (legacy.length > 0) {
      console.log(`  - Notice        : Found standalone plugin(s): ${legacy.join(", ")}. Disable or remove them in Customizations -> Installed to avoid duplicate MCP/hooks.`);
    }

    if (allOk && showStarHint) {
      printStarFollowupHint({ mode: "doctor" });
    }

    return allOk;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function unlinkReparsePoint(p) {
  try {
    await fs.unlink(p);
  } catch (err) {
    if (err && (err.code === "EISDIR" || err.code === "EPERM" || err.code === "EACCES")) {
      await fs.rmdir(p);
    } else if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
}

async function purgeSymlinksInsideDir(rootDir) {
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      let st;
      try {
        st = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        await unlinkReparsePoint(fullPath);
      } else if (st.isDirectory()) {
        await walk(fullPath);
      }
    }
  }
  await walk(rootDir);
}

async function assertNotSymlinkTarget(targetPath, projectRoot = "") {
  if (projectRoot) {
    const agentsDir = path.join(projectRoot, ".agents");
    const pluginsDir = path.join(agentsDir, "plugins");
    for (const p of [agentsDir, pluginsDir]) {
      try {
        const st = await fs.lstat(p);
        if (st.isSymbolicLink()) {
          throw new Error(`Refusing to traverse symlink or junction directory: ${p}`);
        }
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    }
  }
  try {
    const st = await fs.lstat(targetPath);
    if (st.isSymbolicLink()) {
      let targetExists = false;
      try {
        await fs.stat(targetPath);
        targetExists = true;
      } catch {}
      if (!targetExists) {
        throw new Error(`Refusing to install into broken symlink path: ${targetPath}`);
      }
      throw new Error(`Refusing to modify symlink or junction target: ${targetPath}`);
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
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
      let st;
      try {
        st = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          await unlinkReparsePoint(fullPath);
        } catch (err) {
          if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
            lockedDirs.push(relPosix);
          }
        }
      } else if (st.isDirectory()) {
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
      } else if (
        !/^rules\/[^/]+\.local\.md$/i.test(relPosix) &&
        !keepRelSet.has(process.platform === "win32" ? relPosix.toLowerCase() : relPosix)
      ) {
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

function isUncOrDevicePath(p) {
  if (typeof p !== "string") return false;
  const trimmed = p.trim();
  if (!trimmed) return false;
  const stripped = stripWinExtendedPrefix(trimmed);
  if (process.platform === "win32" && /^[\\/]{2}[?.][\\/]/.test(stripped)) return true;
  // Block any UNC share or bare server path (e.g. \\server\share\dir, //server/share/dir, \\server)
  if (/^(?:\\\\|\/\/)[^\\/?]+/.test(stripped)) return true;
  return false;
}

function hasGitMarkerSync(dirPath) {
  if (typeof dirPath !== "string" || !dirPath.trim()) return false;
  try {
    fsSync.lstatSync(path.join(dirPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

function isSourceCheckoutDir(dirPath) {
  if (hasGitMarkerSync(dirPath)) return true;
  try {
    return fsSync.statSync(path.join(dirPath, "tests")).isDirectory();
  } catch {
    return false;
  }
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

function canonicalPath(p) {
  const stripped = stripWinExtendedPrefix(String(p || ""));
  const resolved = path.resolve(stripped);
  if (isUncOrDevicePath(p) || isLexicalFilesystemRoot(stripped)) {
    return resolved;
  }
  let cur = resolved;
  const tail = [];
  while (true) {
    try {
      const real = realpathCanonicalSync(cur);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (!parent || parent === cur) {
        return resolved;
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function normalizeComparePath(p) {
  const canonical = canonicalPath(p);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
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

function isProtectedTargetDir(targetPath, srcRoot, { allowInstalledSelf = false } = {}) {
  if (isUncOrDevicePath(targetPath) || isFilesystemRootPath(targetPath) || hasGitMarkerSync(targetPath)) {
    return true;
  }
  const home = path.resolve(os.homedir());
  const effectiveHome = path.resolve(getHomeDir());
  const globalPluginsRoot = path.resolve(getGlobalPluginsRoot());
  const protectSrcRoot = !allowInstalledSelf || isSourceCheckoutDir(srcRoot);
  return (
    (protectSrcRoot && (isPathSameOrInside(srcRoot, targetPath) || isPathSameOrInside(targetPath, srcRoot))) ||
    isPathSameOrInside(home, targetPath) ||
    isPathSameOrInside(effectiveHome, targetPath) ||
    isPathSameOrInside(globalPluginsRoot, targetPath)
  );
}

async function hasValidPluginManifest(dir) {
  const manifestPath = path.join(dir, "plugin.json");
  try {
    const mst = await fs.lstat(manifestPath);
    if (!mst.isFile() || mst.isSymbolicLink()) return false;
    const parsedManifest = JSON.parse((await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
    return Boolean(parsedManifest && parsedManifest.name === PLUGIN_NAME);
  } catch {
    return false;
  }
}

export function discoverExtraHostPluginTargets({
  homeDir = getHomeDir(),
  env = process.env,
  primaryTargetDir = ""
} = {}) {
  const found = [];
  const seen = new Set();
  if (primaryTargetDir) {
    seen.add(normalizeComparePath(primaryTargetDir));
  }
  const addTarget = (candidatePluginDir) => {
    if (!candidatePluginDir || isUncOrDevicePath(candidatePluginDir)) return;
    const resolved = path.resolve(candidatePluginDir);
    const key = normalizeComparePath(resolved);
    if (seen.has(key)) return;
    if (isProtectedTargetDir(resolved, REPO_ROOT, { allowInstalledSelf: true })) return;
    seen.add(key);
    found.push(resolved);
  };

  const geminiHome = typeof env?.GEMINI_HOME === "string" ? env.GEMINI_HOME.trim() : "";
  if (geminiHome) {
    try {
      const ghResolved = path.resolve(geminiHome);
      const ghStat = fsSync.lstatSync(ghResolved);
      if (ghStat.isDirectory() && !ghStat.isSymbolicLink()) {
        const dotGeminiCfg = path.join(ghResolved, ".gemini", "config");
        const directCfg = path.join(ghResolved, "config");
        if (fsSync.existsSync(directCfg) && !fsSync.existsSync(dotGeminiCfg)) {
          addTarget(path.join(directCfg, "plugins", PLUGIN_NAME));
        } else {
          addTarget(path.join(dotGeminiCfg, "plugins", PLUGIN_NAME));
        }
      }
    } catch {}
  }

  const t3AntigravityRoot = path.join(path.resolve(homeDir), ".t3", "userdata", "providers", "antigravity");
  try {
    const t3Stat = fsSync.lstatSync(t3AntigravityRoot);
    if (t3Stat.isDirectory() && !t3Stat.isSymbolicLink()) {
      const entries = fsSync.readdirSync(t3AntigravityRoot, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.isSymbolicLink() || ent.name.startsWith(".")) continue;
        const profileDir = path.join(t3AntigravityRoot, ent.name);
        const directPlugins = path.join(profileDir, "plugins");
        const dotGeminiPlugins = path.join(profileDir, ".gemini", "config", "plugins");
        if (fsSync.existsSync(directPlugins) && !fsSync.existsSync(path.join(profileDir, ".gemini"))) {
          addTarget(path.join(directPlugins, PLUGIN_NAME));
        } else {
          addTarget(path.join(dotGeminiPlugins, PLUGIN_NAME));
        }
      }
    }
  } catch {}

  return found;
}

const SYNC_MARKER = ".agy-dart-sync.json";

function syncReceiptDir() {
  return path.join(canonicalPath(getHomeDir()), ".agy-dart", "synced-hosts");
}

function syncReceiptName(primary, target) {
  return createHash("sha256").update(JSON.stringify([primary, target])).digest("hex") + ".json";
}

function getSyncMarker(target, primary) {
  const raw = read(path.join(target, SYNC_MARKER));
  if (!raw) return null;
  const marker = JSON.parse(raw);
  if (marker.primary !== normalizeComparePath(primary) || marker.target !== target) return null;
  if (!Array.isArray(marker.files) || !marker.files.every(rel =>
    typeof rel === "string" && rel.split("/").every(part => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")
  )) throw new Error(`Invalid synced file list at ${target}`);
  const plugin = read(path.join(target, "plugin.json"));
  if (plugin !== null && JSON.parse(plugin.replace(/^\uFEFF/, "")).name !== PLUGIN_NAME) {
    throw new Error(`Secondary host at ${target} now contains a different plugin`);
  }
  return marker;
}

function reportUntrackedHost(target) {
  if (fsSync.existsSync(path.join(target, SYNC_MARKER))) {
    console.log(`  - Kept secondary host owned by another installation at ${target}`);
    return;
  }
  console.log(`  - Kept untracked secondary host at ${target}. To remove this copy explicitly, run: node scripts/install.mjs uninstall --target "${target}"`);
}

async function prepareHostSync(target, primary, manifest) {
  const previous = getSyncMarker(target, primary);
  if (!previous && (await pathExists(target)) && (await fs.readdir(target)).length) {
    if (await hasValidPluginManifest(target)) reportUntrackedHost(target);
    else console.log(`  - Kept non-empty secondary host directory at ${target}`);
    return null;
  }
  // Record intent before copying so an interrupted sync can be retried or uninstalled.
  const owner = normalizeComparePath(primary);
  const receipt = path.join(syncReceiptDir(), syncReceiptName(owner, target));
  writeFileAtomicSync(receipt, JSON.stringify({ primary: owner, target }));
  const marker = {
    primary: owner, target, files: [...new Set([...(previous?.files ?? []), ...manifest])]
  };
  writeFileAtomicSync(path.join(target, SYNC_MARKER), JSON.stringify(marker));
  return marker;
}

async function removeSyncedFiles(target, files) {
  const parents = new Set();
  for (const rel of files) {
    const file = path.join(target, rel);
    guardPath(file);
    await fs.rm(file, { force: true });
    for (let dir = path.dirname(file); dir !== target; dir = path.dirname(dir)) parents.add(dir);
  }
  for (const dir of [...parents].sort((a, b) => b.length - a.length)) await removeEmptyDir(dir);
}

async function uninstallSyncedHosts(primary) {
  const owner = normalizeComparePath(primary);
  const receipts = syncReceiptDir();
  guardPath(receipts);
  const known = new Set();
  const entries = await fs.readdir(receipts).catch(err => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  for (const entry of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const receipt = path.join(receipts, entry);
    const raw = read(receipt);
    if (raw === null) continue;
    const record = JSON.parse(raw);
    if (record.primary !== owner) continue;
    const target = record.target;
    if (typeof target !== "string" || !path.isAbsolute(target) || path.basename(target) !== PLUGIN_NAME ||
        path.basename(path.dirname(target)) !== "plugins" || syncReceiptName(owner, target) !== entry ||
        canonicalPath(target) !== target || isProtectedTargetDir(target, REPO_ROOT, { allowInstalledSelf: true })) {
      throw new Error(`Invalid secondary host target in ${receipt}`);
    }
    known.add(normalizeComparePath(target));
    const marker = getSyncMarker(target, primary);
    if (marker) {
      // Only remove files installed here. Leave local rules and other user-owned files.
      await removeSyncedFiles(target, marker.files);
      // Retain the inert marker alongside local rules so a reinstall recognizes ownership.
      if ((await fs.readdir(target)).every(name => name === SYNC_MARKER)) {
        await fs.rm(path.join(target, SYNC_MARKER), { force: true });
        await removeEmptyDir(target);
      }
      console.log(`Removed agy-dart from secondary host at ${target}`);
    } else if (await hasValidPluginManifest(target)) {
      reportUntrackedHost(target);
    }
    await fs.rm(receipt, { force: true });
  }
  await removeEmptyDir(receipts);
  for (const target of discoverExtraHostPluginTargets({ primaryTargetDir: primary })) {
    if (!known.has(normalizeComparePath(target)) && await hasValidPluginManifest(target)) reportUntrackedHost(target);
  }
}

async function removeEmptyDir(dir) {
  try { await fs.rmdir(dir); }
  catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY" && err.code !== "EEXIST") throw err;
  }
}

async function copyManifestToTargetDir(srcRoot, dstRoot, manifest, syncMarker = null) {
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
    if (entries.length > 0 && !syncMarker && !(await hasValidPluginManifest(dstRoot))) {
      throw new Error(
        `Refusing to install into non-empty directory ${dstRoot}: directory does not contain an '${PLUGIN_NAME}' plugin.json manifest.`
      );
    }
    if (!syncMarker) await purgeSymlinksInsideDir(dstRoot);
  }
  await fs.mkdir(dstRoot, { recursive: true });
  const keepRelSet = new Set();
  for (const rel of manifest) {
    const src = path.join(srcRoot, rel);
    const dst = path.join(dstRoot, rel);
    if (syncMarker) guardPath(dst);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    const normRel = rel.replace(/\\/g, "/");
    keepRelSet.add(process.platform === "win32" ? normRel.toLowerCase() : normRel);
  }
  if (!syncMarker) return pruneStaleEntries(dstRoot, keepRelSet);
  await removeSyncedFiles(dstRoot, syncMarker.files.filter(rel => !manifest.includes(rel)));
  writeFileAtomicSync(path.join(dstRoot, SYNC_MARKER), JSON.stringify({ ...syncMarker, files: manifest }));
  return [];
}

async function runInstall(opts) {
  await checkNodeAndSqlite();

  const srcRoot = path.resolve(REPO_ROOT);
  const dstRoot = path.resolve(opts.targetDir);
  const manifest = opts.withDevtools ? FILES_TO_COPY : RUNTIME_FILES;

  if (isProtectedTargetDir(dstRoot, srcRoot, { allowInstalledSelf: false })) {
    throw new Error(`Refusing to install into protected directory: ${dstRoot}`);
  }
  await assertNotSymlinkTarget(dstRoot, opts.projectDir);

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

  // Copy/overwrite all manifest files in-place FIRST, then prune stale entries (preserving rules/*.local.md).
  const locked = await copyManifestToTargetDir(srcRoot, dstRoot, manifest);
  console.log(`Installed agy-dart (${opts.withDevtools ? "runtime+devtools" : "runtime-only"}, ${manifest.length} files) to ${dstRoot}`);
  if (locked.length > 0) {
    console.log(`  - Note          : Skipped removing busy path(s) held by a running process (${locked.join(", ")}); restart Antigravity to complete cleanup.`);
  }

  const skipDb = Boolean(opts.isCustomTarget || opts.isProject);
  const effectiveToolLoading = await resolveAndPersistToolLoading(opts.toolLoading, {
    explicitToolLoading: opts.explicitToolLoading,
    persist: !skipDb
  });
  await applyToolLoading(dstRoot, effectiveToolLoading);
  const modeCfg = await applyMode(dstRoot, opts.mode, skipDb, { explicitMode: opts.explicitMode });
  console.log(`Configured mode: ${opts.mode} — ${modeCfg.label} (tool-loading: ${effectiveToolLoading})`);

  if (!opts.isCustomTarget && !opts.isProject && opts.syncHosts !== false) {
    const extraTargets = discoverExtraHostPluginTargets({ primaryTargetDir: dstRoot });
    const failures = [];
    for (const discovered of extraTargets) {
      try {
        await assertNotSymlinkTarget(discovered);
        const extraDst = canonicalPath(discovered);
        const marker = await prepareHostSync(extraDst, dstRoot, manifest);
        if (!marker) continue;
        await copyManifestToTargetDir(srcRoot, extraDst, manifest, marker);
        await applyToolLoading(extraDst, effectiveToolLoading);
        await applyMode(extraDst, opts.mode, true, { explicitMode: opts.explicitMode });
        console.log(`  - Synced secondary host plugin dir: ${extraDst}`);
      } catch (syncErr) {
        failures.push(`${discovered}: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
      }
    }
    if (failures.length) throw new Error(`Secondary host sync incomplete:\n${failures.join("\n")}`);
  }

  if (opts.installRg) {
    installRipgrepWindows();
  }

  const ok = await runDoctor(dstRoot, { json: false, showStarHint: false });
  if (!ok) throw new Error("Post-install health check failed.");

  console.log("\nDone! Restart Antigravity (or reload window) and open a new conversation to activate agy-dart.");
  printStarFollowupHint({ mode: "install" });
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
      const targetResolved = path.resolve(opts.targetDir);
      if (isProtectedTargetDir(targetResolved, REPO_ROOT, { allowInstalledSelf: true })) {
        throw new Error(`Refusing to modify protected directory: ${targetResolved}`);
      }
      await assertNotSymlinkTarget(targetResolved, opts.projectDir);
      if (!(await pathExists(targetResolved))) {
        throw new Error(`agy-dart is not installed at ${targetResolved}. Run 'install' first.`);
      }
      if (!(await hasValidPluginManifest(targetResolved))) {
        throw new Error(`Refusing to switch mode at ${targetResolved}: directory does not contain an '${PLUGIN_NAME}' plugin.json manifest.`);
      }
      const skipDb = Boolean(opts.isCustomTarget || opts.isProject);
      const cfg = await applyMode(targetResolved, opts.mode, skipDb, { explicitMode: true });
      if (!opts.isCustomTarget && !opts.isProject && opts.syncHosts !== false) {
        for (const extraDst of discoverExtraHostPluginTargets({ primaryTargetDir: targetResolved })) {
          try {
            if (getSyncMarker(canonicalPath(extraDst), targetResolved) && await hasValidPluginManifest(extraDst)) {
              await assertNotSymlinkTarget(extraDst);
              await applyMode(extraDst, opts.mode, true, { explicitMode: true });
            }
          } catch {}
        }
      }
      console.log(`Switched agy-dart mode at ${targetResolved} -> ${opts.mode} (${cfg.label})`);
      break;
    }
    case "tool-loading": {
      const targetResolved = path.resolve(opts.targetDir);
      if (isProtectedTargetDir(targetResolved, REPO_ROOT, { allowInstalledSelf: true })) {
        throw new Error(`Refusing to modify protected directory: ${targetResolved}`);
      }
      await assertNotSymlinkTarget(targetResolved, opts.projectDir);
      if (!(await pathExists(targetResolved))) {
        throw new Error(`agy-dart is not installed at ${targetResolved}. Run 'install' first.`);
      }
      if (!(await hasValidPluginManifest(targetResolved))) {
        throw new Error(`Refusing to switch tool-loading at ${targetResolved}: directory does not contain an '${PLUGIN_NAME}' plugin.json manifest.`);
      }
      const skipDb = Boolean(opts.isCustomTarget || opts.isProject);
      const eff = await resolveAndPersistToolLoading(opts.toolLoading, {
        explicitToolLoading: true,
        persist: !skipDb
      });
      await applyToolLoading(targetResolved, eff);
      if (!opts.isCustomTarget && !opts.isProject && opts.syncHosts !== false) {
        for (const extraDst of discoverExtraHostPluginTargets({ primaryTargetDir: targetResolved })) {
          try {
            if (getSyncMarker(canonicalPath(extraDst), targetResolved) && await hasValidPluginManifest(extraDst)) {
              await assertNotSymlinkTarget(extraDst);
              await applyToolLoading(extraDst, eff);
            }
          } catch {}
        }
      }
      console.log(`Switched agy-dart tool-loading at ${targetResolved} -> ${eff}`);
      break;
    }
    case "doctor":
    case "status": {
      const ok = await runDoctor(opts.targetDir, { json: opts.json, showStarHint: !opts.json });
      if (!ok) process.exitCode = 1;
      break;
    }
    case "uninstall": {
      const targetResolved = path.resolve(opts.targetDir);
      if (isProtectedTargetDir(targetResolved, REPO_ROOT, { allowInstalledSelf: true })) {
        throw new Error(`Refusing to delete protected directory: ${targetResolved}`);
      }
      await assertNotSymlinkTarget(targetResolved, opts.projectDir);
      const installed = await pathExists(targetResolved);
      if (installed && !(await hasValidPluginManifest(targetResolved))) {
        throw new Error(`Refusing to delete ${targetResolved}: directory does not contain an '${PLUGIN_NAME}' plugin.json manifest.`);
      }
      if (!opts.isCustomTarget && !opts.isProject && opts.syncHosts) await uninstallSyncedHosts(targetResolved);
      if (installed) {
        if (isPathSameOrInside(process.cwd(), targetResolved)) {
          try {
            process.chdir(path.dirname(targetResolved));
          } catch {}
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
