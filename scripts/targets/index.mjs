import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "./claude-code.mjs";
import * as codex from "./codex.mjs";
import * as dsh from "./dsh.mjs";
import * as agy from "./antigravity.mjs";
import { cleanupRuntime, guardPath, manageFiles, read, serverCommands, syncSharedRuntime } from "./shared.mjs";
import { RUNTIME_FILES, DEVTOOLS_FILES, FILES_TO_COPY, checkNodeAndSqlite, verifyMcpServer } from "../install.mjs";

const DEFAULT_FRESH_LOCK_GRACE_MS = 2000;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_MAX_RETRIES = 12;

function defaultProbePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "invalid";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    if (err?.code === "EPERM") return "eperm";
    return "dead";
  }
}

function parseLockPayload(raw) {
  const trimmed = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { kind: "empty" };
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 0 ? { kind: "valid", pid, startedAt: null, legacy: true } : { kind: "corrupt" };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        kind: "valid",
        pid: parsed.pid,
        startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : null,
        token: typeof parsed.token === "string" ? parsed.token : "",
        action: typeof parsed.action === "string" ? parsed.action : "",
        targets: Array.isArray(parsed.targets) ? parsed.targets : []
      };
    }
  } catch {}
  return { kind: "corrupt" };
}

function inspectLockFile(lockPath, { now = Date.now, freshLockGraceMs = DEFAULT_FRESH_LOCK_GRACE_MS, staleLockMs = DEFAULT_STALE_LOCK_MS, probePid = defaultProbePid } = {}) {
  let st;
  try {
    st = fs.lstatSync(lockPath);
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "missing" };
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw Error(`Refusing non-regular lock path: ${lockPath}`);
  }
  let raw = "";
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "missing" };
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      return { status: "eperm", pid: null, startedAt: null };
    }
    throw err;
  }
  const ageMs = Math.max(0, now() - st.mtimeMs);
  const parsed = parseLockPayload(raw);
  if (parsed.kind === "empty" || parsed.kind === "corrupt") {
    // Respect the brief window right after `open(wx)` before the creator finishes writing metadata.
    if (ageMs < freshLockGraceMs) {
      return { status: "initializing", ageMs };
    }
    return { status: "stale", reason: parsed.kind, ageMs };
  }
  const pid = parsed.pid;
  if (pid === process.pid) {
    // Same PID inside the same process means re-entrant/live hold unless explicitly orphaned by tests.
    return { status: "active", pid, startedAt: parsed.startedAt, action: parsed.action };
  }
  const probe = probePid(pid);
  if (probe === "eperm") {
    return { status: "eperm", pid, startedAt: parsed.startedAt, action: parsed.action };
  }
  if (probe === "alive") {
    const holderAgeMs = Number.isFinite(parsed.startedAt) ? Math.max(0, now() - parsed.startedAt) : ageMs;
    if (holderAgeMs > staleLockMs) {
      return { status: "stale", reason: "expired", pid, ageMs: holderAgeMs };
    }
    return { status: "active", pid, startedAt: parsed.startedAt, action: parsed.action };
  }
  return { status: "stale", reason: "dead_pid", pid, ageMs };
}

function createLockExclusive(lockPath, meta, { now = Date.now } = {}) {
  const token = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: now(),
    token,
    ...(meta.action ? { action: meta.action } : {}),
    ...(Array.isArray(meta.targets) ? { targets: meta.targets } : {})
  }) + "\n";
  const fd = fs.openSync(lockPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, payload, "utf8");
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
    throw err;
  }
  return { lockPath, fd, token };
}

export async function acquireTargetsLock(lockPath, meta = {}, options = {}) {
  const now = options.now || Date.now;
  const freshLockGraceMs = Number.isFinite(options.freshLockGraceMs) ? options.freshLockGraceMs : DEFAULT_FRESH_LOCK_GRACE_MS;
  const staleLockMs = Number.isFinite(options.staleLockMs) ? options.staleLockMs : DEFAULT_STALE_LOCK_MS;
  const retryMs = Number.isFinite(options.retryMs) ? Math.max(1, options.retryMs) : DEFAULT_LOCK_RETRY_MS;
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(1, options.maxRetries) : DEFAULT_LOCK_MAX_RETRIES;
  const probePid = options.probePid || defaultProbePid;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const inspectOpts = { now, freshLockGraceMs, staleLockMs, probePid };

  guardPath(lockPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const reclaimPath = `${lockPath}.reclaim`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return createLockExclusive(lockPath, meta, { now });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    const info = inspectLockFile(lockPath, inspectOpts);
    if (info.status === "missing") continue;
    if (info.status === "active") {
      const startedHint = Number.isFinite(info.startedAt) ? `, started ${new Date(info.startedAt).toISOString()}` : "";
      const actionHint = info.action ? `, action=${info.action}` : "";
      throw Error(
        `Another agy-dart target operation is already in progress (PID ${info.pid}${actionHint}${startedHint}, lock: ${lockPath}). ` +
          `Wait for it to finish, or remove ${lockPath} only after confirming PID ${info.pid} is no longer running.`
      );
    }
    if (info.status === "eperm") {
      const pidLabel = info.pid ? `PID ${info.pid}` : "another user/elevated process";
      throw Error(
        `Cannot inspect or reclaim target lock held by inaccessible process (${pidLabel}, EPERM) at ${lockPath}. ` +
          `Wait for that process to finish or remove the lock manually once confirmed inactive.`
      );
    }
    if (info.status === "initializing") {
      if (attempt < maxRetries) {
        await sleep(retryMs);
        continue;
      }
      throw Error(
        `Target lock ${lockPath} is currently being initialized by another process. Retry in a moment.`
      );
    }

    // Stale candidate: serialize stale reclamation via `${lockPath}.reclaim` so two racing
    // processes cannot delete each other's newly created live lock.
    guardPath(reclaimPath);
    let reclaimHandle = null;
    try {
      reclaimHandle = createLockExclusive(reclaimPath, { action: "reclaim" }, { now });
    } catch (reclaimErr) {
      if (reclaimErr?.code !== "EEXIST") throw reclaimErr;
      const reclaimInfo = inspectLockFile(reclaimPath, inspectOpts);
      if (reclaimInfo.status === "stale") {
        try { fs.unlinkSync(reclaimPath); } catch {}
      }
      if (attempt < maxRetries) {
        await sleep(retryMs);
        continue;
      }
      throw Error(`Timed out waiting for stale target lock reclamation at ${lockPath}.`);
    }

    try {
      // Re-inspect under the reclaim guard to ensure another process didn't already replace it with a live lock.
      const confirmed = inspectLockFile(lockPath, inspectOpts);
      if (confirmed.status === "stale") {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
        }
        return createLockExclusive(lockPath, meta, { now });
      }
      // Lock became live, initializing, eperm, or missing while acquiring reclaim guard; re-evaluate on next loop.
    } finally {
      releaseTargetsLock(reclaimHandle);
    }
  }

  throw Error(`Unable to acquire target lock at ${lockPath} after ${maxRetries} retries.`);
}

export function releaseTargetsLock(handle) {
  if (!handle) return;
  try {
    if (handle.fd !== undefined) fs.closeSync(handle.fd);
  } catch {}
  try {
    if (handle.lockPath && handle.token) {
      const raw = fs.readFileSync(handle.lockPath, "utf8");
      const parsed = parseLockPayload(raw);
      if (parsed.kind === "valid" && parsed.token && parsed.token !== handle.token) {
        return;
      }
    }
    if (handle.lockPath) fs.unlinkSync(handle.lockPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      // Best-effort cleanup in finally
    }
  }
}

export async function runTargets(src, argv, home = os.homedir(), options = {}) {
  const args=[...argv], at=args.indexOf("--target");
  const names=at<0?["agy"]:String(args.splice(at,2)[1]).split(",");
  const profileAt=args.indexOf("--profile");
  const profile=profileAt<0?undefined:String(args.splice(profileAt,2)[1] ?? "");
  const mcpOnlyAt=args.indexOf("--mcp-only");
  const mcpOnly=mcpOnlyAt<0?undefined:(args.splice(mcpOnlyAt,1),true);
  const adapters={claude,codex,dsh};
  const targets=new Set(names.flatMap(name=>name==="all"?["agy",...Object.keys(adapters).filter(k=>adapters[k].detect(home))]:[name]));
  const action=args[0];
  for(const name of targets) {
    if(name!=="agy" && !Object.hasOwn(adapters,name)) throw Error("Unknown host: "+name);
    if(name!=="agy" && !["install","uninstall","doctor","status"].includes(action)) throw Error("Unsupported "+action+" for "+name);
  }
  if (action !== "uninstall" && [...targets].some(name => name !== "agy")) await checkNodeAndSqlite();
  const modifyingShared = [...targets].some(name => name !== "agy") && ["install","uninstall"].includes(action);
  const lock = path.join(home,".agy-dart","targets.lock");
  let lockHandle = null;
  try {
    if (modifyingShared) {
      lockHandle = await acquireTargetsLock(
        lock,
        { action, targets: [...targets] },
        options.lockOptions || {}
      );
    }
    for(const name of targets) {
    if(name==="agy"){agy.run(src,args);continue;}
    const runtime=path.join(home,".agy-dart/runtime");
    const specs=adapters[name].specs(home,src,runtime,{profile,mcpOnly,action});
    if(action==="install") {
      const withDevtools = args.includes("--with-devtools");
      syncSharedRuntime(src,home,withDevtools?FILES_TO_COPY:RUNTIME_FILES,{preserveFiles:withDevtools?[]:DEVTOOLS_FILES});
      manageFiles(home,name,specs,action);
    } else if(action==="uninstall") {
      manageFiles(home,name,specs,action);
      cleanupRuntime(home);
    } else {
      for(const spec of specs) {
        const raw=read(spec.file);
        if(raw === null || !spec.verify(raw)) throw Error("Invalid installation: " + spec.file);
      }
      const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"agy-doctor-"));
      try {
        for(const entry of Object.values(serverCommands(runtime))) await verifyMcpServer(entry.args[0],{AGY_DART_DB_PATH:path.join(tmp,"check.db")});
      } finally {fs.rmSync(tmp,{recursive:true,force:true});}
      console.log(name+" OK");
    }
  }
  } finally {
    releaseTargetsLock(lockHandle);
  }
}
