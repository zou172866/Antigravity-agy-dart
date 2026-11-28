// HOST_LIVENESS_VERSION = 1  — keep byte-identical across agy-cmd and agy-dart.
import net from "node:net";

export const HOST_LIVENESS_VERSION = 1;

/**
 * Parse a loopback-only Language Server address into `{ host, port }`.
 * Accepts `127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT` (with optional `http(s)://` scheme).
 * Rejects non-loopback hosts, userinfo, and out-of-range ports by returning `null`.
 */
export function parseLoopbackPort(lsAddress) {
  if (typeof lsAddress !== "string") return null;
  const trimmed = lsAddress.trim();
  if (!trimmed || /[\s\x00-\x1f@]/.test(trimmed)) return null;

  let rawHost = "";
  let rawPort = "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password) return null;
      rawHost = parsed.hostname;
      rawPort = parsed.port;
    } catch {
      return null;
    }
  } else {
    const v6Match = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
    if (v6Match) {
      rawHost = `[${v6Match[1]}]`;
      rawPort = v6Match[2];
    } else {
      const idx = trimmed.lastIndexOf(":");
      if (idx <= 0 || trimmed.indexOf(":") !== idx) return null;
      rawHost = trimmed.slice(0, idx);
      rawPort = trimmed.slice(idx + 1);
    }
  }

  if (!/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const lowerHost = rawHost.toLowerCase();
  if (lowerHost === "127.0.0.1" || lowerHost === "localhost") {
    return { host: "127.0.0.1", port };
  }
  if (lowerHost === "[::1]" || lowerHost === "::1") {
    return { host: "::1", port };
  }
  return null;
}

/**
 * Check whether `pid` is alive via zero-signal `process.kill(pid, 0)`.
 * Returns `true` (alive / EPERM), `false` (ESRCH), or `null` (unavailable / pid <= 1).
 */
export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    if (err?.code === "EPERM") return true;
    return null;
  }
}

/**
 * Probe whether a loopback port is free using an exclusive bind (zero TCP connect).
 * Returns `false` on `EADDRINUSE` (host LS still listening), `true` on bind success
 * (immediately closed -> host LS gone), or `null` on indeterminate errors.
 */
export function defaultProbePortFree(targetOrPort, hostArg = "127.0.0.1") {
  const port =
    targetOrPort && typeof targetOrPort === "object"
      ? Number(targetOrPort.port)
      : Number(targetOrPort);
  const host =
    targetOrPort && typeof targetOrPort === "object" && typeof targetOrPort.host === "string"
      ? targetOrPort.host
      : hostArg;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(null);
  }
  if (host !== "127.0.0.1" && host !== "::1") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    let timeoutId = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        srv.close(() => resolve(result));
      } catch {
        resolve(result);
      }
    };

    timeoutId = setTimeout(() => finish(null), 3000);
    timeoutId.unref?.();

    srv.once("error", (err) => {
      if (err?.code === "EADDRINUSE") {
        finish(false);
      } else {
        finish(null);
      }
    });
    srv.once("listening", () => {
      finish(true);
    });
    try {
      srv.listen({ port, host, exclusive: true });
    } catch (err) {
      if (err?.code === "EADDRINUSE") {
        finish(false);
      } else {
        finish(null);
      }
    }
  });
}

/**
 * Dual-signal (PPID + exclusive loopback bind) host liveness guard for Sidecars (#1663).
 * Fail-open: never fires during grace window, never fires without >=1 prior alive observation,
 * ignores `null` (unavailable) probes without resetting streaks, and invokes `onHostGone` once.
 */
export function createHostLivenessGuard({
  ppid = process.ppid,
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  graceMs = 60_000,
  ppidIntervalMs = 60_000,
  probeIntervalMs = 300_000,
  confirmCount = 2,
  isPidAlive = defaultIsPidAlive,
  probePortFree = defaultProbePortFree,
  onHostGone,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const requiredConfirms =
    Number.isInteger(confirmCount) && confirmCount >= 1 ? confirmCount : 2;
  const parsedTarget = parseLoopbackPort(lsAddress);

  let started = false;
  let stopped = false;
  let triggered = false;
  let triggerReason = null;
  let bootMs = null;
  let seenAlive = false;
  let ppidMissStreak = 0;
  let portFreeStreak = 0;
  let ppidTimer = null;
  let probeTimer = null;
  let probeInFlight = false;

  const isInGrace = () => bootMs === null || now() - bootMs < graceMs;

  const stop = () => {
    stopped = true;
    if (ppidTimer !== null) {
      clearIntervalFn(ppidTimer);
      ppidTimer = null;
    }
    if (probeTimer !== null) {
      clearIntervalFn(probeTimer);
      probeTimer = null;
    }
  };

  const trigger = (reason) => {
    if (triggered || stopped) return;
    triggered = true;
    triggerReason = reason;
    stop();
    try {
      onHostGone?.(reason);
    } catch {
      // Fail-open: caller callback errors must not crash timers
    }
  };

  const handlePortResult = (portFree) => {
    if (stopped || triggered) return;
    if (portFree === null || portFree === undefined) {
      return;
    }
    if (portFree === false) {
      seenAlive = true;
      portFreeStreak = 0;
      return;
    }
    if (portFree === true) {
      if (isInGrace() || !seenAlive) return;
      portFreeStreak += 1;
      if (portFreeStreak >= requiredConfirms) {
        trigger(`ls_port_free:${parsedTarget ? parsedTarget.port : "unknown"}`);
      }
    }
  };

  const checkPort = () => {
    if (stopped || triggered || !parsedTarget || probeInFlight) return;
    let raw;
    try {
      raw = probePortFree(parsedTarget);
    } catch {
      return;
    }
    if (raw && typeof raw.then === "function") {
      probeInFlight = true;
      raw
        .then((res) => {
          probeInFlight = false;
          handlePortResult(res);
        })
        .catch(() => {
          probeInFlight = false;
        });
    } else {
      handlePortResult(raw);
    }
  };

  const checkPpid = () => {
    if (stopped || triggered) return;
    let alive;
    try {
      alive = isPidAlive(ppid);
    } catch {
      return;
    }
    if (alive === null || alive === undefined) {
      return;
    }
    if (alive === true) {
      seenAlive = true;
      ppidMissStreak = 0;
      return;
    }
    if (alive === false) {
      if (isInGrace() || !seenAlive) return;
      ppidMissStreak += 1;
      if (ppidMissStreak >= requiredConfirms) {
        trigger(`ppid_gone:${ppid}`);
        return;
      }
      // Supplement immediately with a loopback bind probe when PPID reports dead.
      checkPort();
    }
  };

  const api = {
    start() {
      if (started || stopped) return api;
      started = true;
      bootMs = now();
      checkPpid();
      if (parsedTarget) {
        checkPort();
      }
      if (!stopped) {
        ppidTimer = setIntervalFn(checkPpid, ppidIntervalMs);
        ppidTimer?.unref?.();
        if (parsedTarget) {
          probeTimer = setIntervalFn(checkPort, probeIntervalMs);
          probeTimer?.unref?.();
        }
      }
      return api;
    },
    stop,
    state() {
      return {
        version: HOST_LIVENESS_VERSION,
        started,
        stopped,
        triggered,
        triggerReason,
        bootMs,
        seenAlive,
        ppid,
        lsTarget: parsedTarget ? { ...parsedTarget } : null,
        ppidMissStreak,
        portFreeStreak
      };
    }
  };

  return api;
}
