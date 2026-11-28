#!/usr/bin/env node
/**
 * agy-dart Quota Attribution & #1890 4x Custom-Agent Sentinel (`npm run quota:audit`).
 * Zero-dependency offline CLI (devtools only, 0 Turn-0 token overhead) unifying 3 attribution layers:
 *   1. #1890 Custom/Plugin Agent 4x Sentinel: scans transcript `invoke_subagent` calls & transitive
 *      parent->child subagent lineage against the official 1x built-in allowlist + on-disk agents/*.md.
 *   2. #1886 Background Safety Monitor Attribution: reuses `safety-monitor-audit.js` to separate
 *      hidden background safety reviews (`hiddenPrecheck`/`hiddenHeavy`/429) from custom-agent 4x burn.
 *   3. Multi-Session 1x Billing & Weekly Quota Checkpoint Calibration: computes exact windowed 1x
 *      equivalent USD across all sessions and calibrates real multiplier (USD / 1%) from `--mark <pct>`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelProfile, roundUsd } from "../context/lib/cache/profiles.js";
import { getAntigravityBrainRoots } from "../context/lib/cache/transcript-locator.js";
import { extractStepTokenUsage, parseTimeMs, parseTranscriptLines } from "../context/lib/cache/usage-normalizer.js";
import { auditSafetyMonitor } from "../context/lib/safety-monitor-audit.js";
import { stableSortObject } from "../context/lib/stable-json.js";
import { auditCustomAgentsOnly } from "./cache-audit.mjs";

export const BUILTIN_SUBAGENT_TYPES = Object.freeze([
  "self",
  "research",
  "browser",
  "image-generator",
  "deepcoder",
  "deepinvestigator"
]);
const BUILTIN_SUBAGENT_SET = new Set(BUILTIN_SUBAGENT_TYPES);
// Official internal workers spawned by Antigravity built-in /boost (`DeepInvestigator` / `DeepCoder`)
const BUILTIN_BOOST_INTERNAL_RE = /^deep(?:investigator|coder)(?:worker(?:l\d+)?|improvementworker)$/i;

export const DEFAULT_BASELINE_USD_PER_PCT = 6.0;
export const QUOTA_POOLS = Object.freeze(["all", "gemini", "claude-gpt"]);
export const TRACKED_QUOTA_POOLS = Object.freeze(["gemini", "claude-gpt"]);
export const QUOTA_POOL_LABELS = Object.freeze({
  all: "全池合并 (All)",
  gemini: "Gemini 模型池",
  "claude-gpt": "Claude 与 GPT 模型池",
  other: "其他/未识别模型"
});
const DEFAULT_HOURS = 24;
const MAX_MARKS = 50;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const GEMINI4_CARBON_PHASE2_MS = Date.parse("2026-12-01T00:00:00Z");

const PREFERRED_TRANSCRIPT_SUBPATHS = Object.freeze([
  [".system_generated", "logs", "transcript.jsonl"],
  [".system_generated", "transcript.jsonl"],
  ["transcript.jsonl"]
]);

function getHomeDir() {
  return process.platform === "win32"
    ? process.env.USERPROFILE || process.env.HOME || os.homedir()
    : process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function getDefaultQuotaMarksPath() {
  if (process.env.AGY_DART_QUOTA_MARKS_PATH && process.env.AGY_DART_QUOTA_MARKS_PATH.trim()) {
    return path.resolve(process.env.AGY_DART_QUOTA_MARKS_PATH.trim());
  }
  return path.join(getHomeDir(), ".agy-dart", "quota-marks.json");
}

function compareAscii(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function roundNum(n, digits = 4) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function unquoteArgString(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (!s) return "";
  // Antigravity compact transcripts often store tool args as JSON-stringified strings (e.g. `"\"research\""`)
  for (let i = 0; i < 2; i++) {
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      try {
        const parsed = JSON.parse(s);
        if (typeof parsed === "string") {
          s = parsed.trim();
          continue;
        }
      } catch {
        s = s.slice(1, -1).trim();
      }
    } else if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
      s = s.slice(1, -1).trim();
    }
    break;
  }
  return s;
}

export function isBuiltinSubagentType(typeName) {
  const norm = unquoteArgString(typeName).toLowerCase();
  return Boolean(norm && (BUILTIN_SUBAGENT_SET.has(norm) || BUILTIN_BOOST_INTERNAL_RE.test(norm)));
}

export function normalizeQuotaPool(raw, { allowAll = true } = {}) {
  const s = String(raw ?? "all").trim().toLowerCase();
  if (!s || s === "all") {
    if (!allowAll) throw new Error("Expected a specific quota pool: 'gemini' or 'claude-gpt'.");
    return "all";
  }
  if (s === "gemini" || s === "gem") return "gemini";
  if (s === "claude-gpt" || s === "claude_gpt" || s === "claudegpt" || s === "claude" || s === "gpt" || s === "openai") {
    return "claude-gpt";
  }
  throw new Error(`Invalid quota pool '${raw}'. Expected ${allowAll ? "'all', 'gemini', or 'claude-gpt'" : "'gemini' or 'claude-gpt'"}.`);
}

export function resolveQuotaPool(modelName) {
  const raw = typeof modelName === "string" ? modelName.trim() : "";
  if (!raw) return "other";
  const lower = raw.toLowerCase();
  if (lower === "unknown") return "other";
  if (
    /\bgemini\b|gemini[-_/\s.]|(?:^|[-_/\s.])(?:neon|carbon|argon|hydrogen|helix)(?:$|[-_/\s.\d])/.test(lower)
  ) {
    return "gemini";
  }
  if (
    /claude|opus|sonnet|haiku|fable|\bgpt(?:$|[-_/\s.\d])|\bchatgpt\b|(?:^|[-_/\s.])o[134](?:$|[-_/\s.])/.test(lower)
  ) {
    return "claude-gpt";
  }
  return "other";
}

/**
 * Resolve exact reference API pricing (USD per 1M tokens) for input, cache read, cache write, and output.
 * Covers Antigravity Gemini 4 (Neon/Carbon/Argon/Hydrogen/Helix), Gemini 3.x/2.5, Claude 4/5, and GPT families,
 * falling back cleanly to `resolveModelProfile()`.
 */
export function resolveModelPricing(modelName, atMs = Date.now()) {
  const raw = typeof modelName === "string" ? modelName.trim() : "";
  const lower = raw.toLowerCase();
  const profile = resolveModelProfile(raw);
  const ts = Number.isFinite(atMs) ? atMs : Date.now();

  let inputPer1M = profile.inputPer1M;
  let cacheReadPer1M = profile.inputPer1M * (1 - profile.cacheDiscountRate);
  let outputPer1M = profile.inputPer1M * 5;
  let cacheWriteMultiplier = profile.cacheWriteMultiplier ?? 1.0;
  let cacheWrite1hMultiplier = profile.cacheWrite1hMultiplier ?? cacheWriteMultiplier;

  if (lower) {
    if (/(?:^|[-_/\s.])neon(?:$|[-_/\s.\d])/.test(lower)) {
      inputPer1M = 3.0;
      cacheReadPer1M = 0.15;
      outputPer1M = 15.0;
      cacheWriteMultiplier = 1.0;
      cacheWrite1hMultiplier = 1.0;
    } else if (
      /(?:^|[-_/\s.])(?:carbon|argon)(?:$|[-_/\s.\d])/.test(lower) ||
      lower === "gemini-pro-orchestrator"
    ) {
      const phase2 = ts >= GEMINI4_CARBON_PHASE2_MS;
      inputPer1M = phase2 ? 4.0 : 2.0;
      cacheReadPer1M = phase2 ? 0.2 : 0.1;
      outputPer1M = phase2 ? 20.0 : 10.0;
      cacheWriteMultiplier = 1.0;
      cacheWrite1hMultiplier = 1.0;
    } else if (/(?:^|[-_/\s.])hydrogen(?:$|[-_/\s.\d])/.test(lower) || lower === "gemini-flash-worker-agy") {
      inputPer1M = 1.5;
      cacheReadPer1M = 0.075;
      outputPer1M = 7.5;
      cacheWriteMultiplier = 1.0;
      cacheWrite1hMultiplier = 1.0;
    } else if (/(?:^|[-_/\s.])helix(?:$|[-_/\s.\d])/.test(lower)) {
      inputPer1M = 0.3;
      cacheReadPer1M = 0.015;
      outputPer1M = 2.5;
      cacheWriteMultiplier = 1.0;
      cacheWrite1hMultiplier = 1.0;
    } else if (/gemini[-_]?3\.[678][-_]?flash/.test(lower)) {
      if (lower.includes("low")) {
        inputPer1M = 0.3;
        cacheReadPer1M = 0.03;
        outputPer1M = 2.5;
      } else {
        inputPer1M = 0.75;
        cacheReadPer1M = 0.075;
        outputPer1M = 3.75;
      }
    } else if (/gemini[-_]?3\.5[-_]?flash[-_]?lite/.test(lower)) {
      inputPer1M = 0.3;
      cacheReadPer1M = 0.03;
      outputPer1M = 2.5;
    } else if (/gemini[-_]?3\.5[-_]?flash/.test(lower)) {
      inputPer1M = 1.5;
      cacheReadPer1M = 0.15;
      outputPer1M = 9.0;
    } else if (/gemini[-_]?3\.1[-_]?pro|gemini[-_]?pro[-_]?(?:default|agent|b)\b/.test(lower)) {
      inputPer1M = 2.0;
      cacheReadPer1M = 0.2;
      outputPer1M = 12.0;
    } else if (/gemini[-_]?2\.5[-_]?pro/.test(lower)) {
      inputPer1M = 1.25;
      cacheReadPer1M = 0.125;
      outputPer1M = 10.0;
    } else if (/gemini[-_]?2\.5[-_]?flash[-_]?lite/.test(lower)) {
      inputPer1M = 0.1;
      cacheReadPer1M = 0.01;
      outputPer1M = 0.4;
    } else if (/gemini[-_]?2\.5[-_]?flash/.test(lower)) {
      inputPer1M = 0.3;
      cacheReadPer1M = 0.03;
      outputPer1M = 2.5;
    } else if (/claude[-_]?fable[-_]?5[-_.]?2/.test(lower)) {
      inputPer1M = 8.0;
      cacheReadPer1M = 0.2;
      outputPer1M = 40.0;
    } else if (/claude[-_]?opus[-_]?5[-_.]?5|orchestrator[-_]?opus[-_]?5[-_.]?5/.test(lower)) {
      inputPer1M = 4.0;
      cacheReadPer1M = 0.2;
      outputPer1M = 20.0;
    } else if (/claude[-_]?opus[-_]?(?:4[-_.]?[5678]|5\b)/.test(lower)) {
      inputPer1M = 5.0;
      cacheReadPer1M = 0.5;
      outputPer1M = 25.0;
    } else if (/claude[-_]?sonnet[-_]?5[-_.]?5/.test(lower)) {
      inputPer1M = 2.0;
      cacheReadPer1M = 0.1;
      outputPer1M = 10.0;
    } else if (/claude[-_]?sonnet/.test(lower)) {
      inputPer1M = 3.0;
      cacheReadPer1M = 0.3;
      outputPer1M = 15.0;
    } else if (/claude[-_]?haiku[-_]?5[-_.]?5/.test(lower)) {
      inputPer1M = 0.1;
      cacheReadPer1M = 0.01;
      outputPer1M = 0.5;
    } else if (/claude[-_]?haiku/.test(lower)) {
      inputPer1M = 1.0;
      cacheReadPer1M = 0.1;
      outputPer1M = 5.0;
    } else if (/gpt[-_]?5\.4/.test(lower)) {
      inputPer1M = 2.5;
      cacheReadPer1M = 0.25;
      outputPer1M = 15.0;
    } else if (/gpt[-_]?5/.test(lower)) {
      inputPer1M = 1.25;
      cacheReadPer1M = 0.125;
      outputPer1M = 10.0;
    } else if (/gpt[-_]?4\.1/.test(lower)) {
      inputPer1M = 2.0;
      cacheReadPer1M = 0.5;
      outputPer1M = 8.0;
    } else if (/gpt[-_]?4o/.test(lower)) {
      inputPer1M = 2.5;
      cacheReadPer1M = 1.25;
      outputPer1M = 10.0;
    }
  }

  return {
    model: raw || "unknown",
    inputPer1M,
    cacheReadPer1M,
    outputPer1M,
    cacheWriteMultiplier,
    cacheWrite1hMultiplier
  };
}

export function computeStepCostUsd(usage, modelName, atMs = Date.now()) {
  const p = resolveModelPricing(modelName, atMs);
  const inputUsd = (usage.inputTokens / 1e6) * p.inputPer1M;
  const cacheReadUsd = (usage.cacheReadTokens / 1e6) * p.cacheReadPer1M;
  const c1h = Math.min(usage.cacheCreationTokens, usage.cacheCreation1hTokens || 0);
  const c5m = Math.max(0, usage.cacheCreationTokens - c1h);
  const cacheWriteUsd =
    (c5m / 1e6) * p.inputPer1M * p.cacheWriteMultiplier +
    (c1h / 1e6) * p.inputPer1M * p.cacheWrite1hMultiplier;
  const outputTotal = (usage.outputTokens || 0) + (usage.thinkingTokens || 0);
  const outputUsd = (outputTotal / 1e6) * p.outputPer1M;
  const totalUsd = inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd;
  const cacheSavingsUsd = Math.max(0, (usage.cacheReadTokens / 1e6) * (p.inputPer1M - p.cacheReadPer1M));
  return { totalUsd, cacheSavingsUsd, pricing: p };
}

function readTranscriptStepsBounded(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { steps: [], mtimeMs: 0, bytes: 0, truncated: false };
  } catch {
    return { steps: [], mtimeMs: 0, bytes: 0, truncated: false };
  }

  const truncated = stat.size > MAX_TRANSCRIPT_BYTES;
  let text = "";
  let fd = null;
  try {
    if (!truncated) {
      text = fs.readFileSync(filePath, "utf8");
    } else {
      const start = stat.size - MAX_TRANSCRIPT_BYTES;
      const buf = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES);
      fd = fs.openSync(filePath, "r");
      const nRead = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, start);
      text = buf.subarray(0, nRead).toString("utf8");
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
  } catch {
    return { steps: [], mtimeMs: stat.mtimeMs, bytes: stat.size, truncated };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  return { steps: parseTranscriptLines(text), mtimeMs: stat.mtimeMs, bytes: stat.size, truncated };
}

function findTranscriptInConvDir(convDir) {
  for (const segs of PREFERRED_TRANSCRIPT_SUBPATHS) {
    const candidate = path.join(convDir, ...segs);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return { path: candidate, mtimeMs: st.mtimeMs, size: st.size };
    } catch {}
  }
  return null;
}

function discoverCandidateTranscripts(brainRoots, windowStartMs) {
  const candidates = [];
  const seenConvIds = new Set();
  const mtimeSlackMs = 120_000;

  for (const root of brainRoots) {
    let dir;
    try {
      dir = fs.opendirSync(root);
    } catch {
      continue;
    }
    try {
      let ent;
      while ((ent = dir.readSync()) !== null) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const convId = ent.name;
        if (seenConvIds.has(convId)) continue;
        const convDir = path.join(root, convId);
        const found = findTranscriptInConvDir(convDir);
        if (!found) continue;
        if (windowStartMs > 0 && found.mtimeMs < windowStartMs - mtimeSlackMs) continue;
        seenConvIds.add(convId);
        candidates.push({ convId, filePath: found.path, mtimeMs: found.mtimeMs, root });
      }
    } finally {
      try {
        dir.closeSync();
      } catch {}
    }
  }

  candidates.sort((a, b) => compareAscii(a.convId, b.convId));
  return candidates;
}

function extractStepText(step) {
  if (!step || typeof step !== "object") return "";
  if (typeof step.content === "string") return step.content;
  if (Array.isArray(step.content)) {
    return step.content
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof step.tool_result === "string") return step.tool_result;
  if (typeof step.output === "string") return step.output;
  return "";
}

function extractToolCalls(step) {
  if (!step || typeof step !== "object") return [];
  if (Array.isArray(step.tool_calls)) return step.tool_calls;
  if (Array.isArray(step.toolCalls)) return step.toolCalls;
  return [];
}

/**
 * Scan all candidate transcripts inside `[windowStartMs, windowEndMs]`, resolve transitive
 * parent->child subagent lineage, and aggregate 1x equivalent USD + custom-agent 4x exposure.
 */
export function scanQuotaTranscripts({
  brainRoots = null,
  windowStartMs = 0,
  windowEndMs = Date.now(),
  pool = "all"
} = {}) {
  const activePool = normalizeQuotaPool(pool, { allowAll: true });
  const roots =
    Array.isArray(brainRoots) && brainRoots.length > 0
      ? brainRoots.map((r) => path.resolve(r))
      : getAntigravityBrainRoots();

  const candidates = discoverCandidateTranscripts(roots, windowStartMs);
  const convMap = new Map();
  const spawnedEdgeByChild = new Map(); // childConvId -> { parentConvId, typeName, role, invokedAtMs }
  const invocations = []; // All invoke_subagent calls in window (for audit visibility)
  const makePoolUsage = () => ({
    steps: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    usd1x: 0,
    cacheSavingsUsd: 0
  });

  for (const cand of candidates) {
    const { steps, mtimeMs } = readTranscriptStepsBounded(cand.filePath);
    if (steps.length === 0) continue;

    let hasUserInput = false;
    let firstSenderParentId = null;
    let lastKnownModel = null;
    const pendingInvokes = []; // FIFO queue to pair invoke_subagent calls with subsequent GENERIC results

    const agg = {
      convId: cand.convId,
      filePath: cand.filePath,
      mtimeMs,
      stepsInWindow: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      usd1x: 0,
      cacheSavingsUsd: 0,
      models: new Set(),
      firstStepMs: null,
      lastStepMs: null,
      poolUsage: {
        gemini: makePoolUsage(),
        "claude-gpt": makePoolUsage(),
        other: makePoolUsage()
      }
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== "object") continue;

      const stepType = String(step.type || "");
      const stepTsMs = parseTimeMs(step.created_at ?? step.timestamp ?? step.ts) ?? mtimeMs;

      if (stepType === "USER_INPUT") {
        hasUserInput = true;
      }

      if (!hasUserInput && !firstSenderParentId && stepType === "SYSTEM_MESSAGE") {
        const text = extractStepText(step);
        const senderMatch = text.match(/\[Message\][^\n]*\bsender=([A-Za-z0-9_-]{8,64})(?=\s|$)/);
        if (senderMatch && !senderMatch[1].includes("/")) {
          firstSenderParentId = senderMatch[1];
        }
      }

      // Inspect invoke_subagent tool calls across full transcript (captures lineage even if spawned before window)
      for (const tc of extractToolCalls(step)) {
        if (!tc || tc.name !== "invoke_subagent") continue;
        const args = tc.args && typeof tc.args === "object" ? tc.args : {};
        const typeName = unquoteArgString(args.TypeName ?? args.typeName ?? args.type_name ?? "");
        const role = unquoteArgString(args.Role ?? args.role ?? "");
        const modelArg = unquoteArgString(args.Model ?? args.model ?? "");
        const isBuiltin = typeName ? isBuiltinSubagentType(typeName) : true;
        const rec = {
          parentConvId: cand.convId,
          childConvId: null,
          typeName: typeName || "(unspecified)",
          role,
          modelArg,
          isCustom: Boolean(typeName && !isBuiltin),
          invokedAtMs: stepTsMs,
          inWindow: stepTsMs >= windowStartMs && stepTsMs <= windowEndMs
        };
        pendingInvokes.push(rec);
        if (rec.inWindow) invocations.push(rec);
      }

      // Match tool result carrying created subagent conversationId
      if (pendingInvokes.length > 0 && (stepType === "GENERIC" || stepType === "TOOL_RESULT")) {
        const text = extractStepText(step);
        const childMatch = text.match(/"conversationId"\s*:\s*"([^"]+)"/);
        if (childMatch) {
          const matched = pendingInvokes.shift();
          matched.childConvId = childMatch[1];
          spawnedEdgeByChild.set(childMatch[1], {
            parentConvId: cand.convId,
            typeName: matched.typeName,
            role: matched.role,
            isCustom: matched.isCustom,
            invokedAtMs: matched.invokedAtMs
          });
        }
      }

      // Track latest explicit model across the conversation so model-less CHECKPOINT steps inherit it
      const explicitModel = typeof step.model === "string" && step.model.trim() ? step.model.trim() : "";
      if (explicitModel && explicitModel.toLowerCase() !== "unknown") {
        lastKnownModel = explicitModel;
      }

      // Aggregate windowed usage
      if (stepTsMs < windowStartMs || stepTsMs > windowEndMs) continue;
      const usage = extractStepTokenUsage(step);
      if (usage.inputTokens === 0 && usage.cacheReadTokens === 0 && usage.cacheCreationTokens === 0 && usage.outputTokens === 0 && usage.thinkingTokens === 0) {
        continue;
      }
      const modelName = explicitModel || lastKnownModel || "unknown";
      const stepPool = resolveQuotaPool(modelName);
      const { totalUsd, cacheSavingsUsd } = computeStepCostUsd(usage, modelName, stepTsMs);
      const stepOut = (usage.outputTokens || 0) + (usage.thinkingTokens || 0);

      const pu = agg.poolUsage[stepPool] || agg.poolUsage.other;
      pu.steps += 1;
      pu.inputTokens += usage.inputTokens;
      pu.cacheReadTokens += usage.cacheReadTokens;
      pu.cacheCreationTokens += usage.cacheCreationTokens;
      pu.outputTokens += stepOut;
      pu.usd1x += totalUsd;
      pu.cacheSavingsUsd += cacheSavingsUsd;

      if (activePool !== "all" && stepPool !== activePool) continue;

      agg.stepsInWindow += 1;
      agg.inputTokens += usage.inputTokens;
      agg.cacheReadTokens += usage.cacheReadTokens;
      agg.cacheCreationTokens += usage.cacheCreationTokens;
      agg.outputTokens += stepOut;
      agg.usd1x += totalUsd;
      agg.cacheSavingsUsd += cacheSavingsUsd;
      agg.models.add(modelName);
      if (agg.firstStepMs === null || stepTsMs < agg.firstStepMs) agg.firstStepMs = stepTsMs;
      if (agg.lastStepMs === null || stepTsMs > agg.lastStepMs) agg.lastStepMs = stepTsMs;
    }

    convMap.set(cand.convId, {
      ...agg,
      hasUserInput,
      firstSenderParentId
    });
  }

  // Classify every conversation with transitive custom-agent lineage propagation
  const classifyConversation = (convId) => {
    const visited = new Set();
    let cur = convId;
    let directType = null;
    let directParent = null;
    let isSubagent = false;

    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const edge = spawnedEdgeByChild.get(cur);
      const info = convMap.get(cur);
      if (edge) {
        isSubagent = true;
        if (cur === convId) {
          directType = edge.typeName;
          directParent = edge.parentConvId;
        }
        if (edge.isCustom) {
          return {
            bucket: "custom_agent",
            agentType: cur === convId ? edge.typeName : `${directType || "subagent"} (descendant of ${edge.typeName})`,
            parentConvId: directParent || edge.parentConvId,
            customAncestorConvId: cur,
            customAncestorType: edge.typeName,
            isCustomLineage: true
          };
        }
        cur = edge.parentConvId;
        continue;
      }
      if (info && !info.hasUserInput && info.firstSenderParentId) {
        isSubagent = true;
        if (cur === convId) {
          directParent = info.firstSenderParentId;
        }
        cur = info.firstSenderParentId;
        continue;
      }
      break;
    }

    if (isSubagent) {
      return {
        bucket: "builtin_subagent",
        agentType: directType || "builtin/unknown-subagent",
        parentConvId: directParent,
        customAncestorConvId: null,
        customAncestorType: null,
        isCustomLineage: false
      };
    }

    return {
      bucket: "main",
      agentType: "default",
      parentConvId: null,
      customAncestorConvId: null,
      customAncestorType: null,
      isCustomLineage: false
    };
  };

  const makeBucket = () => ({
    conversationCount: 0,
    steps: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    usd1x: 0,
    cacheSavingsUsd: 0
  });

  const buckets = {
    main: makeBucket(),
    builtin_subagent: makeBucket(),
    custom_agent: makeBucket()
  };

  const makePoolBucket = () => ({
    ...makeBucket(),
    customAgentUsd1x: 0,
    customExtra3xUsd: 0
  });
  const pools = {
    gemini: makePoolBucket(),
    "claude-gpt": makePoolBucket(),
    other: makePoolBucket()
  };

  const conversations = [];
  const customAgentAlerts = [];
  const byModel = new Map();

  // Also check custom invocations even if their child transcript wasn't discovered
  const seenAlertKeys = new Set();
  for (const inv of invocations) {
    if (!inv.isCustom) continue;
    const key = `${inv.parentConvId}:${inv.childConvId || ""}:${inv.typeName}:${inv.invokedAtMs}`;
    if (seenAlertKeys.has(key)) continue;
    seenAlertKeys.add(key);
    customAgentAlerts.push({
      kind: "custom_invoke_subagent",
      parentConvId: inv.parentConvId,
      childConvId: inv.childConvId,
      typeName: inv.typeName,
      role: inv.role,
      invokedAt: new Date(inv.invokedAtMs).toISOString()
    });
  }

  for (const info of convMap.values()) {
    const anyPoolSteps =
      info.poolUsage.gemini.steps + info.poolUsage["claude-gpt"].steps + info.poolUsage.other.steps;
    if (anyPoolSteps === 0) continue;
    const cls = classifyConversation(info.convId);

    for (const poolKey of Object.keys(pools)) {
      const pu = info.poolUsage[poolKey];
      if (!pu || pu.steps === 0) continue;
      const pb = pools[poolKey];
      pb.conversationCount += 1;
      pb.steps += pu.steps;
      pb.inputTokens += pu.inputTokens;
      pb.cacheReadTokens += pu.cacheReadTokens;
      pb.cacheCreationTokens += pu.cacheCreationTokens;
      pb.outputTokens += pu.outputTokens;
      pb.usd1x += pu.usd1x;
      pb.cacheSavingsUsd += pu.cacheSavingsUsd;
      if (cls.isCustomLineage) {
        pb.customAgentUsd1x += pu.usd1x;
        pb.customExtra3xUsd += pu.usd1x * 3;
      }
    }

    if (info.stepsInWindow === 0) continue;
    const b = buckets[cls.bucket];
    b.conversationCount += 1;
    b.steps += info.stepsInWindow;
    b.inputTokens += info.inputTokens;
    b.cacheReadTokens += info.cacheReadTokens;
    b.cacheCreationTokens += info.cacheCreationTokens;
    b.outputTokens += info.outputTokens;
    b.usd1x += info.usd1x;
    b.cacheSavingsUsd += info.cacheSavingsUsd;

    const totalPrompt = info.inputTokens + info.cacheReadTokens;
    const cacheHitPct = totalPrompt > 0 ? roundNum((info.cacheReadTokens / totalPrompt) * 100, 1) : 0;

    const entry = {
      convId: info.convId,
      bucket: cls.bucket,
      agentType: cls.agentType,
      parentConvId: cls.parentConvId,
      isCustomLineage: cls.isCustomLineage,
      steps: info.stepsInWindow,
      inputTokens: info.inputTokens,
      cacheReadTokens: info.cacheReadTokens,
      outputTokens: info.outputTokens,
      cacheHitPct,
      usd1x: roundUsd(info.usd1x),
      estimatedEffectiveUsd: roundUsd(cls.isCustomLineage ? info.usd1x * 4 : info.usd1x),
      models: [...info.models].sort(compareAscii),
      firstStepAt: info.firstStepMs ? new Date(info.firstStepMs).toISOString() : null,
      lastStepAt: info.lastStepMs ? new Date(info.lastStepMs).toISOString() : null
    };
    conversations.push(entry);

    if (cls.isCustomLineage && cls.customAncestorConvId !== info.convId) {
      customAgentAlerts.push({
        kind: "custom_agent_descendant",
        parentConvId: cls.parentConvId,
        childConvId: info.convId,
        typeName: cls.agentType,
        inheritedFromConvId: cls.customAncestorConvId,
        usd1x: entry.usd1x,
        estimatedExtra3xUsd: roundUsd(info.usd1x * 3)
      });
    }

    for (const m of info.models) {
      byModel.set(m, (byModel.get(m) || 0) + 1);
    }
  }

  conversations.sort((a, b) => (b.usd1x !== a.usd1x ? b.usd1x - a.usd1x : compareAscii(a.convId, b.convId)));

  const totalUsd1x = buckets.main.usd1x + buckets.builtin_subagent.usd1x + buckets.custom_agent.usd1x;
  const customExtra3xUsd = buckets.custom_agent.usd1x * 3;
  const totalCacheSavingsUsd =
    buckets.main.cacheSavingsUsd + buckets.builtin_subagent.cacheSavingsUsd + buckets.custom_agent.cacheSavingsUsd;
  const totalInput = buckets.main.inputTokens + buckets.builtin_subagent.inputTokens + buckets.custom_agent.inputTokens;
  const totalCacheRead =
    buckets.main.cacheReadTokens + buckets.builtin_subagent.cacheReadTokens + buckets.custom_agent.cacheReadTokens;
  const totalOutput = buckets.main.outputTokens + buckets.builtin_subagent.outputTokens + buckets.custom_agent.outputTokens;
  const totalSteps = buckets.main.steps + buckets.builtin_subagent.steps + buckets.custom_agent.steps;
  const overallCacheHitPct =
    totalInput + totalCacheRead > 0 ? roundNum((totalCacheRead / (totalInput + totalCacheRead)) * 100, 1) : 0;

  for (const key of Object.keys(buckets)) {
    buckets[key].usd1x = roundUsd(buckets[key].usd1x);
    buckets[key].cacheSavingsUsd = roundUsd(buckets[key].cacheSavingsUsd);
  }
  for (const key of Object.keys(pools)) {
    pools[key].usd1x = roundUsd(pools[key].usd1x);
    pools[key].cacheSavingsUsd = roundUsd(pools[key].cacheSavingsUsd);
    pools[key].customAgentUsd1x = roundUsd(pools[key].customAgentUsd1x);
    pools[key].customExtra3xUsd = roundUsd(pools[key].customExtra3xUsd);
  }

  return {
    pool: activePool,
    scannedRoots: roots,
    candidateTranscriptCount: candidates.length,
    activeConversationCount: conversations.length,
    totalSteps,
    totalInputTokens: totalInput,
    totalCacheReadTokens: totalCacheRead,
    totalOutputTokens: totalOutput,
    overallCacheHitPct,
    totalUsd1x: roundUsd(totalUsd1x),
    customExtra3xUsd: roundUsd(customExtra3xUsd),
    estimatedEffectiveUsd: roundUsd(totalUsd1x + customExtra3xUsd),
    totalCacheSavingsUsd: roundUsd(totalCacheSavingsUsd),
    invocationsInWindowCount: invocations.length,
    customInvocationCount: invocations.filter((x) => x.isCustom).length,
    builtinInvocationCount: invocations.filter((x) => !x.isCustom).length,
    buckets,
    pools,
    customAgentAlerts,
    conversations
  };
}

/* ============================================================================
 * Weekly Quota Checkpoint Store & Multiplier Calibration
 * ========================================================================== */

function normalizeBaselinesMap(rawBaselines) {
  const out = {};
  if (!rawBaselines || typeof rawBaselines !== "object" || Array.isArray(rawBaselines)) return out;
  for (const [k, v] of Object.entries(rawBaselines)) {
    let pool;
    try {
      pool = normalizeQuotaPool(k, { allowAll: true });
    } catch {
      continue;
    }
    const rawNum = typeof v === "number" ? v : v && typeof v === "object" ? Number(v.usdPerPct) : NaN;
    if (!Number.isFinite(rawNum) || rawNum <= 0) continue;
    out[pool] = {
      usdPerPct: roundNum(rawNum, 4),
      updatedAt:
        v && typeof v === "object" && typeof v.updatedAt === "string" && v.updatedAt
          ? v.updatedAt
          : null,
      source:
        v && typeof v === "object" && typeof v.source === "string" && v.source
          ? v.source
          : "saved"
    };
  }
  return out;
}

export function loadQuotaMarks(statePath = getDefaultQuotaMarksPath()) {
  try {
    if (!fs.existsSync(statePath)) return { schemaVersion: 1, baselines: {}, marks: [] };
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
    const baselines = normalizeBaselinesMap(raw?.baselines);
    const marks = Array.isArray(raw?.marks)
      ? raw.marks
          .filter(
            (m) =>
              m &&
              typeof m === "object" &&
              Number.isFinite(Number(m.tsMs)) &&
              Number.isFinite(Number(m.remainingPct)) &&
              Number(m.remainingPct) >= 0 &&
              Number(m.remainingPct) <= 100
          )
          .map((m) => {
            let pool = "all";
            try {
              pool = normalizeQuotaPool(m.pool || "all", { allowAll: true });
            } catch {
              pool = "all";
            }
            return {
              id: typeof m.id === "string" && m.id ? m.id : `m_${m.tsMs}`,
              ts: typeof m.ts === "string" ? m.ts : new Date(Number(m.tsMs)).toISOString(),
              tsMs: Math.round(Number(m.tsMs)),
              pool,
              remainingPct: roundNum(Number(m.remainingPct), 4),
              note: typeof m.note === "string" ? m.note : ""
            };
          })
          .sort((a, b) => (a.tsMs !== b.tsMs ? a.tsMs - b.tsMs : compareAscii(a.pool, b.pool)))
      : [];
    return { schemaVersion: 1, baselines, marks };
  } catch {
    return { schemaVersion: 1, baselines: {}, marks: [] };
  }
}

function trimMarksPerPool(marks) {
  const byPool = new Map();
  for (const m of marks) {
    const p = m.pool || "all";
    if (!byPool.has(p)) byPool.set(p, []);
    byPool.get(p).push(m);
  }
  const kept = [];
  for (const list of byPool.values()) {
    list.sort((a, b) => a.tsMs - b.tsMs);
    kept.push(...list.slice(-MAX_MARKS));
  }
  kept.sort((a, b) => (a.tsMs !== b.tsMs ? a.tsMs - b.tsMs : compareAscii(a.pool, b.pool)));
  return kept;
}

function saveQuotaMarksAtomic(statePath, data) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const baselines = normalizeBaselinesMap(data.baselines);
  const payload =
    JSON.stringify(
      {
        schemaVersion: 1,
        ...(Object.keys(baselines).length > 0 ? { baselines } : {}),
        marks: trimMarksPerPool(data.marks || [])
      },
      null,
      2
    ) + "\n";
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function setQuotaBaseline(
  pool,
  usdPerPct,
  { statePath = getDefaultQuotaMarksPath(), source = "manual", nowMs = Date.now() } = {}
) {
  const normPool = normalizeQuotaPool(pool, { allowAll: true });
  const val = Number(usdPerPct);
  if (!Number.isFinite(val) || val <= 0) {
    throw new Error(`Invalid baseline USD/1% '${usdPerPct}' for pool '${normPool}'. Expected a positive number.`);
  }
  const tsMs = Math.round(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  const store = loadQuotaMarks(statePath);
  const entry = {
    usdPerPct: roundNum(val, 4),
    updatedAt: new Date(tsMs).toISOString(),
    source: String(source || "manual").trim() || "manual"
  };
  store.baselines[normPool] = entry;
  saveQuotaMarksAtomic(statePath, store);
  return { pool: normPool, baseline: entry, baselines: store.baselines, statePath };
}

export function clearQuotaBaseline(statePath = getDefaultQuotaMarksPath(), { pool = "all" } = {}) {
  const normPool = normalizeQuotaPool(pool, { allowAll: true });
  const store = loadQuotaMarks(statePath);
  if (normPool === "all") {
    store.baselines = {};
  } else {
    delete store.baselines[normPool];
  }
  saveQuotaMarksAtomic(statePath, store);
  return { statePath, cleared: true, pool: normPool, baselines: store.baselines };
}

export function recordQuotaMark(
  remainingPct,
  { statePath = getDefaultQuotaMarksPath(), note = "", nowMs = Date.now(), pool = "all" } = {}
) {
  const pct = Number(remainingPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`Invalid quota percentage '${remainingPct}'. Expected a number between 0 and 100.`);
  }
  const normPool = normalizeQuotaPool(pool, { allowAll: true });
  const tsMs = Math.round(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  const store = loadQuotaMarks(statePath);
  const mark = {
    id: `m_${tsMs}_${normPool}_${crypto.randomBytes(2).toString("hex")}`,
    ts: new Date(tsMs).toISOString(),
    tsMs,
    pool: normPool,
    remainingPct: roundNum(pct, 4),
    note: String(note || "").trim()
  };
  store.marks.push(mark);
  store.marks = trimMarksPerPool(store.marks);
  saveQuotaMarksAtomic(statePath, store);
  return { mark, marks: store.marks, baselines: store.baselines, statePath };
}

export function resetQuotaMarks(
  statePath = getDefaultQuotaMarksPath(),
  { pool = "all", clearBaselines = false } = {}
) {
  const normPool = normalizeQuotaPool(pool, { allowAll: true });
  const store = loadQuotaMarks(statePath);
  if (normPool === "all") {
    store.marks = [];
    if (clearBaselines) store.baselines = {};
    saveQuotaMarksAtomic(statePath, store);
    return { statePath, cleared: true, pool: "all", baselinesCleared: Boolean(clearBaselines) };
  }
  store.marks = store.marks.filter((m) => (m.pool || "all") !== normPool);
  if (clearBaselines) delete store.baselines[normPool];
  saveQuotaMarksAtomic(statePath, store);
  return { statePath, cleared: true, pool: normPool, baselinesCleared: Boolean(clearBaselines) };
}

export function evaluateQuotaCalibration(
  marks,
  {
    pool = "all",
    baselineUsdPerPct = null,
    baselineSource = null,
    savedBaselines = null,
    brainRoots = null,
    safety = null,
    diskCustomAgents = null
  } = {}
) {
  const targetPool = normalizeQuotaPool(pool, { allowAll: true });
  const poolLabel = QUOTA_POOL_LABELS[targetPool] || targetPool;
  const poolPrefix = targetPool === "all" ? "" : `[${poolLabel}] `;
  const markHint =
    targetPool === "gemini"
      ? "--mark-gemini <剩余%>"
      : targetPool === "claude-gpt"
        ? "--mark-claude-gpt <剩余%>"
        : "--mark <当前周额度%>";

  let effectiveBaseline = null;
  let effectiveBaselineSource = "uncalibrated";
  const explicitBaseline = Number(baselineUsdPerPct);
  const savedEntry = savedBaselines && typeof savedBaselines === "object" ? savedBaselines[targetPool] : null;
  const savedBaselineVal =
    typeof savedEntry === "number" ? savedEntry : savedEntry && typeof savedEntry === "object" ? Number(savedEntry.usdPerPct) : NaN;

  if (baselineUsdPerPct !== null && baselineUsdPerPct !== undefined && Number.isFinite(explicitBaseline) && explicitBaseline > 0) {
    effectiveBaseline = roundNum(explicitBaseline, 4);
    effectiveBaselineSource = baselineSource || "cli";
  } else if (Number.isFinite(savedBaselineVal) && savedBaselineVal > 0) {
    effectiveBaseline = roundNum(savedBaselineVal, 4);
    effectiveBaselineSource = "saved";
  } else if (targetPool === "all") {
    effectiveBaseline = DEFAULT_BASELINE_USD_PER_PCT;
    effectiveBaselineSource = "default";
  }

  const validMarks = Array.isArray(marks)
    ? marks.filter((m) => (m.pool || "all") === targetPool).sort((a, b) => a.tsMs - b.tsMs)
    : [];
  if (validMarks.length < 2) {
    return {
      pool: targetPool,
      poolLabel,
      status: "needs_two_marks",
      markCount: validMarks.length,
      baselineUsdPerPct: effectiveBaseline,
      baselineSource: effectiveBaselineSource,
      latestMark: validMarks[validMarks.length - 1] || null,
      verdictZh:
        validMarks.length === 0
          ? `${poolPrefix}尚无周额度锚点：请先运行 \`${markHint}\` 记下起点，照常使用待掉 1%～2% 后再打一次点即可自动算出实测倍率。`
          : `${poolPrefix}已记录 1 个起点锚点（${validMarks[0].remainingPct}%）：照常使用待周额度自然下降 1%～2% 后，再运行一次 \`${markHint}\` 即可自动算出实测倍率。`
    };
  }

  const latest = validMarks[validMarks.length - 1];
  const prevLatest = validMarks[validMarks.length - 2];

  // If quota rose between the latest two marks, a weekly quota reset occurred
  if (latest.remainingPct > prevLatest.remainingPct) {
    return {
      pool: targetPool,
      poolLabel,
      status: "quota_reset_detected",
      markCount: validMarks.length,
      baselineUsdPerPct: effectiveBaseline,
      baselineSource: effectiveBaselineSource,
      fromMark: prevLatest,
      toMark: latest,
      deltaPct: roundNum(prevLatest.remainingPct - latest.remainingPct, 4),
      verdictZh: `${poolPrefix}检测到周额度重置（${prevLatest.remainingPct}% → ${latest.remainingPct}%），已自动将最新点位作为新周期起点，下次下降 1%～2% 时再打点即可校准。`
    };
  }

  // Find latest decreasing pair ending at `latest`
  let fromMark = null;
  for (let i = validMarks.length - 2; i >= 0; i--) {
    if (validMarks[i].tsMs < latest.tsMs && validMarks[i].remainingPct > latest.remainingPct) {
      fromMark = validMarks[i];
      break;
    }
  }

  if (!fromMark) {
    return {
      pool: targetPool,
      poolLabel,
      status: "no_quota_drop_yet",
      markCount: validMarks.length,
      baselineUsdPerPct: effectiveBaseline,
      baselineSource: effectiveBaselineSource,
      fromMark: prevLatest,
      toMark: latest,
      deltaPct: 0,
      verdictZh: `${poolPrefix}最新两次锚点周额度无变化（均为 ${latest.remainingPct}%），继续正常使用待掉 1%～2% 后再打点即可计算实测倍率。`
    };
  }

  const deltaPct = roundNum(fromMark.remainingPct - latest.remainingPct, 4);
  const windowScan = scanQuotaTranscripts({
    brainRoots,
    windowStartMs: fromMark.tsMs,
    windowEndMs: latest.tsMs,
    pool: targetPool
  });
  const deltaUsd1x = windowScan.totalUsd1x;
  const usdPerPct = deltaPct > 0 ? roundNum(deltaUsd1x / deltaPct, 4) : 0;
  const impliedMultiplier =
    effectiveBaseline !== null && usdPerPct > 0 ? roundNum(effectiveBaseline / usdPerPct, 2) : null;

  const customCalls =
    targetPool === "all"
      ? windowScan.customInvocationCount + windowScan.customAgentAlerts.length
      : windowScan.buckets.custom_agent.conversationCount;
  // #1886 hidden safety reviews run on Gemini (gemini-4-hydrogen-sonar), not the Claude/GPT pool
  const heavyReviews = targetPool === "claude-gpt" ? 0 : safety?.streamRequests?.hiddenHeavy || 0;
  const placeholderCount = diskCustomAgents?.deprecatedCount || 0;

  let status = "pass_1x";
  let verdictZh = "";

  if (deltaUsd1x <= 0.001) {
    status = "insufficient_activity";
    verdictZh = `${poolPrefix}锚点窗口内仅测得 $${deltaUsd1x} 本地对话消耗但周额度下降了 ${deltaPct}%（可能是其他设备/客户端消耗，或尚未落盘）。`;
  } else if (effectiveBaseline === null) {
    if (customCalls > 0) {
      status = "alert_suspected_4x";
      verdictZh = `${poolPrefix}告警（区间每 1% 对应 $${usdPerPct.toFixed(2)}，尚未标定个人 1× 基线）：窗口内直接命中 ${customCalls} 次自定义 Agent 4× 调用，请按下方清单排查对应会话。`;
    } else {
      status = "baseline_uncalibrated";
      const setFlag = targetPool === "gemini" ? "--set-baseline-gemini" : "--set-baseline-claude-gpt";
      verdictZh = `${poolPrefix}实测每 1% 对应 $${usdPerPct.toFixed(2)}（消耗 $${deltaUsd1x.toFixed(3)} / 下降 ${deltaPct}%，窗口内 0 次自定义 Agent 调用），尚未标定该池个人 1× 基线（不同订阅档位与池体量差异大，不盲套全局 $6/1%）。确认本区间正常后可运行 \`--calibrate-baseline\` 或 \`${setFlag} ${usdPerPct.toFixed(2)}\` 锁定为你的 1× 基准线。`;
    }
  } else if (impliedMultiplier !== null && impliedMultiplier <= 1.35 && customCalls === 0) {
    status = "pass_1x";
    verdictZh = `${poolPrefix}实测通过（≈ ${impliedMultiplier}×，每 1% 对应 $${usdPerPct.toFixed(2)}，基线 $${effectiveBaseline.toFixed(2)}）：防 4× 改造已生效，无隐性 4× 扣费。`;
  } else if (impliedMultiplier !== null && impliedMultiplier <= 2.5) {
    status = "warn_elevated";
    const hints = [];
    if (customCalls > 0) hints.push(`窗口内存在 ${customCalls} 次自定义 Agent 相关越界记录`);
    if (heavyReviews > 0) hints.push(`伴随 ${heavyReviews} 次 #1886 后台重型安全审查`);
    if (hints.length === 0) hints.push("可能是模型基线差异或短窗取整误差（建议跨 ≥2% 下降再复核）");
    verdictZh = `${poolPrefix}实测扣额偏高（≈ ${impliedMultiplier}×，每 1% 对应 $${usdPerPct.toFixed(2)}，基线 $${effectiveBaseline.toFixed(2)}）：${hints.join("；")}。`;
  } else {
    status = "alert_suspected_4x";
    if (customCalls > 0) {
      verdictZh = `${poolPrefix}告警（实测 ≈ ${impliedMultiplier}×，每 1% 仅对应 $${usdPerPct.toFixed(2)}，基线 $${effectiveBaseline.toFixed(2)}）：窗口内命中 ${customCalls} 次自定义 Agent 4× 调用，请按下方清单排查对应会话。`;
    } else if (heavyReviews >= 3) {
      verdictZh = `${poolPrefix}告警（实测 ≈ ${impliedMultiplier}×，每 1% 仅对应 $${usdPerPct.toFixed(2)}，基线 $${effectiveBaseline.toFixed(2)}）：未见自定义 Agent 调用，但伴随 ${heavyReviews} 次 #1886 后台重型安全审查，建议切换新窗口止损。`;
    } else if (placeholderCount > 0) {
      verdictZh = `${poolPrefix}告警（实测 ≈ ${impliedMultiplier}×，每 1% 仅对应 $${usdPerPct.toFixed(2)}，基线 $${effectiveBaseline.toFixed(2)}）：未见自定义 Agent 调用且后台审查极少，高度疑似磁盘留存的 ${placeholderCount} 个 DEPRECATED 占位文件引发连坐，建议删除占位后复测。`;
    } else {
      verdictZh = `${poolPrefix}告警（实测 ≈ ${impliedMultiplier}×，每 1% 仅对应 $${usdPerPct.toFixed(2)}，基线 $${effectiveBaseline.toFixed(2)}）：请核查是否有外部 CLI --agent 会话或其他设备共享同一账号额度。`;
    }
  }

  return {
    pool: targetPool,
    poolLabel,
    status,
    markCount: validMarks.length,
    baselineUsdPerPct: effectiveBaseline,
    baselineSource: effectiveBaselineSource,
    fromMark,
    toMark: latest,
    durationMinutes: roundNum((latest.tsMs - fromMark.tsMs) / 60000, 1),
    deltaPct,
    deltaUsd1x,
    usdPerPct,
    impliedMultiplier,
    customCallsInMarkWindow: customCalls,
    verdictZh
  };
}

function calibrationSeverityRank(status) {
  if (status === "alert_suspected_4x") return 5;
  if (status === "warn_elevated") return 4;
  if (status === "insufficient_activity") return 3;
  if (status === "baseline_uncalibrated") return 2;
  if (status === "pass_1x") return 1;
  return 0;
}

export function auditQuota(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.round(Number(options.nowMs)) : Date.now();
  const hours = Number.isFinite(Number(options.hours)) && Number(options.hours) > 0 ? Number(options.hours) : DEFAULT_HOURS;
  const activePool = normalizeQuotaPool(options.pool || "all", { allowAll: true });
  const explicitGlobalBaseline =
    options.baselineUsdPerPct !== undefined &&
    options.baselineUsdPerPct !== null &&
    Number.isFinite(Number(options.baselineUsdPerPct)) &&
    Number(options.baselineUsdPerPct) > 0
      ? Number(options.baselineUsdPerPct)
      : null;
  const explicitGeminiBaseline =
    options.baselineGeminiUsdPerPct !== undefined &&
    options.baselineGeminiUsdPerPct !== null &&
    Number.isFinite(Number(options.baselineGeminiUsdPerPct)) &&
    Number(options.baselineGeminiUsdPerPct) > 0
      ? Number(options.baselineGeminiUsdPerPct)
      : explicitGlobalBaseline;
  const explicitClaudeGptBaseline =
    options.baselineClaudeGptUsdPerPct !== undefined &&
    options.baselineClaudeGptUsdPerPct !== null &&
    Number.isFinite(Number(options.baselineClaudeGptUsdPerPct)) &&
    Number(options.baselineClaudeGptUsdPerPct) > 0
      ? Number(options.baselineClaudeGptUsdPerPct)
      : explicitGlobalBaseline;
  const statePath = options.statePath ? path.resolve(options.statePath) : getDefaultQuotaMarksPath();
  const includeSafety = options.includeSafety !== false;
  const includeDiskAgents = options.includeDiskAgents !== false;

  const recordedMarks = [];
  const baselineActions = [];
  if (options.resetMarks) {
    resetQuotaMarks(statePath, { pool: activePool, clearBaselines: Boolean(options.resetBaselines) });
  } else if (options.resetBaselines) {
    clearQuotaBaseline(statePath, { pool: activePool });
  }
  if (options.setBaselineUsdPerPct !== undefined && options.setBaselineUsdPerPct !== null) {
    const res = setQuotaBaseline(activePool, options.setBaselineUsdPerPct, {
      statePath,
      source: "manual",
      nowMs
    });
    baselineActions.push({ pool: res.pool, action: "saved", usdPerPct: res.baseline.usdPerPct, source: "manual" });
  }
  if (options.setBaselineGeminiUsdPerPct !== undefined && options.setBaselineGeminiUsdPerPct !== null) {
    const res = setQuotaBaseline("gemini", options.setBaselineGeminiUsdPerPct, {
      statePath,
      source: "manual",
      nowMs
    });
    baselineActions.push({ pool: res.pool, action: "saved", usdPerPct: res.baseline.usdPerPct, source: "manual" });
  }
  if (options.setBaselineClaudeGptUsdPerPct !== undefined && options.setBaselineClaudeGptUsdPerPct !== null) {
    const res = setQuotaBaseline("claude-gpt", options.setBaselineClaudeGptUsdPerPct, {
      statePath,
      source: "manual",
      nowMs
    });
    baselineActions.push({ pool: res.pool, action: "saved", usdPerPct: res.baseline.usdPerPct, source: "manual" });
  }
  if (options.markPct !== undefined && options.markPct !== null) {
    recordedMarks.push(
      recordQuotaMark(options.markPct, {
        statePath,
        note: options.markNote || "",
        nowMs,
        pool: activePool
      }).mark
    );
  }
  if (options.markGeminiPct !== undefined && options.markGeminiPct !== null) {
    recordedMarks.push(
      recordQuotaMark(options.markGeminiPct, {
        statePath,
        note: options.markNote || "",
        nowMs,
        pool: "gemini"
      }).mark
    );
  }
  if (options.markClaudeGptPct !== undefined && options.markClaudeGptPct !== null) {
    recordedMarks.push(
      recordQuotaMark(options.markClaudeGptPct, {
        statePath,
        note: options.markNote || "",
        nowMs,
        pool: "claude-gpt"
      }).mark
    );
  }
  const recordedMark = recordedMarks.length === 1 ? recordedMarks[0] : recordedMarks.length > 1 ? recordedMarks[recordedMarks.length - 1] : null;

  let store = loadQuotaMarks(statePath);
  const marksForActivePool =
    activePool === "all" ? store.marks : store.marks.filter((m) => (m.pool || "all") === activePool);
  let windowStartMs = nowMs - Math.round(hours * 3600 * 1000);
  let windowMode = `rolling_${hours}h`;
  if (options.sinceMark && marksForActivePool.length > 0) {
    windowStartMs = marksForActivePool[marksForActivePool.length - 1].tsMs;
    windowMode = activePool === "all" ? "since_latest_mark" : `since_latest_${activePool}_mark`;
  }
  if (Number.isFinite(Number(options.windowStartMs))) {
    windowStartMs = Math.round(Number(options.windowStartMs));
    windowMode = "explicit";
  }

  const transcripts = scanQuotaTranscripts({
    brainRoots: options.brainRoots,
    windowStartMs,
    windowEndMs: nowMs,
    pool: activePool
  });

  const diskAudit = includeDiskAgents
    ? auditCustomAgentsOnly({
        workspace: options.workspace || process.cwd(),
        configDir: options.configDir,
        workspaceOnly: Boolean(options.workspaceOnly)
      })
    : null;

  let safety = null;
  if (includeSafety) {
    const safetyWindowHours = Math.max(1, Math.min(24, Math.round(hours)));
    safety = auditSafetyMonitor({
      ...(Array.isArray(options.safetyLogPaths) && options.safetyLogPaths.length > 0
        ? { logPaths: options.safetyLogPaths }
        : {}),
      ...(options.disableDefaultSafetyDiscovery ? { disableDefaultDiscovery: true } : {}),
      windowHours: safetyWindowHours,
      persistState: false,
      nowMs
    });
  }

  const evalAllPools = (savedBaselines) => ({
    allCalibration: evaluateQuotaCalibration(store.marks, {
      pool: "all",
      baselineUsdPerPct: explicitGlobalBaseline,
      baselineSource: explicitGlobalBaseline !== null ? "cli" : null,
      savedBaselines,
      brainRoots: options.brainRoots,
      safety,
      diskCustomAgents: diskAudit?.customAgents || null
    }),
    poolCalibrations: {
      gemini: evaluateQuotaCalibration(store.marks, {
        pool: "gemini",
        baselineUsdPerPct: explicitGeminiBaseline,
        baselineSource: explicitGeminiBaseline !== null ? "cli" : null,
        savedBaselines,
        brainRoots: options.brainRoots,
        safety,
        diskCustomAgents: diskAudit?.customAgents || null
      }),
      "claude-gpt": evaluateQuotaCalibration(store.marks, {
        pool: "claude-gpt",
        baselineUsdPerPct: explicitClaudeGptBaseline,
        baselineSource: explicitClaudeGptBaseline !== null ? "cli" : null,
        savedBaselines,
        brainRoots: options.brainRoots,
        safety,
        diskCustomAgents: diskAudit?.customAgents || null
      })
    }
  });

  let { allCalibration, poolCalibrations } = evalAllPools(store.baselines);

  // Auto-calibrate personal 1x baselines from clean observed mark windows (refusing 4x-tainted windows)
  if (options.calibrateBaseline) {
    const hasPerPoolAnyMarks = store.marks.some((m) => m.pool === "gemini" || m.pool === "claude-gpt");
    const targetPools =
      activePool !== "all" ? [activePool] : hasPerPoolAnyMarks ? [...TRACKED_QUOTA_POOLS] : ["all"];
    let anySaved = false;
    for (const p of targetPools) {
      const c = p === "all" ? allCalibration : poolCalibrations[p];
      if (!c || !c.fromMark || !c.toMark || !(c.deltaPct > 0) || !(c.deltaUsd1x > 0.001) || !(c.usdPerPct > 0)) {
        baselineActions.push({ pool: p, action: "skipped", reason: "insufficient_clean_drop" });
        continue;
      }
      if ((c.customCallsInMarkWindow || 0) > 0) {
        baselineActions.push({ pool: p, action: "rejected", reason: "custom_agent_4x_detected" });
        continue;
      }
      if (p !== "claude-gpt" && safety?.status === "429_avalanche") {
        baselineActions.push({ pool: p, action: "rejected", reason: "safety_429_avalanche" });
        continue;
      }
      const res = setQuotaBaseline(p, c.usdPerPct, { statePath, source: "calibrated", nowMs });
      baselineActions.push({ pool: p, action: "calibrated", usdPerPct: res.baseline.usdPerPct, source: "calibrated" });
      anySaved = true;
    }
    if (anySaved) {
      store = loadQuotaMarks(statePath);
      ({ allCalibration, poolCalibrations } = evalAllPools(store.baselines));
    }
  }

  let calibration;
  if (activePool !== "all") {
    calibration = poolCalibrations[activePool];
  } else if (allCalibration.markCount > 0) {
    calibration = allCalibration;
  } else {
    const populatedPools = TRACKED_QUOTA_POOLS.map((p) => poolCalibrations[p]).filter((c) => c.markCount > 0);
    if (populatedPools.length === 1) {
      calibration = populatedPools[0];
    } else if (populatedPools.length > 1) {
      populatedPools.sort((a, b) => calibrationSeverityRank(b.status) - calibrationSeverityRank(a.status));
      calibration = populatedPools[0];
    } else {
      calibration = allCalibration;
    }
  }

  const relevantCalibrations =
    activePool !== "all"
      ? [poolCalibrations[activePool]]
      : [allCalibration, poolCalibrations.gemini, poolCalibrations["claude-gpt"]].filter((c) => c.markCount > 0);

  // Top-level health verdict combining all 3 layers (including any per-pool calibration alert)
  const hasCustomAgent4x =
    transcripts.customInvocationCount > 0 ||
    transcripts.customAgentAlerts.length > 0 ||
    (diskAudit?.customAgents?.activeCount || 0) > 0;
  const hasCalibrationAlert = relevantCalibrations.some((c) => c.status === "alert_suspected_4x");
  const hasCalibrationWarn = relevantCalibrations.some((c) => c.status === "warn_elevated");
  const hasHeavySafety =
    safety?.status === "429_avalanche" || (safety?.streamRequests?.hiddenHeavy || 0) >= 3;

  let overallStatus = "clean_1x";
  if (hasCustomAgent4x || hasCalibrationAlert) overallStatus = "alert_4x_risk";
  else if (hasHeavySafety || hasCalibrationWarn) overallStatus = "warn_background_or_elevated";

  const countsByPool = {
    all: store.marks.filter((m) => (m.pool || "all") === "all").length,
    gemini: store.marks.filter((m) => m.pool === "gemini").length,
    "claude-gpt": store.marks.filter((m) => m.pool === "claude-gpt").length
  };

  return stableSortObject({
    schemaVersion: "1.2",
    sampledAt: new Date(nowMs).toISOString(),
    pool: activePool,
    overallStatus,
    window: {
      mode: windowMode,
      hours,
      startAt: new Date(windowStartMs).toISOString(),
      endAt: new Date(nowMs).toISOString()
    },
    layer1CustomAgents: {
      diskActiveCount: diskAudit?.customAgents?.activeCount ?? 0,
      diskDeprecatedCount: diskAudit?.customAgents?.deprecatedCount ?? 0,
      diskItems: diskAudit?.customAgents?.items ?? [],
      invocationsInWindowCount: transcripts.invocationsInWindowCount,
      builtinInvocationCount: transcripts.builtinInvocationCount,
      customInvocationCount: transcripts.customInvocationCount,
      customAgentUsd1x: transcripts.buckets.custom_agent.usd1x,
      customExtra3xUsd: transcripts.customExtra3xUsd,
      alerts: transcripts.customAgentAlerts
    },
    layer2SafetyMonitor: safety
      ? {
          status: safety.status,
          severity: safety.severity,
          summaryZh: safety.summaryZh,
          hiddenPrecheck: safety.streamRequests?.hiddenPrecheck ?? 0,
          hiddenHeavy: safety.streamRequests?.hiddenHeavy ?? 0,
          hiddenSharePct: safety.streamRequests?.hiddenSharePct ?? 0,
          recentHeavyEvents: (safety.recentHeavyEvents || []).slice(-5)
        }
      : null,
    layer3Billing: {
      activeConversationCount: transcripts.activeConversationCount,
      totalSteps: transcripts.totalSteps,
      totalInputTokens: transcripts.totalInputTokens,
      totalCacheReadTokens: transcripts.totalCacheReadTokens,
      totalOutputTokens: transcripts.totalOutputTokens,
      overallCacheHitPct: transcripts.overallCacheHitPct,
      totalUsd1x: transcripts.totalUsd1x,
      estimatedEffectiveUsd: transcripts.estimatedEffectiveUsd,
      totalCacheSavingsUsd: transcripts.totalCacheSavingsUsd,
      buckets: transcripts.buckets,
      pools: transcripts.pools,
      topConversations: transcripts.conversations.slice(0, 10)
    },
    calibration,
    poolCalibrations,
    baselines: {
      saved: store.baselines,
      actions: baselineActions
    },
    marks: {
      statePath,
      recordedNow: recordedMark,
      recordedMarks,
      count: store.marks.length,
      countsByPool,
      recent: store.marks.slice(-6)
    }
  });
}

function fmtUsd(n) {
  return `$${Number(n || 0).toFixed(3)}`;
}

export function formatQuotaAuditMarkdown(report) {
  const l1 = report.layer1CustomAgents;
  const l2 = report.layer2SafetyMonitor;
  const l3 = report.layer3Billing;
  const cal = report.calibration;

  const badge =
    report.overallStatus === "clean_1x"
      ? "PASS · 1× 正常（无自定义 Agent 4× 风险）"
      : report.overallStatus === "alert_4x_risk"
        ? "ALERT · 存在 4× 自定义 Agent 风险或倍率异常"
        : "WARN · 零 4× 调用，但存在后台安全审查(#1886)或偏高消耗";

  const lines = [
    "# agy-dart Quota Attribution & #1890 4× Sentinel",
    "",
    `- **综合判定**: **${badge}**`,
    `- **统计窗口**: \`${report.window.startAt}\` → \`${report.window.endAt}\` (${report.window.mode})`,
    `- **全机 1× 等效账单**: **${fmtUsd(l3.totalUsd1x)}**（缓存命中 **${l3.overallCacheHitPct}%**，缓存省下 ${fmtUsd(l3.totalCacheSavingsUsd)}；含 4× 越界估算总计 ${fmtUsd(l3.estimatedEffectiveUsd)}）`,
    "",
    "## 1. #1890 自定义 Agent 4× 越界哨兵",
    "",
    `- **本机磁盘 \`agents/*.md\`**: 活跃 **${l1.diskActiveCount}** 个 · \`DEPRECATED\` 过渡占位 **${l1.diskDeprecatedCount}** 个`,
    `- **窗口内 \`invoke_subagent\`**: 共 **${l1.invocationsInWindowCount}** 次（官方 1× 内置 **${l1.builtinInvocationCount}** 次 · 非内置 4× 自定义 **${l1.customInvocationCount}** 次）`,
    `- **自定义 Agent 谱系消耗**: 1× 基准 ${fmtUsd(l1.customAgentUsd1x)} · 额外 3× 溢价损失 **${fmtUsd(l1.customExtra3xUsd)}**`
  ];

  if (l1.alerts.length > 0) {
    lines.push("", "**[ALERT] 命中 4× 自定义 Agent 越界记录：**");
    for (const a of l1.alerts) {
      lines.push(
        `- \`${a.kind}\`: type=\`${a.typeName}\` · parent=\`${a.parentConvId || "—"}\` · child=\`${a.childConvId || "—"}\``
      );
    }
  }
  lines.push("");

  lines.push("## 2. #1886 后台安全审查归因（与 4× 独立区分）", "");
  if (!l2) {
    lines.push("_已跳过后台安全审查扫描（`--no-safety`）。_", "");
  } else {
    lines.push(
      `- **状态**: \`${l2.status}\` (${l2.severity}) — ${l2.summaryZh}`,
      `- **后台请求统计**: 轻量预检 **${l2.hiddenPrecheck}** 次 · 重型复审 **${l2.hiddenHeavy}** 次（占总流请求 ${l2.hiddenSharePct}%）`,
      ""
    );
  }

  lines.push("## 3. 多会话 1× 账单拆解（主会话 vs 官方内置 vs 自定义）", "");
  if (report.pool && report.pool !== "all") {
    lines.push(`- **当前过滤模型池**: \`${report.pool}\`（${QUOTA_POOL_LABELS[report.pool] || report.pool}）`, "");
  }
  lines.push("| 分类 | 会话数 | 步数 | 非缓存输入 | 缓存读取 | 输出 | 1× 等效美元 |");
  lines.push("| :--- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [label, key] of [
    ["默认主会话 (1×)", "main"],
    ["官方内置子智能体 (1×)", "builtin_subagent"],
    ["自定义 Agent 及其后代 (4×)", "custom_agent"]
  ]) {
    const b = l3.buckets[key];
    lines.push(
      `| ${label} | ${b.conversationCount} | ${b.steps} | ${b.inputTokens.toLocaleString("en-US")} | ${b.cacheReadTokens.toLocaleString("en-US")} | ${b.outputTokens.toLocaleString("en-US")} | ${fmtUsd(b.usd1x)} |`
    );
  }
  if (l3.pools) {
    lines.push("", "### 按模型周额度池分桶（Gemini vs Claude/GPT）", "");
    lines.push("| 模型池 | 涉及会话 | 步数 | 非缓存输入 | 缓存读取 | 输出 | 1× 等效美元 |");
    lines.push("| :--- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const poolKey of ["gemini", "claude-gpt", "other"]) {
      const pb = l3.pools[poolKey];
      if (!pb || (poolKey === "other" && pb.steps === 0)) continue;
      lines.push(
        `| ${QUOTA_POOL_LABELS[poolKey]} | ${pb.conversationCount} | ${pb.steps} | ${pb.inputTokens.toLocaleString("en-US")} | ${pb.cacheReadTokens.toLocaleString("en-US")} | ${pb.outputTokens.toLocaleString("en-US")} | ${fmtUsd(pb.usd1x)} |`
      );
    }
  }
  lines.push("");

  const baselineSourceLabel = (src) =>
    src === "saved" ? "已标定个人基线" : src === "cli" ? "命令行基线" : src === "default" ? "默认基线" : "未标定";

  const renderCalibrationBlock = (c, headingPrefix = "") => {
    lines.push(`- **${headingPrefix}校准结论**: ${c.verdictZh}`);
    if (c.fromMark && c.toMark) {
      lines.push(
        `- **${headingPrefix}锚点区间**: \`${c.fromMark.ts}\` (${c.fromMark.remainingPct}%) → \`${c.toMark.ts}\` (${c.toMark.remainingPct}%)，下降 **${c.deltaPct}%**`
      );
    }
    if (c.impliedMultiplier !== undefined && c.impliedMultiplier !== null) {
      lines.push(
        `- **${headingPrefix}实测折算**: 区间 1× 理论花费 **${fmtUsd(c.deltaUsd1x)}** · 每 1% 对应 **$${Number(c.usdPerPct).toFixed(2)}**（${baselineSourceLabel(c.baselineSource)} $${Number(c.baselineUsdPerPct).toFixed(2)}）→ 推算倍率 **${c.impliedMultiplier}×**`
      );
    } else if (c.status === "baseline_uncalibrated" && c.usdPerPct > 0) {
      lines.push(
        `- **${headingPrefix}实测折算**: 区间 1× 理论花费 **${fmtUsd(c.deltaUsd1x)}** · 每 1% 对应 **$${Number(c.usdPerPct).toFixed(2)}**（尚未标定个人 1× 基线）`
      );
    }
  };

  lines.push("## 4. 真实周额度倍率校准（锚点法）", "");
  const poolCals = report.poolCalibrations;
  const hasPerPoolMarks = Boolean(
    poolCals && TRACKED_QUOTA_POOLS.some((p) => (poolCals[p]?.markCount || 0) > 0)
  );
  if (report.pool && report.pool !== "all") {
    renderCalibrationBlock(cal, `${QUOTA_POOL_LABELS[report.pool]} · `);
  } else if (hasPerPoolMarks) {
    if ((report.marks?.countsByPool?.all || 0) > 0 && cal.pool === "all") {
      renderCalibrationBlock(cal, "全池 · ");
    }
    for (const p of TRACKED_QUOTA_POOLS) {
      const pc = poolCals[p];
      if (!pc) continue;
      renderCalibrationBlock(pc, `${QUOTA_POOL_LABELS[p]} · `);
    }
  } else {
    renderCalibrationBlock(cal);
  }
  const savedBaselines = report.baselines?.saved || {};
  const savedKeys = Object.keys(savedBaselines);
  if (savedKeys.length > 0) {
    const bSummary = savedKeys
      .sort(compareAscii)
      .map((k) => `${k}=$${Number(savedBaselines[k].usdPerPct).toFixed(2)}/1%`)
      .join(", ");
    lines.push(`- **已标定个人 1× 基线**: ${bSummary}`);
  }
  const counts = report.marks?.countsByPool;
  const countDetail = counts
    ? `已存 ${report.marks.count} 条：gemini=${counts.gemini}, claude-gpt=${counts["claude-gpt"]}, all=${counts.all}`
    : `已存 ${report.marks.count} 条`;
  lines.push(
    `- **锚点文件**: \`${report.marks.statePath}\`（${countDetail}；双池打点：\`node bin/agy-dart.mjs audit quota --mark-gemini <剩余%> --mark-claude-gpt <剩余%>\`）`
  );

  return lines.join("\n");
}

export function parseCliArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    hours: DEFAULT_HOURS,
    pool: "all",
    sinceMark: false,
    markPct: null,
    markGeminiPct: null,
    markClaudeGptPct: null,
    markNote: "",
    listMarks: false,
    resetMarks: false,
    resetBaselines: false,
    calibrateBaseline: false,
    baselineUsdPerPct: null,
    baselineGeminiUsdPerPct: null,
    baselineClaudeGptUsdPerPct: null,
    setBaselineUsdPerPct: null,
    setBaselineGeminiUsdPerPct: null,
    setBaselineClaudeGptUsdPerPct: null,
    workspace: process.cwd(),
    configDir: undefined,
    workspaceOnly: false,
    statePath: undefined,
    brainRoots: [],
    includeSafety: true,
    json: false,
    help: false
  };

  const parsePctOpt = (flag, rawVal) => {
    const n = Number(rawVal);
    if (rawVal === undefined || rawVal === "" || !Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`Invalid ${flag} value '${rawVal}'. Expected quota remaining percentage 0..100.`);
    }
    return n;
  };
  const parsePositiveUsdOpt = (flag, rawVal) => {
    const n = Number(rawVal);
    if (!rawVal || !Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid ${flag} value '${rawVal}'. Expected positive USD per 1%.`);
    }
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--since-mark") {
      opts.sinceMark = true;
    } else if (a === "--list-marks") {
      opts.listMarks = true;
    } else if (a === "--reset-marks") {
      opts.resetMarks = true;
    } else if (a === "--reset-baselines") {
      opts.resetBaselines = true;
    } else if (a === "--calibrate-baseline") {
      opts.calibrateBaseline = true;
    } else if (a === "--no-safety") {
      opts.includeSafety = false;
    } else if (a === "--workspace-only") {
      opts.workspaceOnly = true;
    } else if (a === "--pool" || a.startsWith("--pool=")) {
      const next = a.includes("=") ? a.slice("--pool=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing value after --pool");
      opts.pool = normalizeQuotaPool(next, { allowAll: true });
    } else if (a === "--hours" || a.startsWith("--hours=")) {
      const next = a.includes("=") ? a.slice("--hours=".length) : args[++i];
      const n = Number(next);
      if (!next || !Number.isFinite(n) || n <= 0 || n > 720) {
        throw new Error(`Invalid --hours value '${next}'. Expected positive number <= 720.`);
      }
      opts.hours = n;
    } else if (a === "--mark" || a.startsWith("--mark=")) {
      const next = a.includes("=") ? a.slice("--mark=".length) : args[++i];
      opts.markPct = parsePctOpt("--mark", next);
    } else if (a === "--mark-gemini" || a.startsWith("--mark-gemini=")) {
      const next = a.includes("=") ? a.slice("--mark-gemini=".length) : args[++i];
      opts.markGeminiPct = parsePctOpt("--mark-gemini", next);
    } else if (
      a === "--mark-claude-gpt" ||
      a.startsWith("--mark-claude-gpt=") ||
      a === "--mark-claude" ||
      a.startsWith("--mark-claude=")
    ) {
      const eq = a.indexOf("=");
      const next = eq >= 0 ? a.slice(eq + 1) : args[++i];
      opts.markClaudeGptPct = parsePctOpt("--mark-claude-gpt", next);
    } else if (a === "--note" || a.startsWith("--note=")) {
      const next = a.includes("=") ? a.slice("--note=".length) : args[++i];
      if (next === undefined) throw new Error("Missing value after --note");
      opts.markNote = next;
    } else if (a === "--baseline-usd" || a.startsWith("--baseline-usd=")) {
      const next = a.includes("=") ? a.slice("--baseline-usd=".length) : args[++i];
      opts.baselineUsdPerPct = parsePositiveUsdOpt("--baseline-usd", next);
    } else if (a === "--baseline-gemini" || a.startsWith("--baseline-gemini=")) {
      const next = a.includes("=") ? a.slice("--baseline-gemini=".length) : args[++i];
      opts.baselineGeminiUsdPerPct = parsePositiveUsdOpt("--baseline-gemini", next);
    } else if (
      a === "--baseline-claude-gpt" ||
      a.startsWith("--baseline-claude-gpt=") ||
      a === "--baseline-claude" ||
      a.startsWith("--baseline-claude=")
    ) {
      const eq = a.indexOf("=");
      const next = eq >= 0 ? a.slice(eq + 1) : args[++i];
      opts.baselineClaudeGptUsdPerPct = parsePositiveUsdOpt("--baseline-claude-gpt", next);
    } else if (a === "--set-baseline" || a.startsWith("--set-baseline=")) {
      const next = a.includes("=") ? a.slice("--set-baseline=".length) : args[++i];
      opts.setBaselineUsdPerPct = parsePositiveUsdOpt("--set-baseline", next);
    } else if (a === "--set-baseline-gemini" || a.startsWith("--set-baseline-gemini=")) {
      const next = a.includes("=") ? a.slice("--set-baseline-gemini=".length) : args[++i];
      opts.setBaselineGeminiUsdPerPct = parsePositiveUsdOpt("--set-baseline-gemini", next);
    } else if (
      a === "--set-baseline-claude-gpt" ||
      a.startsWith("--set-baseline-claude-gpt=") ||
      a === "--set-baseline-claude" ||
      a.startsWith("--set-baseline-claude=")
    ) {
      const eq = a.indexOf("=");
      const next = eq >= 0 ? a.slice(eq + 1) : args[++i];
      opts.setBaselineClaudeGptUsdPerPct = parsePositiveUsdOpt("--set-baseline-claude-gpt", next);
    } else if (a === "--workspace" || a.startsWith("--workspace=")) {
      const next = a.includes("=") ? a.slice("--workspace=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --workspace");
      opts.workspace = path.resolve(next);
    } else if (a === "--config-dir" || a.startsWith("--config-dir=")) {
      const next = a.includes("=") ? a.slice("--config-dir=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --config-dir");
      opts.configDir = path.resolve(next);
    } else if (a === "--state-path" || a.startsWith("--state-path=")) {
      const next = a.includes("=") ? a.slice("--state-path=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --state-path");
      opts.statePath = path.resolve(next);
    } else if (a === "--brain-root" || a.startsWith("--brain-root=")) {
      const next = a.includes("=") ? a.slice("--brain-root=".length) : args[++i];
      if (!next || (!a.includes("=") && next.startsWith("-"))) throw new Error("Missing path after --brain-root");
      opts.brainRoots.push(path.resolve(next));
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`agy-dart Quota Attribution & #1890 4x Custom-Agent Sentinel

Usage:
  node bin/agy-dart.mjs audit quota [options]
  npm run quota:audit -- [options]

Options:
  --hours <1..720>                 Rolling transcript & safety window in hours (default: ${DEFAULT_HOURS})
  --pool <all|gemini|claude-gpt>   Filter billing/marks to one model quota pool (default: all)
  --since-mark                     Measure transcript usage since the most recent saved quota mark
  --mark <0..100>                  Record remaining weekly quota % for --pool (default: all)
  --mark-gemini <0..100>           Record remaining weekly quota % for the Gemini model pool
  --mark-claude-gpt <0..100>       Record remaining weekly quota % for the Claude/GPT model pool (alias: --mark-claude)
  --note <text>                    Optional note attached to --mark*
  --list-marks                     Show saved weekly quota marks & personal baselines (filtered by --pool when set)
  --reset-marks                    Clear saved weekly quota marks (preserves saved baselines unless --reset-baselines)
  --calibrate-baseline             Save clean observed USD/1% from current mark drops as your personal 1x baseline
  --set-baseline <num>             Persist personal 1x USD/1% baseline for --pool
  --set-baseline-gemini <num>      Persist personal 1x USD/1% baseline for the Gemini pool
  --set-baseline-claude-gpt <num>  Persist personal 1x USD/1% baseline for the Claude/GPT pool (alias: --set-baseline-claude)
  --reset-baselines                Clear saved personal 1x baselines (filtered by --pool when set)
  --baseline-usd <num>             One-off 1x equivalent USD/1% override (default for --pool all: ${DEFAULT_BASELINE_USD_PER_PCT})
  --baseline-gemini <num>          One-off 1x USD/1% override for the Gemini pool
  --baseline-claude-gpt <num>      One-off 1x USD/1% override for the Claude/GPT pool
  --workspace <dir>                Workspace root for disk agents/*.md scan (default: cwd)
  --config-dir <dir>               Antigravity config root (default: ~/.gemini/config)
  --workspace-only                 Only scan workspace agents/*.md (skip global/plugins)
  --state-path <file>              Override quota-marks.json path
  --brain-root <dir>               Override Antigravity brain root (repeatable)
  --no-safety                      Skip #1886 background safety-monitor log scan
  --json                           Output machine-readable JSON
  -h, --help                       Show this help
`);
}

function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.listMarks) {
    const statePath = opts.statePath || getDefaultQuotaMarksPath();
    const store = loadQuotaMarks(statePath);
    const marks = opts.pool === "all" ? store.marks : store.marks.filter((m) => (m.pool || "all") === opts.pool);
    const baselines =
      opts.pool === "all"
        ? store.baselines
        : store.baselines[opts.pool]
          ? { [opts.pool]: store.baselines[opts.pool] }
          : {};
    if (opts.json) {
      process.stdout.write(JSON.stringify({ statePath, pool: opts.pool, baselines, marks }, null, 2) + "\n");
    } else {
      const bKeys = Object.keys(baselines).sort(compareAscii);
      if (bKeys.length > 0) {
        process.stdout.write(
          `Saved personal 1x baselines: ${bKeys.map((k) => `[${k}] $${Number(baselines[k].usdPerPct).toFixed(2)}/1% (${baselines[k].source})`).join(" | ")}\n`
        );
      }
      if (marks.length === 0) {
        process.stdout.write(`No quota marks saved in ${statePath}${opts.pool !== "all" ? ` for pool '${opts.pool}'` : ""}.\n`);
      } else {
        for (const m of marks) {
          process.stdout.write(`${m.ts}  [${m.pool || "all"}]  ${m.remainingPct}%${m.note ? `  (${m.note})` : ""}\n`);
        }
      }
    }
    return;
  }
  const report = auditQuota({
    ...opts,
    brainRoots: opts.brainRoots.length > 0 ? opts.brainRoots : undefined
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatQuotaAuditMarkdown(report) + "\n");
  }
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`quota:audit error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
