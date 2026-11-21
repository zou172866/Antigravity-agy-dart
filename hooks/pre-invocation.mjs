#!/usr/bin/env node
/**
 * agy-dart PreInvocation hook:
 * Fast (<5ms) tail scan of transcript.jsonl for server-side KV-cache protection.
 * Uses Antigravity's zero-prefix-pollution UI-only `metadata.user_markdown`
 * (with empty `systemMessage: ""`) so alerts never mutate the model prompt prefix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";

const CONTEXT_WARN_TOKENS = 130000;
const CONTEXT_CRITICAL_TOKENS = 160000;

function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const onData = (chunk) => {
      data += chunk;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function resolveSessionId(payload = {}) {
  return (
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

function resolveDirectConversationId(payload = {}) {
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

function formatDuration(sec) {
  const sAll = Math.max(0, Math.round(Number(sec || 0)));
  if (sAll < 60) return `${sAll}s`;
  if (sAll >= 3600) {
    const h = Math.floor(sAll / 3600);
    const m = Math.floor((sAll % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(sAll / 60);
  const s = sAll % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatK(tokens) {
  return `${Math.round(tokens / 1000)}k`;
}

function formatUsdShort(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "";
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function estimateColdReprefillHint(diag) {
  const pricePer1M = diag.inputPricePer1M ?? diag.modelProfile?.inputPer1M;
  const writeMult =
    Number.isFinite(diag.cacheWriteMultiplier) && diag.cacheWriteMultiplier >= 1
      ? diag.cacheWriteMultiplier
      : 1;
  const estColdUsd =
    Number.isFinite(pricePer1M) && pricePer1M > 0 && diag.currentContextTokens > 0
      ? (diag.currentContextTokens / 1e6) * pricePer1M * writeMult
      : 0;
  const coldUsdStr = formatUsdShort(estColdUsd);
  return coldUsdStr ? ` (~${coldUsdStr} cold re-prefill)` : "";
}

export function evaluateCacheAlerts(diag, { sessionId, store }) {
  const alerts = [];
  if (!diag || diag.turnsWithUsage === 0) return alerts;

  const wmKey = `cache_alert:${sessionId}:watermark`;
  const ttlKey = `cache_alert:${sessionId}:ttl_turn`;
  const ttlExpiringKey = `cache_alert:${sessionId}:ttl_expiring_turn`;
  const mediaKey = `cache_alert:${sessionId}:media`;
  const loopKey = `cache_alert:${sessionId}:loop`;
  const getAlertMeta = (k, def = "") =>
    typeof store.getTimedMeta === "function" ? store.getTimedMeta(k, def) : store.getMeta(k, def);
  const setAlertMeta = (k, v) =>
    typeof store.setTimedMeta === "function" ? store.setTimedMeta(k, v) : store.setMeta(k, v);

  const prevWm = getAlertMeta(wmKey, "");
  const effectiveWarn = diag.warnTokens || CONTEXT_WARN_TOKENS;
  const effectiveCrit = diag.criticalTokens || CONTEXT_CRITICAL_TOKENS;
  const winSource = diag.windowSource || diag.modelProfile?.windowSource;
  const winSourceTag = winSource === "transcript" || winSource === "explicit" ? ` [${winSource}]` : "";
  const windowLabel = diag.modelProfile?.windowTokens
    ? `, ${Math.round((diag.contextUtilization || diag.currentContextTokens / diag.modelProfile.windowTokens) * 100)}% of ${formatK(diag.modelProfile.windowTokens)}${winSourceTag}`
    : "";
  const savedUsdStr = diag.estimatedSavedUsd >= 0.01 ? formatUsdShort(diag.estimatedSavedUsd) : "";
  const wastedUsdStr = diag.estimatedWastedUsd >= 0.01 ? formatUsdShort(diag.estimatedWastedUsd) : "";
  const needsHandoffCue =
    diag.compactAdvice === "critical_compact" || diag.compactAdvice === "opportunistic_cold_compact";

  // 1. Context Watermark alert (fires once per threshold crossing: ok -> warn -> critical)
  if (diag.watermark === "critical" && prevWm !== "critical") {
    setAlertMeta(wmKey, "critical");
    const hitPct = (diag.weightedHitRate * 100).toFixed(0);
    const wasteHint = wastedUsdStr ? `, ~${wastedUsdStr} wasted` : "";
    const handoffHint = needsHandoffCue ? " (or copy Sidecar **Handoff Brief**)" : "";
    alerts.push(
      `Context at **${formatK(diag.currentContextTokens)} tokens** (critical watermark >= ${formatK(effectiveCrit)}${windowLabel}, cache hit ${hitPct}%${wasteHint}). Consider \`/compact\`${handoffHint} at the next milestone, then call \`ctx_resume\`.`
    );
  } else if (diag.watermark === "warn" && prevWm !== "warn" && prevWm !== "critical") {
    setAlertMeta(wmKey, "warn");
    const hitPct = (diag.weightedHitRate * 100).toFixed(0);
    if (diag.compactAdvice === "delay_hot_cache") {
      const tempLabel = String(diag.cacheTemperature || "warm").toUpperCase();
      const savedHint = savedUsdStr ? `, ~${savedUsdStr} saved` : "";
      alerts.push(
        `Context reached **${formatK(diag.currentContextTokens)} tokens** (cache **${tempLabel}**, hit ${hitPct}%${savedHint}${windowLabel}). **Delay \`/compact\`** while cache is hot to avoid re-prefill; keep tool outputs compact via \`agy-dart_fast\` / \`ctx_execute\`.`
      );
    } else if (diag.compactAdvice === "opportunistic_cold_compact") {
      alerts.push(
        `Context reached **${formatK(diag.currentContextTokens)} tokens** (high watermark >= ${formatK(effectiveWarn)}${windowLabel}, cache cold). Good moment for Sidecar **Handoff Brief** + \`/compact\`, then \`ctx_resume\`.`
      );
    } else {
      alerts.push(
        `Context reached **${formatK(diag.currentContextTokens)} tokens** (high watermark >= ${formatK(effectiveWarn)}${windowLabel}, cache hit ${hitPct}%). Keep outputs compact via \`agy-dart_fast\` / \`ctx_execute\`.`
      );
    }
  } else if (diag.watermark === "ok" && prevWm) {
    // Reset watermark state after compaction
    store.deleteMeta(wmKey);
  }

  // 2. Idle Prompt-Cache TTL expiry & proactive expiring alerts (once per idle episode)
  const ttlMinContext = Math.min(diag.delayHotMinTokens || 30000, 60000);
  if (diag.ttlStatus === "expired" && diag.currentContextTokens >= ttlMinContext && diag.lastPlannerAt) {
    const lastAlertedTurn = getAlertMeta(ttlKey, "");
    if (lastAlertedTurn !== diag.lastPlannerAt) {
      setAlertMeta(ttlKey, diag.lastPlannerAt);
      const ttlSourceTag =
        diag.ttlSource === "empirical"
          ? " calibrated"
          : diag.ttlSource === "explicit"
            ? " configured"
            : "";
      const costHint = estimateColdReprefillHint(diag);
      const compactTail = needsHandoffCue
        ? "Good moment to copy Sidecar **Handoff Brief** + `/compact`, then `ctx_resume`."
        : "Good moment to `/compact` if switching tasks.";
      alerts.push(
        `Idle **${formatDuration(diag.idleSeconds)}** (>${formatDuration(diag.cacheTtlSec)}${ttlSourceTag} KV-cache TTL) at **${formatK(diag.currentContextTokens)} tokens**${costHint} — next turn will re-prefill cold. ${compactTail}`
      );
    }
  } else if (diag.ttlStatus === "expiring" && diag.currentContextTokens >= 60000 && diag.lastPlannerAt) {
    const lastAlertedExpiring = getAlertMeta(ttlExpiringKey, "");
    if (lastAlertedExpiring !== diag.lastPlannerAt) {
      setAlertMeta(ttlExpiringKey, diag.lastPlannerAt);
      const remSec = Math.max(0, Math.round(Number(diag.ttlRemainingSec ?? 0)));
      const remLabel = remSec <= 60 ? `${remSec}s` : formatDuration(remSec);
      const costHint = estimateColdReprefillHint(diag);
      alerts.push(
        `KV-cache expiring in **${remLabel}** at **${formatK(diag.currentContextTokens)} tokens**${costHint} — send your next turn soon to stay warm, or copy Sidecar **Handoff Brief** before \`/compact\`.`
      );
    }
  }

  // 3. Multimodal high-context TTFT cliff warning (once per session)
  if (diag.totalMediaCount > 0 && diag.currentContextTokens >= 150000) {
    const alreadyAlerted = getAlertMeta(mediaKey, "");
    if (!alreadyAlerted) {
      setAlertMeta(mediaKey, "1");
      alerts.push(
        `${diag.totalMediaCount} media/image item(s) active in a **${formatK(diag.currentContextTokens)}-token** session (3–7x TTFT cliff risk). Delegate screenshot checks to a text-only subagent or \`/compact\`.`
      );
    }
  }

  // 4. Doom-loop / edit<->fail oscillation convergence alert (fires once per escalation level, resets on convergence)
  const lw = diag.loopWatch;
  if (lw && (lw.status === "warn" || lw.status === "critical")) {
    const prevLoop = getAlertMeta(loopKey, "");
    const shouldEmit =
      (lw.status === "critical" && prevLoop !== "critical") ||
      (lw.status === "warn" && prevLoop !== "warn" && prevLoop !== "critical");
    if (shouldEmit) {
      setAlertMeta(loopKey, lw.status);
      const details = [];
      if (lw.editFailOscillations >= 2) {
        const filesPart =
          Array.isArray(lw.oscillatingFiles) && lw.oscillatingFiles.length > 0
            ? ` on \`${lw.oscillatingFiles.join("`, `")}\``
            : "";
        details.push(`**${lw.editFailOscillations}x edit↔fail oscillation**${filesPart}`);
      }
      const hasRepeat = lw.reason === "repeat_loop" || lw.reason === "repeat_and_oscillation";
      if (hasRepeat && lw.maxRepeatCount >= 3) {
        const callPart = lw.topRepeatedCall ? ` (\`${lw.topRepeatedCall}\` ×${lw.maxRepeatCount})` : ` (×${lw.maxRepeatCount})`;
        details.push(`**${Math.round((lw.repeatRate || 0) * 100)}% tool repeat rate**${callPart}`);
      }
      alerts.push(
        `Convergence watch (${lw.status.toUpperCase()}): ${details.join(" + ")}. Pause repetitive patching, re-check root cause/assumptions, or pivot strategy.`
      );
    }
  } else if (lw && lw.status === "ok" && getAlertMeta(loopKey, "")) {
    store.deleteMeta(loopKey);
  }

  return alerts;
}

async function main() {
  const effectiveCfg = getEffectiveConfig();
  const resolvedDbPath = effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  const needCompactionSweepOnly =
    !effectiveCfg.cacheWatch && !effectiveCfg.diffRead && effectiveCfg.readDedup && fs.existsSync(resolvedDbPath);
  if (!effectiveCfg.cacheWatch && !effectiveCfg.diffRead && !needCompactionSweepOnly) {
    process.stdout.write("{}\n");
    return;
  }

  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write("{}\n");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  const sessionId = resolveSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);
  enableVersionedCompileCache();

  let store = null;

  try {
    const [storeMod, cacheAnalyzerMod] = await Promise.all([
      import("../context/lib/store.js"),
      import("../context/lib/cache-analyzer.js")
    ]);
    const ContextModeStore = storeMod.ContextModeStore;

    // Hook mode: bounded SQLite busy timeout & deadline so external write locks fail-open in <1s
    store = new ContextModeStore({ hookMode: true, maxBusyRetries: 4, maxRetryDeadlineMs: 800 });

    // Advance per-conversation turn sequence on every LLM turn when opt-in diff-read is active
    // so non-read turns (edits/commands/chat) accurately age diff-read baselines — even if
    // cacheWatch is disabled or alerts are paused (prevents stale diffs after unpause).
    if (effectiveCfg.diffRead && directConvId && directConvId !== "default") {
      try {
        store.bumpConversationTurnSeq(directConvId);
      } catch {}
    }

    const { analyzeTranscriptCache, findTranscriptForConversation, readTranscriptTail } = cacheAnalyzerMod;

    const targetConvId = directConvId && directConvId !== "default" ? directConvId : sessionId;
    const isSubagentConv = Boolean(directConvId && directConvId !== "default" && directConvId !== sessionId);

    let transcriptPath =
      typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()
        ? payload.transcriptPath.trim()
        : "";
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      if (targetConvId && targetConvId !== "default") {
        transcriptPath = findTranscriptForConversation(targetConvId, { exactOnly: true }) || "";
      }
    }

    let diag = null;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      const steps = readTranscriptTail(transcriptPath, 131072);
      if (steps.length > 0) {
        const diagOpts = {};
        if (effectiveCfg.cacheTtlSec !== null) diagOpts.ttlSec = effectiveCfg.cacheTtlSec;
        if (effectiveCfg.windowTokens !== null) diagOpts.windowTokens = effectiveCfg.windowTokens;
        if (effectiveCfg.warnTokens !== null) diagOpts.warnTokens = effectiveCfg.warnTokens;
        if (effectiveCfg.criticalTokens !== null) diagOpts.criticalTokens = effectiveCfg.criticalTokens;
        diag = analyzeTranscriptCache(steps, diagOpts);

        // Auto-invalidate file_reads & file_snapshots on compaction even when cacheWatch is off or paused.
        // Reverse-scan so a later TTL bust never masks an earlier compaction bust, and bind to targetConvId
        // so subagent compaction never wipes the parent conversation's file_reads.
        let latestCompactBust = null;
        for (let bi = diag.recentBusts.length - 1; bi >= 0; bi--) {
          if (diag.recentBusts[bi]?.cause === "compaction_or_truncation") {
            latestCompactBust = diag.recentBusts[bi];
            break;
          }
        }
        if (latestCompactBust) {
          const lastCompactKey = `compact_invalidated:${targetConvId}`;
          const stamp = latestCompactBust.at
            ? `at:${latestCompactBust.at}:${latestCompactBust.prevCtxTokens}:${latestCompactBust.currCtxTokens}`
            : latestCompactBust.hasExplicitStepIndex
              ? `step:${latestCompactBust.stepIndex}:${latestCompactBust.prevCtxTokens}:${latestCompactBust.currCtxTokens}`
              : `sig:${latestCompactBust.prevCtxTokens}:${latestCompactBust.currCtxTokens}:${latestCompactBust.wastedTokens ?? 0}`;
          if (store.getTimedMeta(lastCompactKey, "") !== stamp) {
            store.invalidateFileReads(targetConvId, null);
            store.setTimedMeta(lastCompactKey, stamp);
          }
        }
      }
    }

    // Inherit parent pause state for subagents, while isolating alert suppression keys per direct conversation
    if (!effectiveCfg.cacheWatch || store.isPaused(sessionId) || (isSubagentConv && store.isPaused(targetConvId)) || !diag) {
      store.close();
      store = null;
      process.stdout.write("{}\n");
      return;
    }

    const alerts = evaluateCacheAlerts(diag, { sessionId: targetConvId, store });
    store.close();
    store = null;

    if (alerts.length === 0) {
      process.stdout.write("{}\n");
      return;
    }

    const markdown = alerts.map((a) => `> **[agy-dart KV-Cache Watch]** ${a}`).join("\n");
    // Zero-prefix-pollution UI-only step: systemMessage is "" so the model receives 0 tokens!
    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: "",
              metadata: {
                user_markdown: markdown
              }
            }
          }
        ]
      }) + "\n"
    );
  } catch {
    if (store) {
      try {
        store.close();
      } catch {}
    }
    process.stdout.write("{}\n");
  }
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}
const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));
if (isDirectRun) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
