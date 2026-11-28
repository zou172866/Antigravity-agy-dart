import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createHostLivenessGuard,
  HOST_LIVENESS_VERSION,
  parseLoopbackPort
} from "../sidecars/dashboard/host-liveness.mjs";
import {
  createCleanShutdown,
  maybeStartHostLivenessGuard
} from "../sidecars/dashboard/server.mjs";

const EXPECTED_HOST_LIVENESS_SHA256 = "9ef4eecfd3b20e50f13752ef1cb8bb81270aa7314ab9884bff9b6e5ebf2165f4";

function createFakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map();
  const setIntervalFn = (fn, delayMs) => {
    const id = nextId++;
    const handle = {
      id,
      fn,
      delayMs,
      nextAt: nowMs + delayMs,
      repeating: true,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      }
    };
    timers.set(id, handle);
    return handle;
  };
  const clearIntervalFn = (handle) => {
    if (handle && typeof handle === "object") timers.delete(handle.id);
    else timers.delete(handle);
  };
  const setTimeoutFn = (fn, delayMs) => {
    const id = nextId++;
    const handle = {
      id,
      fn,
      delayMs,
      nextAt: nowMs + delayMs,
      repeating: false,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      }
    };
    timers.set(id, handle);
    return handle;
  };
  const advance = async (deltaMs) => {
    const targetMs = nowMs + deltaMs;
    while (true) {
      let earliest = null;
      for (const h of timers.values()) {
        if (h.nextAt <= targetMs && (!earliest || h.nextAt < earliest.nextAt)) {
          earliest = h;
        }
      }
      if (!earliest) break;
      nowMs = earliest.nextAt;
      if (earliest.repeating) {
        earliest.nextAt = nowMs + earliest.delayMs;
      } else {
        timers.delete(earliest.id);
      }
      earliest.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    nowMs = targetMs;
  };
  return {
    now: () => nowMs,
    setIntervalFn,
    clearIntervalFn,
    setTimeoutFn,
    advance,
    timers
  };
}

test("v1.10.3 (#1663): host-liveness guard state machine, parseLoopbackPort, env kill-switch, shutdownCleanly (update & 15s keepalive cap) & SHA-256 parity", async () => {
  // 1. SHA-256 parity check (identical constant shared with agy-cmd)
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const livenessFile = path.resolve(__dir, "../sidecars/dashboard/host-liveness.mjs");
  const actualSha = crypto.createHash("sha256").update(fs.readFileSync(livenessFile)).digest("hex");
  assert.equal(HOST_LIVENESS_VERSION, 1);
  assert.equal(actualSha, EXPECTED_HOST_LIVENESS_SHA256);

  // 2. parseLoopbackPort rejects non-loopback hosts and parses valid loopback addresses
  assert.equal(parseLoopbackPort("10.0.0.5:1234"), null);
  assert.equal(parseLoopbackPort("example.com:80"), null);
  assert.equal(parseLoopbackPort("0.0.0.0:13412"), null);
  assert.equal(parseLoopbackPort("http://user:pass@127.0.0.1:13412"), null);
  assert.deepEqual(parseLoopbackPort("127.0.0.1:13412"), { host: "127.0.0.1", port: 13412 });
  assert.deepEqual(parseLoopbackPort("localhost:13412"), { host: "127.0.0.1", port: 13412 });
  assert.deepEqual(parseLoopbackPort("[::1]:13412"), { host: "::1", port: 13412 });
  assert.deepEqual(parseLoopbackPort("http://127.0.0.1:13412"), { host: "127.0.0.1", port: 13412 });

  // 3. Grace period: both ppid and port report dead during grace -> no callback
  {
    const clock = createFakeClock(0);
    const reasons = [];
    const g = createHostLivenessGuard({
      ppid: 4242,
      lsAddress: "127.0.0.1:13412",
      graceMs: 60_000,
      ppidIntervalMs: 10_000,
      probeIntervalMs: 15_000,
      confirmCount: 2,
      isPidAlive: () => false,
      probePortFree: () => true,
      onHostGone: (r) => reasons.push(r),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn
    });
    g.start();
    for (const h of clock.timers.values()) assert.equal(h.unrefCalled, true);
    await clock.advance(55_000);
    assert.deepEqual(reasons, []);
    g.stop();
  }

  // 4. Never observed alive after start, always dead past grace -> no callback
  {
    const clock = createFakeClock(0);
    const reasons = [];
    const g = createHostLivenessGuard({
      ppid: 4242,
      lsAddress: "127.0.0.1:13412",
      graceMs: 60_000,
      ppidIntervalMs: 30_000,
      probeIntervalMs: 60_000,
      confirmCount: 2,
      isPidAlive: () => false,
      probePortFree: () => true,
      onHostGone: (r) => reasons.push(r),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn
    });
    g.start();
    await clock.advance(300_000);
    assert.deepEqual(reasons, []);
    assert.equal(g.state().seenAlive, false);
    g.stop();
  }

  // 5. Observed alive first, then 2 consecutive dead ppid checks -> calls onHostGone once with 'ppid'
  {
    const clock = createFakeClock(0);
    const reasons = [];
    let pidAlive = true;
    const g = createHostLivenessGuard({
      ppid: 7212,
      lsAddress: "127.0.0.1:13412",
      graceMs: 60_000,
      ppidIntervalMs: 60_000,
      probeIntervalMs: 300_000,
      confirmCount: 2,
      isPidAlive: () => pidAlive,
      probePortFree: () => false,
      onHostGone: (r) => reasons.push(r),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn
    });
    g.start();
    assert.equal(g.state().seenAlive, true);
    pidAlive = false;
    await clock.advance(60_000);
    assert.deepEqual(reasons, []);
    await clock.advance(60_000);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /ppid/i);
    assert.equal(g.state().stopped, true);
    await clock.advance(200_000);
    assert.equal(reasons.length, 1);
  }

  // 6. PID stays alive (PID reuse simulation), port free 2 consecutive times -> calls onHostGone with 'ls_port'
  {
    const clock = createFakeClock(0);
    const reasons = [];
    let portFree = false;
    const g = createHostLivenessGuard({
      ppid: 7212,
      lsAddress: "127.0.0.1:13412",
      graceMs: 60_000,
      ppidIntervalMs: 60_000,
      probeIntervalMs: 300_000,
      confirmCount: 2,
      isPidAlive: () => true,
      probePortFree: async () => portFree,
      onHostGone: (r) => reasons.push(r),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn
    });
    g.start();
    await Promise.resolve();
    portFree = true;
    await clock.advance(300_000);
    assert.deepEqual(reasons, []);
    await clock.advance(300_000);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /ls_port/i);
    assert.equal(g.state().stopped, true);
  }

  // 7. Alternating dead -> alive -> dead does not trigger (must be consecutive)
  {
    const clock = createFakeClock(0);
    const reasons = [];
    const seq = [true, false, true, false, true, false];
    let idx = 0;
    const g = createHostLivenessGuard({
      ppid: 7212,
      lsAddress: "",
      graceMs: 60_000,
      ppidIntervalMs: 60_000,
      confirmCount: 2,
      isPidAlive: () => seq[Math.min(idx++, seq.length - 1)],
      onHostGone: (r) => reasons.push(r),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn
    });
    g.start();
    await clock.advance(300_000);
    assert.deepEqual(reasons, []);
    g.stop();
  }

  // 8. Probe returning null (unavailable) neither increments nor resets streak
  {
    const clock = createFakeClock(0);
    const reasons = [];
    const seq = [true, false, null, null, false];
    let idx = 0;
    const g = createHostLivenessGuard({
      ppid: 7212,
      lsAddress: "",
      graceMs: 60_000,
      ppidIntervalMs: 60_000,
      confirmCount: 2,
      isPidAlive: () => seq[Math.min(idx++, seq.length - 1)],
      onHostGone: (r) => reasons.push(r),
      now: clock.now,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn
    });
    g.start();
    await clock.advance(60_000);
    assert.equal(g.state().ppidMissStreak, 1);
    await clock.advance(60_000);
    assert.equal(g.state().ppidMissStreak, 1);
    await clock.advance(60_000);
    assert.equal(g.state().ppidMissStreak, 1);
    await clock.advance(60_000);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /ppid/i);
  }

  // 9. Disable env var prevents guard creation
  {
    let created = 0;
    const g = maybeStartHostLivenessGuard({
      env: { AGY_DART_DISABLE_LIVENESS_GUARD: "1", ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:13412" },
      onHostGone: () => {},
      createGuard: () => {
        created += 1;
        return { start() {}, stop() {} };
      }
    });
    assert.equal(g, null);
    assert.equal(created, 0);
  }

  // 10. shutdownCleanly waits ~3s while isPluginUpdateBusy() is true then exits once on duplicate calls
  {
    const clock = createFakeClock(0);
    let busy = true;
    const exits = [];
    let closed = 0;
    const shutdown = createCleanShutdown({
      isBusy: () => busy,
      onClose: async () => { closed += 1; },
      exit: (code) => exits.push({ code, atMs: clock.now() }),
      pollIntervalMs: 500,
      maxWaitMs: 15_000,
      setTimeoutFn: clock.setTimeoutFn,
      now: clock.now
    });

    const p1 = shutdown(0);
    const p2 = shutdown(0);
    await clock.advance(2500);
    assert.equal(exits.length, 0);
    busy = false;
    await clock.advance(500);
    await Promise.all([p1, p2]);
    assert.equal(closed, 1);
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0], { code: 0, atMs: 3000 });
  }

  // 11. agy-dart: _keepaliveInFlight.size > 0 lasting 20s waits full 15s cap then exits
  {
    const clock = createFakeClock(0);
    const keepaliveInFlight = new Map([["conv-1", "ka_1"]]);
    const exits = [];
    let closed = 0;
    const shutdown = createCleanShutdown({
      isBusy: () => keepaliveInFlight.size > 0,
      onClose: async () => { closed += 1; },
      exit: (code) => exits.push({ code, atMs: clock.now() }),
      pollIntervalMs: 500,
      maxWaitMs: 15_000,
      setTimeoutFn: clock.setTimeoutFn,
      now: clock.now
    });

    const p = shutdown(0);
    await clock.advance(14_500);
    assert.equal(exits.length, 0);
    await clock.advance(5_500); // total 20s elapsed, cap reached at 15_000ms
    await p;
    assert.equal(closed, 1);
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0], { code: 0, atMs: 15_000 });
  }
});
