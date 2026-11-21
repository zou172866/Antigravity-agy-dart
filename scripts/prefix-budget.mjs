#!/usr/bin/env node
/**
 * agy-dart Turn-0 Prefix Budget & Schema Determinism Auditor.
 * Measures the 4 always-loaded prompt prefix blocks:
 *   1. brake     (rules/AGENTS.md)
 *   2. reference (skills/agy-dart/SKILL.md YAML frontmatter vs on-demand body)
 *   3. tools     (live JSON-RPC tools/list from fast/mcp-server.mjs & context/server.js + SHA-256 fingerprints)
 *   4. startup   (live hooks/session-start.mjs output split into stable prefix vs volatile Git tail)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  extractStepTokenUsage,
  findTranscriptForConversation,
  isSubagentStep,
  parseTranscriptLines
} from "../context/lib/cache-analyzer.js";
import { sha256Hex, stableSortObject, stableStringify } from "../context/lib/stable-json.js";
import { getEffectiveConfig } from "../context/lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TOKEN_WARN_LIMIT = 4000;

function isCjkCodePoint(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, punctuation, Kana, Bopomofo, Unified Ideographs & Ext A
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xffef) || // Fullwidth & Halfwidth Forms
    (cp >= 0x20000 && cp <= 0x2fa1f)  // CJK Ext B-F & Compat Supplement
  );
}

/**
 * CJK/UTF-8 aware token estimator (zero-dependency):
 * - Pure ASCII: 0.25 tok/char (exact match to chars/4)
 * - CJK / Kana / Hangul / fullwidth: 1.25 tok/char (within empirical ~1.0-1.5 tok/char range)
 * - Other non-ASCII BMP (accented Latin, Cyrillic, symbols): 1.0 tok/char
 * - Supplementary plane / emoji (> 0xFFFF, non-CJK): 1.5 tok/char
 * - Numeric fallback: Math.ceil(Math.max(0, n) / 4)
 */
export function estimateTokens(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return 0;
    return Math.ceil(input / 4);
  }
  if (typeof input !== "string" || input.length === 0) {
    return 0;
  }
  // Track in quarter-token integers (exact, zero IEEE-754 rounding drift)
  let quarterTokens = 0;
  for (let i = 0; i < input.length; ) {
    const cp = input.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      quarterTokens += 1; // 0.25 tok/char
    } else if (isCjkCodePoint(cp)) {
      quarterTokens += 5; // 1.25 tok/char
    } else if (cp > 0xffff) {
      quarterTokens += 6; // 1.50 tok/char (emoji / astral symbols)
    } else {
      quarterTokens += 4; // 1.00 tok/char (other non-ASCII)
    }
  }
  return Math.ceil(quarterTokens / 4);
}

/**
 * Empirical cross-script calibration corpus with reference BPE/SentencePiece token counts
 * (measured across cl100k_base / Claude / Gemini tokenizers). Used to quantify estimator
 * error bounds and prevent hidden Turn-0 budget overruns.
 */
export const TOKEN_CALIBRATION_CORPUS = Object.freeze([
  {
    id: "ascii-js-code",
    text: 'export function computeBudget(items) {\n  return items.reduce((acc, item) => acc + Math.max(0, item.bytes), 0);\n}\n',
    actualTokens: 29
  },
  {
    id: "mcp-json-schema",
    text: '{"name":"batch_search","description":"Run 1-20 concurrent search queries","inputSchema":{"type":"object","properties":{"queries":{"type":"array"}},"required":["queries"]}}',
    actualTokens: 43
  },
  {
    id: "markdown-rules",
    text: "# Tool Routing\n- Use `batch_search` for >=2 text/regex/glob queries.\n- Use `apply_edits` for multi-file edits + inline verify.\n- Keep inline output <= 8.8 KB UTF-8.\n",
    actualTokens: 44
  },
  {
    id: "cjk-prose",
    text: "本项目面向原生一体化插件，提供极速批处理、沙盒过滤、上下文护栏与服务端缓存诊断，严格遵循零运行期依赖约束。",
    actualTokens: 58
  },
  {
    id: "mixed-cjk-code",
    text: "调用 `ctx_execute({ language: 'python' })` 过滤超大日志（>16 KB），输出严格控制在 <= 8.8 KB 内联预算。",
    actualTokens: 46
  }
]);

export const ESTIMATOR_ERROR_BAND_PCT = 15;

/**
 * Evaluate `estimateTokens` against a set of `{ id, text, actualTokens }` samples
 * (either built-in corpus or real transcript `usageMetadata` samples).
 */
export function calibrateTokenEstimator(samples = TOKEN_CALIBRATION_CORPUS) {
  const details = [];
  let absErrSum = 0;
  let relErrSum = 0;
  let signedRelSum = 0;
  let maxRelErr = 0;

  for (const s of samples) {
    if (!s || typeof s.text !== "string" || !Number.isFinite(s.actualTokens) || s.actualTokens <= 0) {
      continue;
    }
    const estimated = estimateTokens(s.text);
    const diff = estimated - s.actualTokens;
    const relErr = Math.abs(diff) / s.actualTokens;
    const signedRel = diff / s.actualTokens;
    absErrSum += Math.abs(diff);
    relErrSum += relErr;
    signedRelSum += signedRel;
    if (relErr > maxRelErr) maxRelErr = relErr;
    details.push({
      id: s.id || "sample",
      actualTokens: s.actualTokens,
      estimatedTokens: estimated,
      errorTokens: diff,
      relErrorPct: Number((relErr * 100).toFixed(1))
    });
  }

  const n = details.length;
  return {
    sampleCount: n,
    maeTokens: n > 0 ? Number((absErrSum / n).toFixed(2)) : 0,
    mapePct: n > 0 ? Number(((relErrSum / n) * 100).toFixed(1)) : 0,
    maxRelErrorPct: Number((maxRelErr * 100).toFixed(1)),
    meanBiasPct: n > 0 ? Number(((signedRelSum / n) * 100).toFixed(1)) : 0,
    recommendedErrorBandPct: ESTIMATOR_ERROR_BAND_PCT,
    samples: details
  };
}

function hasNonEmptyValue(val) {
  if (val === null || val === undefined || val === false) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === "string") return val.trim().length > 0;
  if (typeof val === "object") return Object.keys(val).length > 0;
  return Boolean(val);
}

function inspectStepCalibrationSignals(step) {
  if (!step || typeof step !== "object") {
    return {
      text: "",
      hasMedia: false,
      hasToolCalls: false,
      hasThinking: false,
      hasSystemInjection: false,
      hasTruncatedText: false,
      isSubagent: false
    };
  }
  const typeStr = String(step.type || "");
  const isSubagent = Boolean(
    isSubagentStep(step) ||
      step.parent_conversation_id ||
      step.parentConversationId ||
      /subagent/i.test(typeStr)
  );
  const hasSystemInjection = Boolean(
    hasNonEmptyValue(step.systemMessage) ||
      hasNonEmptyValue(step.system_message) ||
      hasNonEmptyValue(step.injectSteps) ||
      hasNonEmptyValue(step.system_instruction) ||
      /^(?:SYSTEM_MESSAGE|SYSTEM_INJECTION)$/i.test(typeStr)
  );
  const contentArr = Array.isArray(step.content) ? step.content : null;
  const hasMedia = Boolean(
    hasNonEmptyValue(step.media) ||
      hasNonEmptyValue(step.images) ||
      typeStr.toLowerCase() === "image" ||
      (contentArr &&
        contentArr.some((p) => p && typeof p === "object" && (p.type === "image" || p.type === "image_url" || p.type === "media")))
  );
  const hasToolCalls = Boolean(
    (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) ||
      (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) ||
      step.function_call ||
      step.functionCall ||
      step.tool_use ||
      step.toolCall ||
      /tool_?call|function_?call|tool_?use/i.test(typeStr) ||
      (contentArr &&
        contentArr.some(
          (p) => p && typeof p === "object" && (p.type === "tool_use" || p.type === "tool_call" || p.type === "function_call")
        ))
  );
  const hasThinking = Boolean(
    (typeof step.thinking === "string" && step.thinking.trim().length > 0) ||
      (typeof step.reasoning === "string" && step.reasoning.trim().length > 0) ||
      (typeof step.thoughts === "string" && step.thoughts.trim().length > 0) ||
      (contentArr &&
        contentArr.some((p) => p && typeof p === "object" && (p.type === "thinking" || p.type === "reasoning")))
  );
  const truncFields = Array.isArray(step.truncated_fields)
    ? step.truncated_fields
    : Array.isArray(step.truncatedFields)
      ? step.truncatedFields
      : [];
  const hasTruncatedText = truncFields.some(
    (f) => typeof f === "string" && /^(?:content|output|result|tool_result|text|user_input|response)$/i.test(f.trim())
  );

  const parts = [];
  for (const key of ["content", "output", "result", "user_input", "text"]) {
    const val = step[key];
    if (typeof val === "string" && val) {
      parts.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") parts.push(item);
        else if (item && typeof item === "object" && typeof item.text === "string") parts.push(item.text);
      }
    }
  }
  if (step.tool_result !== undefined) {
    parts.push(typeof step.tool_result === "string" ? step.tool_result : JSON.stringify(step.tool_result));
  }
  return {
    text: parts.join("\n"),
    hasMedia,
    hasToolCalls,
    hasThinking,
    hasSystemInjection,
    hasTruncatedText,
    isSubagent
  };
}

/**
 * Extract empirical `{ id, text, actualTokens }` calibration pairs from real transcript
 * steps using actual provider `usageMetadata` / `input_tokens` context deltas between turns,
 * while filtering out structurally noisy turns (uncounted tool calls, thinking-token accounting
 * mismatches, media, system injections, truncated content, subagent interleaving, model switches, compaction).
 */
export function extractTranscriptCalibrationReport(steps = [], { minActualTokens = 50, minChars = 100 } = {}) {
  const samples = [];
  const skippedByReason = {};
  let skippedCount = 0;

  const recordSkip = (reason) => {
    skippedCount += 1;
    skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
  };

  if (!Array.isArray(steps) || steps.length === 0) {
    return { samples, skippedCount, skippedByReason };
  }

  let prevCtx = null;
  let prevOut = 0;
  let prevModel = null;
  let prevNoiseReason = null;
  let accParts = [];
  let windowNoiseReason = null;

  const flagWindowNoise = (reason) => {
    if (!windowNoiseReason) windowNoiseReason = reason;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") continue;

    const sig = inspectStepCalibrationSignals(step);

    // Direct single-step labeled sample (supports Gemini usageMetadata, Claude/OpenAI usage, and skips short samples without polluting prevCtx)
    const isDirectLabeledStep = Boolean(
      typeof step.text === "string" &&
        (step.usageMetadata || step.usage || step.usage_metadata) &&
        prevCtx === null &&
        accParts.length === 0 &&
        step.content === undefined &&
        step.user_input === undefined &&
        step.tool_result === undefined
    );
    if (isDirectLabeledStep) {
      const directUsage = extractStepTokenUsage(step);
      const directTok =
        directUsage.contextTokens > 0
          ? directUsage.contextTokens
          : Number(
              step.usageMetadata?.totalTokenCount ??
                step.usage?.total_tokens ??
                step.usage_metadata?.total_token_count ??
                0
            );
      if (!Number.isFinite(directTok) || directTok < minActualTokens || step.text.length < minChars) {
        continue;
      }
      if (sig.isSubagent) {
        recordSkip("subagent_interleaved");
        continue;
      }
      if (sig.hasMedia) {
        recordSkip("media");
        continue;
      }
      if (sig.hasSystemInjection) {
        recordSkip("system_injection");
        continue;
      }
      if (sig.hasTruncatedText) {
        recordSkip("truncated_content");
        continue;
      }
      if ((directUsage?.thinkingTokens || 0) > 0 || sig.hasThinking) {
        recordSkip("thinking_mismatch");
        continue;
      }
      if (sig.hasToolCalls) {
        recordSkip("uncounted_tool_calls");
        continue;
      }
      samples.push({
        id: String(step.id || `step#${step.step_index ?? i}`),
        text: step.text,
        actualTokens: Math.round(directTok)
      });
      continue;
    }

    const usage = extractStepTokenUsage(step);
    const hasUsage = Boolean(usage && usage.contextTokens > 0);
    if (hasUsage) {
      const currModel = typeof step.model === "string" && step.model.trim() ? step.model.trim() : null;
      if (prevCtx !== null && accParts.length > 0) {
        let skipReason = null;
        if (sig.isSubagent) skipReason = "subagent_interleaved";
        else if (sig.hasMedia) skipReason = "media";
        else if (sig.hasSystemInjection) skipReason = "system_injection";
        else if (sig.hasTruncatedText) skipReason = "truncated_content";
        else if (prevNoiseReason) skipReason = prevNoiseReason;
        else if (windowNoiseReason) skipReason = windowNoiseReason;
        else if (prevModel && currModel && prevModel !== currModel) skipReason = "model_switch";
        else if (usage.contextTokens <= prevCtx) skipReason = "compaction_or_reset";
        else {
          const text = accParts.join("\n");
          const actualDelta = usage.contextTokens - prevCtx - prevOut;
          if (actualDelta <= 0) {
            skipReason = "accounting_mismatch";
          } else if (actualDelta >= minActualTokens && text.length >= minChars) {
            samples.push({
              id: `turn#${step.step_index ?? i}`,
              text,
              actualTokens: Math.round(actualDelta)
            });
          }
        }
        if (skipReason) {
          recordSkip(skipReason);
        }
      }

      prevCtx = usage.contextTokens;
      prevOut = usage.outputTokens || 0;
      if (currModel) prevModel = currModel;
      if (sig.isSubagent) {
        prevNoiseReason = "subagent_interleaved";
      } else if (sig.hasMedia) {
        prevNoiseReason = "media";
      } else if (sig.hasSystemInjection) {
        prevNoiseReason = "system_injection";
      } else if (sig.hasTruncatedText) {
        prevNoiseReason = "truncated_content";
      } else if ((usage.thinkingTokens || 0) > 0 || sig.hasThinking) {
        prevNoiseReason = "thinking_mismatch";
      } else if (sig.hasToolCalls) {
        prevNoiseReason = "uncounted_tool_calls";
      } else {
        prevNoiseReason = null;
      }
      accParts = [];
      windowNoiseReason = null;
    } else {
      if (sig.isSubagent) flagWindowNoise("subagent_interleaved");
      if (sig.hasMedia) flagWindowNoise("media");
      if (sig.hasToolCalls) flagWindowNoise("uncounted_tool_calls");
      if (sig.hasThinking) flagWindowNoise("thinking_mismatch");
      if (sig.hasSystemInjection) flagWindowNoise("system_injection");
      if (sig.hasTruncatedText) flagWindowNoise("truncated_content");
      if (sig.text) accParts.push(sig.text);
    }
  }

  return { samples, skippedCount, skippedByReason };
}

/**
 * Extract empirical `{ id, text, actualTokens }` calibration pairs from real transcript
 * steps using actual provider `usageMetadata` / `input_tokens` context deltas between turns.
 */
export function extractTranscriptCalibrationSamples(steps = [], opts = {}) {
  return extractTranscriptCalibrationReport(steps, opts).samples;
}

const MAX_CALIBRATION_TRANSCRIPT_BYTES = 16 * 1024 * 1024; // Cap memory when calibrating against huge transcript_full.jsonl

function readBoundedTranscriptSteps(filePath, maxBytes = MAX_CALIBRATION_TRANSCRIPT_BYTES) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const startOffset = stat.size > maxBytes ? stat.size - maxBytes : 0;
    const totalToRead = stat.size - startOffset;
    fd = fs.openSync(filePath, "r");
    const chunkBuf = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(4096, totalToRead)));
    const decoder = new StringDecoder("utf8");
    const steps = [];
    let pos = startOffset;
    let remaining = totalToRead;
    let carry = "";
    let skipFirstPartial = startOffset > 0;

    while (remaining > 0) {
      const toRead = Math.min(chunkBuf.length, remaining);
      const nRead = fs.readSync(fd, chunkBuf, 0, toRead, pos);
      if (nRead <= 0) break;
      pos += nRead;
      remaining -= nRead;
      const text = carry + decoder.write(chunkBuf.subarray(0, nRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (skipFirstPartial) {
          skipFirstPartial = false;
          continue;
        }
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") steps.push(parsed);
        } catch {}
      }
    }
    carry += decoder.end();
    if (carry.trim() && !skipFirstPartial) {
      for (const parsed of parseTranscriptLines(carry)) steps.push(parsed);
    }
    return steps;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Calibrate `estimateTokens` against a real transcript JSONL file (or pre-parsed steps array).
 * Falls back transparently to `TOKEN_CALIBRATION_CORPUS` if the transcript has no usable pairs.
 */
export function calibrateFromTranscript(transcriptPathOrSteps) {
  let steps = [];
  let transcriptPath = null;
  if (typeof transcriptPathOrSteps === "string") {
    transcriptPath = path.resolve(transcriptPathOrSteps);
    if (fs.existsSync(transcriptPath)) {
      steps = readBoundedTranscriptSteps(transcriptPath);
    }
  } else if (Array.isArray(transcriptPathOrSteps)) {
    steps = transcriptPathOrSteps;
  }

  const report = extractTranscriptCalibrationReport(steps);
  if (report.samples.length > 0) {
    const metrics = calibrateTokenEstimator(report.samples);
    const recommendedBand = Math.max(
      ESTIMATOR_ERROR_BAND_PCT,
      Math.min(50, Math.ceil(metrics.mapePct / 5) * 5)
    );
    return {
      source: "transcript",
      transcriptPath,
      fallbackUsed: false,
      skippedNoisyTurns: report.skippedCount,
      skippedByReason: report.skippedByReason,
      ...metrics,
      recommendedErrorBandPct: recommendedBand
    };
  }

  return {
    source: "reference_corpus",
    transcriptPath,
    fallbackUsed: true,
    skippedNoisyTurns: report.skippedCount,
    skippedByReason: report.skippedByReason,
    ...calibrateTokenEstimator(TOKEN_CALIBRATION_CORPUS)
  };
}

function splitFrontmatter(markdown) {
  const normalized = String(markdown || "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: "", body: normalized };
  }
  const frontmatter = match[0];
  const body = normalized.slice(frontmatter.length);
  return { frontmatter, body };
}

function splitStartupStability(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const volatileIdx = lines.findIndex((line) =>
    /^(?:Git:|Working tree:|Modified \(|Recent commits:)/.test(line)
  );
  if (volatileIdx === -1) {
    return { stableText: normalized, volatileText: "" };
  }
  return {
    stableText: lines.slice(0, volatileIdx).join("\n"),
    volatileText: lines.slice(volatileIdx).join("\n")
  };
}

function fetchMcpTools(scriptPath, extraEnv = {}, baseEnv = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...baseEnv, ...extraEnv }
    });
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP tools/list timed out: ${scriptPath}`));
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
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      let matchedLine = null;
      let listResp = null;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.id === 2) {
            matchedLine = line;
            listResp = parsed;
            break;
          }
        } catch {}
      }
      const tools = listResp?.result?.tools;
      if (!matchedLine || !Array.isArray(tools)) {
        return reject(new Error(`Incomplete or invalid MCP tools/list response (exit ${code}): ${stderr || stdout}`));
      }
      resolve({
        rawLine: matchedLine,
        tools
      });
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agy-dart-prefix-budget", version: "1.0" }
        }
      }) + "\n"
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });
}

function runSessionStartHook(rootDir, dbPath, options = {}) {
  const hookScript = path.join(rootDir, "hooks", "session-start.mjs");
  const childEnv = { ...(options.env || process.env), AGY_DART_DB_PATH: dbPath };
  // Prevent inherited subagent env markers from silently stripping volatile Git tail
  // when prefix-budget audits a top-level Turn-0 session from inside a worker/subagent.
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "ANTIGRAVITY_PARENT_CONVERSATION_ID")) {
    delete childEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "ANTIGRAVITY_SUBAGENT")) {
    delete childEnv.ANTIGRAVITY_SUBAGENT;
  }
  if (options.configPath) {
    childEnv.AGY_DART_CONFIG_PATH = options.configPath;
  }
  if (options.stableOnly === true) {
    childEnv.AGY_DART_STABLE_PREFIX_ONLY = "1";
  } else if (options.stableOnly === false) {
    childEnv.AGY_DART_STABLE_PREFIX_ONLY = "0";
  }
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify({
      cwd: rootDir,
      workspacePaths: [rootDir],
      hookEventName: "SessionStart"
    }),
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    env: childEnv
  });
  if (res.error || res.status !== 0) {
    throw new Error(`SessionStart hook failed: ${res.stderr || res.error?.message || `exit ${res.status}`}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  return parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
}

export async function auditPrefixBudget(rootDir = REPO_ROOT, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-prefix-budget-"));
  const tmpDb = path.join(tmpDir, "prefix-budget.db");
  const cfgOpts = {};
  if (options.configPath) cfgOpts.configPath = options.configPath;
  if (options.env) cfgOpts.env = options.env;
  const effectiveCfg = getEffectiveConfig(cfgOpts);
  const stablePrefixOnly =
    options.stableOnly !== undefined
      ? Boolean(options.stableOnly)
      : Boolean(effectiveCfg.stablePrefixOnly);

  try {
    // 1. brake: rules/AGENTS.md
    const agentsPath = path.join(rootDir, "rules", "AGENTS.md");
    const agentsText = fs.readFileSync(agentsPath, "utf8");
    const brake = {
      file: "rules/AGENTS.md",
      bytes: Buffer.byteLength(agentsText, "utf8"),
      chars: agentsText.length,
      tokens: estimateTokens(agentsText),
      sha256: sha256Hex(agentsText)
    };

    // 2. reference: skills/agy-dart/SKILL.md (only YAML frontmatter counts toward Turn-0 resident total)
    const skillPath = path.join(rootDir, "skills", "agy-dart", "SKILL.md");
    const skillText = fs.readFileSync(skillPath, "utf8");
    const { frontmatter, body } = splitFrontmatter(skillText);
    const reference = {
      file: "skills/agy-dart/SKILL.md",
      frontmatterBytes: Buffer.byteLength(frontmatter, "utf8"),
      frontmatterChars: frontmatter.length,
      frontmatterTokens: estimateTokens(frontmatter),
      bodyBytes: Buffer.byteLength(body, "utf8"),
      bodyChars: body.length,
      bodyTokens: estimateTokens(body),
      totalBytes: Buffer.byteLength(skillText, "utf8"),
      frontmatterSha256: sha256Hex(frontmatter)
    };

    // 3. tools: live JSON-RPC handshake with both MCP servers
    const mcpBaseEnv = options.env || process.env;
    const mcpExtra = options.configPath ? { AGY_DART_CONFIG_PATH: options.configPath } : {};
    const [fastRes, ctxRes] = await Promise.all([
      fetchMcpTools(path.join(rootDir, "fast", "mcp-server.mjs"), mcpExtra, mcpBaseEnv),
      fetchMcpTools(path.join(rootDir, "context", "server.js"), { ...mcpExtra, AGY_DART_DB_PATH: tmpDb }, mcpBaseEnv)
    ]);

    const isSortedByName = (list) => {
      if (!Array.isArray(list) || list.length === 0) return false;
      for (let i = 1; i < list.length; i++) {
        if (String(list[i - 1]?.name ?? "") >= String(list[i]?.name ?? "")) {
          return false;
        }
      }
      return true;
    };

    const fastJson = JSON.stringify(fastRes.tools);
    const ctxJson = JSON.stringify(ctxRes.tools);
    const combinedToolsJson = stableStringify({
      context: ctxRes.tools,
      fast: fastRes.tools
    });
    const fastCanonicalMatch = isSortedByName(fastRes.tools) && fastJson === stableStringify(fastRes.tools);
    const ctxCanonicalMatch = isSortedByName(ctxRes.tools) && ctxJson === stableStringify(ctxRes.tools);

    const fastMeta = {
      toolCount: fastRes.tools.length,
      names: fastRes.tools.map((t) => t.name),
      bytes: Buffer.byteLength(fastJson, "utf8"),
      chars: fastJson.length,
      tokens: estimateTokens(fastJson),
      canonical: fastCanonicalMatch,
      sha256: sha256Hex(fastJson)
    };

    const ctxMeta = {
      toolCount: ctxRes.tools.length,
      names: ctxRes.tools.map((t) => t.name),
      bytes: Buffer.byteLength(ctxJson, "utf8"),
      chars: ctxJson.length,
      tokens: estimateTokens(ctxJson),
      canonical: ctxCanonicalMatch,
      sha256: sha256Hex(ctxJson)
    };

    const toolsFingerprint = sha256Hex(combinedToolsJson);
    const tools = {
      toolCount: fastMeta.toolCount + ctxMeta.toolCount,
      bytes: fastMeta.bytes + ctxMeta.bytes,
      chars: fastMeta.chars + ctxMeta.chars,
      tokens: fastMeta.tokens + ctxMeta.tokens,
      canonical: fastCanonicalMatch && ctxCanonicalMatch,
      fingerprint: toolsFingerprint,
      fast: fastMeta,
      context: ctxMeta
    };

    // 4. startup: live hooks/session-start.mjs output split into stable vs volatile Git tail
    const startupText = runSessionStartHook(rootDir, tmpDb, {
      stableOnly: stablePrefixOnly,
      configPath: options.configPath,
      env: options.env
    });
    const { stableText, volatileText } = splitStartupStability(startupText);
    const startupTotalBytes = Buffer.byteLength(startupText, "utf8");
    const stableBytes = Buffer.byteLength(stableText, "utf8");
    const volatileBytes = Buffer.byteLength(volatileText, "utf8");
    const denom = stableBytes + volatileBytes;
    const stablePct = denom > 0 ? Number(((stableBytes / denom) * 100).toFixed(1)) : 100;
    const volatilePct = denom > 0 ? Number(((volatileBytes / denom) * 100).toFixed(1)) : 0;
    const stableTokens = estimateTokens(stableText);

    const startup = {
      bytes: startupTotalBytes,
      chars: startupText.length,
      tokens: estimateTokens(startupText),
      stableTokens,
      stablePrefixOnly,
      stableBytes,
      volatileBytes,
      stablePct,
      volatilePct,
      stableSha256: sha256Hex(stableText),
      fullSha256: sha256Hex(startupText)
    };

    const totalBytes = brake.bytes + reference.frontmatterBytes + tools.bytes + startup.bytes;
    const totalChars = brake.chars + reference.frontmatterChars + tools.chars + startup.chars;
    const totalTokens = brake.tokens + reference.frontmatterTokens + tools.tokens + startup.tokens;
    const stableOnlyTokens = brake.tokens + reference.frontmatterTokens + tools.tokens + stableTokens;
    const errorBandPct = ESTIMATOR_ERROR_BAND_PCT;
    const upperBoundTokens = Math.ceil(totalTokens * (1 + errorBandPct / 100));
    const exceedsBudget = totalTokens > TOKEN_WARN_LIMIT;
    const exceedsUpperBound = upperBoundTokens > TOKEN_WARN_LIMIT;
    const warnings = [];
    if (exceedsBudget) {
      warnings.push(`Turn-0 resident prefix (${totalTokens} est. tokens) exceeds recommended ${TOKEN_WARN_LIMIT}-token budget.`);
    } else if (exceedsUpperBound) {
      warnings.push(`Turn-0 resident prefix upper bound (${upperBoundTokens} tok at +${errorBandPct}%) exceeds ${TOKEN_WARN_LIMIT}-token budget.`);
    }
    if (!tools.canonical) {
      warnings.push("MCP tools/list output is not canonically sorted/serialized.");
    }
    const warning = warnings.length > 0 ? warnings.join(" ") : null;

    return stableSortObject({
      rootDir,
      budgetLimitTokens: TOKEN_WARN_LIMIT,
      stablePrefixOnly,
      stableOnlyTokens,
      totalBytes,
      totalChars,
      totalTokens,
      errorBandPct,
      upperBoundTokens,
      exceedsBudget,
      exceedsUpperBound,
      warning,
      toolsFingerprint,
      blocks: {
        brake,
        reference,
        tools,
        startup
      }
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
}

function formatHumanReport(report) {
  const { brake, reference, tools, startup } = report.blocks;
  const startupModeNote = report.stablePrefixOnly ? " [stable-only]" : "";
  const lines = [
    "# agy-dart Turn-0 Prefix Budget & Determinism Audit",
    "",
    "| Block | Scope | Bytes | Chars | Est. Tokens | Notes |",
    "| :--- | :--- | ---: | ---: | ---: | :--- |",
    `| 1. brake | \`${brake.file}\` | ${brake.bytes} | ${brake.chars} | ${brake.tokens} | sha256:${brake.sha256.slice(0, 12)} |`,
    `| 2. reference | \`${reference.file}\` (frontmatter) | ${reference.frontmatterBytes} | ${reference.frontmatterChars} | ${reference.frontmatterTokens} | on-demand body: ${reference.bodyBytes} B (${reference.bodyTokens} tok, excluded) |`,
    `| 3. tools (fast) | \`fast/mcp-server.mjs\` (${tools.fast.toolCount} tools) | ${tools.fast.bytes} | ${tools.fast.chars} | ${tools.fast.tokens} | sha256:${tools.fast.sha256.slice(0, 12)} |`,
    `| 3. tools (context) | \`context/server.js\` (${tools.context.toolCount} tools) | ${tools.context.bytes} | ${tools.context.chars} | ${tools.context.tokens} | sha256:${tools.context.sha256.slice(0, 12)} |`,
    `| 4. startup | \`hooks/session-start.mjs\`${startupModeNote} | ${startup.bytes} | ${startup.chars} | ${startup.tokens} | stable: ${startup.stablePct}% (${startup.stableBytes} B) / volatile Git tail: ${startup.volatilePct}% (${startup.volatileBytes} B) |`,
    `| **TOTAL (Turn-0)** | **Always-loaded prefix** | **${report.totalBytes}** | **${report.totalChars}** | **${report.totalTokens}** | budget <= ${report.budgetLimitTokens} tok (±${report.errorBandPct}% band -> <= ${report.upperBoundTokens} tok; stable-only: ${report.stableOnlyTokens} tok) |`,
    "",
    `Tools Fingerprint (SHA-256): ${report.toolsFingerprint}`,
    `  - fast    : ${tools.fast.sha256} (canonical=${tools.fast.canonical})`,
    `  - context : ${tools.context.sha256} (canonical=${tools.context.canonical})`
  ];

  if (report.warning) {
    lines.push("", `WARNING: ${report.warning}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const stableOnly = args.includes("--stable-only");
  const calibrate = args.includes("--calibrate");
  const autoTranscript = args.includes("--auto-transcript");
  let transcriptPath = "";
  const trIdx = args.indexOf("--transcript");
  if (trIdx !== -1 && args[trIdx + 1]) {
    transcriptPath = path.resolve(args[trIdx + 1]);
  } else if (autoTranscript) {
    transcriptPath = findTranscriptForConversation() || "";
  }
  let rootDir = REPO_ROOT;
  const targetIdx = args.indexOf("--target");
  if (targetIdx !== -1 && args[targetIdx + 1]) {
    rootDir = path.resolve(args[targetIdx + 1]);
  }

  if (calibrate) {
    const cal = transcriptPath ? calibrateFromTranscript(transcriptPath) : calibrateTokenEstimator();
    if (asJson) {
      process.stdout.write(JSON.stringify(cal, null, 2) + "\n");
    } else {
      const label =
        cal.source === "transcript"
          ? `${cal.sampleCount} transcript usageMetadata turns (${path.basename(cal.transcriptPath || "transcript")})`
          : `${cal.sampleCount} cross-script samples`;
      console.log(`Token estimator calibration (${label}):`);
      console.log(`  - MAE          : ${cal.maeTokens} tokens`);
      console.log(`  - MAPE         : ${cal.mapePct}% (max rel error: ${cal.maxRelErrorPct}%)`);
      console.log(`  - Mean bias    : ${cal.meanBiasPct >= 0 ? "+" : ""}${cal.meanBiasPct}%`);
      console.log(`  - Safety band  : ±${cal.recommendedErrorBandPct}%`);
      if (cal.skippedNoisyTurns > 0) {
        const reasonSummary = Object.entries(cal.skippedByReason || {})
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`)
          .join(", ");
        console.log(`  - Skipped noisy: ${cal.skippedNoisyTurns} turn(s)${reasonSummary ? ` (${reasonSummary})` : ""}`);
      }
      if (cal.fallbackUsed && cal.transcriptPath) {
        console.log(`  - Fallback     : reference corpus (no uncontaminated transcript turns in ${path.basename(cal.transcriptPath)})`);
      }
    }
    return;
  }

  const report = await auditPrefixBudget(rootDir, stableOnly ? { stableOnly: true } : {});
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatHumanReport(report) + "\n");
  }
  if (report.exceedsBudget || report.exceedsUpperBound || !report.blocks?.tools?.canonical) {
    process.exitCode = 1;
  }
}

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === selfPath)
);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`prefix:budget error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
