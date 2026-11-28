import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import {
  lookupConversationSummary,
  parseAnnotationArchivedStatus,
  readWatchdogLease,
  WATCHDOG_PHASES,
  writeWatchdogLease
} from "../context/lib/watchdog-lease.js";
import { WatchdogMonitor } from "../context/lib/watchdog.js";
import { sendSidecarKeepaliveMessage } from "../sidecars/dashboard/server.mjs";
import { readDashboardHtml } from "./helpers/dashboard-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function flushMicrotasks(rounds = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

function makeControlledClock(startMs = 1_820_000_000_000) {
  let wallMs = startMs;
  let monoNs = 10_000_000_000n;
  return {
    now: () => wallMs,
    mono: () => monoNs,
    set(nextMs) {
      const delta = Math.max(0, nextMs - wallMs);
      wallMs = nextMs;
      monoNs += BigInt(delta) * 1_000_000n;
    }
  };
}

function createFakeAgRoot(prefix = "agy-archived-guard-") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agRoot = path.join(tmpDir, "antigravity");
  const annDir = path.join(agRoot, "annotations");
  const brainDir = path.join(agRoot, "brain");
  fs.mkdirSync(annDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });
  const sumDbPath = path.join(agRoot, "conversation_summaries.db");
  const ctxDbPath = path.join(tmpDir, "context.db");
  return { tmpDir, agRoot, annDir, brainDir, sumDbPath, ctxDbPath };
}

function initSummaryDbWithFts(sumDbPath) {
  const db = new DatabaseSync(sumDbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      agent_name TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE conversations_fts USING fts5(
      conversation_id UNINDEXED,
      archived UNINDEXED,
      title
    );
  `);
  return db;
}

function writeAnnotationPbtxt(annDir, convId, content) {
  fs.writeFileSync(path.join(annDir, `${convId}.pbtxt`), content, "utf8");
}

function seedStoppedLease(store, convId, {
  cacheOriginTs,
  idleAnchorTs,
  contextTokens = 120_000,
  windowTokens = 200_000,
  cacheTtlSec = 300,
  model = "claude-opus-4-6-thinking",
  stopReason = "NO_TOOL_CALL",
  transcriptPath = "",
  watermark = "ok"
}) {
  return writeWatchdogLease(store, {
    conversationId: convId,
    rootSessionId: convId,
    convTitle: `Title ${convId}`,
    phase: WATCHDOG_PHASES.IDLE,
    subphase: "stopped",
    stopReason,
    contextTokens,
    windowTokens,
    cacheTtlSec,
    ttlSource: "profile",
    model,
    isSubagent: false,
    transcriptPath,
    watermark,
    startedTs: cacheOriginTs,
    lastLlmStartTs: cacheOriginTs,
    cacheOriginTs,
    idleAnchorTs,
    phaseChangedTs: idleAnchorTs,
    updatedTs: idleAnchorTs
  });
}

// ---------------------------------------------------------------------------
// 1. pbtxt parser edge cases
// ---------------------------------------------------------------------------
test("v1.7.6-arch-1: parseAnnotationArchivedStatus handles single-line pbtxt, unarchive false, comments, quotes & nested blocks", () => {
  // Real Antigravity single-line archived format
  assert.equal(
    parseAnnotationArchivedStatus(
      'title:"Fix cache bug" archived:true archival_status_timestamp:{seconds:1795107192 nanos:349925400} last_user_view_time:{seconds:1795107192 nanos:457000000}'
    ),
    true
  );

  // Explicit unarchive
  assert.equal(
    parseAnnotationArchivedStatus(
      'title:"Fix cache bug" archived:false archival_status_timestamp:{seconds:1795107200 nanos:0}'
    ),
    false
  );

  // Unset archived field
  assert.equal(
    parseAnnotationArchivedStatus('title:"Active chat" last_user_view_time:{seconds:1795633570 nanos:194000000}'),
    null
  );

  // Quoted title injection must NEVER false-trigger
  assert.equal(
    parseAnnotationArchivedStatus('title:"archived:true" last_user_view_time:{seconds:1795633570 nanos:0}'),
    null
  );
  assert.equal(
    parseAnnotationArchivedStatus('title:"quote \\" archived:true" last_user_view_time:{seconds:1795633570 nanos:0}'),
    null
  );

  // Comments and nested message blocks must NEVER false-trigger
  assert.equal(
    parseAnnotationArchivedStatus(
      '# archived: true\ntitle:"Normal"\nnested_meta: { archived: true }\nother < archived: 1 >'
    ),
    null
  );

  // Multiline + numeric bool + last-write-wins semantics
  assert.equal(parseAnnotationArchivedStatus("title: \"x\"\narchived: 1\n"), true);
  assert.equal(parseAnnotationArchivedStatus("title: \"x\"\narchived: 0\n"), false);
  assert.equal(parseAnnotationArchivedStatus('title:"x" archived:true archived:false'), false);
  assert.equal(parseAnnotationArchivedStatus(""), null);
});

// ---------------------------------------------------------------------------
// 2. lookupConversationSummary dual-source priority & isolation
// ---------------------------------------------------------------------------
test("v1.7.6-arch-2: lookupConversationSummary reads pbtxt > conversations_fts priority and works even without DB", () => {
  const { tmpDir, annDir, sumDbPath } = createFakeAgRoot("agy-arch-lookup-");
  try {
    // (a) Annotation pbtxt works even when conversation_summaries.db does not exist yet
    writeAnnotationPbtxt(
      annDir,
      "conv-pbtxt-only",
      'title:"Only annotation" archived:true last_user_view_time:{seconds:1795100000 nanos:0}'
    );
    const onlyPbtxt = lookupConversationSummary("conv-pbtxt-only", {
      summaryDbPath: sumDbPath,
      allowDefaultDb: false,
      checkArchived: true
    });
    assert.equal(onlyPbtxt.found, false);
    assert.equal(onlyPbtxt.archived, true);

    // (b) Create summary DB with killed=0 across all cases + FTS rows
    const db = initSummaryDbWithFts(sumDbPath);
    const insSum = db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, killed) VALUES (?, ?, ?, ?)"
    );
    const insFts = db.prepare(
      "INSERT INTO conversations_fts (conversation_id, archived, title) VALUES (?, ?, ?)"
    );
    insSum.run("conv-archived-both", "Archived Both", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-archived-both", 1, "Archived Both");
    writeAnnotationPbtxt(annDir, "conv-archived-both", 'title:"Archived Both" archived:true');

    insSum.run("conv-unarchived-stale-fts", "Unarchived", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-unarchived-stale-fts", 1, "Unarchived");
    writeAnnotationPbtxt(annDir, "conv-unarchived-stale-fts", 'title:"Unarchived" archived:false');

    insSum.run("conv-fts-only-archived", "FTS Fallback", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-fts-only-archived", 1, "FTS Fallback");

    insSum.run("conv-active", "Active", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-active", 0, "Active");
    writeAnnotationPbtxt(annDir, "conv-active", 'title:"archived:true" last_user_view_time:{seconds:100 nanos:0}');
    db.close();

    const both = lookupConversationSummary("conv-archived-both", { summaryDbPath: sumDbPath, allowDefaultDb: false });
    assert.equal(both.found, true);
    assert.equal(both.killed, false);
    assert.equal(both.archived, true);

    // Explicit archived:false in pbtxt MUST override stale conversations_fts.archived=1
    const unarchived = lookupConversationSummary("conv-unarchived-stale-fts", {
      summaryDbPath: sumDbPath,
      allowDefaultDb: false
    });
    assert.equal(unarchived.found, true);
    assert.equal(unarchived.archived, false);

    // Missing pbtxt falls back to conversations_fts.archived=1
    const ftsFallback = lookupConversationSummary("conv-fts-only-archived", {
      summaryDbPath: sumDbPath,
      allowDefaultDb: false
    });
    assert.equal(ftsFallback.found, true);
    assert.equal(ftsFallback.archived, true);

    // Active conversation with misleading title stays archived:false
    const active = lookupConversationSummary("conv-active", { summaryDbPath: sumDbPath, allowDefaultDb: false });
    assert.equal(active.found, true);
    assert.equal(active.archived, false);

    // Inline payload with checkArchived:true must NOT short-circuit past disk lookup
    const withInline = lookupConversationSummary("conv-archived-both", {
      payload: { title: "Inline Title", cwd: "e:\\work" },
      summaryDbPath: sumDbPath,
      allowDefaultDb: false,
      checkArchived: true
    });
    assert.equal(withInline.archived, true);

    // Path traversal ID is rejected safely
    const badId = lookupConversationSummary("../conv-archived-both", {
      summaryDbPath: sumDbPath,
      allowDefaultDb: false,
      checkArchived: true
    });
    assert.equal(badId.archived, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Watchdog auto-keepalive, notifications, zero statSync & reversible unarchive
// ---------------------------------------------------------------------------
test("v1.7.6-arch-3: Watchdog suppresses auto-keepalive & desktop alerts for archived chats without destroying state, and resumes on unarchive", async () => {
  const { tmpDir, annDir, brainDir, sumDbPath, ctxDbPath } = createFakeAgRoot("agy-arch-wd-");
  const store = new ContextModeStore({ dbPath: ctxDbPath });
  store.open();
  store.setGlobalTtlKeepaliveMaxCount(2);

  try {
    const db = initSummaryDbWithFts(sumDbPath);
    const insSum = db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, killed) VALUES (?, ?, ?, ?)"
    );
    const insFts = db.prepare(
      "INSERT INTO conversations_fts (conversation_id, archived, title) VALUES (?, ?, ?)"
    );
    insSum.run("conv-arch-live", "Archived Warm Chat", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-arch-live", 1, "Archived Warm Chat");
    writeAnnotationPbtxt(annDir, "conv-arch-live", 'title:"Archived Warm Chat" archived:true');

    insSum.run("conv-arch-exhausted", "Archived Exhausted", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-arch-exhausted", 1, "Archived Exhausted");
    writeAnnotationPbtxt(annDir, "conv-arch-exhausted", 'title:"Archived Exhausted" archived:true');

    insSum.run("conv-normal-live", "Normal Warm Chat", JSON.stringify(["file:///e%3A/work"]), 0);
    insFts.run("conv-normal-live", 0, "Normal Warm Chat");
    writeAnnotationPbtxt(annDir, "conv-normal-live", 'title:"Normal Warm Chat"');
    db.close();

    // Provide transcript paths inside fake brainDir so Watchdog resolves sibling sumDbPath/annotations without env pollution
    const makeFakeTx = (cid) => {
      const logDir = path.join(brainDir, cid, ".system_generated", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const tx = path.join(logDir, "transcript.jsonl");
      fs.writeFileSync(tx, "", "utf8");
      return tx;
    };

    const clock = makeControlledClock();
    const t0 = clock.now();

    // Custom per-chat override on archived conversation — MUST survive archival!
    store.setTtlKeepaliveState("conv-arch-live", {
      enabled: true,
      maxCount: 3,
      usedCount: 0,
      updatedTs: t0
    });
    // Exhausted conversation that was later archived — must not trigger exhausted TTL popup either
    store.setTtlKeepaliveState("conv-arch-exhausted", {
      enabled: true,
      maxCount: 2,
      usedCount: 2,
      lastIdleAnchorTs: t0 - 60_000,
      updatedTs: t0
    });

    seedStoppedLease(store, "conv-arch-live", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 10_000,
      transcriptPath: makeFakeTx("conv-arch-live"),
      watermark: "critical"
    });
    seedStoppedLease(store, "conv-arch-exhausted", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 10_000,
      transcriptPath: makeFakeTx("conv-arch-exhausted"),
      watermark: "critical"
    });
    seedStoppedLease(store, "conv-normal-live", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 10_000,
      transcriptPath: makeFakeTx("conv-normal-live"),
      watermark: "ok"
    });

    const sent = [];
    const popups = [];
    let statCalls = 0;
    const cfg = {
      stallWatchdog: true,
      ttlKeepalive: true,
      ttlKeepaliveMaxCount: 2,
      ttlKeepaliveLeadSec: 60,
      ttlKeepaliveMinRemainSec: 15,
      ttlKeepaliveMinContextPct: 15,
      ttlDesktopNotify: true,
      ttlNotifyLeadSec: 60,
      ttlNotifyMinTokens: 60_000,
      watermarkDesktopNotify: true
    };
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => cfg,
      nowFn: clock.now,
      monoNsFn: clock.mono,
      statFn: () => {
        statCalls += 1;
        throw new Error("Pure IDLE polling must perform 0 statSync");
      },
      notifyFn: (n) => {
        popups.push(n);
        return { dispatched: true };
      },
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // Advance into trigger window (remSec = 40s, <= 60s lead, > 15s minRemain)
    clock.set(t0 + 260_000);
    mon.tick();
    await flushMicrotasks();

    assert.equal(statCalls, 0, "IDLE polling must have 0 statSync");
    assert.deepEqual(
      sent.map((x) => x.conversationId),
      ["conv-normal-live"],
      "Only unarchived primary conversation should receive auto-keepalive"
    );
    assert.equal(popups.length, 0, "Archived chats must not trigger TTL or watermark desktop notifications");

    // Lease and custom keepalive settings on archived chat MUST remain intact (reversible!)
    const archLease = readWatchdogLease(store, "conv-arch-live");
    assert.equal(archLease?.stopReason, "NO_TOOL_CALL", "Archived chat stopReason must NOT be mutated to USER_CANCELED");
    const archKa = store.getTtlKeepaliveState("conv-arch-live");
    assert.equal(archKa.enabled, true);
    assert.equal(archKa.maxCount, 3);
    assert.equal(archKa.usedCount, 0);

    // User unarchives the chat while TTL is still warm (remSec = 30s) -> auto-keepalive resumes cleanly!
    writeAnnotationPbtxt(annDir, "conv-arch-live", 'title:"Archived Warm Chat" archived:false');
    clock.set(t0 + 270_000);
    mon.tick();
    await flushMicrotasks();

    assert.deepEqual(
      sent.map((x) => x.conversationId),
      ["conv-normal-live", "conv-arch-live"],
      "Unarchived conversation must resume auto-keepalive while still within TTL"
    );
    assert.equal(store.getTtlKeepaliveState("conv-arch-live").usedCount, 1);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Manual warm guard + dashboard UI skip reason mapping
// ---------------------------------------------------------------------------
test("v1.7.6-arch-4: triggerManualKeepalive returns skippedReason='archived' and resumes after unarchive; index.html maps archived", async () => {
  const { tmpDir, annDir, brainDir, sumDbPath, ctxDbPath } = createFakeAgRoot("agy-arch-manual-");
  const store = new ContextModeStore({ dbPath: ctxDbPath });
  store.open();

  try {
    const db = initSummaryDbWithFts(sumDbPath);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, killed) VALUES (?, ?, ?, ?)")
      .run("conv-manual-arch", "Manual Arch", JSON.stringify(["file:///e%3A/work"]), 0);
    db.close();
    writeAnnotationPbtxt(annDir, "conv-manual-arch", 'title:"Manual Arch" archived:true');

    const logDir = path.join(brainDir, "conv-manual-arch", ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const tx = path.join(logDir, "transcript.jsonl");
    fs.writeFileSync(tx, "", "utf8");

    const clock = makeControlledClock();
    const t0 = clock.now();
    seedStoppedLease(store, "conv-manual-arch", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 10_000,
      transcriptPath: tx
    });

    const sent = [];
    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({ stallWatchdog: true }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    clock.set(t0 + 120_000);
    const blocked = mon.triggerManualKeepalive("conv-manual-arch");
    await flushMicrotasks();
    assert.equal(blocked.ok, true);
    assert.equal(blocked.dispatched, false);
    assert.equal(blocked.skippedReason, "archived");
    assert.equal(sent.length, 0);
    assert.equal(store.getTtlKeepaliveState("conv-manual-arch").pendingAck, false);

    // Unarchive and retry manual warm -> dispatches cleanly
    writeAnnotationPbtxt(annDir, "conv-manual-arch", 'title:"Manual Arch" archived:false');
    const allowed = mon.triggerManualKeepalive("conv-manual-arch");
    await flushMicrotasks();
    assert.equal(allowed.ok, true);
    assert.equal(allowed.dispatched, true);
    assert.equal(sent.length, 1);

    // Verify dashboard UI maps 'archived' to i18n keys
    const html = readDashboardHtml();
    assert.ok(html.includes("case 'archived':"), "index.html must handle skippedReason='archived'");
    assert.ok(html.includes("kvWarmSkipArchived:"), "index.html must define kvWarmSkipArchived i18n copy");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Sidecar outbound firewall (local & metadata) + Watchdog claim rollback
// ---------------------------------------------------------------------------
test("v1.7.6-arch-5: sendSidecarKeepaliveMessage blocks archived chats locally and via metadata, and Watchdog rolls back cleanly", async () => {
  const { tmpDir, annDir, sumDbPath, ctxDbPath } = createFakeAgRoot("agy-arch-outbound-");
  const prevSummaryEnv = process.env.AGY_DART_SUMMARY_DB_PATH;
  process.env.AGY_DART_SUMMARY_DB_PATH = sumDbPath;

  const store = new ContextModeStore({ dbPath: ctxDbPath });
  store.open();
  store.setGlobalTtlKeepaliveMaxCount(2);

  try {
    const db = initSummaryDbWithFts(sumDbPath);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, killed) VALUES (?, ?, ?, ?)")
      .run("conv-outbound-local-arch", "Local Archived", JSON.stringify(["file:///e%3A/work"]), 0);
    db.close();
    writeAnnotationPbtxt(annDir, "conv-outbound-local-arch", 'title:"Local Archived" archived:true');

    // (a) Local annotation firewall stops BEFORE any RPC call
    let rpcCalls = 0;
    const localRes = await sendSidecarKeepaliveMessage(
      "conv-outbound-local-arch",
      "[agy-dart TTL保活 1/2] 仅回复 OK",
      {
        allowDefaultSummaryDb: true,
        execFn: async () => {
          rpcCalls += 1;
          return {};
        }
      }
    );
    assert.equal(localRes.ok, false);
    assert.equal(localRes.skippedArchived, true);
    assert.equal(rpcCalls, 0, "Local archived check must suppress before calling agentapi");

    // (b) Metadata firewall catches archived flags across top-level, nested metadata, and annotations.archived
    const metadataPayloads = [
      { response: { conversationMetadata: { archived: true, title: "Arch top" } } },
      { response: { conversationMetadata: { metadata: { archived: 1, projectId: "p1" } } } },
      { response: { conversationMetadata: { annotations: { archived: true }, title: "Arch ann" } } },
      { response: { conversationMetadata: { metadata: { annotations: { archived: "true" } } } } }
    ];
    for (let i = 0; i < metadataPayloads.length; i += 1) {
      let sendCalls = 0;
      const metaRes = await sendSidecarKeepaliveMessage(
        `conv-outbound-meta-arch-${i}`,
        "[agy-dart TTL保活 1/2] 仅回复 OK",
        {
          allowDefaultSummaryDb: false,
          execFn: async (cmdArgs) => {
            if (cmdArgs[0] === "get-conversation-metadata") return metadataPayloads[i];
            if (cmdArgs[0] === "send-message") sendCalls += 1;
            return {};
          }
        }
      );
      assert.equal(metaRes.ok, false);
      assert.equal(metaRes.skippedArchived, true, `Metadata payload #${i} must return skippedArchived=true`);
      assert.equal(sendCalls, 0, `Metadata payload #${i} must NEVER invoke send-message`);
    }

    // (c) WatchdogMonitor rolls back auto-keepalive claim cleanly when sendSidecarKeepaliveMessage returns skippedArchived
    const clock = makeControlledClock();
    const t0 = clock.now();
    seedStoppedLease(store, "conv-race-arch", {
      cacheOriginTs: t0,
      idleAnchorTs: t0 + 10_000
    });

    const mon = new WatchdogMonitor({
      getStore: () => store,
      getConfig: () => ({
        stallWatchdog: true,
        ttlKeepalive: true,
        ttlKeepaliveMaxCount: 2,
        ttlKeepaliveLeadSec: 60,
        ttlKeepaliveMinRemainSec: 15,
        ttlKeepaliveMinContextPct: 15
      }),
      nowFn: clock.now,
      monoNsFn: clock.mono,
      // Simulate race where local summary wasn't archived yet, but outbound RPC caught it
      lookupSummaryFn: () => ({ found: true, title: "Race", cwd: "", isSubagent: false, killed: false, archived: false }),
      keepaliveSendFn: async () => ({
        ok: false,
        skippedArchived: true,
        error: "archived_conversation_keepalive_suppressed"
      })
    });

    clock.set(t0 + 260_000);
    mon.tick();
    await flushMicrotasks();

    const kaAfter = store.getTtlKeepaliveState("conv-race-arch");
    assert.equal(kaAfter.usedCount, 0, "skippedArchived rollback must restore usedCount");
    assert.equal(kaAfter.pendingAck, false, "skippedArchived rollback must clear pendingAck");
    assert.equal(kaAfter.lastIdleAnchorTs, 0, "skippedArchived rollback must restore lastIdleAnchorTs");
    assert.equal(kaAfter.lastError, "", "skippedArchived rollback must not leave a stale red error string");
    assert.equal(
      readWatchdogLease(store, "conv-race-arch")?.stopReason,
      "NO_TOOL_CALL",
      "skippedArchived rollback must NOT mutate lease stopReason"
    );
  } finally {
    if (prevSummaryEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevSummaryEnv;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
