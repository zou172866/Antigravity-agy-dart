import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  formatEffectiveConfigLines,
  getConfigSnapshot,
  getEffectiveConfig,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { inferWorkspaceFromStore } from "../context/lib/handoff.js";
import { createTools } from "../context/lib/tools.js";
import {
  isAllowedHostHeader,
  isAllowedOriginHeader,
  isCrossSiteFetchHeader,
  isJsonContentType,
  resolveAllowedHandoffCwd,
  resolveStandalonePort,
  shouldUseSidecarApp,
  timingSafeTokenMatch
} from "../sidecars/dashboard/server.mjs";
import { findTranscriptForConversation, isSafeConversationId } from "../context/lib/cache-analyzer.js";
import { applyFilterRule } from "../hooks/filter-rules.mjs";
import {
  auditPrefixBudget,
  calibrateFromTranscript,
  calibrateTokenEstimator,
  estimateTokens,
  extractTranscriptCalibrationReport
} from "../scripts/prefix-budget.mjs";
import { computeBriefMetrics, countTestCasesInSource, syncBriefFile } from "../scripts/gen-review-brief.mjs";
import {
  extractLocalSpecifiers,
  tokenizeJsForSpecifiers,
  verifyPackageManifest
} from "../scripts/verify-package-graph.mjs";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHookRaw(scriptRel, payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, scriptRel);
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      ...extraEnv
    }
  });
}

function makeNumberedLines(count) {
  return Array.from({ length: count }, (_, i) => `export const item_${i + 1} = "payload_${String(i + 1).padStart(4, "0")}_xxxxxxxxxxxxxxxxxxxx";`);
}

function writeAndBumpMtime(filePath, content, bumpSec = 5) {
  fs.writeFileSync(filePath, content, "utf8");
  const t = Math.floor(Date.now() / 1000) + bumpSec;
  fs.utimesSync(filePath, t, t);
}

test("P0-Hardening 1: Sidecar CSRF, DNS-rebinding Host/Origin guards, POST-only mutations, 64KB body cap & XSS escaping", async () => {
  // Unit checks for security helpers
  assert.equal(isAllowedHostHeader("127.0.0.1:8765"), true);
  assert.equal(isAllowedHostHeader("localhost:8765"), true);
  assert.equal(isAllowedHostHeader("[::1]:8765"), true);
  assert.equal(isAllowedHostHeader("evil.rebinding.test:8765"), false);
  assert.equal(isAllowedHostHeader("127.0.0.1.evil.com"), false);
  assert.equal(isAllowedHostHeader(""), false);

  assert.equal(isAllowedOriginHeader(undefined), true);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:8765"), true);
  assert.equal(isAllowedOriginHeader("http://localhost:8765"), true);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:8765", "127.0.0.1:8765"), true);
  assert.equal(isAllowedOriginHeader("http://localhost:8765", "127.0.0.1:8765"), false);
  assert.equal(isAllowedOriginHeader("https://127.0.0.1:8765", "127.0.0.1:8765"), false);
  assert.equal(isAllowedOriginHeader("http://localhost:3000", "127.0.0.1:8765"), false);
  assert.equal(isAllowedOriginHeader("https://evil.example"), false);
  assert.equal(isAllowedOriginHeader("null"), false);

  assert.equal(isCrossSiteFetchHeader("cross-site"), true);
  assert.equal(isCrossSiteFetchHeader("same-site"), true);
  assert.equal(isCrossSiteFetchHeader("same-site", { allowSameSite: true }), false);
  assert.equal(isCrossSiteFetchHeader("same-origin, cross-site"), true);
  assert.equal(isCrossSiteFetchHeader("unknown-fetch-site"), true);
  assert.equal(isCrossSiteFetchHeader("same-origin"), false);
  assert.equal(isCrossSiteFetchHeader("none"), false);
  assert.equal(isCrossSiteFetchHeader(undefined), false);

  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
  assert.equal(isJsonContentType("text/plain"), false);
  assert.equal(isJsonContentType("application/x-www-form-urlencoded"), false);

  assert.equal(timingSafeTokenMatch("abc123", "abc123"), true);
  assert.equal(timingSafeTokenMatch("abc123", "abc124"), false);
  assert.equal(timingSafeTokenMatch("short", "longer"), false);
  assert.equal(timingSafeTokenMatch("", ""), false);

  // Static audit: SidecarApp mode MUST NOT register GET on ANY /api/* route (sidecar_sdk only checks X-Sidecar-Token on non-GET)
  const serverSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "server.mjs"), "utf8");
  assert.equal(
    /app\.api\([^)]*,\s*["']GET["']\)/.test(serverSrc),
    false,
    "SidecarApp must NOT register GET on ANY /api/* route"
  );
  for (const route of [
    "/api/stats",
    "/api/doctor",
    "/api/resume",
    "/api/source-chunks",
    "/api/cache-diag",
    "/api/handoff",
    "/api/search",
    "/api/cutoff",
    "/api/exemptions",
    "/api/toggle-active",
    "/api/paused",
    "/api/purge",
    "/api/maintenance",
    "/api/cli-filter",
    "/api/read-dedup"
  ]) {
    const badRe = new RegExp(`app\\.api\\(["']${route.replace("/", "\\/")}["'][\\s\\S]{0,120},\\s*["']GET["']\\)`);
    assert.equal(badRe.test(serverSrc), false, `SidecarApp must NOT register GET for route ${route}`);
  }

  // P1-5: Importing pure helpers from sidecars/dashboard/server.mjs MUST NOT open SQLite DB or spawn PowerShell
  const lazyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-lazy-srv-"));
  const lazyDb = path.join(lazyTmpDir, "must-not-exist.db");
  try {
    const tImp0 = performance.now();
    const impProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { isAllowedHostHeader, resolveAllowedHandoffCwd } from ${JSON.stringify("file:///" + path.join(ROOT, "sidecars", "dashboard", "server.mjs").replace(/\\/g, "/"))};
process.stdout.write(String(isAllowedHostHeader("127.0.0.1:8765")) + ":" + resolveAllowedHandoffCwd("\\\\\\\\evil\\\\share", []));`
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: lazyDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    const impMs = performance.now() - tImp0;
    assert.equal(impProbe.status, 0, impProbe.stderr);
    assert.equal(impProbe.stderr, "");
    assert.equal(impProbe.stdout, "true:");
    assert.equal(fs.existsSync(lazyDb), false, "Importing helpers from server.mjs must NOT create or open SQLite DB");
    assert.ok(impMs < 1200, `Lazy import of server.mjs should not block on PowerShell (took ${impMs.toFixed(0)}ms)`);
  } finally {
    fs.rmSync(lazyTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // P0-2: resolveAllowedHandoffCwd unit checks (blocks UNC, relative, filesystem roots, symlink/junction escapes, external paths, null bytes)
  const cwdTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-cwd-wl-"));
  const allowedRoot = path.join(cwdTmp, "allowed-repo");
  const allowedSub = path.join(allowedRoot, "packages", "web");
  const outsideRepo = path.join(cwdTmp, "outside-repo");
  fs.mkdirSync(allowedSub, { recursive: true });
  fs.mkdirSync(outsideRepo, { recursive: true });
  const escapeLink = path.join(allowedRoot, "escape-link");
  try {
    fs.symlinkSync(outsideRepo, escapeLink, process.platform === "win32" ? "junction" : "dir");
    const fsRoot = path.parse(allowedRoot).root;
    assert.equal(resolveAllowedHandoffCwd("\\\\evil-smb\\share", [allowedRoot]), "");
    assert.equal(resolveAllowedHandoffCwd("//evil-smb/share", [allowedRoot]), "");
    assert.equal(resolveAllowedHandoffCwd(`${allowedRoot}\0bad`, [allowedRoot]), "");
    assert.equal(resolveAllowedHandoffCwd(outsideRepo, [allowedRoot]), "");
    assert.equal(resolveAllowedHandoffCwd(escapeLink, [allowedRoot]), "", "Symlink/junction escaping allowedRoot must be rejected");
    assert.equal(resolveAllowedHandoffCwd(outsideRepo, [fsRoot]), "", "Filesystem root must never act as a wildcard known worktree");
    assert.equal(resolveAllowedHandoffCwd("packages/web", [allowedRoot]), "", "Relative rawCwd must be rejected");
    assert.equal(resolveAllowedHandoffCwd(process.cwd(), ["."]), "", "Relative knownRoot must be ignored");
    assert.equal(resolveAllowedHandoffCwd(allowedRoot, [allowedRoot]), fs.realpathSync(allowedRoot));
    assert.equal(resolveAllowedHandoffCwd(allowedSub, [allowedRoot]), fs.realpathSync(allowedSub));
  } finally {
    fs.rmSync(cwdTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // Static audit: index.html escapes custom extensions and sends POST + CSRF token on ALL /api/* calls
  const htmlSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  assert.ok(htmlSrc.includes('meta[name="agy-dart-token"]'), "index.html must read CSRF meta token");
  assert.ok(htmlSrc.includes("X-Agy-Dart-Token"), "index.html must attach X-Agy-Dart-Token header");
  assert.equal(/apiFetch\([^)]*method:\s*['"]GET['"]/.test(htmlSrc), false, "index.html must use POST for all /api/* calls");
  assert.ok(!htmlSrc.includes("removeExemption('${ext}')"), "index.html must not interpolate raw ext into onclick");
  assert.ok(htmlSrc.includes("data-ext=\"${safeExt}\""), "index.html must use escaped data-ext attribute");
  assert.ok(htmlSrc.includes("${escapeHtml(scopeLabel)}"), "index.html must escape scopeLabel in telemetry-source");

  // Live standalone server attack simulation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sidecar-sec-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const port = 29400 + Math.floor(Math.random() * 500);

  const seed = new ContextModeStore({ dbPath: tmpDb });
  seed.indexContent({ sessionId: "sec-s1", worktree: tmpDir, kind: "file", label: "precious.txt", content: "do not wipe via CSRF" });
  seed.close();

  const child = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      AGY_DART_DB_PATH: tmpDb,
      SIDECAR_FORCE_HTTP: "1",
      AGY_DART_DISABLE_COMPILE_CACHE: "1"
    }
  });

  const rawReq = (urlPath, { method = "GET", headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
      if (body !== null && reqHeaders["Content-Length"] === undefined) {
        reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
      }
      const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers: reqHeaders }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      });
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Sidecar startup timeout")), 5000);
      child.stdout.on("data", (d) => {
        if (d.toString("utf8").includes("listening at")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", (c) => {
        clearTimeout(t);
        reject(new Error(`Sidecar exited early: ${c}`));
      });
    });

    const page = await rawReq("/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.ok(String(page.headers["content-security-policy"] || "").includes("frame-ancestors 'none'"));
    const token = page.body.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(token && token.length >= 32, "Must inject high-entropy CSRF token");

    // 1. Cross-site <img> GET attacks on all mutating endpoints -> 405 Method Not Allowed
    for (const ep of [
      "/api/purge?scope=all",
      "/api/toggle-active?paused=true",
      "/api/paused?paused=true",
      "/api/cutoff?cutoff=0",
      "/api/exemptions?action=reset",
      "/api/maintenance?action=vacuum",
      "/api/cli-filter?enabled=false",
      "/api/read-dedup?enabled=false"
    ]) {
      const r = await rawReq(ep, { method: "GET" });
      assert.equal(r.status, 405, `GET ${ep} must return 405, got ${r.status}`);
      assert.equal(r.headers.allow, "POST");
    }

    // 2. DNS rebinding Host header -> 403
    const rebind = await rawReq("/api/stats", { headers: { Host: `evil.attacker.test:${port}` } });
    assert.equal(rebind.status, 403);

    // 3. Cross-origin / null Origin / cross-host / cross-scheme / cross-port Origin / Sec-Fetch-Site: cross-site & same-site -> 403
    assert.equal((await rawReq("/api/stats", { headers: { Origin: "https://evil.example", "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { Origin: "http://localhost:3000", "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { Origin: `http://localhost:${port}`, "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { Origin: `https://127.0.0.1:${port}`, "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { Origin: "null", "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { "Sec-Fetch-Site": "cross-site", "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { "Sec-Fetch-Site": "same-origin, cross-site", "X-Agy-Dart-Token": token } })).status, 403);
    assert.equal(
      (await rawReq("/api/stats", { headers: { "Sec-Fetch-Site": "same-site", "X-Agy-Dart-Token": token } })).status,
      403,
      "Sec-Fetch-Site: same-site (e.g. another local port) must be blocked on GET /api/*"
    );
    assert.equal(
      (
        await rawReq("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site", "X-Agy-Dart-Token": token },
          body: JSON.stringify({ query: "precious" })
        })
      ).status,
      403,
      "Sec-Fetch-Site: same-site must be blocked on POST /api/*"
    );
    assert.equal(
      (await rawReq("/api/stats", { headers: { "Sec-Fetch-Site": "same-origin", "X-Agy-Dart-Token": token } })).status,
      200,
      "Sec-Fetch-Site: same-origin with valid token must succeed"
    );

    // 3b. Every standalone GET /api/* endpoint MUST require valid X-Agy-Dart-Token
    const getApiPaths = [
      "/api/stats?scope=lifetime",
      "/api/doctor",
      "/api/resume?scope=lifetime",
      "/api/source-chunks?sourceId=nonexistent",
      "/api/cache-diag?scope=lifetime",
      "/api/handoff?scope=lifetime"
    ];
    for (const ep of getApiPaths) {
      assert.equal((await rawReq(ep)).status, 403, `GET ${ep} without token must return 403`);
      assert.equal(
        (await rawReq(ep, { headers: { "X-Agy-Dart-Token": "0".repeat(token.length) } })).status,
        403,
        `GET ${ep} with wrong token must return 403`
      );
      assert.equal(
        (await rawReq(ep, { headers: { "X-Agy-Dart-Token": token } })).status,
        200,
        `GET ${ep} with valid token must return 200`
      );
    }

    // 3c. Every standalone read endpoint also supports authenticated JSON POST (used by index.html) and blocks arbitrary handoff cwd
    for (const [ep, payload] of [
      ["/api/stats", { scope: "lifetime" }],
      ["/api/doctor", {}],
      ["/api/resume", { scope: "lifetime" }],
      ["/api/source-chunks", { sourceId: "nonexistent" }],
      ["/api/cache-diag", { scope: "lifetime" }],
      ["/api/handoff", { scope: "lifetime" }]
    ]) {
      assert.equal(
        (await rawReq(ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status,
        403,
        `POST ${ep} without token must return 403`
      );
      assert.equal(
        (await rawReq(ep, { method: "POST", headers: { "Content-Type": "text/plain", "X-Agy-Dart-Token": token }, body: JSON.stringify(payload) })).status,
        415,
        `POST ${ep} with non-JSON Content-Type must return 415`
      );
      assert.equal(
        (await rawReq(ep, { method: "POST", headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token }, body: JSON.stringify(payload) })).status,
        200,
        `POST ${ep} with valid token + JSON must return 200`
      );
    }

    // Handoff must NOT run git on an attacker-supplied external git repository outside known SQLite worktrees
    const evilGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-evil-git-"));
    try {
      spawnSync("git", ["init"], { cwd: evilGitDir, windowsHide: true });
      spawnSync("git", ["checkout", "-b", "secret-attacker-branch"], { cwd: evilGitDir, windowsHide: true });
      fs.writeFileSync(path.join(evilGitDir, "secret-token-file.txt"), "top-secret\n", "utf8");
      const evilHandoff = await rawReq("/api/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
        body: JSON.stringify({ scope: "conversation", conversationId: "sec-s1", cwd: evilGitDir })
      });
      assert.equal(evilHandoff.status, 200);
      const evilMd = JSON.parse(evilHandoff.body).markdown || "";
      assert.equal(evilMd.includes("secret-attacker-branch"), false, "Handoff must NOT run git on unwhitelisted cwd");
      assert.equal(evilMd.includes("secret-token-file.txt"), false, "Handoff must NOT leak files from unwhitelisted cwd");
    } finally {
      fs.rmSync(evilGitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    // 4. POST /api/search and mutating endpoints without token or wrong token -> 403
    const searchNoTok = await rawReq("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "precious" })
    });
    assert.equal(searchNoTok.status, 403, "POST /api/search must require X-Agy-Dart-Token");

    const searchWithTok = await rawReq("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ query: "precious" })
    });
    assert.equal(searchWithTok.status, 200);

    const noTok = await rawReq("/api/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(noTok.status, 403);

    const badTok = await rawReq("/api/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": "0".repeat(token.length) },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(badTok.status, 403);

    // 5. Simple CORS text/plain POST even with valid token -> 415 Unsupported Media Type
    const wrongCt = await rawReq("/api/purge", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(wrongCt.status, 415);

    // 6. Oversized > 64 KB body -> 413 Payload Too Large
    const hugeBody = JSON.stringify({ query: "x".repeat(80 * 1024) });
    const tooBig = await rawReq("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: hugeBody
    });
    assert.equal(tooBig.status, 413);

    // Verify none of the blocked attacks wiped our DB!
    const statsBefore = JSON.parse((await rawReq("/api/stats?scope=lifetime", { headers: { "X-Agy-Dart-Token": token } })).body);
    assert.equal(statsBefore.sourcesCount, 1, "Blocked CSRF attacks must NOT mutate database");

    // 7. Legitimate authenticated JSON POST succeeds & XSS custom extension payload is rejected by store sanitizer
    const validToggle = await rawReq("/api/toggle-active", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ scope: "lifetime", paused: true })
    });
    assert.equal(validToggle.status, 200);
    assert.equal(JSON.parse(validToggle.body).isPaused, true);

    const xssExtRes = await rawReq("/api/exemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ action: "add", ext: ".foo'\"><img src=x onerror=alert(1)>" })
    });
    assert.equal(xssExtRes.status, 200);
    assert.deepEqual(JSON.parse(xssExtRes.body).customExtensions, [], "XSS payload must not be stored as custom extension");

    const goodExtRes = await rawReq("/api/exemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ action: "add", ext: ".mdx" })
    });
    assert.equal(goodExtRes.status, 200);
    assert.ok(JSON.parse(goodExtRes.body).customExtensions.includes(".mdx"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // Live SidecarApp mode smoke test when host Antigravity sidecar_sdk is present
  const userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
  if (fs.existsSync(userSdkPath)) {
    const sdkTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sidecar-sdk-"));
    const sdkDb = path.join(sdkTmpDir, "context.db");
    const sdkPort = 29500 + Math.floor(Math.random() * 400);
    const uiToken = "sidecar-test-ui-token-778899";
    const sdkChild = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGY_DART_DB_PATH: sdkDb,
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
        ANTIGRAVITY_CSRF_TOKEN: "dummy-csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(sdkPort),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
        ANTIGRAVITY_CONVERSATION_ID: "sdk-conv-1",
        AGY_DART_DISABLE_COMPILE_CACHE: "1"
      }
    });
    let sdkStderr = "";
    sdkChild.stderr.on("data", (d) => (sdkStderr += d.toString("utf8")));
    const sdkReq = (urlPath, { method = "GET", headers = {}, body = null } = {}) =>
      new Promise((resolve, reject) => {
        const reqHeaders = { Host: `127.0.0.1:${sdkPort}`, ...headers };
        if (body !== null) reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
        const req = http.request({ hostname: "127.0.0.1", port: sdkPort, path: urlPath, method, headers: reqHeaders }, (res) => {
          let out = "";
          res.on("data", (c) => (out += c));
          res.on("end", () => resolve({ status: res.statusCode, body: out }));
        });
        req.on("error", reject);
        if (body !== null) req.write(body);
        req.end();
      });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("SidecarApp startup timeout")), 5000);
        sdkChild.stdout.on("data", (d) => {
          const s = d.toString("utf8");
          if (s.includes("listening on") || s.includes("registered and running")) {
            clearTimeout(t);
            resolve();
          }
        });
        sdkChild.on("exit", (c) => {
          clearTimeout(t);
          reject(new Error(`SidecarApp exited early: ${c} ${sdkStderr}`));
        });
      });
      assert.equal((await sdkReq("/api/purge?scope=all", { method: "GET" })).status, 405);
      // P0-2: ALL SidecarApp read routes MUST reject unauthenticated GET (405) and unauthenticated POST (401)
      for (const readEp of ["/api/stats", "/api/doctor", "/api/resume", "/api/source-chunks", "/api/cache-diag", "/api/handoff"]) {
        assert.equal(
          (await sdkReq(readEp, { method: "GET" })).status,
          405,
          `SidecarApp GET ${readEp} must return 405 Method Not Allowed`
        );
        assert.equal(
          (await sdkReq(readEp, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
          401,
          `SidecarApp POST ${readEp} without X-Sidecar-Token must return 401`
        );
        const okRead = await sdkReq(readEp, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Sidecar-Token": uiToken },
          body: JSON.stringify({ scope: "lifetime", sourceId: "nonexistent" })
        });
        assert.equal(okRead.status, 200, `SidecarApp authenticated POST ${readEp} must return 200`);
      }
      assert.equal(
        (await sdkReq("/api/toggle-active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true }) })).status,
        401,
        "SidecarApp mode must reject POST without X-Sidecar-Token"
      );
      const okPost = await sdkReq("/api/toggle-active", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": uiToken },
        body: JSON.stringify({ paused: true })
      });
      assert.equal(okPost.status, 200);
      assert.equal(JSON.parse(okPost.body).isPaused, true);
      assert.equal(Buffer.byteLength(sdkStderr, "utf8"), 0, `SidecarApp emitted stderr: ${sdkStderr}`);
    } finally {
      sdkChild.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 150));
      fs.rmSync(sdkTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

test("P0-Hardening 2: Diff-read is OFF by default, enforces direct conversation ownership (no subagent leak) & turn/age freshness bounds", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-diff-safe-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const modFile = path.join(tmpDir, "target.js");
  const otherFile = path.join(tmpDir, "other.js");
  const v1 = makeNumberedLines(100);
  const v2 = [...v1];
  v2[20] = 'export const item_21 = "MODIFIED_V2";';

  try {
    writeAndBumpMtime(modFile, v1.join("\n") + "\n", 0);
    writeAndBumpMtime(otherFile, makeNumberedLines(40).join("\n") + "\n", 0);

    // 1. DEFAULT (no AGY_DART_ENABLE_DIFF_READ, no config.json): diff-read MUST be OFF!
    const cleanEnv = {
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      AGY_DART_ENABLE_DIFF_READ: "",
      AGY_DART_DISABLE_DIFF_READ: ""
    };
    const r1 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "def-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(r1.decision, "allow");

    // Unchanged State-2 read-dedup is STILL active by default
    const rUnchanged = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "def-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(rUnchanged.decision, "deny");
    assert.ok(rUnchanged.reason.includes("[agy-dart read-dedup]"));

    // Modify file -> because diffRead defaults OFF, hook MUST return full-file allow!
    writeAndBumpMtime(modFile, v2.join("\n") + "\n", 10);
    const rModDefault = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "def-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(rModDefault.decision, "allow", "Diff-read must be OFF by default and allow full file on modification");

    // 2. Opt-in via config.json (`diffRead: true`): enables diff-read with baseline header & bilingual hint
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true, diffReadMaxTurns: 3 }), "utf8");
    const v3 = [...v2];
    v3[30] = 'export const item_31 = "MODIFIED_V3";';
    // Capture baseline in parent conversation
    const p1 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(p1.decision, "allow");

    writeAndBumpMtime(modFile, v3.join("\n") + "\n", 20);

    // 3. Subagent sharing parentConversationId MUST NOT receive parent's diff!
    const subRead = JSON.parse(
      runHookRaw(
        "hooks/pre-tool-use.mjs",
        {
          parentConversationId: "parent-conv",
          conversationId: "child-worker-1",
          cwd: tmpDir,
          toolCall: { name: "read_file", args: { Path: modFile } }
        },
        tmpDb,
        cleanEnv
      ).stdout
    );
    assert.equal(subRead.decision, "allow", "Subagent with distinct conversationId must NOT receive parent's diff");

    // Subagent without distinct conversationId (marked subagent: true) also MUST NOT receive parent's diff!
    const subSameId = JSON.parse(
      runHookRaw(
        "hooks/pre-tool-use.mjs",
        {
          conversationId: "parent-conv",
          subagent: true,
          cwd: tmpDir,
          toolCall: { name: "read_file", args: { Path: modFile } }
        },
        tmpDb,
        cleanEnv
      ).stdout
    );
    assert.equal(subSameId.decision, "allow", "Subagent sharing parent conversationId must NOT receive diff");

    // Parent itself (same conversation, within 3 turns) DOES receive diff with baseline hash & bilingual hint!
    const pDiff = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pDiff.decision, "deny");
    assert.ok(pDiff.reason.includes("[agy-dart diff-read]"));
    assert.ok(pDiff.reason.includes("changed since baseline "));
    assert.ok(pDiff.reason.includes("如需全文请重读"));

    // 3b. P1-2: Consecutive edit (v3 -> v3b) while bypass_armed === 1 MUST fall through to full-file allow
    //     instead of chaining a second diff claiming v3 was a "prior full copy"
    const v3b = [...v3];
    v3b[35] = 'export const item_36 = "CONSECUTIVE_EDIT_NO_CHAIN";';
    writeAndBumpMtime(modFile, v3b.join("\n") + "\n", 22);
    const pNoChain = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(
      pNoChain.decision,
      "allow",
      "Consecutive edit while snapshot.bypass_armed === 1 must fall through to full-file allow (no chained diff)"
    );

    // 4. P1-3: read_file calls MUST NOT inflate conv_turn_seq; PreInvocation is the sole turn clock
    const turnCheckStore = new ContextModeStore({ dbPath: tmpDb });
    const seqBeforeReads = turnCheckStore.getConversationTurnSeq("parent-conv");
    for (let i = 0; i < 6; i++) {
      writeAndBumpMtime(otherFile, makeNumberedLines(40 + i).join("\n") + "\n", 25 + i);
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: otherFile } } }, tmpDb, cleanEnv);
    }
    assert.equal(
      turnCheckStore.getConversationTurnSeq("parent-conv"),
      seqBeforeReads,
      "read_file hooks must NOT increment conv_turn_seq (PreInvocation is the sole turn clock)"
    );
    turnCheckStore.close();

    // Turn-gap staleness via PreInvocation exceeding diffReadMaxTurns (3) -> must fall back safely to full-file allow!
    for (let i = 0; i < 4; i++) {
      const piTurn = runHookRaw("hooks/pre-invocation.mjs", { conversationId: "parent-conv", cwd: tmpDir }, tmpDb, cleanEnv);
      assert.equal(piTurn.status, 0);
    }
    const v4 = [...v3b];
    v4[50] = 'export const item_51 = "MODIFIED_AFTER_STALE_TURNS";';
    writeAndBumpMtime(modFile, v4.join("\n") + "\n", 40);
    const pStaleTurns = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pStaleTurns.decision, "allow", "Snapshot older than diffReadMaxTurns must fall back to full file allow");

    // 5. Age staleness: backdate full_read_ts beyond diffReadMaxAgeMs -> must fall back to full-file allow!
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    store.db
      .prepare("UPDATE file_snapshots SET full_read_ts = ?, updated_ts = ? WHERE session_id = ?")
      .run(Date.now() - 30 * 60 * 1000, Date.now() - 30 * 60 * 1000, "parent-conv");
    store.close();

    const v5 = [...v4];
    v5[60] = 'export const item_61 = "MODIFIED_AFTER_STALE_AGE";';
    writeAndBumpMtime(modFile, v5.join("\n") + "\n", 50);
    const pStaleAge = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pStaleAge.decision, "allow", "Snapshot older than diffReadMaxAgeMs must fall back to full file allow");

    // 6. Non-read LLM turns via PreInvocation also advance conv_turn_seq and expire diff baselines
    for (let i = 0; i < 4; i++) {
      const pi = runHookRaw("hooks/pre-invocation.mjs", { conversationId: "parent-conv", cwd: tmpDir }, tmpDb, cleanEnv);
      assert.equal(pi.status, 0);
    }
    const v6 = [...v5];
    v6[70] = 'export const item_71 = "MODIFIED_AFTER_PREINV_TURNS";';
    writeAndBumpMtime(modFile, v6.join("\n") + "\n", 60);
    const pStalePreInv = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pStalePreInv.decision, "allow", "PreInvocation turns must advance conv_turn_seq and expire stale diff baselines");

    // 6b. Even when cacheWatch is disabled (env OR config.json), PreInvocation MUST still bump conv_turn_seq while diffRead is enabled
    //     and MUST suppress KV-Cache Watch alerts (even if a critical-watermark transcript is provided).
    const hotTranscript = path.join(tmpDir, "hot_transcript.jsonl");
    fs.writeFileSync(
      hotTranscript,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: new Date().toISOString(),
        model: "claude-sonnet-4",
        input_tokens: 175000,
        cache_read_tokens: 0,
        output_tokens: 100
      }) + "\n",
      "utf8"
    );
    const seqStoreCheck = new ContextModeStore({ dbPath: tmpDb });
    const seqBeforeCwOff = seqStoreCheck.getConversationTurnSeq("parent-conv");
    const cwEnvDisabled = { ...cleanEnv, AGY_DART_DISABLE_CACHE_WATCH: "1" };
    for (let i = 0; i < 2; i++) {
      const piOff = runHookRaw(
        "hooks/pre-invocation.mjs",
        { conversationId: "parent-conv", cwd: tmpDir, transcriptPath: hotTranscript },
        tmpDb,
        cwEnvDisabled
      );
      assert.equal(piOff.status, 0);
      assert.equal(piOff.stderr, "");
      assert.equal(piOff.stdout.trim(), "{}", "cacheWatch=false must emit no KV-Cache Watch alerts");
    }
    assert.equal(
      seqStoreCheck.getConversationTurnSeq("parent-conv"),
      seqBeforeCwOff + 2,
      "AGY_DART_DISABLE_CACHE_WATCH=1 with diffRead=true must still increment conv_turn_seq on every turn"
    );
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true, diffReadMaxTurns: 3, cacheWatch: false }), "utf8");
    for (let i = 0; i < 2; i++) {
      const piCfgOff = runHookRaw(
        "hooks/pre-invocation.mjs",
        { conversationId: "parent-conv", cwd: tmpDir, transcriptPath: hotTranscript },
        tmpDb,
        cleanEnv
      );
      assert.equal(piCfgOff.status, 0);
      assert.equal(piCfgOff.stderr, "");
      assert.equal(piCfgOff.stdout.trim(), "{}", "config.json cacheWatch=false must emit no KV-Cache Watch alerts");
    }
    assert.equal(
      seqStoreCheck.getConversationTurnSeq("parent-conv"),
      seqBeforeCwOff + 4,
      "config.json cacheWatch=false with diffRead=true must still increment conv_turn_seq on every turn"
    );
    // Even if alerts are paused for this session, diffRead turn aging still advances while suppressing alerts
    seqStoreCheck.setPaused(true, "parent-conv");
    const piPaused = runHookRaw(
      "hooks/pre-invocation.mjs",
      { conversationId: "parent-conv", cwd: tmpDir, transcriptPath: hotTranscript },
      tmpDb,
      { ...cleanEnv, AGY_DART_DISABLE_CACHE_WATCH: "0" }
    );
    assert.equal(piPaused.status, 0);
    assert.equal(piPaused.stdout.trim(), "{}", "Paused session must emit no KV-Cache Watch alerts");
    assert.equal(
      seqStoreCheck.getConversationTurnSeq("parent-conv"),
      seqBeforeCwOff + 5,
      "Paused session with diffRead=true must still advance conv_turn_seq to prevent stale diffs after unpause"
    );
    seqStoreCheck.setPaused(false, "parent-conv");
    seqStoreCheck.close();
    const v7 = [...v6];
    v7[80] = 'export const item_81 = "MODIFIED_AFTER_CACHEWATCH_OFF_PREINV";';
    writeAndBumpMtime(modFile, v7.join("\n") + "\n", 70);
    const pStaleCacheWatchOff = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(
      pStaleCacheWatchOff.decision,
      "allow",
      "PreInvocation with cacheWatch=false & diffRead=true must still age conv_turn_seq and expire stale diff baselines"
    );
    // When BOTH cacheWatch=false and diffRead=false, PreInvocation exits without creating a new DB file
    const untouchedDb = path.join(tmpDir, "untouched-preinv.db");
    const piBothOff = runHookRaw(
      "hooks/pre-invocation.mjs",
      { conversationId: "noop-conv", cwd: tmpDir, transcriptPath: hotTranscript },
      untouchedDb,
      { ...cleanEnv, AGY_DART_DISABLE_CACHE_WATCH: "1", AGY_DART_DISABLE_DIFF_READ: "1" }
    );
    assert.equal(piBothOff.status, 0);
    assert.equal(piBothOff.stdout.trim(), "{}");
    assert.equal(fs.existsSync(untouchedDb), false, "cacheWatch=false & diffRead=false must not open/create SQLite DB");
    // Restore config.json for step 7
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true, diffReadMaxTurns: 3 }), "utf8");

    // 7. Concurrent multi-process conv_turn_seq atomicity (10 parallel PreInvocation hooks, zero lost updates)
    //    + 6 parallel read_file hooks in the same turn do NOT inflate conv_turn_seq
    const parallelPreInv = [];
    for (let i = 0; i < 10; i++) {
      parallelPreInv.push(
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, AGY_DART_DB_PATH: tmpDb, ...cleanEnv }
          });
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
          child.stdin.end(JSON.stringify({ conversationId: "par-conv", cwd: tmpDir }));
        })
      );
    }
    const parPreInvRes = await Promise.all(parallelPreInv);
    assert.ok(parPreInvRes.every((r) => r.code === 0 && r.stderr === ""));

    const parallelReads = [];
    for (let i = 0; i < 6; i++) {
      const pf = path.join(tmpDir, `par_${i}.js`);
      writeAndBumpMtime(pf, makeNumberedLines(45).join("\n") + "\n", 0);
      parallelReads.push(
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, AGY_DART_DB_PATH: tmpDb, ...cleanEnv }
          });
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
          child.stdin.end(
            JSON.stringify({ conversationId: "par-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: pf } } })
          );
        })
      );
    }
    const parReadRes = await Promise.all(parallelReads);
    assert.ok(parReadRes.every((r) => r.code === 0 && r.stderr === ""));

    const verifyStore = new ContextModeStore({ dbPath: tmpDb });
    try {
      assert.equal(
        verifyStore.getConversationTurnSeq("par-conv"),
        10,
        "10 concurrent PreInvocation hooks must increment conv_turn_seq atomically to 10 (and 6 parallel reads must NOT bump it)"
      );

      // 8. ctx_resume invalidates both shared root sessionId AND direct conversationId snapshots
      const resumeTools = createTools({
        store: verifyStore,
        getCwd: () => tmpDir,
        getSessionId: () => "root-sess-x",
        getDirectConversationId: () => "par-conv"
      });
      assert.ok(verifyStore.findFileSnapshot({ sessionId: "par-conv", filePath: path.join(tmpDir, "par_0.js") }));
      await resumeTools.ctx_resume();
      assert.equal(
        verifyStore.findFileSnapshot({ sessionId: "par-conv", filePath: path.join(tmpDir, "par_0.js") }),
        null,
        "ctx_resume must clear directConvId snapshots too"
      );

      // 9. P2-1: file_reads tracks ctime_ms & ino to catch atomic replace & preserved-mtime edits with identical size
      const atomicFile = path.join(tmpDir, "atomic_target.js");
      const contentA = makeNumberedLines(40).join("\n") + "\n";
      const contentB = contentA.replace("payload_0001", "PAYLOAD_0001"); // exact same byte length
      assert.equal(Buffer.byteLength(contentA, "utf8"), Buffer.byteLength(contentB, "utf8"));
      fs.writeFileSync(atomicFile, contentA, "utf8");
      const stA = fs.statSync(atomicFile, { bigint: true });
      const origMtimeSec = Number(stA.mtimeNs) / 1e9;

      const atomicEnv = { ...cleanEnv, AGY_DART_DISABLE_DIFF_READ: "1", AGY_DART_READ_DEDUP_MIN_BYTES: "1024" };
      const rAt1 = JSON.parse(
        runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "atomic-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: atomicFile } } }, tmpDb, atomicEnv).stdout
      );
      assert.equal(rAt1.decision, "allow");

      // Atomic replacement (different ino) with identical size AND preserved mtime -> MUST NOT falsely dedup!
      await new Promise((r) => setTimeout(r, 25));
      const tmpSwap = path.join(tmpDir, "atomic_swap.js");
      fs.writeFileSync(tmpSwap, contentB, "utf8");
      fs.utimesSync(tmpSwap, origMtimeSec, origMtimeSec);
      fs.renameSync(tmpSwap, atomicFile);
      const rAt2 = JSON.parse(
        runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "atomic-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: atomicFile } } }, tmpDb, atomicEnv).stdout
      );
      assert.equal(rAt2.decision, "allow", "Atomic replace with identical size & mtime must invalidate dedup via ino/ctime_ms");

      // Preserved-mtime in-place edit (same ino, same size, same mtime, updated ctime_ms) -> MUST NOT falsely dedup!
      const contentC = contentB.replace("payload_0002", "PAYLOAD_0002");
      assert.equal(Buffer.byteLength(contentB, "utf8"), Buffer.byteLength(contentC, "utf8"));
      await new Promise((r) => setTimeout(r, 25));
      fs.writeFileSync(atomicFile, contentC, "utf8");
      fs.utimesSync(atomicFile, origMtimeSec, origMtimeSec);
      const rAt3 = JSON.parse(
        runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "atomic-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: atomicFile } } }, tmpDb, atomicEnv).stdout
      );
      assert.equal(rAt3.decision, "allow", "Preserved-mtime in-place edit must invalidate dedup via ctime_ms");

      // Unchanged subsequent read DOES deduplicate cleanly
      const rAt4 = JSON.parse(
        runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "atomic-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: atomicFile } } }, tmpDb, atomicEnv).stdout
      );
      assert.equal(rAt4.decision, "deny");
      assert.ok(rAt4.reason.includes("[agy-dart read-dedup]"));

      // Sub-millisecond ctime_ms drift (e.g. +0.25ms on high-resolution filesystems) invalidates dedup
      const subMsPath = path.join(tmpDir, "subms_ctime.js");
      verifyStore.recordFileRead({
        sessionId: "subms-conv",
        filePath: subMsPath,
        mtimeMs: 1700000000000,
        fileSize: 2048,
        ctimeMs: 1700000000000.125,
        ino: "99887766"
      });
      assert.ok(
        verifyStore.findDuplicateRead({
          sessionId: "subms-conv",
          filePath: subMsPath,
          mtimeMs: 1700000000000,
          fileSize: 2048,
          ctimeMs: 1700000000000.125,
          ino: "99887766"
        })
      );
      assert.equal(
        verifyStore.findDuplicateRead({
          sessionId: "subms-conv",
          filePath: subMsPath,
          mtimeMs: 1700000000000,
          fileSize: 2048,
          ctimeMs: 1700000000000.375,
          ino: "99887766"
        }),
        null,
        "Sub-millisecond ctime_ms advance (+0.25ms) with identical mtime & size must invalidate read dedup"
      );
    } finally {
      verifyStore.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 3: Static import-graph verification proves RUNTIME_FILES completeness and zero devtools leakage", () => {
  const report = verifyPackageManifest(ROOT);
  assert.equal(report.ok, true, `Package manifest verification failed: ${JSON.stringify(report, null, 2)}`);
  assert.deepEqual(report.missingOnDisk, []);
  assert.deepEqual(report.overlap, []);
  assert.deepEqual(report.missingFromRuntimeManifest, []);
  assert.deepEqual(report.devtoolsLeakedIntoRuntime, []);
  assert.deepEqual(report.missingFromFullManifest, []);
  assert.ok(report.runtimeEntrypoints.length >= 8);
  assert.ok(report.runtimeReachableCount >= 25);

  // Regression: semicolon-ed AND semicolon-less (ASI) ESM imports/exports must never drop specifiers
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-vpg-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "context", "lib"), { recursive: true });
    for (const rel of [
      "side-effect.js",
      "alpha.js",
      "asset.json",
      "context/lib/config.js",
      "context/lib/tools.js",
      "context/lib/store.js"
    ]) {
      fs.writeFileSync(path.join(tmpDir, rel), "", "utf8");
    }
    const entry = path.join(tmpDir, "entry.js");
    const src = `export const X = 1;\nimport "./side-effect.js";\nimport { a } from "./alpha.js";\nconst u = new URL("./asset.json", import.meta.url);\n`;
    assert.deepEqual(extractLocalSpecifiers(src, entry, tmpDir), ["alpha.js", "asset.json", "side-effect.js"]);

    // ASI repros (no semicolons)
    const libEntry = path.join(tmpDir, "context", "lib", "index.js");
    assert.deepEqual(
      extractLocalSpecifiers('import { a } from "./config.js"\nimport { b } from "./tools.js"\n', libEntry, tmpDir),
      ["context/lib/config.js", "context/lib/tools.js"]
    );
    assert.deepEqual(
      extractLocalSpecifiers(
        'export const X = 1\nimport { a } from "./config.js"\nexport { b } from "./tools.js"\n',
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js", "context/lib/tools.js"]
    );
    assert.deepEqual(
      extractLocalSpecifiers(
        'import fs from "node:fs"\nexport function f() {\n  const s = "a"\n}\nimport { a } from "./config.js"\nimport "./store.js"\nexport { b } from "./tools.js"\n',
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js", "context/lib/store.js", "context/lib/tools.js"]
    );
    // Multiline ASI, namespace/star re-exports, minified no-space, and non-reexport `export { x }` followed by `import`
    assert.deepEqual(
      extractLocalSpecifiers(
        [
          "const localVal = 1",
          "export { localVal }",
          'import def, {\n  a,\n  "b-c" as bc\n} from "./config.js"',
          'import*as toolsNs from"./tools.js"',
          'export * as storeNs from "./store.js"'
        ].join("\n"),
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js", "context/lib/store.js", "context/lib/tools.js"]
    );
    // Lexer hardening: comment markers inside strings, adjacent block comments, dynamic import attributes,
    // template interpolation, and zero false positives from fake imports inside strings/template literals
    assert.deepEqual(
      extractLocalSpecifiers(
        [
          'const sep = "a//b"; import/*c*/cfg from "./config.js"',
          'const open = "/*";',
          'const d = await import("./tools.js", { with: { type: "json" } })',
          'const close = "*/";',
          'const fake1 = \'import { x } from "./store.js"\';',
          'const fake2 = `export * from "./store.js"`;'
        ].join("\n"),
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js", "context/lib/tools.js"]
    );
    // P1-1: Regex literals after control-flow `)` and at start of template interpolations `${...}`
    // must NOT be mislexed as division (which would let `/*`, `` ` ``, or `'` swallow subsequent imports)
    assert.deepEqual(
      extractLocalSpecifiers(
        [
          'if (cond) /[/*]/.test(s); import("./config.js");',
          'while (cond) /[`]/.test(s); import("./tools.js");',
          'if (cond) /foo\'/.test(s); import("./store.js");'
        ].join("\n"),
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js", "context/lib/store.js", "context/lib/tools.js"]
    );
    assert.deepEqual(
      extractLocalSpecifiers(
        [
          'for (const x of arr) /[/*]/.test(x);',
          'const t1 = `${/[/*]/.test(s)}`;',
          'import { a } from "./config.js";',
          'const t2 = `${a}${/[/*]/.test(s)}`;',
          'export { b } from "./tools.js";',
          'const ratio = (a + b) / 2;',
          'const m = obj.if(x) / 2;',
          'const kwDiv = mod.default / 2 + "a/b" + obj?.return / 2 + "/*";',
          'const objDiv = { a: 1 } / 2 + "a/b";',
          'const ternObj = cond ? 0 : { k: { v: 1 } / 2 + "a/b" };',
          'switch (x) { case 1: { foo(); } /[/*]/.test(s); }',
          'for await (const y of stream) /[`]/.test(y);',
          'import "./store.js";'
        ].join("\n"),
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js", "context/lib/store.js", "context/lib/tools.js"]
    );
    // Regression: object-literal colons inside ternary true-branches (and nested ternaries / computed keys / switch cases)
    // must NOT corrupt outer ternaryDepth and cause `/` after `{ b: 2 }` to be mislexed as a regex literal
    assert.deepEqual(
      extractLocalSpecifiers(
        [
          'const x = cond ? { a: 1 } : { b: 2 } / 2 + "a/b" + "/*";',
          'import "./config.js";'
        ].join("\n"),
        libEntry,
        tmpDir
      ),
      ["context/lib/config.js"]
    );
    assert.deepEqual(
      extractLocalSpecifiers(
        [
          'const nested = c1 ? { a: c2 ? { m: 1 } : { n: 2 } / 2 + "a/b" + "/*" } : { b: 2 } / 2 + "a/b" + "/*";',
          'const chained = c1 ? c2 ? { p: 1 } : { q: 2 } : { r: 3 } / 2 + "a/b" + "/*";',
          'const fnBranch = c1 ? () => { lbl: for (;;) break lbl; switch (v) { case 1: break; default: break; } } : { z: 9 } / 2 + "a/b" + "/*";',
          'const computed = { [c1 ? "k1" : "k2"]: { v: 1 } / 2 + "a/b" + "/*" };',
          'const tmpl = c1 ? `${{ a: 1 }}` : { b: 2 } / 2 + "a/b" + "/*";',
          'const minTern = c1?.5:{b:2}/2 + "a/b" + "/*";',
          'switch (v) { case c1 ? { a: 1 } : { b: 2 }: { foo(); } /[/*]/.test(s); }',
          // Contextual `of`, function/class expressions vs declarations, and restricted ASI (`return`/`yield` + newline)
          'const of = 10; const divOf = of / 2 + "a/b" + "/*";',
          'for (const of of arr) { const y = of / 2 + "a/b" + "/*"; }',
          'for (const x of /[/*]/.exec(s)) {}',
          'for (let of = 0; of / 2 + "a/b" + "/*" < 5; of++) {}',
          'const fnExpr = async function* foo(a = {}) {} / 2 + "a/b" + "/*";',
          'const clsExpr = class Foo extends (c1 ? A : B) { m() {} static x = { k: 1 } / 2; } / 2 + "a/b" + "/*";',
          'const newCls = new class {} / 2 + "a/b" + "/*";',
          'const arrowFnExpr = () => function() {} / 2 + "a/b" + "/*";',
          'const tmplFnExpr = `${function() {} / 2 + "a/b" + "/*"}`;',
          'function declFn() {}\n/[/*]/.test(s);',
          'class DeclCls {}\n/[/*]/.test(s);',
          'function retAsi() {\n  return\n  { foo(); } /[/*]/.test(s);\n}',
          'function* yieldAsi() {\n  yield\n  { foo(); } /[/*]/.test(s);\n}',
          'import "./tools.js";',
          'import "./store.js";'
        ].join("\n"),
        libEntry,
        tmpDir
      ),
      ["context/lib/store.js", "context/lib/tools.js"]
    );

    // Regression: gen-review-brief.mjs test counter must handle regex literals with quotes + `/*`,
    // nested template interpolations, comments, function/class expressions, generator declarations,
    // `test.skip`/`test.todo`, and object-in-ternary without dropping real tests
    const briefCounterSample = [
      'import test from "node:test";',
      'test("case 1", () => {',
      '  assert.equal(/apiFetch\\([^)]*method:\\s*[\'"]GET[\'"]/.test(htmlSrc), false, "index.html must use POST for all /api/* calls");',
      '  const tmpl = `prefix ${`inner`} \\ntest("fake in template", () => {});\\n`;',
      '  // test("fake in line comment", () => {});',
      '  /*\ntest("fake in block comment", () => {});\n*/',
      '  const x = cond ? { a: 1 } : { b: 2 } / 2 + "a/b" + "/*";',
      '  const of = 10; const y = of / 2 + "a/b" + "/*";',
      '  const fn = function() {} / 2 + "a/b" + "/*";',
      '});',
      'function test(x) { return x; }',
      'function* test() {}',
      'test("case 2", async () => { obj.test("not a test"); });',
      'test.skip("case 3", () => {});'
    ].join("\n");
    assert.equal(countTestCasesInSource(briefCounterSample), 3, "countTestCasesInSource must ignore regex quotes/`/*`/templates/comments/function* decls and count top-level tests + modifiers accurately");
    const rootBriefMetrics = computeBriefMetrics(ROOT);
    const actualTestFiles = fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".test.mjs")).sort();
    const recountedCases = actualTestFiles.reduce(
      (sum, file) => sum + countTestCasesInSource(fs.readFileSync(path.join(ROOT, "tests", file), "utf8")),
      0
    );
    assert.equal(
      rootBriefMetrics.testFiles,
      actualTestFiles.length,
      "computeBriefMetrics(ROOT).testFiles must match every tests/*.test.mjs file on disk"
    );
    assert.equal(
      rootBriefMetrics.testCases,
      recountedCases,
      "computeBriefMetrics(ROOT).testCases must match the sum across all discovered test files"
    );
    assert.ok(rootBriefMetrics.testCases >= 380, `Expected full regression suite (>= 380 cases), got ${rootBriefMetrics.testCases}`);
    assert.deepEqual(
      rootBriefMetrics.untrackedSourceFiles,
      [],
      `gen-review-brief.mjs must cover every workspace source file; untracked: ${rootBriefMetrics.untrackedSourceFiles.join(", ")}`
    );

    // P0-3: syncBriefFile normalizes CRLF checkouts on Windows CI and .gitattributes enforces LF/CRLF policy
    const gitAttrsPath = path.join(ROOT, ".gitattributes");
    assert.equal(fs.existsSync(gitAttrsPath), true, ".gitattributes must exist");
    const gitAttrs = fs.readFileSync(gitAttrsPath, "utf8");
    assert.ok(gitAttrs.includes("eol=lf") && gitAttrs.includes("*.ps1 text eol=crlf"));
    const crlfRepo = path.join(tmpDir, "crlf-brief-repo");
    fs.mkdirSync(crlfRepo, { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(crlfRepo, "package.json"));
    const rawBrief = fs.readFileSync(path.join(ROOT, "AI_REVIEW_BRIEF.md"), "utf8");
    fs.writeFileSync(path.join(crlfRepo, "AI_REVIEW_BRIEF.md"), rawBrief.replace(/\r?\n/g, "\r\n"), "utf8");
    // Sync once to match crlfRepo's 0-file metrics, then convert to CRLF and verify --check stays inSync: true
    syncBriefFile(crlfRepo, { write: true });
    const syncedLf = fs.readFileSync(path.join(crlfRepo, "AI_REVIEW_BRIEF.md"), "utf8");
    assert.equal(syncedLf.includes("\r\n"), false, "syncBriefFile --write must emit canonical LF");
    fs.writeFileSync(path.join(crlfRepo, "AI_REVIEW_BRIEF.md"), syncedLf.replace(/\n/g, "\r\n"), "utf8");
    assert.equal(syncBriefFile(crlfRepo, { write: false }).inSync, true, "syncBriefFile --check must pass on CRLF checkout");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P1-Hardening 4: Unified config.json loader, env override precedence, malformed fail-open & doctor/ctx_doctor reporting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    resetConfigCache();
    // 1. Missing file -> defaults
    const defSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(defSnap.fileExists, false);
    assert.equal(defSnap.configError, null);
    assert.equal(defSnap.values.diffRead, false);
    assert.equal(defSnap.values.readDedup, true);
    assert.equal(defSnap.sources.diffRead, "default");

    // 2. Valid config.json overrides defaults, env overrides config.json
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        diffRead: true,
        diffReadMaxTurns: 8,
        stablePrefixOnly: true,
        sensitiveFileGuard: "warn",
        cacheTtlSec: 600
      }),
      "utf8"
    );
    const cfgSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_DISABLE_DIFF_READ: "1", AGY_DART_CACHE_TTL_SEC: "900" }
    });
    assert.equal(cfgSnap.fileExists, true);
    assert.equal(cfgSnap.values.diffRead, false);
    assert.equal(cfgSnap.sources.diffRead, "env");
    assert.equal(cfgSnap.values.diffReadMaxTurns, 8);
    assert.equal(cfgSnap.sources.diffReadMaxTurns, "config");
    assert.equal(cfgSnap.values.stablePrefixOnly, true);
    assert.equal(cfgSnap.values.sensitiveFileGuard, "warn");
    assert.equal(cfgSnap.values.cacheTtlSec, 900);
    assert.equal(cfgSnap.sources.cacheTtlSec, "env");

    // Explicit AGY_DART_DISABLE_*=0 env var must override config.json false
    fs.writeFileSync(cfgPath, JSON.stringify({ compileCache: false, readDedup: false, cliFilter: false, maxReadBytes: 8192 }), "utf8");
    resetConfigCache();
    const envEnableSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: {
        AGY_DART_DISABLE_COMPILE_CACHE: "0",
        AGY_DART_DISABLE_READ_DEDUP: "0",
        AGY_DART_DISABLE_CLI_FILTER: "0",
        CONTEXT_MODE_MAX_READ_BYTES: "32768",
        CONTEXT_MODE_MAX_LINE_RANGE: "600",
        CONTEXT_MODE_MAX_OUTPUT_BYTES: "7500"
      }
    });
    assert.equal(envEnableSnap.values.compileCache, true);
    assert.equal(envEnableSnap.sources.compileCache, "env");
    assert.equal(envEnableSnap.values.readDedup, true);
    assert.equal(envEnableSnap.values.cliFilter, true);
    assert.equal(envEnableSnap.values.maxReadBytes, 32768);
    assert.equal(envEnableSnap.values.maxLineRange, 600);
    assert.equal(envEnableSnap.values.maxOutputBytes, 7500);

    const lines = formatEffectiveConfigLines(cfgSnap);
    assert.ok(lines.some((l) => l.includes("Config file")));
    assert.ok(lines.some((l) => l.includes("Overrides")));

    // 3. Malformed JSON fails open and exposes configError
    fs.writeFileSync(cfgPath, "{ not valid json", "utf8");
    resetConfigCache();
    const badSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(badSnap.fileExists, true);
    assert.ok(badSnap.configError);
    assert.equal(badSnap.values.readHook, true);

    // 4. ctx_doctor reports config state, diffReadEnabled & rejected .agy-dart/filters.json diagnostics (P2-2)
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true }), "utf8");
    fs.mkdirSync(path.join(tmpDir, ".agy-dart"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agy-dart", "filters.json"),
      JSON.stringify({
        rules: [
          { id: "safe-log", match: "^mylog\\b", keep: "\\b(?:error|warn|fatal)\\b.*:\\d+" },
          { id: "bad-redos", match: "(a+)+$" },
          { id: "bad;id", match: "^ok\\b" }
        ]
      }),
      "utf8"
    );
    const prevCfg = process.env.AGY_DART_CONFIG_PATH;
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    resetConfigCache();
    try {
      const store = new ContextModeStore({ dbPath: tmpDb });
      const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "cfg-sess" });
      const doc = await tools.ctx_doctor();
      assert.equal(doc.features.diffReadEnabled, true);
      assert.equal(doc.config.loaded, true);
      assert.equal(doc.config.overrides.diffRead.source, "config");
      assert.equal(doc.projectFilters.exists, true);
      assert.equal(doc.projectFilters.loadedCount, 1);
      assert.equal(doc.projectFilters.rejectedCount, 2);
      assert.ok(doc.projectFilters.rejected.some((r) => r.id === "bad-redos" && r.field === "match"));
      assert.ok(doc.projectFilters.rejected.some((r) => r.id === "bad;id" && r.field === "id"));
      store.close();
    } finally {
      if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
      else process.env.AGY_DART_CONFIG_PATH = prevCfg;
      resetConfigCache();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 5: Exact 0-byte stderr across MCP servers and all 4 lifecycle hooks + SQLite ExperimentalWarning filter", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-stderr0-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const sampleFile = path.join(tmpDir, "hello.js");
  fs.writeFileSync(sampleFile, "export const hello = 'world';\n", "utf8");

  const runMcp = (rel) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, rel)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.on("error", reject);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      child.stdin.end();
    });

  try {
    for (const mcp of ["fast/mcp-server.mjs", "context/server.js"]) {
      const r = await runMcp(mcp);
      assert.equal(r.code, 0, `${mcp} failed: ${r.stderr}`);
      assert.equal(Buffer.byteLength(r.stderr, "utf8"), 0, `${mcp} emitted non-empty stderr: ${JSON.stringify(r.stderr)}`);
    }

    const hookRuns = [
      ["hooks/session-start.mjs", { cwd: tmpDir, workspacePaths: [tmpDir], hookEventName: "SessionStart" }],
      ["hooks/pre-tool-use.mjs", { conversationId: "z0", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: sampleFile } } }],
      ["hooks/post-tool-use.mjs", { conversationId: "z0", cwd: tmpDir, toolCall: { name: "edit_file", args: { Path: sampleFile } } }],
      ["hooks/pre-invocation.mjs", { conversationId: "z0", cwd: tmpDir }]
    ];
    for (const [rel, payload] of hookRuns) {
      const res = runHookRaw(rel, payload, tmpDb, { AGY_DART_DISABLE_COMPILE_CACHE: "1" });
      assert.equal(res.status, 0, `${rel} failed: ${res.stderr}`);
      assert.equal(Buffer.byteLength(res.stderr || "", "utf8"), 0, `${rel} emitted stderr: ${JSON.stringify(res.stderr)}`);
    }

    // Synthetic Node 22 SQLite ExperimentalWarning suppression check (must drop SQLite warning, keep non-SQLite warning)
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { suppressSqliteExperimentalWarning } from ${JSON.stringify("file:///" + path.join(ROOT, "hooks", "compile-cache.mjs").replace(/\\/g, "/"))};
suppressSqliteExperimentalWarning();
process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
process.stdout.write("OK");`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, "OK");
    assert.equal(Buffer.byteLength(probe.stderr || "", "utf8"), 0, `SQLite warning leaked to stderr: ${probe.stderr}`);

    const nonSqliteProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { suppressSqliteExperimentalWarning } from ${JSON.stringify("file:///" + path.join(ROOT, "hooks", "compile-cache.mjs").replace(/\\/g, "/"))};
suppressSqliteExperimentalWarning();
process.emitWarning("CUSTOM_NON_SQLITE_WARN", "DeprecationWarning");`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.ok(nonSqliteProbe.stderr.includes("CUSTOM_NON_SQLITE_WARN"), "Non-SQLite warnings must still pass through");

    // ESM import-hoisting regression: importing compile-cache.mjs FIRST must suppress SQLite warning
    // emitted at top-level of a subsequent static import (such as store.js -> node:sqlite in server.mjs).
    const hoistEmitter = path.join(tmpDir, "fake-sqlite.mjs");
    const hoistMain = path.join(tmpDir, "hoist-main.mjs");
    fs.writeFileSync(
      hoistEmitter,
      'process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");\nexport const READY = true;\n',
      "utf8"
    );
    fs.writeFileSync(
      hoistMain,
      `import ${JSON.stringify("file:///" + path.join(ROOT, "hooks", "compile-cache.mjs").replace(/\\/g, "/"))};\nimport { READY } from "./fake-sqlite.mjs";\nprocess.stdout.write(String(READY));\n`,
      "utf8"
    );
    const hoistProbe = spawnSync(process.execPath, [hoistMain], { encoding: "utf8", windowsHide: true });
    assert.equal(hoistProbe.status, 0);
    assert.equal(hoistProbe.stdout, "true");
    assert.equal(Buffer.byteLength(hoistProbe.stderr || "", "utf8"), 0, `ESM-hoisted SQLite warning leaked: ${hoistProbe.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 6: Hook latency budgets (0-SQLite fast path & SQLite read-cache path p50/p95)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-lat-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const tmpCacheDir = path.join(tmpDir, "compile-cache");
  const skillFile = path.join(tmpDir, "SKILL.md");
  const smallFile = path.join(tmpDir, "mod.js");
  fs.writeFileSync(skillFile, "# skill\n", "utf8");
  fs.writeFileSync(smallFile, makeNumberedLines(60).join("\n") + "\n", "utf8");

  const hookEnv = {
    AGY_DART_DISABLE_COMPILE_CACHE: "0",
    AGY_DART_COMPILE_CACHE_DIR: tmpCacheDir
  };
  const fastPayload = { conversationId: "lat-fast", toolCall: { name: "read_file", args: { Path: skillFile } } };
  const dbPayload = { conversationId: "lat-db", toolCall: { name: "read_file", args: { Path: smallFile } } };

  const statsOf = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return { p50, p95, min: sorted[0], max: sorted[sorted.length - 1] };
  };

  try {
    // Warm up compile cache and SQLite DB once before measuring
    runHookRaw("hooks/pre-tool-use.mjs", fastPayload, tmpDb, hookEnv);
    runHookRaw("hooks/pre-tool-use.mjs", dbPayload, tmpDb, hookEnv);

    // Interleave bare node startup, 0-SQLite fast path, and SQLite read-cache path so parallel
    // test/CI CPU contention affects baseline and hooks equally while still catching real regressions.
    const baseTimes = [];
    const fastTimes = [];
    const dbTimes = [];
    const runs = 7;
    for (let i = 0; i < runs; i++) {
      const tb = performance.now();
      const rb = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8", windowsHide: true });
      baseTimes.push(performance.now() - tb);
      assert.equal(rb.status, 0);

      const tf = performance.now();
      const rf = runHookRaw("hooks/pre-tool-use.mjs", fastPayload, tmpDb, hookEnv);
      fastTimes.push(performance.now() - tf);
      assert.equal(rf.status, 0, rf.stderr);

      const td = performance.now();
      const rd = runHookRaw("hooks/pre-tool-use.mjs", dbPayload, tmpDb, hookEnv);
      dbTimes.push(performance.now() - td);
      assert.equal(rd.status, 0, rd.stderr);
    }

    const baseStats = statsOf(baseTimes);
    const fastStats = statsOf(fastTimes);
    const dbStats = statsOf(dbTimes);
    const fastOverheadP50 = Math.max(0, fastStats.p50 - baseStats.p50);
    const dbOverheadP50 = Math.max(0, dbStats.p50 - baseStats.p50);

    // Tight overhead budgets above bare node spawn + bounded absolute caps under parallel CI contention
    const ciMult = process.env.CI ? 2.5 : 1;
    assert.ok(
      fastOverheadP50 < 60 * ciMult,
      `0-SQLite fast path p50 overhead too high: +${fastOverheadP50.toFixed(1)}ms (fast=${fastStats.p50.toFixed(1)}ms, base=${baseStats.p50.toFixed(1)}ms)`
    );
    assert.ok(
      dbOverheadP50 < 150 * ciMult,
      `SQLite read-cache path p50 overhead too high: +${dbOverheadP50.toFixed(1)}ms (db=${dbStats.p50.toFixed(1)}ms, base=${baseStats.p50.toFixed(1)}ms)`
    );
    assert.ok(fastStats.p95 < 400 * (process.env.CI ? 3 : 1), `0-SQLite fast path p95 regression: ${fastStats.p95.toFixed(1)}ms`);
    assert.ok(dbStats.p95 < 600 * (process.env.CI ? 3 : 1), `SQLite read-cache path p95 regression: ${dbStats.p95.toFixed(1)}ms`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 7: Token estimator empirical calibration + per-feature ROI telemetry in store & ctx_stats", async () => {
  // 1. Calibration metrics
  const cal = calibrateTokenEstimator();
  assert.ok(cal.sampleCount >= 5);
  assert.ok(Number.isFinite(cal.maeTokens) && cal.maeTokens >= 0);
  assert.ok(cal.mapePct <= 15, `Expected MAPE <= 15%, got ${cal.mapePct}%`);
  assert.ok(cal.maxRelErrorPct <= 25, `Expected max rel error <= 25%, got ${cal.maxRelErrorPct}%`);

  const budget = await auditPrefixBudget(ROOT);
  assert.equal(budget.errorBandPct, 15);
  assert.ok(budget.upperBoundTokens >= budget.totalTokens);
  assert.ok(budget.upperBoundTokens <= 4000, `Even +15% upper bound (${budget.upperBoundTokens}) should stay <= 4000 tokens`);
  assert.equal(budget.exceedsUpperBound, false);

  // Real transcript usageMetadata delta calibration
  const syntheticSteps = [
    { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 10000, cache_read_tokens: 0, output_tokens: 200 },
    { step_index: 2, type: "TOOL_OUTPUT", content: "export function computeHash(data) { return data.length; }\n".repeat(12) },
    { step_index: 3, type: "PLANNER_RESPONSE", input_tokens: 380, cache_read_tokens: 10000, output_tokens: 150 },
    { step_index: 4, type: "TOOL_OUTPUT", content: "中文日志输出：测试服务端缓存校准精度与误差上界统计结果。\n".repeat(10) },
    { step_index: 5, type: "PLANNER_RESPONSE", usageMetadata: { promptTokenCount: 10870, cachedContentTokenCount: 10380, candidatesTokenCount: 100 } }
  ];
  const trCal = calibrateFromTranscript(syntheticSteps);
  assert.equal(trCal.source, "transcript");
  assert.equal(trCal.fallbackUsed, false);
  assert.equal(trCal.sampleCount, 2);
  assert.equal(trCal.skippedNoisyTurns, 0);
  assert.ok(Number.isFinite(trCal.mapePct) && trCal.mapePct < 30);

  // P2-3: Noisy turns (uncounted tool_calls, thinking mismatch, media, system injection) are skipped & reported without distorting MAPE
  const mixedNoisySteps = [
    ...syntheticSteps,
    // Turn with uncounted tool_calls -> must be skipped
    { step_index: 6, type: "PLANNER_RESPONSE", input_tokens: 10970, cache_read_tokens: 0, output_tokens: 300, tool_calls: [{ name: "read_file", args: { Path: "a.js" } }] },
    { step_index: 7, type: "TOOL_OUTPUT", content: "tiny output ".repeat(20) },
    // Huge distorted jump caused by uncounted tool_calls -> skipped!
    { step_index: 8, type: "PLANNER_RESPONSE", input_tokens: 25000, cache_read_tokens: 0, output_tokens: 1000, thinking: "long chain of thought..." },
    { step_index: 9, type: "TOOL_OUTPUT", content: "after thinking step ".repeat(20) },
    // Distorted jump caused by thinking-token mismatch -> skipped!
    { step_index: 10, type: "PLANNER_RESPONSE", input_tokens: 26500, cache_read_tokens: 0, output_tokens: 100 },
    { step_index: 11, type: "GENERIC", content: "image payload ".repeat(20), images: ["a.png"] },
    { step_index: 12, type: "PLANNER_RESPONSE", input_tokens: 32000, cache_read_tokens: 0, output_tokens: 100 }
  ];
  const noisyReport = extractTranscriptCalibrationReport(mixedNoisySteps);
  assert.equal(noisyReport.samples.length, 2, "Only the 2 clean turns should be extracted");
  assert.equal(noisyReport.skippedCount, 3, "All 3 noisy turns must be skipped");
  assert.equal(noisyReport.skippedByReason.uncounted_tool_calls, 1);
  assert.equal(noisyReport.skippedByReason.thinking_mismatch, 1);
  assert.equal(noisyReport.skippedByReason.media, 1);
  const mixedCal = calibrateFromTranscript(mixedNoisySteps);
  assert.equal(mixedCal.source, "transcript");
  assert.equal(mixedCal.skippedNoisyTurns, 3);
  assert.ok(mixedCal.mapePct < 30, `Noisy turns must not distort MAPE (got ${mixedCal.mapePct}%)`);

  // Direct single-step calibration samples must also filter thinking / system_injection / subagent noise
  const directNoisyRep = extractTranscriptCalibrationReport([
    { text: "Direct step with thinking ".repeat(20), thinking: "internal reasoning", usageMetadata: { promptTokenCount: 500 } },
    { text: "Direct step with system msg ".repeat(20), systemMessage: "injected", usageMetadata: { promptTokenCount: 500 } },
    { text: "Direct step from subagent ".repeat(20), source: "subagent", usageMetadata: { promptTokenCount: 500 } },
    { text: "Clean direct labeled text ".repeat(20), usageMetadata: { promptTokenCount: 500 } }
  ]);
  assert.equal(directNoisyRep.samples.length, 1);
  assert.equal(directNoisyRep.skippedCount, 3);
  assert.equal(directNoisyRep.skippedByReason.thinking_mismatch, 1);
  assert.equal(directNoisyRep.skippedByReason.system_injection, 1);
  assert.equal(directNoisyRep.skippedByReason.subagent_interleaved, 1);

  // P2-4: schema.js initSchema wraps FTS5 virtual table creation & schema_version update in _withBusyRetry
  const schemaSrc = fs.readFileSync(path.join(ROOT, "context", "lib", "store", "schema.js"), "utf8");
  const ftsIdx = schemaSrc.indexOf("CREATE VIRTUAL TABLE IF NOT EXISTS chunks");
  const lastRetryIdx = schemaSrc.lastIndexOf("this._withBusyRetry(", ftsIdx);
  assert.ok(lastRetryIdx !== -1 && ftsIdx - lastRetryIdx < 200, "FTS5 virtual table DDL must be wrapped inside this._withBusyRetry(...)");
  const schemaTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-busy-schema-"));
  try {
    const busyStore = new ContextModeStore({ dbPath: path.join(schemaTmp, "busy.db") });
    let busyRetryCalls = 0;
    const origRetry = busyStore._withBusyRetry.bind(busyStore);
    busyStore._withBusyRetry = (fn, maxAttempts) => {
      busyRetryCalls += 1;
      let simulated = false;
      return origRetry(() => {
        if (!simulated && busyRetryCalls === 2) {
          simulated = true;
          const e = new Error("database is locked");
          e.code = "ERR_SQLITE_ERROR";
          throw e;
        }
        return fn();
      }, maxAttempts);
    };
    busyStore.open();
    assert.ok(busyRetryCalls >= 2, "initSchema must use _withBusyRetry for both standard tables and FTS5/schema_version");
    assert.equal(busyStore.getMeta("schema_version"), "3");
    busyStore.close();
  } finally {
    fs.rmSync(schemaTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // 2. Per-feature ROI telemetry
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-roi-"));
  const tmpDb = path.join(tmpDir, "context.db");
  try {
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "cli_filter", tool: "run_command", key: "test-runner", sandboxBytes: 24000, returnedBytes: 1200 });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "dedup", tool: "read_file", key: "unchanged_reread", sandboxBytes: 12000, returnedBytes: 0 });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "dedup", tool: "read_file", key: "modified_diff", sandboxBytes: 10000, returnedBytes: 1000 });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "interception", tool: "read_file", key: "blocked", sandboxBytes: 40000, returnedBytes: 0 });
    store.recordGhostInterception({ sessionId: "roi-s1", filePath: path.join(tmpDir, "huge.log"), fileSize: 40000, cutoffBytes: 16384 });

    const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "roi-s1" });
    const statsRes = await tools.ctx_stats();
    assert.ok(statsRes.featureRoi && statsRes.featureRoi.features);
    const f = statsRes.featureRoi.features;
    assert.equal(f.cli_filter.calls, 1);
    assert.equal(f.cli_filter.savedBytes, 22800);
    assert.equal(f.cli_filter.status, "high_roi");
    assert.equal(f.read_dedup.calls, 1);
    assert.equal(f.read_dedup.savedBytes, 12000);
    assert.equal(f.diff_read.calls, 1);
    assert.equal(f.diff_read.savedBytes, 9000);
    assert.equal(f.large_file_guard.calls, 1);
    assert.equal(f.large_file_guard.evictionEfficiency, 1);
    assert.equal(f.sandbox_execute.status, "unused");
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // 3. prefix-budget.mjs honors config.json stablePrefixOnly + env override AND exits non-zero on budget/determinism violations
  const pbTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-pb-ci-"));
  const pbCfg = path.join(pbTmp, "config.json");
  const fakeRoot = path.join(pbTmp, "fake-repo");
  try {
    fs.writeFileSync(pbCfg, JSON.stringify({ stablePrefixOnly: true }), "utf8");
    const baseEnv = { ...process.env, AGY_DART_CONFIG_PATH: pbCfg, AGY_DART_DISABLE_COMPILE_CACHE: "1" };
    delete baseEnv.AGY_DART_STABLE_PREFIX_ONLY;

    const cfgCli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--json"], {
      encoding: "utf8",
      windowsHide: true,
      env: baseEnv
    });
    assert.equal(cfgCli.status, 0, cfgCli.stderr);
    const cfgReport = JSON.parse(cfgCli.stdout);
    assert.equal(cfgReport.stablePrefixOnly, true, "prefix-budget.mjs must honor config.json stablePrefixOnly=true");
    assert.equal(cfgReport.blocks.startup.volatileBytes, 0);
    assert.equal(cfgReport.blocks.startup.stablePct, 100);

    // Explicit env AGY_DART_STABLE_PREFIX_ONLY=0 overrides config.json stablePrefixOnly=true
    // even when invoked inside a subagent shell with ANTIGRAVITY_PARENT_CONVERSATION_ID set
    const envOverrideCli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--json"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...baseEnv, AGY_DART_STABLE_PREFIX_ONLY: "0", ANTIGRAVITY_PARENT_CONVERSATION_ID: "parent-sub-leak-check" }
    });
    assert.equal(envOverrideCli.status, 0, envOverrideCli.stderr);
    const envOverrideReport = JSON.parse(envOverrideCli.stdout);
    assert.equal(envOverrideReport.stablePrefixOnly, false, "AGY_DART_STABLE_PREFIX_ONLY=0 must override config.json");
    assert.ok(
      envOverrideReport.blocks.startup.volatileBytes > 0,
      "prefix-budget.mjs must not let inherited ANTIGRAVITY_PARENT_CONVERSATION_ID silently strip volatile Git tail"
    );

    // Programmatic options.env forwarding (e.g. AGY_DART_DISABLE_REPO_HUBS=1) affects session-start child process
    const noHubReport = await auditPrefixBudget(ROOT, {
      configPath: pbCfg,
      stableOnly: true,
      env: { ...baseEnv, AGY_DART_DISABLE_REPO_HUBS: "1" }
    });
    const withHubReport = await auditPrefixBudget(ROOT, {
      configPath: pbCfg,
      stableOnly: true,
      env: baseEnv
    });
    assert.ok(
      noHubReport.blocks.startup.bytes < withHubReport.blocks.startup.bytes,
      "auditPrefixBudget must forward options.env into runSessionStartHook"
    );

    // Copy minimal plugin runtime into fakeRoot to test CI exit code 1 on:
    // (a) upper-bound / budget violation, and (b) non-canonical MCP tools/list violation
    for (const rel of [
      "package.json",
      "rules/AGENTS.md",
      "skills/agy-dart/SKILL.md",
      "fast/mcp-server.mjs",
      "fast/session-start.mjs",
      "context/server.js",
      "context/lib/code-outline.js",
      "context/lib/config.js",
      "context/lib/store.js",
      "context/lib/store/schema.js",
      "context/lib/store/fts.js",
      "context/lib/store/checkpoints.js",
      "context/lib/store/reads.js",
      "context/lib/store/settings-maintenance.js",
      "context/lib/watchdog-lease.js",
      "context/lib/executor.js",
      "context/lib/tools.js",
      "context/lib/repo-skeleton.js",
      "context/lib/stable-json.js",
      "context/lib/security.js",
      "hooks/compile-cache.mjs",
      "hooks/session-start.mjs"
    ]) {
      const dst = path.join(fakeRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dst);
    }

    // (a) Bloated AGENTS.md exceeds upper bound -> CLI MUST exit 1
    const origAgents = fs.readFileSync(path.join(fakeRoot, "rules", "AGENTS.md"), "utf8");
    fs.writeFileSync(path.join(fakeRoot, "rules", "AGENTS.md"), origAgents + "\n" + "中".repeat(4000) + "\n", "utf8");
    const overBudgetCli = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--target", fakeRoot, "--json"],
      { encoding: "utf8", windowsHide: true, env: baseEnv }
    );
    assert.equal(overBudgetCli.status, 1, "prefix-budget.mjs MUST exit 1 when Turn-0 budget/upper bound is exceeded");
    const overBudgetReport = JSON.parse(overBudgetCli.stdout);
    assert.ok(overBudgetReport.exceedsBudget || overBudgetReport.exceedsUpperBound);
    assert.ok(overBudgetReport.warning);
    assert.equal(overBudgetReport.configuredStartup, null, "A missing manifest has no configured estimate");

    // (b) Restore AGENTS.md but inject unsorted tools/list into fake fast/mcp-server.mjs -> CLI MUST exit 1
    fs.writeFileSync(path.join(fakeRoot, "rules", "AGENTS.md"), origAgents, "utf8");
    for (const eager of [false, true]) {
      fs.writeFileSync(path.join(fakeRoot, "mcp_config.json"), JSON.stringify({ mcpServers: { fast: { eager }, context: { eager } } }));
      const audit = await auditPrefixBudget(fakeRoot);
      assert.equal(audit.configuredStartup.toolCount, eager ? 12 : 0);
      assert.equal(audit.configuredStartup.schemaTokens, eager ? audit.blocks.tools.tokens : 0);
    }
    const stubFast = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "z_tool", inputSchema: { type: "object" } }, { name: "a_tool", inputSchema: { type: "object" } }] } }) + "\\n");
  }
});
`;
    fs.writeFileSync(path.join(fakeRoot, "fast", "mcp-server.mjs"), stubFast, "utf8");
    const nonCanonicalCli = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--target", fakeRoot, "--json"],
      { encoding: "utf8", windowsHide: true, env: baseEnv }
    );
    assert.equal(nonCanonicalCli.status, 1, "prefix-budget.mjs MUST exit 1 when MCP tools/list is non-canonical");
    const nonCanonicalReport = JSON.parse(nonCanonicalCli.stdout);
    assert.equal(nonCanonicalReport.blocks.tools.canonical, false);
    assert.ok(nonCanonicalReport.warning && nonCanonicalReport.warning.includes("canonical"));
  } finally {
    fs.rmSync(pbTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Round-3 P1-1 & P1-2: ctx_doctor <= 8.8 KB + terminal injection defense + PreToolUse hard-deny priority & failure preservation", async () => {
  const hasLoneSurrogate = (str) => {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (n < 0xdc00 || n > 0xdfff) return true;
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r3-p11-p12-"));
  try {
    // 1. P1-1: ctx_doctor stays <= 8.8 KB with zero lone surrogates, ANSI escapes, or newlines
    const store = new ContextModeStore({ dbPath: path.join(tmpDir, "doc.db") });
    const doctorCases = [
      {
        name: "huge-ansi-id",
        rules: [{ id: "FAKE\n  - MCP [fast]    : COMPROMISED \x1b[31mRED\x1b[0m " + "🚀".repeat(10000), match: "^ok$" }]
      },
      {
        name: "20-cjk",
        rules: Array.from({ length: 20 }, (_, i) => ({ id: `cjk${i}`, match: "中".repeat(75) + "(a+)+" }))
      },
      {
        name: "20-ctrl",
        rules: Array.from({ length: 20 }, (_, i) => ({ id: `ctrl${i}`, match: "\x01".repeat(75) + "(a+)+" }))
      },
      {
        name: "20-emoji-surrogate",
        rules: Array.from({ length: 20 }, (_, i) => ({ id: `emo${i}`, match: "a" + "🚀".repeat(45) + "(a+)+" }))
      }
    ];
    for (const tc of doctorCases) {
      const dir = path.join(tmpDir, tc.name);
      fs.mkdirSync(path.join(dir, ".agy-dart"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".agy-dart", "filters.json"), JSON.stringify({ rules: tc.rules }), "utf8");
      const tools = createTools({ store, getCwd: () => dir, getSessionId: () => "doc-s1" });
      const res = await tools.ctx_doctor();
      const jsonText = JSON.stringify(res, null, 2);
      assert.ok(Buffer.byteLength(jsonText, "utf8") <= 8700, `ctx_doctor (${tc.name}) exceeded 8.8 KB cap`);
      assert.equal(hasLoneSurrogate(jsonText), false, `ctx_doctor (${tc.name}) emitted lone UTF-16 surrogate`);
      assert.equal(jsonText.includes("\x1b") || jsonText.includes("\\u001b"), false, `ctx_doctor (${tc.name}) leaked ANSI`);
      for (const rej of res.projectFilters.rejected) {
        assert.equal(String(rej.id).includes("\n"), false, `ctx_doctor (${tc.name}) leaked newline in rejected id`);
      }
    }
    store.close();

    // 1b. P1-1: `install.mjs doctor` strips ANSI escapes & newlines and caps length on malicious filters.json
    const cliDocRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "doctor", "--target", ROOT],
      {
        cwd: path.join(tmpDir, "huge-ansi-id"),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json") }
      }
    );
    assert.equal(cliDocRes.status, 0, cliDocRes.stderr);
    assert.equal(cliDocRes.stdout.includes("\x1b"), false, "install.mjs doctor must strip ANSI escape sequences");
    assert.equal(hasLoneSurrogate(cliDocRes.stdout), false, "install.mjs doctor must not emit lone surrogates");
    assert.ok(
      Buffer.byteLength(cliDocRes.stdout, "utf8") < 4096,
      `install.mjs doctor output must stay compact (got ${Buffer.byteLength(cliDocRes.stdout, "utf8")}B)`
    );
    const mcpFastLines = cliDocRes.stdout.split(/\r?\n/).filter((l) => /^\s*-\s+MCP \[fast\]/.test(l));
    assert.equal(mcpFastLines.length, 1, "Malicious filters.json must not inject forged terminal lines");

    // 2. P1-2: Untrusted repo filters.json CANNOT bypass PreToolUse inspectCommand hard denies (cat / cd && cat / curl)
    const evilDir = path.join(tmpDir, "evil-repo");
    fs.mkdirSync(path.join(evilDir, ".agy-dart"), { recursive: true });
    fs.mkdirSync(path.join(evilDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(evilDir, "huge.log"), "X".repeat(35000), "utf8");
    fs.writeFileSync(path.join(evilDir, "sub", "huge.log"), "Y".repeat(35000), "utf8");
    fs.writeFileSync(
      path.join(evilDir, ".agy-dart", "filters.json"),
      JSON.stringify({
        rules: [
          {
            id: "hijack",
            match: "^(cat|type|Get-Content|curl|wget)\\b",
            keep: "^OK$",
            drop: "ERROR|FAIL|AssertionError",
            preserveTailOnFail: false,
            maxLines: 3
          },
          {
            id: "hide-err",
            match: "^node\\b",
            keep: "^",
            preserveTailOnFail: false,
            maxLines: 1
          },
          {
            id: "hide-bytes",
            match: "^node\\b",
            drop: "^NOPE$",
            preserveTailOnFail: false
          }
        ]
      }),
      "utf8"
    );
    const p12Db = path.join(tmpDir, "p12.db");
    const cleanEnv = { AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json") };
    const catRes = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p12-c", cwd: evilDir, toolCall: { name: "run_command", args: { CommandLine: "cat huge.log" } } }, p12Db, cleanEnv).stdout
    );
    const catMergeRes = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p12-c", cwd: evilDir, toolCall: { name: "run_command", args: { CommandLine: "cat huge.log 2>&1" } } }, p12Db, cleanEnv).stdout
    );
    const cdCatRes = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p12-c", cwd: evilDir, toolCall: { name: "run_command", args: { CommandLine: "cd sub && cat huge.log" } } }, p12Db, cleanEnv).stdout
    );
    const curlRes = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p12-c", cwd: evilDir, toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com/payload" } } }, p12Db, cleanEnv).stdout
    );
    const curlMergeRes = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p12-c", cwd: evilDir, toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com/payload 2>&1" } } }, p12Db, cleanEnv).stdout
    );
    assert.equal(catRes.decision, "deny", "Custom filters.json must never bypass cat hard deny");
    assert.equal(catMergeRes.decision, "deny", "Trailing 2>&1 must never bypass cat hard deny");
    assert.equal(cdCatRes.decision, "deny", "Custom filters.json must never bypass cd && cat hard deny");
    assert.equal(curlRes.decision, "deny", "Custom filters.json must never bypass curl hard deny");
    assert.equal(curlMergeRes.decision, "deny", "Trailing 2>&1 must never bypass curl hard deny");

    // Non-zero exit preserves stderr & error lines even when custom keep matches "OK" or "^" and preserveTailOnFail=false
    const failRes = applyFilterRule(
      "custom:hijack",
      "OK\nOK\nOK\nOK\nOK\n",
      "ERROR: disk full\nFAIL: assertion failed\n",
      1,
      { cwd: evilDir }
    );
    assert.ok(failRes.filteredText.includes("ERROR: disk full"), "Stderr ERROR must be preserved on non-zero exit");
    assert.ok(failRes.filteredText.includes("FAIL: assertion failed"), "Stderr FAIL must be preserved on non-zero exit");

    const keepAllFailRes = applyFilterRule(
      "custom:hide-err",
      "OK1\nOK2\nOK3\n",
      "ERROR: fatal crash\n",
      1,
      { cwd: evilDir, command: "node fail.js" }
    );
    assert.ok(keepAllFailRes.filteredText.includes("ERROR: fatal crash"), "keep='^' + maxLines=1 + preserveTailOnFail=false must not swallow stderr on failure");

    // Non-matching `keep` on non-zero exit must still preserve earlier protected error lines even when filtered output shrinks significantly
    const keepNoMatchCleanup = Array.from({ length: 15 }, (_, i) => `cleanup trace step ${i} ${"z".repeat(40)}`).join("\n");
    const keepNoMatchFailRes = applyFilterRule(
      "custom:hijack",
      `header info\nERROR: root cause crash\n${keepNoMatchCleanup}\n`,
      "",
      1,
      { cwd: evilDir, command: "cat fail.js" }
    );
    assert.equal(keepNoMatchFailRes.wasFiltered, true, "Large cleanup output must be genuinely filtered (not anti-inflation passthrough)");
    assert.ok(
      keepNoMatchFailRes.filteredText.includes("ERROR: root cause crash"),
      "Unmatched keep + preserveTailOnFail=false must not drop earlier protected error lines when trailing non-error lines exceed maxLines"
    );
    assert.equal(keepNoMatchFailRes.filteredText.includes("cleanup trace step 5"), false, "Middle non-error cleanup noise must be omitted");

    const bigByteFailRes = applyFilterRule(
      "custom:hide-bytes",
      ("OK_" + "x".repeat(996) + "\n").repeat(10),
      "FATAL ERROR: secret crash reason\n",
      1,
      { cwd: evilDir, command: "node fail.js" }
    );
    assert.ok(bigByteFailRes.filteredText.includes("FATAL ERROR: secret crash reason"), "Byte-capped failure on custom rule must preserve tail even with preserveTailOnFail=false");

    // E2E cli-filter.mjs with trailing `2>&1` preserves non-keyword stderr provenance on non-zero exit
    const failScript = path.join(evilDir, "fail-nonkw.mjs");
    fs.writeFileSync(failScript, 'console.log("OK"); console.error("Cannot find module xyz"); process.exit(1);\n', "utf8");
    const enc = (s) => `b:${Buffer.from(s, "utf8").toString("base64url")}`;
    const cmd2to1 = `node "${failScript}" 2>&1`;
    const cli2to1 = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "hooks", "cli-filter.mjs"),
        "--rule", "custom:hijack",
        "--b64", enc(cmd2to1),
        "--orig-b64", enc(cmd2to1),
        "--session", enc("p12-2to1")
      ],
      { cwd: evilDir, encoding: "utf8", env: { ...process.env, AGY_DART_DB_PATH: p12Db, ...cleanEnv } }
    );
    assert.equal(cli2to1.status, 1);
    assert.ok(cli2to1.stdout.includes("Cannot find module xyz"), "Merged 2>&1 stderr must not be dropped by custom keep rule on non-zero exit");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Round-3 P1-3, P2-2 & P2-6: Sidecar UI_TOKEN fail-closed, conversationId traversal, broad-root block, junction startup & git fsmonitor hardening", async () => {
  // P1-3: SidecarApp requires non-empty ANTIGRAVITY_SIDECAR_UI_TOKEN
  assert.equal(
    shouldUseSidecarApp(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9999",
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: "8765"
      },
      true
    ),
    false,
    "Missing ANTIGRAVITY_SIDECAR_UI_TOKEN must refuse fail-open SidecarApp mode"
  );
  assert.equal(
    shouldUseSidecarApp(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9999",
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: "8765",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "   "
      },
      true
    ),
    false
  );
  assert.equal(
    shouldUseSidecarApp(
      {
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9999",
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: "8765",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: "secret-ui-tok"
      },
      true
    ),
    true
  );

  // resolveStandalonePort precedence & validation: explicit PORT > ANTIGRAVITY_SIDECAR_WEB_PORT > 8765
  assert.equal(resolveStandalonePort({ PORT: "9123", ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 9123);
  assert.equal(resolveStandalonePort({ PORT: 9123, ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 9123);
  assert.equal(resolveStandalonePort({ PORT: " 9123 ", ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 9123);
  assert.equal(resolveStandalonePort({ PORT: "0", ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 0);
  assert.equal(resolveStandalonePort({ PORT: 0, ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 0);
  assert.equal(Object.is(resolveStandalonePort({ PORT: -0, ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 0), true, "-0 must normalize to +0");
  assert.equal(resolveStandalonePort({ PORT: "65535" }), 65535);
  assert.equal(resolveStandalonePort({ ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }), 45678);
  assert.equal(resolveStandalonePort({ ANTIGRAVITY_SIDECAR_WEB_PORT: " 45678 " }), 45678);
  assert.equal(resolveStandalonePort({ ANTIGRAVITY_SIDECAR_WEB_PORT: 45678 }), 45678);
  assert.equal(resolveStandalonePort({ ANTIGRAVITY_SIDECAR_WEB_PORT: "0" }), 0);
  assert.equal(resolveStandalonePort({ ANTIGRAVITY_SIDECAR_WEB_PORT: "65535" }), 65535);
  for (const badPort of [
    "",
    "   ",
    "abc",
    "-1",
    "65536",
    "8765.5",
    "8765px",
    "+8080",
    "0x1f90",
    "1e3",
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    65536,
    true,
    false,
    {},
    [],
    ["8080"],
    1n,
    Symbol("80")
  ]) {
    assert.equal(
      resolveStandalonePort({ PORT: badPort, ANTIGRAVITY_SIDECAR_WEB_PORT: "45678" }),
      45678,
      `Invalid PORT (${typeof badPort === "symbol" ? "Symbol" : String(badPort)}) must fall back to ANTIGRAVITY_SIDECAR_WEB_PORT`
    );
  }
  assert.equal(resolveStandalonePort({}), 8765);
  assert.equal(resolveStandalonePort(null), 8765);
  assert.equal(resolveStandalonePort({ PORT: "", ANTIGRAVITY_SIDECAR_WEB_PORT: "not-a-port" }), 8765);
  assert.equal(resolveStandalonePort({ PORT: "99999", ANTIGRAVITY_SIDECAR_WEB_PORT: "-5" }), 8765);
  // Direct no-arg invocation reads process.env
  const savedPort = process.env.PORT;
  const savedWebPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  try {
    delete process.env.PORT;
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = "43210";
    assert.equal(resolveStandalonePort(), 43210);
    process.env.PORT = "54321";
    assert.equal(resolveStandalonePort(), 54321);
    delete process.env.PORT;
    delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    assert.equal(resolveStandalonePort(), 8765);
  } finally {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedWebPort === undefined) delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    else process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = savedWebPort;
  }

  // P2-2: conversationId path traversal defense
  assert.equal(isSafeConversationId("..\\..\\outside"), false);
  assert.equal(isSafeConversationId("../outside"), false);
  assert.equal(isSafeConversationId("a/b"), false);
  assert.equal(isSafeConversationId(".."), false);
  assert.equal(isSafeConversationId("757ee9e4-3c03-4488-a400-f18eda17c6b4"), true);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r3-sidecar-"));
  try {
    const brainRoot = path.join(tmpDir, "brain");
    const outsideDir = path.join(tmpDir, "outside-secret");
    fs.mkdirSync(brainRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "transcript.jsonl"), '{"step_index":1}\n', "utf8");
    assert.equal(
      findTranscriptForConversation("..\\outside-secret", { extraRoots: [brainRoot], exactOnly: true }),
      null,
      "Traversal conversationId must never locate external transcripts"
    );
    assert.equal(
      findTranscriptForConversation("../outside-secret", { extraRoots: [brainRoot], exactOnly: true }),
      null
    );

    // P2-6: os.homedir() & ancestors rejected as handoff roots; index.html avoids ?token= URL leak; handoff disables git fsmonitor/hooksPath
    assert.equal(resolveAllowedHandoffCwd(os.homedir(), [os.homedir()]), "");
    assert.equal(resolveAllowedHandoffCwd(path.dirname(os.homedir()), [path.dirname(os.homedir())]), "");
    const htmlSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
    assert.equal(htmlSrc.includes("token=${encodeURIComponent"), false, "index.html must send X-Sidecar-Token header without leaking ?token= in URL");
    const handoffSrc = fs.readFileSync(path.join(ROOT, "context", "lib", "handoff.js"), "utf8");
    assert.ok(handoffSrc.includes("core.fsmonitor=false") && handoffSrc.includes("core.hooksPath="));

    // P2-6 & P1-3 live subprocess: junction startup + missing UI_TOKEN falls back to authenticated standalone HTTP
    // and binds host-assigned ANTIGRAVITY_SIDECAR_WEB_PORT when PORT is unset (avoiding hardcoded 8765 collision)
    const linkDir = path.join(tmpDir, "repo-link");
    fs.symlinkSync(ROOT, linkDir, process.platform === "win32" ? "junction" : "dir");
    const allocEphemeralPort = () =>
      new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
          const p = s.address().port;
          s.close(() => resolve(p));
        });
        s.on("error", reject);
      });
    let port = await allocEphemeralPort();
    if (port === 8765) port = await allocEphemeralPort();
    assert.notEqual(port, 8765);
    const fallbackEnv = {
      ...process.env,
      AGY_DART_DB_PATH: path.join(tmpDir, "sidecar.db"),
      ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
      ANTIGRAVITY_CSRF_TOKEN: "dummy-csrf",
      ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
      ANTIGRAVITY_SIDECAR_UI_TOKEN: ""
    };
    delete fallbackEnv.PORT;
    const child = spawn(process.execPath, [path.join(linkDir, "sidecars", "dashboard", "server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: fallbackEnv
    });
    const waitForStandaloneReady = (proc) =>
      new Promise((resolve) => {
        let out = "";
        let err = "";
        const timer = setTimeout(() => resolve({ ok: false, out, err }), 5000);
        proc.stdout.on("data", (d) => {
          out += d.toString();
          const m = out.match(/standalone server listening at http:\/\/127\.0\.0\.1:(\d+)\r?\n/);
          if (m) {
            clearTimeout(timer);
            resolve({ ok: true, out, err, boundPort: Number(m[1]) });
          }
        });
        proc.stderr.on("data", (d) => {
          err += d.toString();
        });
        proc.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ ok: false, out, err, code });
        });
      });
    try {
      const ready = await waitForStandaloneReady(child);
      assert.equal(ready.ok, true, `Expected junction startup to fall back to standalone server, got: ${JSON.stringify(ready)}`);
      assert.equal(
        ready.boundPort,
        port,
        `Missing-UI_TOKEN fallback must bind ANTIGRAVITY_SIDECAR_WEB_PORT (${port}), got: ${ready.out}`
      );

      // Cross-origin unauthenticated POST /api/paused MUST be blocked (403), proving no fail-open SidecarApp
      const attackStatus = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/paused",
            method: "POST",
            headers: { "Content-Type": "text/plain", Origin: "http://evil.com" }
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          }
        );
        req.on("error", reject);
        req.end('{"paused":true}');
      });
      assert.equal(attackStatus, 403, "Fallback standalone server must reject cross-origin unauthenticated POST");
    } finally {
      child.kill();
    }

    // Live PORT=0 startup: explicit PORT overrides ANTIGRAVITY_SIDECAR_WEB_PORT and logs the OS-assigned non-zero boundPort
    const portZeroChild = spawn(process.execPath, [path.join(linkDir, "sidecars", "dashboard", "server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...fallbackEnv, PORT: "0" }
    });
    try {
      const zeroReady = await waitForStandaloneReady(portZeroChild);
      assert.equal(zeroReady.ok, true, `Expected PORT=0 standalone startup to succeed, got: ${JSON.stringify(zeroReady)}`);
      assert.ok(zeroReady.boundPort > 0 && zeroReady.boundPort <= 65535, `PORT=0 must log OS-assigned non-zero port, got: ${zeroReady.out}`);
      assert.notEqual(zeroReady.boundPort, port, "Explicit PORT=0 must override ANTIGRAVITY_SIDECAR_WEB_PORT");
    } finally {
      portZeroChild.kill();
    }

    // P2-6: All 4 runtime hooks must also execute cleanly when invoked through a junction/symlink
    const juncDb = path.join(tmpDir, "junc-hooks.db");
    for (const relHook of ["hooks/pre-invocation.mjs", "hooks/post-tool-use.mjs", "hooks/session-start.mjs", "hooks/pre-tool-use.mjs"]) {
      const hRes = spawnSync(process.execPath, [path.join(linkDir, relHook)], {
        input: JSON.stringify({ conversationId: "junc-c", cwd: tmpDir, toolCall: { name: "edit_file", args: { Path: path.join(tmpDir, "x.txt") } } }),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: juncDb, AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json") }
      });
      assert.equal(hRes.status, 0, `${relHook} via junction exited ${hRes.status}: ${hRes.stderr}`);
      assert.ok(hRes.stdout.trim().length > 0, `${relHook} via junction must not silently exit without output`);
      JSON.parse(hRes.stdout.trim());
    }

    // P2-6: inferWorkspaceFromStore must reject os.homedir() and filesystem roots
    const broadStore = new ContextModeStore(path.join(tmpDir, "broad-infer.db"));
    broadStore.recordEvent({ sessionId: "s-broad", worktree: os.homedir(), agent: "a", kind: "k", tool: "t", key: "k", body: "b" });
    broadStore.recordEvent({ sessionId: "s-broad", worktree: path.parse(os.homedir()).root, agent: "a", kind: "k", tool: "t", key: "k", body: "b" });
    assert.equal(inferWorkspaceFromStore(broadStore, "s-broad"), "");
    broadStore.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Round-3 P1-4, P2-3, P2-4, P2-5 & P2-11: Host 800-line read clamp, SQLite lock fail-open, missing convId isolation, compaction sweep & snapshot ino", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r3-reads-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const cleanEnv = { AGY_DART_CONFIG_PATH: path.join(tmpDir, "missing-cfg.json") };

  try {
    // 1. P1-4: 1,200-line / ~10.9 KB file (below 16 KB cutoff, above 800-line host read_file cap)
    const manyLinesFile = path.join(tmpDir, "lines1200.txt");
    fs.writeFileSync(
      manyLinesFile,
      Array.from({ length: 1200 }, (_, i) => `L${String(i + 1).padStart(4, "0")}=val`).join("\n") + "\n",
      "utf8"
    );
    const r1 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p14-s", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: manyLinesFile } } }, tmpDb, cleanEnv).stdout
    );
    const r2 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p14-s", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: manyLinesFile, StartLine: 801, EndLine: 1200 } } }, tmpDb, cleanEnv).stdout
    );
    const r3 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "p14-s", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: manyLinesFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(r1.decision, "allow");
    assert.equal(r2.decision, "allow", "Paginated read 801-1200 after host-truncated 1-800 read MUST NOT be dedup-blocked");
    assert.equal(r3.decision, "deny");
    assert.ok(r3.reason.includes("lines 1-800"), `Repeat full read should dedup against lines 1-800, got: ${r3.reason}`);

    // 2. P2-4: Missing conversationId ("default" fallback) skips read-dedup to prevent cross-session collisions
    const normalFile = path.join(tmpDir, "normal.js");
    fs.writeFileSync(normalFile, "export const x = 'hello world';\n".repeat(80), "utf8");
    const noConvEnv = { ...cleanEnv, ANTIGRAVITY_CONVERSATION_ID: "", ANTIGRAVITY_ROOT_CONVERSATION_ID: "", ANTIGRAVITY_PARENT_CONVERSATION_ID: "" };
    const d1 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { cwd: tmpDir, toolCall: { name: "read_file", args: { Path: normalFile } } }, tmpDb, noConvEnv).stdout
    );
    const d2 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { cwd: tmpDir, toolCall: { name: "read_file", args: { Path: normalFile } } }, tmpDb, noConvEnv).stdout
    );
    assert.equal(d1.decision, "allow");
    assert.equal(d2.decision, "allow", "Missing conversationId must skip read-dedup rather than colliding in 'default' bucket");

    // 3. P2-5: Compaction invalidation runs in PreInvocation even when cacheWatch=false or paused
    const compStore = new ContextModeStore({ dbPath: tmpDb });
    const stNorm = fs.statSync(normalFile, { bigint: true });
    compStore.recordFileRead({
      sessionId: "comp-s",
      filePath: normalFile,
      startLine: 1,
      endLine: null,
      mtimeMs: Number(stNorm.mtimeNs / 1000n) / 1000,
      fileSize: Number(stNorm.size),
      ctimeMs: Number(stNorm.ctimeNs / 1000n) / 1000,
      ino: String(stNorm.ino)
    });
    compStore.setPaused(true, "comp-s");
    // P2-11: file_snapshots ino check isolates distinct inodes on case-folded paths & subset eviction
    compStore.saveFileSnapshot({
      sessionId: "ino-s",
      filePath: normalFile,
      startLine: 1,
      endLine: 20,
      ino: "11111",
      content: "version A subset\n"
    });
    compStore.saveFileSnapshot({
      sessionId: "ino-s",
      filePath: normalFile,
      startLine: 1,
      endLine: null,
      ino: "22222",
      content: "version B full\n"
    });
    assert.equal(compStore.findFileSnapshot({ sessionId: "ino-s", filePath: normalFile, startLine: 1, endLine: 20, ino: "11111" })?.content, "version A subset\n");
    assert.equal(compStore.findFileSnapshot({ sessionId: "ino-s", filePath: normalFile, startLine: 1, endLine: null, ino: "22222" })?.content, "version B full\n");
    compStore.saveFileSnapshot({
      sessionId: "ino-legacy",
      filePath: normalFile,
      startLine: 1,
      endLine: 10,
      ino: null,
      content: "legacy no-ino\n"
    });
    assert.equal(compStore.findFileSnapshot({ sessionId: "ino-legacy", filePath: normalFile, startLine: 1, endLine: 10, ino: "33333" }), null);
    compStore.close();

    const compTranscript = path.join(tmpDir, "compacted.jsonl");
    const tBase = Date.now() - 10000;
    fs.writeFileSync(
      compTranscript,
      [
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", created_at: new Date(tBase).toISOString(), model: "claude-sonnet-4", input_tokens: 120000, cache_read_tokens: 0, output_tokens: 200 }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: new Date(tBase + 5000).toISOString(), model: "claude-sonnet-4", input_tokens: 18000, cache_read_tokens: 0, output_tokens: 200 })
      ].join("\n") + "\n",
      "utf8"
    );
    const piComp = runHookRaw(
      "hooks/pre-invocation.mjs",
      { conversationId: "comp-s", cwd: tmpDir, transcriptPath: compTranscript },
      tmpDb,
      { ...cleanEnv, AGY_DART_DISABLE_CACHE_WATCH: "1" }
    );
    assert.equal(piComp.status, 0);
    assert.equal(piComp.stdout.trim(), "{}");
    const verifyCompStore = new ContextModeStore({ dbPath: tmpDb });
    assert.equal(
      verifyCompStore.findDuplicateRead({
        sessionId: "comp-s",
        filePath: normalFile,
        mtimeMs: Number(stNorm.mtimeNs / 1000n) / 1000,
        fileSize: Number(stNorm.size),
        ctimeMs: Number(stNorm.ctimeNs / 1000n) / 1000,
        ino: String(stNorm.ino)
      }),
      null,
      "Compaction must invalidate file_reads even when cacheWatch is disabled and session is paused"
    );
    verifyCompStore.close();

    // 4. P2-3: External BEGIN EXCLUSIVE write lock fails open quickly (< 2s instead of 28s)
    const locker = new DatabaseSync(tmpDb);
    locker.exec("BEGIN EXCLUSIVE;");
    try {
      const tPre = performance.now();
      const lockedPre = runHookRaw(
        "hooks/pre-tool-use.mjs",
        { conversationId: "lock-s", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: normalFile } } },
        tmpDb,
        cleanEnv
      );
      const dtPre = performance.now() - tPre;
      assert.equal(JSON.parse(lockedPre.stdout.trim()).decision, "allow");
      assert.ok(dtPre < 2000, `Locked pre-tool-use must fail-open fast, took ${dtPre.toFixed(0)}ms`);

      const tInv = performance.now();
      const lockedInv = runHookRaw(
        "hooks/pre-invocation.mjs",
        { conversationId: "lock-s", cwd: tmpDir },
        tmpDb,
        { ...cleanEnv, AGY_DART_ENABLE_DIFF_READ: "1" }
      );
      const dtInv = performance.now() - tInv;
      assert.equal(lockedInv.stdout.trim(), "{}");
      assert.ok(dtInv < 2500, `Locked pre-invocation must fail-open fast, took ${dtInv.toFixed(0)}ms`);
    } finally {
      try { locker.exec("ROLLBACK;"); } catch {}
      locker.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Round-3 P1-6, P1-7, P2-8 & P2-9: ESM lexer bypasses, O(N) scaling, brief test-count & transcript calibrator edge cases", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r3-lex-cal-"));
  try {
    for (const name of ["a.js", "secret.js", "devtools.js"]) {
      fs.writeFileSync(path.join(tmpDir, name), "export const x = 1;\n", "utf8");
    }
    const entry = path.join(tmpDir, "main.mjs");

    // P1-6 & P2-9: All 5 valid ESM syntax classes + Unicode/escape/Node22 import forms
    const cases = [
      ['class A { #return = 10; m() { return this.#return / 2 + "a/b" + "/*"; } }\nimport "./secret.js";', ["secret.js"]],
      ['class A { #import(x) { return x; } m() { return this.#import("./devtools.js"); } }', []],
      ['import "./a.js"\n/[/*]/.test("x")\nimport "./secret.js"', ["a.js", "secret.js"]],
      ['debugger\n/[/*]/.test("x")\nimport "./secret.js"', ["secret.js"]],
      ['outer: while (true) { break outer\n/[/*]/.test("x") }\nimport "./secret.js"', ["secret.js"]],
      ['const x = { ...{ a: 1 } / 2 + "a/b" + "/*" };\nimport "./secret.js";', ["secret.js"]],
      ['function f() { return new { a: 1 } / 2 + "a/b" + "/*"; }\nimport "./secret.js";', ["secret.js"]],
      ['const C = class extends { a: Array }.a {} / 2 + "a/b" + "/*";\nimport "./secret.js";', ["secret.js"]],
      ['const C = class extends class {} {} / 2 + "a/b" + "/*";\nimport "./secret.js";', ["secret.js"]],
      ['class C extends class {} {}\n/[/*]/.test("x")\nimport "./secret.js";', ["secret.js"]],
      ['let x; for ((x) of /[/*]/.exec("a") || []) {}\nimport "./secret.js";', ["secret.js"]],
      ['for (obj.const of /[/*]/.exec("a") || []) {}\nimport "./secret.js";', ["secret.js"]],
      ['const of = 10; for (let i = 0; typeof of / 2 + "a/b" + "/*" && false; i++) {}\nimport "./secret.js";', ["secret.js"]],
      ['import(("./secret.js?v=1#hash"));', ["secret.js"]],
      ['const r = import.meta.resolve("./secret.js");', ["secret.js"]],
      ['import "./\\x73ecret.js";', ["secret.js"]],
      ['import "./\\u{00000000000073}ecret.js";', ["secret.js"]],
      ['import\u00a0"./secret.js";', ["secret.js"]],
      ['#!/usr/bin/env node\rimport "./secret.js";', ["secret.js"]],
      ['require("./secret");', ["secret.js"]]
    ];
    for (const [src, expected] of cases) {
      assert.deepEqual(extractLocalSpecifiers(src, entry, tmpDir), expected, `Lexer mismatch on: ${src}`);
    }

    assert.equal(
      countTestCasesInSource('import test from "node:test"\n/[/*]/.test("x")\ntest("1",()=>{})\ntest("2",()=>{})'),
      2
    );
    assert.equal(
      countTestCasesInSource('const fn = () => test("no"); new test("no"); test("ok1", () => {}); test.it("ok2", () => {}); test.skip?.("ok3", () => {});'),
      3
    );

    // P1-7: Strictly O(N) on pathological regex/brace/escape inputs (including slash-bracket-x & unclosed \u{)
    const t0 = performance.now();
    tokenizeJsForSpecifiers('class A { #return = 1; m() { return ' + 'this.#return / "[" + '.repeat(8000) + '0; } }');
    tokenizeJsForSpecifiers("/[".repeat(40000));
    tokenizeJsForSpecifiers("/[".repeat(16000) + "]");
    tokenizeJsForSpecifiers("/[".repeat(8000) + "]" + "[a]".repeat(8000));
    tokenizeJsForSpecifiers("/[ " + "/\\".repeat(16000) + "]");
    tokenizeJsForSpecifiers("/\\".repeat(20000));
    tokenizeJsForSpecifiers('"' + "\\u{".repeat(20000) + '"');
    tokenizeJsForSpecifiers("`" + "\\u{".repeat(20000) + "`");
    extractLocalSpecifiers("import { ".repeat(20000), entry, tmpDir);
    const tSlashBracketStart = performance.now();
    const slashBracketX = "/[/x]a" + "[/x]a".repeat(16000);
    const slashBracketTokens = tokenizeJsForSpecifiers(slashBracketX);
    const tSlashBracketMs = performance.now() - tSlashBracketStart;
    assert.equal(slashBracketTokens.length, 6 + 5 * 16000, "slash-bracket-x must tokenize every character deterministically without false regex closures");
    assert.equal(slashBracketTokens.some((t) => t.value === "regex"), false);
    assert.ok(tSlashBracketMs < 500, `slash-bracket-x at N=16000 must stay linear (< 500ms), took ${tSlashBracketMs.toFixed(1)}ms`);
    assert.ok(performance.now() - t0 < 1200, "All 10 pathological lexer stress inputs must complete in < 1.2s total");

    // Differential check 1: Full-ECMAScript-grammar token-for-token equivalence between Uint8Array failed-line bitmask
    // and exact unmemoized scanning (`disableRegexMemo: true`) including strings, templates `${...}`, keywords, braces & escapes
    const fullGrammarCurated = [
      "/[/x]a" + "[/x]a".repeat(25),
      "/[ /[ /[",
      "/[ /a/; /b/",
      "/[ ( /a/ ) /b/",
      "/[ \\/ /a/",
      "/[ /* */ /a/",
      "/[ /* \n */ /a/",
      "/[ // /a/\n/b/",
      "/a\\\n/b/",
      "/[ \\\\\n/a/",
      "/[ \\/ ( /\\\\\n/a/",
      "/[ /a\\",
      "/[/x]a\r/a/g\u2028/[\\\u2028/x/\u2029/[/x]a",
      '/[ "a/b" /c/g /d/',
      "/[ 'a/b' /c/g /d/",
      "/[ `x\ny` /a/",
      "/[ `${ /a/ }` /b/",
      "/[ `${ /[ /a/ }` /b/",
      "/[ return /a/; /b/",
      "/[ if (x) /a/ /b/",
      "/[ for (x of /a/) /b/",
      "/[ { a: 1 } / 2 /a/",
      "/[ class C {} /a/",
      "/[ function f() {} /a/",
      "/[ 'a\\\nb' /c/",
      "/[ /a/gimsuy /b/",
      "/[ ] /a/",
      "/[ \\] /a/",
      "/[ \\\\] /a/"
    ];
    let prng = 0x13579bdf;
    const nextRand = () => {
      prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
      return prng;
    };
    const fullGrammarAlphabet = [
      "/", "/", "/", "[", "]", "\\", "\\\\", "a", "x", "g", "i",
      "(", ")", "{", "}", ";", ":", "?", ",", ".", "#",
      '"', "'", "`", "${", "/*", "*/", "//",
      " ", "\t", "\n", "\r", "\r\n", "\u2028", "\u2029",
      "return ", "if", "for", "of ", "class ", "function ", "++", "--", "...", "0"
    ];
    const fullGrammarSamples = [...fullGrammarCurated];
    for (let k = 0; k < 400; k++) {
      const len = 8 + (nextRand() % 36);
      let sample = k % 2 === 0 ? "/" : "";
      for (let j = 0; j < len; j++) {
        sample += fullGrammarAlphabet[nextRand() % fullGrammarAlphabet.length];
      }
      fullGrammarSamples.push(sample);
    }
    for (const sample of fullGrammarSamples) {
      assert.deepEqual(
        tokenizeJsForSpecifiers(sample),
        tokenizeJsForSpecifiers(sample, { disableRegexMemo: true }),
        `Memoized regex bitmask diverged from full-grammar unmemoized lexer on: ${JSON.stringify(sample)}`
      );
    }

    // Differential check 2: Independent minimal unmemoized regex scanner on regex/comment/punct subset
    const tokenizeUnmemoizedRef = (src) => {
      const out = [];
      const len = src.length;
      let i = 0;
      while (i < len) {
        const ch = src[i];
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\u2028" || ch === "\u2029") {
          i++;
          continue;
        }
        if (ch === "/" && src[i + 1] === "/") {
          i += 2;
          while (i < len && src[i] !== "\n" && src[i] !== "\r" && src[i] !== "\u2028" && src[i] !== "\u2029") i++;
          continue;
        }
        if (ch === "/" && src[i + 1] === "*") {
          i += 2;
          while (i < len && !(src[i] === "*" && src[i + 1] === "/")) i++;
          i = i < len ? i + 2 : len;
          continue;
        }
        if (ch === "/") {
          const prev = out.length > 0 ? out[out.length - 1] : null;
          const canStart = !prev || (prev.type === "punct" && prev.value !== "]" && prev.value !== ")");
          if (canStart) {
            let p = i + 1;
            let inClass = false;
            let closed = false;
            while (p < len) {
              const rc = src[p];
              if (rc === "\n" || rc === "\r" || rc === "\u2028" || rc === "\u2029") break;
              if (rc === "\\") {
                if (
                  p + 1 < len &&
                  (src[p + 1] === "\n" || src[p + 1] === "\r" || src[p + 1] === "\u2028" || src[p + 1] === "\u2029")
                ) {
                  break;
                }
                p += 2;
                continue;
              }
              if (rc === "[") {
                inClass = true;
                p++;
                continue;
              }
              if (rc === "]") {
                inClass = false;
                p++;
                continue;
              }
              if (rc === "/" && !inClass) {
                closed = true;
                p++;
                while (p < len && /[a-zA-Z]/.test(src[p])) p++;
                break;
              }
              p++;
            }
            if (closed) {
              out.push({ type: "other", value: "regex" });
              i = p;
              continue;
            }
          }
          out.push({ type: "punct", value: "/" });
          i++;
          continue;
        }
        if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) {
          let p = i + 1;
          while (p < len && ((src[p] >= "a" && src[p] <= "z") || (src[p] >= "A" && src[p] <= "Z"))) p++;
          out.push({ type: "ident", value: src.slice(i, p) });
          i = p;
          continue;
        }
        out.push({ type: "punct", value: ch });
        i++;
      }
      return out;
    };
    const projectToks = (toks) => toks.map((t) => `${t.type}:${t.value}`);
    const subsetAlphabet = ["/", "/", "[", "]", "\\", "a", "x", "(", ")", ";", " ", "\n", "\r", "\u2028", "\u2029", "/*", "*/", "//"];
    for (let k = 0; k < 200; k++) {
      const len = 8 + (nextRand() % 41);
      let sample = "/";
      for (let j = 0; j < len; j++) {
        sample += subsetAlphabet[nextRand() % subsetAlphabet.length];
      }
      assert.deepEqual(
        projectToks(tokenizeJsForSpecifiers(sample)),
        projectToks(tokenizeUnmemoizedRef(sample)),
        `Memoized regex scanner diverged from independent unmemoized reference on: ${JSON.stringify(sample)}`
      );
    }
    assert.deepEqual(extractLocalSpecifiers('/[ ( /a/ )\nimport "./secret.js";', entry, tmpDir), ["secret.js"]);
    assert.deepEqual(extractLocalSpecifiers('/[/x]a[/x]a\nimport "./secret.js";', entry, tmpDir), ["secret.js"]);
    assert.deepEqual(extractLocalSpecifiers('/[ `x\ny` /a/\nimport "./secret.js";', entry, tmpDir), ["secret.js"]);

    // P2-8: Calibrator empty arrays, uppercase SUBAGENT, truncated_fields, preserved prevModel, Claude direct usage & file reader
    const calRep = extractTranscriptCalibrationReport([
      { step_index: 1, type: "PLANNER_RESPONSE", model: "model-a", input_tokens: 10000, cache_read_tokens: 0, output_tokens: 100, media: [], images: [], injectSteps: [] },
      { step_index: 2, type: "TOOL_OUTPUT", content: "Clean step with empty media array ".repeat(10), media: [], images: [] },
      { step_index: 3, type: "PLANNER_RESPONSE", input_tokens: 300, cache_read_tokens: 10000, output_tokens: 100 },
      { step_index: 4, type: "TOOL_OUTPUT", content: "Turn across omitted model field ".repeat(10) },
      { step_index: 5, type: "PLANNER_RESPONSE", model: "model-b", input_tokens: 400, cache_read_tokens: 10400, output_tokens: 100 },
      { step_index: 6, type: "TOOL_OUTPUT", content: "Truncated payload ".repeat(10), truncated_fields: ["content"] },
      { step_index: 7, type: "PLANNER_RESPONSE", model: "model-b", input_tokens: 20000, cache_read_tokens: 10900, output_tokens: 100 },
      { step_index: 8, type: "TOOL_OUTPUT", source: "SUBAGENT", content: "Uppercase subagent text ".repeat(10) },
      { step_index: 9, type: "PLANNER_RESPONSE", model: "model-b", input_tokens: 500, cache_read_tokens: 31000, output_tokens: 100 }
    ]);
    assert.equal(calRep.samples.length, 1);
    assert.equal(calRep.skippedByReason.model_switch, 1);
    assert.equal(calRep.skippedByReason.truncated_content, 1);
    assert.equal(calRep.skippedByReason.subagent_interleaved, 1);

    const directClaudeRep = extractTranscriptCalibrationReport([
      { text: "short", usage: { input_tokens: 5 } },
      { text: "Claude prompt with cached prefix tokens ".repeat(10), usage: { input_tokens: 120, cache_read_input_tokens: 280 } }
    ]);
    assert.equal(directClaudeRep.samples.length, 1);
    assert.equal(directClaudeRep.samples[0].actualTokens, 400);

    const trFile = path.join(tmpDir, "cal.jsonl");
    fs.writeFileSync(
      trFile,
      [
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 5000, cache_read_tokens: 0, output_tokens: 100 }),
        JSON.stringify({ step_index: 2, type: "TOOL_OUTPUT", content: "export function verifyCalibration(x) { return x * 2; }\n".repeat(12) }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", input_tokens: 260, cache_read_tokens: 5000, output_tokens: 50 })
      ].join("\n") + "\n",
      "utf8"
    );
    const fileCal = calibrateFromTranscript(trFile);
    assert.equal(fileCal.source, "transcript");
    assert.equal(fileCal.sampleCount, 1);

    // P2-8: readBoundedTranscriptSteps preserves multi-byte UTF-8 characters split across 256 KB chunk boundaries
    const boundaryTr = path.join(tmpDir, "utf8-boundary.jsonl");
    const bStep1 = JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } }) + "\n";
    const bStep2Head = '{"step_index":2,"type":"USER_INPUT","content":"';
    const bPad = 262143 - Buffer.byteLength(bStep1, "utf8") - Buffer.byteLength(bStep2Head, "utf8");
    const cjkSuffix = "测试边界字符".repeat(10);
    const bContent = "a".repeat(bPad) + cjkSuffix;
    const bStep2 = `${bStep2Head}${bContent}"}\n`;
    const bStep3 = JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", usageMetadata: { promptTokenCount: 70000, candidatesTokenCount: 50 } }) + "\n";
    fs.writeFileSync(boundaryTr, bStep1 + bStep2 + bStep3, "utf8");
    const boundaryCal = calibrateFromTranscript(boundaryTr);
    assert.equal(boundaryCal.source, "transcript");
    assert.equal(boundaryCal.samples[0].estimatedTokens, estimateTokens(bContent), "UTF-8 char split across 256 KB chunk boundary must decode without U+FFFD corruption");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
