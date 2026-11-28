import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  analyzeTranscriptCache,
  doesPassResolveFailure,
  extractCheckIdentity,
  extractCompoundPassIdentities,
  isAdhocInspectionRunCheckBlock,
  stripCheckDurationSuffix
} from "../context/lib/cache-analyzer.js";
import {
  extractCheckIdentity as checkpointExtractCheckIdentity,
  extractCompoundPassIdentities as checkpointExtractCompoundPassIdentities,
  stripCheckDurationSuffix as checkpointStripCheckDurationSuffix
} from "../context/lib/store/checkpoints.js";
import { ContextModeStore } from "../context/lib/store.js";
import { recordHookLeaseTransition } from "../context/lib/watchdog.js";
import { extractVerificationSignal } from "../hooks/post-tool-use.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const T0_MS = Date.parse("2026-11-28T10:00:00.000Z");
const iso = (offsetSec) => new Date(T0_MS + offsetSec * 1000).toISOString();

function plannerTurn(stepIndex, offsetSec, toolCalls) {
  return {
    type: "PLANNER_RESPONSE",
    step_index: stepIndex,
    created_at: iso(offsetSec),
    model: "claude-sonnet-4-6",
    input_tokens: 2500,
    cache_read_tokens: 42000,
    output_tokens: 200,
    tool_calls: toolCalls
  };
}

function toolResult(stepIndex, callId, content, extra = {}) {
  return {
    type: "TOOL_RESULT",
    step_index: stepIndex,
    tool_call_id: callId,
    content,
    ...extra
  };
}

function createSidecarBindingVm(
  html,
  {
    nativeConvId = "",
    locationSearch = "",
    hasSidecar = true,
    workspaceUris = [],
    apiHandler = null
  } = {}
) {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "index.html must contain main inline <script>");

  const elements = new Map();
  const makeClassList = (el) => ({
    add: (...cls) => {
      const cur = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const c of cls) if (c) cur.add(c);
      el.className = Array.from(cur).join(" ");
    },
    remove: (...cls) => {
      const cur = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const c of cls) cur.delete(c);
      el.className = Array.from(cur).join(" ");
    },
    contains: (c) => String(el.className || "").split(/\s+/).includes(c)
  });

  const getEl = (id) => {
    if (!elements.has(id)) {
      const el = {
        id,
        className: "",
        innerText: "",
        textContent: "",
        innerHTML: "",
        title: "",
        value: "",
        disabled: false,
        style: {},
        dataset: {},
        attributes: {},
        listeners: {},
        setAttribute(k, v) {
          this.attributes[k] = String(v);
        },
        getAttribute(k) {
          return this.attributes[k] ?? null;
        },
        addEventListener(ev, fn) {
          this.listeners[ev] = fn;
        },
        scrollIntoView() {}
      };
      el.classList = makeClassList(el);
      elements.set(id, el);
    }
    return elements.get(id);
  };

  let currentNativeConvId = nativeConvId;
  let wsListener = null;
  let currentWorkspaceUris = [...workspaceUris];
  const sidecarHost = hasSidecar
    ? {
        get conversationId() {
          return currentNativeConvId;
        },
        set conversationId(v) {
          currentNativeConvId = v;
        },
        async getWorkspaceUris() {
          return [...currentWorkspaceUris];
        },
        onWorkspaceChange(fn) {
          wsListener = fn;
          return () => {
            if (wsListener === fn) wsListener = null;
          };
        },
        async api(route, payload) {
          if (typeof apiHandler === "function") return apiHandler(route, payload);
          return { ok: true };
        }
      }
    : undefined;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    Error,
    Promise,
    Headers,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); }
    },
    sessionStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); }
    },
    navigator: { language: "zh-CN", clipboard: { async writeText() {} } },
    document: {
      title: "",
      documentElement: { lang: "zh" },
      hidden: false,
      hasFocus: () => true,
      body: { appendChild() {}, removeChild() {} },
      getElementById: (id) => getEl(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ value: "", style: {}, setAttribute() {}, focus() {}, select() {} }),
      execCommand: () => false,
      addEventListener() {}
    },
    fetch: async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const data = typeof apiHandler === "function" ? await apiHandler(url, body) : { ok: true };
      return { ok: true, status: 200, async json() { return data; } };
    }
  };
  sandbox.window = {
    location: { search: locationSearch, origin: "http://127.0.0.1:0" },
    ...(sidecarHost ? { sidecar: sidecarHost } : {}),
    addEventListener() {}
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const runnableScript = scriptMatch[1]
    .replace(/window\.addEventListener\('DOMContentLoaded'[\s\S]*$/m, "")
    .replace(/\brefreshData\s*\(\s*\)\s*;/g, "");
  vm.runInContext(runnableScript, ctx);

  return {
    ctx,
    getEl,
    sidecarHost,
    triggerWorkspaceChange(nextUris) {
      currentWorkspaceUris = [...nextUris];
      if (typeof wsListener === "function") {
        wsListener([...nextUris]);
      }
    }
  };
}

test("v1.10.4-1: Strip outputMode=full duration suffixes across cache-analyzer, post-tool-use, checkpoints, and UI", () => {
  assert.equal(stripCheckDurationSuffix("inspect-new-commits-and-versions (136ms)"), "inspect-new-commits-and-versions");
  assert.equal(stripCheckDurationSuffix("verify-suite (1.25s)"), "verify-suite");
  assert.equal(stripCheckDurationSuffix("my-check (v2)"), "my-check (v2)");
  assert.equal(checkpointStripCheckDurationSuffix("custom-gate (42ms)"), "custom-gate");

  const id1 = extractCheckIdentity("check", "custom-gate (136ms)", "node scripts/custom-gate.mjs");
  const id2 = extractCheckIdentity("check", "custom-gate (84ms)", "node scripts/custom-gate.mjs");
  assert.equal(id1.checkKey, id2.checkKey);
  assert.equal(doesPassResolveFailure(id2, id1), true);
  assert.equal(
    checkpointExtractCheckIdentity("check", "custom-gate (136ms)", "node scripts/custom-gate.mjs").checkKey,
    id1.checkKey
  );

  // outputMode=full FAIL (136ms) followed by outputMode=full PASS (84ms) resolves cleanly in transcript
  const steps = [
    plannerTurn(1, 0, [
      { id: "rc1", name: "mcp_agy-dart_fast_run_checks", args: { outputMode: "full", commands: [{ name: "custom-gate", command: "node scripts/verify-custom.mjs" }] } }
    ]),
    toolResult(
      2,
      "rc1",
      "Checks: 0/1 passed, 1 failed (wall: 140ms)\n\n## [FAIL (exit 1)] custom-gate (136ms)\n$ node scripts/verify-custom.mjs\nError: mismatch"
    ),
    plannerTurn(3, 10, [
      { id: "rc2", name: "mcp_agy-dart_fast_run_checks", args: { outputMode: "full", commands: [{ name: "custom-gate", command: "node scripts/verify-custom.mjs" }] } }
    ]),
    toolResult(
      4,
      "rc2",
      "Checks: 1/1 passed (wall: 88ms)\n\n## [PASS] custom-gate (84ms)\n$ node scripts/verify-custom.mjs\nall ok"
    )
  ];
  const diagFail = analyzeTranscriptCache(steps.slice(0, 2), { nowMs: T0_MS + 5000 });
  assert.equal(diagFail.checkStatus.unresolvedFailures.length, 1);
  assert.equal(diagFail.checkStatus.unresolvedFailures[0].name, "custom-gate");
  assert.ok(!diagFail.checkStatus.unresolvedFailures[0].checkKey.includes("136ms"));

  const diagPass = analyzeTranscriptCache(steps, { nowMs: T0_MS + 15000 });
  assert.equal(diagPass.checkStatus.unresolvedFailures.length, 0);
  assert.equal(diagPass.checkStatus.latestCheck?.name, "custom-gate");

  // PostToolUse strips duration suffix in failedCommands / passedCommands
  const sigFail = extractVerificationSignal(
    "mcp_agy-dart_fast_run_checks",
    { commands: [{ name: "custom-gate", command: "node scripts/verify-custom.mjs" }] },
    "Checks: 0/1 passed, 1 failed (wall: 140ms)\n\n## [FAIL (exit 1)] custom-gate (136ms)\n$ node scripts/verify-custom.mjs\nError: mismatch"
  );
  assert.equal(sigFail?.failedCommands?.[0]?.name, "custom-gate");

  // Legacy checkpoint row with stored "(136ms)" clears when rerun passes
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-1104-dur-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db") });
  try {
    store.open();
    const legacyPayload = JSON.stringify({
      command: "custom-gate",
      ruleId: "run_checks",
      ok: false,
      outcome: "fail",
      exitCode: 1,
      unresolvedFailures: [
        {
          command: "node scripts/verify-custom.mjs",
          name: "custom-gate (136ms)",
          kind: "check",
          checkKey: "check:named:name:custom-gate (136ms)",
          exitCode: 1,
          summary: "Checks: 0/1 passed, 1 failed",
          failureExcerpt: "Error: mismatch",
          missingDetails: false,
          at: iso(0)
        }
      ],
      at: iso(0)
    });
    store.db
      .prepare(
        "INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at) VALUES (?, ?, '[]', ?, NULL, ?, ?)"
      )
      .run("conv-legacy-dur", tmpDir, legacyPayload, T0_MS, iso(0));

    store.recordVerificationResult("conv-legacy-dur", {
      kind: "test",
      ruleId: "run_checks",
      command: "custom-gate",
      passed: true,
      exitCode: 0,
      passedCommands: [{ name: "custom-gate (84ms)", command: "node scripts/verify-custom.mjs" }],
      batchCommands: [{ name: "custom-gate", command: "node scripts/verify-custom.mjs" }],
      batchTotalCount: 1,
      summary: "Checks: 1/1 passed",
      worktree: tmpDir
    });
    const cp = store.getSessionCheckpoint("conv-legacy-dur");
    assert.equal(cp.lastTest?.ok, true);
    assert.equal(cp.lastTest?.unresolvedFailures, undefined);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.10.4-2: Ad-hoc inspection run_checks probes never stick red, while real checks and filter syntax errors still fail", () => {
  const real03eCmd1 =
    'git status -sb && echo "---00809d7---" && git show --stat 00809d7 && node -e "console.log(1)"';
  const real03eCmd2 =
    'git show --stat 4b1550a && echo "---TAGS---" && git tag --sort=-v:refname | head -n 5 && echo "---REMOTES---" && git remote -v && echo "---STATUS---" && git status --short';

  assert.equal(isAdhocInspectionRunCheckBlock("inspect-new-commits-and-versions (136ms)", real03eCmd1), true);
  assert.equal(isAdhocInspectionRunCheckBlock("inspect-v1101-release-commit (60ms)", real03eCmd2), true);
  assert.equal(isAdhocInspectionRunCheckBlock("inspect-db", 'node -e "console.log(1)"'), true);
  assert.equal(isAdhocInspectionRunCheckBlock("add-remote", "git remote add origin https://example.com/repo.git"), false);
  // Audit Item 2 regressions: downstream pipe verifiers, xargs, filter syntax error, verify-named probe, git diff --exit-code/--check, mutating git tag/branch
  assert.equal(isAdhocInspectionRunCheckBlock("plugin-validate", "echo input | agy plugin validate --strict"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("verify-pkg", "cat package.json | node scripts/verify-pkg.mjs"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("syntax", "type a.js | node --check"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("xargs-syntax", 'git ls-files "*.mjs" | xargs node --check'), false);
  assert.equal(isAdhocInspectionRunCheckBlock("verify-version", 'echo checking && node -e "process.exit(1)"'), false);
  assert.equal(isAdhocInspectionRunCheckBlock("verify-clean-git", "git diff --exit-code"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("check-whitespace", "git diff --check"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("inspect-win", 'node -e "console.log(1)" | Select-String "["'), false);
  assert.equal(isAdhocInspectionRunCheckBlock("tag-release", "git tag v1.10.4"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("del-branch", "git branch -D old-branch"), false);

  // Anti-false-negatives: real verification tools, test/build checks, and filter regex errors MUST stay false
  assert.equal(isAdhocInspectionRunCheckBlock("plugin-validate", "agy plugin validate --strict --json"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("syntax", "node --check context/lib/cache-analyzer.js"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("doctor", "npm run doctor"), false);
  assert.equal(isAdhocInspectionRunCheckBlock("tsc-filter", 'Select-String "[" src/a.ts'), false);
  assert.equal(isAdhocInspectionRunCheckBlock("win", 'Select-String "foo" "C:\\src\\" ; node -e "process.exit(1)"'), false);
  assert.equal(isAdhocInspectionRunCheckBlock("custom-verify", 'node -e "process.exit(1)"'), false);
  assert.equal(isAdhocInspectionRunCheckBlock("unit-test", "npm test"), false);

  // Transcript with exact 03e251c6 ad-hoc inspection failures produces 0 unresolvedFailures
  const steps = [
    plannerTurn(1, 0, [
      { id: "rc_i1", name: "mcp_agy-dart_fast_run_checks", args: { outputMode: "full", commands: [{ name: "inspect-v1101-release-commit", command: real03eCmd2 }] } }
    ]),
    toolResult(
      2,
      "rc_i1",
      `Checks: 0/1 passed, 1 failed (wall: 65ms)\n\n## [FAIL (exit 1)] inspect-v1101-release-commit (60ms)\n$ ${real03eCmd2}\nfatal: ambiguous argument`
    ),
    plannerTurn(3, 10, [
      { id: "rc_i2", name: "mcp_agy-dart_fast_run_checks", args: { outputMode: "full", commands: [{ name: "inspect-new-commits-and-versions", command: real03eCmd1 }] } }
    ]),
    toolResult(
      4,
      "rc_i2",
      `Checks: 0/1 passed, 1 failed (wall: 140ms)\n\n## [FAIL (exit 1)] inspect-new-commits-and-versions (136ms)\n$ ${real03eCmd1}\nSyntaxError: Unexpected end of input`
    )
  ];
  const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 20000 });
  assert.equal(diag.checkStatus.unresolvedFailures.length, 0);
  assert.equal(diag.checkStatus.latestRealFailure, null);

  // PostToolUse returns null for standalone ad-hoc inspection failures so checkpoints stay clean
  assert.equal(
    extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "inspect-new-commits-and-versions", command: real03eCmd1 }] },
      `Checks: 0/1 passed, 1 failed (wall: 140ms)\n\n## [FAIL (exit 1)] inspect-new-commits-and-versions (136ms)\n$ ${real03eCmd1}\nSyntaxError: Unexpected end of input`
    ),
    null
  );

  // Mixed batch (vitest PASS + ad-hoc git inspect FAIL) counts as PASS
  const sigMixed = extractVerificationSignal(
    "mcp_agy-dart_fast_run_checks",
    {
      commands: [
        { name: "vitest", command: "npx vitest run" },
        { name: "inspect-git", command: real03eCmd2 }
      ]
    },
    `Checks: 1/2 passed, 1 failed (wall: 520ms)\n\n- [PASS 450ms] vitest (\`npx vitest run\`): 20 passed\n\n## [FAIL (exit 1)] inspect-git (60ms)\n$ ${real03eCmd2}\nfatal: bad revision`
  );
  assert.equal(sigMixed?.passed, true);

  // Real agy plugin validate failure STILL sticks as unresolved failure
  const realSteps = [
    plannerTurn(1, 0, [
      { id: "rc_v", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "plugin-validate", command: "agy plugin validate --strict --json" }] } }
    ]),
    toolResult(
      2,
      "rc_v",
      "Checks: 0/1 passed, 1 failed (wall: 220ms)\n\n## [FAIL (exit 1) 210ms] plugin-validate\n$ agy plugin validate --strict --json\nInvalid plugin.json"
    )
  ];
  const diagReal = analyzeTranscriptCache(realSteps, { nowMs: T0_MS + 5000 });
  assert.equal(diagReal.checkStatus.unresolvedFailures.length, 1);
  assert.equal(diagReal.checkStatus.unresolvedFailures[0].name, "plugin-validate");
});

test("v1.10.4-3: Compound && verification chains resolve cleanly without hybrid checkKeys or || bypasses", () => {
  const failSuiteCmd =
    "npm run brief:sync && npm test && npm run verify:pkg && npm run prefix:budget && npm run brief:check && agy plugin validate --strict --json";
  const passSuiteCmd =
    "npm test && npm run verify:pkg && npm run brief:check && npm run install:plugin && npm run doctor";

  const failId = extractCheckIdentity("test", "full-verification-suite", failSuiteCmd);
  assert.equal(failId.tool, "pkg-test", "Compound test chain must anchor on npm test, not trailing agy plugin validate");
  assert.equal(checkpointExtractCheckIdentity("test", "full-verification-suite", failSuiteCmd).checkKey, failId.checkKey);

  const passIds = extractCompoundPassIdentities("test", "publish-v1103-and-sync-local", passSuiteCmd);
  assert.ok(passIds.some((pid) => doesPassResolveFailure(pid, failId)));
  assert.ok(
    checkpointExtractCompoundPassIdentities("test", "publish-v1103-and-sync-local", passSuiteCmd).some((pid) =>
      doesPassResolveFailure(pid, failId)
    )
  );

  // End-to-end transcript resolution
  const steps = [
    plannerTurn(1, 0, [
      { id: "c1", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "full-verification-suite", command: failSuiteCmd }] } }
    ]),
    toolResult(
      2,
      "c1",
      `Checks: 0/1 passed, 1 failed (wall: 4100ms)\n\n## [FAIL (exit 1) 4000ms] full-verification-suite\n$ ${failSuiteCmd}\nAssertionError: mismatch`
    ),
    plannerTurn(3, 20, [
      { id: "c2", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "publish-v1103-and-sync-local", command: passSuiteCmd }] } }
    ]),
    toolResult(
      4,
      "c2",
      `Checks: 1/1 passed (wall: 5200ms)\n\n- [PASS 5100ms] publish-v1103-and-sync-local (\`${passSuiteCmd}\`): all passed`
    )
  ];
  const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 30000 });
  assert.equal(diag.checkStatus.unresolvedFailures.length, 0);

  // Anti-false-negative: narrow compound pass (lint && vitest a.test.ts) must NOT resolve b.test.ts failure; || must NOT expand
  const failB = extractCheckIdentity("test", "vitest", "npx vitest run tests/b.test.ts");
  const narrowPassIds = extractCompoundPassIdentities("test", "partial", "npm run lint && npx vitest run tests/a.test.ts");
  assert.equal(narrowPassIds.some((pid) => doesPassResolveFailure(pid, failB)), false);

  const orPassIds = extractCompoundPassIdentities("test", "swallowed", "npm test || true");
  assert.equal(orPassIds.some((pid) => pid.tool === "pkg-test" && pid.isBroad), false);

  // PowerShell 5.1 fail-fast semicolon guards (`if ($LASTEXITCODE -ne 0) { exit ... }` and `if ($LASTEXITCODE -eq 0) { ... }`)
  const psAbortGuardCmd =
    "cd e:\\work\\agy-dart; npm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run verify:pkg; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; agy plugin validate --strict --json .";
  const psAbortIds = extractCompoundPassIdentities("test", "", psAbortGuardCmd);
  assert.ok(psAbortIds.some((pid) => doesPassResolveFailure(pid, failId)), "PS5 fail-fast abort guard chain must resolve full-verification-suite");
  assert.ok(
    checkpointExtractCompoundPassIdentities("test", "", psAbortGuardCmd).some((pid) => doesPassResolveFailure(pid, failId))
  );

  const psIfOkCmd =
    "Set-Location e:\\work\\agy-dart; npm run brief:sync; if ($LASTEXITCODE -eq 0) { npm run brief:check }; if ($LASTEXITCODE -eq 0) { npm run doctor }";
  const briefFailId = extractCheckIdentity("check", "brief-check", "npm run brief:check");
  assert.ok(
    extractCompoundPassIdentities("check", "", psIfOkCmd).some((pid) => doesPassResolveFailure(pid, briefFailId)),
    "PS5 if ($LASTEXITCODE -eq 0) chain must resolve brief-check"
  );

  // Unguarded semicolon (`npm test; echo done`) must NOT resolve prior test failure!
  const unguardedSemiIds = extractCompoundPassIdentities("test", "", "npm test; echo done");
  assert.equal(unguardedSemiIds.some((pid) => pid.tool === "pkg-test" && pid.isBroad), false);

  // Audit Item 3 regressions: exit 0 / bare exit, if-eq-0 before unguarded cmd, || with generic name, wrapped ||, filter pipe, >140-char checkpoint PS5 chain
  for (const unsafeCmd of [
    "npm test || true",
    'bash -c "npm test || npm run lint"',
    "npm run lint && npm test | grep PASS",
    "npm test; if ($LASTEXITCODE -ne 0) { exit 0 }",
    "npm test; if ($LASTEXITCODE -ne 0) { exit }",
    "npm test; if ($LASTEXITCODE -eq 0) { npm run build }; npm run lint",
    'npm run lint; if ($LASTEXITCODE -eq 0) { bash -c "npm test; echo done" }'
  ]) {
    assert.equal(
      extractCompoundPassIdentities("test", "", unsafeCmd).some((pid) => doesPassResolveFailure(pid, failId)),
      false,
      `cache-analyzer must NOT resolve npm test on unsafe pass: ${unsafeCmd}`
    );
    assert.equal(
      checkpointExtractCompoundPassIdentities("test", "", unsafeCmd).some((pid) => doesPassResolveFailure(pid, failId)),
      false,
      `checkpoints must NOT resolve npm test on unsafe pass: ${unsafeCmd}`
    );
  }

  // Long (>140-char) PS5 fail-fast checkpoint command resolves cleanly without truncating checkKey mid-guard
  const tmpLong = fs.mkdtempSync(path.join(os.tmpdir(), "agy-1104-longcp-"));
  const longStore = new ContextModeStore({ dbPath: path.join(tmpLong, "context.db") });
  try {
    const longBuildCmd =
      "cd e:\\work\\agy-dart; npm run verify:pkg; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run prefix:budget; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npx tsc --noEmit --project tsconfig.json";
    assert.ok(longBuildCmd.length > 160);
    longStore.recordVerificationResult("conv-long-ps5", {
      kind: "build",
      command: longBuildCmd,
      passed: false,
      exitCode: 1,
      summary: "tsc failed",
      failureExcerpt: "error TS2322",
      worktree: tmpLong
    });
    const cpFail = longStore.getSessionCheckpoint("conv-long-ps5");
    assert.ok(!String(cpFail.lastBuild?.checkKey || "").includes(":if:"), `Long PS5 checkKey must not corrupt to :if:: ${cpFail.lastBuild?.checkKey}`);
    longStore.recordVerificationResult("conv-long-ps5", {
      kind: "build",
      command: longBuildCmd,
      passed: true,
      exitCode: 0,
      summary: "passed",
      worktree: tmpLong
    });
    const cpPass = longStore.getSessionCheckpoint("conv-long-ps5");
    assert.equal(cpPass.lastBuild?.ok, true);
    assert.equal(cpPass.lastBuild?.unresolvedFailures, undefined);
  } finally {
    longStore.close();
    fs.rmSync(tmpLong, { recursive: true, force: true });
  }
});

test("v1.10.4-4: Dashboard VM URL precedence, onWorkspaceChange mismatch unbinding, standalone auto-follow, and legacy duration strip", async () => {
  const html = readDashboardHtml();

  // 4A. URL query conversationId takes precedence over frozen window.sidecar.conversationId
  const vmUrl = createSidecarBindingVm(html, {
    nativeConvId: "conv-frozen-old",
    locationSearch: "?conversationId=conv-live-url"
  });
  assert.equal(vm.runInContext("getNativeHostConversationId()", vmUrl.ctx), "conv-live-url");

  // 4B. Reused sidecar iframe switches workspace from e:\work to e:\mys -> unbinds stale e:\work error
  const vmWs = createSidecarBindingVm(html, {
    nativeConvId: "03e251c6-988c-4f54-a8b1-9244bf39322e",
    workspaceUris: ["file:///e%3A/work"]
  });
  vm.runInContext("setLanguage('zh', false);", vmWs.ctx);
  await vm.runInContext("resolveHostWorkspacePaths()", vmWs.ctx);

  // Seed watchdog state with conv in e:\work and no unique session in e:\mys
  const wdInitial = {
    ok: true,
    enabled: true,
    current: { conversationId: "03e251c6-988c-4f54-a8b1-9244bf39322e", cwd: "e:\\work", workspaceLabel: "work", phase: "IDLE", severity: "idle" },
    sessions: [
      { conversationId: "03e251c6-988c-4f54-a8b1-9244bf39322e", cwd: "e:\\work", workspaceLabel: "work", phase: "IDLE", severity: "idle", lastActivityTs: T0_MS }
    ],
    alertingSessions: []
  };
  vm.runInContext(`renderWatchdogCard(${JSON.stringify(wdInitial)});`, vmWs.ctx);
  // Seed legacy failure with "(136ms)" on e:\work conversation -> stripped in guidance text!
  const kvFail = {
    ok: true,
    transcriptFound: true,
    turnsWithUsage: 3,
    watermark: "healthy",
    checkStatus: {
      hasConfirmedResult: true,
      latestCheck: { outcome: "pass", name: "publish", kind: "test" },
      latestRealFailure: { outcome: "fail", name: "custom-gate (136ms)", kind: "check", exitCode: 1, errorExcerpt: "err" },
      unresolvedFailures: [{ outcome: "fail", name: "custom-gate (136ms)", kind: "check", exitCode: 1, errorExcerpt: "err" }]
    }
  };
  vm.runInContext(`renderKvCacheCard(${JSON.stringify(kvFail)});`, vmWs.ctx);
  assert.equal(vmWs.getEl("kv-guidance-text").textContent, "还有检查未通过（custom-gate）。先看这项报错。");

  // Switch host workspace to e:\mys without reloading iframe -> stale e:\work conversation unbinds & error clears!
  vmWs.triggerWorkspaceChange(["file:///e%3A/mys"]);
  assert.equal(vm.runInContext("getActiveConversationId()", vmWs.ctx), "");
  assert.equal(vmWs.getEl("kv-guidance-bar").dataset.guidanceKind, "none");

  // Switch workspace back to e:\work -> original native conversation re-binds automatically
  vmWs.triggerWorkspaceChange(["file:///e%3A/work"]);
  assert.equal(vm.runInContext("getActiveConversationId()", vmWs.ctx), "03e251c6-988c-4f54-a8b1-9244bf39322e");

  // Switch to e:\mys when there IS a unique active primary session there -> auto-follows e:\mys session
  const wdWithMys = {
    ...wdInitial,
    sessions: [
      ...wdInitial.sessions,
      { conversationId: "a43c5878-b6d3-402b-b2cb-dd1d08f56956", cwd: "e:\\mys", workspaceLabel: "mys", phase: "PLANNER_THINKING", severity: "ok", lastActivityTs: T0_MS + 5000 }
    ]
  };
  vm.runInContext(`cachedWatchdog = ${JSON.stringify(wdWithMys)};`, vmWs.ctx);
  vmWs.triggerWorkspaceChange(["file:///e%3A/mys"]);
  assert.equal(vm.runInContext("getActiveConversationId()", vmWs.ctx), "a43c5878-b6d3-402b-b2cb-dd1d08f56956");

  // 4C. Standalone browser mode (no window.sidecar) advances inferredFallbackConvId to newer active session
  const vmStandalone = createSidecarBindingVm(html, { hasSidecar: false });
  vm.runInContext("inferredFallbackConvId = 'conv-old-idle';", vmStandalone.ctx);
  assert.equal(vm.runInContext("getActiveConversationId()", vmStandalone.ctx), "conv-old-idle");
  const wdStandalone = {
    ok: true,
    enabled: true,
    current: { conversationId: "conv-old-idle", phase: "IDLE", severity: "idle" },
    sessions: [
      { conversationId: "conv-old-idle", phase: "IDLE", severity: "idle", lastActivityTs: T0_MS },
      { conversationId: "conv-new-active", phase: "TOOL_RUNNING", severity: "ok", lastActivityTs: T0_MS + 10000 }
    ],
    alertingSessions: []
  };
  vm.runInContext(`renderWatchdogCard(${JSON.stringify(wdStandalone)});`, vmStandalone.ctx);
  assert.equal(vm.runInContext("getActiveConversationId()", vmStandalone.ctx), "conv-new-active");
});

test("v1.10.4-5: Parent-workspace primary session resolution & anonymous workspace:* checkpoint failure TTL", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-1104-ws-"));
  const subRepo = path.join(tmpRoot, "sub-repo");
  const otherWs = path.join(tmpRoot, "other-ws");
  fs.mkdirSync(subRepo, { recursive: true });
  fs.mkdirSync(otherWs, { recursive: true });

  const store = new ContextModeStore({ dbPath: path.join(tmpRoot, "context.db") });
  try {
    const now = Date.now();
    // 1. Single active primary session in parent tmpRoot resolves child subRepo cleanly
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-parent-1", cwd: tmpRoot }, { nowMs: now, cwd: tmpRoot });
    assert.equal(store.resolveUniqueActivePrimarySessionForWorkspace(subRepo, { nowMs: now }), "conv-parent-1");
    assert.equal(store.resolveUniqueActivePrimarySessionForWorkspace(otherWs, { nowMs: now }), "conv-parent-1");

    // 2. Two active primary sessions in parent tmpRoot -> ambiguous -> returns ""
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-parent-2", cwd: tmpRoot }, { nowMs: now, cwd: tmpRoot });
    assert.equal(store.resolveUniqueActivePrimarySessionForWorkspace(subRepo, { nowMs: now }), "");

    // 3. Unique exact primary session at subRepo takes precedence over parent umbrella sessions (Wave1-4 contract)
    recordHookLeaseTransition(store, "PreInvocation", { conversationId: "conv-exact-sub", cwd: subRepo }, { nowMs: now, cwd: subRepo });
    assert.equal(store.resolveUniqueActivePrimarySessionForWorkspace(subRepo, { nowMs: now }), "conv-exact-sub");

    // 3b. Active subagent in subRepo belonging to another root session competes with active parent umbrella -> returns ""
    const tmpSub = fs.mkdtempSync(path.join(os.tmpdir(), "agy-1104-sub-"));
    const subA = path.join(tmpSub, "sub-a");
    fs.mkdirSync(subA, { recursive: true });
    const subStore = new ContextModeStore({ dbPath: path.join(tmpSub, "context.db") });
    try {
      recordHookLeaseTransition(subStore, "PreInvocation", { conversationId: "conv-umb", cwd: tmpSub }, { nowMs: now, cwd: tmpSub });
      recordHookLeaseTransition(
        subStore,
        "PreInvocation",
        { conversationId: "sub-worker-1", parentConversationId: "conv-other", rootConversationId: "conv-other", cwd: subA },
        { nowMs: now, cwd: subA, rootSessionId: "conv-other" }
      );
      assert.equal(
        subStore.resolveUniqueActivePrimarySessionForWorkspace(subA, { nowMs: now }),
        "",
        "Active subagent of another root in child dir must prevent umbrella from absorbing its checks"
      );
    } finally {
      subStore.close();
      fs.rmSync(tmpSub, { recursive: true, force: true });
    }

    // 4. Anonymous workspace:* checkpoint expires unresolvedFailures >6h on direct AND all/app/lifetime scopes, prunes previousFailure, and clears all-expired fail slots
    const staleIso = new Date(now - 7 * 3600 * 1000).toISOString();
    const freshIso = new Date(now - 5 * 60 * 1000).toISOString();
    const stalePayload = JSON.stringify({
      command: "old-check",
      ruleId: "run_checks",
      ok: false,
      outcome: "fail",
      exitCode: 1,
      unresolvedFailures: [
        { command: "npm test", name: "old-test", kind: "test", checkKey: "test:pkg-test:*", exitCode: 1, at: staleIso },
        { command: "npm run lint", name: "fresh-lint", kind: "build", checkKey: "build:pkg-script:script:lint", exitCode: 1, at: freshIso }
      ],
      at: freshIso
    });
    const allExpiredFreshOuterPayload = JSON.stringify({
      command: "all-expired",
      ruleId: "run_checks",
      ok: false,
      outcome: "fail",
      exitCode: 1,
      unresolvedFailures: [
        { command: "npm test", name: "old-only", kind: "test", checkKey: "test:pkg-test:*", exitCode: 1, at: staleIso }
      ],
      at: freshIso
    });
    const expiredPrevTimeoutPayload = JSON.stringify({
      command: "slow-test",
      ruleId: "run_checks",
      ok: false,
      outcome: "timeout",
      timedOut: true,
      previousFailure: { command: "npm test", name: "old-prev", kind: "test", at: staleIso },
      at: freshIso
    });
    store.db
      .prepare(
        "INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at) VALUES (?, ?, '[]', ?, ?, ?, ?)"
      )
      .run("workspace:deadbeef1234", subRepo, stalePayload, expiredPrevTimeoutPayload, now, freshIso);
    store.db
      .prepare(
        "INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at) VALUES (?, ?, '[]', ?, NULL, ?, ?)"
      )
      .run("workspace:allexpired99", subRepo, allExpiredFreshOuterPayload, now - 1000, freshIso);
    store.db
      .prepare(
        "INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at) VALUES (?, ?, '[]', ?, NULL, ?, ?)"
      )
      .run("conv-named-keep", subRepo, stalePayload, now - 2000, freshIso);

    const anonCp = store.getSessionCheckpoint("workspace:deadbeef1234");
    assert.equal(anonCp.lastTest?.unresolvedFailures?.length, 1);
    assert.equal(anonCp.lastTest.unresolvedFailures[0].name, "fresh-lint");
    assert.equal(anonCp.lastBuild?.previousFailure, undefined, "Expired previousFailure on anonymous timeout slot must be pruned");

    const allScopeCp = store.getSessionCheckpoint("all");
    assert.equal(allScopeCp.lastTest?.unresolvedFailures?.length, 1, "scope='all' returning latest workspace:* row must also prune expired failures");

    const allExpiredCp = store.getSessionCheckpoint("workspace:allexpired99");
    assert.equal(allExpiredCp.lastTest, null, "Fail slot whose unresolvedFailures all expired must return null");

    const namedCp = store.getSessionCheckpoint("conv-named-keep");
    assert.equal(namedCp.lastTest?.unresolvedFailures?.length, 2, "Named conversation checkpoints must NOT drop >6h failures");
  } finally {
    store.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
