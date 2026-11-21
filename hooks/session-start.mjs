#!/usr/bin/env node
/**
 * agy-dart unified SessionStart hook:
 * - Resets transient session overrides & runs lightweight daily DB TTL maintenance
 * - Produces a strictly deterministic, KV-cache prefix-stable systemMessage:
 *   1. Static invariant routing line first
 *   2. Semi-static workspace structure + git-HEAD-cached import hotspot hubs
 *   3. Volatile git branch / working-tree status last
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const FAST_SNAPSHOT_SCRIPT = path.resolve(__dirname, "..", "fast", "session-start.mjs");

export const STATIC_COOP_NOTE =
  "agy-dart active: use agy-dart_fast + parallel ranged read_file for source code search/outline/edits/checks; use agy-dart_context (ctx_execute / ctx_index / ctx_search) for >16 KB logs, large JSON/CSV/API payloads, or long docs/URLs.";

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

function parseHookPayload(rawInput) {
  if (!rawInput) return null;
  if (typeof rawInput === "object") return rawInput;
  try {
    const parsed = JSON.parse(rawInput);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function nonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : "";
}

const SUBAGENT_ROLE_RE = /(?:^|[-_\s/])(?:sub[-_]?agent|worker|research(?:er)?|verifier)(?:$|[-_\s/])/i;

/**
 * Detect whether a SessionStart hook payload / environment belongs to a subagent or swarm worker.
 */
export function isSubagentPayload(payload, env = process.env) {
  const e = env && typeof env === "object" ? env : {};
  if (nonEmptyString(e.ANTIGRAVITY_PARENT_CONVERSATION_ID)) return true;
  const envSubagent = nonEmptyString(e.ANTIGRAVITY_SUBAGENT).toLowerCase();
  if (envSubagent === "1" || envSubagent === "true") return true;

  const p = parseHookPayload(payload);
  if (!p) return false;

  if (p.subagent === true || p.isSubagent === true || p.is_subagent === true) {
    return true;
  }

  if (p.metadata && typeof p.metadata === "object") {
    if (
      p.metadata.subagent === true ||
      nonEmptyString(p.metadata.parentConversationId) ||
      nonEmptyString(p.metadata.parent_conversation_id)
    ) {
      return true;
    }
  }

  if (
    nonEmptyString(p.parentConversationId) ||
    nonEmptyString(p.parent_conversation_id) ||
    nonEmptyString(p.parentSessionId) ||
    nonEmptyString(p.parent_session_id)
  ) {
    return true;
  }

  const rootId = nonEmptyString(p.rootConversationId) || nonEmptyString(p.root_conversation_id);
  const convId =
    nonEmptyString(p.conversationId) ||
    nonEmptyString(p.conversation_id) ||
    nonEmptyString(p.sessionId) ||
    nonEmptyString(p.session_id);
  if (rootId && convId && rootId !== convId) {
    return true;
  }

  const roleCandidates = [
    p.role,
    p.agentRole,
    p.agent_role,
    p.agentType,
    p.agent_type,
    p.sessionType,
    p.session_type,
    p.sessionKind,
    p.session_kind
  ];
  for (const candidate of roleCandidates) {
    const text = nonEmptyString(candidate);
    if (text && SUBAGENT_ROLE_RE.test(text)) {
      return true;
    }
  }

  return false;
}

function resolveWorkspaceDir(rawOrPayload) {
  const payload = parseHookPayload(rawOrPayload);
  if (!payload) return "";
  if (typeof payload.cwd === "string" && payload.cwd.trim()) return payload.cwd.trim();
  const lists = [payload.workspacePaths, payload.workspace_paths, payload.workspaceRoots, payload.workspace_roots];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string" && item.trim()) return item.trim();
      }
    }
  }
  return "";
}

/**
 * Reorder workspace snapshot sections for maximum LLM KV-cache prefix stability:
 *   Static note -> Workspace header -> Project -> Layout -> Core hubs -> Volatile Git status.
 * When `options.omitVolatileGit === true`, all volatile Git lines are omitted so parent sessions,
 * new sessions, and concurrent subagents share a 100% byte-identical Turn-0 KV-cache prefix.
 */
export function assemblePrefixStableStartup(snapshotText, hotspotsLine = "", options = {}) {
  if (!snapshotText) {
    return hotspotsLine ? `${STATIC_COOP_NOTE}\n${hotspotsLine}` : STATIC_COOP_NOTE;
  }

  const omitVolatileGit = Boolean(options?.omitVolatileGit);
  const lines = snapshotText.replace(/\r\n/g, "\n").split("\n");
  const headerLines = [];
  const projectLines = [];
  const layoutLines = [];
  const gitLines = [];
  const otherLines = [];

  let section = "header";
  for (const line of lines) {
    if (line.startsWith("[agy-dart startup snapshot]") || line.startsWith("[agy-fast startup snapshot]")) {
      section = "header";
      headerLines.push(line);
    } else if (line.startsWith("Git:") || line.startsWith("Working tree:") || line.startsWith("Modified (") || line.startsWith("Recent commits:")) {
      section = "git";
      gitLines.push(line);
    } else if (line.startsWith("Project:")) {
      section = "project";
      projectLines.push(line);
    } else if (line.startsWith("Layout (")) {
      section = "layout";
      layoutLines.push(line);
    } else if (section === "git") {
      gitLines.push(line);
    } else if (section === "project") {
      projectLines.push(line);
    } else if (section === "layout") {
      layoutLines.push(line);
    } else if (section === "header" && headerLines.length === 0) {
      headerLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  const ordered = [
    STATIC_COOP_NOTE,
    ...headerLines,
    ...projectLines,
    ...layoutLines,
    ...(hotspotsLine ? [hotspotsLine] : []),
    ...otherLines,
    ...(omitVolatileGit ? [] : gitLines)
  ].filter((l) => l !== "");

  return ordered.join("\n");
}

async function main() {
  const cc = enableVersionedCompileCache();
  const rawInput = (await readStdin()).trim();
  const payload = parseHookPayload(rawInput);
  const workspaceDir = resolveWorkspaceDir(payload);
  const effectiveCfg = getEffectiveConfig();
  const isSubagent = isSubagentPayload(payload, process.env);
  const stablePrefixOnly =
    effectiveCfg.stablePrefixOnly === true ||
    (!effectiveCfg.subagentIncludeGit && isSubagent);

  // 1. Reset transient session overrides (primary sessions only!), run lightweight daily DB TTL cleanup, & fetch repo hubs
  let hotspotsLine = "";
  let store = null;
  try {
    const [{ ContextModeStore }, { getCachedRepoHotspots }] = await Promise.all([
      import("../context/lib/store.js"),
      import("../context/lib/repo-skeleton.js")
    ]);
    store = new ContextModeStore({ hookMode: true });
    if (!isSubagent) {
      store.clearSessionOverrides();
      store.maybeRunDailyMaintenance(14);
    }
    if (workspaceDir && effectiveCfg.repoHubs) {
      hotspotsLine = getCachedRepoHotspots(workspaceDir, store, { maxFiles: 120, maxHubs: 5 });
    }
  } catch {
    // Non-blocking: never block session start on DB error
  } finally {
    if (store) {
      try {
        store.close();
      } catch {}
    }
  }

  // 2. Capture compact workspace snapshot from fast/session-start.mjs (with upstream updater disabled)
  let snapshotText = "";
  if (rawInput) {
    try {
      const childEnv = { ...process.env, AGY_FAST_AUTO_UPDATE: "off" };
      if (cc.enabled && cc.cacheDir) {
        childEnv.NODE_COMPILE_CACHE = cc.cacheDir;
      }
      if (stablePrefixOnly) {
        // Prevent fast/session-start.mjs from running git or letting volatile gitSummary
        // steal 1500-char budget from Layout (2 levels) on medium/large repos.
        childEnv.GIT_DIR = path.join(__dirname, ".agy-dart-no-git");
        delete childEnv.GIT_WORK_TREE;
        delete childEnv.GIT_INDEX_FILE;
        delete childEnv.GIT_COMMON_DIR;
      }
      const res = spawnSync(process.execPath, [FAST_SNAPSHOT_SCRIPT], {
        input: rawInput,
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        env: childEnv
      });
      if (!res.error && res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout.trim());
        snapshotText = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
      }
    } catch {
      // Fail open: fall back to status line only
    }
  }

  const mergedText = assemblePrefixStableStartup(snapshotText, hotspotsLine, {
    omitVolatileGit: stablePrefixOnly
  });

  process.stdout.write(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: mergedText
          }
        }
      ]
    }) + "\n"
  );
}

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
    process.stdout.write(JSON.stringify({}) + "\n");
  });
}
