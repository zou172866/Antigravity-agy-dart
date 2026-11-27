#!/usr/bin/env node
/**
 * Transparent CLI output filter runner for agy-dart PreToolUse.overwrite.
 * Runs the decoded command, preserves exact exit code, compacts noisy output
 * to <= 8.8 KB total inline budget, and indexes raw output into SQLite FTS5.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { enableVersionedCompileCache } from "./compile-cache.mjs";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2 MB cap per stream to prevent OOM
const MAX_OVERFLOW_TAIL_BYTES = 64 * 1024; // 64 KiB bounded tail ring buffer for >2 MiB streams

function decodePayload(encoded) {
  if (!encoded) return "";
  if (encoded.startsWith("b:")) {
    return Buffer.from(encoded.slice(2), "base64url").toString("utf8");
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function parseCliArgs(argv) {
  let ruleId = "";
  let cmdB64 = "";
  let origB64 = "";
  let sessionId = process.env.ANTIGRAVITY_CONVERSATION_ID || "default";
  let noteB64 = "";

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rule" && i + 1 < argv.length) {
      ruleId = argv[++i];
    } else if (a === "--b64" && i + 1 < argv.length) {
      cmdB64 = argv[++i];
    } else if (a === "--orig-b64" && i + 1 < argv.length) {
      origB64 = argv[++i];
    } else if (a === "--session" && i + 1 < argv.length) {
      sessionId = decodePayload(argv[++i]) || sessionId;
    } else if (a === "--note" && i + 1 < argv.length) {
      noteB64 = argv[++i];
    }
  }

  const command = decodePayload(cmdB64);
  const originalCommand = origB64 ? decodePayload(origB64) : command;
  const note = decodePayload(noteB64);
  return { ruleId, command, originalCommand, sessionId, note };
}

function expandHomePrefix(dirPath) {
  if (dirPath === "~") return os.homedir();
  if (dirPath.startsWith("~/") || dirPath.startsWith("~\\")) {
    return path.join(os.homedir(), dirPath.slice(2));
  }
  return dirPath;
}

function decodeUtf8TrimIncomplete(chunks, trimTrailingIncomplete = false) {
  let buf = Buffer.concat(chunks);
  if (trimTrailingIncomplete && buf.length > 0) {
    let start = buf.length - 1;
    while (start > 0 && (buf[start] & 0xc0) === 0x80) {
      start -= 1;
    }
    const lead = buf[start];
    let expectedLen = 1;
    if ((lead & 0xe0) === 0xc0) expectedLen = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
    if (buf.length - start < expectedLen) {
      buf = buf.subarray(0, start);
    }
  }
  return buf.toString("utf8");
}

function createBoundedTailBuffer(maxBytes = MAX_OVERFLOW_TAIL_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  let droppedLeadingBytes = false;
  let lastDroppedByte = -1;
  return {
    push(chunk) {
      if (!chunk || chunk.length === 0 || maxBytes <= 0) return;
      if (chunk.length >= maxBytes) {
        if (chunk.length > maxBytes) {
          droppedLeadingBytes = true;
          lastDroppedByte = chunk[chunk.length - maxBytes - 1];
        } else if (totalBytes > 0) {
          droppedLeadingBytes = true;
          const prevLastChunk = chunks[chunks.length - 1];
          lastDroppedByte = prevLastChunk[prevLastChunk.length - 1];
        }
        chunks.length = 0;
        chunks.push(Buffer.from(chunk.subarray(chunk.length - maxBytes)));
        totalBytes = maxBytes;
        return;
      }
      chunks.push(Buffer.from(chunk));
      totalBytes += chunk.length;
      while (totalBytes > maxBytes && chunks.length > 0) {
        droppedLeadingBytes = true;
        const overflow = totalBytes - maxBytes;
        if (chunks[0].length <= overflow) {
          lastDroppedByte = chunks[0][chunks[0].length - 1];
          totalBytes -= chunks[0].length;
          chunks.shift();
        } else {
          lastDroppedByte = chunks[0][overflow - 1];
          chunks[0] = chunks[0].subarray(overflow);
          totalBytes -= overflow;
        }
      }
    },
    hasData() {
      return totalBytes > 0;
    },
    markDroppedLeading(prevByte = -1) {
      droppedLeadingBytes = true;
      lastDroppedByte = Number.isInteger(prevByte) && prevByte >= 0 && prevByte <= 0xff ? prevByte : -1;
    },
    decodeUtf8() {
      if (totalBytes === 0) return "";
      let buf = Buffer.concat(chunks, totalBytes);
      if (droppedLeadingBytes && lastDroppedByte !== 0x0a) {
        const firstNl = buf.indexOf(0x0a);
        if (firstNl < 0 || firstNl + 1 >= buf.length) {
          return "";
        }
        buf = buf.subarray(firstNl + 1);
      }
      let start = 0;
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
        start += 1;
      }
      if (start > 0) {
        buf = buf.subarray(start);
      }
      return buf.toString("utf8");
    }
  };
}

function runCommandCaptured(command, unwrapFn = null, helpers = {}) {
  const resolveWinExe = helpers.resolveWindowsExeOnPath;
  const parseSimple = helpers.tryParseSimpleCommand;
  return new Promise((resolve) => {
    const parts = typeof unwrapFn === "function" ? unwrapFn(command) : null;
    let execCwd = process.cwd();
    let execCmd = command;
    let mergeStderrToStdout = false;

    if (parts) {
      execCmd = parts.innerCommand;
      mergeStderrToStdout = Boolean(parts.hasStderrRedirect);
      if (parts.cdPath) {
        execCwd = path.resolve(process.cwd(), expandHomePrefix(parts.cdPath));
        try {
          if (!fs.statSync(execCwd).isDirectory()) {
            resolve({
              stdout: "",
              stderr: `cd: not a directory: ${parts.cdPath}\n`,
              exitCode: 1,
              outTruncated: false,
              errTruncated: false,
              truncatedCapture: false,
              execCwd: process.cwd(),
              innerCommand: execCmd
            });
            return;
          }
        } catch {
          resolve({
            stdout: "",
            stderr: `cd: no such file or directory: ${parts.cdPath}\n`,
            exitCode: 1,
            outTruncated: false,
            errTruncated: false,
            truncatedCapture: false,
            execCwd: process.cwd(),
            innerCommand: execCmd
          });
          return;
        }
      }
    }

    // On Windows, prefer direct shell:false spawn for resolved native .exe binaries when single-command
    // syntax contains quotes/`^` (avoids cmd.exe `^` stripping, PS 5.1 embedded `"` loss inside `'...'`,
    // PS alias hijacking of curl/diff/ls/sort, and PS OEM encoding). For .ps1/.cmd shims (npm/npx/vitest),
    // pass -ExecutionPolicy Bypass and force UTF-8 console encoding.
    const usePowerShell = process.platform === "win32" && /['^%]/.test(execCmd) && !/&&/.test(execCmd);
    let directWinExe = null;
    let directWinArgs = null;
    if (process.platform === "win32" && usePowerShell && typeof parseSimple === "function" && typeof resolveWinExe === "function") {
      const parsedSimple = parseSimple(execCmd);
      if (parsedSimple) {
        const exePath = resolveWinExe(parsedSimple.bin, execCwd, process.env);
        if (exePath) {
          directWinExe = exePath;
          directWinArgs = parsedSimple.args;
        }
      }
    }

    const psCommand =
      usePowerShell && !directWinExe
        ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n${execCmd}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $?) { exit 1 }\nexit 0`
        : null;

    const child = directWinExe
      ? spawn(directWinExe, directWinArgs, {
          shell: false,
          cwd: execCwd,
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        })
      : usePowerShell
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand], {
            cwd: execCwd,
            env: process.env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
          })
        : spawn(execCmd, {
            shell: true,
            detached: process.platform !== "win32",
            cwd: execCwd,
            env: process.env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
          });

    const outChunks = [];
    const errChunks = [];
    const outTailBuf = createBoundedTailBuffer(MAX_OVERFLOW_TAIL_BYTES);
    const errTailBuf = createBoundedTailBuffer(MAX_OVERFLOW_TAIL_BYTES);
    const overflowTailArmBytes = Math.max(0, MAX_CAPTURE_BYTES - MAX_OVERFLOW_TAIL_BYTES);
    let outLen = 0;
    let errLen = 0;
    let outTotalBytes = 0;
    let errTotalBytes = 0;
    let lastOutByte = -1;
    let lastErrByte = -1;
    let outTruncated = false;
    let errTruncated = false;
    let truncatedCapture = false;

    const appendOut = (chunk) => {
      if (!chunk || chunk.length === 0) return;
      const prevLen = outLen;
      const prevByte = lastOutByte;
      outTotalBytes += chunk.length;
      if (outLen < MAX_CAPTURE_BYTES) {
        const take = Math.min(chunk.length, MAX_CAPTURE_BYTES - outLen);
        outChunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        outLen += take;
        if (take < chunk.length) {
          outTruncated = true;
          truncatedCapture = true;
        }
      } else {
        outTruncated = true;
        truncatedCapture = true;
      }
      if (outTruncated || prevLen + chunk.length > overflowTailArmBytes) {
        if (!outTailBuf.hasData() && prevLen > 0) {
          outTailBuf.markDroppedLeading(prevByte);
        }
        outTailBuf.push(chunk);
      }
      lastOutByte = chunk[chunk.length - 1];
    };

    child.stdout.on("data", appendOut);

    child.stderr.on("data", (chunk) => {
      if (!chunk || chunk.length === 0) return;
      if (mergeStderrToStdout) {
        appendOut(chunk);
      }
      const prevLen = errLen;
      const prevByte = lastErrByte;
      errTotalBytes += chunk.length;
      if (errLen < MAX_CAPTURE_BYTES) {
        const take = Math.min(chunk.length, MAX_CAPTURE_BYTES - errLen);
        errChunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        errLen += take;
        if (take < chunk.length) {
          errTruncated = true;
          if (!mergeStderrToStdout) truncatedCapture = true;
        }
      } else {
        errTruncated = true;
        if (!mergeStderrToStdout) truncatedCapture = true;
      }
      if (errTruncated || prevLen + chunk.length > overflowTailArmBytes) {
        if (!errTailBuf.hasData() && prevLen > 0) {
          errTailBuf.markDroppedLeading(prevByte);
        }
        errTailBuf.push(chunk);
      }
      lastErrByte = chunk[chunk.length - 1];
    });

    let childClosed = false;
    let terminatingSignal = null;
    const killChildProcessTree = (sig) => {
      const pid = child.pid;
      const fallback = () => {
        try {
          child.kill(sig);
        } catch {}
      };
      if (!pid) {
        fallback();
        return;
      }
      if (process.platform === "win32") {
        try {
          const sysRoot = process.env.SystemRoot || process.env.WINDIR;
          const taskkillBin = sysRoot ? path.join(sysRoot, "System32", "taskkill.exe") : "taskkill";
          const killer = spawn(taskkillBin, ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
            windowsHide: true
          });
          killer.on("error", fallback);
          killer.on("close", (kCode) => {
            if (kCode !== 0 && !childClosed) fallback();
          });
          killer.unref();
        } catch {
          fallback();
        }
      } else {
        try {
          process.kill(-pid, sig);
        } catch {
          fallback();
        }
      }
    };
    const onSignal = (sig) => {
      if (terminatingSignal) return;
      terminatingSignal = sig;
      const sigExitCode = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 1;
      killChildProcessTree(sig);
      const forceExitTimer = setTimeout(() => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {}
        process.exit(sigExitCode);
      }, 400);
      forceExitTimer.unref?.();
      child.once("close", () => {
        clearTimeout(forceExitTimer);
        process.exit(sigExitCode);
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    child.on("error", (err) => {
      childClosed = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve({
        stdout: "",
        stderr: `Failed to execute command: ${err.message}`,
        exitCode: 1,
        outTruncated: false,
        errTruncated: false,
        truncatedCapture: false,
        execCwd,
        innerCommand: execCmd
      });
    });

    child.on("close", (code, signal) => {
      childClosed = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      const stderrText = decodeUtf8TrimIncomplete(errChunks, errTruncated);
      resolve({
        stdout: decodeUtf8TrimIncomplete(outChunks, outTruncated),
        stderr: mergeStderrToStdout ? "" : stderrText,
        capturedStderr: mergeStderrToStdout ? stderrText : "",
        stdoutOverflowTail: outTruncated && outTailBuf.hasData() ? outTailBuf.decodeUtf8() : "",
        stderrOverflowTail: errTruncated && errTailBuf.hasData() ? errTailBuf.decodeUtf8() : "",
        outTruncated,
        errTruncated,
        outTotalBytes,
        errTotalBytes,
        exitCode: code !== null && code !== undefined ? code : signal ? 1 : 0,
        truncatedCapture,
        execCwd,
        innerCommand: execCmd
      });
    });
  });
}

function assembleStreamWithOverflowTail(headText, tailText, wasTruncated, totalBytes = 0) {
  if (!wasTruncated || !tailText) return headText || "";
  const completeHead = stripTrailingTruncatedLine(headText || "", true);
  const headBytes = Buffer.byteLength(completeHead, "utf8");
  const tailBytes = Buffer.byteLength(tailText, "utf8");
  const effectiveTotal = Math.max(totalBytes || 0, headBytes + tailBytes);
  const omittedBytes = Math.max(0, effectiveTotal - headBytes - tailBytes);
  const sep = completeHead && !completeHead.endsWith("\n") ? "\n" : "";
  const marker =
    omittedBytes > 0
      ? `${sep}[... agy-dart omitted ~${omittedBytes} bytes between captured 2 MiB head and trailing ${tailBytes} B tail (total stream ${effectiveTotal} B) ...]\n`
      : `${sep}[... agy-dart 2 MiB capture boundary (trailing ${tailBytes} B preserved below) ...]\n`;
  return `${completeHead}${marker}${tailText}`;
}

function stripTrailingTruncatedLine(text, wasTruncated) {
  if (!text || !wasTruncated) return text || "";
  if (text.endsWith("\n")) return text;
  const lastNl = text.lastIndexOf("\n");
  return lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
}

function normalizeWindowForAnchorMatch(text, stripAnsiFn) {
  if (!text) return "";
  const stripped = typeof stripAnsiFn === "function" ? stripAnsiFn(text) : text;
  return stripped
    .split("\n")
    .map((line) => line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").replace(/\t+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function selectStreamFailureExcerpt(prefixText, wasTruncated, tailText, extractFn, stripAnsiFn = null) {
  const completePrefix = stripTrailingTruncatedLine(prefixText, wasTruncated);
  const prefixEx = completePrefix ? extractFn(completePrefix) : "";
  const tailEx = tailText ? extractFn(tailText) : "";
  if (!prefixEx) {
    return tailEx || "";
  }
  if (wasTruncated && tailEx) {
    const prefixLines = prefixEx.split("\n");
    const tailLines = tailEx.split("\n");
    const rawTailWindow = completePrefix.length > 8192 ? completePrefix.slice(-8192) : completePrefix;
    const normalizedTailWindow = normalizeWindowForAnchorMatch(rawTailWindow, stripAnsiFn);
    const sharedAnchorLine = prefixLines.find(
      (pl) => pl && tailLines.some((tl) => tl === pl || tl.startsWith(pl))
    );
    const anchorMatchBody = sharedAnchorLine
      ? sharedAnchorLine.replace(/^(?:error|message)\s*:\s*/i, "")
      : "";
    const nearBoundary = Boolean(
      sharedAnchorLine &&
        (normalizedTailWindow.includes(sharedAnchorLine) ||
          (anchorMatchBody && normalizedTailWindow.includes(anchorMatchBody)))
    );
    if (nearBoundary) {
      const prefixAnchorIdx = prefixLines.indexOf(sharedAnchorLine);
      const tailAnchorIdx = tailLines.findIndex(
        (tl) => tl === sharedAnchorLine || tl.startsWith(sharedAnchorLine)
      );
      const prefixAfterAnchor = prefixLines.slice(prefixAnchorIdx);
      const tailAfterAnchor = tailLines.slice(tailAnchorIdx);
      const prefixAfterBytes = Buffer.byteLength(prefixAfterAnchor.join("\n"), "utf8");
      const tailAfterBytes = Buffer.byteLength(tailAfterAnchor.join("\n"), "utf8");
      if (tailAfterAnchor.length > prefixAfterAnchor.length || tailAfterBytes > prefixAfterBytes) {
        return tailEx;
      }
    }
  }
  return prefixEx;
}

function extractCompactVerdict(
  filteredText,
  exitCode,
  { stripAnsiFn = null, stripTapDirectivesFn = null, isFailureAnchorFn = null, isPassingNoiseFn = null, requireFailureAnchor = false } = {}
) {
  let cleanedText = typeof stripAnsiFn === "function" ? stripAnsiFn(String(filteredText || "")) : String(filteredText || "");
  if (exitCode !== 0 && typeof stripTapDirectivesFn === "function") {
    cleanedText = stripTapDirectivesFn(cleanedText);
  }
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[agy-dart cli-filter:"));
  if (lines.length === 0) return exitCode === 0 ? "passed (exit 0)" : `failed (exit ${exitCode})`;
  if (exitCode !== 0) {
    const fallbackPriorityRe = /(?:FAIL|ERROR|ERR!|AssertionError|✖|not ok|\b[1-9]\d*\s+failed\b|exit\s+[1-9])/i;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (typeof isPassingNoiseFn === "function" && isPassingNoiseFn(line)) continue;
      const isAnchor =
        typeof isFailureAnchorFn === "function"
          ? isFailureAnchorFn(line, { includeTimeout: true }) || /\bexit\s+[1-9]\d*\b/i.test(line)
          : fallbackPriorityRe.test(line);
      if (isAnchor) return line.slice(0, 200);
    }
    if (requireFailureAnchor) {
      return `failed (exit ${exitCode})`;
    }
    return lines[lines.length - 1].slice(0, 200);
  }
  const passPriorityRe = /(?:pass|passed|tests\s+\d+|ok\b|built|compiled|0\s+errors|succeeded|done)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (passPriorityRe.test(lines[i])) return lines[i].slice(0, 200);
  }
  return lines[lines.length - 1].slice(0, 200);
}

async function main() {
  enableVersionedCompileCache();

  const { ruleId, command, originalCommand, sessionId, note } = parseCliArgs(process.argv);
  if (!command) {
    process.stderr.write("agy-dart cli-filter: missing --b64 command\n");
    process.exit(2);
  }

  const {
    applyFilterRule,
    extractFailureExcerpt,
    isFailureAnchorLine,
    isPassingNoiseLine,
    stripAnsiAndProgress,
    stripTapDirectiveBlocks,
    MAX_FILTERED_OUTPUT_BYTES,
    unwrapSafeCompoundCommand,
    resolveWindowsExeOnPath,
    tryParseSimpleCommand
  } = await import("./filter-rules.mjs");
  const [res, { ContextModeStore }, { redactSecrets }] = await Promise.all([
    runCommandCaptured(command, unwrapSafeCompoundCommand, { resolveWindowsExeOnPath, tryParseSimpleCommand }),
    import("../context/lib/store.js"),
    import("../context/lib/security.js")
  ]);

  const redOut = redactSecrets(res.stdout || "");
  const redErr = redactSecrets(res.stderr || "");
  const safeOriginalCommand = redactSecrets(originalCommand || "").text;
  const safeStdout = redOut.text;
  const safeStderr = redErr.text;
  const safeCapturedStderr = res.capturedStderr ? redactSecrets(res.capturedStderr).text : "";
  const redOutTail = res.stdoutOverflowTail ? redactSecrets(res.stdoutOverflowTail) : { text: "", redactedCount: 0 };
  const redErrTail = res.stderrOverflowTail ? redactSecrets(res.stderrOverflowTail) : { text: "", redactedCount: 0 };
  const safeOutTail = redOutTail.text;
  const safeErrTail = redErrTail.text;
  const effectiveStdout = assembleStreamWithOverflowTail(
    safeStdout,
    safeOutTail,
    Boolean(res.outTruncated),
    res.outTotalBytes
  );
  const effectiveStderr = assembleStreamWithOverflowTail(
    safeStderr,
    safeErrTail,
    Boolean(res.errTruncated),
    res.errTotalBytes
  );
  const effectiveCapturedStderr = safeCapturedStderr
    ? assembleStreamWithOverflowTail(safeCapturedStderr, safeErrTail, Boolean(res.errTruncated), res.errTotalBytes)
    : "";

  const rawCombined =
    effectiveStdout +
    (effectiveStderr ? (effectiveStdout && !effectiveStdout.endsWith("\n") ? "\n" : "") + effectiveStderr : "");
  const rawBytes = Buffer.byteLength(rawCombined, "utf8");

  let sourceId = null;
  let store = null;
  let effectiveSessionId = sessionId;
  const effectiveCwd = res.execCwd || process.cwd();

  // Index redacted output (head + omitted-middle marker + trailing 64 KiB tail when >2 MiB) into SQLite FTS5
  if (rawBytes >= 2048 || (res.exitCode !== 0 && rawBytes >= 1024)) {
    try {
      store = new ContextModeStore({ hookMode: true });
      if (typeof store.resolveRootSessionId === "function") {
        effectiveSessionId = store.resolveRootSessionId(sessionId);
      }
      const indexed = store.indexContent({
        sessionId: effectiveSessionId,
        worktree: effectiveCwd,
        agent: "antigravity",
        kind: "tool_output",
        label: `cli:${ruleId || "cmd"} ${safeOriginalCommand.slice(0, 60)}`,
        content: rawCombined,
        dedup: true
      });
      sourceId = indexed.sourceId;
    } catch {
      // Fail-open: never break command output on DB error
    }
  }

  const totalRedacted = redOut.redactedCount + redErr.redactedCount + redOutTail.redactedCount + redErrTail.redactedCount;
  const effectiveNote = [
    note,
    res.truncatedCapture ? "raw stream capped at 2MB (middle omitted; tail preserved)" : "",
    totalRedacted > 0 ? `redacted ${totalRedacted} secret(s)` : ""
  ]
    .filter(Boolean)
    .join("; ");

  const filtered = applyFilterRule(ruleId, effectiveStdout, effectiveStderr, res.exitCode, {
    cwd: effectiveCwd,
    fallbackCwd: process.cwd(),
    command: res.innerCommand || command,
    capturedStderr: effectiveCapturedStderr,
    maxBytes: MAX_FILTERED_OUTPUT_BYTES,
    note: effectiveNote || null,
    truncatedCapture: Boolean(res.truncatedCapture),
    sourceId
  });

  // Record telemetry & session verification checkpoint for Sidecar dashboard, ctx_stats & ctx_resume
  try {
    if (!store) {
      store = new ContextModeStore({ hookMode: true });
      if (typeof store.resolveRootSessionId === "function") {
        effectiveSessionId = store.resolveRootSessionId(sessionId);
      }
    }
    if (filtered.wasFiltered || rawBytes > 0) {
      store.recordEvent({
        sessionId: effectiveSessionId,
        worktree: effectiveCwd,
        agent: "antigravity",
        kind: "cli_filter",
        tool: "run_command",
        key: ruleId || "generic",
        path: safeOriginalCommand.slice(0, 120),
        ok: res.exitCode === 0 ? 1 : 0,
        exitCode: res.exitCode,
        bytes: filtered.rawBytes,
        body: filtered.filteredText.slice(0, 500),
        sandboxBytes: filtered.rawBytes,
        returnedBytes: filtered.filteredBytes
      });
    }
    if (ruleId === "test-runner" || ruleId === "playwright" || ruleId === "build-lint" || ruleId === "docker-build") {
      const outTruncated = Boolean(res.outTruncated);
      const errTruncated = Boolean(res.errTruncated);
      const anyTruncated = outTruncated || errTruncated;
      const completeStdout = stripTrailingTruncatedLine(safeStdout, outTruncated);
      const completeStderr = stripTrailingTruncatedLine(safeStderr, errTruncated);
      const completeCapturedStderr = safeCapturedStderr
        ? stripTrailingTruncatedLine(safeCapturedStderr, errTruncated)
        : "";
      const completeRawCombined =
        completeStdout +
        (completeStderr ? (completeStdout && !completeStdout.endsWith("\n") ? "\n" : "") + completeStderr : "");
      let failureExcerpt = "";
      if (res.exitCode !== 0) {
        const outEx = selectStreamFailureExcerpt(
          safeStdout,
          outTruncated,
          safeOutTail,
          extractFailureExcerpt,
          stripAnsiAndProgress
        );
        const errEx = selectStreamFailureExcerpt(
          safeStderr,
          errTruncated,
          safeErrTail,
          extractFailureExcerpt,
          stripAnsiAndProgress
        );
        const capErrEx = safeCapturedStderr
          ? selectStreamFailureExcerpt(
              safeCapturedStderr,
              errTruncated,
              safeErrTail,
              extractFailureExcerpt,
              stripAnsiAndProgress
            )
          : "";
        failureExcerpt =
          outEx ||
          errEx ||
          capErrEx ||
          (completeRawCombined ? extractFailureExcerpt(completeRawCombined) : "") ||
          (!anyTruncated ? extractFailureExcerpt(filtered.filteredText) : "");
      }
      let verdictSource = filtered.filteredText;
      let requireFailureAnchor = false;
      if (anyTruncated) {
        if (res.exitCode !== 0 && failureExcerpt) {
          verdictSource = failureExcerpt;
        } else {
          // Use bounded complete tail lines (stripping ANSI/progress) so truncated runs never
          // leak half-lines, raw ANSI sequences, or passing-test false positives into summary.
          const boundedCompleteTail = (text) => {
            if (!text) return "";
            if (text.length <= 8192) return text;
            const tail = text.slice(-8192);
            const firstNl = tail.indexOf("\n");
            return firstNl >= 0 && firstNl + 1 < tail.length ? tail.slice(firstNl + 1) : "";
          };
          verdictSource = [
            safeOutTail || boundedCompleteTail(completeStdout),
            safeErrTail || boundedCompleteTail(completeStderr || completeCapturedStderr)
          ]
            .filter(Boolean)
            .join("\n");
          requireFailureAnchor = res.exitCode !== 0;
        }
      }
      store.recordVerificationResult(effectiveSessionId, {
        kind: ruleId === "test-runner" || ruleId === "playwright" ? "test" : "build",
        command: safeOriginalCommand,
        ruleId,
        exitCode: res.exitCode,
        passed: res.exitCode === 0,
        summary: extractCompactVerdict(verdictSource, res.exitCode, {
          stripAnsiFn: stripAnsiAndProgress,
          stripTapDirectivesFn: stripTapDirectiveBlocks,
          isFailureAnchorFn: isFailureAnchorLine,
          isPassingNoiseFn: isPassingNoiseLine,
          requireFailureAnchor
        }),
        failureExcerpt,
        sourceId,
        worktree: effectiveCwd
      });
    }
  } catch {
    // Fail-open
  } finally {
    if (store) {
      try {
        store.close();
      } catch {}
    }
  }

  if (filtered.filteredText) {
    process.stdout.write(
      filtered.filteredText.endsWith("\n") ? filtered.filteredText : `${filtered.filteredText}\n`
    );
  }
  process.exit(res.exitCode);
}

main().catch((err) => {
  process.stderr.write(`agy-dart cli-filter error: ${err?.message || err}\n`);
  process.exit(1);
});
