import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

import { CONFIG_DEFAULTS, getEffectiveConfig, resetConfigCache } from "../context/lib/config.js";
import { DEVTOOLS_FILES, RUNTIME_FILES } from "../scripts/install.mjs";
import { verifyPackageManifest } from "../scripts/verify-package-graph.mjs";
import {
  AUTO_UPDATE_ROUTE,
  closeRuntimeStore,
  createStandaloneServer,
  handleAutoUpdateMutation,
  handlePluginUpdate,
  handleVersionCheck,
  invalidateVersionCache,
  isPluginUpdateBusy,
  registerSidecarRoutes,
  runAutoUpdateCycle
} from "../sidecars/dashboard/server.mjs";
import {
  downloadArchive,
  readReleaseArchive,
  UpdateError,
  verifyArchiveSha256
} from "../sidecars/dashboard/update-archive.mjs";
import {
  compareVersions,
  createVersionChecker,
  parseVersion,
  readLocalVersion,
  RELEASES_URL,
  selectReleasePackageAsset,
  VERSION_ROUTE
} from "../sidecars/dashboard/version-check.mjs";
import {
  createPluginUpdater,
  evaluateAutoInstallEligibility,
  extractStaticRelativeImports,
  hasActiveUpdateMarker,
  resolveInstalledRoot,
  UPDATE_MARKER_NAME,
  UPDATE_ROUTE
} from "../sidecars/dashboard/version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTarHeader(name, size, typeByte, { prefix = "", mode = typeByte === 53 ? 0o755 : 0o644 } = {}) {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name, "utf8").copy(header, 0, 0, 100);
  Buffer.from(mode.toString(8).padStart(7, "0") + "\0", "latin1").copy(header, 100);
  Buffer.from("0000000\0", "latin1").copy(header, 108);
  Buffer.from("0000000\0", "latin1").copy(header, 116);
  Buffer.from(size.toString(8).padStart(11, "0") + "\0", "latin1").copy(header, 124);
  Buffer.from("00000000000\0", "latin1").copy(header, 136);
  Buffer.from("        ", "latin1").copy(header, 148);
  header[156] = typeByte;
  Buffer.from("ustar\0", "latin1").copy(header, 257);
  Buffer.from("00", "latin1").copy(header, 263);
  if (prefix) Buffer.from(prefix, "utf8").copy(header, 345, 0, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "latin1").copy(header, 148);
  return header;
}

function makePaxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let len = Buffer.byteLength(body, "utf8") + 3;
  while (true) {
    const candidate = `${len} ${body}`;
    const actual = Buffer.byteLength(candidate, "utf8");
    if (actual === len) return Buffer.from(candidate, "utf8");
    len = actual;
  }
}

function buildTarGz(entries, { includeGlobalComment = false, corruptChecksum = false } = {}) {
  const blocks = [];
  if (includeGlobalComment) {
    const comment = Buffer.from(`52 comment=${"a".repeat(40)}\n`, "latin1");
    blocks.push(makeTarHeader("pax_global_header", comment.length, 103));
    blocks.push(comment);
    const pad = (512 - (comment.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  for (const entry of entries) {
    const contentBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || "", "utf8");
    const typeByte = entry.type ?? 48;
    if (entry.rawPaxBuf || entry.paxRecords) {
      const paxBuf = entry.rawPaxBuf || Buffer.concat(entry.paxRecords.map(([k, v]) => makePaxRecord(k, v)));
      blocks.push(makeTarHeader("PaxHeader", paxBuf.length, 120));
      blocks.push(paxBuf);
      const pad = (512 - (paxBuf.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
    const headerSize = entry.headerSize !== undefined ? entry.headerSize : typeByte === 53 ? 0 : contentBuf.length;
    const hdr = makeTarHeader(entry.name, headerSize, typeByte, {
      prefix: entry.prefix || ""
    });
    if (corruptChecksum) hdr[148] = 0x41;
    blocks.push(hdr);
    if (typeByte !== 53 && contentBuf.length > 0) {
      blocks.push(contentBuf);
      const pad = (512 - (contentBuf.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function makeMockJsonRes(status, body, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => headerMap.get(k.toLowerCase()) ?? null
    },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body)
  };
}

function makeMockStreamRes(status, buffer, headers = {}, url = "") {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let consumed = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (k) => headerMap.get(k.toLowerCase()) ?? null
    },
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

function createReleaseArchiveEntries(
  version,
  {
    rootPrefix = `Antigravity-agy-dart-${version}`,
    extraRuntimeFiles = {},
    includeDevtools = false,
    includeManifest = true,
    brokenImport = false,
    brokenMultilineImport = false,
    serverSource = null
  } = {}
) {
  const runtimeList = [
    ...(includeManifest ? RUNTIME_FILES : RUNTIME_FILES.filter((f) => f !== "scripts/package-manifest.json")),
    ...Object.keys(extraRuntimeFiles)
  ];
  const devtoolsList = includeDevtools ? [...DEVTOOLS_FILES] : [];
  const installScript = `export const FAST_MCP_TOOL_NAMES = Object.freeze(["apply_edits", "batch_search", "read_slices", "run_checks"]);
export const CONTEXT_MCP_TOOL_NAMES = Object.freeze(["ctx_batch", "ctx_doctor", "ctx_execute", "ctx_index", "ctx_purge", "ctx_resume", "ctx_search", "ctx_stats"]);
export const RUNTIME_FILES = Object.freeze([
  // comment with "ignored/fake.js" should not be parsed
${runtimeList.map((f) => `  ${JSON.stringify(f)}`).join(",\n")}
]);
export const DEVTOOLS_FILES = Object.freeze(${JSON.stringify(devtoolsList, null, 2)});
`;
  const sidecarJson = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8");
  const mcpJson = fs.readFileSync(path.join(ROOT, "mcp_config.json"), "utf8");
  const hooksJson = fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8");

  const filesMap = new Map();
  for (const rel of runtimeList) {
    filesMap.set(rel, `// stub for ${rel} v${version}\n`);
  }
  for (const rel of devtoolsList) {
    filesMap.set(rel, `// devtools stub for ${rel} v${version}\n`);
  }
  if (includeManifest) {
    filesMap.set(
      "scripts/package-manifest.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          runtimeFiles: runtimeList,
          devtoolsFiles: devtoolsList,
          fastMcpTools: ["apply_edits", "batch_search", "read_slices", "run_checks"],
          contextMcpTools: [
            "ctx_batch",
            "ctx_doctor",
            "ctx_execute",
            "ctx_index",
            "ctx_purge",
            "ctx_resume",
            "ctx_search",
            "ctx_stats"
          ]
        },
        null,
        2
      )
    );
  }
  filesMap.set("plugin.json", JSON.stringify({ name: "agy-dart", version }, null, 2));
  filesMap.set("package.json", JSON.stringify({ name: "agy-dart", version, type: "module" }, null, 2));
  filesMap.set("mcp_config.json", mcpJson);
  filesMap.set("hooks.json", hooksJson);
  filesMap.set("sidecars/dashboard/sidecar.json", sidecarJson);
  filesMap.set(
    "sidecars/dashboard/server.mjs",
    serverSource ||
      (brokenImport
        ? 'import "./does-not-exist.mjs";\n'
        : brokenMultilineImport
          ? 'import {\n  missingSymbol\n} from "./does-not-exist.mjs";\n'
          : 'import {\n  v as checkedVer\n} from "./version-check.mjs";\nexport const v = checkedVer;\n')
  );
  filesMap.set("sidecars/dashboard/index.html", `<html><span id="dashboard-version">--</span></html>`);
  filesMap.set("sidecars/dashboard/version-check.mjs", `export const v = "${version}";\n`);
  filesMap.set("sidecars/dashboard/update-archive.mjs", `export const a = 1;\n`);
  filesMap.set("sidecars/dashboard/version-update.mjs", `export const u = 1;\n`);
  filesMap.set("scripts/install.mjs", installScript);
  filesMap.set("context/server.js", "// ctx\n");
  filesMap.set("fast/mcp-server.mjs", "// fast\n");
  for (const [rel, content] of Object.entries(extraRuntimeFiles)) {
    filesMap.set(rel, content);
  }

  return Array.from(filesMap.entries()).map(([rel, content]) => ({
    name: `${rootPrefix}/${rel}`,
    content
  }));
}

async function httpRequest(port, reqPath, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          Referer: `http://127.0.0.1:${port}/`,
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function setupMockPluginInstall(rootDir, version = "1.7.2") {
  const sidecarDir = path.join(rootDir, "sidecars", "dashboard");
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, "rules"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "plugin.json"), JSON.stringify({ name: "agy-dart", version }));
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "agy-dart", version }));
  fs.writeFileSync(path.join(sidecarDir, "sidecar.json"), fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8"));
  fs.writeFileSync(path.join(sidecarDir, "server.mjs"), "// old server\n");
  return sidecarDir;
}

test("v1.7.6-1: version-check SemVer parsing, comparison, rate-limit, caching & auto/manual modes", async () => {
  assert.deepEqual(parseVersion("v1.7.2")?.version, "1.7.2");
  assert.equal(parseVersion("1.7.2-beta.1")?.pre.length, 2);
  assert.equal(parseVersion("1.7.2-01"), null);
  assert.equal(parseVersion("invalid"), null);

  assert.equal(compareVersions("1.8.0", "1.7.2"), 1);
  assert.equal(compareVersions("1.7.2", "1.7.2"), 0);
  assert.equal(compareVersions("1.7.1", "1.7.2"), -1);
  assert.equal(compareVersions("1.8.0", "1.8.0-rc.1"), 1);
  assert.equal(compareVersions(readLocalVersion(ROOT), "1.0.0"), 1);

  let fakeNow = 1_000_000;
  let fetchCalls = 0;
  const checker = createVersionChecker({
    getCurrentVersion: () => "1.7.2",
    now: () => fakeNow,
    fetchImpl: async () => {
      fetchCalls += 1;
      return makeMockJsonRes(200, {
        tag_name: "v1.8.0",
        draft: false,
        prerelease: false,
        published_at: "2026-11-26T00:00:00Z"
      });
    }
  });

  // Concurrent auto + manual share single-flight request
  const [rAuto, rManual] = await Promise.all([checker("auto"), checker("manual")]);
  assert.equal(fetchCalls, 1);
  assert.equal(rAuto.status, "update");
  assert.equal(rManual.status, "update");
  assert.equal(rManual.latestVersion, "1.8.0");
  assert.equal(rManual.releaseUrl, `${RELEASES_URL}/tag/v1.8.0`);

  // Manual 5s dedupe reuses recent successful result unless fresh=true
  await checker("manual");
  assert.equal(fetchCalls, 1);
  await checker("manual", { fresh: true });
  assert.equal(fetchCalls, 2);

  // Invalid mode returns error
  const invalidMode = await checker("bogus");
  assert.equal(invalidMode.status, "error");
  assert.equal(invalidMode.reason, "invalidMode");

  // Rate-limit & prerelease/404/network handling
  let scenario = "429";
  let limitCalls = 0;
  const errChecker = createVersionChecker({
    getCurrentVersion: () => "1.7.2",
    now: () => fakeNow,
    fetchImpl: async () => {
      limitCalls += 1;
      if (scenario === "429") {
        return makeMockJsonRes(429, { message: "rate limit" }, { "retry-after": "120" });
      }
      if (scenario === "prerelease") {
        return makeMockJsonRes(200, { tag_name: "v1.9.0-rc.1", prerelease: true, draft: false });
      }
      if (scenario === "404") return makeMockJsonRes(404, {});
      throw new Error("ECONNREFUSED");
    }
  });

  const rlAuto = await errChecker("auto");
  assert.equal(rlAuto.status, "idle", "auto mode suppresses errors into idle");
  const rlManual = await errChecker("manual");
  assert.equal(rlManual.status, "error");
  assert.equal(rlManual.reason, "rateLimit");
  assert.equal(limitCalls, 1, "active rateLimit cooldown prevents extra fetches");

  fakeNow += 130_000;
  scenario = "prerelease";
  const preRes = await errChecker("manual", { fresh: true });
  assert.equal(preRes.reason, "invalidRelease");

  scenario = "404";
  const notFoundRes = await errChecker("manual", { fresh: true });
  assert.equal(notFoundRes.reason, "noRelease");

  scenario = "net";
  const callsBeforeNet = limitCalls;
  const netRes1 = await errChecker("manual");
  assert.equal(netRes1.reason, "network");
  assert.equal(limitCalls, callsBeforeNet + 1);
  // Error responses must NOT be cached by 5s manual dedupe so immediate Retry makes a real request
  const netRes2 = await errChecker("manual");
  assert.equal(netRes2.reason, "network");
  assert.equal(limitCalls, callsBeforeNet + 2, "immediate manual Retry after error must not be blocked by 5s dedupe");
});

test("v1.7.6-2: update-archive validates HTTPS redirects, size limits, pax/ustar paths & rejects symlinks/traversal", async () => {
  // Valid redirect within allowed GitHub hosts (including release-assets.githubusercontent.com)
  const samplePayload = Buffer.from("hello-tarball");
  let step = 0;
  const downloaded = await downloadArchive("https://api.github.com/repos/zou172866/Antigravity-agy-dart/tarball/v1.8.0", {
    fetchImpl: async (url) => {
      step += 1;
      if (step === 1) {
        return makeMockStreamRes(302, Buffer.alloc(0), { location: "https://codeload.github.com/archive.tar.gz" }, url);
      }
      return makeMockStreamRes(200, samplePayload, { "content-length": String(samplePayload.length) }, url);
    }
  });
  assert.deepEqual(downloaded, samplePayload);

  // Disallowed redirect host blocked
  await assert.rejects(
    downloadArchive("https://api.github.com/repos/zou172866/Antigravity-agy-dart/tarball/v1.8.0", {
      fetchImpl: async () => makeMockStreamRes(302, Buffer.alloc(0), { location: "https://evil.example.com/a.tgz" })
    }),
    (err) => err instanceof UpdateError && err.reason === "redirect"
  );

  // Oversize archive rejected
  await assert.rejects(
    downloadArchive("https://api.github.com/repos/zou172866/Antigravity-agy-dart/tarball/v1.8.0", {
      maxBytes: 8,
      fetchImpl: async () => makeMockStreamRes(200, Buffer.alloc(16, 1), {})
    }),
    (err) => err instanceof UpdateError && err.reason === "size"
  );

  // Valid GitHub pax + ustar archive strips top-level folder (including PAX size override)
  const paxContent = "pax-sized-payload-12345";
  const validTgz = buildTarGz(
    [
      { name: "repo-v1.8.0/plugin.json", content: '{"name":"agy-dart","version":"1.8.0"}' },
      {
        name: "repo-v1.8.0/ignored",
        content: "long-path-content",
        paxRecords: [["path", "repo-v1.8.0/skills/agy-dart/references/long-doc.md"]]
      },
      {
        name: "repo-v1.8.0/pax-size.txt",
        content: paxContent,
        headerSize: 0,
        paxRecords: [["size", String(Buffer.byteLength(paxContent))]]
      }
    ],
    { includeGlobalComment: true }
  );
  const parsedMap = await readReleaseArchive(validTgz);
  assert.equal(parsedMap.get("plugin.json")?.toString("utf8"), '{"name":"agy-dart","version":"1.8.0"}');
  assert.equal(parsedMap.get("skills/agy-dart/references/long-doc.md")?.toString("utf8"), "long-path-content");
  assert.equal(parsedMap.get("pax-size.txt")?.toString("utf8"), paxContent);

  // Reject symlinks, traversal, Windows reserved names, case-collisions, pax linkpath, bad UTF-8 in PAX & bad checksum
  const invalidUtf8Pax = Buffer.concat([Buffer.from("12 path="), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from("\n")]);
  for (const badEntries of [
    [{ name: "repo-v1.8.0/evil-link", content: "", type: 50 }],
    [{ name: "repo-v1.8.0/../escape.txt", content: "x" }],
    [{ name: "repo-v1.8.0/CON.txt", content: "x" }],
    [
      { name: "repo-v1.8.0/File.txt", content: "a" },
      { name: "repo-v1.8.0/file.txt", content: "b" }
    ],
    [{ name: "repo-v1.8.0/a.txt", content: "x", paxRecords: [["linkpath", "/etc/passwd"]] }],
    [{ name: "repo-v1.8.0/bad-utf8.txt", content: "x", rawPaxBuf: invalidUtf8Pax }]
  ]) {
    await assert.rejects(
      readReleaseArchive(buildTarGz(badEntries)),
      (err) => err instanceof UpdateError && err.reason === "archive"
    );
  }
  await assert.rejects(
    readReleaseArchive(buildTarGz([{ name: "repo-v1.8.0/a.txt", content: "x" }], { corruptChecksum: true })),
    (err) => err instanceof UpdateError && err.reason === "archive"
  );
});

test("v1.7.6-3: version-update atomically replaces files, preserves local settings/rules, blocks git checkout & rolls back on error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-upd-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const installedRoot = path.join(pluginsDir, "agy-dart");
    const sidecarDir = setupMockPluginInstall(installedRoot, "1.7.2");
    fs.mkdirSync(path.join(installedRoot, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(installedRoot, "rules", "custom.local.md"), "# User local override\n");
    fs.writeFileSync(path.join(installedRoot, "legacy", "obsolete.js"), "// obsolete\n");

    // Existing installation configured eager MCP tools + no-read-hook mode
    const eagerMcp = {
      mcpServers: {
        fast: { command: "node", args: ["${PLUGIN_ROOT}/fast/mcp-server.mjs"], tools: { apply_edits: { eager: true } } },
        context: { command: "node", args: ["${PLUGIN_ROOT}/context/server.js"], tools: { ctx_search: { eager: true } } }
      }
    };
    fs.writeFileSync(path.join(installedRoot, "mcp_config.json"), JSON.stringify(eagerMcp));
    fs.writeFileSync(
      path.join(installedRoot, "hooks.json"),
      JSON.stringify({ "agy-dart-lifecycle": { PreToolUse: [{ matcher: "run_command", hooks: [] }] } })
    );

    const tgz180 = buildTarGz(
      createReleaseArchiveEntries("1.8.0", {
        extraRuntimeFiles: {
          "context/lib/new-module.js": "// new module\n"
        }
      })
    );

    const checkVersion = async () => ({
      ok: true,
      status: "update",
      currentVersion: "1.7.2",
      latestVersion: "1.8.0",
      releaseTag: "v1.8.0",
      releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
    });

    // 1. Atomic rollback test when move fails mid-replace (EBUSY)
    let moveCount = 0;
    const failingUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) },
      move: async (from, to) => {
        moveCount += 1;
        if (moveCount === 5) {
          const err = new Error("busy");
          err.code = "EBUSY";
          throw err;
        }
        return fs.promises.rename(from, to);
      }
    });
    const failedRes = await failingUpdater("1.8.0");
    assert.equal(failedRes.status, "error");
    assert.equal(failedRes.reason, "locked");
    assert.equal(failedRes.diagnostics?.restored, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedRoot, "plugin.json"), "utf8")).version, "1.7.2");
    assert.equal(fs.existsSync(path.join(installedRoot, "legacy", "obsolete.js")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, UPDATE_MARKER_NAME)), false);

    // 2. Full successful upgrade
    const updater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) }
    });
    const okRes = await updater("1.8.0");
    assert.equal(okRes.status, "updated");
    assert.equal(okRes.version, "1.8.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedRoot, "plugin.json"), "utf8")).version, "1.8.0");
    assert.equal(fs.existsSync(path.join(installedRoot, "context/lib/new-module.js")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, "rules/custom.local.md")), true, "rules/*.local.md preserved");
    assert.equal(fs.existsSync(path.join(installedRoot, "legacy/obsolete.js")), false, "obsolete file pruned");
    assert.equal(fs.existsSync(path.join(installedRoot, UPDATE_MARKER_NAME)), false);

    // Preserved eager MCP & no-read-hook matcher
    const updatedMcp = JSON.parse(fs.readFileSync(path.join(installedRoot, "mcp_config.json"), "utf8"));
    assert.equal(updatedMcp.mcpServers.context.tools?.ctx_search?.eager, true);
    const updatedHooks = JSON.parse(fs.readFileSync(path.join(installedRoot, "hooks.json"), "utf8"));
    assert.equal(updatedHooks["agy-dart-lifecycle"].PreToolUse[0].matcher, "run_command");

    // 3. Broken single-line AND multiline static imports inside release archive are rejected before modifying live files
    for (const opts of [{ brokenImport: true }, { brokenMultilineImport: true }]) {
      const badTgz = buildTarGz(createReleaseArchiveEntries("1.9.0", opts));
      const brokenArchiveUpdater = createPluginUpdater({
        sidecarDirectory: sidecarDir,
        pluginsDirectory: pluginsDir,
        syncedHostsDir: path.join(tmpDir, "synced-hosts"),
        checkVersion: async () => ({
          ok: true,
          status: "update",
          currentVersion: "1.8.0",
          latestVersion: "1.9.0",
          releaseTag: "v1.9.0",
          releaseUrl: `${RELEASES_URL}/tag/v1.9.0`
        }),
        downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, badTgz) }
      });
      const brokenRes = await brokenArchiveUpdater("1.9.0");
      assert.equal(brokenRes.status, "error");
      assert.equal(brokenRes.reason, "incomplete");
    }

    // 4. Git checkout repo root is strictly protected
    const gitRepoSidecar = setupMockPluginInstall(path.join(tmpDir, "git-repo"), "1.7.2");
    fs.mkdirSync(path.join(tmpDir, "git-repo", ".git"), { recursive: true });
    await assert.rejects(
      resolveInstalledRoot(gitRepoSidecar, { allowCustomRoot: true }),
      (err) => err instanceof UpdateError && err.reason === "gitCheckout"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.6-4: /api/version & /api/update enforce POST-only, CSRF, Origin, Content-Type & strict input schemas", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-srv-"));
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = path.join(tmpDir, "ctx.db");
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "cfg.json");
  resetConfigCache();

  let srv = null;
  try {
    // 1. Direct handler validation
    assert.equal((await handleVersionCheck({ mode: "bogus" })).status, 400);
    assert.equal((await handleVersionCheck({ extra: 1 })).status, 400);
    assert.equal((await handlePluginUpdate({ version: "not-semver" })).status, 400);
    assert.equal((await handlePluginUpdate({ version: "1.8.0", extra: 1 })).status, 400);

    // 2. SidecarApp routes are strictly POST-only and trigger onUpdated callback & busy tracking
    const registered = [];
    let restarted = false;
    let busyDuringUpdate = false;
    registerSidecarRoutes(
      {
        config: { conversationId: "conv-1" },
        api(route, handler, method) {
          registered.push({ route, handler, method });
        }
      },
      {
        versionChecker: async (mode) => ({ ok: true, status: "current", mode, currentVersion: "1.7.2" }),
        pluginUpdater: async (version) => {
          busyDuringUpdate = isPluginUpdateBusy();
          return { ok: true, status: "updated", version };
        },
        onUpdated: () => {
          restarted = true;
        }
      }
    );
    assert.equal(registered.some((r) => r.method !== "POST"), false);
    const verRoute = registered.find((r) => r.route === VERSION_ROUTE);
    const updRoute = registered.find((r) => r.route === UPDATE_ROUTE);
    assert.ok(verRoute && updRoute);
    assert.equal((await verRoute.handler({ mode: "auto" })).status, "current");
    assert.equal((await updRoute.handler({ version: "1.8.0" })).status, "updated");
    assert.equal(busyDuringUpdate, true, "isPluginUpdateBusy() must suppress reloadTimer during update");
    assert.equal(isPluginUpdateBusy(), true, "isPluginUpdateBusy() must remain true once restart is scheduled");
    assert.equal(restarted, true);
    closeRuntimeStore();
    assert.equal(isPluginUpdateBusy(), false);

    // 3. Standalone HTTP server security checks
    const token = "test-csrf-token-v176";
    srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: { pollMs: 60_000 },
      versionChecker: async (mode) => ({
        ok: true,
        status: "update",
        mode,
        currentVersion: "1.7.2",
        latestVersion: "1.8.0",
        releaseTag: "v1.8.0",
        releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
      }),
      pluginUpdater: async (version) => ({ ok: true, status: "updated", version })
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address();

    for (const route of [VERSION_ROUTE, UPDATE_ROUTE]) {
      const get405 = await httpRequest(port, route, {
        method: "GET",
        headers: { "X-Agy-Dart-Token": token }
      });
      assert.equal(get405.status, 405);
      assert.equal(get405.headers.allow, "POST");

      const noCsrf = await httpRequest(port, route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.equal(noCsrf.status, 403);

      const crossSite = await httpRequest(port, route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agy-Dart-Token": token,
          "Sec-Fetch-Site": "cross-site"
        },
        body: "{}"
      });
      assert.equal(crossSite.status, 403);

      const badCt = await httpRequest(port, route, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Agy-Dart-Token": token },
        body: "{}"
      });
      assert.equal(badCt.status, 415);
    }

    const okVer = await httpRequest(port, VERSION_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ mode: "auto" })
    });
    assert.equal(okVer.status, 200);
    assert.equal(okVer.json.latestVersion, "1.8.0");

    const okUpd = await httpRequest(port, UPDATE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ version: "1.8.0" })
    });
    assert.equal(okUpd.status, 200);
    assert.equal(okUpd.json.status, "updated");
    invalidateVersionCache();
  } finally {
    if (srv) await new Promise((r) => srv.close(r));
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.6-5: Dashboard UI auto-checks on open, focuses banner on topbar click, sends fresh on retry & renders EN/ZH", async () => {
  const htmlSource = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/index.html"), "utf8");
  assert.ok(htmlSource.includes('id="version-check-btn"'));
  assert.ok(htmlSource.includes('id="version-update-banner"'));
  assert.ok(htmlSource.includes('id="version-update"'));
  assert.ok(htmlSource.includes("versionErrIntegrity"));
  assert.ok(htmlSource.indexOf('id="kv-cache-card"') < htmlSource.indexOf('id="star-milestone-banner"'));

  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainUiScript = scriptBlocks[scriptBlocks.length - 1][1];
  new vm.Script(mainUiScript, { filename: "sidecars/dashboard/index.html" });
  assert.equal(/apiFetch\([^)]*method:\s*['"]GET['"]/.test(mainUiScript), false);

  const elements = new Map();
  let scrolledBanner = false;
  let focusedUpdateBtn = false;
  const makeEl = (id) => ({
    id,
    value: id === "cutoff-select" ? "46080" : "",
    innerText: "",
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    href: "",
    hidden: id === "version-update-banner" || id === "version-update",
    disabled: false,
    style: {},
    dataset: {},
    options: id === "cutoff-select" ? [{ value: "0" }, { value: "46080" }] : [],
    classList: {
      _s: new Set(id === "version-update-banner" || id === "version-update" || id === "star-milestone-banner" ? ["hidden"] : []),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    getAttribute(attr) {
      return attr === "content" ? "vm-csrf" : "";
    },
    scrollIntoView() {
      if (id === "version-update-banner") scrolledBanner = true;
    },
    focus() {
      if (id === "version-update") focusedUpdateBtn = true;
    }
  });
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const apiCalls = [];
  let versionMode = "update";
  let updateMode = "ok";
  const scheduledCallbacks = [];

  const sandbox = {
    window: { location: { search: "", reload() {} }, addEventListener() {}, sidecar: null },
    document: {
      title: "",
      hidden: false,
      documentElement: { lang: "en" },
      getElementById: getEl,
      querySelector: () => getEl("meta-csrf"),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    navigator: { language: "en-US" },
    localStorage: { getItem: () => "en", setItem: () => {} },
    URLSearchParams,
    Headers,
    Intl,
    fetch: async (urlPath, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      apiCalls.push({ urlPath, method: opts.method || "GET", body });
      const mk = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
      if (urlPath === "/api/version") {
        if (versionMode === "error") {
          return mk({ ok: false, status: "error", reason: "network" });
        }
        return mk({
          ok: true,
          status: "update",
          currentVersion: "1.7.2",
          latestVersion: "1.8.0",
          releaseTag: "v1.8.0",
          releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
        });
      }
      if (urlPath === "/api/update") {
        if (updateMode === "locked") {
          return mk({ ok: false, status: "error", reason: "locked", diagnostics: { restored: true } });
        }
        if (updateMode === "integrity") {
          return mk({ ok: false, status: "error", reason: "integrity" });
        }
        return mk({ ok: true, status: "updated", version: "1.8.0" });
      }
      if (urlPath === "/api/stats") {
        return mk({
          version: "1.7.2",
          isPaused: false,
          cutoffBytes: 46080,
          exemptCategories: [],
          starPrompt: { state: "dismissed", shouldShow: false }
        });
      }
      return mk({ status: "HEALTHY", ok: true, recentEvents: [], recentSources: [] });
    },
    alert: () => {},
    confirm: () => true,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      scheduledCallbacks.push({ fn, ms });
      return scheduledCallbacks.length;
    },
    clearTimeout: () => {},
    console: { log() {}, warn() {}, error() {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${mainUiScript}\nglobalThis.__uiTest = { checkForUpdates, handleVersionButtonClick, handleVersionUpdateClick, dismissVersionBanner, setLanguage };`,
    sandbox
  );

  // Opening dashboard schedules one automatic version check (600ms delay)
  const autoTimer = scheduledCallbacks.find((c) => c.ms === 600);
  assert.ok(autoTimer, "Dashboard open must schedule automatic version check");
  await autoTimer.fn();

  assert.ok(apiCalls.some((c) => c.urlPath === "/api/version" && c.method === "POST" && c.body.mode === "auto"));
  assert.equal(getEl("version-update-banner").classList.contains("hidden"), false);
  assert.equal(getEl("version-update").classList.contains("hidden"), false);
  assert.equal(getEl("version-check-btn").classList.contains("has-update"), true);
  assert.ok(getEl("version-status-text").textContent.includes("1.8.0"));

  // Clicking topbar button while update banner is visible focuses the banner instead of re-fetching
  const callsBeforeTopbarClick = apiCalls.filter((c) => c.urlPath === "/api/version").length;
  sandbox.__uiTest.handleVersionButtonClick();
  assert.equal(apiCalls.filter((c) => c.urlPath === "/api/version").length, callsBeforeTopbarClick);
  assert.equal(scrolledBanner, true);
  assert.equal(focusedUpdateBtn, true);

  // Language switch translates update banner immediately
  sandbox.__uiTest.setLanguage("zh", false);
  assert.ok(getEl("version-update").textContent.includes("立即更新"));

  // Integrity failure renders localized SHA-256 error
  updateMode = "integrity";
  await sandbox.__uiTest.handleVersionUpdateClick();
  assert.equal(getEl("version-update-banner").dataset.state, "error");
  assert.ok(getEl("version-detail-text").textContent.includes("SHA-256"));

  // Update failure renders localized error + restored hint + retry button
  updateMode = "locked";
  await sandbox.__uiTest.handleVersionUpdateClick();
  assert.equal(getEl("version-update-banner").dataset.state, "error");
  assert.ok(getEl("version-detail-text").textContent.includes("已自动回滚"));
  assert.equal(getEl("version-update").textContent, "重试");

  // Retry succeeds and updates #dashboard-version immediately in standalone mode
  updateMode = "ok";
  await sandbox.__uiTest.handleVersionUpdateClick();
  assert.equal(getEl("version-update-banner").dataset.state, "updated");
  assert.ok(getEl("version-status-text").textContent.includes("1.8.0"));
  assert.equal(getEl("dashboard-version").textContent, "v1.8.0");

  // Manual check error -> Retry button sends { mode: "manual", fresh: true }
  versionMode = "error";
  await sandbox.__uiTest.checkForUpdates(true);
  assert.equal(getEl("version-update-banner").dataset.state, "check-error");
  await sandbox.__uiTest.handleVersionUpdateClick();
  const lastVerCall = [...apiCalls].reverse().find((c) => c.urlPath === "/api/version");
  assert.deepEqual(lastVerCall?.body, { mode: "manual", fresh: true });

  // Package graph remains 100% clean
  const pkgReport = verifyPackageManifest(ROOT);
  assert.equal(pkgReport.ok, true, JSON.stringify(pkgReport));
});

test("v1.7.6-6: case-insensitive FS case-only filename rename preserves newly installed file instead of pruning it", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-case-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const installedRoot = path.join(pluginsDir, "agy-dart");
    const sidecarDir = setupMockPluginInstall(installedRoot, "1.7.2");
    // Simulate an existing file whose casing differs from the incoming release manifest
    fs.mkdirSync(path.join(installedRoot, "context", "lib"), { recursive: true });
    fs.writeFileSync(path.join(installedRoot, "context", "lib", "MixedCase.js"), "// old uppercase\n");

    const tgz = buildTarGz(
      createReleaseArchiveEntries("1.8.0", {
        extraRuntimeFiles: {
          "context/lib/mixedcase.js": "// new lowercase v1.8.0\n"
        }
      })
    );

    const updater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      caseInsensitiveFs: true,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "1.7.2",
        latestVersion: "1.8.0",
        releaseTag: "v1.8.0",
        releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
      }),
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz) }
    });

    const res = await updater("1.8.0");
    assert.equal(res.status, "updated");
    const livePath = path.join(installedRoot, "context", "lib", "mixedcase.js");
    assert.equal(fs.existsSync(livePath), true, "renamed file must remain present on case-insensitive FS");
    assert.equal(fs.readFileSync(livePath, "utf8"), "// new lowercase v1.8.0\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.6-7: AGY_DART_DISABLE_AUTO_UPDATE_CHECK & config.json autoUpdateCheck=false gate /api/version auto mode", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const prevDisable = process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK;
  try {
    assert.equal(CONFIG_DEFAULTS.autoUpdateCheck, true);
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    delete process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK;
    resetConfigCache();
    assert.equal(getEffectiveConfig().autoUpdateCheck, true);

    // 1. config.json autoUpdateCheck: false blocks mode="auto" in handleVersionCheck without calling checker
    fs.writeFileSync(cfgPath, JSON.stringify({ autoUpdateCheck: false }), "utf8");
    resetConfigCache();
    assert.equal(getEffectiveConfig().autoUpdateCheck, false);

    let checkerCalls = 0;
    const mockChecker = async (mode) => {
      checkerCalls += 1;
      return { ok: true, status: "current", mode, currentVersion: "1.7.5" };
    };
    const autoBlocked = await handleVersionCheck({ mode: "auto" }, mockChecker);
    assert.equal(autoBlocked.ok, true);
    assert.equal(autoBlocked.status, "idle");
    assert.equal(autoBlocked.disabled, true);
    assert.equal(checkerCalls, 0, "auto check must not invoke remote checker when disabled in config.json");

    // Manual checks remain allowed when auto check is disabled
    const manualAllowed = await handleVersionCheck({ mode: "manual" }, mockChecker);
    assert.equal(manualAllowed.status, "current");
    assert.equal(checkerCalls, 1);

    // 2. Env AGY_DART_DISABLE_AUTO_UPDATE_CHECK=1 overrides config.json autoUpdateCheck: true
    fs.writeFileSync(cfgPath, JSON.stringify({ autoUpdateCheck: true }), "utf8");
    process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK = "1";
    resetConfigCache();
    assert.equal(getEffectiveConfig().autoUpdateCheck, false);
    const envBlocked = await handleVersionCheck({ mode: "auto" }, mockChecker);
    assert.equal(envBlocked.status, "idle");
    assert.equal(envBlocked.disabled, true);
    assert.equal(checkerCalls, 1);
  } finally {
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    if (prevDisable === undefined) delete process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK;
    else process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK = prevDisable;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.6-8: release .tgz asset selection, release-assets.githubusercontent.com redirect & SHA-256 verification", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-sha-"));
  try {
    const tgz180 = buildTarGz(createReleaseArchiveEntries("1.8.0", { rootPrefix: "package" }));
    const validSha = sha256Hex(tgz180);
    const assetUrl = "https://github.com/zou172866/Antigravity-agy-dart/releases/download/v1.8.0/agy-dart-1.8.0.tgz";

    // 1. selectReleasePackageAsset accepts matching repo asset with sha256 digest and rejects foreign/digestless assets
    assert.deepEqual(
      selectReleasePackageAsset(
        [
          { name: "agy-dart-1.8.0.tgz", browser_download_url: "https://evil.example.com/a.tgz", digest: `sha256:${validSha}` },
          { name: "agy-dart-1.8.0.tgz", browser_download_url: assetUrl, digest: "md5:1234" },
          { name: "agy-dart-1.8.0.tgz", browser_download_url: assetUrl, digest: `sha256:${validSha.toUpperCase()}` }
        ],
        "1.8.0"
      ),
      { assetName: "agy-dart-1.8.0.tgz", assetUrl, assetSha256: validSha }
    );

    // 2. verifyArchiveSha256 passes on match and rejects mismatch with UpdateError("integrity")
    verifyArchiveSha256(tgz180, validSha);
    assert.throws(
      () => verifyArchiveSha256(tgz180, "0".repeat(64)),
      (err) => err instanceof UpdateError && err.reason === "integrity"
    );

    // 3. Version checker surfaces assetUrl & assetSha256; updater downloads via release-assets.githubusercontent.com
    const checker = createVersionChecker({
      getCurrentVersion: () => "1.7.5",
      fetchImpl: async () =>
        makeMockJsonRes(200, {
          tag_name: "v1.8.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "agy-dart-1.8.0.tgz", browser_download_url: assetUrl, digest: `sha256:${validSha}` }]
        })
    });
    const checkRes = await checker("manual");
    assert.equal(checkRes.assetUrl, assetUrl);
    assert.equal(checkRes.assetSha256, validSha);

    const pluginsDir = path.join(tmpDir, "plugins");
    const installedRoot = path.join(pluginsDir, "agy-dart");
    const sidecarDir = setupMockPluginInstall(installedRoot, "1.7.5");

    // 4. Tampered download fails with reason="integrity" BEFORE touching live files
    const tamperedBuf = Buffer.concat([tgz180, Buffer.from("tampered")]);
    const tamperedUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      checkVersion: checker,
      downloadOptions: {
        fetchImpl: async (url) => {
          if (url === assetUrl) {
            return makeMockStreamRes(
              302,
              Buffer.alloc(0),
              { location: "https://release-assets.githubusercontent.com/github-production-release-asset/1/2" },
              url
            );
          }
          return makeMockStreamRes(200, tamperedBuf, {}, url);
        }
      }
    });
    const badRes = await tamperedUpdater("1.8.0");
    assert.equal(badRes.status, "error");
    assert.equal(badRes.reason, "integrity");
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedRoot, "plugin.json"), "utf8")).version, "1.7.5");

    // 5. Authentic download via release-assets.githubusercontent.com succeeds and reports verifiedSha256
    const visitedUrls = [];
    const okUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      checkVersion: checker,
      downloadOptions: {
        fetchImpl: async (url) => {
          visitedUrls.push(url);
          if (url === assetUrl) {
            return makeMockStreamRes(
              302,
              Buffer.alloc(0),
              { location: "https://release-assets.githubusercontent.com/github-production-release-asset/1/2" },
              url
            );
          }
          return makeMockStreamRes(200, tgz180, {}, url);
        }
      }
    });
    const okRes = await okUpdater("1.8.0");
    assert.equal(okRes.status, "updated");
    assert.equal(okRes.verifiedSha256, validSha);
    assert.equal(visitedUrls[0], assetUrl);
    assert.ok(visitedUrls[1].startsWith("https://release-assets.githubusercontent.com/"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.6-9: stale update lock recovery, Windows EPERM mapping, intermediate symlink guard & dotfiles .git isolation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-lock-"));
  try {
    // 1. Standard plugins/agy-dart slot is NOT falsely blocked by an ancestor .git (e.g. $HOME/.git dotfiles repo)
    const fakeHome = path.join(tmpDir, "fake-home");
    fs.mkdirSync(path.join(fakeHome, ".git"), { recursive: true });
    const installedRoot = path.join(fakeHome, ".gemini", "config", "plugins", "agy-dart");
    const sidecarDir = setupMockPluginInstall(installedRoot, "1.7.5");
    const resolved = await resolveInstalledRoot(sidecarDir);
    assert.equal(path.basename(resolved), "agy-dart");

    // Non-standard monorepo subdir with ancestor .git IS still blocked
    const monorepoSub = path.join(tmpDir, "mono", "packages", "agy-dart");
    fs.mkdirSync(path.join(tmpDir, "mono", ".git"), { recursive: true });
    const monoSidecar = setupMockPluginInstall(monorepoSub, "1.7.5");
    await assert.rejects(
      resolveInstalledRoot(monoSidecar, { allowCustomRoot: true }),
      (err) => err instanceof UpdateError && err.reason === "gitCheckout"
    );

    const tgz180 = buildTarGz(createReleaseArchiveEntries("1.8.0"));
    const checkVersion = async () => ({
      ok: true,
      status: "update",
      currentVersion: "1.7.5",
      latestVersion: "1.8.0",
      releaseTag: "v1.8.0",
      releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
    });
    const markerPath = path.join(installedRoot, UPDATE_MARKER_NAME);

    // 2. Dead-PID orphan marker is reported inactive by hasActiveUpdateMarker and auto-reclaimed on update
    fs.writeFileSync(markerPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1000, phase: "replacing" }));
    assert.equal(hasActiveUpdateMarker(markerPath, { isPidAlive: () => false }), false);
    assert.equal(hasActiveUpdateMarker(markerPath, { isPidAlive: () => true }), true);

    // Recovery marker is NEVER auto-reclaimed (blocks with reason="recovery")
    fs.writeFileSync(markerPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1000, phase: "recovery" }));
    assert.equal(hasActiveUpdateMarker(markerPath, { isPidAlive: () => false }), true);
    const recoveryUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      markerOptions: { isPidAlive: () => false },
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) }
    });
    const recRes = await recoveryUpdater("1.8.0");
    assert.equal(recRes.status, "error");
    assert.equal(recRes.reason, "recovery");

    // Replace marker with dead-PID orphan and verify EPERM maps to "locked"
    fs.writeFileSync(markerPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1000, phase: "replacing" }));
    let epermMoves = 0;
    const epermUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      markerOptions: { isPidAlive: () => false },
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) },
      move: async (from, to) => {
        epermMoves += 1;
        if (epermMoves === 3) {
          const err = new Error("operation not permitted");
          err.code = "EPERM";
          throw err;
        }
        return fs.promises.rename(from, to);
      }
    });
    const epermRes = await epermUpdater("1.8.0");
    assert.equal(epermRes.status, "error");
    assert.equal(epermRes.reason, "locked", "Windows EPERM must map to 'locked'");
    assert.equal(epermRes.diagnostics?.restored, true);
    assert.equal(fs.existsSync(markerPath), false);

    // 3. Intermediate directory symlink/junction inside plugin root is rejected with pathConflict
    const outsideDir = path.join(tmpDir, "outside-escape");
    fs.mkdirSync(outsideDir, { recursive: true });
    const symlinkContextDir = path.join(installedRoot, "context");
    fs.symlinkSync(outsideDir, symlinkContextDir, process.platform === "win32" ? "junction" : "dir");
    const symUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) }
    });
    const symRes = await symUpdater("1.8.0");
    assert.equal(symRes.status, "error");
    assert.equal(symRes.reason, "pathConflict");
    assert.equal(fs.readdirSync(outsideDir).length, 0, "must never write files through symlinked subdir");
    fs.rmSync(symlinkContextDir, { recursive: true, force: true });

    // 4. After removing symlink and leaving dead-PID marker, full update reclaims orphan lock and succeeds
    fs.writeFileSync(markerPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1000, phase: "replacing" }));
    const okUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      syncedHostsDir: path.join(tmpDir, "synced-hosts"),
      markerOptions: { isPidAlive: () => false },
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) }
    });
    const okRes = await okUpdater("1.8.0");
    assert.equal(okRes.status, "updated");
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.6-10: preserves --with-devtools, syncs owned secondary hosts & validates multiline static imports across repo", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v176-sync-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const primaryRoot = path.join(pluginsDir, "agy-dart");
    const primarySidecar = setupMockPluginInstall(primaryRoot, "1.7.5");

    // Mark primary install as --with-devtools by placing a devtools sentinel
    fs.mkdirSync(path.join(primaryRoot, "fast"), { recursive: true });
    fs.writeFileSync(path.join(primaryRoot, "fast", "benchmark.mjs"), "// old benchmark\n");

    // Create an owned secondary host + an unowned secondary host
    const ownedSecondary = path.join(tmpDir, "secondary-owned", "agy-dart");
    const ownedSecSidecar = setupMockPluginInstall(ownedSecondary, "1.7.5");
    fs.writeFileSync(path.join(ownedSecondary, "legacy-synced.js"), "// stale synced file\n");
    // Customize Windows node.exe launcher on secondary host to verify preservation
    const customSecSidecar = JSON.parse(fs.readFileSync(path.join(ownedSecSidecar, "sidecar.json"), "utf8"));
    customSecSidecar.command = "C:\\Program Files\\nodejs\\node.exe";
    fs.writeFileSync(path.join(ownedSecSidecar, "sidecar.json"), JSON.stringify(customSecSidecar, null, 2));

    const normPrimary = process.platform === "win32" ? fs.realpathSync(primaryRoot).toLowerCase() : fs.realpathSync(primaryRoot);
    const canonOwned = fs.realpathSync(ownedSecondary);
    fs.writeFileSync(
      path.join(ownedSecondary, ".agy-dart-sync.json"),
      JSON.stringify({ primary: normPrimary, target: canonOwned, files: ["plugin.json", "legacy-synced.js"] })
    );

    const unownedSecondary = path.join(tmpDir, "secondary-unowned", "agy-dart");
    setupMockPluginInstall(unownedSecondary, "1.7.5");

    const syncedHostsDir = path.join(tmpDir, "synced-hosts");
    fs.mkdirSync(syncedHostsDir, { recursive: true });
    fs.writeFileSync(
      path.join(syncedHostsDir, "owned.json"),
      JSON.stringify({ primary: normPrimary, target: canonOwned })
    );
    fs.writeFileSync(
      path.join(syncedHostsDir, "unowned.json"),
      JSON.stringify({ primary: normPrimary, target: fs.realpathSync(unownedSecondary) })
    );

    const tgz180 = buildTarGz(createReleaseArchiveEntries("1.8.0", { includeDevtools: true }));
    const updater = createPluginUpdater({
      sidecarDirectory: primarySidecar,
      pluginsDirectory: pluginsDir,
      syncedHostsDir,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "1.7.5",
        latestVersion: "1.8.0",
        releaseTag: "v1.8.0",
        releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
      }),
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) }
    });

    const res = await updater("1.8.0");
    assert.equal(res.status, "updated");
    assert.equal(res.syncedSecondaryHosts, 1);

    // Primary preserved & updated --with-devtools files
    assert.equal(fs.existsSync(path.join(primaryRoot, "fast", "benchmark.mjs")), true);
    assert.ok(fs.readFileSync(path.join(primaryRoot, "fast", "benchmark.mjs"), "utf8").includes("v1.8.0"));
    assert.equal(fs.existsSync(path.join(primaryRoot, "bin", "agy-dart.mjs")), true);

    // Owned secondary host synced to 1.8.0, pruned stale synced file, preserved Windows node.exe launcher
    assert.equal(JSON.parse(fs.readFileSync(path.join(ownedSecondary, "plugin.json"), "utf8")).version, "1.8.0");
    assert.equal(fs.existsSync(path.join(ownedSecondary, "legacy-synced.js")), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ownedSecSidecar, "sidecar.json"), "utf8")).command,
      "C:\\Program Files\\nodejs\\node.exe"
    );

    // Unowned secondary host (no .agy-dart-sync.json) untouched
    assert.equal(JSON.parse(fs.readFileSync(path.join(unownedSecondary, "plugin.json"), "utf8")).version, "1.7.5");

    // Multiline static import extractor catches server.mjs's multiline imports cleanly without false positives
    const serverSrc = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/server.mjs"), "utf8");
    const serverImports = extractStaticRelativeImports(serverSrc);
    assert.ok(serverImports.includes("../../context/lib/watchdog.js"));
    assert.ok(serverImports.includes("../../context/lib/cache-analyzer.js"));
    assert.ok(serverImports.includes("./version-check.mjs"));
    assert.ok(serverImports.includes("./version-update.mjs"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.7-auto-install: opt-in default-OFF silent auto-update guardrails, SQLite/env precedence, keepalive deferral, /api/auto-update CSRF & UI", async () => {
  const { ContextModeStore } = await import("../context/lib/store.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v177-autoinst-"));
  const dbPath = path.join(tmpDir, "ctx.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const prevAutoInst = process.env.AGY_DART_AUTO_UPDATE_INSTALL;
  const prevDisInst = process.env.AGY_DART_DISABLE_AUTO_UPDATE_INSTALL;
  const prevDisChk = process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK;

  try {
    assert.equal(CONFIG_DEFAULTS.autoUpdateInstall, false);
    const validSha = "d".repeat(64);
    const baseRelease = {
      ok: true,
      status: "update",
      currentVersion: "1.7.6",
      latestVersion: "1.7.7",
      releaseTag: "v1.7.7",
      releaseUrl: `${RELEASES_URL}/tag/v1.7.7`,
      assetName: "agy-dart-1.7.7.tgz",
      assetUrl: "https://github.com/zou172866/Antigravity-agy-dart/releases/download/v1.7.7/agy-dart-1.7.7.tgz",
      assetSha256: validSha
    };

    // 1. 4-guardrail eligibility checks
    assert.deepEqual(
      evaluateAutoInstallEligibility({ release: baseRelease, currentVersion: "1.7.6" }),
      { eligible: true, skipReason: null, targetVersion: "1.7.7" }
    );
    assert.equal(
      evaluateAutoInstallEligibility({
        release: { ...baseRelease, latestVersion: "2.0.0", releaseTag: "v2.0.0" },
        currentVersion: "1.7.6"
      }).skipReason,
      "majorUpgrade"
    );
    assert.equal(
      evaluateAutoInstallEligibility({
        release: { ...baseRelease, assetUrl: "", assetSha256: "" },
        currentVersion: "1.7.6"
      }).skipReason,
      "noVerifiedAsset"
    );
    assert.equal(
      evaluateAutoInstallEligibility({
        release: baseRelease,
        currentVersion: "1.7.6",
        failedVersion: "1.7.7"
      }).skipReason,
      "failedCircuitOpen"
    );

    // 2. Store precedence (env > sqlite > config > default) + runAutoUpdateCycle guardrails
    process.env.AGY_DART_DB_PATH = dbPath;
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    delete process.env.AGY_DART_AUTO_UPDATE_INSTALL;
    delete process.env.AGY_DART_DISABLE_AUTO_UPDATE_INSTALL;
    delete process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK;
    resetConfigCache();
    closeRuntimeStore();

    const store = new ContextModeStore(dbPath);
    try {
      assert.deepEqual(store.getAutoUpdateInstallInfo({}), { enabled: false, source: "default" });
      store.setAutoUpdateInstallEnabled(true);
      assert.deepEqual(store.getAutoUpdateInstallInfo({}), { enabled: true, source: "sqlite" });
      assert.deepEqual(
        store.getAutoUpdateInstallInfo({ AGY_DART_DISABLE_AUTO_UPDATE_INSTALL: "1" }),
        { enabled: false, source: "env" }
      );
      assert.deepEqual(
        store.getAutoUpdateInstallInfo({ AGY_DART_DISABLE_AUTO_UPDATE_CHECK: "1" }),
        { enabled: false, source: "env" }
      );

      // Keepalive in-flight defers automatic install cleanly
      let updateCalls = 0;
      const deferred = await runAutoUpdateCycle({
        store,
        checker: async () => baseRelease,
        updater: async () => {
          updateCalls += 1;
          return { ok: true, status: "updated", previousVersion: "1.7.6", version: "1.7.7", releaseUrl: baseRelease.releaseUrl };
        },
        monitor: { _keepaliveInFlight: new Set(["conv-busy"]) },
        currentVersion: "1.7.6"
      });
      assert.equal(deferred.action, "deferred");
      assert.equal(deferred.reason, "keepaliveInFlight");
      assert.equal(updateCalls, 0);

      // Failure trips per-version circuit breaker; second cycle skips 1.7.7
      const failed = await runAutoUpdateCycle({
        store,
        checker: async () => baseRelease,
        updater: async () => {
          updateCalls += 1;
          return { ok: false, status: "error", reason: "locked", diagnostics: { step: "replace", restored: true } };
        },
        monitor: { _keepaliveInFlight: new Set() },
        currentVersion: "1.7.6",
        nowIso: "2026-11-26T16:10:00.000Z"
      });
      assert.equal(failed.action, "failed");
      assert.equal(store.getAutoUpdateRuntimeState().failedVersion, "1.7.7");

      const circuitSkip = await runAutoUpdateCycle({
        store,
        checker: async () => baseRelease,
        updater: async () => {
          updateCalls += 1;
          return { ok: true, status: "updated", version: "1.7.7" };
        },
        monitor: { _keepaliveInFlight: new Set() },
        currentVersion: "1.7.6"
      });
      assert.equal(circuitSkip.action, "checked");
      assert.equal(circuitSkip.autoInstallSkipped, "failedCircuitOpen");
      assert.equal(updateCalls, 1);

      // Manual update success clears circuit breaker; next auto-update succeeds and persists notice
      const manualOk = await handlePluginUpdate(
        { version: "1.7.7" },
        async (v) => ({ ok: true, status: "updated", previousVersion: "1.7.6", version: v, releaseUrl: baseRelease.releaseUrl }),
        null,
        { store }
      );
      assert.equal(manualOk.status, "updated");
      assert.equal(store.getAutoUpdateRuntimeState().failedVersion, "");

      let restarted = false;
      const localVer = readLocalVersion(ROOT);
      const autoOk = await runAutoUpdateCycle({
        store,
        checker: async () => ({
          ...baseRelease,
          latestVersion: localVer,
          releaseTag: `v${localVer}`
        }),
        updater: async (v) => ({
          ok: true,
          status: "updated",
          previousVersion: "1.7.5",
          version: v,
          releaseUrl: `${RELEASES_URL}/tag/v${v}`
        }),
        monitor: { _keepaliveInFlight: new Set() },
        currentVersion: "1.7.5",
        nowIso: "2026-11-26T16:12:00.000Z",
        onUpdated: () => {
          restarted = true;
        }
      });
      assert.equal(autoOk.action, "updated");
      assert.equal(restarted, true);
      assert.equal(store.getAutoUpdateRuntimeState().lastAutoUpdatedVersion, localVer);

      // handleAutoUpdateMutation validates inputs and clears notice
      assert.equal(handleAutoUpdateMutation({}, { store }).status, 400);
      assert.equal(handleAutoUpdateMutation({ enabled: "yes" }, { store }).status, 400);
      assert.equal(handleAutoUpdateMutation({ enabled: true, extra: 1 }, { store }).status, 400);
      const dismissed = handleAutoUpdateMutation({ dismissNotice: true }, { store });
      assert.equal(dismissed.ok, true);
      assert.equal(dismissed.autoUpdateNotice, null);
    } finally {
      store.close();
    }

    // 3. Standalone HTTP /api/auto-update enforces POST + CSRF + triggers callback on enable
    closeRuntimeStore();
    const csrf = "dart-auto-upd-csrf-0123456789";
    let triggered = false;
    const srv = createStandaloneServer({
      csrfToken: csrf,
      onAutoInstallEnabled: () => {
        triggered = true;
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    try {
      const req = (method, headers, body = null) =>
        new Promise((resolve, reject) => {
          const r = http.request(
            { hostname: "127.0.0.1", port, path: AUTO_UPDATE_ROUTE, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
            (res) => {
              let raw = "";
              res.on("data", (d) => (raw += d));
              res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw || "{}") }));
            }
          );
          r.on("error", reject);
          if (body !== null) r.write(body);
          r.end();
        });
      assert.equal((await req("GET", { "X-Agy-Dart-Token": csrf })).status, 405);
      assert.equal((await req("POST", { "Content-Type": "application/json" }, JSON.stringify({ enabled: true }))).status, 403);
      const okOn = await req(
        "POST",
        { "Content-Type": "application/json", "X-Agy-Dart-Token": csrf },
        JSON.stringify({ enabled: true })
      );
      assert.equal(okOn.status, 200);
      assert.equal(okOn.json.autoUpdateInstall.enabled, true);
      assert.equal(triggered, true);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      closeRuntimeStore();
    }

    // 4. Dashboard index.html exposes #auto-update-install-btn and auto-updated notice i18n
    const html = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/index.html"), "utf8");
    assert.ok(html.includes('id="auto-update-install-btn"'));
    assert.ok(html.includes("toggleAutoUpdateInstall()"));
    assert.ok(html.includes("versionAutoUpdatedTitleFrom"));
    assert.ok(html.includes("/api/auto-update"));
  } finally {
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    if (prevAutoInst === undefined) delete process.env.AGY_DART_AUTO_UPDATE_INSTALL;
    else process.env.AGY_DART_AUTO_UPDATE_INSTALL = prevAutoInst;
    if (prevDisInst === undefined) delete process.env.AGY_DART_DISABLE_AUTO_UPDATE_INSTALL;
    else process.env.AGY_DART_DISABLE_AUTO_UPDATE_INSTALL = prevDisInst;
    if (prevDisChk === undefined) delete process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK;
    else process.env.AGY_DART_DISABLE_AUTO_UPDATE_CHECK = prevDisChk;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
