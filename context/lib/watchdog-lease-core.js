/**
 * Ultra-lightweight Watchdog Lease core writer/reader shared by high-frequency
 * lifecycle hooks (`PreToolUse`, `PostToolUse`) and the Watchdog / Sidecar stack.
 *
 * Keeps top-level imports restricted to `node:path`, `node:url`, `./security.js`,
 * and `./stable-json.js` (zero `node:fs`, zero `node:sqlite`, zero transcript/summary
 * scanning) so per-tool-call hooks pay minimal parse/link cost.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./security.js";
import { truncateUtf8Safe } from "./stable-json.js";
export { truncateUtf8Safe };

export const WATCHDOG_LEASE_PREFIX = "watchdog_lease:";
export const WATCHDOG_PHASES = Object.freeze({
  IDLE: "IDLE",
  LLM_INFLIGHT: "LLM_INFLIGHT",
  TOOL_RUNNING: "TOOL_RUNNING",
  SUBAGENT_BG: "SUBAGENT_BG"
});

const RESERVED_CONV_IDS = new Set(["default", "all", "lifetime", "app"]);
const SLASH_COMPACT_RE = /^\s*\/compact(?:\s|$)/i;
export const TTL_KEEPALIVE_PROMPT_RE = /\[agy-dart TTL(?:保活| Keepalive)(?:\s|\])/i;
export const HEADLESS_FINISH_PROMPT_RE =
  /\bWhen you are done,\s*call the finish tool with your result\./i;
export const SUBAGENT_ROLE_RE =
  /(?:^|[-_\s/])(?:sub[-_]?agent|worker|monitor|swarm|research(?:er)?|verifier|review(?:er)?|explor(?:er|e)|audit(?:or)?|investigat(?:or)?|browser|image[-_]?generator)(?:$|[-_\s/])|^(?:DeepCoder|DeepInvestigator)[A-Za-z0-9_-]*$/i;
export const PRIMARY_HOST_AGENT_NAME_RE =
  /^(?:antigravity|main|default|primary|chat|user|assistant|cascade|coordinator)$/i;
export const SUBAGENT_GENESIS_SYS_MSG_RE =
  /\[Message\]\s+timestamp=\S+\s+sender=[0-9a-f-]{8,}|<original_task>|<subagent_reminder>|\brunning as a subagent,\s*invoked by a caller agent\b|<swarm_(?:brief|board|assignment)>|\[Swarm\s+(?:Brief|Assignment|Worker)\b|\bYou are a swarm worker\b|\bswarm_monitor\s+SKILL\.md\b/i;
export const SUBAGENT_TOOL_RE =
  /^(?:subagent|task|agent|delegate|call_subagent|invoke_subagent|run_workflow|schedule|manage_task|send_message|browser_subagent|spawn_subagent|run_subagent)$/i;
export const LONG_MCP_TOOL_RE = /^(?:ctx_execute|ctx_batch|run_checks)$/i;
export const SLOW_GEN_TOOL_RE = /^(?:generate_image|image_generator)$/i;
const LOW_OR_MEDIUM_EFFORT_RE = /(?:^|[-_/\s(])(?:low|medium|med|minimal)(?:$|[-_/\s)])/i;
const HIGH_REASONING_MODEL_RE =
  /(?:^|[-_/\s(])(?:high|xhigh)(?:$|[-_/\s)])|thinking|(?:^|[-_/\s(])o[134](?:$|[-_/\s.)])|deepseek[-_/\s]?r1|(?:^|[-_/\s(])opus(?:$|[-_/\s).\d])|gemini[-_/\s]?4(?:[-_/\s.])?(?:carbon|neon)(?:$|[-_/\s.\d])|orchestrator[-_/\s._]*neon/i;
export const KNOWN_MCP_TOOL_RE =
  /^(?:ctx_execute|ctx_batch|ctx_index|ctx_search|ctx_resume|ctx_stats|ctx_doctor|ctx_purge|batch_search|apply_edits|read_slices|run_checks|list_resources|read_resource)$/i;
const HOST_NAMESPACE_RE = /^(?:default_api|builtin|host|antigravity|core|native)$/i;
const BG_RESPONSE_RE = /\b(?:running as a background task|background task with task id|scheduled|running in the background)\b/i;
const MAX_PENDING_SLOW_CALLS = 8;

const AMBIGUOUS_LEAF_DIR_RE =
  /^(?:\d+|v\d+(?:[._-]\d+)*|src|app|apps|lib|pkg|packages|package|client|server|web|api|core|main|trunk|dev|prod|test|tests|docs|scripts|build|dist)$/i;
const INTERNAL_REPO_DIRS_RE =
  /^(?:src|lib|test|tests|__tests__|spec|specs|docs|doc|scripts|bin|config|configs|public|assets|static|styles|components|views|pages|routes|controllers|models|utils|helpers|hooks|context|fast|sidecars|rules|skills|dist|build|out|target|coverage|node_modules|vendor|tmp|temp)$/i;
const MONOREPO_CONTAINER_DIRS_RE = /^(?:packages|apps|services|modules|crates|plugins|projects)$/i;
const SYSTEM_HOME_PARENT_RE = /^(?:users|home|root|mnt|volumes|var|tmp|opt)$/i;

let _registeredSummaryLookup = null;

/**
 * Registers the optional synchronous summary lookup implementation provided by
 * `./watchdog-summaries.js` so `recordHookLeaseTransition` stays decoupled from SQLite.
 */
export function registerSummaryLookup(fn) {
  _registeredSummaryLookup = typeof fn === "function" ? fn : null;
}

export function isTtlKeepalivePrompt(rawText) {
  if (typeof rawText !== "string" || !rawText) return false;
  return TTL_KEEPALIVE_PROMPT_RE.test(rawText);
}

export function isHeadlessWorkerPrompt(rawText) {
  if (typeof rawText !== "string" || !rawText) return false;
  return HEADLESS_FINISH_PROMPT_RE.test(rawText);
}

export function isSummaryMetadataSubagent({
  conversationId = "",
  parentConversationId = "",
  rootConversationId = "",
  nestingDepth = 0,
  agentName = "",
  title = "",
  allowUntitledCustomAgent = true
} = {}) {
  const safeConv = sanitizeConversationId(conversationId);
  const safeParent = sanitizeConversationId(parentConversationId);
  if (safeParent && safeParent !== safeConv) return true;
  const safeRoot = sanitizeConversationId(rootConversationId);
  if (safeRoot && safeConv && safeRoot !== safeConv) return true;
  const depthNum = Number(nestingDepth);
  if (Number.isFinite(depthNum) && depthNum > 0) return true;
  const cleanAgent = typeof agentName === "string" ? agentName.trim() : "";
  if (!cleanAgent || PRIMARY_HOST_AGENT_NAME_RE.test(cleanAgent)) return false;
  if (cleanAgent.toLowerCase() === "self" || SUBAGENT_ROLE_RE.test(cleanAgent)) return true;
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle && allowUntitledCustomAgent !== false) return true;
  return false;
}

export function computeCausalTurnLlmFloorTs(lease, nowMs) {
  if (!lease || typeof lease !== "object") return 0;
  const now = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : Date.now();
  const turnFloorTs = lease.startedTs > 0 && lease.startedTs <= now ? lease.startedTs : 0;
  const maxAgeMs = 30 * 60 * 1000;
  let floor = 0;
  const consider = (ts) => {
    if (
      Number.isFinite(ts) &&
      ts > 0 &&
      ts <= now &&
      (turnFloorTs === 0 || ts >= turnFloorTs - 1_000) &&
      now - ts <= maxAgeMs
    ) {
      floor = Math.max(floor, Math.floor(ts));
    }
  };
  consider(lease.lastLlmStartTs);
  consider(lease.lastCompletedToolTs);
  if (lease.phase === WATCHDOG_PHASES.TOOL_RUNNING || lease.phase === WATCHDOG_PHASES.SUBAGENT_BG) {
    consider(lease.phaseChangedTs);
  }
  return floor;
}

export function isSubagentLeasePayload(payload = {}, env = process.env) {
  const envSub = String(env?.ANTIGRAVITY_SUBAGENT || "").trim().toLowerCase();
  if (envSub === "1" || envSub === "true") return true;
  const envSwarmWorker = String(env?.ANTIGRAVITY_SWARM_WORKER || "").trim().toLowerCase();
  if (envSwarmWorker === "1" || envSwarmWorker === "true") return true;
  if (env?.ANTIGRAVITY_PARENT_CONVERSATION_ID) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const common =
    payload.common && typeof payload.common === "object" && !Array.isArray(payload.common) ? payload.common : null;
  const meta =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : null;

  for (const bag of [payload, common, meta]) {
    if (!bag) continue;
    if (
      bag.subagent === true ||
      bag.isSubagent === true ||
      bag.is_subagent === true ||
      bag.swarmWorker === true ||
      bag.isSwarmWorker === true ||
      bag.is_swarm_worker === true
    ) {
      return true;
    }
    if (
      (typeof bag.subagentId === "string" && bag.subagentId.trim()) ||
      (typeof bag.subagent_id === "string" && bag.subagent_id.trim())
    ) {
      return true;
    }
    const workerName = [bag.workerName, bag.worker_name, bag.rosterName, bag.roster_name]
      .find((v) => typeof v === "string" && v.trim());
    if (workerName && !PRIMARY_HOST_AGENT_NAME_RE.test(workerName.trim())) {
      return true;
    }
    const swarmObj = bag.swarm && typeof bag.swarm === "object" && !Array.isArray(bag.swarm) ? bag.swarm : null;
    if (swarmObj) {
      if (swarmObj.isWorker === true || swarmObj.is_worker === true) return true;
      const swRole = typeof swarmObj.role === "string" ? swarmObj.role.trim() : "";
      if (swRole && !PRIMARY_HOST_AGENT_NAME_RE.test(swRole) && SUBAGENT_ROLE_RE.test(swRole)) return true;
      const swName = [swarmObj.workerName, swarmObj.worker_name, swarmObj.name]
        .find((v) => typeof v === "string" && v.trim());
      if (swName && !PRIMARY_HOST_AGENT_NAME_RE.test(swName.trim()) && swRole.toLowerCase() !== "coordinator") {
        return true;
      }
    }
    const spec = bag.subagentSpec ?? bag.subagent_spec ?? null;
    if (spec && typeof spec === "object" && !Array.isArray(spec) && Object.keys(spec).length > 0) {
      return true;
    }
    const depth = Number(bag.nestingDepth ?? bag.nesting_depth);
    if (Number.isFinite(depth) && depth > 0) return true;
  }

  const convId = sanitizeConversationId(
    payload.conversationId ||
      payload.conversation_id ||
      common?.conversationId ||
      common?.conversation_id ||
      payload.sessionId ||
      payload.session_id ||
      ""
  );
  const directParent = sanitizeConversationId(
    payload.parentConversationId ||
      payload.parent_conversation_id ||
      common?.parentConversationId ||
      common?.parent_conversation_id ||
      meta?.parentConversationId ||
      meta?.parent_conversation_id ||
      payload.parentSessionId ||
      payload.parent_session_id ||
      meta?.parentSessionId ||
      meta?.parent_session_id ||
      ""
  );
  if (directParent && directParent !== convId) return true;

  const isBattle = Boolean(
    payload.isBattleMode ||
      payload.is_battle_mode ||
      common?.isBattleMode ||
      common?.is_battle_mode ||
      meta?.isBattleModeFork ||
      meta?.is_battle_mode_fork
  );
  const rootId = sanitizeConversationId(
    payload.rootConversationId ||
      payload.root_conversation_id ||
      common?.rootConversationId ||
      common?.root_conversation_id ||
      meta?.rootConversationId ||
      meta?.root_conversation_id ||
      env?.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
      ""
  );
  if (!isBattle && convId && rootId && rootId !== convId) return true;

  const roleCandidates = [
    payload.role,
    payload.agentRole,
    payload.agent_role,
    payload.agentType,
    payload.agent_type,
    payload.agentName,
    payload.agent_name,
    payload.swarmRole,
    payload.swarm_role,
    payload.sessionType,
    payload.session_type,
    payload.sessionKind,
    payload.session_kind,
    common?.agentName,
    common?.agent_name,
    common?.role,
    common?.swarmRole,
    common?.swarm_role,
    meta?.role,
    meta?.agentRole,
    meta?.agent_role,
    meta?.agentType,
    meta?.agent_type,
    meta?.agentName,
    meta?.agent_name,
    meta?.swarmRole,
    meta?.swarm_role
  ];
  for (const candidate of roleCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const clean = candidate.trim();
      if (!PRIMARY_HOST_AGENT_NAME_RE.test(clean) && (clean.toLowerCase() === "self" || SUBAGENT_ROLE_RE.test(clean))) {
        return true;
      }
    }
  }
  return false;
}

export function getToolTimeoutTier(toolKind = "", phase = "") {
  if (phase === WATCHDOG_PHASES.SUBAGENT_BG || toolKind === "subagent" || toolKind === "async_cmd") return 4;
  if (toolKind === "sync_cmd" || toolKind === "mcp_long") return 3;
  if (toolKind === "mcp") return 2;
  if (toolKind === "read" || toolKind === "host") return 1;
  return 0;
}

export function sanitizeConversationId(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return "";
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return "";
  if (RESERVED_CONV_IDS.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

export function getWatchdogLeaseKey(conversationId) {
  const safeId = sanitizeConversationId(conversationId);
  return safeId ? `${WATCHDOG_LEASE_PREFIX}${safeId}` : "";
}

export function sanitizeWatchdogText(raw, maxBytes = 200) {
  if (raw === null || raw === undefined) return "";
  const redacted = redactSecrets(String(raw)).text;
  const flat = redacted
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (Buffer.byteLength(flat, "utf8") <= maxBytes) return flat;
  const budget = Math.max(1, maxBytes - 3);
  if (maxBytes <= 3) return truncateUtf8Safe(flat, maxBytes);
  return `${truncateUtf8Safe(flat, budget)}...`;
}

export function sanitizeCwd(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || /^[\\/]{2}/.test(trimmed)) return "";
  return trimmed.slice(0, 512);
}

export function isSameWorkspacePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (/^[a-zA-Z]:(?:\/|$)/.test(na) || /^[a-zA-Z]:(?:\/|$)/.test(nb) || process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

export function decodeFileUriOrPath(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  if (/^file:\/\//i.test(trimmed)) {
    const winDriveMatch = trimmed.match(/^file:\/\/\/([a-zA-Z])(?::|%3[aA])(\/.*)?$/);
    if (winDriveMatch) {
      const drive = winDriveMatch[1];
      let rest = winDriveMatch[2] || "/";
      try {
        rest = decodeURIComponent(rest);
      } catch {}
      const sep = process.platform === "win32" ? "\\" : "/";
      const normalizedRest = rest.replace(/\//g, sep);
      return sanitizeCwd(`${drive}:${normalizedRest}`);
    }
    try {
      return sanitizeCwd(fileURLToPath(trimmed));
    } catch {
      try {
        return sanitizeCwd(fileURLToPath(decodeURIComponent(trimmed)));
      } catch {
        return "";
      }
    }
  }
  return sanitizeCwd(trimmed);
}

export function parseWorkspaceUriToPath(rawWorkspaceUris) {
  if (typeof rawWorkspaceUris !== "string") return "";
  const trimmed = rawWorkspaceUris.trim();
  if (!trimmed) return "";
  const candidates = [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") candidates.push(item);
          else if (item && typeof item === "object") candidates.push(item.uri || item.path || "");
        }
      } else if (typeof parsed === "string") {
        candidates.push(parsed);
      } else if (parsed && typeof parsed === "object") {
        candidates.push(parsed.uri || parsed.path || "");
      }
    } catch {}
  }
  if (candidates.length === 0) {
    const uriMatches = trimmed.match(/file:\/\/[^\s"',;\]]+/gi);
    if (uriMatches && uriMatches.length > 0) {
      candidates.push(...uriMatches);
    } else {
      candidates.push(...trimmed.split(/[\r\n,;]+/));
    }
  }
  for (const cand of candidates) {
    const decoded = decodeFileUriOrPath(cand);
    if (decoded) return decoded;
  }
  return "";
}

export function extractPayloadWorkspaceRoot(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
  const direct = decodeFileUriOrPath(payload.cwd || payload.workspacePath || payload.workspace_path || meta?.cwd || "");
  if (direct) return direct;

  const listSources = [
    payload.workspacePaths,
    payload.workspace_paths,
    payload.workspaceRoots,
    payload.workspace_roots,
    payload.workspaces,
    meta?.workspacePaths,
    meta?.workspace_paths,
    meta?.workspaceRoots,
    meta?.workspace_roots
  ];
  for (const src of listSources) {
    if (typeof src === "string" && src.trim()) {
      const p = parseWorkspaceUriToPath(src) || decodeFileUriOrPath(src);
      if (p) return p;
    } else if (Array.isArray(src)) {
      for (const item of src) {
        const raw = typeof item === "string" ? item : item?.uri || item?.path || "";
        const p = decodeFileUriOrPath(raw);
        if (p) return p;
      }
    }
  }
  return "";
}

/**
 * Pure, 0-fs-I/O smart window/subproject label formatter:
 *   - Disambiguates numeric/version/generic leaf dirs (`e:\故事\1` -> `故事/1`, `d:\proj\v2` -> `proj/v2`)
 *   - Refines umbrella workspaces (`e:\work` + edits/reads inside `e:\work\agy-dart\...` -> `work/agy-dart`)
 */
export function formatWorkspaceWindowLabel(cwd, modifiedOrReadPaths = []) {
  const cleanCwd = decodeFileUriOrPath(cwd);
  if (!cleanCwd) return "";
  const posixCwd = cleanCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!posixCwd) return "";

  const hasWinDrive = /^[a-zA-Z]:(?:\/|$)/.test(posixCwd);
  const bodyAfterRoot = hasWinDrive ? posixCwd.slice(2).replace(/^\/+/, "") : posixCwd.replace(/^\/+/, "");
  const segments = bodyAfterRoot.split("/").filter(Boolean);
  if (segments.length === 0) return "";

  const leaf = segments[segments.length - 1];
  const parent = segments.length >= 2 ? segments[segments.length - 2] : "";
  const isShortAmbiguous =
    leaf.length === 1 || (Buffer.byteLength(leaf, "utf8") <= 2 && /^[a-z0-9._-]+$/i.test(leaf));
  const needsParent =
    Boolean(parent) &&
    !SYSTEM_HOME_PARENT_RE.test(parent) &&
    (AMBIGUOUS_LEAF_DIR_RE.test(leaf) || isShortAmbiguous);
  const baseLabel = needsParent ? `${parent}/${leaf}` : leaf;

  if (Array.isArray(modifiedOrReadPaths) && modifiedOrReadPaths.length > 0) {
    const cwdPrefix = `${posixCwd}/`;
    const cwdPrefixLower = cwdPrefix.toLowerCase();
    const caseInsensitive = hasWinDrive || process.platform === "win32";
    const subprojects = new Set();
    const subprojectDisplay = new Map();
    let sawRootFile = false;
    let sawInternalRepoDir = false;

    for (const entry of modifiedOrReadPaths) {
      const rawPath =
        typeof entry === "string"
          ? entry.trim()
          : entry && typeof entry.path === "string"
            ? entry.path.trim()
            : "";
      if (!rawPath || rawPath.includes("\0")) continue;
      let posixPath = rawPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      if (!posixPath) continue;

      let rel = "";
      const isAbs = posixPath.startsWith("/") || /^[a-zA-Z]:(?:\/|$)/.test(posixPath);
      if (isAbs) {
        const matchesCwd = caseInsensitive
          ? posixPath.toLowerCase().startsWith(cwdPrefixLower)
          : posixPath.startsWith(cwdPrefix);
        if (!matchesCwd) continue;
        rel = posixPath.slice(cwdPrefix.length);
      } else {
        if (posixPath === ".." || posixPath.startsWith("../")) continue;
        rel = posixPath;
      }

      const relParts = rel.split("/").filter(Boolean);
      if (relParts.length === 0) continue;
      if (relParts.length === 1) {
        if (!relParts[0].startsWith(".")) sawRootFile = true;
        continue;
      }

      const dir1 = relParts[0];
      if (MONOREPO_CONTAINER_DIRS_RE.test(dir1) && relParts.length >= 3 && !relParts[1].startsWith(".")) {
        const sub = relParts[1];
        const key = caseInsensitive ? sub.toLowerCase() : sub;
        subprojects.add(key);
        if (!subprojectDisplay.has(key)) subprojectDisplay.set(key, sub);
      } else if (dir1.startsWith(".") || INTERNAL_REPO_DIRS_RE.test(dir1)) {
        if (!/^\.(?:gemini|agy-dart|vscode|idea)$/i.test(dir1)) {
          sawInternalRepoDir = true;
        }
      } else {
        const key = caseInsensitive ? dir1.toLowerCase() : dir1;
        subprojects.add(key);
        if (!subprojectDisplay.has(key)) subprojectDisplay.set(key, dir1);
      }
    }

    if (!sawRootFile && !sawInternalRepoDir && subprojects.size === 1) {
      const [onlyKey] = subprojects;
      const subName = subprojectDisplay.get(onlyKey) || onlyKey;
      if (subName && subName.toLowerCase() !== leaf.toLowerCase()) {
        return sanitizeWatchdogText(`${baseLabel}/${subName}`, 48);
      }
    }
  }

  return sanitizeWatchdogText(baseLabel, 48);
}

export function extractInlinePayloadTitle(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
  const candidates = [
    payload.conversationTitle,
    payload.conversation_title,
    payload.title,
    meta?.conversationTitle,
    meta?.conversation_title
  ];
  for (const cand of candidates) {
    if (typeof cand !== "string") continue;
    const trimmed = cand.trim();
    if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) continue;
    if (Buffer.byteLength(trimmed, "utf8") > 160) continue;
    if (HEADLESS_FINISH_PROMPT_RE.test(trimmed)) continue;
    const clean = sanitizeWatchdogText(trimmed, 36);
    if (clean) return clean;
  }
  return "";
}

function firstNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function toFiniteTs(val, fallback = 0) {
  if (val === null || val === undefined || typeof val === "boolean") return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toOptionalNonNegInt(val) {
  if (val === null || val === undefined || val === "" || typeof val === "boolean") return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function parseMaybeJsonObj(val) {
  if (!val) return {};
  if (typeof val === "object" && !Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function unwrapJsonQuotedString(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export function extractBareToolName(rawName) {
  const name = unwrapJsonQuotedString(String(rawName || ""));
  if (!name) return "";
  const colonIdx = name.lastIndexOf(":");
  const afterColon = colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
  const mcpMatch = afterColon.match(/^mcp_+[^_]+_+(.+)$/);
  if (mcpMatch) {
    const tail = mcpMatch[1];
    const known = tail.match(
      /(?:^|_)(ctx_execute|ctx_batch|ctx_index|ctx_search|ctx_resume|ctx_stats|ctx_doctor|ctx_purge|batch_search|apply_edits|read_slices|run_checks)$/
    );
    if (known) return known[1];
    return tail;
  }
  return afterColon;
}

export function isHighReasoningModel(model) {
  if (typeof model !== "string") return false;
  const trimmed = model.trim();
  if (!trimmed) return false;
  if (LOW_OR_MEDIUM_EFFORT_RE.test(trimmed)) return false;
  return HIGH_REASONING_MODEL_RE.test(trimmed);
}

export function deriveLlmSubphase({ contextTokens = 0, mediaCount = 0, isCompactCmd = false, model = "" } = {}) {
  const ctx = Number(contextTokens || 0);
  const media = Number(mediaCount || 0);
  const highReasoning = isHighReasoningModel(model);
  if (ctx >= 500000 || (highReasoning && (ctx >= 250000 || (ctx >= 100000 && media > 0)))) {
    return "reasoning_compound";
  }
  if (highReasoning) return "reasoning";
  if (ctx >= 250000) return "ultra_high_ctx";
  if ((ctx >= 150000 && media > 0) || (ctx >= 100000 && media >= 3)) return "multimodal_high_ctx";
  if (isCompactCmd) return "compact";
  if (ctx >= 120000) return "high_ctx";
  return "normal";
}

export function classifyToolExecutionKind(toolName, rawArgs = {}, options = {}) {
  const args = parseMaybeJsonObj(rawArgs);
  let effectiveName = String(toolName || "").trim();
  let effectiveArgs = args;
  const rawBare = extractBareToolName(effectiveName);
  const wasCallMcpTool = rawBare === "call_mcp_tool";

  if (wasCallMcpTool) {
    const mcpTool = unwrapJsonQuotedString(String(args.ToolName || args.toolName || ""));
    const mcpServer = unwrapJsonQuotedString(String(args.ServerName || args.serverName || ""));
    const mcpArgs = parseMaybeJsonObj(args.Arguments ?? args.arguments);
    effectiveName = mcpTool || (mcpServer ? `mcp:${mcpServer}` : "call_mcp_tool");
    effectiveArgs = mcpArgs;
  }

  const colonIdx = effectiveName.lastIndexOf(":");
  const colonPrefix = colonIdx > 0 ? effectiveName.slice(0, colonIdx).trim() : "";
  const isNamespacedMcp =
    wasCallMcpTool || /^mcp_/i.test(effectiveName) || (colonIdx > 0 && !HOST_NAMESPACE_RE.test(colonPrefix));

  const bare = extractBareToolName(effectiveName);
  const asyncBypassMs = Number.isFinite(Number(options.asyncBypassMs)) ? Number(options.asyncBypassMs) : 2000;

  if (!isNamespacedMcp && bare === "run_command") {
    const cmd = String(
      effectiveArgs.CommandLine ?? effectiveArgs.commandLine ?? effectiveArgs.command ?? ""
    ).trim();
    const isDaemon = Boolean(effectiveArgs.IsDaemon || effectiveArgs.isDaemon);
    const rawWait = effectiveArgs.WaitMsBeforeAsync ?? effectiveArgs.waitMsBeforeAsync;
    const waitMs =
      rawWait !== undefined && rawWait !== null && rawWait !== "" && typeof rawWait !== "boolean"
        ? Number(rawWait)
        : NaN;
    const isAsync = asyncBypassMs > 0 && Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= asyncBypassMs;
    const isBackground = isDaemon || isAsync;
    return {
      activeTool: "run_command",
      activeToolKind: isBackground ? "async_cmd" : "sync_cmd",
      isBackground,
      summary: sanitizeWatchdogText(cmd, 180)
    };
  }

  if (!isNamespacedMcp && (bare === "read_file" || bare === "view_file")) {
    const p = String(
      effectiveArgs.Path ??
        effectiveArgs.path ??
        effectiveArgs.filePath ??
        effectiveArgs.AbsolutePath ??
        effectiveArgs.absolutePath ??
        ""
    ).trim();
    const base = p ? path.basename(p.replace(/[\\/]+$/, "")) : "";
    return {
      activeTool: bare,
      activeToolKind: "read",
      isBackground: false,
      summary: sanitizeWatchdogText(base || p, 120)
    };
  }

  const isSwarmBg =
    bare.toLowerCase() === "swarm" &&
    /^(?:add|wait|spawn|start)$/i.test(String(effectiveArgs.action || effectiveArgs.Action || "").trim());
  if (
    isSwarmBg ||
    SUBAGENT_TOOL_RE.test(bare) ||
    /(?:^|_)(?:subagent|delegate|schedule|manage_task)$/i.test(bare)
  ) {
    const desc =
      effectiveArgs.TaskId ||
      effectiveArgs.taskId ||
      effectiveArgs.Prompt ||
      effectiveArgs.prompt ||
      effectiveArgs.description ||
      effectiveArgs.workflow ||
      effectiveArgs.name ||
      effectiveArgs.code ||
      effectiveArgs.Action ||
      effectiveArgs.action ||
      "";
    return {
      activeTool: bare || effectiveName || "subagent",
      activeToolKind: "subagent",
      isBackground: true,
      summary: sanitizeWatchdogText(desc, 140)
    };
  }

  if (
    bare === "apply_edits" &&
    typeof effectiveArgs.verify === "string" &&
    effectiveArgs.verify.trim() !== ""
  ) {
    return {
      activeTool: "apply_edits",
      activeToolKind: "mcp_long",
      isBackground: false,
      summary: sanitizeWatchdogText(effectiveArgs.verify.trim(), 160)
    };
  }

  if (SLOW_GEN_TOOL_RE.test(bare)) {
    const desc =
      effectiveArgs.ImageName ||
      effectiveArgs.imageName ||
      effectiveArgs.Prompt ||
      effectiveArgs.prompt ||
      "";
    return {
      activeTool: bare,
      activeToolKind: "mcp_long",
      isBackground: false,
      summary: sanitizeWatchdogText(desc, 160)
    };
  }

  if (LONG_MCP_TOOL_RE.test(bare)) {
    const aliasIntent =
      bare === "ctx_execute"
        ? [effectiveArgs.intent, effectiveArgs.summary, effectiveArgs.description].find(
            (v) => typeof v === "string" && v.trim()
          ) || ""
        : effectiveArgs.intent;
    const desc =
      aliasIntent ||
      effectiveArgs.file ||
      (Array.isArray(effectiveArgs.commands)
        ? effectiveArgs.commands
            .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
            .filter(Boolean)
            .slice(0, 3)
            .join(", ")
        : "") ||
      effectiveArgs.language ||
      "";
    return {
      activeTool: bare,
      activeToolKind: "mcp_long",
      isBackground: false,
      summary: sanitizeWatchdogText(desc, 160)
    };
  }

  const fallbackDesc =
    effectiveArgs.Path ||
    effectiveArgs.path ||
    effectiveArgs.TargetFile ||
    effectiveArgs.targetFile ||
    effectiveArgs.SearchPath ||
    effectiveArgs.DirectoryPath ||
    effectiveArgs.query ||
    effectiveArgs.url ||
    effectiveArgs.command ||
    "";
  const isMcpTool = isNamespacedMcp || KNOWN_MCP_TOOL_RE.test(bare);
  return {
    activeTool: bare || effectiveName || "tool",
    activeToolKind: isMcpTool ? "mcp" : "host",
    isBackground: false,
    summary: sanitizeWatchdogText(fallbackDesc, 140)
  };
}

function normalizePendingSlowCalls(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim().slice(0, 80) : "";
    if (!id || seen.has(id)) continue;
    const activeToolKind = typeof item.activeToolKind === "string" ? item.activeToolKind.slice(0, 32) : "";
    if (getToolTimeoutTier(activeToolKind, WATCHDOG_PHASES.TOOL_RUNNING) < 3) continue;
    const activeTool = typeof item.activeTool === "string" ? item.activeTool.slice(0, 80) : "";
    if (!activeTool) continue;
    seen.add(id);
    out.push({
      id,
      activeTool,
      activeToolKind,
      activeToolSummary: sanitizeWatchdogText(item.activeToolSummary || "", 180),
      subphase: typeof item.subphase === "string" && item.subphase ? item.subphase.slice(0, 48) : "sync_cmd",
      phaseChangedTs: toFiniteTs(item.phaseChangedTs, 0)
    });
  }
  return out.slice(-MAX_PENDING_SLOW_CALLS);
}

function extractLivePendingSlowCalls(existing, now, maxAgeMs) {
  if (!existing || existing.phase !== WATCHDOG_PHASES.TOOL_RUNNING) return [];
  const raw = Array.isArray(existing.pendingSlowCalls) ? existing.pendingSlowCalls : [];
  const map = new Map();
  for (const entry of normalizePendingSlowCalls(raw)) {
    if (entry.phaseChangedTs > 0 && now - entry.phaseChangedTs < maxAgeMs) {
      map.set(entry.id, entry);
    }
  }
  if (
    existing.activeToolCallId &&
    getToolTimeoutTier(existing.activeToolKind, existing.phase) >= 3 &&
    existing.phaseChangedTs > 0 &&
    now - existing.phaseChangedTs < maxAgeMs &&
    !map.has(existing.activeToolCallId)
  ) {
    map.set(existing.activeToolCallId, {
      id: existing.activeToolCallId,
      activeTool: existing.activeTool || "run_command",
      activeToolKind: existing.activeToolKind,
      activeToolSummary: existing.activeToolSummary || "",
      subphase: existing.subphase || "sync_cmd",
      phaseChangedTs: existing.phaseChangedTs
    });
  }
  return Array.from(map.values()).slice(-MAX_PENDING_SLOW_CALLS);
}

export function normalizeWatchdogLease(raw, fallbackConvId = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const conversationId = sanitizeConversationId(raw.conversationId || fallbackConvId);
  if (!conversationId) return null;
  const validPhases = new Set(Object.values(WATCHDOG_PHASES));
  const phase = validPhases.has(raw.phase) ? raw.phase : WATCHDOG_PHASES.IDLE;
  const updatedTs = toFiniteTs(raw.updatedTs, 0);
  const startedTs = toFiniteTs(raw.startedTs, updatedTs);
  const phaseChangedTs = toFiniteTs(raw.phaseChangedTs, updatedTs);
  const lastHeartbeatTs = Math.max(toFiniteTs(raw.lastHeartbeatTs, 0), updatedTs);
  return {
    v: 1,
    conversationId,
    rootSessionId: sanitizeConversationId(raw.rootSessionId) || conversationId,
    parentConversationId: sanitizeConversationId(raw.parentConversationId) || "",
    isSubagent: Boolean(raw.isSubagent),
    phase,
    subphase: typeof raw.subphase === "string" ? raw.subphase.slice(0, 48) : "",
    startedTs,
    phaseChangedTs,
    updatedTs,
    lastHeartbeatTs,
    hookEvent: typeof raw.hookEvent === "string" ? raw.hookEvent.slice(0, 32) : "",
    invocationNum: toOptionalNonNegInt(raw.invocationNum),
    initialNumSteps: toOptionalNonNegInt(raw.initialNumSteps),
    lastUserInput: sanitizeWatchdogText(raw.lastUserInput || "", 240),
    isCompactCmd: Boolean(raw.isCompactCmd),
    activeTool: typeof raw.activeTool === "string" ? raw.activeTool.slice(0, 80) : "",
    activeToolKind: typeof raw.activeToolKind === "string" ? raw.activeToolKind.slice(0, 32) : "",
    activeToolSummary: sanitizeWatchdogText(raw.activeToolSummary || "", 180),
    activeToolCallId:
      (phase === WATCHDOG_PHASES.TOOL_RUNNING || phase === WATCHDOG_PHASES.SUBAGENT_BG) &&
      typeof raw.activeToolCallId === "string"
        ? raw.activeToolCallId.trim().slice(0, 80)
        : "",
    pendingSlowCalls:
      phase === WATCHDOG_PHASES.TOOL_RUNNING ? normalizePendingSlowCalls(raw.pendingSlowCalls) : [],
    lastCompletedTool: typeof raw.lastCompletedTool === "string" ? raw.lastCompletedTool.slice(0, 80) : "",
    lastCompletedToolTs: toFiniteTs(raw.lastCompletedToolTs, 0),
    cwd: sanitizeCwd(raw.cwd || ""),
    workspaceLabel: sanitizeWatchdogText(raw.workspaceLabel || "", 48),
    convTitle: sanitizeWatchdogText(raw.convTitle || "", 36),
    transcriptPath:
      typeof raw.transcriptPath === "string" &&
      !raw.transcriptPath.includes("\0") &&
      !/^[\\/]{2}/.test(raw.transcriptPath.trim())
        ? raw.transcriptPath.trim().slice(0, 512)
        : "",
    transcriptMtimeMs:
      Number.isFinite(Number(raw.transcriptMtimeMs)) && Number(raw.transcriptMtimeMs) > 0
        ? Number(raw.transcriptMtimeMs)
        : 0,
    transcriptSize:
      Number.isFinite(Number(raw.transcriptSize)) && Number(raw.transcriptSize) >= 0
        ? Math.floor(Number(raw.transcriptSize))
        : 0,
    contextTokens:
      Number.isFinite(Number(raw.contextTokens)) && Number(raw.contextTokens) >= 0
        ? Math.floor(Number(raw.contextTokens))
        : 0,
    windowTokens:
      Number.isFinite(Number(raw.windowTokens)) && Number(raw.windowTokens) >= 0
        ? Math.floor(Number(raw.windowTokens))
        : 0,
    warnTokens:
      Number.isFinite(Number(raw.warnTokens)) && Number(raw.warnTokens) >= 0
        ? Math.floor(Number(raw.warnTokens))
        : 0,
    criticalTokens:
      Number.isFinite(Number(raw.criticalTokens)) && Number(raw.criticalTokens) >= 0
        ? Math.floor(Number(raw.criticalTokens))
        : 0,
    watermark:
      typeof raw.watermark === "string" &&
      (raw.watermark === "ok" || raw.watermark === "warn" || raw.watermark === "critical")
        ? raw.watermark
        : "",
    mediaCount:
      Number.isFinite(Number(raw.mediaCount)) && Number(raw.mediaCount) >= 0
        ? Math.floor(Number(raw.mediaCount))
        : 0,
    model: typeof raw.model === "string" ? raw.model.slice(0, 96) : "",
    cacheTtlSec:
      Number.isFinite(Number(raw.cacheTtlSec)) && Number(raw.cacheTtlSec) > 0
        ? Math.floor(Number(raw.cacheTtlSec))
        : 0,
    ttlSource:
      typeof raw.ttlSource === "string" &&
      (raw.ttlSource === "explicit" || raw.ttlSource === "empirical" || raw.ttlSource === "profile")
        ? raw.ttlSource
        : "",
    idleAnchorTs: toFiniteTs(raw.idleAnchorTs, 0),
    cacheOriginTs: (() => {
      const rawIdle = toFiniteTs(raw.idleAnchorTs, 0);
      const rawOrigin = toFiniteTs(raw.cacheOriginTs, 0);
      if (phase === WATCHDOG_PHASES.IDLE && rawIdle > 0 && rawOrigin > rawIdle) {
        return rawIdle;
      }
      return rawOrigin;
    })(),
    lastLlmStartTs: toFiniteTs(raw.lastLlmStartTs, 0),
    stopReason: raw.stopReason ? sanitizeWatchdogText(raw.stopReason, 120) : "",
    ackedUntilTs: toFiniteTs(raw.ackedUntilTs, 0)
  };
}

export function readWatchdogLease(store, conversationId) {
  if (!store || typeof store.getMeta !== "function") return null;
  const key = getWatchdogLeaseKey(conversationId);
  if (!key) return null;
  try {
    const raw = store.getMeta(key, null);
    if (!raw || typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    return normalizeWatchdogLease(parsed, conversationId);
  } catch {
    return null;
  }
}

export function writeWatchdogLease(store, lease) {
  if (!store || typeof store.setMeta !== "function" || !lease) return null;
  const normalized = normalizeWatchdogLease(lease, lease.conversationId);
  if (!normalized) return null;
  const key = getWatchdogLeaseKey(normalized.conversationId);
  if (!key) return null;
  store.setMeta(key, JSON.stringify(normalized));
  return normalized;
}

/**
 * Atomic compare-and-swap lease write preventing TOCTOU races between Sidecar
 * background self-healing / startup cleanup and concurrent lifecycle hooks.
 */
export function writeWatchdogLeaseIfUnchanged(store, expectedUpdatedTs, expectedPhase, nextLease) {
  if (!store || !nextLease) return { written: false, current: null };
  const normalized = normalizeWatchdogLease(nextLease, nextLease.conversationId);
  if (!normalized) return { written: false, current: null };
  const key = getWatchdogLeaseKey(normalized.conversationId);
  if (!key) return { written: false, current: null };

  const execCas = () => {
    const current = readWatchdogLease(store, normalized.conversationId);
    if (!current) return { written: false, current: null };
    if (current.updatedTs !== expectedUpdatedTs || current.phase !== expectedPhase) {
      return { written: false, current };
    }
    store.setMeta(key, JSON.stringify(normalized));
    return { written: true, lease: normalized, current: normalized };
  };

  if (typeof store._withWriteTx === "function") {
    if (typeof store.open === "function") store.open();
    return store._withWriteTx(execCas);
  }
  return execCas();
}

/**
 * Atomic compare-and-swap lease deletion preventing TOCTOU races when periodic
 * IDLE lease pruning runs concurrently with hooks resuming the same conversation.
 */
export function deleteWatchdogLeaseIfUnchanged(store, conversationId, expectedUpdatedTs, expectedPhase) {
  if (!store) return { deleted: false, current: null };
  const cleanId = sanitizeConversationId(conversationId);
  const key = getWatchdogLeaseKey(cleanId);
  if (!cleanId || !key) return { deleted: false, current: null };

  const execCas = () => {
    const current = readWatchdogLease(store, cleanId);
    if (!current) return { deleted: true, current: null };
    if (
      current.updatedTs !== expectedUpdatedTs ||
      current.phase !== expectedPhase ||
      current.subphase === "stopped_bg_pending"
    ) {
      return { deleted: false, current };
    }
    store.deleteMeta?.(key);
    return { deleted: true, current: null };
  };

  if (typeof store._withWriteTx === "function") {
    if (typeof store.open === "function") store.open();
    return store._withWriteTx(execCas);
  }
  return execCas();
}

export function listWatchdogLeases(store) {
  if (!store) return [];
  try {
    let rows = [];
    if (typeof store.listMetaByPrefix === "function") {
      rows = store.listMetaByPrefix(WATCHDOG_LEASE_PREFIX);
    } else if (store.db) {
      rows = store.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'watchdog_lease:%' ORDER BY key ASC")
        .all();
    }
    const leases = [];
    for (const row of rows || []) {
      if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
      const convIdFromKey = row.key.slice(WATCHDOG_LEASE_PREFIX.length);
      try {
        const parsed = JSON.parse(row.value);
        const norm = normalizeWatchdogLease(parsed, convIdFromKey);
        if (norm) leases.push(norm);
      } catch {
        // Ignore corrupted lease JSON
      }
    }
    return leases;
  } catch {
    return [];
  }
}

export function recordHookLeaseTransition(store, eventName, payload = {}, options = {}) {
  if (!store) return null;
  const safePayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const safeOptions = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const now = Number.isFinite(safeOptions.nowMs) ? Math.floor(safeOptions.nowMs) : Date.now();
  const directConvId = sanitizeConversationId(
    safeOptions.directConvId ||
      safePayload.conversationId ||
      safePayload.conversation_id ||
      safePayload.sessionId ||
      safePayload.session_id ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      ""
  );
  if (!directConvId) return null;

  const rootSessionId =
    sanitizeConversationId(
      safeOptions.rootSessionId ||
        safePayload.rootConversationId ||
        safePayload.root_conversation_id ||
        safePayload.parentConversationId ||
        safePayload.parent_conversation_id ||
        process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
        process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
        ""
    ) || directConvId;
  let parentConversationId = sanitizeConversationId(
    safeOptions.parentConversationId ||
      safePayload.parentConversationId ||
      safePayload.parent_conversation_id ||
      process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
      ""
  );
  const rawPromptForHeadlessCheck =
    typeof (safePayload.lastUserInput ?? safePayload.last_user_input) === "string"
      ? String(safePayload.lastUserInput ?? safePayload.last_user_input)
      : "";
  let isSubagent = safeOptions.suppressPayloadSubagent
    ? Boolean(safeOptions.isSubagent)
    : Boolean(
        safeOptions.isSubagent ||
          (parentConversationId && parentConversationId !== directConvId) ||
          (rootSessionId && rootSessionId !== directConvId) ||
          isSubagentLeasePayload(safePayload) ||
          isHeadlessWorkerPrompt(rawPromptForHeadlessCheck)
      );

  const existing = readWatchdogLease(store, directConvId);
  const base = existing || {
    v: 1,
    conversationId: directConvId,
    rootSessionId,
    parentConversationId: parentConversationId && parentConversationId !== directConvId ? parentConversationId : "",
    isSubagent,
    phase: WATCHDOG_PHASES.IDLE,
    subphase: "",
    startedTs: now,
    phaseChangedTs: now,
    updatedTs: now,
    lastHeartbeatTs: now,
    hookEvent: eventName,
    invocationNum: null,
    initialNumSteps: null,
    lastUserInput: "",
    isCompactCmd: false,
    activeTool: "",
    activeToolKind: "",
    activeToolSummary: "",
    activeToolCallId: "",
    pendingSlowCalls: [],
    lastCompletedTool: "",
    lastCompletedToolTs: 0,
    cwd: "",
    workspaceLabel: "",
    convTitle: "",
    transcriptPath: "",
    transcriptMtimeMs: 0,
    transcriptSize: 0,
    contextTokens: 0,
    windowTokens: 0,
    warnTokens: 0,
    criticalTokens: 0,
    watermark: "",
    mediaCount: 0,
    model: "",
    cacheTtlSec: 0,
    ttlSource: "",
    idleAnchorTs: 0,
    cacheOriginTs: 0,
    lastLlmStartTs: 0,
    stopReason: "",
    ackedUntilTs: 0
  };

  const resolvedTranscriptPath =
    (typeof safeOptions.transcriptPath === "string" && safeOptions.transcriptPath.trim()) ||
    (typeof safePayload.transcriptPath === "string" && safePayload.transcriptPath.trim()) ||
    (typeof safePayload.transcript_path === "string" && safePayload.transcript_path.trim()) ||
    base.transcriptPath;

  let resolvedCwd =
    sanitizeCwd(safeOptions.cwd || extractPayloadWorkspaceRoot(safePayload) || "") || base.cwd;

  let resolvedTitle = "";
  if (typeof safeOptions.convTitle === "string" && safeOptions.convTitle.trim()) {
    resolvedTitle = sanitizeWatchdogText(safeOptions.convTitle, 36);
  } else {
    resolvedTitle = extractInlinePayloadTitle(safePayload);
  }
  const summaryLookupFn =
    typeof safeOptions.lookupSummaryFn === "function" ? safeOptions.lookupSummaryFn : _registeredSummaryLookup;
  if (
    summaryLookupFn &&
    (!resolvedTitle || !resolvedCwd || (!isSubagent && !base.isSubagent && !base.convTitle)) &&
    (safeOptions.summaryDbPath || safeOptions.lookupSummary === true)
  ) {
    const summary = summaryLookupFn(directConvId, {
      payload: safePayload,
      cwd: resolvedCwd,
      transcriptPath: resolvedTranscriptPath,
      summaryDbPath: safeOptions.summaryDbPath || "",
      allowDefaultDb: safeOptions.allowDefaultDb !== false,
      checkSubagent: !isSubagent && !base.isSubagent
    });
    if (!resolvedTitle && summary.title) resolvedTitle = summary.title;
    if (!resolvedCwd && summary.cwd) resolvedCwd = summary.cwd;
    if (summary.isSubagent) isSubagent = true;
    if (!parentConversationId && summary.parentConversationId && summary.parentConversationId !== directConvId) {
      parentConversationId = summary.parentConversationId;
    }
  }

  let resolvedWorkspaceLabel = base.workspaceLabel || "";
  if (typeof safeOptions.workspaceLabel === "string" && safeOptions.workspaceLabel.trim()) {
    resolvedWorkspaceLabel = sanitizeWatchdogText(safeOptions.workspaceLabel, 48);
  } else if (resolvedCwd) {
    const computedWs = formatWorkspaceWindowLabel(resolvedCwd, safeOptions.modifiedOrReadPaths || []);
    if (
      base.workspaceLabel &&
      base.cwd &&
      isSameWorkspacePath(base.cwd, resolvedCwd) &&
      computedWs &&
      base.workspaceLabel.toLowerCase().startsWith(`${computedWs.toLowerCase()}/`)
    ) {
      resolvedWorkspaceLabel = base.workspaceLabel;
    } else if (computedWs) {
      resolvedWorkspaceLabel = computedWs;
    }
  }

  const effectiveRootSessionId =
    rootSessionId && rootSessionId !== directConvId
      ? rootSessionId
      : base.rootSessionId && base.rootSessionId !== directConvId
        ? base.rootSessionId
        : parentConversationId && parentConversationId !== directConvId
          ? parentConversationId
          : directConvId;

  const next = {
    ...base,
    conversationId: directConvId,
    rootSessionId: effectiveRootSessionId,
    parentConversationId:
      parentConversationId && parentConversationId !== directConvId
        ? parentConversationId
        : base.parentConversationId || "",
    isSubagent: isSubagent || base.isSubagent,
    cwd: resolvedCwd,
    workspaceLabel: resolvedWorkspaceLabel,
    convTitle: resolvedTitle || base.convTitle || "",
    transcriptPath: resolvedTranscriptPath,
    updatedTs: now,
    lastHeartbeatTs: Math.max(base.lastHeartbeatTs || 0, now),
    hookEvent: eventName,
    ackedUntilTs: 0
  };

  if (Number.isFinite(safeOptions.transcriptSize) && safeOptions.transcriptSize >= 0) {
    next.transcriptSize = Math.floor(safeOptions.transcriptSize);
    if (next.transcriptSize === 0 && !(Number.isFinite(safeOptions.transcriptMtimeMs) && safeOptions.transcriptMtimeMs > 0)) {
      next.transcriptMtimeMs = 0;
    }
  }
  if (Number.isFinite(safeOptions.transcriptMtimeMs) && safeOptions.transcriptMtimeMs > 0) {
    next.transcriptMtimeMs = safeOptions.transcriptMtimeMs;
  }
  if (Number.isFinite(safeOptions.contextTokens) && safeOptions.contextTokens >= 0) {
    next.contextTokens = Math.floor(safeOptions.contextTokens);
  }
  if (Number.isFinite(safeOptions.windowTokens) && safeOptions.windowTokens > 0) {
    next.windowTokens = Math.floor(safeOptions.windowTokens);
  }
  if (Number.isFinite(safeOptions.warnTokens) && safeOptions.warnTokens > 0) {
    next.warnTokens = Math.floor(safeOptions.warnTokens);
  }
  if (Number.isFinite(safeOptions.criticalTokens) && safeOptions.criticalTokens > 0) {
    next.criticalTokens = Math.floor(safeOptions.criticalTokens);
  }
  if (
    typeof safeOptions.watermark === "string" &&
    (safeOptions.watermark === "ok" || safeOptions.watermark === "warn" || safeOptions.watermark === "critical")
  ) {
    next.watermark = safeOptions.watermark;
  }
  if (Number.isFinite(safeOptions.mediaCount) && safeOptions.mediaCount >= 0) {
    next.mediaCount = Math.floor(safeOptions.mediaCount);
  }
  if (typeof safeOptions.model === "string" && safeOptions.model.trim()) {
    next.model = safeOptions.model.trim().slice(0, 96);
  }
  if (Number.isFinite(safeOptions.cacheTtlSec) && safeOptions.cacheTtlSec > 0) {
    next.cacheTtlSec = Math.floor(safeOptions.cacheTtlSec);
  }
  if (
    typeof safeOptions.ttlSource === "string" &&
    (safeOptions.ttlSource === "explicit" ||
      safeOptions.ttlSource === "empirical" ||
      safeOptions.ttlSource === "profile")
  ) {
    next.ttlSource = safeOptions.ttlSource;
  }

  if (eventName === "PreInvocation") {
    const invNum = toOptionalNonNegInt(safePayload.invocationNum ?? safePayload.invocation_num);
    const initSteps = toOptionalNonNegInt(safePayload.initialNumSteps ?? safePayload.initial_num_steps);
    const rawInput =
      typeof (safePayload.lastUserInput ?? safePayload.last_user_input) === "string"
        ? String(safePayload.lastUserInput ?? safePayload.last_user_input)
        : "";
    const isMidTurn = invNum !== null && invNum >= 1;
    const isKeepaliveInput = Boolean(safeOptions.isKeepaliveTurn) || isTtlKeepalivePrompt(rawInput);
    const isSyntheticWake = isKeepaliveInput || Boolean(safeOptions.isBackgroundWakeup);
    if (rawInput.trim() && !isSyntheticWake) {
      next.lastUserInput = sanitizeWatchdogText(rawInput, 240);
      next.isCompactCmd = SLASH_COMPACT_RE.test(rawInput);
    } else if (!isMidTurn || isSyntheticWake) {
      next.isCompactCmd = false;
    }
    if (invNum !== null) next.invocationNum = invNum;
    if (initSteps !== null) next.initialNumSteps = initSteps;

    next.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
    next.subphase = deriveLlmSubphase({
      contextTokens: next.contextTokens,
      mediaCount: next.mediaCount,
      isCompactCmd: next.isCompactCmd,
      model: next.model
    });
    if (!isMidTurn || !existing || existing.phase === WATCHDOG_PHASES.IDLE) {
      next.startedTs = now;
    }
    next.phaseChangedTs = now;
    next.idleAnchorTs = now;
    next.lastLlmStartTs = now;
    next.cacheOriginTs =
      Number.isFinite(safeOptions.cacheOriginTs) && safeOptions.cacheOriginTs > 0
        ? Math.floor(safeOptions.cacheOriginTs)
        : now;
    next.activeTool = "";
    next.activeToolKind = "";
    next.activeToolSummary = "";
    next.activeToolCallId = "";
    next.pendingSlowCalls = [];
    next.stopReason = "";
  } else if (eventName === "PreToolUse") {
    const toolCall = safePayload.toolCall && typeof safePayload.toolCall === "object" ? safePayload.toolCall : {};
    const toolName = safeOptions.toolName || toolCall.name || "";
    const toolArgs = safeOptions.toolArgs || toolCall.args || {};
    const toolCallId = firstNonEmptyString(
      safeOptions.toolCallId,
      toolCall.id,
      toolCall.call_id,
      safePayload.toolCallId,
      safePayload.tool_call_id
    ).slice(0, 80);
    const decision = safeOptions.decision || "allow";
    const cls = classifyToolExecutionKind(toolName, toolArgs, {
      asyncBypassMs: safeOptions.asyncBypassMs
    });
    const incomingPhase = cls.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING;
    const incomingTier = getToolTimeoutTier(cls.activeToolKind, incomingPhase);
    const existingTier = existing ? getToolTimeoutTier(existing.activeToolKind, existing.phase) : 0;
    const recentPendingSlow = extractLivePendingSlowCalls(existing, now, 60_000);
    const existingSlowToolRunning = Boolean(
      existing &&
        existing.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
        existingTier >= 3 &&
        now - (existing.phaseChangedTs || 0) < 60_000
    );
    const preserveLowerTierParallel = Boolean(
      !cls.isBackground &&
        existingSlowToolRunning &&
        incomingTier < existingTier &&
        cls.activeTool !== existing.activeTool
    );
    const otherSlowOnDeny =
      decision === "deny" && toolCallId ? recentPendingSlow.filter((c) => c.id !== toolCallId) : [];

    if (preserveLowerTierParallel) {
      next.phase = existing.phase;
      next.subphase = existing.subphase;
      next.activeTool = existing.activeTool;
      next.activeToolKind = existing.activeToolKind;
      next.activeToolSummary = existing.activeToolSummary;
      next.activeToolCallId = existing.activeToolCallId || "";
      next.pendingSlowCalls = recentPendingSlow;
      next.phaseChangedTs = existing.phaseChangedTs;
      next.stopReason = "";
    } else if (otherSlowOnDeny.length > 0) {
      const keep =
        otherSlowOnDeny.find((c) => c.id === existing?.activeToolCallId) ||
        otherSlowOnDeny[otherSlowOnDeny.length - 1];
      next.phase = WATCHDOG_PHASES.TOOL_RUNNING;
      next.subphase = keep.subphase || "sync_cmd";
      next.activeTool = keep.activeTool;
      next.activeToolKind = keep.activeToolKind;
      next.activeToolSummary = keep.activeToolSummary;
      next.activeToolCallId = keep.id;
      next.pendingSlowCalls = otherSlowOnDeny;
      next.phaseChangedTs = keep.phaseChangedTs || existing.phaseChangedTs;
      next.stopReason = "";
    } else if (decision === "deny") {
      next.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
      next.subphase = deriveLlmSubphase({
        contextTokens: next.contextTokens,
        mediaCount: next.mediaCount,
        isCompactCmd: next.isCompactCmd,
        model: next.model
      });
      next.activeTool = "";
      next.activeToolKind = "";
      next.activeToolSummary = "";
      next.activeToolCallId = "";
      next.pendingSlowCalls = [];
      next.phaseChangedTs = now;
      next.lastLlmStartTs = now;
      next.cacheOriginTs = now;
      next.stopReason = "";
    } else {
      if (cls.isBackground) {
        next.phase = WATCHDOG_PHASES.SUBAGENT_BG;
        next.subphase = cls.activeToolKind;
        next.pendingSlowCalls = [];
      } else {
        next.phase = WATCHDOG_PHASES.TOOL_RUNNING;
        next.subphase =
          cls.activeToolKind === "sync_cmd" || cls.activeToolKind === "mcp_long" ? "sync_cmd" : "read_or_mcp";
        if (incomingTier >= 3 && toolCallId) {
          const filtered = recentPendingSlow.filter((c) => c.id !== toolCallId);
          filtered.push({
            id: toolCallId,
            activeTool: cls.activeTool,
            activeToolKind: cls.activeToolKind,
            activeToolSummary: cls.summary,
            subphase: next.subphase,
            phaseChangedTs: now
          });
          next.pendingSlowCalls = filtered.slice(-MAX_PENDING_SLOW_CALLS);
        } else {
          next.pendingSlowCalls = [];
        }
      }
      if (!existing || existing.phase === WATCHDOG_PHASES.IDLE) {
        next.startedTs = now;
      }
      next.activeTool = cls.activeTool;
      next.activeToolKind = cls.activeToolKind;
      next.activeToolSummary = cls.summary;
      next.activeToolCallId = toolCallId;
      next.phaseChangedTs = now;
      next.stopReason = "";
    }
  } else if (eventName === "PostToolUse") {
    const toolCall = safePayload.toolCall && typeof safePayload.toolCall === "object" ? safePayload.toolCall : {};
    const toolName = safeOptions.toolName || toolCall.name || "";
    const toolArgs = safeOptions.toolArgs || toolCall.args || {};
    const toolCallId = firstNonEmptyString(
      safeOptions.toolCallId,
      toolCall.id,
      toolCall.call_id,
      safePayload.toolCallId,
      safePayload.tool_call_id
    ).slice(0, 80);
    const responseText = typeof safeOptions.responseText === "string" ? safeOptions.responseText : "";
    const cls = classifyToolExecutionKind(toolName, toolArgs, {
      asyncBypassMs: safeOptions.asyncBypassMs
    });
    const launchedBg = cls.isBackground || (responseText && BG_RESPONSE_RE.test(responseText));
    const existingTier = existing ? getToolTimeoutTier(existing.activeToolKind, existing.phase) : 0;
    const completedTier = getToolTimeoutTier(cls.activeToolKind, WATCHDOG_PHASES.TOOL_RUNNING);
    const livePendingSlow = extractLivePendingSlowCalls(existing, now, 600_000);
    const remainingPendingSlow = toolCallId
      ? livePendingSlow.filter((c) => c.id !== toolCallId)
      : livePendingSlow;
    const matchedActiveById = Boolean(toolCallId && existing?.activeToolCallId && toolCallId === existing.activeToolCallId);
    const preserveByPendingCallId = Boolean(
      !launchedBg &&
        String(toolName || "").trim() &&
        toolCallId &&
        existing &&
        existing.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
        existingTier >= 3 &&
        remainingPendingSlow.length > 0
    );
    const preserveExistingSlowTool = Boolean(
      !launchedBg &&
        !matchedActiveById &&
        String(toolName || "").trim() &&
        existing &&
        existing.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
        existingTier >= 3 &&
        completedTier < existingTier &&
        cls.activeTool !== existing.activeTool &&
        now - (existing.phaseChangedTs || 0) < 600_000
    );

    next.lastCompletedTool = cls.activeTool || next.activeTool || "";
    next.lastCompletedToolTs = now;
    next.idleAnchorTs = now;
    if (launchedBg) {
      next.phase = WATCHDOG_PHASES.SUBAGENT_BG;
      next.subphase = cls.activeToolKind === "subagent" ? "subagent_bg" : "bg_task";
      next.activeTool = cls.activeTool;
      next.activeToolKind = cls.isBackground ? cls.activeToolKind : "async_cmd";
      next.activeToolSummary = cls.summary || next.activeToolSummary;
      next.activeToolCallId = toolCallId;
      next.pendingSlowCalls = [];
      next.phaseChangedTs = now;
    } else if (preserveByPendingCallId) {
      const keep =
        remainingPendingSlow.find((c) => c.id === existing.activeToolCallId) ||
        remainingPendingSlow[remainingPendingSlow.length - 1];
      next.phase = WATCHDOG_PHASES.TOOL_RUNNING;
      next.subphase = keep.subphase || existing.subphase || "sync_cmd";
      next.activeTool = keep.activeTool;
      next.activeToolKind = keep.activeToolKind;
      next.activeToolSummary = keep.activeToolSummary;
      next.activeToolCallId = keep.id;
      next.pendingSlowCalls = remainingPendingSlow;
      next.phaseChangedTs = keep.phaseChangedTs || existing.phaseChangedTs;
    } else if (preserveExistingSlowTool) {
      next.phase = existing.phase;
      next.subphase = existing.subphase;
      next.activeTool = existing.activeTool;
      next.activeToolKind = existing.activeToolKind;
      next.activeToolSummary = existing.activeToolSummary;
      next.activeToolCallId = existing.activeToolCallId || "";
      next.pendingSlowCalls = remainingPendingSlow;
      next.phaseChangedTs = existing.phaseChangedTs;
    } else {
      next.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
      next.subphase = deriveLlmSubphase({
        contextTokens: next.contextTokens,
        mediaCount: next.mediaCount,
        isCompactCmd: next.isCompactCmd,
        model: next.model
      });
      next.activeTool = "";
      next.activeToolKind = "";
      next.activeToolSummary = "";
      next.activeToolCallId = "";
      next.pendingSlowCalls = [];
      next.phaseChangedTs = now;
      next.lastLlmStartTs = now;
      next.cacheOriginTs = now;
    }
    if (!existing || existing.phase === WATCHDOG_PHASES.IDLE) {
      next.startedTs = now;
    }
    next.stopReason = "";
  } else if (eventName === "Stop") {
    const explicitReason = firstNonEmptyString(
      safeOptions.stopReason,
      safePayload.terminationReason,
      safePayload.termination_reason,
      safePayload.stopReason,
      safePayload.stop_reason,
      safePayload.endReason,
      safePayload.end_reason,
      safePayload.reason
    );
    const rawErrorSource = safeOptions.error !== undefined ? safeOptions.error : safePayload.error;
    const rawError =
      typeof rawErrorSource === "string"
        ? rawErrorSource.trim()
        : rawErrorSource && typeof rawErrorSource.message === "string"
          ? rawErrorSource.message.trim()
          : "";
    const rawReason = explicitReason || (rawError ? "ERROR" : "stop_hook");
    const normalizedUpperReason = rawReason.toUpperCase().replace(/^EXECUTOR_TERMINATION_REASON_/, "");
    const isAbortOrError =
      normalizedUpperReason === "USER_CANCELED" ||
      normalizedUpperReason === "USER_CANCELLED" ||
      normalizedUpperReason === "ERROR";
    const rawFullyIdle =
      safeOptions.fullyIdle !== undefined
        ? safeOptions.fullyIdle
        : safePayload.fullyIdle !== undefined
          ? safePayload.fullyIdle
          : safePayload.fully_idle;
    const formattedReason =
      normalizedUpperReason === "ERROR" && rawError
        ? `${normalizedUpperReason}: ${rawError}`
        : rawReason;

    const turnFloorTs = base.startedTs > 0 && base.startedTs <= now ? base.startedTs : 0;
    const causalLlmFloorTs = computeCausalTurnLlmFloorTs(base, now);
    const optOriginTs =
      Number.isFinite(safeOptions.cacheOriginTs) && safeOptions.cacheOriginTs > 0
        ? Math.floor(safeOptions.cacheOriginTs)
        : 0;
    let resolvedCacheOriginTs = now;
    if (
      optOriginTs > 0 &&
      optOriginTs <= now + 5_000 &&
      (turnFloorTs === 0 || optOriginTs >= turnFloorTs - 5_000) &&
      (causalLlmFloorTs === 0 || optOriginTs >= causalLlmFloorTs - 5_000) &&
      now - optOriginTs <= 30 * 60 * 1000
    ) {
      resolvedCacheOriginTs = Math.min(now, optOriginTs);
    } else if (causalLlmFloorTs > 0) {
      resolvedCacheOriginTs = causalLlmFloorTs;
    }

    next.phase = WATCHDOG_PHASES.IDLE;
    next.subphase = rawFullyIdle === false && !isAbortOrError ? "stopped_bg_pending" : "stopped";
    next.activeTool = "";
    next.activeToolKind = "";
    next.activeToolSummary = "";
    next.activeToolCallId = "";
    next.pendingSlowCalls = [];
    next.transcriptSize = 0;
    next.transcriptMtimeMs = 0;
    next.phaseChangedTs = now;
    next.idleAnchorTs = now;
    next.cacheOriginTs = resolvedCacheOriginTs;
    next.lastLlmStartTs = 0;
    next.stopReason = sanitizeWatchdogText(formattedReason, 120);
  }

  return writeWatchdogLease(store, next);
}
