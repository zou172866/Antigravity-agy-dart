import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as nodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  buildRepoHotspots,
  collectSourceFiles,
  getCachedRepoHotspots
} from "../context/lib/repo-skeleton.js";
import { auditPrefixBudget, estimateTokens } from "../scripts/prefix-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function writeFileDeep(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function listFilesRecursive(root, cur = root, out = []) {
  if (!fs.existsSync(cur)) return out;
  for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
    const full = path.join(cur, entry.name);
    if (entry.isDirectory()) listFilesRecursive(root, full, out);
    else out.push({ rel: path.relative(root, full), size: fs.statSync(full).size });
  }
  return out;
}

function runMcpHandshake(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...extraEnv }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP handshake timed out: ${scriptPath}\nstderr=${stderr}`));
    }, 8000);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const rawLines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let responses = [];
      try {
        responses = rawLines.map((l) => JSON.parse(l));
      } catch (err) {
        return reject(new Error(`Corrupted JSON-RPC stdout from ${scriptPath}: ${err.message}\nstdout=${stdout}\nstderr=${stderr}`));
      }
      resolve({ code, rawLines, responses, stderr });
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "v1.2-quickfixes-test", version: "1.0" }
        }
      }) + "\n"
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });
}

test("Fix 1: ctx_execute and ctx_batch enable SHA-256 FTS5 deduplication while staying <= 8.8 KB", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-dedup-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });
  const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "v12-dedup-sess" });

  try {
    // 1. ctx_execute: identical stdout twice reuses the same sourceId without duplicating sources/chunks
    const execScript = 'console.log("重复日志条目_ALPHA_999\\n".repeat(400));';
    const ex1 = await tools.ctx_execute({
      language: "nodejs",
      code: execScript,
      intent: "first run"
    });
    assert.equal(ex1.ok, true);
    assert.ok(ex1.sourceId);
    assert.equal(ex1.deduplicated, false);
    assert.ok(Buffer.byteLength(JSON.stringify(ex1, null, 2), "utf8") <= 8800);

    const sourcesAfterEx1 = store.db.prepare("SELECT count(*) AS cnt FROM sources").get().cnt;
    const chunksAfterEx1 = store.db.prepare("SELECT count(*) AS cnt FROM chunks").get().cnt;
    assert.equal(sourcesAfterEx1, 1);
    assert.ok(chunksAfterEx1 >= 1);

    const ex2 = await tools.ctx_execute({
      language: "nodejs",
      code: execScript,
      intent: "second run identical output"
    });
    assert.equal(ex2.ok, true);
    assert.equal(ex2.sourceId, ex1.sourceId, "Identical ctx_execute output must reuse existing sourceId");
    assert.equal(ex2.deduplicated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(ex2, null, 2), "utf8") <= 8800);
    assert.equal(store.db.prepare("SELECT count(*) AS cnt FROM sources").get().cnt, sourcesAfterEx1);
    assert.equal(store.db.prepare("SELECT count(*) AS cnt FROM chunks").get().cnt, chunksAfterEx1);

    // Modified output creates a brand-new source
    const ex3 = await tools.ctx_execute({
      language: "nodejs",
      code: 'console.log("不同输出_BETA_777\\n".repeat(400));',
      intent: "third run changed output"
    });
    assert.equal(ex3.deduplicated, false);
    assert.notEqual(ex3.sourceId, ex1.sourceId);

    // Empty output produces sourceId: null, deduplicated: false
    const exEmpty = await tools.ctx_execute({
      language: "nodejs",
      code: "/* silent */",
      intent: "silent"
    });
    assert.equal(exEmpty.sourceId, null);
    assert.equal(exEmpty.deduplicated, false);

    // 2. ctx_batch: identical commands output twice reuses sourceId and avoids duplicate chunks
    const batchCmd = 'node -e "process.stdout.write(\'批量输出条目_GAMMA_555\\n\'.repeat(350))"';
    const b1 = await tools.ctx_batch({
      commands: [batchCmd],
      queries: ["GAMMA_555"]
    });
    assert.ok(b1.sourceId);
    assert.equal(b1.deduplicated, false);
    assert.ok(b1.content.includes("GAMMA_555"));
    assert.ok(Buffer.byteLength(JSON.stringify(b1, null, 2), "utf8") <= 8800);

    const sourcesAfterB1 = store.db.prepare("SELECT count(*) AS cnt FROM sources").get().cnt;
    const chunksAfterB1 = store.db.prepare("SELECT count(*) AS cnt FROM chunks").get().cnt;

    const b2 = await tools.ctx_batch({
      commands: [batchCmd],
      queries: ["GAMMA_555"]
    });
    assert.equal(b2.sourceId, b1.sourceId, "Identical ctx_batch output must reuse existing sourceId");
    assert.equal(b2.deduplicated, true);
    assert.ok(b2.content.includes("GAMMA_555"));
    assert.ok(Buffer.byteLength(JSON.stringify(b2, null, 2), "utf8") <= 8800);
    assert.equal(store.db.prepare("SELECT count(*) AS cnt FROM sources").get().cnt, sourcesAfterB1);
    assert.equal(store.db.prepare("SELECT count(*) AS cnt FROM chunks").get().cnt, chunksAfterB1);

    // Changed batch output gets a new sourceId
    const b3 = await tools.ctx_batch({
      commands: ['node -e "console.log(\'DELTA_888\')"']
    });
    assert.equal(b3.deduplicated, false);
    assert.notEqual(b3.sourceId, b1.sourceId);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Fix 2: fast/mcp-server.mjs and context/server.js activate versioned V8 compile cache silently without corrupting JSON-RPC", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-mcpcc-"));
  const fastCcDir = path.join(tmpDir, "fast-cc");
  const ctxCcDir = path.join(tmpDir, "ctx-cc");
  const disabledCcDir = path.join(tmpDir, "disabled-cc");
  const tmpDb = path.join(tmpDir, "context.db");
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const supportsCompileCache = typeof nodeModule.enableCompileCache === "function";

  try {
    // 1. Compile cache ENABLED on both MCP servers -> clean JSON-RPC, zero stderr, versioned dir created
    const fastOn = await runMcpHandshake(path.join(ROOT, "fast", "mcp-server.mjs"), {
      AGY_DART_COMPILE_CACHE_DIR: fastCcDir,
      AGY_DART_DISABLE_COMPILE_CACHE: ""
    });
    assert.equal(fastOn.code, 0);
    assert.equal(fastOn.stderr, "", "fast/mcp-server.mjs must never write to stderr during compile-cache startup");
    assert.equal(fastOn.responses.length, 2);
    assert.deepEqual(
      fastOn.responses[1].result.tools.map((t) => t.name),
      ["apply_edits", "batch_search", "read_slices", "run_checks"]
    );

    const ctxOn = await runMcpHandshake(path.join(ROOT, "context", "server.js"), {
      AGY_DART_DB_PATH: tmpDb,
      AGY_DART_COMPILE_CACHE_DIR: ctxCcDir,
      AGY_DART_DISABLE_COMPILE_CACHE: ""
    });
    assert.equal(ctxOn.code, 0);
    assert.equal(ctxOn.stderr, "", "context/server.js must never write to stderr during compile-cache startup");
    assert.equal(ctxOn.responses.length, 2);
    assert.equal(ctxOn.responses[1].result.tools.length, 8);

    if (supportsCompileCache) {
      assert.ok(
        fs.existsSync(path.join(fastCcDir, pkgVersion)),
        "fast/mcp-server.mjs should create versioned compile-cache dir"
      );
      assert.ok(
        fs.existsSync(path.join(ctxCcDir, pkgVersion)),
        "context/server.js should create versioned compile-cache dir"
      );
      const ctxCacheFiles = listFilesRecursive(ctxCcDir);
      assert.ok(
        ctxCacheFiles.some((f) => f.size > 0),
        `context/server.js should persist non-empty V8 bytecode files, got: ${JSON.stringify(ctxCacheFiles)}`
      );
    }

    // 2. Compile cache DISABLED via AGY_DART_DISABLE_COMPILE_CACHE=1 -> cache dir MUST NOT be created
    const fastOff = await runMcpHandshake(path.join(ROOT, "fast", "mcp-server.mjs"), {
      AGY_DART_COMPILE_CACHE_DIR: disabledCcDir,
      AGY_DART_DISABLE_COMPILE_CACHE: "1"
    });
    const ctxOff = await runMcpHandshake(path.join(ROOT, "context", "server.js"), {
      AGY_DART_DB_PATH: tmpDb,
      AGY_DART_COMPILE_CACHE_DIR: disabledCcDir,
      AGY_DART_DISABLE_COMPILE_CACHE: "1"
    });
    assert.equal(fastOff.code, 0);
    assert.equal(ctxOff.code, 0);
    assert.equal(fastOff.stderr, "");
    assert.equal(ctxOff.stderr, "");
    assert.equal(fastOff.rawLines[1], fastOn.rawLines[1], "tools/list must be byte-identical with/without compile cache");
    assert.equal(ctxOff.rawLines[1], ctxOn.rawLines[1], "tools/list must be byte-identical with/without compile cache");
    assert.equal(fs.existsSync(disabledCcDir), false, "AGY_DART_DISABLE_COMPILE_CACHE=1 must skip creating cache dir");

    // 3. scripts/prefix-budget.mjs --json remains deterministic with compile cache active
    const runBudget = () => {
      const res = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--json"], {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          AGY_DART_COMPILE_CACHE_DIR: ctxCcDir,
          AGY_DART_DISABLE_COMPILE_CACHE: ""
        }
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stderr, "");
      return JSON.parse(res.stdout);
    };
    const b1 = runBudget();
    const b2 = runBudget();
    assert.equal(b1.toolsFingerprint, b2.toolsFingerprint);
    assert.equal(b1.blocks.tools.canonical, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Fix 3A: repo-skeleton resolves Go internal packages via go.mod (single, grouped, aliased, monorepo) without comment/prefix false matches", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-go-"));
  try {
    writeFileDeep(
      path.join(tmpDir, "go.mod"),
      `module github.com/acme/ordersvc // core service\n\ngo 1.22\n`
    );
    writeFileDeep(
      path.join(tmpDir, "internal/config/config.go"),
      `package config\n\ntype Config struct { Port int }\n`
    );
    writeFileDeep(
      path.join(tmpDir, "internal/store/store.go"),
      `package store\n\nimport "github.com/acme/ordersvc/internal/config"\n\ntype Store struct { Cfg config.Config }\n`
    );
    writeFileDeep(
      path.join(tmpDir, "internal/store/queries.go"),
      `package store\n\nfunc Query() {}\n`
    );
    writeFileDeep(
      path.join(tmpDir, "internal/store/store_test.go"),
      `package store_test\n\nimport (\n  "testing"\n  _ "github.com/acme/ordersvc/internal/store"\n)\nfunc TestStore(t *testing.T) {}\n`
    );
    writeFileDeep(
      path.join(tmpDir, "internal/handler/order.go"),
      `package handler\n\nimport (\n  "fmt"\n  "net/http"\n  // "github.com/acme/ordersvc/internal/ignored"\n  /* "github.com/acme/ordersvc/internal/ignored2" */\n  cfg "github.com/acme/ordersvc/internal/config"\n  "github.com/acme/ordersvc/internal/store"\n  "github.com/acme/ordersvc2/internal/store"\n)\n\nfunc Handle() { _ = fmt.Sprint(http.StatusOK, cfg.Config{}, store.Store{}) }\n`
    );
    writeFileDeep(
      path.join(tmpDir, "cmd/api/main.go"),
      `package main\n\nimport (\n  . "github.com/acme/ordersvc/internal/config"\n  "github.com/acme/ordersvc/internal/handler"\n  "github.com/acme/ordersvc/internal/store"\n)\n\nconst tpl = \`\nimport "github.com/acme/ordersvc/internal/ignored"\n\`\n\nfunc main() { _ = Config{}; _ = tpl; handler.Handle(); _ = store.Store{} }\n`
    );
    writeFileDeep(
      path.join(tmpDir, "internal/ignored/ignored.go"),
      `package ignored\n`
    );

    const res = buildRepoHotspots(tmpDir);
    assert.ok(res.fileCount >= 7);
    const byPath = new Map(res.hubs.map((h) => [h.path, h.refs]));
    assert.equal(byPath.get("internal/config/config.go"), 3, "config imported by store, handler, main");
    assert.equal(byPath.get("internal/store/store.go"), 3, "store imported by store_test, handler, main");
    assert.equal(byPath.get("internal/handler/order.go"), 1, "handler imported by main");
    assert.equal(byPath.has("internal/ignored/ignored.go"), false, "commented Go imports must be ignored");
    assert.equal(byPath.has("internal/store/queries.go"), false, "package hub should pick store.go without flooding hubs");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Fix 3B: repo-skeleton supports .vue, .svelte, .dart, .java and tsconfig/jsconfig compilerOptions.paths (JSONC safe)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-langs-"));
  try {
    // 1. Vue + Svelte + TS with JSONC tsconfig.json containing "@/*" and "~/*"
    const webDir = path.join(tmpDir, "web");
    writeFileDeep(
      path.join(webDir, "tsconfig.json"),
      `{
        // Root TS config with comments and trailing commas
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            /* preserve @/* inside string! */
            "@/*": ["src/*"],
            "~/*": ["lib/*"],
            "@config": ["src/config.ts"],
          },
        },
      }`
    );
    writeFileDeep(path.join(webDir, "src/core/store.ts"), `export const store = {};\n`);
    writeFileDeep(path.join(webDir, "src/config.ts"), `export const API_URL = "https://example.com";\n`);
    writeFileDeep(path.join(webDir, "lib/format.ts"), `export const fmt = (v: string) => v;\n`);
    writeFileDeep(
      path.join(webDir, "src/components/Card.vue"),
      `<template>\n  <div>from './not-real.ts'</div>\n</template>\n<script setup lang="ts">\nimport { store } from '@/core/store'\nimport { fmt } from '~/format'\nimport { API_URL } from '@config'\n</script>\n`
    );
    writeFileDeep(
      path.join(webDir, "src/components/Panel.svelte"),
      `<script lang="ts">\nimport { store } from "@/core/store";\nimport Card from "./Card.vue";\n</script>\n<main>from './fake.ts'</main>\n`
    );
    writeFileDeep(
      path.join(webDir, "src/main.ts"),
      `import { store } from "@/core/store";\nimport Panel from "@/components/Panel.svelte";\nconsole.log(store, Panel);\n`
    );

    const webHubs = buildRepoHotspots(webDir);
    const webMap = new Map(webHubs.hubs.map((h) => [h.path, h.refs]));
    assert.equal(webMap.get("src/core/store.ts"), 3, "store.ts imported via @/* from .vue, .svelte, and .ts");
    assert.equal(webMap.get("lib/format.ts"), 1, "format.ts imported via ~/* from .vue");
    assert.equal(webMap.get("src/config.ts"), 1, "config.ts imported via exact @config alias");
    assert.equal(webMap.get("src/components/Card.vue"), 1, "Card.vue imported relatively from Panel.svelte");
    assert.equal(webMap.get("src/components/Panel.svelte"), 1, "Panel.svelte imported via @/* from main.ts");

    // 2. Dart / Flutter workspace with pubspec.yaml package: imports & relative imports
    const dartDir = path.join(tmpDir, "dart-app");
    writeFileDeep(path.join(dartDir, "pubspec.yaml"), "name: sample_flutter\nversion: 1.0.0\n");
    writeFileDeep(path.join(dartDir, "lib/core/store.dart"), "class Store {}\n");
    writeFileDeep(
      path.join(dartDir, "lib/models/user.dart"),
      "import 'dart:async';\nimport 'package:flutter/material.dart';\nimport '../core/store.dart';\nclass User {}\n"
    );
    writeFileDeep(
      path.join(dartDir, "lib/pages/home.dart"),
      "import 'package:sample_flutter/core/store.dart';\nimport 'package:sample_flutter/models/user.dart';\n"
    );
    writeFileDeep(
      path.join(dartDir, "lib/main.dart"),
      "import 'core/store.dart';\nimport 'pages/home.dart';\nvoid main() {}\n"
    );
    const dartHubs = buildRepoHotspots(dartDir);
    const dartMap = new Map(dartHubs.hubs.map((h) => [h.path, h.refs]));
    assert.equal(dartMap.get("lib/core/store.dart"), 3, "store.dart imported via relative & package:sample_flutter/");
    assert.equal(dartMap.get("lib/models/user.dart"), 1);
    assert.equal(dartMap.get("lib/pages/home.dart"), 1);

    // 3. Java Maven layout (deep path depth 6+) with regular, static, and wildcard imports
    const javaDir = path.join(tmpDir, "java-app");
    writeFileDeep(
      path.join(javaDir, "src/main/java/com/acme/app/core/Store.java"),
      "package com.acme.app.core;\npublic class Store {}\n"
    );
    writeFileDeep(
      path.join(javaDir, "src/main/java/com/acme/app/util/HashUtil.java"),
      "package com.acme.app.util;\npublic class HashUtil { public static String sha(String s) { return s; } }\n"
    );
    writeFileDeep(
      path.join(javaDir, "src/main/java/com/acme/app/service/UserService.java"),
      `package com.acme.app.service;
import java.util.List;
// import com.acme.app.core.Fake;
import com.acme.app.core.Store;
import static com.acme.app.util.HashUtil.sha;
public class UserService {}
`
    );
    writeFileDeep(
      path.join(javaDir, "src/main/java/com/acme/app/api/ApiController.java"),
      `package com.acme.app.api;
import com.acme.app.core.*;
import com.acme.app.service.UserService;
public class ApiController {
  String doc = """
import com.acme.app.util.HashUtil;
""";
}
`
    );
    const javaHubs = buildRepoHotspots(javaDir);
    const javaMap = new Map(javaHubs.hubs.map((h) => [h.path, h.refs]));
    assert.equal(javaMap.get("src/main/java/com/acme/app/core/Store.java"), 2, "Store imported directly + via wildcard");
    assert.equal(javaMap.get("src/main/java/com/acme/app/util/HashUtil.java"), 1, "HashUtil imported via import static");
    assert.equal(javaMap.get("src/main/java/com/acme/app/service/UserService.java"), 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Fix 3C: repo-skeleton priority BFS prioritizes core source roots over huge sibling/docs/examples folders and stays strictly deterministic", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-bfs-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // Seed 140 files each in alphabetically-first sibling folders (a_misc, docs, examples)
    // that would completely exhaust maxFiles=120 under alphabetical DFS
    for (let i = 0; i < 140; i++) {
      const id = String(i).padStart(3, "0");
      writeFileDeep(path.join(tmpDir, `a_misc/m_${id}.js`), `export const m = ${i};\n`);
      writeFileDeep(path.join(tmpDir, `docs/d_${id}.js`), `export const d = ${i};\n`);
      writeFileDeep(path.join(tmpDir, `examples/e_${id}.js`), `export const e = ${i};\n`);
    }

    // Core monorepo source files under src/ and packages/
    writeFileDeep(
      path.join(tmpDir, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } })
    );
    writeFileDeep(path.join(tmpDir, "src/core/engine.js"), `export function runEngine() { return 1; }\n`);
    writeFileDeep(path.join(tmpDir, "src/api/routes.js"), `import { runEngine } from "@/core/engine";\nexport default runEngine;\n`);
    writeFileDeep(path.join(tmpDir, "src/api/auth.js"), `import { runEngine } from "../core/engine.js";\nexport const ok = runEngine;\n`);
    writeFileDeep(path.join(tmpDir, "packages/web/src/index.js"), `import { runEngine } from "@/core/engine";\nconsole.log(runEngine);\n`);
    writeFileDeep(path.join(tmpDir, "packages/cli/src/main.js"), `import { runEngine } from "@/core/engine";\nconsole.log(runEngine);\n`);

    const collected = collectSourceFiles(tmpDir, 120, 8).map((p) => path.relative(tmpDir, p).replace(/\\/g, "/"));
    assert.equal(collected.length, 120);
    // Priority roots (src, packages) MUST appear at the very front before a_misc/docs/examples
    const firstFive = collected.slice(0, 5);
    assert.ok(firstFive.every((p) => p.startsWith("src/") || p.startsWith("packages/")), `Expected core roots first, got: ${firstFive.join(", ")}`);
    assert.ok(collected.includes("src/core/engine.js"));
    assert.ok(collected.includes("packages/web/src/index.js"));
    assert.ok(collected.includes("packages/cli/src/main.js"));

    const h1 = buildRepoHotspots(tmpDir, { maxFiles: 120 });
    const h2 = buildRepoHotspots(tmpDir, { maxFiles: 120 });
    assert.equal(h1.hubs[0]?.path, "src/core/engine.js");
    assert.equal(h1.hubs[0]?.refs, 4);
    assert.equal(h1.summary, h2.summary, "Core hubs summary must be strictly deterministic");

    const store = new ContextModeStore({ dbPath: tmpDb });
    const cached1 = getCachedRepoHotspots(tmpDir, store, { headSha: "abc1234" });
    const cached2 = getCachedRepoHotspots(tmpDir, store, { headSha: "abc1234" });
    assert.equal(cached1, h1.summary);
    assert.equal(cached2, h1.summary);
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Fix 4: prefix-budget.mjs estimateTokens is CJK/UTF-8 aware with numeric fallback and preserves JSON contract", async () => {
  // 1. Pure ASCII matches chars/4 exactly
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a".repeat(400)), 100);
  assert.equal(estimateTokens("hello"), 2);

  // 2. Pure CJK (~1.0-1.5 tok/char, NOT naive chars/4)
  const cjk400 = "中文测试".repeat(100); // 400 CJK chars
  const cjkTok = estimateTokens(cjk400);
  assert.ok(cjkTok >= 400 && cjkTok <= 600, `Expected 400 CJK chars in [400, 600] tok, got ${cjkTok}`);
  assert.equal(cjkTok, 500);

  // Japanese Kana/Kanji & Korean Hangul & CJK Ext-B (surrogate pair)
  const jpKo = "テスト漢字한글"; // 7 CJK/Kana/Hangul chars
  assert.ok(estimateTokens(jpKo) >= 7 && estimateTokens(jpKo) <= 11);
  const astralCjk = "𠀀𠀁𠀂𠀃"; // 4 astral CJK code points (8 UTF-16 code units!)
  assert.equal(estimateTokens(astralCjk), 5, "Astral CJK must count code points (4 * 1.25 = 5), not UTF-16 units");

  // Mixed ASCII + CJK, Cyrillic, Emoji
  assert.equal(estimateTokens("Hello 世界"), 4); // 6*0.25 + 2*1.25 = 4.0
  assert.equal(estimateTokens("Привет"), 6); // 6*1.0 = 6
  assert.equal(estimateTokens("🚀🔥"), 3); // 2*1.5 = 3

  // 3. Numeric fallback & nullish/invalid safety
  assert.equal(estimateTokens(400), 100);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-50), 0);
  assert.equal(estimateTokens(Number.NaN), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);

  // 4. End-to-end auditPrefixBudget on current repo preserves JSON contract & TOKEN_WARN_LIMIT = 4000
  const repoReport = await auditPrefixBudget(ROOT);
  assert.equal(repoReport.budgetLimitTokens, 4000);
  assert.equal(repoReport.exceedsBudget, false);
  assert.equal(repoReport.warning, null);
  assert.equal(repoReport.blocks.tools.canonical, true);
  assert.equal(typeof repoReport.blocks.brake.tokens, "number");
  assert.equal(typeof repoReport.blocks.reference.frontmatterTokens, "number");
  assert.equal(typeof repoReport.blocks.startup.tokens, "number");
  assert.equal(
    repoReport.totalTokens,
    repoReport.blocks.brake.tokens +
      repoReport.blocks.reference.frontmatterTokens +
      repoReport.blocks.tools.tokens +
      repoReport.blocks.startup.tokens
  );

  // 5. End-to-end auditPrefixBudget detects a bloated CJK rules/AGENTS.md that naive chars/4 would undercount!
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-cjkbudget-"));
  try {
    // Copy minimal plugin runtime into isolated tmpRoot so auditPrefixBudget runs cleanly on CJK rules/AGENTS.md
    for (const rel of [
      "package.json",
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
      "context/lib/watchdog-lease-core.js",
      "context/lib/watchdog-transcript.js",
      "context/lib/watchdog-summaries.js",
      "context/lib/watchdog-lease.js",
      "context/lib/executor.js",
      "context/lib/tools.js",
      "context/lib/repo-skeleton.js",
      "context/lib/stable-json.js",
      "context/lib/security.js",
      "hooks/compile-cache.mjs",
      "hooks/session-start.mjs"
    ]) {
      const src = path.join(ROOT, rel);
      const dst = path.join(tmpRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    // 2500 CJK chars: naive chars/4 would estimate only 625 tok (total ~2600 <= 4000),
    // while CJK-aware estimation counts 3125 tok (total ~5100 > 4000 -> exceedsBudget = true!)
    writeFileDeep(
      path.join(tmpRoot, "rules/AGENTS.md"),
      "# 中文规则\n" + "规则说明内容测试字符".repeat(250) + "\n"
    );

    const cjkReport = await auditPrefixBudget(tmpRoot);
    assert.ok(
      cjkReport.blocks.brake.tokens >= 3000,
      `Expected CJK rules/AGENTS.md >= 3000 est. tokens, got ${cjkReport.blocks.brake.tokens}`
    );
    assert.equal(cjkReport.exceedsBudget, true, "Bloated CJK AGENTS.md must trigger exceedsBudget > 4000");
    assert.ok(cjkReport.warning && cjkReport.warning.includes("4000"));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
