import { spawn } from "node:child_process";
import path from "node:path";

export const OUTPUT_CAP = 16384; // 16 KB default preview cap
export const DEFAULT_TIMEOUT_MS = 30000; // 30s timeout

/** Run a process and capture stdout / stderr with time and byte bounding */
export function runProcess({
  cmd,
  args = [],
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = 10 * 1024 * 1024,
  env = process.env,
  stdinData = null,
  windowsVerbatimArguments = false
}) {
  return new Promise((resolve) => {
    const stdoutBuffer = [];
    const stderrBuffer = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let finished = false;

    let forceCloseTimer = null;

    const child = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: Boolean(windowsVerbatimArguments),
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    const onFinish = (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceCloseTimer) {
        clearTimeout(forceCloseTimer);
        forceCloseTimer = null;
      }

      const stdout = Buffer.concat(stdoutBuffer).toString("utf8");
      const stderr = Buffer.concat(stderrBuffer).toString("utf8");
      const rawBytes = stdoutBytes + stderrBytes;

      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode: timedOut ? 124 : (exitCode ?? (signal ? 1 : 0)),
        signal,
        timedOut,
        stdout,
        stderr,
        rawBytes
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      const fallbackKill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      };
      try {
        if (pid) {
          if (process.platform === "win32") {
            const sysRoot = process.env.SystemRoot || process.env.WINDIR;
            const taskkillBin = sysRoot ? path.join(sysRoot, "System32", "taskkill.exe") : "taskkill";
            const killer = spawn(taskkillBin, ["/F", "/T", "/PID", String(pid)], {
              stdio: "ignore",
              windowsHide: true
            });
            killer.on("error", fallbackKill);
            killer.unref();
          } else {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              fallbackKill();
            }
          }
        } else {
          fallbackKill();
        }
      } catch {
        fallbackKill();
      }
      try {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      forceCloseTimer = setTimeout(() => onFinish(124, "SIGKILL"), 500);
      forceCloseTimer.unref?.();
    }, timeoutMs);

    if (stdinData && child.stdin) {
      try {
        child.stdin.end(stdinData);
      } catch {
        // ignore
      }
    } else if (child.stdin) {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maxBytes) {
        stdoutBuffer.push(chunk);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maxBytes) {
        stderrBuffer.push(chunk);
      }
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceCloseTimer) {
        clearTimeout(forceCloseTimer);
        forceCloseTimer = null;
      }
      resolve({
        ok: false,
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: String(err && err.message ? err.message : err),
        rawBytes: 0
      });
    });

    child.on("close", (code, sig) => onFinish(code, sig));
  });
}

/** Execute code in specified runtime (nodejs, python, shell, pwsh, cmd) */
export async function executeCode({
  language = "shell",
  code = "",
  file = "",
  args = [],
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = {}
}) {
  const normLang = String(language || "shell").toLowerCase().trim();
  const workdir = cwd || process.cwd();
  const safeArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];

  // 1. Node.js
  if (normLang === "nodejs" || normLang === "node" || normLang === "javascript" || normLang === "js") {
    if (file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: process.execPath,
        args: [scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runProcess({
      cmd: process.execPath,
      args: ["-e", code, "--", ...safeArgs],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 2. Python
  if (normLang === "python" || normLang === "python3" || normLang === "py") {
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    if (file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: pythonBin,
        args: [scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runProcess({
      cmd: pythonBin,
      args: ["-c", code, ...safeArgs],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 3. PowerShell
  const runPowerShellCommand = (bin, scriptText) => {
    const psScript = scriptText || "";
    if (safeArgs.length === 0) {
      return runProcess({
        cmd: bin,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    // Never append args after `-Command` (PowerShell concatenates them into script syntax -> command injection).
    // Pass code and data arguments through env vars and invoke via ScriptBlock so `$args` receives literal strings.
    const psEnv = { ...env, __AGY_PS_CODE: psScript };
    const psArgRefs = safeArgs.map((arg, idx) => {
      const key = `__AGY_PS_ARG_${idx}`;
      psEnv[key] = arg;
      return `$env:${key}`;
    });
    const wrapper = `& ([scriptblock]::Create($env:__AGY_PS_CODE)) ${psArgRefs.join(" ")}`;
    return runProcess({
      cmd: bin,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapper],
      cwd: workdir,
      timeoutMs,
      env: psEnv
    });
  };

  if (normLang === "pwsh" || normLang === "powershell") {
    const bin = process.platform === "win32" ? "powershell.exe" : "pwsh";
    if (file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: bin,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runPowerShellCommand(bin, code);
  }

  // 4. Windows CMD
  if (normLang === "cmd" || normLang === "bat") {
    if (!code && file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      if (
        scriptPath.includes('"') ||
        /[\r\n\0]/.test(scriptPath) ||
        safeArgs.some((a) => a.includes('"') || /[\r\n\0]/.test(a))
      ) {
        return {
          ok: false,
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "Invalid script file path or argument for cmd execution",
          rawBytes: 0
        };
      }
      const cmdEnv = { ...env, __AGY_CMD_FILE: scriptPath };
      const argRefs = safeArgs.map((arg, idx) => {
        const key = `__AGY_CMD_ARG_${idx}`;
        cmdEnv[key] = arg;
        return `"%${key}%"`;
      });
      const cmdLine = `"${['"%__AGY_CMD_FILE%"', ...argRefs].join(" ")}"`;
      return runProcess({
        cmd: "cmd.exe",
        args: ["/d", "/s", "/c", cmdLine],
        cwd: workdir,
        timeoutMs,
        env: cmdEnv,
        windowsVerbatimArguments: true
      });
    }
    return runProcess({
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", code || ""],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 5. Default Shell
  if (process.platform === "win32") {
    if (!code && file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runPowerShellCommand("powershell.exe", code || "");
  } else {
    const shell = process.env.SHELL || "/bin/sh";
    if (!code && file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: shell,
        args: [scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runProcess({
      cmd: shell,
      args: safeArgs.length > 0 ? ["-c", code || "", "--", ...safeArgs] : ["-c", code || ""],
      cwd: workdir,
      timeoutMs,
      env
    });
  }
}
