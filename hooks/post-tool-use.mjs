#!/usr/bin/env node
/**
 * agy-dart PostToolUse hook:
 * Invalidates session-level `file_reads` entries whenever a file is edited/written
 * (edit_file, write_file, replace_file_content, apply_edits) while keeping
 * `file_snapshots` intact as the diff baseline for State-3 compact diff-read.
 * When `ctx_resume` is called after conversation compaction, invalidates BOTH
 * `file_reads` and `file_snapshots` for the session.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";

function readStdin(timeoutMs = 1500) {
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

function cleanPath(val) {
  if (!val) return "";
  let p = String(val).trim();
  while ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  p = p.replace(/#L\d+(-L\d+)?$/i, "");
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      let rest = p.replace(/^file:\/\//i, "");
      try {
        rest = decodeURIComponent(rest);
      } catch {}
      if (/^\/[A-Za-z]:[\\/]/.test(rest)) {
        rest = rest.slice(1);
      }
      p = rest;
    }
  }
  return p.trim();
}

function parseMaybeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return null;
}

export function extractInvalidationTargets(toolName, args = {}, cwd = process.cwd()) {
  const paths = [];
  let clearAllSession = false;

  const addPath = (raw, baseDir = cwd) => {
    const cleaned = cleanPath(raw);
    if (!cleaned) return;
    paths.push(path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseDir || cwd, cleaned));
  };

  const resolveBaseCwd = (rawCwd) => {
    const cleaned = cleanPath(rawCwd);
    if (!cleaned) return cwd;
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
  };

  if (
    toolName === "edit_file" ||
    toolName === "write_file" ||
    toolName === "replace_file_content" ||
    toolName === "multi_replace_file_content" ||
    toolName === "write_to_file"
  ) {
    addPath(args.Path || args.path || args.TargetFile || args.targetFile || args.filePath || args.AbsolutePath || args.absolutePath);
  } else if (toolName === "apply_edits" || /(?:^|_)apply_edits$/.test(toolName)) {
    if (!args.dryRun) {
      const editCwd = resolveBaseCwd(args.cwd);
      if (Array.isArray(args.edits)) {
        for (const e of args.edits) {
          if (e && e.path) addPath(e.path, editCwd);
        }
      }
    }
  } else if (toolName === "call_mcp_tool") {
    const mcpTool = String(args.ToolName || args.toolName || "").trim();
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    if (mcpTool === "apply_edits") {
      if (!mcpArgs.dryRun) {
        const editCwd = resolveBaseCwd(mcpArgs.cwd);
        if (Array.isArray(mcpArgs.edits)) {
          for (const e of mcpArgs.edits) {
            if (e && e.path) addPath(e.path, editCwd);
          }
        }
      }
    } else if (mcpTool === "ctx_resume") {
      clearAllSession = true;
    }
  } else if (toolName === "ctx_resume" || /(?:^|_)ctx_resume$/.test(toolName)) {
    clearAllSession = true;
  }

  return { paths, clearAllSession };
}

function extractResponseIsError(payload = {}) {
  if (payload.isError === true || payload.is_error === true || Boolean(payload.error)) return true;
  const candidates = [
    payload.toolResponse,
    payload.tool_response,
    payload.response,
    payload.result,
    payload.toolCall?.result
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && (c.isError === true || c.is_error === true)) return true;
  }
  return false;
}

function extractPartialAppliedPaths(responseText, toolName, args = {}, cwd = process.cwd()) {
  if (!responseText || !/Partial edit applied\b/i.test(responseText)) return null;
  const appliedBlockMatch = responseText.match(/Applied:\r?\n([\s\S]*?)(?:\r?\n\r?\nFailed\b|$)/i);
  if (!appliedBlockMatch) return [];

  let baseCwd = cwd;
  const resolveBase = (rawCwd) => {
    const cleaned = cleanPath(rawCwd);
    if (!cleaned) return cwd;
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
  };
  if (toolName === "apply_edits" || /(?:^|_)apply_edits$/.test(toolName)) {
    baseCwd = resolveBase(args.cwd);
  } else if (toolName === "call_mcp_tool") {
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    baseCwd = resolveBase(mcpArgs.cwd);
  }

  const out = [];
  for (const line of appliedBlockMatch[1].split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+?):\s+(?:created|updated\b)/i);
    if (!m) continue;
    const cleaned = cleanPath(m[1]);
    if (!cleaned) continue;
    out.push(path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseCwd, cleaned));
  }
  return out;
}

function extractToolResponseText(payload = {}) {
  const candidates = [
    payload.toolResponse,
    payload.tool_response,
    payload.response,
    payload.result,
    payload.output,
    payload.toolCall?.result,
    payload.toolCall?.output
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      if (typeof c.text === "string" && c.text.trim()) return c.text;
      if (Array.isArray(c.content)) {
        const joined = c.content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n");
        if (joined.trim()) return joined;
      }
    }
  }
  return "";
}

export function extractVerificationSignal(toolName, args = {}, responseText = "") {
  if (!responseText || typeof responseText !== "string") return null;

  // Case 1: apply_edits with inline verify command
  let verifyCmd = "";
  let isRunChecks = false;
  let runChecksCmd = "";
  if (toolName === "apply_edits" || /(?:^|_)apply_edits$/.test(toolName)) {
    verifyCmd = typeof args.verify === "string" ? args.verify : args.verify?.command || "";
  } else if (toolName === "run_checks" || /(?:^|_)run_checks$/.test(toolName)) {
    isRunChecks = true;
    const cmds = Array.isArray(args.commands) ? args.commands : [];
    runChecksCmd = cmds
      .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  } else if (toolName === "call_mcp_tool") {
    const mcpTool = String(args.ToolName || args.toolName || "").trim();
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    if (mcpTool === "apply_edits") {
      verifyCmd = typeof mcpArgs.verify === "string" ? mcpArgs.verify : mcpArgs.verify?.command || "";
    } else if (mcpTool === "run_checks") {
      isRunChecks = true;
      const cmds = Array.isArray(mcpArgs.commands) ? mcpArgs.commands : [];
      runChecksCmd = cmds
        .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
    }
  }

  if (verifyCmd) {
    const m = responseText.match(/Verify \[(PASS|FAIL|TIMEOUT)[^\]]*\]\s*`?([^`\n]*)`?:/i);
    if (m) {
      const status = m[1].toUpperCase();
      const passed = status === "PASS";
      const isBuild = /\b(?:build|tsc|typecheck|lint|eslint|biome|webpack|vite|clippy)\b/i.test(verifyCmd);
      return {
        kind: isBuild ? "build" : "test",
        command: verifyCmd,
        ruleId: "apply_edits_verify",
        exitCode: passed ? 0 : 1,
        passed,
        summary: m[0].slice(0, 180)
      };
    }
  }

  if (isRunChecks) {
    const m = responseText.match(/^Checks:\s*(\d+)\/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/m);
    if (m) {
      const passedCnt = Number(m[1]);
      const totalCnt = Number(m[2]);
      const failedCnt = m[3] ? Number(m[3]) : Math.max(0, totalCnt - passedCnt);
      const passed = failedCnt === 0 && totalCnt > 0;
      const isBuild =
        /\b(?:build|tsc|typecheck|lint|eslint|biome|check)\b/i.test(runChecksCmd) &&
        !/\btest\b/i.test(runChecksCmd);
      return {
        kind: isBuild ? "build" : "test",
        command: runChecksCmd || "run_checks",
        ruleId: "run_checks",
        exitCode: passed ? 0 : 1,
        passed,
        summary: m[0]
      };
    }
  }

  return null;
}

async function main() {
  enableVersionedCompileCache();

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

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};
  const cwd = payload.cwd || process.cwd();
  const sessionId = resolveSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);

  const { paths, clearAllSession } = extractInvalidationTargets(toolName, args, cwd);
  const responseText = extractToolResponseText(payload);
  const responseIsError = extractResponseIsError(payload);
  const verifySignal = extractVerificationSignal(toolName, args, responseText);

  if (clearAllSession || paths.length > 0 || verifySignal) {
    let store = null;
    try {
      const { ContextModeStore } = await import("../context/lib/store.js");
      store = new ContextModeStore({ hookMode: true });
      if (clearAllSession) {
        store.invalidateFileReads(sessionId, null);
        if (directConvId && directConvId !== sessionId) {
          store.invalidateFileReads(directConvId, null);
        }
      } else if (paths.length > 0) {
        const partialApplied = extractPartialAppliedPaths(responseText, toolName, args, cwd);
        const explicitlyApplied = /^\s*Applied edits to \d+ file\(s\):/im.test(responseText);
        const abortedNoWrite =
          partialApplied === null &&
          !explicitlyApplied &&
          (responseIsError ||
            /^\s*(?:(?:Atomic edit aborted|Edit aborted|Validation failed)\s*\(0 files modified\)|Write failed \(changes rolled back\)|Dry run validated|Encountered error in step execution|Tool error \()/i.test(
              responseText
            ));
        const effectivePaths = partialApplied !== null ? partialApplied : abortedNoWrite ? [] : paths;
        if (effectivePaths.length > 0) {
          for (const absPath of effectivePaths) {
            store.invalidateFileReads(sessionId, absPath);
            if (directConvId && directConvId !== sessionId) {
              store.invalidateFileReads(directConvId, absPath);
            }
          }
          store.recordModifiedFiles(sessionId, effectivePaths, { worktree: cwd, tool: toolName });
        }
      }
      if (verifySignal) {
        store.recordVerificationResult(sessionId, { ...verifySignal, worktree: cwd });
      }
    } catch {
      // Fail-open: never block PostToolUse
    } finally {
      if (store) {
        try {
          store.close();
        } catch {}
      }
    }
  }

  process.stdout.write("{}\n");
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
