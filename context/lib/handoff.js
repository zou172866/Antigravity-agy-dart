/**
 * agy-dart Cache-Friendly Session Handoff Brief Generator
 * Clean-room zero-dependency ESM implementation inspired by
 * lennartschoch/opencode-cache-compact & the-cybersapien/claude-cache.
 *
 * Produces a strictly byte-bounded, UTF-8/CJK-safe Markdown handoff brief
 * capturing workspace git state, structured session checkpoint, recent FTS5
 * source handles, live KV-cache snapshot, and a post-compaction resume cue.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./security.js";

const DEFAULT_MAX_BYTES = 5800;
const GIT_TIMEOUT_MS = 500;
const MAX_DIFF_STAT_LINES = 16;
const MAX_DIFF_STAT_BYTES = 1200;
const NEXT_STEP_LINE = "Call ctx_resume({}) after /compact or paste this brief into a fresh session.";

/** Strictly truncate a string to <= maxBytes UTF-8 bytes without splitting multi-byte chars or surrogate pairs */
export function truncateUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  if (limit === 0) return "";
  const str = String(text);
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let cut = limit;
  // Back up if landing in the middle of a multi-byte UTF-8 sequence (continuation bytes: 10xxxxxx)
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  let out = buf.subarray(0, cut).toString("utf8");
  // Extra defensive guard against trailing replacement chars or lone high surrogate
  out = out.replace(/\uFFFD+$/, "");
  if (out.length > 0) {
    const lastCode = out.charCodeAt(out.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      out = out.slice(0, -1);
    }
  }
  return out;
}

function formatBytesCompact(bytes) {
  const b = Number(bytes || 0);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTokensK(tokens) {
  const n = Number(tokens || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 1000)}k`;
}

function toFiniteNumber(val) {
  if (val === null || val === undefined || typeof val === "boolean") return null;
  if (typeof val === "string" && val.trim() === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function isUncPath(p) {
  if (!p || typeof p !== "string") return false;
  return /^[\\/]{2}/.test(p.trim());
}

function formatUsdCompact(val) {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatDurationCompact(sec) {
  const s = Math.max(0, Math.round(Number(sec || 0)));
  if (s < 60) return `${s}s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function sanitizeInline(val, maxBytes = 240) {
  if (val === null || val === undefined) return "";
  const flat = String(val).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return Buffer.byteLength(flat, "utf8") > maxBytes ? `${truncateUtf8Safe(flat, Math.max(8, maxBytes - 3))}...` : flat;
}

function isExistingDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return false;
  const trimmed = dirPath.trim();
  if (!trimmed || trimmed.includes("\0") || isUncPath(trimmed)) return false;
  const resolved = path.resolve(trimmed);
  if (isUncPath(resolved)) return false;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return false;
    const real = fs.realpathSync(resolved);
    if (isUncPath(real)) return false;
    return true;
  } catch {
    return false;
  }
}

function resolveCanonicalPath(p) {
  const real = typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(p)
    : fs.realpathSync(p);
  if (process.platform === "win32") {
    const driveMatch = real.match(/^\\\\\?\\([a-zA-Z]:\\.*)$/);
    if (driveMatch) return driveMatch[1];
  }
  return real;
}

function isUnsafeBroadRoot(dirPath) {
  const resolved = path.resolve(dirPath);
  const root = path.parse(resolved).root;
  if (root) {
    const isFsRoot = process.platform === "win32"
      ? resolved.toLowerCase() === root.toLowerCase()
      : resolved === root;
    if (isFsRoot) return true;
  }
  let realResolved = resolved;
  try {
    realResolved = resolveCanonicalPath(resolved);
    const realRoot = path.parse(realResolved).root;
    if (realRoot) {
      const isRealFsRoot = process.platform === "win32"
        ? realResolved.toLowerCase() === realRoot.toLowerCase()
        : realResolved === realRoot;
      if (isRealFsRoot) return true;
    }
  } catch {}
  const home = path.resolve(os.homedir());
  let realHome = home;
  try {
    realHome = resolveCanonicalPath(home);
  } catch {}
  const inside = (cand, anc) => {
    const nc = process.platform === "win32" ? cand.toLowerCase() : cand;
    const na = process.platform === "win32" ? anc.toLowerCase() : anc;
    const rel = path.relative(na, nc);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
    );
  };
  return (
    inside(home, resolved) ||
    inside(realHome, resolved) ||
    inside(home, realResolved) ||
    inside(realHome, realResolved)
  );
}

function runGitReadOnly(args, workDir) {
  try {
    const res = spawnSync(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args],
      {
        cwd: workDir,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 128 * 1024
      }
    );
    if (res.error || res.status !== 0) {
      return { ok: false, stdout: "", stderr: String(res.stderr || res.error?.message || "") };
    }
    return { ok: true, stdout: String(res.stdout || ""), stderr: String(res.stderr || "") };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

function boundDiffStat(rawStat) {
  if (!rawStat || typeof rawStat !== "string") return "";
  const lines = rawStat
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";

  let selected = lines;
  if (lines.length > MAX_DIFF_STAT_LINES) {
    const summaryLine = lines[lines.length - 1];
    const headCount = MAX_DIFF_STAT_LINES - 2;
    const omitted = lines.length - 1 - headCount;
    selected = [...lines.slice(0, headCount), `... (+${omitted} more file(s))`, summaryLine];
  }

  const joined = selected.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= MAX_DIFF_STAT_BYTES) return joined;
  return `${truncateUtf8Safe(joined, MAX_DIFF_STAT_BYTES - 16)}\n... [truncated]`;
}

function inspectGitWorkspace(cwd) {
  if (!isExistingDirectory(cwd)) {
    return { validDir: false, isGit: false, branch: "", diffStat: "" };
  }
  const resolved = path.resolve(cwd.trim());

  let isGit = false;
  let branch = "";

  const sym = runGitReadOnly(["symbolic-ref", "--short", "HEAD"], resolved);
  if (sym.ok && sym.stdout.trim()) {
    isGit = true;
    branch = sym.stdout.trim();
  } else if (!/not a git repository/i.test(sym.stderr)) {
    const rev = runGitReadOnly(["rev-parse", "--short", "HEAD"], resolved);
    if (rev.ok && rev.stdout.trim()) {
      isGit = true;
      branch = `detached@${rev.stdout.trim()}`;
    } else {
      const inside = runGitReadOnly(["rev-parse", "--is-inside-work-tree"], resolved);
      if (inside.ok && inside.stdout.trim() === "true") {
        isGit = true;
        branch = "HEAD";
      }
    }
  }

  if (!isGit) {
    return { validDir: true, isGit: false, branch: "", diffStat: "" };
  }

  // Prefer diff against HEAD (captures both staged & unstaged working-tree edits); fall back cleanly for unborn repos
  let diffRes = runGitReadOnly(["-c", "core.quotepath=false", "diff", "--stat", "--stat-width=80", "HEAD"], resolved);
  if (!diffRes.ok) {
    diffRes = runGitReadOnly(["-c", "core.quotepath=false", "diff", "--stat", "--stat-width=80", "--cached"], resolved);
    if (!diffRes.ok || !diffRes.stdout.trim()) {
      diffRes = runGitReadOnly(["-c", "core.quotepath=false", "diff", "--stat", "--stat-width=80"], resolved);
    }
  }

  return {
    validDir: true,
    isGit: true,
    branch,
    diffStat: diffRes.ok ? boundDiffStat(diffRes.stdout) : ""
  };
}

/**
 * Infer a valid existing workspace directory from SQLite checkpoints, indexed sources, or recent events.
 * Strictly fail-open: returns "" if no existing directory can be inferred.
 */
export function inferWorkspaceFromStore(store, sessionId = "default", sinceTs = null) {
  if (!store) return "";
  try {
    if (typeof store.open === "function") store.open();
    if (!store.db) return "";
    const sid = sessionId || "default";
    const isAll = sid === "all" || sid === "lifetime";
    const sinceNum = sid === "app" ? toFiniteNumber(sinceTs) : null;
    const isApp = sinceNum !== null;
    const sinceIso = isApp ? new Date(sinceNum).toISOString() : null;

    const queries = [
      () =>
        isAll
          ? store.db
              .prepare("SELECT worktree FROM session_checkpoints WHERE worktree != '' ORDER BY updated_ts DESC LIMIT 3")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT worktree FROM session_checkpoints WHERE worktree != '' AND updated_ts >= ? ORDER BY updated_ts DESC LIMIT 3")
                .all(sinceNum)
            : store.db
                .prepare("SELECT worktree FROM session_checkpoints WHERE session_id = ? AND worktree != '' LIMIT 1")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT worktree FROM sources WHERE worktree != '' ORDER BY created_ts DESC LIMIT 3")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT worktree FROM sources WHERE worktree != '' AND (created_ts >= ? OR created_at >= ?) ORDER BY created_ts DESC LIMIT 3")
                .all(sinceNum, sinceIso)
            : store.db
                .prepare("SELECT worktree FROM sources WHERE session_id = ? AND worktree != '' ORDER BY created_ts DESC LIMIT 3")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT worktree FROM events WHERE worktree != '' ORDER BY seq DESC LIMIT 3")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT worktree FROM events WHERE worktree != '' AND created_at >= ? ORDER BY seq DESC LIMIT 3")
                .all(sinceIso)
            : store.db
                .prepare("SELECT worktree FROM events WHERE session_id = ? AND worktree != '' ORDER BY seq DESC LIMIT 3")
                .all(sid)
    ];

    for (const run of queries) {
      try {
        const rows = run();
        for (const row of rows || []) {
          if (row?.worktree && isExistingDirectory(row.worktree)) {
            const resolved = path.resolve(row.worktree);
            if (!isUnsafeBroadRoot(resolved)) {
              return resolved;
            }
          }
        }
      } catch {
        // Ignore missing table/column on partial or mock stores
      }
    }
  } catch {
    // Fail-open
  }
  return "";
}

function formatVerificationLine(label, rec) {
  if (!rec || typeof rec !== "object") return "";
  const status = rec.ok ? "PASS" : "FAIL";
  const exitNum = toFiniteNumber(rec.exitCode);
  const exitPart = exitNum !== null ? ` (exit ${exitNum})` : "";
  const cmdPart = rec.command ? ` \`${sanitizeInline(rec.command, 120)}\`` : "";
  const summaryPart = rec.summary ? ` — ${sanitizeInline(rec.summary, 180)}` : "";
  const srcPart = rec.sourceId ? ` [sourceId: \`${sanitizeInline(rec.sourceId, 64)}\`]` : "";
  return `- **${label}**: ${status}${exitPart}${cmdPart}${summaryPart}${srcPart}`;
}

function hasCacheSnapshot(cacheDiag) {
  if (!cacheDiag || typeof cacheDiag !== "object") return false;
  if (cacheDiag.transcriptFound === false) return false;
  return Boolean(
    cacheDiag.turnsWithUsage > 0 ||
      cacheDiag.currentContextTokens > 0 ||
      cacheDiag.currentModel ||
      (cacheDiag.compactAdvice && cacheDiag.compactAdvice !== "none") ||
      (cacheDiag.cacheTemperature && cacheDiag.cacheTemperature !== "cold") ||
      Number(cacheDiag.weightedHitRate || 0) > 0 ||
      Number(cacheDiag.estimatedSavedUsd || 0) !== 0
  );
}

/**
 * Build a compact, cache-friendly Markdown handoff brief for `/compact` or session switches.
 * Strictly bounded to `<= maxBytes` UTF-8 bytes without broken multi-byte characters.
 */
export function buildHandoffBrief({
  store = null,
  sessionId = "default",
  cwd = "",
  cacheDiag = null,
  maxBytes = DEFAULT_MAX_BYTES,
  sinceTs = null
} = {}) {
  const sid = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default";
  const parsedMax = Number(maxBytes);
  const budget = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : DEFAULT_MAX_BYTES;
  const rawCwd = typeof cwd === "string" ? cwd.trim() : "";

  const gitInfo = inspectGitWorkspace(rawCwd);

  let checkpoint = null;
  let resumeState = null;

  if (store && typeof store.getSessionCheckpoint === "function") {
    try {
      checkpoint = store.getSessionCheckpoint(sid);
    } catch {
      checkpoint = null;
    }
  }
  if (store && typeof store.getResumeState === "function") {
    try {
      const resumeSince = toFiniteNumber(sinceTs);
      const resumeOpts = resumeSince !== null ? { sinceTs: resumeSince } : {};
      resumeState = store.getResumeState(sid, 5, resumeOpts);
    } catch {
      resumeState = null;
    }
  }
  if (!checkpoint && resumeState?.sessionCheckpoint) {
    checkpoint = resumeState.sessionCheckpoint;
  }

  const modifiedFiles = Array.isArray(checkpoint?.modifiedFiles) ? checkpoint.modifiedFiles.filter(Boolean) : [];
  const cpModCount = toFiniteNumber(checkpoint?.modifiedFileCount);
  const modifiedFileCount = cpModCount !== null ? Math.max(modifiedFiles.length, cpModCount) : modifiedFiles.length;
  const lastTest = checkpoint?.lastTest || null;
  const lastBuild = checkpoint?.lastBuild || null;
  const recentSources = Array.isArray(resumeState?.recentSources) ? resumeState.recentSources.slice(0, 5) : [];

  const sections = [];
  const summaryParts = [];

  // 1. Header & workspace metadata
  const headerLines = ["# agy-dart Handoff Brief", `- **Session**: \`${sanitizeInline(sid, 96)}\``];
  if (rawCwd) {
    headerLines.push(`- **Workspace**: \`${sanitizeInline(rawCwd.replace(/\\/g, "/"), 220)}\``);
  }
  if (gitInfo.isGit && gitInfo.branch) {
    headerLines.push(`- **Git Branch**: \`${sanitizeInline(gitInfo.branch, 120)}\``);
    summaryParts.push(`branch=${sanitizeInline(gitInfo.branch, 48)}`);
  }
  sections.push(headerLines.join("\n"));

  // 2. Bounded git diff --stat
  if (gitInfo.isGit && gitInfo.diffStat) {
    sections.push(`## Git Diff Stat\n\`\`\`text\n${gitInfo.diffStat}\n\`\`\``);
  }

  // 3. Structured session checkpoint (modified files, last test, last build)
  const cpLines = [];
  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 12).map((f) => `\`${sanitizeInline(f, 160)}\``);
    const extra = modifiedFileCount > shown.length ? ` (+${modifiedFileCount - shown.length} more)` : "";
    cpLines.push(`- **Modified Files (${modifiedFileCount})**: ${shown.join(", ")}${extra}`);
    summaryParts.push(`${modifiedFileCount} modified`);
  }
  const testLine = formatVerificationLine("Last Test", lastTest);
  if (testLine) {
    cpLines.push(testLine);
    summaryParts.push(`test=${lastTest.ok ? "PASS" : "FAIL"}`);
  }
  const buildLine = formatVerificationLine("Last Build", lastBuild);
  if (buildLine) {
    cpLines.push(buildLine);
    summaryParts.push(`build=${lastBuild.ok ? "PASS" : "FAIL"}`);
  }
  if (cpLines.length > 0) {
    sections.push(`## Session Checkpoint\n${cpLines.join("\n")}`);
  }

  // 4. Recent indexed FTS5 handles
  if (recentSources.length > 0) {
    const srcLines = recentSources.map((src) => {
      const id = sanitizeInline(src?.id ?? src?.sourceId ?? "", 80);
      const label = sanitizeInline(src?.label || "untitled", 160);
      const sz = formatBytesCompact(src?.bytes_total ?? src?.bytesTotal ?? 0);
      const chunks = Number(src?.chunk_count ?? src?.chunkCount ?? 0);
      const chunkNote = chunks > 0 ? `, ${chunks} ${chunks === 1 ? "chunk" : "chunks"}` : "";
      return `- \`${id}\` — ${label} (${sz}${chunkNote})`;
    });
    sections.push(`## Indexed FTS5 Handles\n${srcLines.join("\n")}`);
    summaryParts.push(`${recentSources.length} FTS5 ${recentSources.length === 1 ? "source" : "sources"}`);
  }

  // 5. Live KV-cache snapshot
  if (hasCacheSnapshot(cacheDiag)) {
    const kvLines = [];
    const model = sanitizeInline(cacheDiag.currentModel || cacheDiag.modelProfile?.id || "", 96);
    const ctxTok = Number(cacheDiag.currentContextTokens || 0);
    const winTok = Number(cacheDiag.modelProfile?.windowTokens || 0);
    const temp = sanitizeInline(cacheDiag.cacheTemperature || "cold", 32);
    const advice = sanitizeInline(cacheDiag.compactAdvice || "none", 48);
    const hitRate = toFiniteNumber(cacheDiag.weightedHitRate);
    const savedUsd = formatUsdCompact(cacheDiag.estimatedSavedUsd);

    const row1 = [];
    if (model) row1.push(`**Model**: \`${model}\``);
    if (ctxTok > 0) {
      const ctxStr = winTok > 0
        ? `${formatTokensK(ctxTok)} / ${formatTokensK(winTok)} (${Math.round((ctxTok / winTok) * 100)}%)`
        : `${formatTokensK(ctxTok)} tok`;
      row1.push(`**Context**: ${ctxStr}`);
    }
    if (row1.length > 0) kvLines.push(`- ${row1.join(" | ")}`);

    const row2 = [];
    if (temp) row2.push(`**Cache**: ${temp.toUpperCase()}`);
    if (hitRate !== null) row2.push(`**Hit Rate**: ${(hitRate * 100).toFixed(1)}%`);
    if (advice) row2.push(`**Advice**: \`${advice}\``);
    if (savedUsd !== null) {
      row2.push(`**Est. Saved**: ${savedUsd}`);
    }
    if (cacheDiag.ttlStatus && cacheDiag.ttlStatus !== "cold") {
      const ttlRem = toFiniteNumber(cacheDiag.ttlRemainingSec);
      const ttlDetail =
        cacheDiag.ttlStatus === "expired"
          ? "expired"
          : ttlRem !== null
            ? `${formatDurationCompact(ttlRem)} left`
            : cacheDiag.ttlStatus;
      row2.push(`**TTL**: ${ttlDetail}`);
    }
    if (row2.length > 0) kvLines.push(`- ${row2.join(" | ")}`);

    if (kvLines.length > 0) {
      sections.push(`## KV-Cache Snapshot\n${kvLines.join("\n")}`);
      const ctxPart = ctxTok > 0 ? `ctx=${formatTokensK(ctxTok)}` : "";
      const tempPart = temp ? temp : "";
      if (ctxPart || tempPart) {
        summaryParts.push([ctxPart, tempPart ? `(${tempPart})` : ""].filter(Boolean).join(" "));
      }
    }
  }

  // 6. Actionable next step
  const nextStepSection = `## Next Step\n${NEXT_STEP_LINE}`;

  const rawBody = sections.join("\n\n");
  const redactedBody = redactSecrets(rawBody).text;
  const fullMarkdown = `${redactedBody}\n\n${nextStepSection}`;

  let markdown = fullMarkdown;
  let truncated = false;

  if (Buffer.byteLength(fullMarkdown, "utf8") > budget) {
    truncated = true;
    const footerBlock = `\n\n... [truncated to <=${budget} B]\n\n${nextStepSection}`;
    const footerBytes = Buffer.byteLength(footerBlock, "utf8");

    if (budget > footerBytes + 32) {
      const bodyBudget = budget - footerBytes;
      let cutBody = truncateUtf8Safe(redactedBody, bodyBudget);
      // Prefer breaking cleanly on a newline if it preserves at least 60% of available body budget
      const lastNl = cutBody.lastIndexOf("\n");
      if (lastNl > 0 && Buffer.byteLength(cutBody.slice(0, lastNl), "utf8") >= Math.floor(bodyBudget * 0.6)) {
        cutBody = cutBody.slice(0, lastNl).trimEnd();
      }
      // Close an unclosed fenced code block if truncation happened mid-fence
      const fenceCount = (cutBody.match(/^```/gm) || []).length;
      if (fenceCount % 2 === 1) {
        const closeFence = "\n```";
        const closeBytes = Buffer.byteLength(closeFence, "utf8");
        if (Buffer.byteLength(cutBody, "utf8") + closeBytes <= bodyBudget) {
          cutBody += closeFence;
        } else {
          cutBody = `${truncateUtf8Safe(cutBody, Math.max(0, bodyBudget - closeBytes))}${closeFence}`;
        }
      }
      markdown = `${cutBody}${footerBlock}`;
    } else {
      // Extreme tiny maxBytes budget: hard UTF-8 safe cap
      markdown = truncateUtf8Safe(fullMarkdown, budget);
    }

    // Final hard invariant guard
    if (Buffer.byteLength(markdown, "utf8") > budget) {
      markdown = truncateUtf8Safe(markdown, budget);
    }
  }

  const bytes = Buffer.byteLength(markdown, "utf8");
  const summary = summaryParts.length > 0 ? summaryParts.join(" | ") : `session=${sanitizeInline(sid, 48)}`;

  return {
    markdown,
    summary,
    bytes,
    truncated
  };
}
