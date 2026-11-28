import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigSnapshot, getEffectiveConfig, parseUiLang } from "../config.js";
import { readConversationParentId } from "../watchdog-lease.js";
import {
  DEFAULT_ACTIVE_CATEGORIES,
  DEFAULT_CUTOFF_BYTES,
  DEFAULT_EXEMPT_EXTENSIONS,
  FILE_CATEGORIES
} from "./schema.js";

const STORE_HEADLESS_FINISH_RE = /\bWhen you are done,\s*call the finish tool with your result\./i;
const STORE_PRIMARY_HOST_AGENT_RE = /^(?:antigravity|main|default|primary|chat|user|assistant|cascade|coordinator)$/i;
const STORE_SUBAGENT_ROLE_RE =
  /(?:^|[-_\s/])(?:sub[-_]?agent|worker|monitor|swarm|research(?:er)?|verifier|review(?:er)?|explor(?:er|e)|audit(?:or)?|investigat(?:or)?|browser|image[-_]?generator)(?:$|[-_\s/])|^(?:DeepCoder|DeepInvestigator)[A-Za-z0-9_-]*$/i;
const STORE_SUBAGENT_GENESIS_RE =
  /\[Message\]\s+timestamp=\S+\s+sender=[0-9a-f-]{8,}|<original_task>|<subagent_reminder>|\brunning as a subagent,\s*invoked by a caller agent\b|<swarm_(?:brief|board|assignment)>|\[Swarm\s+(?:Brief|Assignment|Worker)\b|\bYou are a swarm worker\b|\bswarm_monitor\s+SKILL\.md\b/i;

function isSameStorePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return process.platform === "win32" || /^[a-zA-Z]:(?:\/|$)/.test(na)
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

function resolveStoreCandidateTranscriptPath(cid, { transcriptPath = "", allowDefaultDb = false } = {}) {
  if (typeof transcriptPath === "string" && transcriptPath.trim()) {
    const direct = transcriptPath.trim();
    try {
      if (fs.existsSync(direct)) return direct;
    } catch {}
  }
  if (!cid || !/^[A-Za-z0-9._-]+$/.test(cid) || cid.includes("..")) return "";
  const roots = [];
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    roots.push(path.join(path.dirname(path.resolve(process.env.AGY_DART_SUMMARY_DB_PATH.trim())), "brain"));
  }
  if (allowDefaultDb) {
    const home = os.homedir();
    if (home) {
      roots.push(path.join(home, ".gemini", "antigravity", "brain"));
      roots.push(path.join(home, ".gemini", "antigravity-ide", "brain"));
      roots.push(path.join(home, ".gemini", "antigravity-cli", "brain"));
    }
  }
  for (const r of roots) {
    const rootAbs = path.resolve(r);
    for (const sub of [
      path.join(cid, ".system_generated", "logs", "transcript_full.jsonl"),
      path.join(cid, ".system_generated", "logs", "transcript.jsonl")
    ]) {
      const cand = path.resolve(rootAbs, sub);
      try {
        if (fs.existsSync(cand)) return cand;
      } catch {}
    }
  }
  return "";
}

const MAX_MAINTENANCE_SUMMARY_LOOKUPS = 500;
const MAX_MAINTENANCE_SCAN_MS = 200;

function collectSummaryDbCandidates({ transcriptPath = "", allowDefaultDb = false } = {}) {
  const candidates = [];
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    candidates.push(path.resolve(process.env.AGY_DART_SUMMARY_DB_PATH.trim()));
  }
  if (typeof transcriptPath === "string" && transcriptPath.trim()) {
    let cur = path.dirname(path.resolve(transcriptPath.trim()));
    for (let depth = 0; depth < 7 && cur; depth += 1) {
      if (path.basename(cur).toLowerCase() === "brain") {
        const agRoot = path.dirname(cur);
        if (agRoot && agRoot !== cur) candidates.push(path.join(agRoot, "conversation_summaries.db"));
        break;
      }
      const next = path.dirname(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }
  if (allowDefaultDb) {
    const home = os.homedir();
    if (home) {
      candidates.push(path.join(home, ".gemini", "antigravity", "conversation_summaries.db"));
      candidates.push(path.join(home, ".gemini", "antigravity-ide", "conversation_summaries.db"));
      candidates.push(path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"));
    }
  }
  const unique = [];
  const seen = new Set();
  for (const dbPath of candidates) {
    const key = process.platform === "win32" ? dbPath.toLowerCase() : dbPath;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dbPath);
  }
  return unique;
}

const SUMMARY_READER_SELECTS = [
  "SELECT title, parent_conversation_id, nesting_depth, agent_name, killed FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
  "SELECT title, parent_conversation_id, nesting_depth, agent_name FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
  "SELECT title FROM conversation_summaries WHERE conversation_id = ? LIMIT 1"
];

function isSummaryMissingColumnError(err) {
  return /no such column/i.test(String(err?.message || err || ""));
}

function querySummaryDbRow(sdb, cid, schemaState = null) {
  let row = null;
  let startTier = Number.isInteger(schemaState?.tier) ? schemaState.tier : 0;
  let lastErr = null;
  for (let i = startTier; i < SUMMARY_READER_SELECTS.length; i += 1) {
    try {
      row = sdb.prepare(SUMMARY_READER_SELECTS[i]).get(cid);
      if (schemaState) schemaState.tier = i;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isSummaryMissingColumnError(err)) {
        throw err;
      }
    }
  }
  if (lastErr) throw lastErr;
  const parentId = readConversationParentId(sdb, cid, row?.parent_conversation_id);
  if (!row && !parentId) return null;
  row ??= {};
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const depth = Number(row.nesting_depth);
  const agent = typeof row.agent_name === "string" ? row.agent_name.trim() : "";
  const killed = Boolean(row.killed === true || (Number.isFinite(Number(row.killed)) && Number(row.killed) > 0));
  const isSubagent = Boolean(
    parentId ||
      (Number.isFinite(depth) && depth > 0) ||
      (agent &&
        !STORE_PRIMARY_HOST_AGENT_RE.test(agent) &&
        (agent.toLowerCase() === "self" || STORE_SUBAGENT_ROLE_RE.test(agent) || !title))
  );
  return { isSubagent, killed, parentId, title };
}

/**
 * Scoped read-only reader that reuses open `conversation_summaries.db` handles and enforces
 * bounded lookup/time budgets across large historical sweeps (`v2.35.0+` unlimited history).
 */
export function createSummaryDbReader(
  DatabaseSyncCtor,
  { allowDefaultDb = false, maxLookups = MAX_MAINTENANCE_SUMMARY_LOOKUPS, maxScanMs = MAX_MAINTENANCE_SCAN_MS } = {}
) {
  const handles = new Map();
  const schemaStates = new Map();
  const rowCache = new Map();
  const startedAt = Date.now();
  let lookups = 0;
  let openCount = 0;

  const remainingBudgetMs = () => Math.max(0, maxScanMs - (Date.now() - startedAt));

  const getHandle = (dbPath) => {
    const key = process.platform === "win32" ? dbPath.toLowerCase() : dbPath;
    if (handles.has(key)) return handles.get(key);
    const remMs = remainingBudgetMs();
    if (remMs <= 0) return null;
    const initTimeout = Math.max(10, Math.min(remMs, 25));
    let sdb = null;
    try {
      if (fs.existsSync(dbPath)) {
        try {
          sdb = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: initTimeout });
        } catch {
          sdb = new DatabaseSyncCtor(dbPath, { readOnly: true });
          try {
            sdb.exec(`PRAGMA busy_timeout = ${initTimeout};`);
          } catch {}
        }
        openCount += 1;
      }
    } catch {
      sdb = null;
    }
    handles.set(key, sdb);
    return sdb;
  };

  return {
    get openCount() {
      return openCount;
    },
    get lookupCount() {
      return lookups;
    },
    isBudgetExhausted() {
      return lookups >= maxLookups || Date.now() - startedAt >= maxScanMs;
    },
    lookup(cid, { transcriptPath = "" } = {}) {
      if (!DatabaseSyncCtor || !cid) return { isSubagent: false, killed: false, parentId: "", title: "" };
      const cacheKey = `${cid}\0${transcriptPath || ""}`;
      if (rowCache.has(cacheKey)) return rowCache.get(cacheKey);
      if (this.isBudgetExhausted()) {
        return { isSubagent: false, killed: false, parentId: "", title: "", budgetExhausted: true };
      }
      lookups += 1;
      let hadError = false;
      const candidates = collectSummaryDbCandidates({ transcriptPath, allowDefaultDb });
      for (const dbPath of candidates) {
        const remMs = remainingBudgetMs();
        if (remMs <= 0) {
          return { isSubagent: false, killed: false, parentId: "", title: "", budgetExhausted: true };
        }
        const sdb = getHandle(dbPath);
        if (!sdb) continue;
        const key = process.platform === "win32" ? dbPath.toLowerCase() : dbPath;
        let st = schemaStates.get(key);
        if (!st) {
          st = { tier: 0 };
          schemaStates.set(key, st);
        }
        try {
          const perQueryTimeout = Math.max(10, Math.min(remMs, 25));
          try {
            sdb.exec(`PRAGMA busy_timeout = ${perQueryTimeout};`);
          } catch {}
          const hit = querySummaryDbRow(sdb, cid, st);
          if (hit) {
            rowCache.set(cacheKey, hit);
            return hit;
          }
        } catch {
          // Fail-open without poisoning cache on transient lock/read errors
          hadError = true;
        }
      }
      const miss = { isSubagent: false, killed: false, parentId: "", title: "" };
      if (!hadError) {
        rowCache.set(cacheKey, miss);
      }
      return miss;
    },
    close() {
      for (const sdb of handles.values()) {
        if (sdb) {
          try {
            sdb.close();
          } catch {}
        }
      }
      handles.clear();
      schemaStates.clear();
      rowCache.clear();
    }
  };
}

function inspectTranscriptGenesisFileForSubagent(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return false;
  let fd = null;
  try {
    const cleanPath = transcriptPath.trim();
    if (!fs.existsSync(cleanPath)) return false;
    fd = fs.openSync(cleanPath, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size <= 0) return false;
    const toRead = Math.min(262144, st.size);
    const buf = Buffer.allocUnsafe(toRead);
    const n = fs.readSync(fd, buf, 0, toRead, 0);
    if (n <= 0) return false;
    const rawLines = buf.subarray(0, n).toString("utf8").split(/\r?\n/);
    let sawSysStep0 = false;
    let sawSubagentSys = false;
    for (let i = 0, seen = 0; i < rawLines.length && seen < 10; i++) {
      const ln = rawLines[i].trim();
      if (!ln) continue;
      seen += 1;
      try {
        const o = JSON.parse(ln);
        if (!o || typeof o !== "object") continue;
        const t = String(o.type || "").toUpperCase();
        const r = String(o.role || "").toLowerCase();
        if (t === "PLANNER_RESPONSE" || r === "assistant" || r === "model") break;
        const txt = typeof (o.user_input ?? o.content ?? o.text) === "string" ? String(o.user_input ?? o.content ?? o.text) : "";
        if (txt && STORE_HEADLESS_FINISH_RE.test(txt)) return true;
        if (t === "USER_INPUT" || r === "user") return false;
        if (t === "SYSTEM_MESSAGE") {
          if (o.step_index === 0 || seen === 1) sawSysStep0 = true;
          if (o.source === "SYSTEM" || (txt && STORE_SUBAGENT_GENESIS_RE.test(txt))) sawSubagentSys = true;
        }
      } catch {
        if (/^\{\s*(?:"[^"]+"\s*:\s*[^,]+,\s*){0,6}"type"\s*:\s*"USER_INPUT"/.test(ln)) {
          return STORE_HEADLESS_FINISH_RE.test(ln);
        }
        if (
          sawSysStep0 &&
          /^\{\s*(?:"[^"]+"\s*:\s*[^,]+,\s*){0,6}"type"\s*:\s*"SYSTEM_MESSAGE"/.test(ln) &&
          (/"source"\s*:\s*"SYSTEM"\b/.test(ln) || STORE_SUBAGENT_GENESIS_RE.test(ln))
        ) {
          return true;
        }
        break;
      }
    }
    return Boolean(sawSysStep0 && sawSubagentSys);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const DEFAULT_PROFILE_COLD_FLOOR_SEC = 300;

function resolveProfileColdFloorSec(profileId) {
  return profileId === "deepseek-128k" ? 600 : DEFAULT_PROFILE_COLD_FLOOR_SEC;
}

function resolveModelColdFloorSec(modelStr) {
  return typeof modelStr === "string" && /deepseek/i.test(modelStr) ? 600 : DEFAULT_PROFILE_COLD_FLOOR_SEC;
}

export const STAR_PROMPT_META_KEY = "star_prompt";
export const CACHE_AUDIT_PASSED_META_KEY = "cache_audit:passed_at";
export const AUTO_UPDATE_INSTALL_META_KEY = "auto_update:install";
export const AUTO_UPDATE_STATE_META_KEY = "auto_update:state";
const AUTO_UPDATE_RELEASE_URL_PREFIX = "https://github.com/zou172866/Antigravity-agy-dart/releases/";

export function normalizeAutoUpdateRuntimeState(raw) {
  const defaults = {
    lastAutoUpdatedVersion: "",
    lastAutoUpdatedFrom: "",
    lastAutoUpdatedAt: "",
    lastAutoUpdatedUrl: "",
    failedVersion: "",
    failedReason: "",
    failedAt: ""
  };
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ...defaults };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { ...defaults };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...defaults };
  }
  const norm = (v, maxLen = 64) => (typeof v === "string" ? v.trim().slice(0, maxLen) : "");
  const rawUrl = norm(obj.lastAutoUpdatedUrl, 256);
  return {
    lastAutoUpdatedVersion: norm(obj.lastAutoUpdatedVersion, 32),
    lastAutoUpdatedFrom: norm(obj.lastAutoUpdatedFrom, 32),
    lastAutoUpdatedAt: norm(obj.lastAutoUpdatedAt, 64),
    lastAutoUpdatedUrl: rawUrl.startsWith(AUTO_UPDATE_RELEASE_URL_PREFIX) ? rawUrl : "",
    failedVersion: norm(obj.failedVersion, 32),
    failedReason: norm(obj.failedReason, 64),
    failedAt: norm(obj.failedAt, 64)
  };
}
export const STAR_PROMPT_STATES = Object.freeze(["pending", "clicked", "dismissed", "copied_cli"]);
export const STAR_PROMPT_TERMINAL_STATES = Object.freeze(["clicked", "dismissed", "copied_cli"]);
export const STAR_PROMPT_MIN_SAVED_BYTES = 100 * 1024;
export const STAR_PROMPT_MIN_SESSIONS = 3;

export function normalizeStarPromptState(raw) {
  const defaults = {
    state: "pending",
    triggeredAt: null,
    resolvedAt: null,
    milestoneSavedBytes: 0
  };
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ...defaults };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { ...defaults };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...defaults };
  }
  let src = obj;
  if (Object.prototype.hasOwnProperty.call(obj, "starPrompt")) {
    src =
      obj.starPrompt && typeof obj.starPrompt === "object" && !Array.isArray(obj.starPrompt)
        ? obj.starPrompt
        : null;
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ...defaults };
  }
  const state =
    typeof src.state === "string" && STAR_PROMPT_STATES.includes(src.state) ? src.state : "pending";
  const normIso = (v) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= 64 ? t : null;
  };
  let milestoneSavedBytes = 0;
  const rawBytes = src.milestoneSavedBytes;
  if (typeof rawBytes === "number" || (typeof rawBytes === "string" && rawBytes.trim() !== "")) {
    const n = Number(rawBytes);
    if (Number.isFinite(n) && n >= 0) {
      milestoneSavedBytes = Math.floor(n);
    }
  }
  return {
    state,
    triggeredAt: normIso(src.triggeredAt),
    resolvedAt: normIso(src.resolvedAt),
    milestoneSavedBytes
  };
}

function isSpecialSessionScope(sid) {
  if (typeof sid !== "string") return true;
  const trimmed = sid.trim();
  if (!trimmed) return true;
  return /^(?:default|all|app|lifetime|__unbound__)$/i.test(trimmed) || /^workspace:/i.test(trimmed);
}

function sanitizeLeaseLinkId(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || /[\x00-\x1f\x7f\\/]/.test(trimmed) || isSpecialSessionScope(trimmed)) {
    return "";
  }
  return trimmed;
}

export const SESSION_WORKSPACE_PREFIX = "session_workspace:";
const SESSION_WORKSPACE_MAX_ENTRIES = 32;
const SESSION_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_WORKSPACE_MAX_AGE_MS = 10 * 60 * 1000;
const SESSION_WORKSPACE_RESERVED_IDS = new Set([
  "default",
  "all",
  "lifetime",
  "app",
  "__unbound__",
  "unknown",
  "none",
  "null",
  "undefined"
]);
const STORE_INSTALLED_PLUGIN_PATH_RE =
  /\/(?:\.gemini\/(?:config|antigravity)\/plugins|\.agents\/plugins|\.t3\/userdata\/providers\/antigravity\/[^/]+\/(?:\.gemini\/config\/)?plugins)\/agy-dart(?:\/|$)/i;
const STORE_SELF_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STORE_IS_INSTALLED_PLUGIN_COPY = !fs.existsSync(path.join(STORE_SELF_PLUGIN_ROOT, ".git"));

function normalizeStoreCompareDir(dirPath) {
  let resolved = path.resolve(String(dirPath || ""));
  try {
    resolved = fs.realpathSync(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const STORE_SELF_PLUGIN_ROOT_NORM = normalizeStoreCompareDir(STORE_SELF_PLUGIN_ROOT);

function isStoreSameOrSubDir(candidateNorm, parentNorm) {
  if (!candidateNorm || !parentNorm) return false;
  const rel = path.relative(parentNorm, candidateNorm);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

function isStoreInsideInstalledPluginDir(candidateDir, pluginRootNorm = null) {
  if (typeof candidateDir !== "string" || !candidateDir.trim()) return false;
  const candNorm = normalizeStoreCompareDir(candidateDir);
  const candPosix = candNorm.replace(/\\/g, "/");
  if (STORE_INSTALLED_PLUGIN_PATH_RE.test(candPosix)) return true;
  for (const envVar of [process.env.PLUGIN_ROOT, process.env.AGY_PLUGIN_ROOT]) {
    if (typeof envVar === "string" && envVar.trim()) {
      if (isStoreSameOrSubDir(candNorm, normalizeStoreCompareDir(envVar.trim()))) return true;
    }
  }
  if (pluginRootNorm && isStoreSameOrSubDir(candNorm, pluginRootNorm)) return true;
  if (STORE_IS_INSTALLED_PLUGIN_COPY && isStoreSameOrSubDir(candNorm, STORE_SELF_PLUGIN_ROOT_NORM)) {
    return true;
  }
  return false;
}

function sanitizeSessionWorkspaceConvId(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return "";
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed)) return "";
  if (SESSION_WORKSPACE_RESERVED_IDS.has(trimmed.toLowerCase()) || /^workspace:/i.test(trimmed)) return "";
  return trimmed;
}

function normalizeSafeSessionWorkspaceDir(rawDir, { pluginRootNorm = null } = {}) {
  if (typeof rawDir !== "string") return null;
  let s = rawDir.trim();
  if (!s || /[\x00-\x1f\x7f]/.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      return null;
    }
  }
  if (s === "~") {
    s = os.homedir();
  } else if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(os.homedir(), s.slice(2));
  }
  if (/^[\\/]{2}/.test(s)) return null;
  let abs;
  try {
    abs = path.resolve(s);
    if (!fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {}
  if (/^[\\/]{2}/.test(real)) return null;
  if (path.parse(real).root === real) return null;
  const norm = process.platform === "win32" ? real.toLowerCase() : real;
  try {
    const homeNorm = normalizeStoreCompareDir(os.homedir());
    if (homeNorm && (norm === homeNorm || isStoreSameOrSubDir(homeNorm, norm))) return null;
  } catch {}
  try {
    const tmpNorm = normalizeStoreCompareDir(os.tmpdir());
    if (tmpNorm && (norm === tmpNorm || isStoreSameOrSubDir(tmpNorm, norm))) return null;
  } catch {}
  if (isStoreInsideInstalledPluginDir(real, pluginRootNorm)) return null;
  return { dir: abs, canonicalKey: norm };
}

export class SettingsMaintenanceMethods {
  /** Resolve a conversationId to its top-level rootSessionId via watchdog_lease parent/root links */
  resolveRootSessionId(sessionId) {
    const raw = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!raw) return "default";
    if (isSpecialSessionScope(raw)) return raw;
    this.open();
    let cur = raw;
    const visited = new Set([cur]);
    for (let depth = 0; depth < 12; depth++) {
      let leaseRaw = null;
      try {
        leaseRaw = this.getMeta(`watchdog_lease:${cur}`, null);
      } catch {
        break;
      }
      if (!leaseRaw) break;
      let lease = null;
      try {
        lease = JSON.parse(leaseRaw);
      } catch {
        break;
      }
      if (!lease || typeof lease !== "object") break;
      const rootCand = sanitizeLeaseLinkId(lease.rootSessionId);
      const parentCand = sanitizeLeaseLinkId(lease.parentConversationId);
      const next =
        rootCand && rootCand !== cur
          ? rootCand
          : parentCand && parentCand !== cur
            ? parentCand
            : "";
      if (!next || visited.has(next)) break;
      visited.add(next);
      cur = next;
    }
    return cur;
  }

  /** Return [sessionId, ...descendantSubagentIds] for clean parent-level rollup without double-counting */
  getSessionFamilyIds(sessionId) {
    const raw = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!raw) return ["default"];
    if (isSpecialSessionScope(raw)) return [raw];
    this.open();
    let rows = [];
    try {
      rows = this.listMetaByPrefix("watchdog_lease:");
    } catch {
      return [raw];
    }
    if (!rows || rows.length === 0) return [raw];

    const links = new Map();
    for (const row of rows) {
      if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
      const cid = sanitizeLeaseLinkId(row.key.slice("watchdog_lease:".length));
      if (!cid) continue;
      try {
        const lease = JSON.parse(row.value);
        if (!lease || typeof lease !== "object") continue;
        const rootCand = sanitizeLeaseLinkId(lease.rootSessionId);
        const parentCand = sanitizeLeaseLinkId(lease.parentConversationId);
        const ancestors = [];
        if (parentCand && parentCand !== cid) ancestors.push(parentCand);
        if (rootCand && rootCand !== cid && rootCand !== parentCand) ancestors.push(rootCand);
        if (ancestors.length > 0) {
          links.set(cid, ancestors);
        }
      } catch {}
    }

    const family = new Set([raw]);
    for (const cid of links.keys()) {
      if (family.has(cid)) continue;
      const queue = [...(links.get(cid) || [])];
      const seen = new Set([cid]);
      while (queue.length > 0 && seen.size <= 32) {
        const anc = queue.shift();
        if (!anc || seen.has(anc)) continue;
        if (anc === raw) {
          family.add(cid);
          break;
        }
        seen.add(anc);
        const nextAncs = links.get(anc);
        if (nextAncs) {
          for (const na of nextAncs) {
            if (!seen.has(na)) queue.push(na);
          }
        }
      }
      if (family.size >= 500) break;
    }
    return Array.from(family);
  }

  /** Calculate token savings & statistics */
  getStats(sessionId, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = options.sinceTs || null;
    const sinceIso = sinceTs ? new Date(sinceTs).toISOString() : null;
    const isGlobalOrApp = sid === "all" || sid === "lifetime" || (sid === "app" && sinceIso);
    const effectiveSid = isGlobalOrApp ? sid : this.resolveRootSessionId(sid);
    const familyIds = isGlobalOrApp ? null : this.getSessionFamilyIds(effectiveSid);
    const inClause = familyIds && familyIds.length > 1 ? `IN (${familyIds.map(() => "?").join(",")})` : "= ?";
    const sidParams = familyIds && familyIds.length > 1 ? familyIds : [effectiveSid];

    let eventStats;
    let sourceStats;
    let unrecordedSources;

    if (sid === "all" || sid === "lifetime") {
      eventStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_calls,
          SUM(MAX(sandbox_bytes, bytes, returned_bytes)) AS total_raw_bytes,
          SUM(returned_bytes) AS total_returned_bytes,
          SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)) AS total_kept_out_bytes
        FROM events
        WHERE COALESCE(key, '') != 'dedup_bypass'
      `).get();

      sourceStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_sources,
          SUM(bytes_total) AS total_source_bytes,
          SUM(chunk_count) AS total_chunks
        FROM sources
      `).get();

      unrecordedSources = this.db.prepare(`
        SELECT COALESCE(SUM(bytes_total), 0) AS unrecorded_source_bytes
        FROM sources s
        WHERE s.kind NOT IN ('execution', 'batch', 'tool_output', 'exec')
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.tool = 'ctx_index'
              AND (e.source_id = s.id OR e.sandbox_bytes = s.bytes_total)
          )
      `).get();
    } else if (sid === "app" && sinceIso) {
      eventStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_calls,
          SUM(MAX(sandbox_bytes, bytes, returned_bytes)) AS total_raw_bytes,
          SUM(returned_bytes) AS total_returned_bytes,
          SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)) AS total_kept_out_bytes
        FROM events
        WHERE created_at >= ? AND COALESCE(key, '') != 'dedup_bypass'
      `).get(sinceIso);

      sourceStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_sources,
          SUM(bytes_total) AS total_source_bytes,
          SUM(chunk_count) AS total_chunks
        FROM sources
        WHERE created_at >= ? OR created_ts >= ?
      `).get(sinceIso, sinceTs);

      unrecordedSources = this.db.prepare(`
        SELECT COALESCE(SUM(bytes_total), 0) AS unrecorded_source_bytes
        FROM sources s
        WHERE (created_at >= ? OR created_ts >= ?)
          AND s.kind NOT IN ('execution', 'batch', 'tool_output', 'exec')
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.tool = 'ctx_index'
              AND (e.source_id = s.id OR e.sandbox_bytes = s.bytes_total)
          )
      `).get(sinceIso, sinceTs);
    } else {
      eventStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_calls,
          SUM(MAX(sandbox_bytes, bytes, returned_bytes)) AS total_raw_bytes,
          SUM(returned_bytes) AS total_returned_bytes,
          SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)) AS total_kept_out_bytes
        FROM events
        WHERE session_id ${inClause} AND COALESCE(key, '') != 'dedup_bypass'
      `).get(...sidParams);

      sourceStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_sources,
          SUM(bytes_total) AS total_source_bytes,
          SUM(chunk_count) AS total_chunks
        FROM sources
        WHERE session_id ${inClause}
      `).get(...sidParams);

      unrecordedSources = this.db.prepare(`
        SELECT COALESCE(SUM(bytes_total), 0) AS unrecorded_source_bytes
        FROM sources s
        WHERE s.session_id ${inClause}
          AND s.kind NOT IN ('execution', 'batch', 'tool_output', 'exec')
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.session_id ${inClause}
              AND e.tool = 'ctx_index'
              AND (e.source_id = s.id OR e.sandbox_bytes = s.bytes_total)
          )
      `).get(...sidParams, ...sidParams);
    }

    const unrecordedBytes = unrecordedSources?.unrecorded_source_bytes || 0;
    const totalRawBytes = (eventStats?.total_raw_bytes || 0) + unrecordedBytes;
    const totalReturnedBytes = eventStats?.total_returned_bytes || 0;
    const keptOutBytes = (eventStats?.total_kept_out_bytes || 0) + unrecordedBytes;
    const savingsPercent = totalRawBytes > 0 ? Number(((keptOutBytes / totalRawBytes) * 100).toFixed(1)) : 0;
    const tokensKeptOut = Math.round(keptOutBytes / 4);

    let breakdownRows = [];
    try {
      if (sid === "all" || sid === "lifetime") {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE COALESCE(key, '') != 'dedup_bypass' GROUP BY kind
        `).all();
      } else if (sid === "app" && sinceIso) {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE created_at >= ? AND COALESCE(key, '') != 'dedup_bypass' GROUP BY kind
        `).all(sinceIso);
      } else {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE session_id ${inClause} AND COALESCE(key, '') != 'dedup_bypass' GROUP BY kind
        `).all(...sidParams);
      }
    } catch {}

    const breakdown = {
      interceptions: 0,
      cliFilters: 0,
      dedups: 0,
      executions: 0,
      indexes: 0,
      fastTools: 0,
      cliFilterSavedBytes: 0,
      dedupSavedBytes: 0,
      fastToolSavedBytes: 0
    };
    for (const row of breakdownRows) {
      if (row.kind === "interception") breakdown.interceptions = row.cnt;
      else if (row.kind === "cli_filter") {
        breakdown.cliFilters = row.cnt;
        breakdown.cliFilterSavedBytes = row.saved_bytes || 0;
      } else if (row.kind === "dedup") {
        breakdown.dedups = row.cnt;
        breakdown.dedupSavedBytes = row.saved_bytes || 0;
      } else if (row.kind === "execution" || row.kind === "batch") {
        breakdown.executions += row.cnt;
      } else if (row.kind === "index") {
        breakdown.indexes = row.cnt;
      } else if (row.kind === "fast_slice" || row.kind === "fast_check" || row.kind === "fast_search") {
        breakdown.fastTools += row.cnt;
        breakdown.fastToolSavedBytes += row.saved_bytes || 0;
      }
    }

    return {
      sessionId: sid,
      calls: eventStats?.total_calls || 0,
      totalRawBytes,
      totalReturnedBytes,
      keptOutBytes,
      savingsPercent,
      tokensKeptOut,
      sourcesCount: sourceStats?.total_sources || 0,
      chunksCount: sourceStats?.total_chunks || 0,
      breakdown
    };
  }

  /**
   * Quantify per-feature telemetry ROI from `events` + `ghost_interceptions`
   * so low-value or unused features can be measured objectively.
   */
  getFeatureRoi(sessionId, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = Number.isFinite(options.sinceTs) ? options.sinceTs : null;
    const sinceIso = sinceTs !== null ? new Date(sinceTs).toISOString() : null;

    let rows = [];
    try {
      const baseSql = `
        SELECT kind, COALESCE(key, '') AS key, COUNT(*) AS cnt,
          COALESCE(SUM(MAX(sandbox_bytes, bytes, returned_bytes)), 0) AS raw_bytes,
          COALESCE(SUM(returned_bytes), 0) AS returned_bytes,
          COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
        FROM events
      `;
      if (sid === "all" || sid === "lifetime") {
        rows = this.db.prepare(`${baseSql} GROUP BY kind, COALESCE(key, '')`).all();
      } else if (sid === "app" && sinceIso) {
        rows = this.db.prepare(`${baseSql} WHERE created_at >= ? GROUP BY kind, COALESCE(key, '')`).all(sinceIso);
      } else {
        const effectiveSid = this.resolveRootSessionId(sid);
        const familyIds = this.getSessionFamilyIds(effectiveSid);
        if (familyIds.length > 1) {
          const placeholders = familyIds.map(() => "?").join(",");
          rows = this.db.prepare(`${baseSql} WHERE session_id IN (${placeholders}) GROUP BY kind, COALESCE(key, '')`).all(...familyIds);
        } else {
          rows = this.db.prepare(`${baseSql} WHERE session_id = ? GROUP BY kind, COALESCE(key, '')`).all(effectiveSid);
        }
      }
    } catch {}

    const buckets = {
      cli_filter: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      read_dedup: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      diff_read: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      large_file_guard: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      sandbox_execute: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      fts_index: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      fast_tools: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 }
    };

    const add = (name, r) => {
      const b = buckets[name];
      b.calls += Number(r.cnt || 0);
      b.rawBytes += Number(r.raw_bytes || 0);
      b.returnedBytes += Number(r.returned_bytes || 0);
      b.savedBytes += Number(r.saved_bytes || 0);
    };

    let dedupBypasses = 0;
    for (const r of rows) {
      if (r.kind === "cli_filter") add("cli_filter", r);
      else if (r.kind === "dedup" && r.key === "dedup_bypass") dedupBypasses += Number(r.cnt || 0);
      else if (r.kind === "dedup" && r.key === "modified_diff") add("diff_read", r);
      else if (r.kind === "dedup") add("read_dedup", r);
      else if (r.kind === "interception") add("large_file_guard", r);
      else if (r.kind === "execution" || r.kind === "batch") add("sandbox_execute", r);
      else if (r.kind === "index") add("fts_index", r);
      else if (r.kind === "fast_slice" || r.kind === "fast_check" || r.kind === "fast_search") add("fast_tools", r);
    }

    const ghost =
      options && options.ghost && typeof options.ghost === "object"
        ? options.ghost
        : this.getGhostStats(sid, sinceTs !== null ? { sinceTs } : {});
    const features = {};
    for (const [name, b] of Object.entries(buckets)) {
      const estTokensSaved = Math.round(b.savedBytes / 4);
      const avgSavedBytesPerCall = b.calls > 0 ? Math.round(b.savedBytes / b.calls) : 0;
      const reductionPct = b.rawBytes > 0 ? Number(((b.savedBytes / b.rawBytes) * 100).toFixed(1)) : 0;
      const status =
        b.calls === 0
          ? "unused"
          : estTokensSaved >= 1000 || reductionPct >= 50
            ? "high_roi"
            : "active";
      features[name] = {
        calls: b.calls,
        savedBytes: b.savedBytes,
        estTokensSaved,
        avgSavedBytesPerCall,
        reductionPct,
        status,
        ...(name === "read_dedup"
          ? {
              bypasses: dedupBypasses,
              bypassRate: b.calls > 0 ? Number((dedupBypasses / b.calls).toFixed(4)) : 0
            }
          : {}),
        ...(name === "large_file_guard"
          ? { evictionEfficiency: ghost.evictionEfficiency, ghostRecalls: ghost.ghostRecalls }
          : {})
      };
    }

    return {
      sessionId: sid,
      features
    };
  }

  /** Purge stored data */
  purge({ scope = "session", sessionId, worktree, sinceTs, olderThanDays = 14, vacuum = false } = {}) {
    this.open();
    if (scope === "stale") {
      return this.pruneByTtl({ maxAgeDays: olderThanDays, vacuum });
    }

    if (scope === "all" || scope === "lifetime") {
      this._withWriteTx(() => {
        this.db.exec(`
          DELETE FROM chunks;
          DELETE FROM chunks_tri;
          DELETE FROM sources;
          DELETE FROM events;
          DELETE FROM file_reads;
          DELETE FROM file_snapshots;
          DELETE FROM repo_cache;
          DELETE FROM outline_cache;
          DELETE FROM ghost_interceptions;
          DELETE FROM session_checkpoints;
          DELETE FROM meta WHERE key LIKE 'large_read_confirm:%' OR key LIKE 'sensitive_read_confirm:%' OR key LIKE 'watchdog_lease:%';
        `);
      });
      try {
        this.db.exec("VACUUM;");
      } catch {
        // Best-effort VACUUM: ignore transient SQLITE_BUSY from concurrent readers
      }
      return { ok: true, purged: "all" };
    }

    if (scope === "app") {
      if (sinceTs === null || sinceTs === undefined || typeof sinceTs === "boolean" || (typeof sinceTs === "string" && sinceTs.trim() === "") || !Number.isFinite(Number(sinceTs))) {
        throw new Error("purge({ scope: 'app' }) requires a finite 'sinceTs' timestamp");
      }
      const sinceNum = Number(sinceTs);
      const sinceIso = new Date(sinceNum).toISOString();
      const count = this._withWriteTx(() => {
        const sourceIds = this.db
          .prepare("SELECT id FROM sources WHERE created_at >= ? OR created_ts >= ?")
          .all(sinceIso, sinceNum)
          .map((r) => r.id);
        for (let i = 0; i < sourceIds.length; i += 400) {
          const batch = sourceIds.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
        }
        this.db.prepare("DELETE FROM sources WHERE created_at >= ? OR created_ts >= ?").run(sinceIso, sinceNum);
        this.db.prepare("DELETE FROM events WHERE created_at >= ?").run(sinceIso);
        this.db.prepare("DELETE FROM file_reads WHERE read_ts >= ?").run(sinceNum);
        this.db.prepare("DELETE FROM file_snapshots WHERE updated_ts >= ?").run(sinceNum);
        this.db.prepare("DELETE FROM ghost_interceptions WHERE blocked_ts >= ?").run(sinceNum);
        this.db.prepare("DELETE FROM session_checkpoints WHERE updated_ts >= ?").run(sinceNum);
        return sourceIds.length;
      });
      return { ok: true, purged: "app", count };
    }

    if (scope === "worktree") {
      if (typeof worktree !== "string" || !worktree.trim()) {
        throw new Error("purge({ scope: 'worktree' }) requires a non-empty 'worktree' path");
      }
      this._withWriteTx(() => {
        const sourceIds = this.db
          .prepare("SELECT id FROM sources WHERE worktree = ?")
          .all(worktree)
          .map((r) => r.id);
        for (let i = 0; i < sourceIds.length; i += 400) {
          const batch = sourceIds.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
        }
        this.db.prepare("DELETE FROM chunks WHERE worktree = ?").run(worktree);
        this.db.prepare("DELETE FROM sources WHERE worktree = ?").run(worktree);
        this.db.prepare("DELETE FROM events WHERE worktree = ?").run(worktree);
        this.db.prepare("DELETE FROM session_checkpoints WHERE worktree = ?").run(worktree);
      });
      return { ok: true, purged: "worktree", worktree };
    }

    if (scope === "session" || scope === "conversation") {
      const sid = sessionId || "default";
      this._withWriteTx(() => {
        this.db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM chunks_tri WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM sources WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM file_reads WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM ghost_interceptions WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM session_checkpoints WHERE session_id = ?").run(sid);
        const escSid = String(sid).replace(/[\\%_]/g, "\\$&");
        this.db
          .prepare(
            "DELETE FROM meta WHERE key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'"
          )
          .run(
            `watchdog_lease:${sid}`,
            `large_read_confirm:conv:${escSid}:%`,
            `large_read_confirm:sub:${escSid}:%`,
            `sensitive_read_confirm:${escSid}:%`,
            `sensitive_read_confirm:conv:${escSid}:%`,
            `sensitive_read_confirm:sub:${escSid}:%`
          );
      });
      return { ok: true, purged: "session", sessionId: sid };
    }

    throw new Error(`Invalid purge scope: '${String(scope)}'`);
  }

  /** Inspect SQLite file size, WAL size, and reclaimable freelist fragmentation */
  getStorageHealth() {
    this.open();
    const stat = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath) : null;
    const walPath = `${this.dbPath}-wal`;
    const walStat = fs.existsSync(walPath) ? fs.statSync(walPath) : null;
    let pageSize = 4096;
    let pageCount = 0;
    let freelistPages = 0;
    try {
      const psRow = this.db.prepare("PRAGMA page_size").get();
      const pcRow = this.db.prepare("PRAGMA page_count").get();
      const flRow = this.db.prepare("PRAGMA freelist_count").get();
      pageSize = Number(psRow?.page_size ?? 4096) || 4096;
      pageCount = Number(pcRow?.page_count ?? 0) || 0;
      freelistPages = Number(flRow?.freelist_count ?? 0) || 0;
    } catch {}
    const dbSizeBytes = stat ? stat.size : pageCount * pageSize;
    const walSizeBytes = walStat ? walStat.size : 0;
    const logicalBytes = pageCount * pageSize;
    const reclaimableBytes = freelistPages * pageSize;
    const denom = Math.max(dbSizeBytes, logicalBytes);
    const reclaimablePct = denom > 0 ? Number(((reclaimableBytes / denom) * 100).toFixed(1)) : 0;
    const lastVacuumRaw = this.getMeta("last_vacuum_ts", null);
    const lastVacuumTs =
      lastVacuumRaw !== null && Number.isFinite(Number(lastVacuumRaw)) && Number(lastVacuumRaw) > 0
        ? Math.floor(Number(lastVacuumRaw))
        : 0;
    return {
      dbSizeBytes,
      walSizeBytes,
      pageSize,
      pageCount,
      freelistPages,
      reclaimableBytes,
      reclaimablePct,
      lastVacuumTs,
      lastVacuumAt: lastVacuumTs > 0 ? new Date(lastVacuumTs).toISOString() : null
    };
  }

  /**
   * Threshold-gated SQLite VACUUM + WAL truncate meant for background/idle execution
   * (never blocks SessionStart). Fail-open on transient lock contention.
   */
  maybeAutoVacuum({
    minReclaimableBytes = 4 * 1024 * 1024,
    minReclaimablePct = 25,
    cooldownMs = 24 * 3600 * 1000,
    force = false
  } = {}) {
    try {
      this.open();
      const before = this.getStorageHealth();
      const now = Date.now();
      if (!force) {
        if (cooldownMs > 0 && before.lastVacuumTs > 0 && now - before.lastVacuumTs < cooldownMs) {
          return {
            ok: true,
            vacuumed: false,
            reason: "cooldown",
            bytesBefore: before.dbSizeBytes + before.walSizeBytes,
            bytesAfter: before.dbSizeBytes + before.walSizeBytes,
            reclaimedBytes: 0,
            storageHealth: before
          };
        }
        if (before.reclaimableBytes < minReclaimableBytes || before.reclaimablePct < minReclaimablePct) {
          return {
            ok: true,
            vacuumed: false,
            reason: "below_threshold",
            bytesBefore: before.dbSizeBytes + before.walSizeBytes,
            bytesAfter: before.dbSizeBytes + before.walSizeBytes,
            reclaimedBytes: 0,
            storageHealth: before
          };
        }
      }
      const bytesBefore = before.dbSizeBytes + before.walSizeBytes;
      this.db.exec("VACUUM;");
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
      this.setMeta("last_vacuum_ts", String(Date.now()));
      const after = this.getStorageHealth();
      const bytesAfter = after.dbSizeBytes + after.walSizeBytes;
      return {
        ok: true,
        vacuumed: true,
        reason: force ? "forced" : "threshold_met",
        bytesBefore,
        bytesAfter,
        reclaimedBytes: Math.max(0, bytesBefore - bytesAfter),
        storageHealth: after
      };
    } catch (err) {
      let current = null;
      try {
        current = this.getStorageHealth();
      } catch {}
      return {
        ok: false,
        vacuumed: false,
        reason: "busy_or_error",
        error: String(err && err.message ? err.message : err),
        bytesBefore: current ? current.dbSizeBytes + current.walSizeBytes : 0,
        bytesAfter: current ? current.dbSizeBytes + current.walSizeBytes : 0,
        reclaimedBytes: 0,
        storageHealth: current
      };
    }
  }

  /** Run diagnostic checks */
  doctor() {
    try {
      this.open();
      const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      const sqliteRow = this.db.prepare("SELECT sqlite_version() AS v").get();
      const ftsCheck = this.db.prepare("SELECT count(*) as cnt FROM chunks").get();
      const srcCheck = this.db.prepare("SELECT count(*) as cnt FROM sources").get();
      const evCheck = this.db.prepare("SELECT count(*) as cnt FROM events").get();
      const readsCheck = this.db.prepare("SELECT count(*) as cnt FROM file_reads").get();
      const snapsCheck = this.db.prepare("SELECT count(*) as cnt FROM file_snapshots").get();
      const outlineCheck = this.db.prepare("SELECT count(*) as cnt FROM outline_cache").get();
      const lastMaint = this.getMeta("last_maintenance_ts", null);
      const storageHealth = this.getStorageHealth();

      return {
        status: "HEALTHY",
        allOk: true,
        dbPath: this.dbPath,
        dbSizeBytes: storageHealth.dbSizeBytes,
        walSizeBytes: storageHealth.walSizeBytes,
        freelistPages: storageHealth.freelistPages,
        reclaimableBytes: storageHealth.reclaimableBytes,
        reclaimablePct: storageHealth.reclaimablePct,
        lastVacuumAt: storageHealth.lastVacuumAt,
        storageHealth,
        schemaVersion: versionRow ? versionRow.value : "unknown",
        totalChunksIndexed: ftsCheck ? ftsCheck.cnt : 0,
        totalSources: srcCheck ? srcCheck.cnt : 0,
        totalEvents: evCheck ? evCheck.cnt : 0,
        trackedFileReads: readsCheck ? readsCheck.cnt : 0,
        trackedFileSnapshots: snapsCheck ? snapsCheck.cnt : 0,
        cachedOutlines: outlineCheck ? outlineCheck.cnt : 0,
        lastMaintenanceAt: lastMaint ? new Date(Number(lastMaint)).toISOString() : null,
        sqliteVersion: sqliteRow && sqliteRow.v ? String(sqliteRow.v) : "unknown"
      };
    } catch (err) {
      return {
        status: "ERROR",
        allOk: false,
        error: String(err && err.message ? err.message : err)
      };
    }
  }

  /** Read a key from meta table */
  getMeta(key, defaultValue = null) {
    this.open();
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : defaultValue;
  }

  /** Write a key-value pair to meta table */
  setMeta(key, value) {
    this.open();
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, String(value));
  }

  /** Record a recent keepalive cold-miss circuit-breaker trip for a model profile (#1665/#1720) */
  recordKeepaliveColdTrip(profileId, atMs = Date.now()) {
    if (typeof profileId !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(profileId)) {
      return;
    }
    const ts = Number(atMs);
    if (!Number.isFinite(ts) || ts <= 0) {
      return;
    }
    this.setMeta(`keepalive_cold_trip:${profileId}`, String(Math.floor(ts)));
  }

  /** Return timestamp (ms) of a recent keepalive cold trip within windowMs, or null */
  getRecentKeepaliveColdTrip(profileId, nowMs = Date.now(), windowMs = 15 * 60 * 1000) {
    if (typeof profileId !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(profileId)) {
      return null;
    }
    const now = Number(nowMs);
    const win = Number(windowMs);
    if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(win) || win < 0) {
      return null;
    }
    const raw = this.getMeta(`keepalive_cold_trip:${profileId}`, null);
    if (raw === null || raw === undefined || raw === "") {
      return null;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0 || v > now) {
      return null;
    }
    return now - v <= win ? v : null;
  }

  /** Delete a key from meta table */
  deleteMeta(key) {
    this.open();
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** List meta rows matching an exact key prefix (safe LIKE escaping) */
  listMetaByPrefix(prefix) {
    if (!prefix || typeof prefix !== "string") return [];
    this.open();
    const esc = prefix.replace(/[\\%_]/g, "\\$&");
    return this.db
      .prepare("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC")
      .all(`${esc}%`);
  }

  /** Delete all meta rows matching an exact key prefix (safe LIKE escaping) */
  deleteMetaByPrefix(prefix) {
    if (!prefix || typeof prefix !== "string") return 0;
    this.open();
    const esc = prefix.replace(/[\\%_]/g, "\\$&");
    const res = this.db
      .prepare("DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'")
      .run(`${esc}%`);
    return res.changes || 0;
  }

  /** Read a timestamped meta value with optional TTL enforcement (backward compatible with 2-arg calls) */
  getTimedMeta(key, defaultValue = null, maxAgeMs = 0) {
    const raw = this.getMeta(key, null);
    if (raw === null) return defaultValue;
    const enforceTtl = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "v" in parsed) {
          if (enforceTtl) {
            const ts = Number(parsed.ts);
            if (!Number.isFinite(ts) || ts <= 0 || Date.now() - ts > maxAgeMs) {
              try {
                this.deleteMeta(key);
              } catch {}
              return defaultValue;
            }
          }
          return parsed.v;
        }
      } catch {}
    }
    if (enforceTtl) {
      // Plain legacy string or corrupted entry lacks a valid timestamp -> treat as expired
      try {
        this.deleteMeta(key);
      } catch {}
      return defaultValue;
    }
    return raw;
  }

  /** Write a timestamped meta value so pruneByTtl can evict stale per-session entries */
  setTimedMeta(key, value) {
    this.setMeta(key, JSON.stringify({ v: String(value), ts: Date.now() }));
  }

  /** Clear all session-level overrides so new sessions start with lifetime defaults */
  clearSessionOverrides() {
    this.open();
    this.db.prepare("DELETE FROM meta WHERE key LIKE '%:session:app' OR key LIKE '%:session:default'").run();
  }

  /** Record or refresh the workspace directory associated with a conversation */
  recordSessionWorkspace(
    conversationId,
    workspaceDir,
    { rootSessionId = "", active = true, isSubagent = undefined, source = "", nowMs = Date.now(), pluginRootNorm = null } = {}
  ) {
    const cid = sanitizeSessionWorkspaceConvId(conversationId);
    if (!cid) return null;
    const valid = normalizeSafeSessionWorkspaceDir(workspaceDir, { pluginRootNorm });
    if (!valid) return null;
    const ts = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const key = `${SESSION_WORKSPACE_PREFIX}${cid}`;
    const cleanRoot = sanitizeSessionWorkspaceConvId(rootSessionId);
    let existing = null;
    try {
      const raw = this.getMeta(key, null);
      if (raw && raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") existing = parsed;
      }
    } catch {}
    const entry = {
      v: 1,
      conversationId: cid,
      rootSessionId: cleanRoot || existing?.rootSessionId || cid,
      cwd: valid.dir,
      active: Boolean(active),
      isSubagent: typeof isSubagent === "boolean" ? isSubagent : Boolean(existing?.isSubagent),
      updatedTs: ts,
      source: typeof source === "string" ? source.trim().slice(0, 32) : ""
    };
    this.setMeta(key, JSON.stringify(entry));
    try {
      const rows = this.listMetaByPrefix(SESSION_WORKSPACE_PREFIX);
      if (rows.length > SESSION_WORKSPACE_MAX_ENTRIES) {
        const parsedRows = rows.map((row) => {
          let rowTs = 0;
          let rowActive = false;
          try {
            const p = JSON.parse(row.value);
            if (p && typeof p === "object") {
              rowTs = Number.isFinite(p.updatedTs) ? p.updatedTs : 0;
              rowActive = Boolean(p.active);
            }
          } catch {}
          return { key: row.key, updatedTs: rowTs, active: rowActive };
        });
        const cutoff = ts - SESSION_WORKSPACE_MAX_AGE_MS;
        const toDelete = [];
        const survivors = [];
        for (const r of parsedRows) {
          if (r.key !== key && (r.updatedTs <= 0 || r.updatedTs < cutoff)) {
            toDelete.push(r.key);
          } else {
            survivors.push(r);
          }
        }
        if (survivors.length > SESSION_WORKSPACE_MAX_ENTRIES) {
          survivors.sort((a, b) => {
            if (a.key === key) return 1;
            if (b.key === key) return -1;
            if (a.active !== b.active) return a.active ? 1 : -1;
            return a.updatedTs - b.updatedTs;
          });
          const excess = survivors.length - SESSION_WORKSPACE_MAX_ENTRIES;
          for (let i = 0; i < excess; i++) {
            if (survivors[i].key !== key) toDelete.push(survivors[i].key);
          }
        }
        for (const dk of toDelete) {
          this.deleteMeta(dk);
        }
      }
    } catch {}
    return entry;
  }

  /** Mark a conversation's session_workspace entry idle while retaining its cwd for named lookup */
  markSessionWorkspaceIdle(conversationId, { nowMs = Date.now(), source = "Stop" } = {}) {
    const cid = sanitizeSessionWorkspaceConvId(conversationId);
    if (!cid) return false;
    const key = `${SESSION_WORKSPACE_PREFIX}${cid}`;
    let existing = null;
    try {
      const raw = this.getMeta(key, null);
      if (!raw || !raw.startsWith("{")) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return false;
      existing = parsed;
    } catch {
      return false;
    }
    if (existing.active === false) return false;
    const ts = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const updated = {
      ...existing,
      active: false,
      updatedTs: Math.max(ts, Number.isFinite(existing.updatedTs) ? existing.updatedTs : 0),
      source: typeof source === "string" ? source.trim().slice(0, 32) : "Stop"
    };
    this.setMeta(key, JSON.stringify(updated));
    return true;
  }

  /** Resolve a validated workspace directory for one or more explicit conversation/session IDs */
  resolveSessionWorkspace(sessionIds = [], { pluginRootNorm = null } = {}) {
    const list = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
    const candidates = [];
    const seen = new Set();
    const pushId = (raw) => {
      const cid = sanitizeSessionWorkspaceConvId(raw);
      if (cid && !seen.has(cid)) {
        seen.add(cid);
        candidates.push(cid);
      }
    };
    for (const id of list) {
      pushId(id);
      const cid = sanitizeSessionWorkspaceConvId(id);
      if (cid && typeof this.resolveRootSessionId === "function") {
        try {
          pushId(this.resolveRootSessionId(cid));
        } catch {}
      }
    }
    if (candidates.length === 0) return "";
    for (const cid of candidates) {
      try {
        const raw = this.getMeta(`${SESSION_WORKSPACE_PREFIX}${cid}`, null);
        if (raw && raw.startsWith("{")) {
          const parsed = JSON.parse(raw);
          const valid = normalizeSafeSessionWorkspaceDir(parsed?.cwd, { pluginRootNorm });
          if (valid) return valid.dir;
        }
      } catch {}
    }
    for (const cid of candidates) {
      try {
        const raw = this.getMeta(`watchdog_lease:${cid}`, null);
        if (raw && raw.startsWith("{")) {
          const parsed = JSON.parse(raw);
          const valid = normalizeSafeSessionWorkspaceDir(parsed?.cwd, { pluginRootNorm });
          if (valid) return valid.dir;
        }
      } catch {}
    }
    for (const cid of candidates) {
      try {
        this.open();
        const row = this.db
          .prepare("SELECT worktree FROM session_checkpoints WHERE session_id = ? AND worktree != '' LIMIT 1")
          .get(cid);
        const valid = normalizeSafeSessionWorkspaceDir(row?.worktree, { pluginRootNorm });
        if (valid) return valid.dir;
      } catch {}
    }
    return "";
  }

  /** Collect currently active (non-IDLE, fresh) conversation workspace records with primary/subagent classification */
  _collectActiveWorkspaceRecords({
    maxAgeMs = DEFAULT_ACTIVE_WORKSPACE_MAX_AGE_MS,
    nowMs = Date.now()
  } = {}) {
    const now = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const ttl = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? Math.floor(maxAgeMs) : DEFAULT_ACTIVE_WORKSPACE_MAX_AGE_MS;
    const perConv = new Map();

    try {
      const swRows = this.listMetaByPrefix(SESSION_WORKSPACE_PREFIX);
      for (const row of swRows) {
        const cid = sanitizeSessionWorkspaceConvId(row.key.slice(SESSION_WORKSPACE_PREFIX.length));
        if (!cid || typeof row.value !== "string" || !row.value.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(row.value);
          if (!parsed || typeof parsed !== "object") continue;
          const updatedTs = Number.isFinite(parsed.updatedTs) ? parsed.updatedTs : 0;
          perConv.set(cid, {
            swActive: Boolean(parsed.active),
            swTs: updatedTs,
            swCwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
            swIsSubagent: Boolean(parsed.isSubagent),
            swRootSessionId: sanitizeSessionWorkspaceConvId(parsed.rootSessionId),
            wlActive: null,
            wlTs: 0,
            wlCwd: "",
            wlIsSubagent: false,
            wlRootSessionId: "",
            wlParentConvId: ""
          });
        } catch {}
      }
    } catch {}

    try {
      const wlRows = this.listMetaByPrefix("watchdog_lease:");
      for (const row of wlRows) {
        const cid = sanitizeSessionWorkspaceConvId(row.key.slice("watchdog_lease:".length));
        if (!cid || typeof row.value !== "string" || !row.value.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(row.value);
          if (!parsed || typeof parsed !== "object") continue;
          if (parsed.isKeepaliveTurn === true || parsed.subphase === "ttl_keepalive") continue;
          const phase = typeof parsed.phase === "string" ? parsed.phase.toUpperCase() : "IDLE";
          const wlTs = Math.max(
            Number.isFinite(parsed.updatedTs) ? parsed.updatedTs : 0,
            Number.isFinite(parsed.lastHeartbeatTs) ? parsed.lastHeartbeatTs : 0
          );
          const wlActive = phase !== "IDLE";
          const wlCwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
          const wlIsSubagent = Boolean(parsed.isSubagent);
          const wlRootSessionId = sanitizeSessionWorkspaceConvId(
            parsed.rootConversationId || parsed.rootSessionId || ""
          );
          const wlParentConvId = sanitizeSessionWorkspaceConvId(parsed.parentConversationId || "");
          const existing = perConv.get(cid);
          if (existing) {
            existing.wlActive = wlActive;
            existing.wlTs = wlTs;
            existing.wlCwd = wlCwd;
            existing.wlIsSubagent = wlIsSubagent;
            existing.wlRootSessionId = wlRootSessionId;
            existing.wlParentConvId = wlParentConvId;
          } else {
            perConv.set(cid, {
              swActive: null,
              swTs: 0,
              swCwd: "",
              swIsSubagent: false,
              swRootSessionId: "",
              wlActive,
              wlTs,
              wlCwd,
              wlIsSubagent,
              wlRootSessionId,
              wlParentConvId
            });
          }
        } catch {}
      }
    } catch {}

    const activeRecords = [];
    for (const [cid, rec] of perConv.entries()) {
      let effectiveActive = false;
      let effectiveTs = 0;
      let effectiveCwd = "";

      if (rec.swActive !== null && rec.wlActive !== null) {
        if (rec.swTs > rec.wlTs) {
          effectiveActive = rec.swActive;
          effectiveTs = rec.swTs;
          effectiveCwd = rec.swCwd || rec.wlCwd;
        } else if (rec.wlTs > rec.swTs) {
          effectiveActive = rec.wlActive;
          effectiveTs = rec.wlTs;
          effectiveCwd = rec.wlCwd || rec.swCwd;
        } else {
          // On exact timestamp tie, IDLE / inactive wins so Stop cannot be shadowed.
          effectiveActive = rec.swActive && rec.wlActive;
          effectiveTs = rec.swTs;
          effectiveCwd = rec.swCwd || rec.wlCwd;
        }
      } else if (rec.swActive !== null) {
        effectiveActive = rec.swActive;
        effectiveTs = rec.swTs;
        effectiveCwd = rec.swCwd;
      } else if (rec.wlActive !== null) {
        effectiveActive = rec.wlActive;
        effectiveTs = rec.wlTs;
        effectiveCwd = rec.wlCwd;
      }

      if (!effectiveActive || effectiveTs <= 0) continue;
      if (now - effectiveTs > ttl || effectiveTs - now > 60_000) continue;

      const isSubagent = Boolean(
        rec.swIsSubagent ||
          rec.wlIsSubagent ||
          (rec.swRootSessionId && rec.swRootSessionId !== cid) ||
          (rec.wlRootSessionId && rec.wlRootSessionId !== cid) ||
          (rec.wlParentConvId && rec.wlParentConvId !== cid)
      );
      activeRecords.push({ cid, cwd: effectiveCwd, ts: effectiveTs, isSubagent });
    }
    return activeRecords;
  }

  /** Return true when another fresh, non-subagent conversation is currently active */
  hasOtherActivePrimarySession(
    excludeConvId = "",
    { maxAgeMs = DEFAULT_ACTIVE_WORKSPACE_MAX_AGE_MS, nowMs = Date.now() } = {}
  ) {
    const cleanExclude = sanitizeSessionWorkspaceConvId(excludeConvId);
    const activeRecords = this._collectActiveWorkspaceRecords({ maxAgeMs, nowMs });
    return activeRecords.some((rec) => !rec.isSubagent && (!cleanExclude || rec.cid !== cleanExclude));
  }

  /**
   * Return the unique active primary root session ID working in `workspaceDir`,
   * or "" if zero or multiple distinct primary sessions share that workspace.
   */
  resolveUniqueActivePrimarySessionForWorkspace(
    workspaceDir,
    { maxAgeMs = DEFAULT_ACTIVE_WORKSPACE_MAX_AGE_MS, nowMs = Date.now(), pluginRootNorm = null } = {}
  ) {
    const target = normalizeSafeSessionWorkspaceDir(workspaceDir, { pluginRootNorm });
    if (!target) return "";
    const activeRecords = this._collectActiveWorkspaceRecords({ maxAgeMs, nowMs });
    const exactPrimaryRootIds = new Set();
    const exactAnyRootIds = new Set();
    const parentAnyRootIds = new Set();
    for (const rec of activeRecords) {
      const valid = normalizeSafeSessionWorkspaceDir(rec.cwd, { pluginRootNorm });
      if (!valid) continue;
      const rootSid =
        typeof this.resolveRootSessionId === "function" ? this.resolveRootSessionId(rec.cid) : rec.cid;
      if (!rootSid) continue;
      if (valid.canonicalKey === target.canonicalKey) {
        exactAnyRootIds.add(rootSid);
        if (!rec.isSubagent) exactPrimaryRootIds.add(rootSid);
      } else if (isStoreSameOrSubDir(target.canonicalKey, valid.canonicalKey)) {
        parentAnyRootIds.add(rootSid);
      }
    }
    if (exactPrimaryRootIds.size === 1 && exactAnyRootIds.size === 1) {
      return [...exactPrimaryRootIds][0];
    }
    if (exactAnyRootIds.size === 0 && parentAnyRootIds.size === 1) {
      return [...parentAnyRootIds][0];
    }
    return "";
  }

  /**
   * Resolve a workspace directory ONLY when currently active (non-IDLE, fresh)
   * conversations unanimously point to a single unique workspace.
   * Prefers primary (non-subagent/non-swarm-worker) sessions so Swarm share/branch
   * worktrees never make the coordinator's active workspace look ambiguous.
   * Returns { status: "unique" | "ambiguous" | "none", dir, dirs }.
   */
  resolveUniqueActiveWorkspace({
    maxAgeMs = DEFAULT_ACTIVE_WORKSPACE_MAX_AGE_MS,
    nowMs = Date.now(),
    pluginRootNorm = null
  } = {}) {
    const activeRecords = this._collectActiveWorkspaceRecords({ maxAgeMs, nowMs });
    const primaryDirs = new Map();
    const subagentDirs = new Map();

    for (const rec of activeRecords) {
      const valid = normalizeSafeSessionWorkspaceDir(rec.cwd, { pluginRootNorm });
      if (!valid) continue;
      const targetMap = rec.isSubagent ? subagentDirs : primaryDirs;
      if (!targetMap.has(valid.canonicalKey)) {
        targetMap.set(valid.canonicalKey, valid.dir);
      }
    }

    const chosenDirs = primaryDirs.size > 0 ? primaryDirs : subagentDirs;
    const dirs = [...chosenDirs.values()];
    if (dirs.length === 1) {
      return { status: "unique", dir: dirs[0], dirs };
    }
    if (dirs.length > 1) {
      return { status: "ambiguous", dir: "", dirs };
    }
    return { status: "none", dir: "", dirs: [] };
  }

  /** Check if a session or conversation has an explicit cutoff override */
  hasCutoffOverride(sessionId) {
    if (!sessionId || sessionId === "all" || sessionId === "lifetime") return false;
    this.open();
    return this.getMeta(`cutoff:session:${sessionId}`) !== null;
  }

  /** Get active cutoff in bytes along with provenance ("sqlite:session"|"sqlite:app"|"env"|"config"|"sqlite:user"|"sqlite:installer_default"|"default") */
  getCutoffInfo(sessionId = null) {
    this.open();
    const parseMetaCutoff = (raw) => {
      if (raw === null || raw === undefined) return null;
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    const isGlobalScope = !sessionId || sessionId === "all" || sessionId === "lifetime";
    // 1. Session/Conversation override
    if (!isGlobalScope) {
      const sessionCutoff = parseMetaCutoff(this.getMeta(`cutoff:session:${sessionId}`));
      if (sessionCutoff !== null) {
        return {
          cutoffBytes: sessionCutoff,
          source: "sqlite:session",
          savedCutoffBytes: sessionCutoff,
          overriddenBy: null
        };
      }
      // If checking a conversation, fall back to the app session cutoff if set
      if (sessionId !== "app") {
        const appCutoff = parseMetaCutoff(this.getMeta("cutoff:session:app"));
        if (appCutoff !== null) {
          return {
            cutoffBytes: appCutoff,
            source: "sqlite:app",
            savedCutoffBytes: appCutoff,
            overriddenBy: null
          };
        }
      }
    }

    // 2. Unified config / env override if explicitly set
    const cfgSnap = getConfigSnapshot();
    const cfgMaxRead = cfgSnap.values.maxReadBytes;
    if (cfgMaxRead !== null && cfgMaxRead !== undefined && Number.isFinite(Number(cfgMaxRead))) {
      const effSource = cfgSnap.sources.maxReadBytes === "env" ? "env" : "config";
      const savedGlobalCutoff = parseMetaCutoff(this.getMeta("cutoff:global"));
      return {
        cutoffBytes: Math.max(0, Math.floor(Number(cfgMaxRead))),
        source: effSource,
        savedCutoffBytes: isGlobalScope ? savedGlobalCutoff : null,
        overriddenBy: isGlobalScope ? effSource : null
      };
    }

    // 3. Saved global setting in SQLite
    const globalCutoff = parseMetaCutoff(this.getMeta("cutoff:global"));
    if (globalCutoff !== null) {
      const metaSrc = this.getMeta("cutoff:source", null);
      return {
        cutoffBytes: globalCutoff,
        source: metaSrc === "installer_default" ? "sqlite:installer_default" : "sqlite:user",
        savedCutoffBytes: globalCutoff,
        overriddenBy: null
      };
    }

    // 4. Default 45 KiB (46,080 B — aligns with Antigravity read_file host cap & <= 800-line window)
    return { cutoffBytes: DEFAULT_CUTOFF_BYTES, source: "default", savedCutoffBytes: null, overriddenBy: null };
  }

  /** Get active cutoff in bytes (0 = none/disabled) */
  getCutoff(sessionId = null) {
    return this.getCutoffInfo(sessionId).cutoffBytes;
  }

  /** Set cutoff in bytes (0 = none/disabled) */
  setCutoff(bytes, sessionId = null, options = {}) {
    this.open();
    const val = parseInt(bytes, 10);
    const numVal = Number.isNaN(val) ? DEFAULT_CUTOFF_BYTES : Math.max(0, val);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`cutoff:session:${sessionId}`, numVal);
    } else {
      this.setMeta("cutoff:global", numVal);
      this.setMeta("cutoff:source", options?.source === "installer_default" ? "installer_default" : "user");
      // When changing cutoff in lifetime, clear session-level and default overrides
      // so new sessions and new conversations inherit this global setting as their default.
      this.deleteMeta("cutoff:session:app");
      this.deleteMeta("cutoff:session:default");
    }
    return numVal;
  }

  /** Internal helper to recompute and save the combined exempt_ext list */
  _recomputeExemptExtensions(sessionId = null) {
    const activeCats = this.getExemptCategories(sessionId);
    const customs = this.getCustomExemptExtensions(sessionId);
    const combined = new Set(customs);
    for (const catId of activeCats) {
      const cat = FILE_CATEGORIES[catId];
      if (cat && Array.isArray(cat.extensions)) {
        for (const ext of cat.extensions) {
          combined.add(ext);
        }
      }
    }
    const cleanList = Array.from(combined);
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`exempt_ext:session:${sessionId}`, serialized);
    } else {
      this.setMeta("exempt_ext:global", serialized);
      this.deleteMeta("exempt_ext:session:app");
      this.deleteMeta("exempt_ext:session:default");
    }
    return cleanList;
  }

  /** Get list of active category IDs */
  getExemptCategories(sessionId = null) {
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const raw = this.getMeta(`exempt_categories:session:${sessionId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      if (sessionId !== "app") {
        const appRaw = this.getMeta("exempt_categories:session:app");
        if (appRaw) {
          try {
            const parsed = JSON.parse(appRaw);
            if (Array.isArray(parsed)) return parsed;
          } catch {}
        }
      }
    }
    const globalRaw = this.getMeta("exempt_categories:global");
    if (globalRaw) {
      try {
        const parsed = JSON.parse(globalRaw);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [...DEFAULT_ACTIVE_CATEGORIES];
  }

  /** Set list of active category IDs */
  setExemptCategories(categories, sessionId = null) {
    this.open();
    const cleanList = Array.isArray(categories)
      ? Array.from(new Set(categories.map(c => String(c).trim().toLowerCase()).filter(c => FILE_CATEGORIES[c])))
      : [...DEFAULT_ACTIVE_CATEGORIES];
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`exempt_categories:session:${sessionId}`, serialized);
    } else {
      this.setMeta("exempt_categories:global", serialized);
      this.deleteMeta("exempt_categories:session:app");
      this.deleteMeta("exempt_categories:session:default");
    }
    this._recomputeExemptExtensions(sessionId);
    return cleanList;
  }

  /** Toggle an exempt category on or off */
  toggleExemptCategory(categoryId, enabled = null, sessionId = null) {
    const active = this.getExemptCategories(sessionId);
    const cat = String(categoryId || "").trim().toLowerCase();
    if (!FILE_CATEGORIES[cat]) return active;

    const isCurrentlyActive = active.includes(cat);
    const shouldEnable = enabled !== null ? Boolean(enabled) : !isCurrentlyActive;

    let updated;
    if (shouldEnable && !isCurrentlyActive) {
      updated = [...active, cat];
    } else if (!shouldEnable && isCurrentlyActive) {
      updated = active.filter(c => c !== cat);
    } else {
      return active;
    }
    return this.setExemptCategories(updated, sessionId);
  }

  /** Get custom file extensions (explicitly added by user) */
  getCustomExemptExtensions(sessionId = null) {
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const raw = this.getMeta(`custom_exempt_ext:session:${sessionId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      if (sessionId !== "app") {
        const appRaw = this.getMeta("custom_exempt_ext:session:app");
        if (appRaw) {
          try {
            const parsed = JSON.parse(appRaw);
            if (Array.isArray(parsed)) return parsed;
          } catch {}
        }
      }
    }
    const globalRaw = this.getMeta("custom_exempt_ext:global");
    if (globalRaw) {
      try {
        const parsed = JSON.parse(globalRaw);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [];
  }

  /** Sanitize a custom file extension to safe dotted token (blocks HTML/whitespace/path-sep injection) */
  _sanitizeCustomExtension(raw) {
    const clean = String(raw || "").trim().toLowerCase();
    if (!clean) return "";
    const formatted = clean.startsWith(".") ? clean : `.${clean}`;
    if (!/^\.[a-z0-9][a-z0-9._+-]{0,31}$/i.test(formatted)) return "";
    return formatted;
  }

  /** Set custom file extensions */
  setCustomExemptExtensions(extensions, sessionId = null) {
    this.open();
    const cleanList = Array.from(
      new Set(
        (Array.isArray(extensions) ? extensions : [])
          .map((ext) => this._sanitizeCustomExtension(ext))
          .filter(Boolean)
      )
    );
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`custom_exempt_ext:session:${sessionId}`, serialized);
    } else {
      this.setMeta("custom_exempt_ext:global", serialized);
      this.deleteMeta("custom_exempt_ext:session:app");
      this.deleteMeta("custom_exempt_ext:session:default");
    }
    this._recomputeExemptExtensions(sessionId);
    return cleanList;
  }

  /** Add custom file extension */
  addCustomExemptExtension(ext, sessionId = null) {
    const list = this.getCustomExemptExtensions(sessionId);
    const formatted = this._sanitizeCustomExtension(ext);
    if (!formatted) return list;
    if (!list.includes(formatted)) {
      list.push(formatted);
      this.setCustomExemptExtensions(list, sessionId);
    }
    return list;
  }

  /** Remove custom file extension */
  removeCustomExemptExtension(ext, sessionId = null) {
    const list = this.getCustomExemptExtensions(sessionId);
    const cleanExt = String(ext || "").trim().toLowerCase();
    if (!cleanExt) return list;
    const formatted = cleanExt.startsWith(".") ? cleanExt : `.${cleanExt}`;
    const filtered = list.filter((e) => e !== formatted);
    this.setCustomExemptExtensions(filtered, sessionId);
    return filtered;
  }

  /** Get list of file extensions exempt from the read_file size cutoff */
  getExemptExtensions(sessionId = null) {
    this.open();
    // Scope precedence: session:<sid> -> session:app -> global.
    // Only honor a legacy raw `exempt_ext:<scope>` key if that highest-precedence scope has
    // NO structured `exempt_categories`/`custom_exempt_ext` keys; otherwise compute dynamically
    // from getExemptCategories(sid) U getCustomExemptExtensions(sid) so global category updates
    // are never shadowed by stale cached session `exempt_ext` snapshots.
    const scopes = [];
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      scopes.push(`session:${sessionId}`);
      if (sessionId !== "app") {
        scopes.push("session:app");
      }
    }
    scopes.push("global");

    for (const sc of scopes) {
      const hasCats = this.getMeta(`exempt_categories:${sc}`) !== null;
      const hasCustom = this.getMeta(`custom_exempt_ext:${sc}`) !== null;
      if (hasCats || hasCustom) {
        break;
      }
      const rawExt = this.getMeta(`exempt_ext:${sc}`);
      if (rawExt !== null) {
        try {
          const parsed = JSON.parse(rawExt);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
    }

    const activeCats = this.getExemptCategories(sessionId);
    const customs = this.getCustomExemptExtensions(sessionId);
    const combined = new Set(customs);
    for (const catId of activeCats) {
      const cat = FILE_CATEGORIES[catId];
      if (cat && Array.isArray(cat.extensions)) {
        for (const ext of cat.extensions) {
          combined.add(ext);
        }
      }
    }
    return Array.from(combined);
  }

  /** Set list of file extensions exempt from the size cutoff */
  setExemptExtensions(extensions, sessionId = null) {
    this.open();
    if (extensions === null) {
      this.setExemptCategories(null, sessionId);
      this.setCustomExemptExtensions([], sessionId);
      return this.getExemptExtensions(sessionId);
    }
    const cleanList = Array.from(
      new Set(
        (Array.isArray(extensions) ? extensions : [])
          .map((ext) => String(ext || "").trim().toLowerCase())
          .filter(Boolean)
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      )
    );
    const activeCats = [];
    for (const [catId, catObj] of Object.entries(FILE_CATEGORIES)) {
      if (Array.isArray(catObj.extensions) && catObj.extensions.length > 0 && catObj.extensions.every((e) => cleanList.includes(e))) {
        activeCats.push(catId);
      }
    }
    const allCatExts = new Set(activeCats.flatMap((c) => FILE_CATEGORIES[c]?.extensions || []));
    const customs = cleanList.filter((e) => !allCatExts.has(e));

    this.setExemptCategories(activeCats, sessionId);
    this.setCustomExemptExtensions(customs, sessionId);
    return this.getExemptExtensions(sessionId);
  }

  /** Add an exempt file extension */
  addExemptExtension(ext, sessionId = null) {
    this.addCustomExemptExtension(ext, sessionId);
    return this.getExemptExtensions(sessionId);
  }

  /** Remove an exempt file extension */
  removeExemptExtension(ext, sessionId = null) {
    this.removeCustomExemptExtension(ext, sessionId);
    return this.getExemptExtensions(sessionId);
  }

  /** Check if protection is paused (true = paused, false = active) */
  isPaused(sessionId = null) {
    this.open();
    // 1. Session/Conversation override
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sessionPaused = this.getMeta(`paused:session:${sessionId}`);
      if (sessionPaused !== null) {
        return sessionPaused === "true" || sessionPaused === "1";
      }
      // If checking a conversation, fall back to the app session paused state if set
      if (sessionId !== "app") {
        const appPaused = this.getMeta("paused:session:app");
        if (appPaused !== null) {
          return appPaused === "true" || appPaused === "1";
        }
      }
    }
    // 2. Global paused setting
    const globalPaused = this.getMeta("paused:global");
    if (globalPaused !== null) {
      return globalPaused === "true" || globalPaused === "1";
    }
    return false;
  }

  /** Set protection paused state (true = paused, false = active) */
  setPaused(paused, sessionId = null) {
    this.open();
    const boolVal = Boolean(paused && paused !== "false" && paused !== "0");
    const strVal = boolVal ? "true" : "false";
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`paused:session:${sessionId}`, strVal);
    } else {
      this.setMeta("paused:global", strVal);
      this.deleteMeta("paused:session:app");
      this.deleteMeta("paused:session:default");
    }
    return boolVal;
  }

  /** Check if transparent PreToolUse CLI output filtering is enabled */
  isCliFilterEnabled(sessionId = null) {
    if (!getEffectiveConfig().cliFilter) return false;
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sVal = this.getMeta(`cli_filter:session:${sessionId}`);
      if (sVal !== null) return sVal !== "false" && sVal !== "0";
      if (sessionId !== "app") {
        const aVal = this.getMeta("cli_filter:session:app");
        if (aVal !== null) return aVal !== "false" && aVal !== "0";
      }
    }
    const gVal = this.getMeta("cli_filter:global");
    if (gVal !== null) return gVal !== "false" && gVal !== "0";
    return true;
  }

  /** Enable or disable transparent PreToolUse CLI output filtering */
  setCliFilterEnabled(enabled, sessionId = null) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    const strVal = boolVal ? "true" : "false";
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`cli_filter:session:${sessionId}`, strVal);
    } else {
      this.setMeta("cli_filter:global", strVal);
      this.deleteMeta("cli_filter:session:app");
      this.deleteMeta("cli_filter:session:default");
    }
    return boolVal;
  }

  /** Check if session-level unchanged read_file deduplication is enabled */
  isReadDedupEnabled(sessionId = null) {
    if (!getEffectiveConfig().readDedup) return false;
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sVal = this.getMeta(`read_dedup:session:${sessionId}`);
      if (sVal !== null) return sVal !== "false" && sVal !== "0";
      if (sessionId !== "app") {
        const aVal = this.getMeta("read_dedup:session:app");
        if (aVal !== null) return aVal !== "false" && aVal !== "0";
      }
    }
    const gVal = this.getMeta("read_dedup:global");
    if (gVal !== null) return gVal !== "false" && gVal !== "0";
    return true;
  }

  /** Enable or disable session-level unchanged read_file deduplication */
  setReadDedupEnabled(enabled, sessionId = null) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    const strVal = boolVal ? "true" : "false";
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`read_dedup:session:${sessionId}`, strVal);
    } else {
      this.setMeta("read_dedup:global", strVal);
      this.deleteMeta("read_dedup:session:app");
      this.deleteMeta("read_dedup:session:default");
    }
    return boolVal;
  }

  /** Check if Sidecar Stall Watchdog is enabled (env > sqlite toggle > config > default true) */
  isWatchdogEnabled() {
    const snap = getConfigSnapshot();
    if (snap.sources.stallWatchdog === "env") {
      return Boolean(snap.values.stallWatchdog);
    }
    this.open();
    const raw = this.getMeta("watchdog:enabled", null);
    if (raw !== null) {
      return raw !== "false" && raw !== "0";
    }
    return Boolean(snap.values.stallWatchdog);
  }

  /** Enable or disable Sidecar Stall Watchdog in SQLite meta */
  setWatchdogEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta("watchdog:enabled", boolVal ? "true" : "false");
    return boolVal;
  }

  /**
   * Unified effective-value + override-source snapshot for core dashboard settings:
   * cutoff, cliFilter, readDedup, watchdog, and ttlKeepalive.
   */
  getCoreSettingsInfo(sessionId = null) {
    this.open();
    const snap = getConfigSnapshot();
    const cutoff = this.getCutoffInfo(sessionId);

    const resolveScopedBoolMeta = (prefix) => {
      if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
        const sVal = this.getMeta(`${prefix}:session:${sessionId}`);
        if (sVal !== null) return { saved: sVal !== "false" && sVal !== "0", scope: sessionId === "app" ? "app" : "conversation" };
        if (sessionId !== "app") {
          const aVal = this.getMeta(`${prefix}:session:app`);
          if (aVal !== null) return { saved: aVal !== "false" && aVal !== "0", scope: "app" };
        }
      }
      const gVal = this.getMeta(`${prefix}:global`);
      if (gVal !== null) return { saved: gVal !== "false" && gVal !== "0", scope: "global" };
      return { saved: null, scope: null };
    };

    const buildToggleInfo = (cfgKey, metaPrefix, effectiveBool) => {
      const cfgDisabled = snap.values[cfgKey] === false;
      const cfgSource = snap.sources[cfgKey] || "default";
      const meta = resolveScopedBoolMeta(metaPrefix);
      if (cfgDisabled && (cfgSource === "env" || cfgSource === "config")) {
        return {
          effective: false,
          saved: meta.saved,
          effectiveSource: cfgSource,
          overriddenBy: cfgSource,
          scope: meta.scope
        };
      }
      if (meta.saved !== null) {
        return {
          effective: effectiveBool,
          saved: meta.saved,
          effectiveSource: `sqlite:${meta.scope}`,
          overriddenBy: null,
          scope: meta.scope
        };
      }
      return {
        effective: effectiveBool,
        saved: null,
        effectiveSource: cfgSource,
        overriddenBy: null,
        scope: null
      };
    };

    const cliFilter = buildToggleInfo("cliFilter", "cli_filter", this.isCliFilterEnabled(sessionId));
    const readDedup = buildToggleInfo("readDedup", "read_dedup", this.isReadDedupEnabled(sessionId));

    const wdRaw = this.getMeta("watchdog:enabled", null);
    const wdSaved = wdRaw !== null ? wdRaw !== "false" && wdRaw !== "0" : null;
    const wdEffective = this.isWatchdogEnabled();
    const wdEnvLocked = snap.sources.stallWatchdog === "env";
    const watchdog = {
      effective: wdEffective,
      saved: wdSaved,
      effectiveSource: wdEnvLocked ? "env" : wdSaved !== null ? "sqlite:user" : snap.sources.stallWatchdog || "default",
      overriddenBy: wdEnvLocked ? "env" : null
    };

    const kaRaw = this.getMeta("cache:ttl_keepalive_global_max_count", null);
    const kaSavedMax =
      kaRaw !== null && kaRaw !== "" && Number.isFinite(Number(kaRaw)) ? Math.max(0, Math.floor(Number(kaRaw))) : null;
    const kaEffectiveMax = this.getGlobalTtlKeepaliveMaxCount();
    const kaEnvLocked =
      (snap.sources.ttlKeepalive === "env" && snap.values.ttlKeepalive === false) ||
      snap.sources.ttlKeepaliveMaxCount === "env" ||
      (snap.sources.ttlKeepalive === "env" && snap.values.ttlKeepalive === true && kaSavedMax === 0);
    const ttlKeepalive = {
      effective: kaEffectiveMax >= 1,
      effectiveMaxCount: kaEffectiveMax,
      savedMaxCount: kaSavedMax,
      effectiveSource: kaEnvLocked
        ? "env"
        : kaSavedMax !== null
          ? "sqlite:user"
          : snap.sources.ttlKeepalive !== "default"
            ? snap.sources.ttlKeepalive
            : snap.sources.ttlKeepaliveMaxCount || "default",
      overriddenBy: kaEnvLocked ? "env" : null
    };

    return { cutoff, cliFilter, readDedup, watchdog, ttlKeepalive };
  }

  /** Check if opt-in desktop stall notifications are enabled (default OFF; env > sqlite toggle > config) */
  isWatchdogDesktopNotifyEnabled() {
    const snap = getConfigSnapshot();
    if (snap.sources.watchdogDesktopNotify === "env") {
      return Boolean(snap.values.watchdogDesktopNotify);
    }
    this.open();
    const raw = this.getMeta("watchdog:desktop_notify", null);
    if (raw !== null) {
      return raw === "true" || raw === "1";
    }
    return Boolean(snap.values.watchdogDesktopNotify);
  }

  /** Enable or disable opt-in desktop stall notifications in SQLite meta */
  setWatchdogDesktopNotifyEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta("watchdog:desktop_notify", boolVal ? "true" : "false");
    return boolVal;
  }

  /** Check if opt-in high-context KV-cache TTL expiry desktop alerts are enabled (default OFF; env > sqlite > config) */
  isTtlDesktopNotifyEnabled() {
    const snap = getConfigSnapshot();
    if (snap.sources.ttlDesktopNotify === "env") {
      return Boolean(snap.values.ttlDesktopNotify);
    }
    this.open();
    const raw = this.getMeta("cache:ttl_desktop_notify", null);
    if (raw !== null) {
      return raw === "true" || raw === "1";
    }
    return Boolean(snap.values.ttlDesktopNotify);
  }

  /** Enable or disable opt-in high-context KV-cache TTL expiry desktop alerts in SQLite meta */
  setTtlDesktopNotifyEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta("cache:ttl_desktop_notify", boolVal ? "true" : "false");
    return boolVal;
  }

  /** Inspect effective opt-in silent auto-update install setting and its source (default OFF; env > sqlite > config) */
  getAutoUpdateInstallInfo(env = process.env) {
    const snap = getConfigSnapshot({ env });
    if (snap.values.autoUpdateCheck === false) {
      return { enabled: false, source: snap.sources.autoUpdateCheck === "env" ? "env" : "config" };
    }
    if (snap.sources.autoUpdateInstall === "env") {
      return { enabled: Boolean(snap.values.autoUpdateInstall), source: "env" };
    }
    this.open();
    const raw = this.getMeta(AUTO_UPDATE_INSTALL_META_KEY, null);
    if (raw !== null) {
      return { enabled: raw === "true" || raw === "1", source: "sqlite" };
    }
    return {
      enabled: Boolean(snap.values.autoUpdateInstall),
      source: snap.sources.autoUpdateInstall || "default"
    };
  }

  /** Check if opt-in silent auto-update install is enabled (default OFF; env > sqlite > config) */
  isAutoUpdateInstallEnabled(env = process.env) {
    return this.getAutoUpdateInstallInfo(env).enabled;
  }

  /** Enable or disable opt-in silent auto-update install in SQLite meta */
  setAutoUpdateInstallEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta(AUTO_UPDATE_INSTALL_META_KEY, boolVal ? "true" : "false");
    return boolVal;
  }

  /** Read normalized silent auto-update runtime state (circuit breaker + post-update notice) */
  getAutoUpdateRuntimeState() {
    this.open();
    return normalizeAutoUpdateRuntimeState(this.getMeta(AUTO_UPDATE_STATE_META_KEY, null));
  }

  /** Merge and persist silent auto-update runtime state in SQLite meta */
  setAutoUpdateRuntimeState(patch = {}) {
    this.open();
    const next = normalizeAutoUpdateRuntimeState({
      ...this.getAutoUpdateRuntimeState(),
      ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {})
    });
    this.setMeta(AUTO_UPDATE_STATE_META_KEY, JSON.stringify(next));
    return next;
  }

  /** Clear one-time post-auto-update notice after user acknowledgement */
  clearAutoUpdateNotice() {
    return this.setAutoUpdateRuntimeState({
      lastAutoUpdatedVersion: "",
      lastAutoUpdatedFrom: "",
      lastAutoUpdatedAt: "",
      lastAutoUpdatedUrl: ""
    });
  }

  /** Return last remembered non-zero global keepalive max count (1..20, fallback 1) */
  getFallbackNonZeroKeepaliveMaxCount() {
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_last_nonzero_max", null);
    if (raw !== null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 1) {
        return Math.min(20, Math.max(1, Math.floor(n)));
      }
    }
    const snap = getConfigSnapshot();
    const cfgMax = Number(snap.values.ttlKeepaliveMaxCount);
    if (Number.isFinite(cfgMax) && cfgMax >= 1) {
      return Math.min(20, Math.max(1, Math.floor(cfgMax)));
    }
    return 1;
  }

  /** True iff global keepalive max count (0..20) has been explicitly persisted in SQLite meta */
  hasExplicitGlobalTtlKeepaliveMaxCount() {
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_global_max_count", null);
    if (raw === null || raw === "") return false;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 20;
  }

  /** Resolve global default auto-keepalive max count (0..20; 0 means off by default for uncustomized windows) */
  getGlobalTtlKeepaliveMaxCount() {
    const snap = getConfigSnapshot();
    const clampGlobal = (v) => Math.min(20, Math.max(0, Math.floor(Number(v))));
    if (snap.sources.ttlKeepalive === "env" && snap.values.ttlKeepalive === false) {
      return 0;
    }
    if (snap.sources.ttlKeepaliveMaxCount === "env") {
      return clampGlobal(snap.values.ttlKeepaliveMaxCount ?? 1);
    }
    const envForcedOn = snap.sources.ttlKeepalive === "env" && snap.values.ttlKeepalive === true;
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_global_max_count", null);
    if (raw !== null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) {
        const clampedMeta = clampGlobal(n);
        return clampedMeta === 0 && envForcedOn ? this.getFallbackNonZeroKeepaliveMaxCount() : clampedMeta;
      }
    }
    if (snap.values.ttlKeepalive === false) {
      return 0;
    }
    const cfgVal = clampGlobal(snap.values.ttlKeepaliveMaxCount ?? 1);
    return cfgVal === 0 && envForcedOn ? this.getFallbackNonZeroKeepaliveMaxCount() : cfgVal;
  }

  /** Persist global default auto-keepalive max count (0..20) in SQLite meta and remember last non-zero count */
  setGlobalTtlKeepaliveMaxCount(maxCount) {
    this.open();
    const isBlankOrInvalid =
      maxCount === null ||
      maxCount === undefined ||
      typeof maxCount === "boolean" ||
      typeof maxCount === "object" ||
      (typeof maxCount === "string" && maxCount.trim() === "");
    const n = isBlankOrInvalid ? NaN : Number(maxCount);
    const clamped = Number.isFinite(n) ? Math.min(20, Math.max(0, Math.floor(n))) : 1;
    this.setMeta("cache:ttl_keepalive_global_max_count", String(clamped));
    if (clamped >= 1) {
      this.setMeta("cache:ttl_keepalive_last_nonzero_max", String(clamped));
    }
    return clamped;
  }

  /** True iff global keepalive min context % (0..100) has been explicitly persisted in SQLite meta */
  hasExplicitGlobalTtlKeepaliveMinContextPct() {
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_min_context_pct", null);
    if (raw === null || raw === "") return false;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 100;
  }

  /** Resolve global default keepalive min context window % (0..100, default 15%; env > sqlite > config) */
  getGlobalTtlKeepaliveMinContextPct() {
    const snap = getConfigSnapshot();
    const clampPct = (v) => Math.min(100, Math.max(0, Math.floor(Number(v))));
    if (snap.sources.ttlKeepaliveMinContextPct === "env") {
      return clampPct(snap.values.ttlKeepaliveMinContextPct ?? 15);
    }
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_min_context_pct", null);
    if (raw !== null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n <= 100) {
        return clampPct(n);
      }
    }
    return clampPct(snap.values.ttlKeepaliveMinContextPct ?? 15);
  }

  /** Persist global default keepalive min context window % (0..100; 0 means no threshold) in SQLite meta */
  setGlobalTtlKeepaliveMinContextPct(pct) {
    this.open();
    const isBlankOrInvalid =
      pct === null ||
      pct === undefined ||
      typeof pct === "boolean" ||
      typeof pct === "object" ||
      (typeof pct === "string" && pct.trim() === "");
    const n = isBlankOrInvalid ? NaN : Number(pct);
    const clamped = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 15;
    this.setMeta("cache:ttl_keepalive_min_context_pct", String(clamped));
    return clamped;
  }

  _normalizeKeepaliveIntervalSec(raw) {
    if (raw === null || raw === undefined || typeof raw === "boolean" || typeof raw === "object") return null;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (!s) return null;
      if (s === "0" || s === "auto" || s === "adaptive" || s === "dynamic") return 0;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const floored = Math.floor(n);
    if (floored === 0) return 0;
    if (floored < 60) return null;
    return Math.min(3600, floored);
  }

  /** True iff global keepalive interval (0=auto or 60..3600s) has been explicitly persisted in SQLite meta */
  hasExplicitGlobalTtlKeepaliveIntervalSec() {
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_global_interval_sec", null);
    if (raw === null || raw === "") return false;
    return this._normalizeKeepaliveIntervalSec(raw) !== null;
  }

  /** Resolve global default keepalive interval seconds (0=adaptive auto, 60..3600=fixed seconds; env > sqlite > config) */
  getGlobalTtlKeepaliveIntervalSec() {
    const snap = getConfigSnapshot();
    if (snap.sources.ttlKeepaliveIntervalSec === "env") {
      return this._normalizeKeepaliveIntervalSec(snap.values.ttlKeepaliveIntervalSec) ?? 0;
    }
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_global_interval_sec", null);
    if (raw !== null && raw !== "") {
      const parsed = this._normalizeKeepaliveIntervalSec(raw);
      if (parsed !== null) return parsed;
    }
    return this._normalizeKeepaliveIntervalSec(snap.values.ttlKeepaliveIntervalSec) ?? 0;
  }

  /** Persist global default keepalive interval seconds (0=adaptive auto, 60..3600=fixed seconds) in SQLite meta */
  setGlobalTtlKeepaliveIntervalSec(intervalSec) {
    this.open();
    const norm = this._normalizeKeepaliveIntervalSec(intervalSec);
    const clamped = norm !== null ? norm : 0;
    this.setMeta("cache:ttl_keepalive_global_interval_sec", String(clamped));
    return clamped;
  }

  /** Resolve effective keepalive interval seconds for a conversation (per-conv > env > global sqlite > config > 0) */
  getTtlKeepaliveIntervalSec(conversationId = null) {
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (cleanId) {
      const st = this.getTtlKeepaliveState(cleanId);
      if (st.intervalSec !== null && st.intervalSec !== undefined) {
        return st.intervalSec;
      }
    }
    return this.getGlobalTtlKeepaliveIntervalSec();
  }

  /** Persist per-conversation keepalive interval override (0=auto, 60..3600=fixed, null=follow global) */
  setTtlKeepaliveIntervalSec(intervalSec, conversationId = null) {
    const targetId = this._sanitizeKeepaliveConvId(conversationId) || "__unbound__";
    if (intervalSec === null) {
      this.setTtlKeepaliveState(targetId, { intervalSec: null });
      return this.getGlobalTtlKeepaliveIntervalSec();
    }
    const norm = this._normalizeKeepaliveIntervalSec(intervalSec);
    const effective = norm !== null ? norm : 0;
    this.setTtlKeepaliveState(targetId, { intervalSec: effective });
    return effective;
  }

  /** Read smoothed keepalive send->PreInvocation delivery latency in ms (0..20000; 0 = uncalibrated) */
  getTtlKeepaliveDeliveryMs() {
    this.open();
    const raw = this.getMeta("cache:ttl_keepalive_delivery_ms", null);
    if (raw === null || raw === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(20000, Math.max(0, Math.round(n))) : 0;
  }

  /** Record a measured keepalive send->PreInvocation ack latency sample (EMA smoothed, clamped 50..20000 ms) */
  recordTtlKeepaliveDeliveryMs(sampleMs) {
    const s = Number(sampleMs);
    if (!Number.isFinite(s) || s <= 0 || s > 30000) {
      return this.getTtlKeepaliveDeliveryMs();
    }
    this.open();
    const clampedSample = Math.min(20000, Math.max(50, Math.round(s)));
    const prev = this.getTtlKeepaliveDeliveryMs();
    const next = prev > 0 ? Math.round(prev * 0.6 + clampedSample * 0.4) : clampedSample;
    this.setMeta("cache:ttl_keepalive_delivery_ms", String(next));
    return next;
  }

  /** Resolve opt-in keepalive: env kill-switch > per-conv sqlite > env max/on > global sqlite > config. */
  isTtlKeepaliveEnabled(conversationId = null) {
    const snap = getConfigSnapshot();
    if (snap.sources.ttlKeepalive === "env" && snap.values.ttlKeepalive === false) {
      return false;
    }
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (cleanId) {
      const st = this.getTtlKeepaliveState(cleanId);
      if (typeof st.enabled === "boolean") {
        return st.enabled;
      }
      if (typeof st.maxCount === "number" && Number.isFinite(st.maxCount) && st.maxCount >= 1) {
        return true;
      }
    }
    if (snap.sources.ttlKeepaliveMaxCount === "env") {
      return Number(snap.values.ttlKeepaliveMaxCount) >= 1;
    }
    if (snap.sources.ttlKeepalive === "env" && snap.values.ttlKeepalive === true) {
      return true;
    }
    return this.getGlobalTtlKeepaliveMaxCount() >= 1;
  }

  /** Enable or disable KV-cache TTL auto-keepalive for a specific conversation in SQLite meta */
  setTtlKeepaliveEnabled(enabled, conversationId = null) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    const targetId = this._sanitizeKeepaliveConvId(conversationId) || "__unbound__";
    this.setTtlKeepaliveState(targetId, { enabled: boolVal });
    return boolVal;
  }

  /** True iff this specific conversation was explicitly toggled ON (or given an explicit count >= 1 while global is 0) in SQLite meta */
  hasExplicitTtlKeepaliveEnabled(conversationId, { globalOff = this.getGlobalTtlKeepaliveMaxCount() === 0 } = {}) {
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (!cleanId || cleanId === "__unbound__") return false;
    const st = this.getTtlKeepaliveState(cleanId);
    if (st.enabled === true) return true;
    return Boolean(globalOff && st.enabled !== false && typeof st.maxCount === "number" && st.maxCount >= 1);
  }

  /** True iff ANY real conversation in SQLite meta has an explicit keepalive ON override */
  hasAnyExplicitTtlKeepaliveEnabled({ globalOff = this.getGlobalTtlKeepaliveMaxCount() === 0 } = {}) {
    this.open();
    try {
      const isGlobalOff = Boolean(globalOff);
      const allowDefaultSummaryDb = Boolean(
        (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) ||
          (typeof this.dbPath === "string" &&
            isSameStorePath(this.dbPath, path.join(os.homedir(), ".agy-dart", "context.db")))
      );
      const DatabaseSyncCtor = this.db?.constructor || null;
      const summaryReader = DatabaseSyncCtor
        ? createSummaryDbReader(DatabaseSyncCtor, { allowDefaultDb: allowDefaultSummaryDb })
        : null;
      try {
        const rows = this.db
          .prepare("SELECT key, value FROM meta WHERE key LIKE 'cache:ttl_keepalive_state:%'")
          .all();
        for (const row of rows || []) {
          if (!row || typeof row.key !== "string" || row.key.endsWith(":__unbound__")) continue;
          if (typeof row.value !== "string") continue;
          const cid = this._sanitizeKeepaliveConvId(row.key.slice("cache:ttl_keepalive_state:".length));
          if (!cid) continue;
          try {
            const parsed = JSON.parse(row.value);
            const explicitlyOn =
              parsed &&
              (parsed.enabled === true ||
                (isGlobalOff &&
                  parsed.enabled !== false &&
                  parsed.maxCount !== null &&
                  parsed.maxCount !== undefined &&
                  parsed.maxCount !== "" &&
                  typeof parsed.maxCount !== "boolean" &&
                  Number.isFinite(Number(parsed.maxCount)) &&
                  Number(parsed.maxCount) >= 1));
            if (!explicitlyOn) continue;
            const leaseRaw = this.getMeta(`watchdog_lease:${cid}`, null);
            let leaseObj = null;
            if (leaseRaw && typeof leaseRaw === "string") {
              leaseObj = JSON.parse(leaseRaw);
              if (
                leaseObj &&
                (leaseObj.isSubagent === true ||
                  (leaseObj.parentConversationId && leaseObj.parentConversationId !== cid) ||
                  (leaseObj.rootSessionId && leaseObj.rootSessionId !== cid))
              ) {
                continue;
              }
            }
            const txPath = resolveStoreCandidateTranscriptPath(cid, {
              transcriptPath: typeof leaseObj?.transcriptPath === "string" ? leaseObj.transcriptPath : "",
              allowDefaultDb: allowDefaultSummaryDb
            });
            if ((allowDefaultSummaryDb || txPath) && summaryReader) {
              const summary = summaryReader.lookup(cid, { transcriptPath: txPath });
              if (summary.isSubagent) continue;
            }
            if (txPath && inspectTranscriptGenesisFileForSubagent(txPath)) continue;
            return true;
          } catch {}
        }
      } finally {
        summaryReader?.close();
      }
    } catch {}
    return false;
  }

  /** Resolve max auto-keepalive activations for a conversation before a fresh user message (1..20, fallback to last non-zero when global is 0) */
  getTtlKeepaliveMaxCount(conversationId = null) {
    const snap = getConfigSnapshot();
    const clampMax = (v) => Math.min(20, Math.max(1, Math.floor(Number(v) || 1)));
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (cleanId) {
      const st = this.getTtlKeepaliveState(cleanId);
      if (typeof st.maxCount === "number" && Number.isFinite(st.maxCount) && st.maxCount >= 1) {
        return clampMax(st.maxCount);
      }
    }
    if (snap.sources.ttlKeepaliveMaxCount === "env") {
      const envVal = Number(snap.values.ttlKeepaliveMaxCount);
      return envVal >= 1 ? clampMax(envVal) : this.getFallbackNonZeroKeepaliveMaxCount();
    }
    const globalMax = this.getGlobalTtlKeepaliveMaxCount();
    if (globalMax >= 1) {
      return clampMax(globalMax);
    }
    return this.getFallbackNonZeroKeepaliveMaxCount();
  }

  /** Persist per-conversation max auto-keepalive count (1..20) in SQLite meta */
  setTtlKeepaliveMaxCount(maxCount, conversationId = null) {
    const clamped = Math.min(20, Math.max(1, Math.floor(Number(maxCount) || 1)));
    const targetId = this._sanitizeKeepaliveConvId(conversationId) || "__unbound__";
    const cur = this.getTtlKeepaliveState(targetId);
    const shouldAutoEnable = cur.enabled === null && this.getGlobalTtlKeepaliveMaxCount() === 0;
    this.setTtlKeepaliveState(targetId, {
      ...(shouldAutoEnable ? { enabled: true } : {}),
      maxCount: clamped
    });
    return clamped;
  }

  /** True iff a conversation (or __unbound__ tab) has an explicit per-window enabled, maxCount, or intervalSec override */
  hasCustomTtlKeepaliveOverride(conversationId) {
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (!cleanId) return false;
    const st = this.getTtlKeepaliveState(cleanId);
    return st.enabled !== null || st.maxCount !== null || st.intervalSec !== null;
  }

  /** Clear per-conversation enabled/maxCount/intervalSec override so the window follows global again while preserving usedCount */
  clearTtlKeepaliveOverride(conversationId, nowMs = Date.now()) {
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (!cleanId) return null;
    this.open();
    const metaKey = `cache:ttl_keepalive_state:${cleanId}`;
    if (cleanId === "__unbound__") {
      this.deleteMeta(metaKey);
      return this.getTtlKeepaliveState(cleanId, nowMs);
    }
    const cur = this.getTtlKeepaliveState(cleanId, nowMs);
    if (
      cur.usedCount === 0 &&
      !cur.lastIdleAnchorTs &&
      !cur.lastSentTs &&
      !cur.lastAttemptTs &&
      !cur.pendingAck &&
      !cur.coldMissTripped &&
      !cur.inKeepaliveTurn &&
      !cur.lastDispatchId &&
      !cur.pendingColdCheckId &&
      !cur.lastError
    ) {
      this.deleteMeta(metaKey);
      return this.getTtlKeepaliveState(cleanId, nowMs);
    }
    return this.setTtlKeepaliveState(cleanId, {
      enabled: null,
      maxCount: null,
      intervalSec: null,
      updatedTs: nowMs
    });
  }

  _sanitizeKeepaliveConvId(conversationId) {
    if (typeof conversationId !== "string") return "";
    const trimmed = conversationId.trim();
    if (!trimmed || trimmed.length > 128) return "";
    if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return "";
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return "";
    const lower = trimmed.toLowerCase();
    if (lower === "default" || lower === "all" || lower === "lifetime" || lower === "app") return "";
    return trimmed;
  }

  /** Read per-conversation TTL auto-keepalive activation & toggle state */
  getTtlKeepaliveState(conversationId, nowMs = Date.now()) {
    const empty = {
      enabled: null,
      maxCount: null,
      intervalSec: null,
      usedCount: 0,
      lastIdleAnchorTs: 0,
      lastSentTs: 0,
      lastAttemptTs: 0,
      pendingAck: false,
      coldMissTripped: false,
      inKeepaliveTurn: false,
      lastColdCheckUsed: 0,
      lastDispatchId: "",
      lastDispatchMode: "",
      pendingColdCheckId: "",
      lastColdCheckedId: "",
      lastError: "",
      updatedTs: 0
    };
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (!cleanId) return empty;
    this.open();
    const metaKey = `cache:ttl_keepalive_state:${cleanId}`;
    const raw = this.getMeta(metaKey, null);
    if (!raw || typeof raw !== "string") return empty;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return empty;
      const updatedTs =
        Number.isFinite(Number(parsed.updatedTs)) && Number(parsed.updatedTs) > 0
          ? Math.floor(Number(parsed.updatedTs))
          : 0;
      if (cleanId === "__unbound__") {
        const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        if (updatedTs <= 0 || safeNow - updatedTs > 30 * 60 * 1000) {
          try {
            this.deleteMeta(metaKey);
          } catch {}
          return empty;
        }
      }
      const rawMax = parsed.maxCount;
      const validMax =
        rawMax !== null &&
        rawMax !== undefined &&
        rawMax !== "" &&
        typeof rawMax !== "boolean" &&
        Number.isFinite(Number(rawMax)) &&
        Number(rawMax) >= 1
          ? Math.min(20, Math.max(1, Math.floor(Number(rawMax))))
          : null;
      const validInterval =
        parsed.intervalSec !== undefined && parsed.intervalSec !== null
          ? this._normalizeKeepaliveIntervalSec(parsed.intervalSec)
          : null;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : null,
        maxCount: validMax,
        intervalSec: validInterval,
        usedCount: Number.isFinite(Number(parsed.usedCount)) && Number(parsed.usedCount) >= 0 ? Math.floor(Number(parsed.usedCount)) : 0,
        lastIdleAnchorTs: Number.isFinite(Number(parsed.lastIdleAnchorTs)) && Number(parsed.lastIdleAnchorTs) > 0 ? Math.floor(Number(parsed.lastIdleAnchorTs)) : 0,
        lastSentTs: Number.isFinite(Number(parsed.lastSentTs)) && Number(parsed.lastSentTs) > 0 ? Math.floor(Number(parsed.lastSentTs)) : 0,
        lastAttemptTs: Number.isFinite(Number(parsed.lastAttemptTs)) && Number(parsed.lastAttemptTs) > 0 ? Math.floor(Number(parsed.lastAttemptTs)) : 0,
        pendingAck: Boolean(parsed.pendingAck),
        coldMissTripped: Boolean(parsed.coldMissTripped),
        inKeepaliveTurn: Boolean(parsed.inKeepaliveTurn),
        lastColdCheckUsed:
          Number.isFinite(Number(parsed.lastColdCheckUsed)) && Number(parsed.lastColdCheckUsed) >= 0
            ? Math.floor(Number(parsed.lastColdCheckUsed))
            : 0,
        lastDispatchId:
          typeof parsed.lastDispatchId === "string" ? parsed.lastDispatchId.trim().slice(0, 64) : "",
        lastDispatchMode:
          parsed.lastDispatchMode === "auto" || parsed.lastDispatchMode === "manual"
            ? parsed.lastDispatchMode
            : "",
        pendingColdCheckId:
          typeof parsed.pendingColdCheckId === "string" ? parsed.pendingColdCheckId.trim().slice(0, 64) : "",
        lastColdCheckedId:
          typeof parsed.lastColdCheckedId === "string" ? parsed.lastColdCheckedId.trim().slice(0, 64) : "",
        lastError: typeof parsed.lastError === "string" ? parsed.lastError.slice(0, 180) : "",
        updatedTs
      };
    } catch {
      return empty;
    }
  }

  /**
   * Atomically migrate a fresh empty-tab (`__unbound__`) keepalive preference onto a genuinely
   * brand-new conversation's Turn 0, clearing `__unbound__` so other tabs stay isolated.
   */
  claimPendingUnboundTtlKeepalive(conversationId, { nowMs = Date.now(), maxAgeMs = 30 * 60 * 1000 } = {}) {
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (!cleanId || cleanId === "__unbound__") return null;
    this.open();
    const safeNow = Number.isFinite(Number(nowMs)) ? Math.floor(Number(nowMs)) : Date.now();
    const ttlMs = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 30 * 60 * 1000;
    try {
      return this._withWriteTx(() => {
        const unboundRow = this.db
          .prepare("SELECT value FROM meta WHERE key = 'cache:ttl_keepalive_state:__unbound__'")
          .get();
        if (!unboundRow || typeof unboundRow.value !== "string") return null;

        let parsed = null;
        try {
          parsed = JSON.parse(unboundRow.value);
        } catch {
          parsed = null;
        }
        const updatedTs =
          parsed && Number.isFinite(Number(parsed.updatedTs)) && Number(parsed.updatedTs) > 0
            ? Math.floor(Number(parsed.updatedTs))
            : 0;
        const rawMax = parsed?.maxCount;
        const validMax =
          rawMax !== null &&
          rawMax !== undefined &&
          rawMax !== "" &&
          typeof rawMax !== "boolean" &&
          Number.isFinite(Number(rawMax)) &&
          Number(rawMax) >= 1
            ? Math.min(20, Math.max(1, Math.floor(Number(rawMax))))
            : null;
        const validEnabled = typeof parsed?.enabled === "boolean" ? parsed.enabled : null;
        const validInterval =
          parsed?.intervalSec !== undefined && parsed?.intervalSec !== null
            ? this._normalizeKeepaliveIntervalSec(parsed.intervalSec)
            : null;
        if (
          !parsed ||
          updatedTs <= 0 ||
          safeNow - updatedTs > ttlMs ||
          (validEnabled === null && validMax === null && validInterval === null)
        ) {
          this.db.prepare("DELETE FROM meta WHERE key = 'cache:ttl_keepalive_state:__unbound__'").run();
          return null;
        }

        const existingMeta = this.db
          .prepare("SELECT 1 FROM meta WHERE key IN (?, ?) LIMIT 1")
          .get(`cache:ttl_keepalive_state:${cleanId}`, `watchdog_lease:${cleanId}`);
        if (existingMeta) return null;

        const priorActivity = this.db
          .prepare(
            "SELECT 1 FROM events WHERE session_id = ? UNION ALL SELECT 1 FROM sources WHERE session_id = ? UNION ALL SELECT 1 FROM session_checkpoints WHERE session_id = ? LIMIT 1"
          )
          .get(cleanId, cleanId, cleanId);
        if (priorActivity) return null;

        const migrated = {
          enabled: validEnabled,
          maxCount: validMax,
          intervalSec: validInterval,
          usedCount: 0,
          lastIdleAnchorTs: 0,
          lastSentTs: 0,
          lastAttemptTs: 0,
          pendingAck: false,
          coldMissTripped: false,
          inKeepaliveTurn: false,
          lastColdCheckUsed: 0,
          lastDispatchId: "",
          lastDispatchMode: "",
          pendingColdCheckId: "",
          lastColdCheckedId: "",
          lastError: "",
          updatedTs: safeNow
        };
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          )
          .run(`cache:ttl_keepalive_state:${cleanId}`, JSON.stringify(migrated));
        this.db.prepare("DELETE FROM meta WHERE key = 'cache:ttl_keepalive_state:__unbound__'").run();
        return migrated;
      });
    } catch {
      return null;
    }
  }

  /** Merge & persist per-conversation TTL auto-keepalive state */
  setTtlKeepaliveState(conversationId, patch = {}) {
    const cleanId = this._sanitizeKeepaliveConvId(conversationId);
    if (!cleanId) return null;
    this.open();
    const cur = this.getTtlKeepaliveState(cleanId);
    const safePatch = patch && typeof patch === "object" ? patch : {};
    const nextEnabled =
      safePatch.enabled === null
        ? null
        : safePatch.enabled !== undefined
          ? Boolean(safePatch.enabled && safePatch.enabled !== "false" && safePatch.enabled !== "0")
          : cur.enabled;
    const nextMaxCount =
      safePatch.maxCount === null
        ? null
        : safePatch.maxCount !== undefined
          ? Math.min(20, Math.max(1, Math.floor(Number(safePatch.maxCount) || 1)))
          : cur.maxCount;
    const nextIntervalSec =
      safePatch.intervalSec === null
        ? null
        : safePatch.intervalSec !== undefined
          ? (this._normalizeKeepaliveIntervalSec(safePatch.intervalSec) ?? cur.intervalSec)
          : cur.intervalSec;
    const next = {
      enabled: nextEnabled,
      maxCount: nextMaxCount,
      intervalSec: nextIntervalSec,
      usedCount:
        safePatch.usedCount !== undefined
          ? Math.max(0, Math.floor(Number(safePatch.usedCount) || 0))
          : cur.usedCount,
      lastIdleAnchorTs:
        safePatch.lastIdleAnchorTs !== undefined
          ? Math.max(0, Math.floor(Number(safePatch.lastIdleAnchorTs) || 0))
          : cur.lastIdleAnchorTs,
      lastSentTs:
        safePatch.lastSentTs !== undefined
          ? Math.max(0, Math.floor(Number(safePatch.lastSentTs) || 0))
          : cur.lastSentTs,
      lastAttemptTs:
        safePatch.lastAttemptTs !== undefined
          ? Math.max(0, Math.floor(Number(safePatch.lastAttemptTs) || 0))
          : cur.lastAttemptTs,
      pendingAck: safePatch.pendingAck !== undefined ? Boolean(safePatch.pendingAck) : cur.pendingAck,
      coldMissTripped:
        safePatch.coldMissTripped !== undefined ? Boolean(safePatch.coldMissTripped) : cur.coldMissTripped,
      inKeepaliveTurn:
        safePatch.inKeepaliveTurn !== undefined ? Boolean(safePatch.inKeepaliveTurn) : cur.inKeepaliveTurn,
      lastColdCheckUsed:
        safePatch.lastColdCheckUsed !== undefined
          ? Math.max(0, Math.floor(Number(safePatch.lastColdCheckUsed) || 0))
          : cur.lastColdCheckUsed,
      lastDispatchId:
        safePatch.lastDispatchId !== undefined
          ? String(safePatch.lastDispatchId || "").trim().slice(0, 64)
          : cur.lastDispatchId,
      lastDispatchMode:
        safePatch.lastDispatchMode !== undefined
          ? safePatch.lastDispatchMode === "auto" || safePatch.lastDispatchMode === "manual"
            ? safePatch.lastDispatchMode
            : ""
          : cur.lastDispatchMode,
      pendingColdCheckId:
        safePatch.pendingColdCheckId !== undefined
          ? String(safePatch.pendingColdCheckId || "").trim().slice(0, 64)
          : cur.pendingColdCheckId,
      lastColdCheckedId:
        safePatch.lastColdCheckedId !== undefined
          ? String(safePatch.lastColdCheckedId || "").trim().slice(0, 64)
          : cur.lastColdCheckedId,
      lastError:
        safePatch.lastError !== undefined ? String(safePatch.lastError || "").slice(0, 180) : cur.lastError,
      updatedTs:
        safePatch.updatedTs !== undefined && Number.isFinite(Number(safePatch.updatedTs))
          ? Math.floor(Number(safePatch.updatedTs))
          : Date.now()
    };
    this.setMeta(`cache:ttl_keepalive_state:${cleanId}`, JSON.stringify(next));
    return next;
  }

  /** Reset per-conversation TTL auto-keepalive counter & cold-miss breaker back to 0 */
  resetTtlKeepaliveState(conversationId, nowMs = Date.now()) {
    return this.setTtlKeepaliveState(conversationId, {
      usedCount: 0,
      lastIdleAnchorTs: 0,
      lastSentTs: 0,
      lastAttemptTs: 0,
      pendingAck: false,
      coldMissTripped: false,
      inKeepaliveTurn: false,
      lastColdCheckUsed: 0,
      lastDispatchId: "",
      lastDispatchMode: "",
      pendingColdCheckId: "",
      lastColdCheckedId: "",
      lastError: "",
      updatedTs: nowMs
    });
  }

  /** Resolve UI/alert language ('zh' | 'en') and provenance ('env' | 'sqlite' | 'config' | 'default') */
  getUiLangInfo() {
    const snap = getConfigSnapshot();
    if (snap.sources.uiLang === "env") {
      return { lang: snap.values.uiLang, source: "env" };
    }
    this.open();
    const raw = this.getMeta("ui:lang", null);
    const parsed = parseUiLang(raw);
    if (parsed) {
      return { lang: parsed, source: "sqlite" };
    }
    if (snap.sources.uiLang === "config") {
      return { lang: snap.values.uiLang, source: "config" };
    }
    return { lang: snap.values.uiLang || "en", source: "default" };
  }

  /** Read effective UI/alert language ('zh' | 'en') */
  getUiLang() {
    return this.getUiLangInfo().lang;
  }

  /** Persist UI/alert language ('zh' | 'en') in SQLite meta */
  setUiLang(lang) {
    const normalized = parseUiLang(lang) || "en";
    this.open();
    this.setMeta("ui:lang", normalized);
    return normalized;
  }

  /** Read cross-session empirical TTL calibration ring buffer for a single model profile */
  getModelTtlCalibration(profileId, nowMs = Date.now()) {
    if (typeof profileId !== "string") return null;
    const cleanId = profileId.trim();
    if (!cleanId || cleanId.length > 64 || !/^[A-Za-z0-9._-]+$/.test(cleanId)) return null;
    this.open();
    const raw = this.getMeta(`ttl_calibration:v1:${cleanId}`, null);
    if (!raw || typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const maxAgeMs = 14 * 24 * 3600 * 1000;
      const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      const updatedTs = Number.isFinite(parsed.updatedTs) ? Math.floor(parsed.updatedTs) : 0;
      if (updatedTs > 0 && safeNow - updatedTs > maxAgeMs) return null;
      const filterSamples = (arr, minSec) => {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const item of arr) {
          if (!item || typeof item !== "object") continue;
          const gapSec = Number(item.gapSec);
          const atMs = Number.isFinite(item.atMs) ? Math.floor(item.atMs) : 0;
          if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > 14400) continue;
          if (atMs > 0 && safeNow - atMs > maxAgeMs) continue;
          out.push({
            gapSec: Math.round(gapSec),
            atMs,
            conv: typeof item.conv === "string" ? item.conv.slice(0, 96) : ""
          });
        }
        return out.slice(-20);
      };
      const coldFloorSec = resolveProfileColdFloorSec(cleanId);
      return {
        v: 1,
        profileId: cleanId,
        warm: filterSamples(parsed.warm, 180),
        cold: filterSamples(parsed.cold, coldFloorSec),
        seen1hWrite: Boolean(parsed.seen1hWrite),
        updatedTs
      };
    } catch {
      return null;
    }
  }

  /** Read all fresh (<=14d) cross-session empirical TTL calibration records keyed by profileId */
  getAllModelTtlCalibrations(nowMs = Date.now()) {
    this.open();
    const out = {};
    try {
      const rows = this.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'ttl_calibration:v1:%' ORDER BY key ASC")
        .all();
      const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      const maxAgeMs = 14 * 24 * 3600 * 1000;
      for (const row of rows || []) {
        if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
        const pid = row.key.slice("ttl_calibration:v1:".length).trim();
        if (!pid || pid.length > 64 || !/^[A-Za-z0-9._-]+$/.test(pid)) continue;
        try {
          const parsed = JSON.parse(row.value);
          if (!parsed || typeof parsed !== "object") continue;
          const updatedTs = Number.isFinite(parsed.updatedTs) ? Math.floor(parsed.updatedTs) : 0;
          if (updatedTs > 0 && safeNow - updatedTs > maxAgeMs) continue;
          const filterSamples = (arr, minSec) => {
            if (!Array.isArray(arr)) return [];
            const list = [];
            for (const item of arr) {
              if (!item || typeof item !== "object") continue;
              const gapSec = Number(item.gapSec);
              const atMs = Number.isFinite(item.atMs) ? Math.floor(item.atMs) : 0;
              if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > 14400) continue;
              if (atMs > 0 && safeNow - atMs > maxAgeMs) continue;
              list.push({
                gapSec: Math.round(gapSec),
                atMs,
                conv: typeof item.conv === "string" ? item.conv.slice(0, 96) : ""
              });
            }
            return list.slice(-20);
          };
          const coldFloorSec = resolveProfileColdFloorSec(pid);
          const warm = filterSamples(parsed.warm, 180);
          const cold = filterSamples(parsed.cold, coldFloorSec);
          const seen1hWrite = Boolean(parsed.seen1hWrite);
          if (warm.length > 0 || cold.length > 0 || seen1hWrite) {
            out[pid] = {
              v: 1,
              profileId: pid,
              warm,
              cold,
              seen1hWrite,
              updatedTs
            };
          }
        } catch {}
      }
    } catch {}
    return out;
  }

  /** Append deduplicated warm/cold TTL observations into bounded (<=20 each) SQLite meta ring buffers */
  recordModelTtlObservations(observations, convId = "", nowMs = Date.now()) {
    if (!observations || typeof observations !== "object") return { updatedProfiles: 0 };
    this.open();
    const safeNow = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const safeConv =
      typeof convId === "string" ? convId.trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 96) : "";
    const maxAgeMs = 14 * 24 * 3600 * 1000;
    let updatedProfiles = 0;

    for (const [rawPid, obs] of Object.entries(observations)) {
      if (!obs || typeof obs !== "object") continue;
      const pid = String(obs.profileId || rawPid || "").trim();
      if (!pid || pid.length > 64 || !/^[A-Za-z0-9._-]+$/.test(pid)) continue;

      const existing = this.getModelTtlCalibration(pid, safeNow) || {
        v: 1,
        profileId: pid,
        warm: [],
        cold: [],
        seen1hWrite: false,
        updatedTs: 0
      };

      const mergeRing = (prevList, incomingList, minSec) => {
        const merged = [];
        const seen = new Set();
        let addedNew = false;
        for (const item of prevList) {
          if (item.atMs > 0 && safeNow - item.atMs > maxAgeMs) continue;
          const k = `${item.conv || ""}:${item.atMs}:${item.gapSec}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(item);
        }
        for (const rawItem of Array.isArray(incomingList) ? incomingList : []) {
          if (!rawItem || typeof rawItem !== "object") continue;
          const gapSec = Number(rawItem.gapSec);
          if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > 14400) continue;
          const roundedGap = Math.round(gapSec);
          const atMs = Number.isFinite(rawItem.atMs) && rawItem.atMs > 0 ? Math.floor(rawItem.atMs) : safeNow;
          if (safeNow - atMs > maxAgeMs) continue;
          const itemConv =
            typeof rawItem.conv === "string" && rawItem.conv.trim()
              ? rawItem.conv.trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 96)
              : safeConv;
          const k = `${itemConv}:${atMs}:${roundedGap}`;
          if (seen.has(k)) continue;
          seen.add(k);
          addedNew = true;
          merged.push({ gapSec: roundedGap, atMs, conv: itemConv });
        }
        merged.sort((a, b) => a.atMs - b.atMs);
        return { list: merged.slice(-20), addedNew };
      };

      const coldFloorSec = resolveProfileColdFloorSec(pid);
      let hadLegacySubFloorCold = false;
      try {
        const rawStored = this.getMeta(`ttl_calibration:v1:${pid}`, null);
        if (rawStored) {
          const parsedRaw = JSON.parse(rawStored);
          if (Array.isArray(parsedRaw?.cold)) {
            hadLegacySubFloorCold = parsedRaw.cold.some(
              (c) => c && Number.isFinite(Number(c.gapSec)) && Number(c.gapSec) < coldFloorSec
            );
          }
        }
      } catch {}

      const warmRes = mergeRing(existing.warm, obs.warm, 180);
      const coldRes = mergeRing(existing.cold, obs.cold, coldFloorSec);
      const next1h = Boolean(existing.seen1hWrite || obs.seen1hWrite);
      const changed =
        warmRes.addedNew || coldRes.addedNew || next1h !== existing.seen1hWrite || hadLegacySubFloorCold;
      if (!changed) continue;

      const record = {
        v: 1,
        profileId: pid,
        warm: warmRes.list,
        cold: coldRes.list,
        seen1hWrite: next1h,
        updatedTs: safeNow
      };
      this.setMeta(`ttl_calibration:v1:${pid}`, JSON.stringify(record));
      updatedProfiles += 1;
    }

    return { updatedProfiles };
  }

  /** Scrub legacy sub-baseline (< profile.ttlSec) cold noise, empirical leases, mislabeled subagent leases & obsolete global keepalive keys in SQLite meta */
  sanitizeModelTtlState() {
    this.open();
    let scrubbedCalibrations = 0;
    let clampedLeases = 0;
    let healedSubagentLeases = 0;
    let removedLegacyGlobalKeepalive = 0;
    try {
      const allowDefaultSummaryDb = Boolean(
        (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) ||
          (typeof this.dbPath === "string" &&
            isSameStorePath(this.dbPath, path.join(os.homedir(), ".agy-dart", "context.db")))
      );
      const DatabaseSyncCtor = this.db?.constructor || null;
      const summaryReader = DatabaseSyncCtor
        ? createSummaryDbReader(DatabaseSyncCtor, { allowDefaultDb: allowDefaultSummaryDb })
        : null;
      const subagentRepairMap = new Map();
      const orphanSubagentKeepaliveIds = new Set();
      try {
        const preScanRows = this.db
          .prepare("SELECT key, value FROM meta WHERE key LIKE 'watchdog_lease:%'")
          .all();
        for (const row of preScanRows || []) {
          if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
          const cid = this._sanitizeKeepaliveConvId(row.key.slice("watchdog_lease:".length));
          if (!cid || cid === "__unbound__") continue;
          try {
            const lease = JSON.parse(row.value);
            if (!lease || typeof lease !== "object") continue;
            if (lease.isSubagent === true) {
              subagentRepairMap.set(cid, { markSubagent: false, scrubKeepalive: true, parentId: "" });
              continue;
            }
            const inlineSub = Boolean(
              (lease.parentConversationId && lease.parentConversationId !== cid) ||
                (lease.rootSessionId && lease.rootSessionId !== cid) ||
                (typeof lease.lastUserInput === "string" && STORE_HEADLESS_FINISH_RE.test(lease.lastUserInput))
            );
            if (inlineSub) {
              subagentRepairMap.set(cid, {
                markSubagent: true,
                scrubKeepalive: true,
                parentId: lease.parentConversationId || ""
              });
              continue;
            }
            if (summaryReader?.isBudgetExhausted()) continue;
            let detectedSub = false;
            let detectedKilled = false;
            let foundParent = "";
            const txPath = resolveStoreCandidateTranscriptPath(cid, {
              transcriptPath: typeof lease.transcriptPath === "string" ? lease.transcriptPath : "",
              allowDefaultDb: allowDefaultSummaryDb
            });
            if ((allowDefaultSummaryDb || txPath) && summaryReader) {
              const summary = summaryReader.lookup(cid, { transcriptPath: txPath });
              if (summary.isSubagent) detectedSub = true;
              if (summary.killed) detectedKilled = true;
              if (summary.parentId && summary.parentId !== cid) {
                foundParent = summary.parentId;
              }
            }
            if (!detectedSub && txPath && inspectTranscriptGenesisFileForSubagent(txPath)) {
              detectedSub = true;
            }
            if (detectedSub || detectedKilled) {
              subagentRepairMap.set(cid, {
                markSubagent: detectedSub,
                markKilled: detectedKilled,
                scrubKeepalive: true,
                parentId: foundParent
              });
            }
          } catch {}
        }

        const kaPreRows = this.db
          .prepare("SELECT key FROM meta WHERE key LIKE 'cache:ttl_keepalive_state:%'")
          .all();
        for (const row of kaPreRows || []) {
          if (!row || typeof row.key !== "string" || row.key.endsWith(":__unbound__")) continue;
          const cid = this._sanitizeKeepaliveConvId(row.key.slice("cache:ttl_keepalive_state:".length));
          if (!cid || subagentRepairMap.has(cid)) continue;
          if (summaryReader?.isBudgetExhausted()) break;
          try {
            const txPath = resolveStoreCandidateTranscriptPath(cid, { allowDefaultDb: allowDefaultSummaryDb });
            let detectedSub = false;
            let detectedKilled = false;
            if ((allowDefaultSummaryDb || txPath) && summaryReader) {
              const summary = summaryReader.lookup(cid, { transcriptPath: txPath });
              if (summary.isSubagent) detectedSub = true;
              if (summary.killed) detectedKilled = true;
            }
            if (!detectedSub && txPath && inspectTranscriptGenesisFileForSubagent(txPath)) {
              detectedSub = true;
            }
            if (detectedSub || detectedKilled) {
              orphanSubagentKeepaliveIds.add(cid);
            }
          } catch {}
        }
      } finally {
        summaryReader?.close();
      }

      this._withWriteTx(() => {
        const legacyRes = this.db
          .prepare("DELETE FROM meta WHERE key IN ('cache:ttl_keepalive_enabled', 'cache:ttl_keepalive_max_count')")
          .run();
        removedLegacyGlobalKeepalive = Number(legacyRes?.changes || 0);

        const calRows = this.db
          .prepare("SELECT key, value FROM meta WHERE key LIKE 'ttl_calibration:v1:%'")
          .all();
        const upsertStmt = this.db.prepare(
          "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        );
        const delKeyStmt = this.db.prepare("DELETE FROM meta WHERE key = ?");
        for (const orphanCid of orphanSubagentKeepaliveIds) {
          delKeyStmt.run(`cache:ttl_keepalive_state:${orphanCid}`);
        }
        for (const row of calRows || []) {
          if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
          const pid = row.key.slice("ttl_calibration:v1:".length).trim();
          const floorSec = resolveProfileColdFloorSec(pid);
          try {
            const parsed = JSON.parse(row.value);
            if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cold)) continue;
            const filteredCold = parsed.cold.filter(
              (c) => c && Number.isFinite(Number(c.gapSec)) && Number(c.gapSec) >= floorSec
            );
            if (filteredCold.length !== parsed.cold.length) {
              parsed.cold = filteredCold;
              upsertStmt.run(row.key, JSON.stringify(parsed));
              scrubbedCalibrations += 1;
            }
          } catch {}
        }

        const leaseRows = this.db
          .prepare("SELECT key, value FROM meta WHERE key LIKE 'watchdog_lease:%'")
          .all();
        for (const row of leaseRows || []) {
          if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
          const cid = this._sanitizeKeepaliveConvId(row.key.slice("watchdog_lease:".length));
          try {
            const lease = JSON.parse(row.value);
            if (!lease || typeof lease !== "object") continue;
            let mutated = false;
            if (lease.ttlSource === "empirical") {
              const modelStr = typeof lease.model === "string" ? lease.model : "";
              const floorSec = resolveModelColdFloorSec(modelStr);
              if (
                Number.isFinite(Number(lease.cacheTtlSec)) &&
                Number(lease.cacheTtlSec) > 0 &&
                Number(lease.cacheTtlSec) < floorSec
              ) {
                lease.cacheTtlSec = floorSec;
                clampedLeases += 1;
                mutated = true;
              }
            }
            const repair = cid ? subagentRepairMap.get(cid) : null;
            if (repair) {
              if (repair.markSubagent && !lease.isSubagent) {
                lease.isSubagent = true;
                if (repair.parentId && !lease.parentConversationId) {
                  lease.parentConversationId = repair.parentId;
                  if (!lease.rootSessionId || lease.rootSessionId === cid) {
                    lease.rootSessionId = repair.parentId;
                  }
                }
                healedSubagentLeases += 1;
                mutated = true;
              }
              if (repair.markKilled && lease.phase === "IDLE" && lease.stopReason !== "USER_CANCELED") {
                lease.stopReason = "USER_CANCELED";
                mutated = true;
              }
              if (repair.scrubKeepalive && cid) {
                delKeyStmt.run(`cache:ttl_keepalive_state:${cid}`);
              }
            }
            if (mutated) {
              upsertStmt.run(row.key, JSON.stringify(lease));
            }
          } catch {}
        }
      });
    } catch {}
    return { scrubbedCalibrations, clampedLeases, healedSubagentLeases, removedLegacyGlobalKeepalive };
  }

  /** Read normalized one-time GitHub Star milestone prompt state from SQLite meta */
  getStarPromptState() {
    this.open();
    return normalizeStarPromptState(this.getMeta(STAR_PROMPT_META_KEY, null));
  }

  /** Count distinct non-sentinel sessions across recorded events and sources */
  getDistinctSessionCount() {
    this.open();
    const row = this.db
      .prepare(`
        SELECT COUNT(DISTINCT sid) AS cnt FROM (
          SELECT session_id AS sid FROM events
          WHERE session_id IS NOT NULL AND TRIM(session_id) != ''
            AND session_id NOT IN ('all', 'lifetime', 'app')
            AND COALESCE(key, '') != 'dedup_bypass'
          UNION
          SELECT session_id AS sid FROM sources
          WHERE session_id IS NOT NULL AND TRIM(session_id) != ''
            AND session_id NOT IN ('all', 'lifetime', 'app')
        )
      `)
      .get();
    const cnt = Number(row?.cnt || 0);
    return Number.isFinite(cnt) && cnt >= 0 ? Math.floor(cnt) : 0;
  }

  /** Record a passing cache:audit run in SQLite meta */
  recordCacheAuditPassed(atIso = new Date().toISOString()) {
    this.open();
    this.setMeta(CACHE_AUDIT_PASSED_META_KEY, String(atIso));
  }

  /** Check whether cache:audit has passed at least once */
  hasCacheAuditPassed() {
    this.open();
    return Boolean(this.getMeta(CACHE_AUDIT_PASSED_META_KEY, null));
  }

  /** Evaluate whether the one-time GitHub Star milestone banner should be shown */
  evaluateStarPrompt({ markTriggered = false, nowIso = null } = {}) {
    this.open();
    const current = this.getStarPromptState();
    if (current.state !== "pending") {
      const savedBytes = Math.max(0, Math.floor(Number(current.milestoneSavedBytes || 0)));
      return {
        state: current.state,
        triggeredAt: current.triggeredAt,
        resolvedAt: current.resolvedAt,
        milestoneSavedBytes: savedBytes,
        shouldShow: false,
        triggerReason: null,
        lifetimeSavedBytes: savedBytes,
        lifetimeTokensSaved: Math.round(savedBytes / 4),
        sessionCount: 0,
        cacheAuditPassed: this.hasCacheAuditPassed(),
        thresholds: {
          minSavedBytes: STAR_PROMPT_MIN_SAVED_BYTES,
          minSessions: STAR_PROMPT_MIN_SESSIONS
        }
      };
    }
    const lifetimeStats = this.getStats("all");
    const lifetimeSavedBytes = Math.max(0, Math.floor(Number(lifetimeStats?.keptOutBytes || 0)));
    const lifetimeTokensSaved = Math.max(
      0,
      Math.floor(Number(lifetimeStats?.tokensKeptOut ?? Math.round(lifetimeSavedBytes / 4)))
    );
    const sessionCount = this.getDistinctSessionCount();
    const cacheAuditPassed = this.hasCacheAuditPassed();
    const savingsMilestoneMet =
      lifetimeSavedBytes >= STAR_PROMPT_MIN_SAVED_BYTES && sessionCount >= STAR_PROMPT_MIN_SESSIONS;
    const milestoneReached = savingsMilestoneMet || cacheAuditPassed;
    const triggerReason = savingsMilestoneMet
      ? "savings_milestone"
      : (cacheAuditPassed ? "cache_audit" : null);
    const shouldShow = current.state === "pending" && milestoneReached;

    let effective = current;
    if (shouldShow && markTriggered && !current.triggeredAt) {
      const next = {
        state: "pending",
        triggeredAt:
          typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString(),
        resolvedAt: null,
        milestoneSavedBytes: Math.max(current.milestoneSavedBytes, lifetimeSavedBytes)
      };
      this.setMeta(STAR_PROMPT_META_KEY, JSON.stringify(next));
      effective = next;
    }

    return {
      state: effective.state,
      triggeredAt: effective.triggeredAt,
      resolvedAt: effective.resolvedAt,
      milestoneSavedBytes: effective.milestoneSavedBytes,
      shouldShow,
      triggerReason,
      lifetimeSavedBytes,
      lifetimeTokensSaved,
      sessionCount,
      cacheAuditPassed,
      thresholds: {
        minSavedBytes: STAR_PROMPT_MIN_SAVED_BYTES,
        minSessions: STAR_PROMPT_MIN_SESSIONS
      }
    };
  }

  /** Persist a terminal starPrompt state ('clicked' | 'dismissed' | 'copied_cli') permanently */
  setStarPromptState(nextState, { nowIso = null } = {}) {
    if (typeof nextState !== "string" || !STAR_PROMPT_TERMINAL_STATES.includes(nextState)) {
      return {
        ok: false,
        error: "Invalid 'state' value: expected 'clicked', 'dismissed', or 'copied_cli'"
      };
    }
    this.open();
    const current = this.getStarPromptState();
    if (current.state !== "pending") {
      return { ok: true, starPrompt: current, alreadyResolved: true };
    }
    const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
    const lifetimeStats = this.getStats("all");
    const lifetimeSavedBytes = Math.max(0, Math.floor(Number(lifetimeStats?.keptOutBytes || 0)));
    const saved = {
      state: nextState,
      triggeredAt: current.triggeredAt || ts,
      resolvedAt: ts,
      milestoneSavedBytes: Math.max(current.milestoneSavedBytes, lifetimeSavedBytes)
    };
    this.setMeta(STAR_PROMPT_META_KEY, JSON.stringify(saved));
    return { ok: true, starPrompt: saved, alreadyResolved: false };
  }

  /**
   * TTL-based database maintenance & optional VACUUM (inspired by antigravity-panel).
   * Keeps ~/.agy-dart/context.db lean across months of heavy usage.
   */
  pruneByTtl({ maxAgeDays = 14, vacuum = false } = {}) {
    this.open();
    const rawStr = maxAgeDays === null || maxAgeDays === undefined ? "" : String(maxAgeDays).trim();
    const parsedDays = rawStr === "" ? NaN : Number(rawStr);
    const days = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 14;
    const now = Date.now();
    const cutoffTs = now - days * 24 * 3600 * 1000;
    const cutoffIso = new Date(cutoffTs).toISOString();
    const readsCutoffTs = now - 24 * 3600 * 1000;
    const repoCacheCutoffTs = now - 30 * 24 * 3600 * 1000;

    const getDiskSize = () => {
      let total = 0;
      try { total += fs.statSync(this.dbPath).size; } catch {}
      try { total += fs.statSync(`${this.dbPath}-wal`).size; } catch {}
      return total;
    };

    this.sanitizeModelTtlState();
    const bytesBefore = getDiskSize();
    const txStats = this._withWriteTx(() => {
      const staleSources = this.db
        .prepare("SELECT id FROM sources WHERE accessed_ts < ?")
        .all(cutoffTs)
        .map((r) => r.id);

      // Batch deletes in groups of 400 to stay safely below SQLite's SQLITE_MAX_VARIABLE_NUMBER limit
      for (let i = 0; i < staleSources.length; i += 400) {
        const batch = staleSources.slice(i, i + 400);
        const placeholders = batch.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...batch);
      }

      const evRes = this.db.prepare("DELETE FROM events WHERE created_at < ?").run(cutoffIso);
      const readRes = this.db.prepare("DELETE FROM file_reads WHERE read_ts < ?").run(readsCutoffTs);
      const snapRes = this.db.prepare("DELETE FROM file_snapshots WHERE updated_ts < ?").run(readsCutoffTs);
      const ghostRes = this.db.prepare("DELETE FROM ghost_interceptions WHERE blocked_ts < ?").run(cutoffTs);
      const cpRes = this.db.prepare("DELETE FROM session_checkpoints WHERE updated_ts < ?").run(cutoffTs);
      const outlineRes = this.db.prepare("DELETE FROM outline_cache WHERE updated_ts < ?").run(cutoffTs);
      this.db.prepare("DELETE FROM repo_cache WHERE updated_ts < ?").run(repoCacheCutoffTs);

      // Prune stale per-session PreInvocation alert/compaction/sensitive-file/large-read-confirm/watchdog meta keys so meta stays bounded
      try {
        const confirmCutoffTs = now - 10 * 60 * 1000;
        const leaseCutoffTs = Math.min(cutoffTs, now - 24 * 3600 * 1000);
        const metaRows = this.db
          .prepare(
            "SELECT key, value FROM meta WHERE key LIKE 'cache_alert:%' OR key LIKE 'compact_invalidated:%' OR key LIKE 'sensitive_read_confirm:%' OR key LIKE 'large_read_confirm:%' OR key LIKE 'conv_turn_seq:%' OR key LIKE 'watchdog_lease:%' OR key LIKE 'session_workspace:%' OR key LIKE 'ttl_calibration:%' OR key LIKE 'cache:ttl_keepalive_state:%'"
          )
          .all();
        const delMetaStmt = this.db.prepare("DELETE FROM meta WHERE key = ?");
        const upsertMetaStmt = this.db.prepare(
          "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        );
        const unboundCutoffTs = now - 30 * 60 * 1000;
        for (const row of metaRows) {
          let entryTs = 0;
          let parsedObj = null;
          if (typeof row.value === "string" && row.value.startsWith("{")) {
            try {
              const p = JSON.parse(row.value);
              if (p && typeof p === "object") {
                parsedObj = p;
                if (Number.isFinite(p.updatedTs)) entryTs = p.updatedTs;
                else if (Number.isFinite(p.ts)) entryTs = p.ts;
              }
            } catch {}
          }
          const isShortConfirm =
            row.key.startsWith("large_read_confirm:") || row.key.startsWith("sensitive_read_confirm:");
          if (isShortConfirm) {
            if (entryTs <= 0 || entryTs < confirmCutoffTs) {
              delMetaStmt.run(row.key);
            }
          } else if (row.key === "cache:ttl_keepalive_state:__unbound__") {
            if (days === 0 || entryTs <= 0 || entryTs < unboundCutoffTs) {
              delMetaStmt.run(row.key);
            }
          } else if (row.key.startsWith("cache:ttl_keepalive_state:")) {
            if (!parsedObj) {
              delMetaStmt.run(row.key);
              continue;
            }
            const hasExplicitOverride =
              typeof parsedObj.enabled === "boolean" ||
              (typeof parsedObj.maxCount === "number" && Number.isFinite(parsedObj.maxCount) && parsedObj.maxCount >= 1);
            const isStaleKa = entryTs <= 0 || entryTs < (days === 0 ? cutoffTs : leaseCutoffTs);
            if (!hasExplicitOverride) {
              if (isStaleKa) {
                delMetaStmt.run(row.key);
              }
            } else if (
              isStaleKa &&
              (parsedObj.usedCount > 0 ||
                parsedObj.lastIdleAnchorTs > 0 ||
                parsedObj.lastSentTs > 0 ||
                parsedObj.lastAttemptTs > 0 ||
                parsedObj.pendingAck ||
                parsedObj.coldMissTripped ||
                parsedObj.inKeepaliveTurn ||
                parsedObj.lastDispatchId ||
                parsedObj.lastDispatchMode ||
                parsedObj.pendingColdCheckId ||
                parsedObj.lastColdCheckedId ||
                parsedObj.lastColdCheckUsed > 0 ||
                parsedObj.lastError)
            ) {
              upsertMetaStmt.run(
                row.key,
                JSON.stringify({
                  enabled: typeof parsedObj.enabled === "boolean" ? parsedObj.enabled : null,
                  maxCount:
                    typeof parsedObj.maxCount === "number" && Number.isFinite(parsedObj.maxCount) && parsedObj.maxCount >= 1
                      ? Math.min(20, Math.max(1, Math.floor(parsedObj.maxCount)))
                      : null,
                  usedCount: 0,
                  lastIdleAnchorTs: 0,
                  lastSentTs: 0,
                  lastAttemptTs: 0,
                  pendingAck: false,
                  coldMissTripped: false,
                  inKeepaliveTurn: false,
                  lastColdCheckUsed: 0,
                  lastDispatchId: "",
                  lastDispatchMode: "",
                  pendingColdCheckId: "",
                  lastColdCheckedId: "",
                  lastError: "",
                  updatedTs: entryTs > 0 ? entryTs : now
                })
              );
            }
          } else if (row.key.startsWith("watchdog_lease:") || row.key.startsWith("session_workspace:")) {
            if (entryTs <= 0 || entryTs < (days === 0 ? cutoffTs : leaseCutoffTs)) {
              delMetaStmt.run(row.key);
            }
          } else if (entryTs > 0 && entryTs < cutoffTs) {
            delMetaStmt.run(row.key);
          }
        }
      } catch {}

      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('last_maintenance_ts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(now));

      return {
        deletedSources: staleSources.length,
        deletedEvents: evRes.changes || 0,
        deletedFileReads: readRes.changes || 0,
        deletedFileSnapshots: snapRes.changes || 0,
        deletedGhostInterceptions: ghostRes.changes || 0,
        deletedCheckpoints: cpRes.changes || 0,
        deletedOutlineCache: outlineRes.changes || 0
      };
    });

    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {}

    let vacuumed = false;
    if (vacuum === "auto") {
      const autoRes = this.maybeAutoVacuum();
      vacuumed = Boolean(autoRes.vacuumed);
    } else if (vacuum) {
      try {
        this.db.exec("VACUUM;");
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        this.setMeta("last_vacuum_ts", String(Date.now()));
        vacuumed = true;
      } catch {}
    }

    const bytesAfter = getDiskSize();
    const storageHealth = this.getStorageHealth();

    return {
      ok: true,
      purged: "stale",
      maxAgeDays: days,
      ...txStats,
      bytesBefore,
      bytesAfter,
      reclaimedBytes: Math.max(0, bytesBefore - bytesAfter),
      vacuumed,
      storageHealth
    };
  }

  /** Lightweight daily auto-maintenance hook (at most once per 24h, fail-open) */
  maybeRunDailyMaintenance(maxAgeDays = 14) {
    try {
      this.open();
      const last = Number(this.getMeta("last_maintenance_ts", "0") || "0");
      if (Date.now() - last < 24 * 3600 * 1000) return null;
      return this.pruneByTtl({ maxAgeDays, vacuum: false });
    } catch {
      return null;
    }
  }

  /**
   * Automatic LRU pruning: limits the number of indexed sources and chunks
   * to avoid unbounded database expansion.
   */
  pruneStaleSources({ maxSourcesPerSession = 50, maxTotalSources = 200 } = {}) {
    this.open();
    try {
      const deleteSourceIds = (ids) => {
        if (!ids || ids.length === 0) return;
        this._withWriteTx(() => {
          for (let i = 0; i < ids.length; i += 400) {
            const batch = ids.slice(i, i + 400);
            const placeholders = batch.map(() => "?").join(",");
            this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
            this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
            this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...batch);
          }
        });
      };

      // 1. Prune sources exceeding per-session cap (LRU by accessed_ts)
      const excessSessionSources = this.db
        .prepare(`
          SELECT id FROM sources
          WHERE id NOT IN (
            SELECT id FROM sources s2
            WHERE s2.session_id = sources.session_id
            ORDER BY s2.accessed_ts DESC, s2.created_ts DESC
            LIMIT ?
          )
        `)
        .all(maxSourcesPerSession);

      if (excessSessionSources.length > 0) {
        deleteSourceIds(excessSessionSources.map((r) => r.id));
      }

      // 2. Prune global total sources if over cap (LRU by accessed_ts)
      const totalCountRow = this.db.prepare("SELECT count(*) as count FROM sources").get();
      if (totalCountRow && totalCountRow.count > maxTotalSources) {
        const deleteCount = totalCountRow.count - maxTotalSources;
        const oldest = this.db
          .prepare("SELECT id FROM sources ORDER BY accessed_ts ASC, created_ts ASC LIMIT ?")
          .all(deleteCount);

        if (oldest.length > 0) {
          deleteSourceIds(oldest.map((r) => r.id));
        }
      }
    } catch {
      // Best-effort auto-prune
    }
  }
}
