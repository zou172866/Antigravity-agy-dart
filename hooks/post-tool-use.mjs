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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enableVersionedCompileCache,
  isSameFilePath,
  readStdin,
  resolveDirectConversationId,
  resolveSessionId
} from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";
import {
  executionReceiptFromText,
  extractFastSavingsToolName,
  fastToolFingerprint,
  isContextExecution
} from "../context/lib/execution-receipts.js";

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

function expandHookPath(val) {
  const p = cleanPath(val);
  if (!p) return "";
  const joinExpandedTail = (base, rawTail) => {
    const segs = String(rawTail || "").split(/[\\/]+/).filter(Boolean);
    return segs.length > 0 ? path.join(base, ...segs) : base;
  };
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return joinExpandedTail(os.homedir(), p.slice(2));
  }
  const tmpMatch = p.match(
    /^(?:\$\{(?:env:)?(?:TMPDIR|TEMP|TMP)\}|\$(?:env:)?(?:TMPDIR|TEMP|TMP)|%(?:TEMP|TMP)%)(?=$|[\\/])(.*)$/i
  );
  if (tmpMatch) {
    return joinExpandedTail(os.tmpdir(), tmpMatch[1]);
  }
  const homeMatch = p.match(
    /^(?:\$\{(?:env:)?(?:HOME|USERPROFILE)\}|\$(?:env:)?(?:HOME|USERPROFILE)|%(?:HOME|USERPROFILE)%)(?=$|[\\/])(.*)$/i
  );
  if (homeMatch) {
    return joinExpandedTail(os.homedir(), homeMatch[1]);
  }
  const localAppMatch = p.match(
    /^(?:\$\{(?:env:)?LOCALAPPDATA\}|\$(?:env:)?LOCALAPPDATA|%LOCALAPPDATA%)(?=$|[\\/])(.*)$/i
  );
  if (localAppMatch) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return joinExpandedTail(base, localAppMatch[1]);
  }
  return p;
}

function stripHostNamespace(rawToolName) {
  const s = String(rawToolName || "").trim();
  const colonIdx = s.lastIndexOf(":");
  return colonIdx >= 0 ? s.slice(colonIdx + 1) : s;
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
  const bareTool = stripHostNamespace(toolName);

  const addPath = (raw, baseDir = cwd) => {
    const cleaned = expandHookPath(raw);
    if (!cleaned) return;
    paths.push(path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseDir || cwd, cleaned));
  };

  const resolveBaseCwd = (rawCwd) => {
    const cleaned = expandHookPath(rawCwd);
    if (!cleaned) return cwd;
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
  };

  const lowerBare = bareTool.toLowerCase();
  if (
    bareTool === "edit_file" ||
    bareTool === "write_file" ||
    bareTool === "replace_file_content" ||
    bareTool === "multi_replace_file_content" ||
    bareTool === "write_to_file" ||
    lowerBare === "edit" ||
    lowerBare === "write" ||
    (lowerBare === "str_replace_editor" && String(args.command || "").toLowerCase() !== "view")
  ) {
    addPath(
      args.Path ||
        args.path ||
        args.file_path ||
        args.TargetFile ||
        args.targetFile ||
        args.filePath ||
        args.AbsolutePath ||
        args.absolutePath
    );
  } else if (lowerBare === "apply_patch") {
    const patchText = typeof args.input === "string" ? args.input : "";
    for (const m of patchText.matchAll(/^\*\*\*\s+(?:(?:Add|Update|Delete)\s+File|Move\s+to):\s*(.+)$/gim)) {
      if (m[1]) addPath(m[1]);
    }
  } else if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    if (!args.dryRun) {
      const editCwd = resolveBaseCwd(args.cwd);
      const editsList = Array.isArray(args.edits) ? args.edits : parseMaybeJson(args.edits);
      if (Array.isArray(editsList)) {
        for (const e of editsList) {
          if (e && e.path) addPath(e.path, editCwd);
        }
      }
    }
  } else if (bareTool === "call_mcp_tool") {
    const mcpTool = stripHostNamespace(cleanPath(args.ToolName || args.toolName || ""));
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    if (mcpTool === "apply_edits" || /(?:^|_)apply_edits$/.test(mcpTool)) {
      if (!mcpArgs.dryRun) {
        const editCwd = resolveBaseCwd(mcpArgs.cwd);
        const editsList = Array.isArray(mcpArgs.edits) ? mcpArgs.edits : parseMaybeJson(mcpArgs.edits);
        if (Array.isArray(editsList)) {
          for (const e of editsList) {
            if (e && e.path) addPath(e.path, editCwd);
          }
        }
      }
    } else if (mcpTool === "ctx_resume" || /(?:^|_)ctx_resume$/.test(mcpTool)) {
      if (mcpArgs.seq === undefined || mcpArgs.seq === null) {
        clearAllSession = true;
      }
    }
  } else if (bareTool === "ctx_resume" || /(?:^|_)ctx_resume$/.test(bareTool)) {
    if (args.seq === undefined || args.seq === null) {
      clearAllSession = true;
    }
  }

  return { paths, clearAllSession };
}

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_NON_CONV_SEGMENTS = new Set([
  "default",
  "all",
  "app",
  "lifetime",
  "main",
  "master",
  "test",
  "tests",
  "core",
  "util",
  "utils",
  "src",
  "lib",
  "dist",
  "build",
  "docs",
  "scripts"
]);
const SOURCE_TREE_PARENT_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "packages",
  "modules",
  "components",
  "services",
  "server",
  "client",
  "node_modules",
  "vendor",
  "test",
  "tests"
]);

function resolveRealPathBestEffort(resolvedPath) {
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    let cur = path.dirname(resolvedPath);
    const tail = [path.basename(resolvedPath)];
    for (let i = 0; i < 16 && cur; i += 1) {
      try {
        const realCur = fs.realpathSync(cur);
        return path.join(realCur, ...tail.reverse());
      } catch {
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
    return null;
  }
}

function isWinDriveLike(p) {
  return typeof p === "string" && /^\/?[A-Za-z]:(?:$|[\\/])/.test(p);
}

function normalizeWinDriveToSyntheticPosix(rawWinPath) {
  const s = rawWinPath.startsWith("/") ? rawWinPath.slice(1) : rawWinPath;
  const drive = s[0].toLowerCase();
  const rest = s.slice(2).replace(/\\/g, "/");
  const normRest = path.posix.normalize("/" + rest).toLowerCase();
  return normRest === "/" ? `/${drive}:` : `/${drive}:${normRest.replace(/\/+$/, "")}`;
}

function resolvePathBundle(rawPath, baseDir = "", { platform = process.platform } = {}) {
  const cleaned = expandHookPath(rawPath);
  if (!cleaned) return null;
  const effPlatform = platform || process.platform;

  if (effPlatform !== "win32" && isWinDriveLike(cleaned)) {
    const winPosix = normalizeWinDriveToSyntheticPosix(cleaned);
    return { logical: winPosix, real: winPosix, allForms: [winPosix] };
  }

  if (effPlatform !== process.platform) {
    const cleanedBase = expandHookPath(baseDir);
    if (effPlatform !== "win32") {
      const candPosix = cleaned.replace(/\\/g, "/");
      const basePosix = cleanedBase && !isWinDriveLike(cleanedBase) ? cleanedBase.replace(/\\/g, "/") : "";
      const resolved =
        !path.posix.isAbsolute(candPosix) && basePosix
          ? path.posix.resolve(basePosix, candPosix)
          : path.posix.resolve("/", candPosix);
      return { logical: resolved, real: resolved, allForms: [resolved] };
    }
    const resolvedWin = (
      !path.win32.isAbsolute(cleaned) && cleanedBase
        ? path.win32.resolve(cleanedBase, cleaned)
        : path.win32.resolve(cleaned)
    ).toLowerCase();
    return { logical: resolvedWin, real: resolvedWin, allForms: [resolvedWin] };
  }

  const cleanedBase = expandHookPath(baseDir);
  const resolved =
    !path.isAbsolute(cleaned) && cleanedBase ? path.resolve(cleanedBase, cleaned) : path.resolve(cleaned);
  const normCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const logical = normCase(resolved);
  const realRaw = resolveRealPathBestEffort(resolved);
  const real = realRaw ? normCase(realRaw) : logical;
  const allForms = real !== logical ? [logical, real] : [logical];
  return { logical, real, allForms };
}

function relativeBetweenForms(dirForm, candForm) {
  if (dirForm.startsWith("/") && candForm.startsWith("/")) {
    return path.posix.relative(dirForm, candForm);
  }
  if (/^[a-zA-Z]:[\\/]/.test(dirForm) && /^[a-zA-Z]:[\\/]/.test(candForm)) {
    return path.win32.relative(dirForm, candForm);
  }
  return path.relative(dirForm, candForm);
}

function isSameOrInsideAnyDir(candForms, dirForms, { strictChild = false } = {}) {
  for (const c of candForms) {
    for (const d of dirForms) {
      if (!c || !d) continue;
      const rel = relativeBetweenForms(d, c);
      if (rel === "") {
        if (!strictChild) return true;
        continue;
      }
      if (
        rel !== ".." &&
        !rel.startsWith(`..${path.sep}`) &&
        !rel.startsWith("../") &&
        !rel.startsWith("..\\") &&
        !path.posix.isAbsolute(rel) &&
        !path.win32.isAbsolute(rel)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isInsideBrainConversationSubdir(candForms, brainDirForms) {
  for (const c of candForms) {
    for (const d of brainDirForms) {
      if (!c || !d) continue;
      const rel = relativeBetweenForms(d, c);
      if (
        !rel ||
        rel === ".." ||
        rel.startsWith(`..${path.sep}`) ||
        rel.startsWith("../") ||
        rel.startsWith("..\\") ||
        path.posix.isAbsolute(rel) ||
        path.win32.isAbsolute(rel)
      ) {
        continue;
      }
      const parts = rel.split(/[\\/]+/).filter(Boolean);
      if (parts.length >= 2 && parts[0] !== "." && parts[0] !== "..") {
        return true;
      }
    }
  }
  return false;
}

function isAbsoluteForAnyOs(p) {
  return Boolean(p && (path.isAbsolute(p) || path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)));
}

function pathModFor(p) {
  return /^[A-Za-z]:[\\/]/.test(p) ? path.win32 : path.posix.isAbsolute(p) && process.platform === "win32" && !p.startsWith("\\\\") ? path.posix : path;
}

export function isEphemeralOsTempPathOutsideWorkspace(absPath, workspaceCwd = "", options = {}) {
  const effPlatform = options?.platform || process.platform;
  const candBundle = resolvePathBundle(absPath, workspaceCwd, { platform: effPlatform });
  if (!candBundle) return false;
  if (workspaceCwd && typeof workspaceCwd === "string" && workspaceCwd.trim()) {
    const wsBundle = resolvePathBundle(workspaceCwd, "", { platform: effPlatform });
    if (wsBundle && isSameOrInsideAnyDir(candBundle.allForms, wsBundle.allForms)) {
      return false;
    }
  }
  const rawTmpCandidates = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    ...(effPlatform !== "win32" ? ["/tmp", "/private/tmp", "/var/tmp"] : [])
  ];
  // Require the canonical real target (`candBundle.real`) to reside inside an OS temp dir so a
  // symlink/junction inside %TEMP% or /tmp pointing to an external repo file is never excluded.
  for (const tmpCand of rawTmpCandidates) {
    if (!tmpCand || typeof tmpCand !== "string" || !tmpCand.trim() || !isAbsoluteForAnyOs(tmpCand.trim())) {
      continue;
    }
    const tmpBundle = resolvePathBundle(tmpCand, "", { platform: effPlatform });
    if (tmpBundle && isSameOrInsideAnyDir([candBundle.real], tmpBundle.allForms, { strictChild: true })) {
      return true;
    }
  }
  return false;
}

export function isAntigravityBrainPathOutsideWorkspace(absPath, workspaceCwd = "", options = {}) {
  const effPlatform = options?.platform || process.platform;
  const candBundle = resolvePathBundle(absPath, workspaceCwd, { platform: effPlatform });
  if (!candBundle) return false;
  if (workspaceCwd && typeof workspaceCwd === "string" && workspaceCwd.trim()) {
    const wsBundle = resolvePathBundle(workspaceCwd, "", { platform: effPlatform });
    if (wsBundle && isSameOrInsideAnyDir(candBundle.allForms, wsBundle.allForms)) {
      return false;
    }
  }

  const knownBrainDirCandidates = [];
  const pushBrainDir = (rawDir) => {
    const cleaned = expandHookPath(rawDir);
    if (cleaned && isAbsoluteForAnyOs(cleaned)) {
      knownBrainDirCandidates.push(cleaned);
    }
  };

  for (const appDir of [
    options?.appDataDir,
    process.env.ANTIGRAVITY_APP_DATA_DIR,
    process.env.ANTIGRAVITY_DATA_DIR,
    process.env.AGY_APP_DATA_DIR
  ]) {
    const cleanedApp = expandHookPath(appDir);
    if (cleanedApp && isAbsoluteForAnyOs(cleanedApp)) {
      pushBrainDir(pathModFor(cleanedApp).join(cleanedApp, "brain"));
    }
  }
  const summaryDbEnv = expandHookPath(options?.summaryDbPath || process.env.AGY_DART_SUMMARY_DB_PATH);
  if (summaryDbEnv && isAbsoluteForAnyOs(summaryDbEnv)) {
    const pm = pathModFor(summaryDbEnv);
    pushBrainDir(pm.join(pm.dirname(summaryDbEnv), "brain"));
  }
  const txPath = expandHookPath(options?.transcriptPath);
  if (txPath && isAbsoluteForAnyOs(txPath)) {
    const pm = pathModFor(txPath);
    let cur = pm.dirname(txPath);
    for (let depth = 0; depth < 7 && cur; depth += 1) {
      if (pm.basename(cur).toLowerCase() === "brain") {
        pushBrainDir(cur);
        break;
      }
      const next = pm.dirname(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }
  for (const homeCand of [os.homedir(), process.env.USERPROFILE, process.env.HOME]) {
    const cleanedHome = expandHookPath(homeCand);
    if (cleanedHome && isAbsoluteForAnyOs(cleanedHome)) {
      const pm = pathModFor(cleanedHome);
      pushBrainDir(pm.join(cleanedHome, ".gemini", "antigravity", "brain"));
      pushBrainDir(pm.join(cleanedHome, ".gemini", "antigravity-ide", "brain"));
      pushBrainDir(pm.join(cleanedHome, ".gemini", "antigravity-cli", "brain"));
    }
  }

  // Require the canonical target (`candBundle.real`) to remain inside `<brain>/<convId>/...` so
  // symlinks/junctions inside `brain/<convId>/scratch/` pointing to external repos are not excluded.
  for (const brainCand of knownBrainDirCandidates) {
    const brainBundle = resolvePathBundle(brainCand, "", { platform: effPlatform });
    if (brainBundle && isInsideBrainConversationSubdir([candBundle.real], brainBundle.allForms)) {
      return true;
    }
  }

  const activeConvIds = new Set();
  const rawConvList = Array.isArray(options?.conversationIds) ? options.conversationIds : [];
  for (const rawId of rawConvList) {
    if (typeof rawId !== "string") continue;
    const trimmed = rawId.trim();
    if (!trimmed || trimmed.length < 4 || trimmed.length > 128 || /[\x00-\x1f\x7f\\/]/.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    if (GENERIC_NON_CONV_SEGMENTS.has(lower)) continue;
    activeConvIds.add(effPlatform === "win32" ? lower : trimmed);
    activeConvIds.add(lower);
  }

  const isAntigravityHostSeg = (seg) => seg === "antigravity" || /^antigravity-[a-z0-9._-]+$/i.test(seg);

  for (const cand of candBundle.allForms) {
    const segs = cand.replace(/\\/g, "/").split("/");
    for (let i = 0; i < segs.length; i += 1) {
      if (segs[i].toLowerCase() !== "brain") continue;
      const convSeg = segs[i + 1] || "";
      if (!convSeg || convSeg === "." || convSeg === ".." || convSeg.length > 128) continue;
      const hasChildFile = segs.slice(i + 2).some(Boolean);
      if (!hasChildFile) continue;

      const prev1 = (segs[i - 1] || "").toLowerCase();
      const prev2 = (segs[i - 2] || "").toLowerCase();
      const hasAgAncestry =
        prev1 === ".gemini" || isAntigravityHostSeg(prev1) || isAntigravityHostSeg(prev2);
      const isUuidConv = UUID_SEGMENT_RE.test(convSeg);
      const isActiveConv =
        !SOURCE_TREE_PARENT_SEGMENTS.has(prev1) &&
        (activeConvIds.has(convSeg) || activeConvIds.has(convSeg.toLowerCase()));
      if (!hasAgAncestry && !isUuidConv && !isActiveConv) continue;

      const matchedBrainPrefix = segs.slice(0, i + 1).join("/") || "/";
      const matchedBrainBundle = resolvePathBundle(matchedBrainPrefix, "", { platform: effPlatform });
      if (matchedBrainBundle && isInsideBrainConversationSubdir([candBundle.real], matchedBrainBundle.allForms)) {
        return true;
      }
    }
  }

  return false;
}

export function isEphemeralScratchOrTempPathOutsideWorkspace(absPath, workspaceCwd = "", options = {}) {
  return (
    isEphemeralOsTempPathOutsideWorkspace(absPath, workspaceCwd, options) ||
    isAntigravityBrainPathOutsideWorkspace(absPath, workspaceCwd, options)
  );
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

function extractPartialAppliedPaths(responseText, toolName, args = {}, cwd = process.cwd(), candidatePaths = []) {
  if (!responseText || !/Partial edit applied\b/i.test(responseText)) return null;
  // If the MCP output was truncated to <=8.8 KB, the `Applied:` section may have clipped trailing edited files;
  // fall back conservatively to invalidating all candidate input paths so no modified file stays stale in `file_reads`.
  if (/\.\.\.\s*\[truncated/i.test(responseText) && Array.isArray(candidatePaths) && candidatePaths.length > 0) {
    return candidatePaths;
  }
  const appliedBlockMatch = responseText.match(/Applied:\r?\n([\s\S]*?)(?:\r?\n\r?\nFailed\b|$)/i);
  if (!appliedBlockMatch) return candidatePaths.length > 0 ? candidatePaths : [];

  let baseCwd = cwd;
  const resolveBase = (rawCwd) => {
    const cleaned = expandHookPath(rawCwd);
    if (!cleaned) return cwd;
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
  };
  const bareTool = stripHostNamespace(toolName);
  if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    baseCwd = resolveBase(args.cwd);
  } else if (bareTool === "call_mcp_tool") {
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    baseCwd = resolveBase(mcpArgs.cwd);
  }

  const out = [];
  for (const line of appliedBlockMatch[1].split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+?):\s+(?:created|updated\b)/i);
    if (!m) continue;
    const cleaned = expandHookPath(m[1]);
    if (!cleaned) continue;
    out.push(path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseCwd, cleaned));
  }
  return out;
}

function extractToolResponseText(payload = {}) {
  const candidates = [
    payload.toolResponse,
    payload.tool_response,
    payload.toolOutput,
    payload.tool_output,
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
      if (typeof c.output === "string" && c.output.trim()) return c.output;
      if (c.result && typeof c.result === "object") {
        if (typeof c.result.text === "string" && c.result.text.trim()) return c.result.text;
        if (Array.isArray(c.result.content)) {
          const joined = c.result.content
            .map((item) => (typeof item?.text === "string" ? item.text : ""))
            .filter(Boolean)
            .join("\n");
          if (joined.trim()) return joined;
        }
      }
    }
  }
  return "";
}

const ZERO_MATCH_FILTER_STAGE_RE =
  /^(?:&\s+)?(?:(?:[a-z]:)?[\\/][^\s]+?[\\/])?(?:select-string|sls|grep|egrep|fgrep|rg|ripgrep|findstr)(?:\.exe)?(?:\s|$)/i;

const WIN_DRIVE_OR_UNC_PATH_BEFORE_TRAILING_BS_RE =
  /^(?:[a-zA-Z]:(?:[\\/][^"'`<>|;&=()]*)?|(?:\\\\|\.\.?\\)[^"'`<>|;&=()]*)$/;
const WIN_REL_PATH_BEFORE_TRAILING_BS_RE =
  /^(?:[^"'`<>|;&=()\s][^"'`<>|;&=()]*\\[^"'`<>|;&=()]*|[^\s"'`<>|;&=()]+)$/;

const PURE_SETUP_CLAUSE_RE =
  /^(?:(?:cd|chdir|pushd|set-location|push-location|sl)(?:\s|$)|export\s+[a-z_][a-z0-9_]*=|set\s+(?:"[a-z_][a-z0-9_]*=|[a-z_][a-z0-9_]*=)|\$env:[a-z0-9_]+\s*=|[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)(?:\s+[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*$)/i;

const READ_ONLY_STAGE_HEAD_RE =
  /^(?:git(?:\.exe)?\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|-c\s+(?:"[^"]*"|'[^']*'|\S+))\s+)*(?:diff|status|log|show|branch|rev-parse|ls-files|grep|blame|shortlog|describe|tag|reflog|ls-tree|cat-file|check-ignore|for-each-ref)|(?:cat|head|tail|less|more|ls|dir|echo|printf|pwd|which|where|type|rg|ripgrep|grep|egrep|fgrep|select-string|sls|findstr|get-content|get-childitem|get-location|get-item|gc|gci|gl|stat|wc|file|tree|find|write-output|write-host|format-table|select-object|measure-object|sort-object|test-path|resolve-path|true)(?:\.exe)?)(?:\s|$)/i;

const SHELL_WRAPPER_CMD_RE =
  /^(?:(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-(?:NoProfile|NonInteractive|NoLogo|nop|noni)|-ExecutionPolicy\s+\S+)\s+)*(?:-Command|-c)\s+|(?:bash|sh|zsh)(?:\.exe)?\s+(?:-[a-zA-Z]*c)\s+|cmd(?:\.exe)?\s+(?:\/[a-zA-Z]+\s+)*\/c\s+)(.+)$/i;

function hasEvenRemainingDoubleQuotes(str, startIdx) {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  for (let j = startIdx; j < str.length; j++) {
    const c = str[j];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = true;
      continue;
    }
    if (inDouble) {
      if (c === "`" && j + 1 < str.length && (str[j + 1] === '"' || str[j + 1] === "`")) {
        j++;
        continue;
      }
      if (c === "\\" && j + 1 < str.length) {
        if (str[j + 1] === "\\") {
          j++;
          continue;
        }
        if (str[j + 1] === '"') {
          const after = str[j + 2];
          if (after !== undefined && !/[\s;|&<>)]/.test(after)) {
            j++;
            continue;
          }
        }
      }
    }
    if (c === '"') {
      count += 1;
      inDouble = !inDouble;
    }
  }
  return count % 2 === 0;
}

function splitShellOutsideQuotesWithOps(str, isSepFn) {
  const parts = [];
  const ops = [];
  let cur = "";
  let quote = "";
  let quoteStartIdx = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (quote === '"') {
        if (ch === "`" && i + 1 < str.length && (str[i + 1] === '"' || str[i + 1] === "`")) {
          cur += ch + str[++i];
          continue;
        }
        if (ch === "\\" && i + 1 < str.length) {
          if (str[i + 1] === "\\") {
            cur += ch + str[++i];
            continue;
          }
          if (str[i + 1] === '"') {
            const quoteContent = str.slice(quoteStartIdx + 1, i);
            const nextAfter = str[i + 2];
            const atTokenEnd = nextAfter === undefined || /[\s;|&<>)]/.test(nextAfter);
            const isWinTrailingBs =
              atTokenEnd &&
              (WIN_DRIVE_OR_UNC_PATH_BEFORE_TRAILING_BS_RE.test(quoteContent) ||
                (WIN_REL_PATH_BEFORE_TRAILING_BS_RE.test(quoteContent) &&
                  hasEvenRemainingDoubleQuotes(str, i + 2)));
            if (!isWinTrailingBs) {
              cur += ch + str[++i];
              continue;
            }
          }
        }
      }
      cur += ch;
      if (ch === quote) {
        quote = "";
        quoteStartIdx = -1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoteStartIdx = i;
      cur += ch;
      continue;
    }
    const sepLen = isSepFn(str, i);
    if (sepLen > 0) {
      if (cur.trim()) {
        parts.push(cur.trim());
        ops.push(str.slice(i, i + sepLen));
      }
      cur = "";
      i += sepLen - 1;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) {
    parts.push(cur.trim());
  } else if (ops.length > 0 && ops.length >= parts.length) {
    ops.pop();
  }
  return { parts, ops };
}

function splitShellOutsideQuotes(str, isSepFn) {
  return splitShellOutsideQuotesWithOps(str, isSepFn).parts;
}

function unwrapShellPayloadToken(payload) {
  const s = String(payload || "")
    .replace(/\s+2>&1\s*$/g, "")
    .replace(/\s+2>(?:\/dev\/null|\$null|nul)\s*$/gi, "")
    .trim();
  if (!s) return "";
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
    const q = s[0];
    let closedAt = -1;
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (q === '"') {
        if (ch === "`" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "`")) {
          i++;
          continue;
        }
        if (ch === "\\" && i + 1 < s.length && (s[i + 1] === "\\" || s[i + 1] === '"')) {
          if (s[i + 1] === "\\") {
            i++;
            continue;
          }
          const atEnd = i + 2 === s.length;
          if (!atEnd || !WIN_DRIVE_OR_UNC_PATH_BEFORE_TRAILING_BS_RE.test(s.slice(1, i))) {
            i++;
            continue;
          }
        }
      }
      if (ch === q) {
        closedAt = i;
        break;
      }
    }
    if (closedAt === s.length - 1) {
      const inner = s.slice(1, -1);
      if (q === "'") return inner.trim();
      return inner.replace(/\\"/g, '"').replace(/`"/g, '"').trim();
    }
    return "";
  }
  return s;
}

function stripShellExecPathPrefix(stageStr) {
  const quotedExec = stageStr.match(/^("([^"]+)"|'([^']+)')(?:\s+(.*))?$/);
  if (quotedExec) {
    const rawExec = quotedExec[2] ?? quotedExec[3] ?? "";
    const rest = quotedExec[4] || "";
    if (!/(?:^|[\\/])scripts[\\/]/i.test(rawExec) && /[\\/]/.test(rawExec)) {
      const base = rawExec.replace(/^.*[\\/]/, "");
      return rest ? `${base} ${rest}` : base;
    }
    return stageStr;
  }
  const unquotedExec = stageStr.match(/^([^\s"']+)(?:\s+(.*))?$/);
  if (unquotedExec) {
    const rawExec = unquotedExec[1];
    const rest = unquotedExec[2] || "";
    if (!/(?:^|[\\/])scripts[\\/]/i.test(rawExec) && /[\\/]/.test(rawExec)) {
      const base = rawExec.replace(/^.*[\\/]/, "");
      return rest ? `${base} ${rest}` : base;
    }
  }
  return stageStr;
}

function normalizeShellStageHead(stage) {
  let s = String(stage || "").trim();
  if (!s) return "";
  s = s.replace(/^&\s+/, "");
  while (true) {
    s = stripShellExecPathPrefix(s);
    const envCmd = s.match(/^(?:env|cross-env)(?:\s+(?:-u\s+\S+|-i))*\s+(.*)$/i);
    if (envCmd) {
      s = envCmd[1].trim();
      continue;
    }
    const assign = s.match(/^[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+(.*)$/i);
    if (assign) {
      s = assign[1].trim();
      continue;
    }
    break;
  }
  return stripShellExecPathPrefix(s);
}

function unwrapSingleShellWrapperClause(clause) {
  const stages = splitShellOutsideQuotes(String(clause || "").trim(), (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length !== 1) return "";
  const head = normalizeShellStageHead(stages[0]);
  const m = head.match(SHELL_WRAPPER_CMD_RE);
  if (!m || !m[1]) return "";
  return unwrapShellPayloadToken(m[1]);
}

function splitShellClauses(commandText, depth = 0) {
  const cleaned = String(commandText || "").trim();
  if (!cleaned) return { clauses: [], operators: [] };
  const { parts, ops } = splitShellOutsideQuotesWithOps(cleaned, (s, i) => {
    if (s[i] === ";") return 1;
    if ((s[i] === "&" && s[i + 1] === "&") || (s[i] === "|" && s[i + 1] === "|")) return 2;
    return 0;
  });
  if (depth >= 2 || parts.length === 0) {
    return { clauses: parts, operators: ops };
  }
  const expandedClauses = [];
  const expandedOps = [];
  for (let idx = 0; idx < parts.length; idx++) {
    const unwrapped = unwrapSingleShellWrapperClause(parts[idx]);
    if (unwrapped && unwrapped !== parts[idx]) {
      const sub = splitShellClauses(unwrapped, depth + 1);
      if (sub.clauses.length > 0) {
        for (let j = 0; j < sub.clauses.length; j++) {
          expandedClauses.push(sub.clauses[j]);
          if (j < sub.operators.length) expandedOps.push(sub.operators[j]);
        }
        if (idx < ops.length) expandedOps.push(ops[idx]);
        continue;
      }
    }
    expandedClauses.push(parts[idx]);
    if (idx < ops.length) expandedOps.push(ops[idx]);
  }
  return { clauses: expandedClauses, operators: expandedOps };
}

function isPureSetupShellClause(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitShellOutsideQuotes(trimmed, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length !== 1) return false;
  return PURE_SETUP_CLAUSE_RE.test(trimmed);
}

function shellClauseHasFilterStage(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitShellOutsideQuotes(trimmed, (s, i) => (s[i] === "|" ? 1 : 0));
  for (const rawStage of stages) {
    const cleanedStage = rawStage
      .replace(/\b2>&1\b/g, "")
      .replace(/\b2>(?:\/dev\/null|\$null|nul)\b/gi, "")
      .trim();
    const norm = normalizeShellStageHead(cleanedStage);
    if (norm && ZERO_MATCH_FILTER_STAGE_RE.test(norm)) return true;
  }
  return false;
}

function isReadOnlyShellClause(clause) {
  const trimmed = String(clause || "").trim();
  if (!trimmed) return false;
  const stages = splitShellOutsideQuotes(trimmed, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length === 0) return false;
  const head = normalizeShellStageHead(stages[0]);
  return READ_ONLY_STAGE_HEAD_RE.test(head);
}

function isNonConvergingPassCommand(cmd) {
  if (!cmd || typeof cmd !== "string" || !cmd.trim()) return false;
  const { clauses, operators } = splitShellClauses(cmd);
  if (clauses.length === 0) return false;
  let lastSemi = -1;
  for (let i = 0; i < operators.length; i++) {
    if (operators[i] === ";") lastSemi = i;
  }
  const tailClauses = lastSemi >= 0 ? clauses.slice(lastSemi + 1) : clauses;
  const tailOps = lastSemi >= 0 ? operators.slice(lastSemi + 1) : operators;
  if (tailOps.includes("||")) return true;
  const nonSetup = tailClauses.filter((c) => !isPureSetupShellClause(c));
  if (nonSetup.length === 0) return true;
  return nonSetup.every((c) => isReadOnlyShellClause(c) || shellClauseHasFilterStage(c));
}

function isZeroMatchFilterRunCheckBlock(tag, exitCode, cmd, bodyLines) {
  if (tag !== "FAIL" || exitCode !== 1 || !cmd) return false;
  const { clauses, operators } = splitShellClauses(cmd);
  if (clauses.length === 0) return false;
  if (operators.includes("||")) return false;
  if (operators.includes("&&")) {
    for (let idx = 0; idx < clauses.length - 1; idx++) {
      if (!isPureSetupShellClause(clauses[idx])) return false;
    }
  }
  const lastClause = clauses[clauses.length - 1];
  const stages = splitShellOutsideQuotes(lastClause, (s, i) => (s[i] === "|" ? 1 : 0));
  if (stages.length === 0) return false;
  const finalStage = normalizeShellStageHead(
    stages[stages.length - 1]
      .replace(/\b2>&1\b/g, "")
      .replace(/\b2>(?:\/dev\/null|\$null|nul)\b/gi, "")
      .trim()
  );
  if (!ZERO_MATCH_FILTER_STAGE_RE.test(finalStage)) return false;
  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:Command\s+)?exited with code\s+1\.?$/i.test(line)) continue;
    if (/^(?:\(no output\)|No output from the command\.?)$/i.test(line)) continue;
    return false;
  }
  return true;
}

const REAL_CODE_ERROR_CHECK_RE =
  /(?:^|\n)\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|ImportError|ModuleNotFoundError|ValueError|NameError|AttributeError|KeyError|IndexError|FileNotFoundError|RuntimeError|IndentationError|ZeroDivisionError|ZodError|Error:|FAIL\s+\S|✖\s+|not ok\s+\d+|E\s+assert\b|error(?:\[E\d+\]|\s+TS\d{4})?:|panic:|fatal error:|Traceback \(most recent call last\)|Cannot find module\b|Module not found\b)/m;

function hasRealCodeErrorInBlock(text = "") {
  if (!text || typeof text !== "string") return false;
  const cleaned = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^(?:TIMED OUT|Command timed out|Exited with code\s+\d+|Command exited with code\s+\d+|No output from the command)\b/i.test(t)) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  if (!cleaned) return false;
  if (REAL_CODE_ERROR_CHECK_RE.test(cleaned)) return true;
  if (/\b([1-9]\d*)\s+failed\b/i.test(cleaned)) return true;
  return false;
}

function parseRunChecksBlocks(responseText) {
  if (!responseText || typeof responseText !== "string") {
    return {
      failureSection: "",
      realFailBlocks: 0,
      timeoutBlocks: 0,
      skippedBlocks: 0,
      benignZeroMatchBlocks: 0,
      passCmds: [],
      passedEntries: [],
      failedEntries: []
    };
  }
  const normalized = responseText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const failingLines = [];
  const passCmds = [];
  const passedEntries = [];
  const failedEntries = [];
  let realFailBlocks = 0;
  let timeoutBlocks = 0;
  let skippedBlocks = 0;
  let benignZeroMatchBlocks = 0;
  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.tag === "PASS") {
      passCmds.push(current.cmd || "");
      passedEntries.push({ name: current.name || "", command: current.cmd || "" });
    } else if (current.tag === "TIMEOUT") {
      const bodyStr = current.bodyLines.join("\n");
      if (hasRealCodeErrorInBlock(bodyStr)) {
        realFailBlocks += 1;
        failedEntries.push({ name: current.name || "", command: current.cmd || "" });
        for (const l of current.bodyLines) failingLines.push(l);
      } else {
        timeoutBlocks += 1;
      }
    } else if (current.tag === "SKIPPED") {
      skippedBlocks += 1;
    } else if (isZeroMatchFilterRunCheckBlock(current.tag, current.exitCode, current.cmd, current.bodyLines)) {
      benignZeroMatchBlocks += 1;
    } else {
      realFailBlocks += 1;
      failedEntries.push({ name: current.name || "", command: current.cmd || "" });
      for (const l of current.bodyLines) failingLines.push(l);
    }
    current = null;
  };

  for (const line of lines) {
    const compactPass = line.match(/^- \[PASS[^\]]*\]\s+(.+?)(?:\s+\(`(.+?)`\))?:\s*(.*)$/);
    if (compactPass) {
      flush();
      const cName = (compactPass[1] || "").trim();
      const cCmd = (compactPass[2] || "").trim();
      passCmds.push(cCmd);
      passedEntries.push({ name: cName, command: cCmd });
      continue;
    }
    const heading = line.match(/^## \[(PASS|FAIL|TIMEOUT|ERROR|SKIPPED)([^\]]*)\]\s*(.*)$/i);
    if (heading) {
      flush();
      const tag = heading[1].toUpperCase();
      const exitMatch = (heading[2] || "").match(/exit\s+(\d+)/i);
      current = {
        tag,
        name: (heading[3] || "").trim(),
        exitCode: exitMatch ? Number(exitMatch[1]) : tag === "PASS" ? 0 : null,
        cmd: "",
        justEntered: true,
        bodyLines: []
      };
      continue;
    }
    if (!current) continue;
    // Skip echoed `$ <command>` line immediately under a check heading so command args never create false error anchors
    if (current.justEntered && /^\$\s+/.test(line.trim())) {
      current.cmd = line.trim().replace(/^\$\s+/, "").trim();
      current.justEntered = false;
      continue;
    }
    current.justEntered = false;
    if (current.tag !== "PASS") {
      current.bodyLines.push(line);
    }
  }
  flush();

  return {
    failureSection: failingLines.join("\n").trim(),
    realFailBlocks,
    timeoutBlocks,
    skippedBlocks,
    benignZeroMatchBlocks,
    passCmds,
    passedEntries,
    failedEntries
  };
}

export function extractVerificationSignal(toolName, args = {}, responseText = "") {
  if (!responseText || typeof responseText !== "string") return null;

  // Case 1: apply_edits with inline verify command
  let verifyCmd = "";
  let isRunChecks = false;
  let runChecksCmd = "";
  let runChecksBatchCommands = [];
  const normalizeRunChecksCmds = (rawList) => {
    const cmds = Array.isArray(rawList) ? rawList : [];
    const batch = cmds
      .map((c) =>
        typeof c === "string"
          ? { name: "", command: c.trim() }
          : { name: String(c?.name || "").trim(), command: String(c?.command || "").trim() }
      )
      .filter((c) => c.name || c.command)
      .slice(0, 12);
    const label = cmds
      .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    return { batch, label };
  };
  const bareTool = stripHostNamespace(toolName);
  if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    verifyCmd = typeof args.verify === "string" ? args.verify : args.verify?.command || "";
  } else if (bareTool === "run_checks" || /(?:^|_)run_checks$/.test(bareTool)) {
    isRunChecks = true;
    const parsedCmds = Array.isArray(args.commands) ? args.commands : parseMaybeJson(args.commands);
    const norm = normalizeRunChecksCmds(parsedCmds);
    runChecksBatchCommands = norm.batch;
    runChecksCmd = norm.label;
  } else if (bareTool === "call_mcp_tool") {
    const mcpTool = stripHostNamespace(cleanPath(args.ToolName || args.toolName || ""));
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    if (mcpTool === "apply_edits" || /(?:^|_)apply_edits$/.test(mcpTool)) {
      verifyCmd = typeof mcpArgs.verify === "string" ? mcpArgs.verify : mcpArgs.verify?.command || "";
    } else if (mcpTool === "run_checks" || /(?:^|_)run_checks$/.test(mcpTool)) {
      isRunChecks = true;
      const parsedCmds = Array.isArray(mcpArgs.commands) ? mcpArgs.commands : parseMaybeJson(mcpArgs.commands);
      const norm = normalizeRunChecksCmds(parsedCmds);
      runChecksBatchCommands = norm.batch;
      runChecksCmd = norm.label;
    }
  }

  if (verifyCmd) {
    const m = responseText.match(/Verify \[(PASS|FAIL|TIMEOUT)[^\]]*\]\s*[^\n]*:/i);
    if (m) {
      const status = m[1].toUpperCase();
      const passed = status === "PASS";
      if (passed && isNonConvergingPassCommand(verifyCmd)) {
        return null;
      }
      const isBuild = /\b(?:build|tsc|typecheck|lint|eslint|biome|webpack|vite|clippy)\b/i.test(verifyCmd);
      const rawAfterBanner = !passed
        ? responseText.slice((m.index || 0) + m[0].length).trim()
        : "";
      const isPureTimeout = status === "TIMEOUT" && !hasRealCodeErrorInBlock(rawAfterBanner);
      const failureSection = passed || isPureTimeout ? "" : rawAfterBanner;
      return {
        kind: isBuild ? "build" : "test",
        command: verifyCmd,
        ruleId: "apply_edits_verify",
        exitCode: passed ? 0 : 1,
        passed,
        outcome: passed ? "pass" : isPureTimeout ? "timeout" : "fail",
        timedOut: isPureTimeout,
        summary: m[0].slice(0, 180),
        failureSection
      };
    }
  }

  if (isRunChecks) {
    const m = responseText.match(/^Checks:\s*(\d+)\/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/m);
    if (m) {
      const passedCnt = Number(m[1]);
      const totalCnt = Number(m[2]);
      const failedCnt = m[3] ? Number(m[3]) : Math.max(0, totalCnt - passedCnt);
      const parsed = parseRunChecksBlocks(responseText);
      const allFailedBenignZeroMatch =
        failedCnt > 0 &&
        parsed.realFailBlocks === 0 &&
        parsed.timeoutBlocks === 0 &&
        parsed.benignZeroMatchBlocks > 0 &&
        parsed.benignZeroMatchBlocks === failedCnt;
      if (passedCnt === 0 && allFailedBenignZeroMatch) {
        return null;
      }
      const onlyBenignZeroMatch = passedCnt > 0 && allFailedBenignZeroMatch;
      const passed = (failedCnt === 0 && totalCnt > 0) || onlyBenignZeroMatch;
      if (passed && parsed.passCmds.length > 0 && parsed.passCmds.every((c) => c && isNonConvergingPassCommand(c))) {
        return null;
      }
      const isPureTimeout =
        !passed &&
        failedCnt > 0 &&
        parsed.realFailBlocks === 0 &&
        parsed.timeoutBlocks > 0 &&
        parsed.timeoutBlocks + parsed.skippedBlocks + parsed.benignZeroMatchBlocks >= failedCnt;
      const accountedFailed =
        parsed.realFailBlocks + parsed.timeoutBlocks + parsed.skippedBlocks + parsed.benignZeroMatchBlocks;
      const missingFailureCount =
        !passed && !isPureTimeout && failedCnt > accountedFailed
          ? failedCnt - accountedFailed
          : 0;
      const missingDetails = missingFailureCount > 0 && parsed.realFailBlocks === 0;
      const isBuild =
        /\b(?:build|tsc|typecheck|lint|eslint|biome|check)\b/i.test(runChecksCmd) &&
        !/\btest\b/i.test(runChecksCmd);
      const failureSection = !passed && !isPureTimeout ? (parsed.failureSection || "") : "";
      const summary = onlyBenignZeroMatch
        ? `${m[0]} (${parsed.benignZeroMatchBlocks} benign 0-match filter)`
        : isPureTimeout
          ? `${m[0]} (timed out)`
          : m[0];
      return {
        kind: isBuild ? "build" : "test",
        command: runChecksCmd || "run_checks",
        ruleId: "run_checks",
        exitCode: passed ? 0 : 1,
        passed,
        outcome: passed ? "pass" : isPureTimeout ? "timeout" : "fail",
        timedOut: isPureTimeout,
        ...(missingDetails ? { missingDetails: true, missingFailureCount } : {}),
        ...(runChecksBatchCommands.length > 0 ? { batchCommands: runChecksBatchCommands } : {}),
        batchTotalCount: totalCnt,
        ...(!passed && !isPureTimeout && parsed.failedEntries.length > 0
          ? { failedCommands: parsed.failedEntries.slice(0, 8) }
          : {}),
        ...(parsed.passedEntries.length > 0 ? { passedCommands: parsed.passedEntries.slice(0, 12) } : {}),
        summary,
        failureSection
      };
    }
  }

  return null;
}

export async function processPostToolPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return;
  const payload = { ...rawPayload };
  if (!payload.toolCall && (payload.hook_event_name === "PostToolUse" || typeof payload.tool_name === "string")) {
    payload.toolCall = {
      name: payload.tool_name || "",
      args: payload.tool_input || {}
    };
  }
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};
  const cwd = payload.cwd || process.cwd();
  const sessionId = resolveSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);
  const rawTranscriptPath =
    (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) ||
    (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) ||
    (typeof payload.common?.transcriptPath === "string" && payload.common.transcriptPath.trim()) ||
    (typeof payload.common?.transcript_path === "string" && payload.common.transcript_path.trim()) ||
    "";
  const payloadConvIds = [
    sessionId,
    directConvId,
    payload.rootConversationId,
    payload.root_conversation_id,
    payload.parentConversationId,
    payload.parent_conversation_id,
    payload.conversationId,
    payload.conversation_id,
    payload.common?.conversationId,
    payload.common?.conversation_id
  ].filter(Boolean);

  const { paths, clearAllSession } = extractInvalidationTargets(toolName, args, cwd);
  const responseText = extractToolResponseText(payload);
  const receipt = isContextExecution(toolCall) && executionReceiptFromText(responseText);
  const fastToolName = extractFastSavingsToolName(toolCall);
  const fastFingerprint = fastToolName ? fastToolFingerprint(fastToolName, responseText) : null;
  const responseIsError = extractResponseIsError(payload);
  const bareToolName = stripHostNamespace(toolName);
  const isReadTool = bareToolName === "read_file" || bareToolName === "view_file" || bareToolName === "read";
  const readWasCancelledOrFailed =
    isReadTool &&
    (responseIsError ||
      payload.cancelled === true ||
      payload.aborted === true ||
      payload.isCancelled === true ||
      payload.is_cancelled === true ||
      String(payload.status || "").toLowerCase() === "cancelled" ||
      String(payload.status || "").toLowerCase() === "aborted" ||
      String(payload.status || "").toLowerCase() === "error");
  let failedReadTarget = null;
  if (readWasCancelledOrFailed) {
    const rawReadPath = cleanPath(
      args.Path || args.path || args.AbsolutePath || args.absolute_path || args.file_path || args.filePath || args.TargetFile
    );
    if (rawReadPath) {
      const absReadPath = path.isAbsolute(rawReadPath) ? path.normalize(rawReadPath) : path.resolve(cwd, rawReadPath);
      const rawStart = args.StartLine ?? args.startLine ?? args.start_line ?? args.offset;
      const rawEnd = args.EndLine ?? args.endLine ?? args.end_line;
      const rawLimit = args.limit ?? args.Limit;
      const startLine = Number.isFinite(Number(rawStart)) && Number(rawStart) > 0 ? Math.floor(Number(rawStart)) : null;
      let endLine = Number.isFinite(Number(rawEnd)) && Number(rawEnd) > 0 ? Math.floor(Number(rawEnd)) : null;
      if (endLine === null && startLine !== null && Number.isFinite(Number(rawLimit)) && Number(rawLimit) > 0) {
        endLine = startLine + Math.floor(Number(rawLimit)) - 1;
      }
      failedReadTarget = { absPath: absReadPath, startLine, endLine };
    }
  }
  const verifySignal = extractVerificationSignal(toolName, args, responseText);

  const effectiveCfg = getEffectiveConfig();
  const resolvedDbPath = effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  const shouldTouchWatchdog =
    Boolean(effectiveCfg.stallWatchdog) &&
    Boolean(directConvId && directConvId !== "default") &&
    (clearAllSession || paths.length > 0 || Boolean(failedReadTarget) || Boolean(verifySignal) || fs.existsSync(resolvedDbPath));

  if (clearAllSession || paths.length > 0 || failedReadTarget || verifySignal || shouldTouchWatchdog || receipt || fastFingerprint) {
    let store = null;
    try {
      const [{ ContextModeStore }, { redactSecrets }, watchdogLeaseMod, filterRulesMod] = await Promise.all([
        import("../context/lib/store.js"),
        import("../context/lib/security.js"),
        shouldTouchWatchdog ? import("../context/lib/watchdog-lease-core.js") : Promise.resolve(null),
        verifySignal && !verifySignal.passed && verifySignal.failureSection
          ? import("./filter-rules.mjs")
          : Promise.resolve(null)
      ]);
      store = new ContextModeStore({ hookMode: true, maxBusyRetries: 4, maxRetryDeadlineMs: 800 });
      const rawClaimOwner = sessionId !== "default" ? sessionId : directConvId;
      const effectiveRootSessionId =
        typeof store.resolveRootSessionId === "function"
          ? store.resolveRootSessionId(rawClaimOwner)
          : rawClaimOwner;
      if (receipt) store.claimExecutionReceipts(effectiveRootSessionId, [receipt]);
      if (fastFingerprint && !responseIsError && typeof store.claimFastToolEvent === "function") {
        store.claimFastToolEvent(effectiveRootSessionId, {
          fingerprint: fastFingerprint,
          tool: fastToolName,
          worktree: cwd,
          directConvId
        });
      }
      if (failedReadTarget && typeof store.invalidatePendingFileRead === "function") {
        const invalidateCancelledRead = (targetPath) => {
          store.invalidatePendingFileRead({
            sessionId,
            filePath: targetPath,
            startLine: failedReadTarget.startLine,
            endLine: failedReadTarget.endLine
          });
          if (directConvId && directConvId !== sessionId) {
            store.invalidatePendingFileRead({
              sessionId: directConvId,
              filePath: targetPath,
              startLine: failedReadTarget.startLine,
              endLine: failedReadTarget.endLine
            });
          }
        };
        invalidateCancelledRead(failedReadTarget.absPath);
        const realReadTarget = resolveRealPathBestEffort(failedReadTarget.absPath);
        if (
          realReadTarget &&
          (process.platform === "win32"
            ? realReadTarget.toLowerCase() !== failedReadTarget.absPath.toLowerCase()
            : realReadTarget !== failedReadTarget.absPath)
        ) {
          invalidateCancelledRead(realReadTarget);
        }
      }
      if (clearAllSession) {
        store.invalidateFileReads(sessionId, null);
        if (directConvId && directConvId !== sessionId) {
          store.invalidateFileReads(directConvId, null);
        }
      } else if (paths.length > 0) {
        const partialApplied = extractPartialAppliedPaths(responseText, toolName, args, cwd, paths);
        const explicitlyApplied = /^\s*Applied edits to \d+ file\(s\):/im.test(responseText);
        const bareToolForWrite = stripHostNamespace(toolName);
        const effectiveApplyTool =
          bareToolForWrite === "call_mcp_tool"
            ? stripHostNamespace(cleanPath(args.ToolName || args.toolName || ""))
            : bareToolForWrite;
        const effectiveApplyArgs =
          bareToolForWrite === "call_mcp_tool"
            ? parseMaybeJson(args.Arguments ?? args.arguments) || {}
            : args;
        const isBestEffortApply =
          (effectiveApplyTool === "apply_edits" || /(?:^|_)apply_edits$/.test(effectiveApplyTool)) &&
          Boolean(effectiveApplyArgs?.bestEffort) &&
          !effectiveApplyArgs?.dryRun;
        const abortedNoWrite =
          partialApplied === null &&
          !explicitlyApplied &&
          (responseIsError ||
            /^\s*(?:(?:Atomic edit aborted|Edit aborted|Validation failed)\s*\(0 files modified\)|Write failed \(changes rolled back\)|Dry run validated|Encountered error in step execution|Tool error \(|Error(?:\s*\[[A-Z0-9_]+\])?:)/i.test(
              responseText
            ));
        // When bestEffort apply_edits returns isError with an empty toolResponse (e.g. host omits
        // PostToolUse response payload), some files may still have been written on disk: fail safe
        // by invalidating read-dedup/ghost caches for all candidate paths without polluting modifiedFiles.
        const isUnconfirmedBestEffortError = isBestEffortApply && !responseText && responseIsError;
        const invalidationPaths =
          partialApplied !== null
            ? partialApplied
            : isUnconfirmedBestEffortError
              ? paths
              : abortedNoWrite
                ? []
                : paths;
        const checkpointSourcePaths =
          partialApplied !== null ? partialApplied : abortedNoWrite ? [] : paths;
        if (invalidationPaths.length > 0) {
          const invalidateSinglePath = (target) => {
            store.invalidateFileReads(sessionId, target);
            if (typeof store.clearGhostInterception === "function") {
              store.clearGhostInterception(sessionId, target);
            }
            if (directConvId && directConvId !== sessionId) {
              store.invalidateFileReads(directConvId, target);
              if (typeof store.clearGhostInterception === "function") {
                store.clearGhostInterception(directConvId, target);
              }
            }
            if (typeof store.invalidateFileReadsByPath === "function") {
              store.invalidateFileReadsByPath(target);
            }
          };
          for (const absPath of invalidationPaths) {
            invalidateSinglePath(absPath);
            const realTarget = resolveRealPathBestEffort(absPath);
            if (
              realTarget &&
              (process.platform === "win32"
                ? realTarget.toLowerCase() !== absPath.toLowerCase()
                : realTarget !== absPath)
            ) {
              invalidateSinglePath(realTarget);
            }
          }
        }
        if (checkpointSourcePaths.length > 0) {
          const wsLogicalForm =
            cwd && typeof cwd === "string" && cwd.trim()
              ? (process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd))
              : "";
          const checkpointPaths = checkpointSourcePaths
            .filter(
              (absPath) =>
                !isEphemeralScratchOrTempPathOutsideWorkspace(absPath, cwd, {
                  conversationIds: payloadConvIds,
                  transcriptPath: rawTranscriptPath
                })
            )
            .map((absPath) => {
              const absForm = process.platform === "win32" ? absPath.toLowerCase() : absPath;
              if (wsLogicalForm && isSameOrInsideAnyDir([absForm], [wsLogicalForm])) {
                return absPath;
              }
              const realTarget = resolveRealPathBestEffort(absPath);
              return realTarget || absPath;
            });
          if (checkpointPaths.length > 0) {
            const realCwd = resolveRealPathBestEffort(cwd) || cwd;
            store.recordModifiedFiles(effectiveRootSessionId, checkpointPaths, {
              worktree: wsLogicalForm ? cwd : realCwd,
              tool: toolName
            });
          }
        }
      }
      if (verifySignal) {
        const safeCommand = redactSecrets(verifySignal.command || "").text;
        const safeSummary = redactSecrets(verifySignal.summary || "").text;
        const redactCmdEntries = (list) =>
          Array.isArray(list)
            ? list.map((item) => ({
                name: redactSecrets(String(item?.name || "")).text,
                command: redactSecrets(String(item?.command || "")).text
              }))
            : undefined;
        const rawFailureSection = !verifySignal.passed ? verifySignal.failureSection || "" : "";
        const safeFailureExcerpt =
          rawFailureSection && typeof filterRulesMod?.extractFailureExcerpt === "function"
            ? filterRulesMod.extractFailureExcerpt(redactSecrets(rawFailureSection).text)
            : "";
        const { failureSection: _ignoredSection, ...cleanVerifySignal } = verifySignal;
        store.recordVerificationResult(effectiveRootSessionId, {
          ...cleanVerifySignal,
          command: safeCommand,
          summary: safeSummary,
          ...(Array.isArray(cleanVerifySignal.batchCommands)
            ? { batchCommands: redactCmdEntries(cleanVerifySignal.batchCommands) }
            : {}),
          ...(Array.isArray(cleanVerifySignal.failedCommands)
            ? { failedCommands: redactCmdEntries(cleanVerifySignal.failedCommands) }
            : {}),
          ...(Array.isArray(cleanVerifySignal.passedCommands)
            ? { passedCommands: redactCmdEntries(cleanVerifySignal.passedCommands) }
            : {}),
          failureExcerpt: safeFailureExcerpt,
          worktree: cwd
        });
      }
      if (
        shouldTouchWatchdog &&
        watchdogLeaseMod?.recordHookLeaseTransition &&
        (typeof store.isWatchdogEnabled !== "function" || store.isWatchdogEnabled())
      ) {
        try {
          watchdogLeaseMod.recordHookLeaseTransition(store, "PostToolUse", payload, {
            directConvId,
            rootSessionId: effectiveRootSessionId,
            cwd,
            toolName,
            toolArgs: args,
            responseText,
            asyncBypassMs: effectiveCfg.cliFilterAsyncBypassMs ?? 2000
          });
        } catch {}
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

  return;
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

  await processPostToolPayload(payload);
  process.stdout.write("{}\n");
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));
if (isDirectRun) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
