import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

import { specs as codexSpecs } from "../scripts/targets/codex.mjs";
import { listRecordedProfiles, specs as dshSpecs } from "../scripts/targets/dsh.mjs";
import { acquireTargetsLock, releaseTargetsLock, runTargets } from "../scripts/targets/index.mjs";
import { createPluginUpdater } from "../sidecars/dashboard/version-update.mjs";
import { closeRuntimeStore, runAutoUpdateCycle } from "../sidecars/dashboard/server.mjs";
import { RELEASES_URL } from "../sidecars/dashboard/version-check.mjs";
import { createTools, enforceToolCallWireBudget, fetchUrlText } from "../context/lib/tools.js";
import { ContextModeStore } from "../context/lib/store.js";
import { auditSafetyMonitor, resetSafetyAuditCache } from "../context/lib/safety-monitor-audit.js";
import { clearTranscriptScanCache, findTranscriptForConversation } from "../context/lib/cache-analyzer.js";
import { queryRecentConversationIdsFromSummaryDb } from "../context/lib/watchdog-lease.js";
import { buildSafeChildEnv, executeCode, isSensitiveEnvKey, runProcess } from "../context/lib/executor.js";
import { resetConfigCache } from "../context/lib/config.js";
import { validateFetchTarget } from "../context/lib/security.js";
import { evaluatePreToolPayload } from "../hooks/pre-tool-use.mjs";
import { processPostToolPayload } from "../hooks/post-tool-use.mjs";
import { apply as applyDshPlugin } from "../dsh/plugin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SAFETY_FIXTURES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests", "fixtures", "safety-monitor-issue-1886.json"), "utf8")
);

function findPythonBin() {
  for (const bin of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const res = spawnSync(bin, ["-c", "import sys; print(sys.version_info[:2])"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (res.status === 0) return bin;
  }
  return null;
}

const PYTHON_BIN = findPythonBin();

function parseTomlWithPython(tomlText) {
  if (!PYTHON_BIN) return null;
  const res = spawnSync(
    PYTHON_BIN,
    [
      "-c",
      "import sys, json, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"
    ],
    { input: tomlText, encoding: "utf8", windowsHide: true }
  );
  if (res.status !== 0) {
    throw new Error(`tomllib rejected TOML: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function parseYamlWithPython(yamlText) {
  if (!PYTHON_BIN) return null;
  const check = spawnSync(PYTHON_BIN, ["-c", "import yaml"], { encoding: "utf8", windowsHide: true });
  if (check.status !== 0) return null;
  const res = spawnSync(
    PYTHON_BIN,
    [
      "-c",
      "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"
    ],
    { input: yamlText, encoding: "utf8", windowsHide: true }
  );
  if (res.status !== 0) {
    throw new Error(`PyYAML rejected YAML: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

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

function createMinimalReleaseEntries(version, extraEntries = []) {
  const prefix = `package/`;
  const runtimeFiles = [
    "plugin.json",
    "package.json",
    "mcp_config.json",
    "hooks.json",
    "sidecars/dashboard/sidecar.json",
    "sidecars/dashboard/server.mjs",
    "sidecars/dashboard/index.html",
    "scripts/install.mjs",
    "context/server.js",
    "fast/mcp-server.mjs",
    ...extraEntries.map((e) => e.rel)
  ];
  const base = [
    { name: `${prefix}plugin.json`, content: JSON.stringify({ name: "agy-dart", version }, null, 2) + "\n" },
    { name: `${prefix}package.json`, content: JSON.stringify({ name: "agy-dart", version }, null, 2) + "\n" },
    { name: `${prefix}mcp_config.json`, content: JSON.stringify({ mcpServers: { fast: {}, context: {} } }) + "\n" },
    { name: `${prefix}hooks.json`, content: JSON.stringify({ "agy-dart-lifecycle": { PreToolUse: [{ matcher: "run_command|read_file|view_file" }] } }) + "\n" },
    {
      name: `${prefix}sidecars/dashboard/sidecar.json`,
      content: JSON.stringify({ command: "node", args: ["server.mjs"], restart_policy: "always" }) + "\n"
    },
    { name: `${prefix}sidecars/dashboard/server.mjs`, content: `// server v${version}\n` },
    { name: `${prefix}sidecars/dashboard/index.html`, content: `<!-- ui v${version} -->\n` },
    {
      name: `${prefix}scripts/install.mjs`,
      content: `export const RUNTIME_FILES = Object.freeze(${JSON.stringify(runtimeFiles)});\n`
    },
    { name: `${prefix}context/server.js`, content: `// context v${version}\n` },
    { name: `${prefix}fast/mcp-server.mjs`, content: `// fast v${version}\n` },
    ...extraEntries.map((e) => ({ name: `${prefix}${e.rel}`, content: e.content }))
  ];
  return base;
}

function setupMockPluginInstall(rootDir, version, extraFiles = {}) {
  const entries = createMinimalReleaseEntries(version);
  for (const e of entries) {
    const rel = e.name.replace(/^package\//, "");
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.content, "utf8");
  }
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

function parseHexColor(hex) {
  const clean = hex.trim().replace(/^#/, "");
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255
  ];
}

function relativeLuminance(hex) {
  const [r, g, b] = parseHexColor(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function wcagContrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------------------------------------------------------------------------
// Batch 1: H1, H2, M07, M08
// ---------------------------------------------------------------------------

test("Wave1-B1 (H1): Codex install rejects closed inline mcp_servers table, doctor fails on broken TOML, valid configs pass round-trip + tomllib", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-h1-codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexDir = path.join(home, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const cfgPath = path.join(codexDir, "config.toml");

  // 1. Top-level closed inline table `mcp_servers = {}` is rejected BEFORE modifying user config
  const inlineEmpty = 'model = "gpt-5"\nmcp_servers = {}\n';
  fs.writeFileSync(cfgPath, inlineEmpty, "utf8");
  await assert.rejects(
    runTargets(ROOT, ["install", "--target", "codex"], home),
    /Cannot install agy-dart into Codex config\.toml.*inline table/i
  );
  assert.equal(fs.readFileSync(cfgPath, "utf8"), inlineEmpty, "Original config.toml must stay untouched");

  // 2. Quoted / non-empty inline table / array-of-tables / conflicting key under [mcp_servers] are all rejected
  const runtime = path.join(home, ".agy-dart", "runtime");
  const [codexSpec] = codexSpecs(home, ROOT, runtime);
  for (const badInput of [
    'mcp_servers = { other = { command = "x" } }\n',
    '"mcp_servers" = {}\n',
    '[[mcp_servers]]\nname = "a"\n',
    '[mcp_servers]\nagy_dart_fast = { command = "node" }\n',
    'mcp_servers.agy_dart_context.command = "node"\n'
  ]) {
    assert.throws(() => codexSpec.install(badInput), /Cannot install|Conflicting/);
  }

  // 3. Previously corrupted file (inline table + managed block) fails verify() and doctor, yet remove() still cleans it
  const validInstalled = codexSpec.install("").text;
  const legacyCorrupted = `mcp_servers = {}\n${validInstalled}`;
  assert.equal(codexSpec.verify(legacyCorrupted), false, "verify() must reject closed inline table + subtable TOML");
  fs.writeFileSync(cfgPath, legacyCorrupted, "utf8");
  await assert.rejects(runTargets(ROOT, ["doctor", "--target", "codex"], home), /Invalid installation|Conflicting/);
  assert.equal(codexSpec.remove(legacyCorrupted), "mcp_servers = {}\n", "remove() must still uninstall legacy broken block");

  // 4. Valid configs (nested `[other] mcp_servers = {}`, multiline string containing `mcp_servers = {}`, `[mcp_servers]` with sibling entry)
  const validOriginal = [
    'model = "o3"',
    'note = """',
    "mcp_servers = {}",
    '"""',
    "",
    "[other]",
    "mcp_servers = {}",
    "",
    "[mcp_servers]",
    'sibling = { command = "echo", args = ["ok"] }',
    ""
  ].join("\n");
  fs.writeFileSync(cfgPath, validOriginal, "utf8");
  await runTargets(ROOT, ["install", "--target", "codex"], home);
  const afterInstall = fs.readFileSync(cfgPath, "utf8");
  if (PYTHON_BIN) {
    const parsed = parseTomlWithPython(afterInstall);
    assert.equal(parsed.model, "o3");
    assert.deepEqual(parsed.other.mcp_servers, {});
    assert.equal(parsed.mcp_servers.sibling.command, "echo");
    assert.ok(parsed.mcp_servers.agy_dart_fast.command);
    assert.ok(parsed.mcp_servers.agy_dart_context.command);
  }
  await runTargets(ROOT, ["doctor", "--target", "codex"], home);
  // User appends another table after install -> reinstall & uninstall preserve it cleanly
  const userTail = '\n[profiles.custom]\nmodel = "fast"\n';
  fs.writeFileSync(cfgPath, afterInstall + userTail, "utf8");
  await runTargets(ROOT, ["install", "--target", "codex"], home);
  if (PYTHON_BIN) {
    const parsedReinstall = parseTomlWithPython(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(parsedReinstall.profiles.custom.model, "fast");
  }
  await runTargets(ROOT, ["uninstall", "--target", "codex"], home);
  const afterUninstall = fs.readFileSync(cfgPath, "utf8");
  assert.equal(afterUninstall, validOriginal + userTail);
  if (PYTHON_BIN) {
    const parsedUninstall = parseTomlWithPython(afterUninstall);
    assert.equal(parsedUninstall.mcp_servers.sibling.command, "echo");
    assert.equal(parsedUninstall.mcp_servers.agy_dart_fast, undefined);
  }
});

test("Wave1-B1 (H2): DSH uninstall from empty [] preserves user-appended and user-prepended YAML entries cleanly", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-h2-dsh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const desktopDir = path.join(home, ".dsh", "profiles", "desktop");
  fs.mkdirSync(desktopDir, { recursive: true });
  const patchPath = path.join(desktopDir, "cordis.patch.yml");

  // 1. Start from `[]\n`, install, append user list item -> reinstall -> uninstall must NOT re-emit `[]`
  fs.writeFileSync(patchPath, "[]\n", "utf8");
  await runTargets(ROOT, ["install", "--target", "dsh", "--profile", "desktop"], home);
  const installed = fs.readFileSync(patchPath, "utf8");
  const withUserEntry = installed + "- id: user-extension\n  disabled: false\n";
  fs.writeFileSync(patchPath, withUserEntry, "utf8");

  const parsedBefore = parseYamlWithPython(withUserEntry);
  if (parsedBefore !== null) {
    assert.ok(Array.isArray(parsedBefore));
  }

  await runTargets(ROOT, ["install", "--target", "dsh", "--profile", "desktop"], home);
  const reinstalled = fs.readFileSync(patchPath, "utf8");
  const parsedReinstalled = parseYamlWithPython(reinstalled);
  if (parsedReinstalled !== null) {
    assert.ok(parsedReinstalled.some((item) => item && item.id === "user-extension"));
  }

  await runTargets(ROOT, ["uninstall", "--target", "dsh", "--profile", "desktop"], home);
  const afterUninstall = fs.readFileSync(patchPath, "utf8");
  assert.equal(afterUninstall, "- id: user-extension\n  disabled: false\n");
  assert.doesNotMatch(afterUninstall, /^\s*\[\s*\]/m);
  const parsedAfter = parseYamlWithPython(afterUninstall);
  if (parsedAfter !== null) {
    assert.deepEqual(parsedAfter, [{ id: "user-extension", disabled: false }]);
  }

  // 2. Direct spec unit check: user prepends item before block, and comment-only tail still restores `[]`
  const runtime = path.join(home, ".agy-dart", "runtime");
  const [dshSpec] = dshSpecs(home, ROOT, runtime, { profile: "desktop" });
  const added = dshSpec.install("# header\n[]\n");
  const withPrepended = "- id: before-ext\n" + added.text;
  const removedPrepended = dshSpec.remove(withPrepended, added.undo);
  assert.equal(removedPrepended, "- id: before-ext\n# header\n");
  assert.doesNotMatch(removedPrepended, /\[\]/);

  const withCommentOnly = added.text + "# trailing comment\n";
  const removedCommentOnly = dshSpec.remove(withCommentOnly, added.undo);
  assert.equal(removedCommentOnly, "# header\n[]\n# trailing comment\n");
  const parsedCommentOnly = parseYamlWithPython(removedCommentOnly);
  if (parsedCommentOnly !== null) {
    assert.deepEqual(parsedCommentOnly, []);
  }
});

test("Wave1-B1 (M07): DSH multi-profile tracking keeps shared runtime alive until every profile is uninstalled", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m07-dsh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const desktopPatch = path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
  const webPatch = path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(desktopPatch), { recursive: true });
  fs.mkdirSync(path.dirname(webPatch), { recursive: true });
  fs.writeFileSync(desktopPatch, "[]\n", "utf8");
  fs.writeFileSync(webPatch, "[]\n", "utf8");

  // Install desktop, then web -> both profiles recorded
  await runTargets(ROOT, ["install", "--target", "dsh", "--profile", "desktop"], home);
  await runTargets(ROOT, ["install", "--target", "dsh", "--profile", "web", "--mcp-only"], home);
  assert.deepEqual(listRecordedProfiles(home).sort(), ["desktop", "web"]);

  // Uninstall ONLY web -> desktop patch, skills, receipt, and shared runtime MUST survive
  await runTargets(ROOT, ["uninstall", "--target", "dsh", "--profile", "web"], home);
  assert.equal(fs.readFileSync(webPatch, "utf8"), "[]\n");
  assert.match(fs.readFileSync(desktopPatch, "utf8"), /id: agy-dart-native/);
  assert.equal(fs.existsSync(path.join(home, ".agy-dart", "runtime")), true, "Runtime must survive while desktop profile remains");
  assert.deepEqual(listRecordedProfiles(home), ["desktop"]);
  await runTargets(ROOT, ["doctor", "--target", "dsh"], home);

  // Re-install web, then run plain `uninstall --target dsh` (no --profile) -> removes BOTH profiles + runtime
  await runTargets(ROOT, ["install", "--target", "dsh", "--profile", "web"], home);
  assert.deepEqual(listRecordedProfiles(home).sort(), ["desktop", "web"]);
  await runTargets(ROOT, ["uninstall", "--target", "dsh"], home);
  assert.equal(fs.readFileSync(desktopPatch, "utf8"), "[]\n");
  assert.equal(fs.readFileSync(webPatch, "utf8"), "[]\n");
  assert.equal(fs.existsSync(path.join(home, ".agy-dart", "dsh-install.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".agy-dart", "runtime")), false, "Runtime cleaned once all profiles uninstalled");
});

test("Wave1-B1 (M08): targets.lock reclaims dead-PID stale lock safely under race, respects fresh empty-file window & EPERM", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m08-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, ".agy-dart", "targets.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // 1. Dead-PID stale lock (both legacy plain-PID and JSON format) is reclaimed
  fs.writeFileSync(lockPath, "999999", "utf8");
  const h1 = await acquireTargetsLock(lockPath, { action: "uninstall", targets: ["codex"] }, { probePid: () => "dead" });
  assert.ok(h1 && h1.token);
  releaseTargetsLock(h1);
  assert.equal(fs.existsSync(lockPath), false);

  // 2. Live-PID lock rejects with holder PID and leaves lock intact
  const livePayload = JSON.stringify({ pid: 424242, startedAt: Date.now(), token: "live-tok", action: "install" });
  fs.writeFileSync(lockPath, livePayload, "utf8");
  await assert.rejects(
    acquireTargetsLock(lockPath, { action: "uninstall" }, { probePid: () => "alive" }),
    /PID 424242/
  );
  assert.equal(fs.readFileSync(lockPath, "utf8"), livePayload, "Live lock must not be deleted");

  // 3. EPERM lock rejects with clear message and leaves lock intact
  await assert.rejects(
    acquireTargetsLock(lockPath, { action: "uninstall" }, { probePid: () => "eperm" }),
    /EPERM/
  );
  assert.equal(fs.readFileSync(lockPath, "utf8"), livePayload, "EPERM lock must not be deleted");
  fs.unlinkSync(lockPath);

  // 4. Newly created empty lock (holder metadata not yet written) MUST NOT be deleted as corrupt;
  //    once holder finishes writing live PID during retry, waiter sees live PID cleanly.
  fs.writeFileSync(lockPath, "", "utf8");
  let retryStep = 0;
  await assert.rejects(
    acquireTargetsLock(
      lockPath,
      { action: "install" },
      {
        freshLockGraceMs: 5000,
        retryMs: 5,
        maxRetries: 5,
        probePid: () => "alive",
        sleep: async () => {
          retryStep += 1;
          if (retryStep === 2) {
            fs.writeFileSync(lockPath, JSON.stringify({ pid: 515151, startedAt: Date.now(), token: "finished-write" }), "utf8");
          }
        }
      }
    ),
    /PID 515151/
  );
  assert.match(fs.readFileSync(lockPath, "utf8"), /515151/, "Fresh empty lock must not be prematurely unlinked");
  fs.unlinkSync(lockPath);

  // 5. Two concurrent callers racing to reclaim the SAME stale lock: exactly 1 wins and its live lock stays intact
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 987654, startedAt: Date.now() - 10_000, token: "dead-old" }), "utf8");
  const settled = await Promise.allSettled([
    acquireTargetsLock(lockPath, { action: "install", targets: ["codex"] }, {
      probePid: (pid) => (pid === 987654 ? "dead" : "alive"),
      retryMs: 5,
      maxRetries: 6
    }),
    acquireTargetsLock(lockPath, { action: "install", targets: ["dsh"] }, {
      probePid: (pid) => (pid === 987654 ? "dead" : "alive"),
      retryMs: 5,
      maxRetries: 6
    })
  ]);
  const wins = settled.filter((r) => r.status === "fulfilled");
  const losses = settled.filter((r) => r.status === "rejected");
  assert.equal(wins.length, 1, "Exactly one racer must acquire the reclaimed lock");
  assert.equal(losses.length, 1, "Second racer must fail cleanly");
  assert.match(String(losses[0].reason?.message || ""), /already in progress|Timed out/i);
  const onDisk = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(onDisk.token, wins[0].value.token, "Winner's live lock token must remain untouched on disk");
  releaseTargetsLock(wins[0].value);
  assert.equal(fs.existsSync(lockPath), false);
});

// ---------------------------------------------------------------------------
// Batch 2: M01, M06
// ---------------------------------------------------------------------------

test("Wave1-B2 (M01): auto-update pins approved assetUrl (case-sensitive path) + SHA-256 (case-insensitive hex) and never downgrades to tarball", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m01-auto-"));
  let store = null;
  t.after(() => {
    try { store?.close(); } catch {}
    closeRuntimeStore();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const pluginsDir = path.join(tmpDir, "plugins");
  const root = path.join(pluginsDir, "agy-dart");
  const sidecarDir = path.join(root, "sidecars", "dashboard");
  setupMockPluginInstall(root, "1.9.3");

  const tgz194 = buildTarGz(createMinimalReleaseEntries("1.9.4"));
  const sha194Lower = crypto.createHash("sha256").update(tgz194).digest("hex").toLowerCase();
  const sha194Upper = sha194Lower.toUpperCase();
  const baseUrl = "https://github.com/zou172866/Antigravity-agy-dart/releases/download/v1.9.4/agy-dart-1.9.4.tgz";
  const approvedRelease = {
    ok: true,
    status: "update",
    currentVersion: "1.9.3",
    latestVersion: "1.9.4",
    releaseTag: "v1.9.4",
    releaseUrl: `${RELEASES_URL}/tag/v1.9.4`,
    assetName: "agy-dart-1.9.4.tgz",
    assetUrl: baseUrl,
    assetSha256: sha194Lower
  };

  store = new ContextModeStore(path.join(tmpDir, "ctx.db"));
  store.setAutoUpdateInstallEnabled(true);

  const runScenario = async (freshRelease) => {
    let downloadCalls = 0;
    const updater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced"),
      checkVersion: async () => freshRelease,
      downloadOptions: {
        fetchImpl: async () => {
          downloadCalls += 1;
          return makeMockStreamRes(200, tgz194, freshRelease.assetUrl || "");
        }
      }
    });
    // Reset failedVersion circuit breaker between sub-scenarios
    store.setAutoUpdateRuntimeState({ failedVersion: "", failedReason: "", failedAt: "" });
    const res = await runAutoUpdateCycle({
      store,
      checker: async () => approvedRelease,
      updater,
      currentVersion: "1.9.3"
    });
    return { res, downloadCalls };
  };

  // 1. Fresh query loses asset digest -> must abort with noVerifiedAsset (zero tarball fallback, zero downloads)
  const missingDigest = await runScenario({ ...approvedRelease, assetUrl: "", assetSha256: "" });
  assert.equal(missingDigest.res.action, "failed");
  assert.equal(missingDigest.res.result.reason, "noVerifiedAsset");
  assert.equal(missingDigest.downloadCalls, 0);

  // 2. Fresh query mutates SHA-256 -> must abort with releaseChanged
  const changedSha = await runScenario({ ...approvedRelease, assetSha256: "f".repeat(64) });
  assert.equal(changedSha.res.action, "failed");
  assert.equal(changedSha.res.result.reason, "releaseChanged");
  assert.equal(changedSha.downloadCalls, 0);

  // 3. Fresh query mutates URL path casing -> must abort with releaseChanged (URL path is case-sensitive!)
  const changedUrlCase = await runScenario({
    ...approvedRelease,
    assetUrl: baseUrl.replace("/v1.9.4/", "/V1.9.4/")
  });
  assert.equal(changedUrlCase.res.action, "failed");
  assert.equal(changedUrlCase.res.result.reason, "releaseChanged");
  assert.equal(changedUrlCase.downloadCalls, 0);

  // 4. Same exact assetUrl + uppercase hex SHA-256 -> succeeds cleanly
  const matchingUpperHex = await runScenario({ ...approvedRelease, assetSha256: sha194Upper });
  assert.equal(matchingUpperHex.res.action, "updated");
  assert.equal(matchingUpperHex.downloadCalls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).version, "1.9.4");
});

test("Wave1-B2 (M06): secondary host sync rolls back atomically on I/O error and preserves user-owned extra files on both success and rollback", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m06-sec-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const pluginsDir = path.join(tmpDir, "plugins");
  const primaryRoot = path.join(pluginsDir, "agy-dart");
  const primarySidecar = path.join(primaryRoot, "sidecars", "dashboard");
  const secondaryRoot = path.join(tmpDir, "secondary", "agy-dart");
  const syncedHostsDir = path.join(tmpDir, "synced-hosts");
  fs.mkdirSync(syncedHostsDir, { recursive: true });

  const initialSyncedFiles = [
    "plugin.json",
    "package.json",
    "mcp_config.json",
    "hooks.json",
    "sidecars/dashboard/sidecar.json",
    "sidecars/dashboard/server.mjs",
    "sidecars/dashboard/index.html",
    "scripts/install.mjs",
    "context/server.js",
    "fast/mcp-server.mjs",
    "legacy-obsolete.js"
  ];
  setupMockPluginInstall(primaryRoot, "1.9.3");
  setupMockPluginInstall(secondaryRoot, "1.9.3", {
    "legacy-obsolete.js": "// old retired runtime file\n",
    "user-custom-note.txt": "keep-me-forever\n"
  });
  const normPrimary = await fsPromises.realpath(primaryRoot);
  const normSecondary = await fsPromises.realpath(secondaryRoot);
  const normCmp = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const origSyncMarker = { primary: normPrimary, target: normSecondary, files: initialSyncedFiles };
  fs.writeFileSync(path.join(secondaryRoot, ".agy-dart-sync.json"), JSON.stringify(origSyncMarker) + "\n", "utf8");
  fs.writeFileSync(
    path.join(syncedHostsDir, "sec.json"),
    JSON.stringify({ primary: normPrimary, target: normSecondary }),
    "utf8"
  );

  const tgz194 = buildTarGz(createMinimalReleaseEntries("1.9.4"));
  const sha194 = crypto.createHash("sha256").update(tgz194).digest("hex");
  const rel194 = {
    ok: true,
    status: "update",
    currentVersion: "1.9.3",
    latestVersion: "1.9.4",
    releaseTag: "v1.9.4",
    releaseUrl: `${RELEASES_URL}/tag/v1.9.4`,
    assetName: "agy-dart-1.9.4.tgz",
    assetUrl: "https://github.com/zou172866/Antigravity-agy-dart/releases/download/v1.9.4/agy-dart-1.9.4.tgz",
    assetSha256: sha194
  };

  // 1. Failure mid-sync on secondary host's `plugin.json` -> ALL secondary files rolled back to 1.9.3, user file intact, receipt intact
  let injectedOnce = false;
  const failingUpdater = createPluginUpdater({
    sidecarDirectory: primarySidecar,
    pluginsDirectory: pluginsDir,
    syncedHostsDir,
    checkVersion: async () => rel194,
    downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz194, rel194.assetUrl) },
    move: async (from, to) => {
      if (!injectedOnce && normCmp(to) === normCmp(path.join(normSecondary, "plugin.json"))) {
        injectedOnce = true;
        const err = new Error("Simulated EBUSY on secondary plugin.json");
        err.code = "EBUSY";
        throw err;
      }
      return fsPromises.rename(from, to);
    }
  });
  const failRes = await failingUpdater("1.9.4");
  assert.equal(failRes.status, "updated", "Primary host update still succeeds");
  assert.equal(failRes.syncedSecondaryHosts, undefined);
  assert.ok(failRes.warnings?.some((w) => w.step === "sync-secondary-host" && w.reason === "locked" && w.restored === true));
  // Secondary must have ZERO mixed old/new files: earlier moved `context/server.js` is back to 1.9.3!
  assert.equal(JSON.parse(fs.readFileSync(path.join(secondaryRoot, "plugin.json"), "utf8")).version, "1.9.3");
  assert.match(fs.readFileSync(path.join(secondaryRoot, "context/server.js"), "utf8"), /v1\.9\.3/);
  assert.equal(fs.existsSync(path.join(secondaryRoot, "legacy-obsolete.js")), true, "Obsolete file preserved after rollback");
  assert.equal(fs.readFileSync(path.join(secondaryRoot, "user-custom-note.txt"), "utf8"), "keep-me-forever\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(secondaryRoot, ".agy-dart-sync.json"), "utf8")).files, initialSyncedFiles);

  // 2. Success path on next update (1.9.4 -> 1.9.5): obsolete file pruned, user-custom-note.txt preserved, receipt matches 1.9.5 disk state
  const tgz195 = buildTarGz(createMinimalReleaseEntries("1.9.5"));
  const sha195 = crypto.createHash("sha256").update(tgz195).digest("hex");
  const rel195 = {
    ...rel194,
    currentVersion: "1.9.4",
    latestVersion: "1.9.5",
    releaseTag: "v1.9.5",
    assetName: "agy-dart-1.9.5.tgz",
    assetUrl: "https://github.com/zou172866/Antigravity-agy-dart/releases/download/v1.9.5/agy-dart-1.9.5.tgz",
    assetSha256: sha195
  };
  const okUpdater = createPluginUpdater({
    sidecarDirectory: primarySidecar,
    pluginsDirectory: pluginsDir,
    syncedHostsDir,
    checkVersion: async () => rel195,
    downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz195, rel195.assetUrl) }
  });
  const okRes = await okUpdater("1.9.5");
  assert.equal(okRes.status, "updated");
  assert.equal(okRes.syncedSecondaryHosts, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(secondaryRoot, "plugin.json"), "utf8")).version, "1.9.5");
  assert.match(fs.readFileSync(path.join(secondaryRoot, "context/server.js"), "utf8"), /v1\.9\.5/);
  assert.equal(fs.existsSync(path.join(secondaryRoot, "legacy-obsolete.js")), false, "Registered obsolete file pruned");
  assert.equal(fs.readFileSync(path.join(secondaryRoot, "user-custom-note.txt"), "utf8"), "keep-me-forever\n", "User-owned extra file preserved");
  const updatedMarker = JSON.parse(fs.readFileSync(path.join(secondaryRoot, ".agy-dart-sync.json"), "utf8"));
  assert.equal(updatedMarker.files.includes("legacy-obsolete.js"), false);
  assert.equal(updatedMarker.files.includes("plugin.json"), true);
});

// ---------------------------------------------------------------------------
// Batch 3: M02, M03, M09
// ---------------------------------------------------------------------------

test("Wave1-B3 (M02): Context MCP enforces <= 8800 B wire JSON-RPC line on quote-heavy ctx_execute, isError, and UI dual responses", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m02-wire-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. Unit tests on enforceToolCallWireBudget: quote-heavy JSON, huge isError, huge UI structuredContent, CJK
  const hugeQuoted = Array.from({ length: 270 }, (_, i) => `build[${i}]: "step_${i}" -> "ok\\path\\file_${i}.js"`).join("\n");
  const cappedJson = enforceToolCallWireBudget("req-very-long-id-" + "x".repeat(60), {
    content: [{ type: "text", text: JSON.stringify({ ok: true, sourceId: "src-123", output: hugeQuoted, returnedBytes: hugeQuoted.length }) }],
    isError: false
  });
  const lineJson = JSON.stringify({ jsonrpc: "2.0", id: "req-very-long-id-" + "x".repeat(60), result: cappedJson }) + "\n";
  assert.ok(Buffer.byteLength(lineJson, "utf8") <= 8800, `Expected <= 8800 B, got ${Buffer.byteLength(lineJson, "utf8")}`);
  const innerParsed = JSON.parse(cappedJson.content[0].text);
  assert.equal(innerParsed.sourceId, "src-123");

  const cappedErr = enforceToolCallWireBudget(2, {
    content: [{ type: "text", text: "错误详情：" + "中文报错信息".repeat(1200) }],
    isError: true
  });
  const lineErr = JSON.stringify({ jsonrpc: "2.0", id: 2, result: cappedErr }) + "\n";
  assert.ok(Buffer.byteLength(lineErr, "utf8") <= 8800);
  assert.equal(cappedErr.content[0].text.includes("\uFFFD"), false, "UTF-8 boundary must never emit replacement char");

  const cappedUi = enforceToolCallWireBudget(3, {
    content: [{ type: "text", text: JSON.stringify({ kind: "ctx_doctor", ok: true }) }],
    structuredContent: { kind: "ctx_doctor", hugeBlob: "z".repeat(12000) },
    isError: false
  });
  const lineUi = JSON.stringify({ jsonrpc: "2.0", id: 3, result: cappedUi }) + "\n";
  assert.ok(Buffer.byteLength(lineUi, "utf8") <= 8800);

  // 2. Live stdio integration check against context/server.js reproducing the 270-line quoted build log
  const scriptPath = path.join(tmpDir, "emit_quoted.mjs");
  fs.writeFileSync(
    scriptPath,
    'for (let i = 0; i < 270; i++) console.log(`line ${i}: "module_${i}" => "dist/chunk_${i}.js" ("ok")`);\n',
    "utf8"
  );
  const child = spawn(process.execPath, [path.join(ROOT, "context", "server.js")], {
    cwd: tmpDir,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: path.join(tmpDir, "ctx.db"),
      AGY_DART_WORKSPACE: tmpDir
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stdoutLines = [];
  let stderrText = "";
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const p of parts) if (p.trim()) stdoutLines.push(p);
  });
  child.stderr.on("data", (d) => {
    stderrText += d.toString("utf8");
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ctx_execute", arguments: { language: "nodejs", file: scriptPath, cwd: tmpDir, intent: "quoted build log" } }
  });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));

  assert.equal(stderrText, "", "Context MCP stderr must stay empty");
  const callLine = stdoutLines.find((l) => JSON.parse(l).id === 2);
  assert.ok(callLine, "Must receive tools/call response for id=2");
  const wireLen = Buffer.byteLength(callLine + "\n", "utf8");
  assert.ok(wireLen <= 8800, `Live stdio JSON-RPC line must be <= 8800 B, got ${wireLen} B`);
  const rpcObj = JSON.parse(callLine);
  const payload = JSON.parse(rpcObj.result.content[0].text);
  assert.ok(payload.sourceId);
  assert.ok(payload.rawBytes > 12000);
});

test("Wave1-B3 (M03): >2.4 MB node --test spec failure preserves trailing root cause in preview, FTS5 search, and checkpoint", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m03-tail-"));
  let store = null;
  t.after(() => {
    try { store?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const dbPath = path.join(tmpDir, "ctx.db");
  const sessionId = "m03-big-test-sess";

  const bigTestFile = path.join(tmpDir, "big-spec.test.mjs");
  fs.writeFileSync(
    bigTestFile,
    [
      'import test from "node:test";',
      'test("noisy progress then named tail failure", () => {',
      '  const chunk = Array.from({ length: 1000 }, (_, i) => `progress_row_${i} status=running payload=0123456789abcdef0123456789abcdef0123456789abcdef`).join("\\n") + "\\n";',
      "  for (let b = 0; b < 28; b++) process.stdout.write(chunk);",
      '  throw new Error("UNIQUE_TAIL_ROOT_CAUSE_9911: database checksum mismatch at shard 7");',
      "});"
    ].join("\n"),
    "utf8"
  );

  const innerCmd = `${JSON.stringify(process.execPath)} --test --test-reporter=spec ${JSON.stringify(bigTestFile)}`;
  const childEnv = { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: path.join(tmpDir, "cfg.json") };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "hooks", "cli-filter.mjs"),
      "--rule",
      "test-runner",
      "--b64",
      Buffer.from(innerCmd, "utf8").toString("base64"),
      "--orig-b64",
      Buffer.from("node --test --test-reporter=spec big-spec.test.mjs", "utf8").toString("base64"),
      "--session",
      Buffer.from(sessionId, "utf8").toString("base64")
    ],
    {
      cwd: tmpDir,
      encoding: "utf8",
      windowsHide: true,
      env: childEnv
    }
  );

  assert.equal(res.status, 1, "Exact non-zero exit code must be preserved");
  assert.ok(Buffer.byteLength(res.stdout, "utf8") <= 8800, "Preview must fit <= 8.8 KB");
  assert.ok(
    res.stdout.includes("UNIQUE_TAIL_ROOT_CAUSE_9911"),
    `Preview must preserve trailing root cause error, got:\n${res.stdout.slice(-600)}`
  );
  assert.match(res.stdout, /head\+tail output indexed/, "Truncated footer must not falsely claim full output indexed");

  store = new ContextModeStore(dbPath);
  const fts = store.search({ queries: ["UNIQUE_TAIL_ROOT_CAUSE_9911"], sessionId });
  assert.ok(fts.hits.length >= 1, "FTS5 index must contain the trailing root cause error");

  const checkpoint = store.getSessionCheckpoint(sessionId);
  const latestVer = checkpoint?.lastTest;
  assert.ok(latestVer, "Verification checkpoint must be recorded");
  assert.ok(
    `${latestVer.summary || ""}\n${latestVer.failureExcerpt || ""}`.includes("UNIQUE_TAIL_ROOT_CAUSE_9911"),
    `Verification checkpoint must include trailing root cause, got summary=${latestVer.summary}, excerpt=${latestVer.failureExcerpt}`
  );
});

test("Wave1-B3 (M09): Safety Monitor handles split-write lines + split UTF-8 bytes, stateless EOF, oversized lines & unrecognized formats", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m09-safety-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  resetSafetyAuditCache();

  const nowMs = new Date(2026, 10, 27, 1, 25, 0, 0).getTime();
  const statePath = path.join(tmpDir, "state.json");
  const splitLog = path.join(tmpDir, "language_server.log");
  // Inject multi-byte UTF-8 text into a golden FINISHED event and split RIGHT inside the 3-byte UTF-8 sequence!
  const baseEvent = SAFETY_FIXTURES.desktop_allowed_tool_skip_chain[0];
  const fullEventBuf = Buffer.from(baseEvent.replace("allowed_tool", "allowed_tool_中文测试") + "\n", "utf8");
  const splitAt = fullEventBuf.indexOf(Buffer.from("中文", "utf8")) + 1; // mid-UTF8-char!
  assert.ok(splitAt > 10 && splitAt < fullEventBuf.length - 5);

  // 1. Stateful poll after first half (no trailing \n) -> holds partial line without advancing past it
  fs.writeFileSync(splitLog, fullEventBuf.subarray(0, splitAt));
  fs.utimesSync(splitLog, nowMs / 1000, nowMs / 1000);
  const r1 = auditSafetyMonitor({ logPaths: [splitLog], disableDefaultDiscovery: true, statePath, nowMs });
  assert.equal(r1.window.stage1Total, 0);

  // Append second half + \n -> stateful poll recovers the complete intact line & UTF-8 bytes!
  fs.appendFileSync(splitLog, fullEventBuf.subarray(splitAt));
  fs.utimesSync(splitLog, (nowMs + 1000) / 1000, (nowMs + 1000) / 1000);
  const r2 = auditSafetyMonitor({ logPaths: [splitLog], disableDefaultDiscovery: true, statePath, nowMs: nowMs + 1000 });
  assert.equal(r2.window.stage1Total, 1, "Split-write FINISHED event must not be dropped across incremental polls");
  assert.equal(r2.status, "ok");
  assert.equal(r2.sources.parseStatus, "recognized");

  // 2. Stateless `--no-state` (`persistState: false`) parses a final line with NO trailing newline
  const noEolLog = path.join(tmpDir, "static-no-eol.log");
  fs.writeFileSync(noEolLog, baseEvent, "utf8"); // intentionally no \n
  fs.utimesSync(noEolLog, nowMs / 1000, nowMs / 1000);
  const rStatic = auditSafetyMonitor({
    logPaths: [noEolLog],
    disableDefaultDiscovery: true,
    persistState: false,
    nowMs
  });
  assert.equal(rStatic.window.stage1Total, 1, "Stateless scan must still parse final line without trailing newline");

  // 3. Unrecognized log format is distinguished from recognized zero-event logs
  const foreignLog = path.join(tmpDir, "foreign.log");
  fs.writeFileSync(foreignLog, "completely unrelated app log line 1\nanother unknown line 2\n", "utf8");
  const rForeign = auditSafetyMonitor({
    logPaths: [foreignLog],
    disableDefaultDiscovery: true,
    persistState: false,
    nowMs
  });
  assert.equal(rForeign.status, "no_safety_events");
  assert.equal(rForeign.sources.parseStatus, "unrecognized_format");
  assert.equal(rForeign.sources.recognizedLines, 0);
  assert.equal(rForeign.verdictCode, "UNRECOGNIZED_LOG_FORMAT");

  // 4. Oversized newline-less line (>maxPendingLineBytes) is skipped safely without stalling subsequent events
  const megaLog = path.join(tmpDir, "mega-line.log");
  fs.writeFileSync(megaLog, "A".repeat(4096) + "\n" + baseEvent + "\n", "utf8");
  fs.utimesSync(megaLog, nowMs / 1000, nowMs / 1000);
  const rMega = auditSafetyMonitor({
    logPaths: [megaLog],
    disableDefaultDiscovery: true,
    statePath: path.join(tmpDir, "mega-state.json"),
    maxPendingLineBytes: 512,
    nowMs
  });
  assert.equal(rMega.sources.oversizedLinesSkipped, 1);
  assert.equal(rMega.window.stage1Total, 1, "Normal event after skipped oversized line must still be parsed");
});

// ---------------------------------------------------------------------------
// Batch 4: M04, M05, M12, M13
// ---------------------------------------------------------------------------

test("Wave1-B4 (M04+M05): findTranscriptForConversation shares one deadline across locked roots, avoids negative-cache poison & cross-checks rowid_heuristic", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m04-m05-"));
  t.after(() => {
    clearTranscriptScanCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. M04: 3 rollback-journal roots held under EXCLUSIVE lock -> bounded total wall-clock & no negative-cache poisoning
  const roots = [];
  const dbs = [];
  let expectedLog = "";
  for (let i = 0; i < 3; i++) {
    const agRoot = path.join(tmpDir, `root-${i}`);
    const brainDir = path.join(agRoot, "brain");
    const convLog = path.join(brainDir, `conv-${i}`, ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(convLog), { recursive: true });
    fs.writeFileSync(convLog, '{"type":"USER_INPUT"}\n', "utf8");
    if (i === 2) {
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(convLog, future, future);
      expectedLog = convLog;
    }
    const db = new DatabaseSync(path.join(agRoot, "conversation_summaries.db"));
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, last_modified_time INTEGER);");
    db.exec("CREATE INDEX idx_lmt ON conversation_summaries(last_modified_time);");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(`conv-${i}`, 100 + i);
    roots.push(brainDir);
    dbs.push(db);
  }

  try {
    clearTranscriptScanCache();
    for (const db of dbs) db.exec("BEGIN EXCLUSIVE");
    try {
      const t0 = Date.now();
      findTranscriptForConversation(null, {
        extraRoots: roots,
        includeDefaultRoots: false,
        maxScanMs: 70
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 700, `3 locked roots must share one deadline instead of multiplying retries, got ${elapsed}ms`);
    } finally {
      for (const db of dbs) db.exec("COMMIT");
    }

    // Immediately after unlock (WITH cache enabled!) -> MUST find transcript, proving locked pass did NOT poison negative cache
    const afterUnlock = findTranscriptForConversation(null, {
      extraRoots: roots,
      includeDefaultRoots: false,
      maxScanMs: 150
    });
    assert.equal(afterUnlock, expectedLog, "Transient lock degradation must never poison the transcript cache");
  } finally {
    for (const db of dbs) db.close();
  }

  // 2. M05: Large unindexed table (>256 rows) reports precision='rowid_heuristic' and cross-checks mtime so newly-updated c00001 beats c00319
  const agUnidx = path.join(tmpDir, "unindexed");
  const brainUnidx = path.join(agUnidx, "brain");
  const c00001Log = path.join(brainUnidx, "c00001", ".system_generated", "logs", "transcript.jsonl");
  const c00319Log = path.join(brainUnidx, "c00319", ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(c00001Log), { recursive: true });
  fs.mkdirSync(path.dirname(c00319Log), { recursive: true });
  fs.writeFileSync(c00001Log, '{"type":"USER_INPUT"}\n', "utf8");
  fs.writeFileSync(c00319Log, '{"type":"USER_INPUT"}\n', "utf8");
  const baseSec = Math.floor(Date.now() / 1000) - 100;
  fs.utimesSync(c00319Log, baseSec, baseSec);
  fs.utimesSync(c00001Log, baseSec + 90, baseSec + 90);

  const dbUnidx = new DatabaseSync(path.join(agUnidx, "conversation_summaries.db"));
  try {
    dbUnidx.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, last_modified_time INTEGER);");
    dbUnidx.exec("BEGIN");
    const ins = dbUnidx.prepare("INSERT INTO conversation_summaries VALUES (?, ?)");
    for (let i = 1; i <= 320; i++) {
      ins.run(`c${String(i).padStart(5, "0")}`, i === 1 ? 999999999 : i);
    }
    dbUnidx.exec("COMMIT");
  } finally {
    dbUnidx.close();
  }

  const meta = queryRecentConversationIdsFromSummaryDb(brainUnidx, 10);
  assert.equal(meta.status, "ok");
  assert.equal(meta.precision, "rowid_heuristic");
  clearTranscriptScanCache();
  const chosen = findTranscriptForConversation(null, {
    extraRoots: [brainUnidx],
    includeDefaultRoots: false,
    noCache: true
  });
  assert.equal(chosen, c00001Log, "rowid_heuristic must cross-check filesystem mtimes so recently updated c00001 wins over c00319");
});

test("Wave1-B4 (M12): executor allowlists OS/toolchain env, supports config.json execEnvAllowlist, hard-filters secrets & respects empty env: {}", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m12-env-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const cfgPath = path.join(tmpDir, "config.json");
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const savedKeys = ["AGY_TEST_RANDOM_VAR", "AGY_TEST_CONFIG_ALLOWED", "OPENAI_API_KEY", "MY_CUSTOM_SECRET_TOKEN"];
  const prevVals = Object.fromEntries(savedKeys.map((k) => [k, process.env[k]]));

  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        execEnvAllowlist: ["AGY_TEST_CONFIG_ALLOWED", "OPENAI_API_KEY", "MY_CUSTOM_SECRET_TOKEN"]
      }),
      "utf8"
    );
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    process.env.AGY_TEST_RANDOM_VAR = "should-not-leak";
    process.env.AGY_TEST_CONFIG_ALLOWED = "allowed-by-config";
    process.env.OPENAI_API_KEY = "sk-live-secret-should-be-blocked";
    process.env.MY_CUSTOM_SECRET_TOKEN = "tok-secret-should-be-blocked";
    resetConfigCache();

    // 1. Hard credential filter beats config allowlist
    assert.equal(isSensitiveEnvKey("OPENAI_API_KEY"), true);
    assert.equal(isSensitiveEnvKey("MY_CUSTOM_SECRET_TOKEN"), true);
    assert.equal(isSensitiveEnvKey("AGY_TEST_CONFIG_ALLOWED"), false);

    const built = buildSafeChildEnv(process.env);
    assert.equal(built.AGY_TEST_CONFIG_ALLOWED, "allowed-by-config");
    assert.equal(built.AGY_TEST_RANDOM_VAR, undefined);
    assert.equal(built.OPENAI_API_KEY, undefined, "Credential hard-filter must beat config allowlist");
    assert.equal(built.MY_CUSTOM_SECRET_TOKEN, undefined, "Credential hard-filter must beat config allowlist");

    // 2. executeCode inherits only safe allowlisted env
    const execRes = await executeCode({
      language: "nodejs",
      code: 'console.log(JSON.stringify({ allowed: process.env.AGY_TEST_CONFIG_ALLOWED || null, random: process.env.AGY_TEST_RANDOM_VAR || null, openai: process.env.OPENAI_API_KEY || null, secret: process.env.MY_CUSTOM_SECRET_TOKEN || null, hasPath: Boolean(process.env.PATH || process.env.Path) }));',
      cwd: tmpDir
    });
    assert.equal(execRes.ok, true, execRes.stderr);
    const seen = JSON.parse(execRes.stdout.trim());
    assert.deepEqual(seen, {
      allowed: "allowed-by-config",
      random: null,
      openai: null,
      secret: null,
      hasPath: true
    });

    // 3. Explicit `env: {}` passed to runProcess preserves empty env semantics (never re-merges process.env)
    const emptyRes = await runProcess({
      cmd: process.execPath,
      args: [
        "-e",
        'console.log(JSON.stringify({ allowed: process.env.AGY_TEST_CONFIG_ALLOWED || null, random: process.env.AGY_TEST_RANDOM_VAR || null, openai: process.env.OPENAI_API_KEY || null }))'
      ],
      cwd: tmpDir,
      env: {}
    });
    assert.equal(emptyRes.ok, true, emptyRes.stderr);
    assert.deepEqual(JSON.parse(emptyRes.stdout.trim()), { allowed: null, random: null, openai: null });
  } finally {
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    for (const k of savedKeys) {
      if (prevVals[k] === undefined) delete process.env[k];
      else process.env[k] = prevVals[k];
    }
    resetConfigCache();
  }
});

test("Wave1-B4 (M13): fetchUrlText and validateFetchTarget enforce wall-clock deadline during slow DNS lookup", async () => {
  const slowResolveLookup = async () => {
    await new Promise((r) => setTimeout(r, 220));
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const slowRejectLookup = async () => {
    await new Promise((r) => setTimeout(r, 220));
    throw new Error("late DNS failure");
  };

  const t0 = Date.now();
  await assert.rejects(
    fetchUrlText("https://example.com/slow-dns", { timeoutMs: 25, lookupFn: slowResolveLookup }),
    /Request timed out/
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 160, `DNS timeout must abort near 25ms instead of waiting for 220ms DNS, got ${elapsed}ms`);

  const t1 = Date.now();
  await assert.rejects(
    validateFetchTarget("https://example.com/slow-dns-reject", { timeoutMs: 25, lookupFn: slowRejectLookup }),
    /Request timed out/
  );
  assert.ok(Date.now() - t1 < 160);
});

// ---------------------------------------------------------------------------
// Batch 5: M14, M15, M16, M17
// ---------------------------------------------------------------------------

test("Wave1-B5 (M14): cancelled/failed read invalidates pending read cache so immediate retry succeeds; fallback wording stays accurate", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-m14-read-"));
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const prevDb = process.env.AGY_DART_DB_PATH;
  process.env.AGY_DART_CONFIG_PATH = path.join(dir, "cfg.json");
  process.env.AGY_DART_DB_PATH = path.join(dir, "ctx.db");
  resetConfigCache();
  t.after(() => {
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    resetConfigCache();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const sampleJs = path.join(dir, "sample.js");
  fs.writeFileSync(sampleJs, "// sample\n" + "export const val = '0123456789abcdef';\n".repeat(220), "utf8");

  // 1. Direct PostToolUse cancel/error receipt invalidates pending read so 2nd read is allowed immediately
  const sid1 = "m14-cancel-sess";
  const r1 = await evaluatePreToolPayload({
    sessionId: sid1,
    cwd: dir,
    toolCall: { name: "read_file", args: { Path: sampleJs } }
  });
  assert.equal(r1.verdict?.decision, "allow", "First read allowed");

  await processPostToolPayload({
    sessionId: sid1,
    cwd: dir,
    toolCall: { name: "read_file", args: { Path: sampleJs } },
    cancelled: true,
    is_error: true
  });

  const r2 = await evaluatePreToolPayload({
    sessionId: sid1,
    cwd: dir,
    toolCall: { name: "read_file", args: { Path: sampleJs } }
  });
  assert.equal(r2.verdict?.decision, "allow", "Immediate retry after cancelled read must be allowed");

  // 2. DSH native plugin forwards failed/cancelled `read` in tools/result so retry succeeds immediately
  const listeners = new Map();
  const mockCtx = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    inject() {},
    get() {
      return { get: () => dir };
    }
  };
  applyDshPlugin(mockCtx);
  const runPre = async (exec) => {
    const fns = listeners.get("tools/pre-execute") || [];
    let i = 0;
    const next = () => (i < fns.length ? fns[i++](exec, next) : Promise.resolve({ kind: "allow" }));
    return next();
  };
  const agent = { session: { id: "m14-dsh-sess", header: { cwd: dir } } };
  const exec1 = { name: "read", arguments: Object.freeze({ file_path: sampleJs }), agent };
  assert.equal((await runPre(exec1)).kind, "allow");
  for (const fn of listeners.get("tools/result") || []) {
    fn(exec1, { isError: true, cancelled: true, content: [{ type: "text", text: "cancelled" }] });
  }
  await new Promise((r) => setTimeout(r, 150));
  const exec2 = { name: "read", arguments: Object.freeze({ file_path: sampleJs }), agent };
  assert.equal((await runPre(exec2)).kind, "allow", "DSH retry after failed/cancelled read must be allowed immediately");

  // 3. Without a cancel receipt, 2nd call still dedups with accurate "already allowed" + retry wording, and 3rd bypasses
  const sid2 = "m14-no-receipt-sess";
  const firstNoReceipt = await evaluatePreToolPayload({
    sessionId: sid2,
    cwd: dir,
    toolCall: { name: "read_file", args: { Path: sampleJs } }
  });
  assert.equal(firstNoReceipt.verdict?.decision, "allow");
  const denied = await evaluatePreToolPayload({
    sessionId: sid2,
    cwd: dir,
    toolCall: { name: "read_file", args: { Path: sampleJs } }
  });
  assert.equal(denied.verdict?.decision, "deny");
  assert.match(denied.verdict?.reason || "", /already allowed/i);
  assert.match(denied.verdict?.reason || "", /cancelled\/failed/i);
  const bypassed = await evaluatePreToolPayload({
    sessionId: sid2,
    cwd: dir,
    toolCall: { name: "read_file", args: { Path: sampleJs } }
  });
  assert.equal(bypassed.verdict?.decision, "allow", "2-strike bypass still works");
});

test("Wave1-B5 (M15): Dashboard search and inspectSource ignore stale out-of-order responses and invalidate on scope switch", async () => {
  const html = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  const inspectMatch = html.match(/async function inspectSource\([\s\S]*?\n    \}/);
  const searchMatch = html.match(/async function executeSearch\([\s\S]*?\n    \}/);
  assert.ok(inspectMatch && searchMatch, "Must locate inspectSource and executeSearch in index.html");
  assert.match(html, /let searchRequestSeq = 0;/, "Shared searchRequestSeq counter must exist");

  const inputEl = { value: "" };
  const resultsEl = { innerHTML: "" };
  const pendingResolvers = [];
  const ctx = vm.createContext({
    searchRequestSeq: 0,
    currentScope: "conversation",
    document: {
      getElementById(id) {
        if (id === "search-input") return inputEl;
        if (id === "search-results") return resultsEl;
        return null;
      }
    },
    escapeHtml: (s) => String(s),
    t: (k) => k,
    getActiveConversationId: () => "conv-1",
    console,
    apiFetch(url, opts) {
      return new Promise((resolve) => {
        pendingResolvers.push({ url, body: JSON.parse(opts.body), resolve });
      });
    },
    Promise
  });

  vm.runInContext(`${inspectMatch[0]}\n${searchMatch[0]}`, ctx);

  // Fire query #1 ("slow"), then query #2 ("fast")
  inputEl.value = "slow";
  const p1 = ctx.executeSearch();
  inputEl.value = "fast";
  const p2 = ctx.executeSearch();
  assert.equal(pendingResolvers.length, 2);

  // Query #2 resolves FIRST
  pendingResolvers[1].resolve({
    ok: true,
    json: async () => ({ hits: [{ title: "FAST_RESULT", rrfScore: 9, snippet: "fresh" }] })
  });
  await p2;
  assert.match(resultsEl.innerHTML, /FAST_RESULT/);

  // Query #1 resolves LATE -> MUST NOT overwrite FAST_RESULT!
  pendingResolvers[0].resolve({
    ok: true,
    json: async () => ({ hits: [{ title: "STALE_RESULT", rrfScore: 1, snippet: "old" }] })
  });
  await p1;
  assert.match(resultsEl.innerHTML, /FAST_RESULT/, "Late stale search must never overwrite newer query results");
  assert.doesNotMatch(resultsEl.innerHTML, /STALE_RESULT/);

  // Cross-race: inspectSource starts, then user switches scope (bumping searchRequestSeq) -> stale inspectSource ignored
  const pInspect = ctx.inspectSource("src-old", encodeURIComponent("old-source"));
  ctx.searchRequestSeq += 1;
  pendingResolvers[2].resolve({
    ok: true,
    json: async () => ({ chunks: [{ title: "STALE_CHUNK", body: "old chunk" }] })
  });
  await pInspect;
  assert.doesNotMatch(resultsEl.innerHTML, /STALE_CHUNK/);
});

test("Wave1-B5 (M16+M17): diagnostics.html shrinks height from rootEl & cancels RAF on teardown; Mocha & Latte placeholders meet WCAG AA", async () => {
  // 1. M16: diagnostics.html shrink + dedup + teardown RAF cancellation
  const diagHtml = fs.readFileSync(path.join(ROOT, "context", "ui", "diagnostics.html"), "utf8");
  const scriptMatch = diagHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  let currentRootHeight = 245;
  const makeNode = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      style: { setProperty() {} },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { const idx = this.children.indexOf(c); if (idx >= 0) this.children.splice(idx, 1); },
      get firstChild() { return this.children[0] || null; },
      addEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      scrollWidth: 480,
      offsetWidth: 480,
      get offsetHeight() { return currentRootHeight; },
      getBoundingClientRect() { return { width: 480, height: currentRootHeight }; }
    };
    return node;
  };
  const rootEl = makeNode("div");
  // Simulate host clamping documentElement.scrollHeight to old tall iframe height (245) even after content shrinks!
  const docEl = { ...makeNode("html"), scrollHeight: 245, scrollWidth: 480 };
  const posted = [];
  const winListeners = new Map();
  const rafQueue = new Map();
  let nextRaf = 1;
  const cancelledRafs = [];
  const mockParent = { postMessage: (msg) => posted.push(structuredClone(msg)) };
  const ctx = vm.createContext({
    window: {
      parent: mockParent,
      addEventListener: (e, fn) => {
        if (!winListeners.has(e)) winListeners.set(e, []);
        winListeners.get(e).push(fn);
      },
      removeEventListener: () => {}
    },
    document: {
      documentElement: docEl,
      getElementById: (id) => (id === "root" ? rootEl : null),
      createElement: (tag) => makeNode(tag)
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(fn) {
      const id = nextRaf++;
      rafQueue.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledRafs.push(id);
      rafQueue.delete(id);
    },
    setTimeout,
    clearTimeout,
    Map, Set, Promise, Object, Array, Number, String, Boolean, Math, JSON, Error, RegExp
  });
  const flushRaf = () => {
    for (const [id, fn] of [...rafQueue.entries()]) {
      rafQueue.delete(id);
      fn();
    }
  };
  const dispatch = (data) => {
    for (const fn of [...(winListeners.get("message") || [])]) fn({ data, source: mockParent });
  };

  vm.runInContext(scriptMatch[1], ctx);
  // Render tall stats card (245px)
  dispatch({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { kind: "ctx_stats", stats: { calls: 1, totalRawBytes: 5000, totalReturnedBytes: 500, keptOutBytes: 4500, tokensKeptOut: 1125, savingsPercent: 90 } } }
  });
  flushRaf();
  let sizeMsgs = posted.filter((m) => m.method === "ui/notifications/size-changed");
  assert.equal(sizeMsgs.at(-1)?.params?.height, 245);

  // Cancel -> content shrinks to 55px while documentElement.scrollHeight stays 245px
  currentRootHeight = 55;
  dispatch({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: {} });
  flushRaf();
  sizeMsgs = posted.filter((m) => m.method === "ui/notifications/size-changed");
  assert.equal(sizeMsgs.at(-1)?.params?.height, 55, "Shrunk card must report 55px instead of clamped 245px viewport height");

  // Unchanged size does not emit duplicate notification
  const countBeforeDup = sizeMsgs.length;
  dispatch({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: {} });
  flushRaf();
  assert.equal(posted.filter((m) => m.method === "ui/notifications/size-changed").length, countBeforeDup);

  // Queued RAF is cancelled cleanly on ui/resource-teardown
  currentRootHeight = 120;
  dispatch({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: {} });
  assert.equal(rafQueue.size, 1);
  dispatch({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} });
  assert.equal(cancelledRafs.length, 1, "Pending RAF must be cancelled on teardown");
  assert.equal(rafQueue.size, 0);

  // 2. M17: Mocha and Latte placeholder text contrast meets WCAG 2.2 AA (>= 4.5:1)
  const dashHtml = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  const mochaBlock = dashHtml.match(/:root\[data-theme="mocha"\][\s\S]*?\n    \}/);
  assert.ok(mochaBlock, "Mocha theme block must exist");
  const mochaInputBg = mochaBlock[0].match(/--input-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
  const mochaPlaceholder = mochaBlock[0].match(/--placeholder-color:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(mochaInputBg && mochaPlaceholder);
  const mochaRatio = wcagContrastRatio(mochaPlaceholder, mochaInputBg);
  assert.ok(mochaRatio >= 4.5, `Mocha placeholder contrast must be >= 4.5:1, got ${mochaRatio.toFixed(2)}:1 (${mochaPlaceholder} on ${mochaInputBg})`);

  const rootBlock = dashHtml.match(/:root\s*\{[\s\S]*?\n    \}/);
  assert.ok(rootBlock);
  const latteBg = rootBlock[0].match(/--bg-panel:\s*(#[0-9a-fA-F]{6})/)?.[1];
  const lattePlaceholder = rootBlock[0].match(/--placeholder-color:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(latteBg && lattePlaceholder);
  const latteRatio = wcagContrastRatio(lattePlaceholder, latteBg);
  assert.ok(latteRatio >= 4.5, `Latte placeholder contrast must be >= 4.5:1, got ${latteRatio.toFixed(2)}:1`);
});
