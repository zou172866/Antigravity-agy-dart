import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEffectiveConfig } from "./config.js";

export const OUTPUT_CAP = 16384; // 16 KB default preview cap
export const DEFAULT_TIMEOUT_MS = 120000; // 120s default exec timeout
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 300000; // 300s max exec timeout

const SAFE_CHILD_ENV_ALLOWLIST = new Set([
  // Core OS & filesystem environment (Windows + POSIX)
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "OS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "PUBLIC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "COMPUTERNAME",
  "USERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  // Language & toolchain runtimes
  "NODE_ENV",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NVM_HOME",
  "NVM_SYMLINK",
  "NVM_DIR",
  "FNM_DIR",
  "VOLTA_HOME",
  "PNPM_HOME",
  "BUN_INSTALL",
  "DENO_DIR",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "GOPATH",
  "GOROOT",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "DOTNET_ROOT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY"
]);

const SENSITIVE_ENV_KEY_RE =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASS(?:WORD|WD)?|CREDENTIAL|CREDENTIALS|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?ID|COOKIE|SIGNING_?KEY|BEARER|JWT|OAUTH|WEBHOOK)(?:$|_)|^(?:AWS_(?:ACCESS|SECRET|SESSION|SECURITY|WEB_IDENTITY)|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API_|GOOGLE_APPLICATION_CREDENTIALS|AZURE_(?:CLIENT_SECRET|STORAGE_KEY|API_KEY)|GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|PYPI_TOKEN|DOCKER_PASSWORD|HF_TOKEN|HUGGING_?FACE_HUB_TOKEN|SLACK_TOKEN|DISCORD_TOKEN|STRIPE_|TWILIO_|SENDGRID_|DATABASE_URL|POSTGRES_PASSWORD|MYSQL_PWD|REDIS_PASSWORD|PGPASSWORD|SSH_AUTH_SOCK|AGY_DART_UI_TOKEN|AGY_SIDECAR_TOKEN|ANTIGRAVITY_(?:TOKEN|SECRET|API_KEY|AUTH|COOKIE))/i;

/** Hard credential filter (always takes precedence over built-in and user-configured allowlists). */
export function isSensitiveEnvKey(name) {
  if (typeof name !== "string" || !name.trim()) return true;
  return SENSITIVE_ENV_KEY_RE.test(name.trim());
}

/**
 * Construct a minimal child-process environment from OS & language toolchain allowlists plus
 * optional user-configured `execEnvAllowlist` names. Hard credential filtering always wins.
 */
export function buildSafeChildEnv(baseEnv = process.env, { allowlist = null, extraEnv = null } = {}) {
  const effectiveAllowlist = Array.isArray(allowlist)
    ? allowlist
    : getEffectiveConfig().execEnvAllowlist || [];
  const extraAllowedUpper = new Set();
  const extraAllowedExact = new Set();
  for (const name of effectiveAllowlist) {
    if (typeof name !== "string") continue;
    const clean = name.trim();
    if (!clean) continue;
    extraAllowedExact.add(clean);
    extraAllowedUpper.add(clean.toUpperCase());
  }

  const out = {};
  const isWin = process.platform === "win32";
  if (baseEnv && typeof baseEnv === "object") {
    for (const [k, v] of Object.entries(baseEnv)) {
      if (v === undefined || v === null) continue;
      if (isSensitiveEnvKey(k)) continue;
      const upper = k.toUpperCase();
      const allowedByDefault = SAFE_CHILD_ENV_ALLOWLIST.has(upper) || upper.startsWith("LC_");
      const allowedByConfig = isWin ? extraAllowedUpper.has(upper) : extraAllowedExact.has(k);
      if (allowedByDefault || allowedByConfig) {
        out[k] = String(v);
      }
    }
  }
  if (extraEnv && typeof extraEnv === "object") {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined || v === null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

/** Clamp execution timeout safely into [1s, 300s] */
export function resolveExecTimeoutMs(timeoutMs, fallbackMs = DEFAULT_TIMEOUT_MS) {
  const fb =
    Number.isFinite(Number(fallbackMs)) && Number(fallbackMs) > 0 ? Math.floor(Number(fallbackMs)) : DEFAULT_TIMEOUT_MS;
  const clampedFb = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, fb));
  if (timeoutMs === undefined || timeoutMs === null || timeoutMs === "" || typeof timeoutMs === "boolean") {
    return clampedFb;
  }
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return clampedFb;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

function trimIncompleteUtf8Tail(buf) {
  if (!buf || buf.length === 0) return buf;
  let start = buf.length - 1;
  while (start > 0 && buf.length - start < 4 && (buf[start] & 0xc0) === 0x80) {
    start -= 1;
  }
  const lead = buf[start];
  if ((lead & 0x80) === 0) return buf;
  let expectedLen = 0;
  if ((lead & 0xe0) === 0xc0) expectedLen = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
  else return buf.subarray(0, start);
  if (buf.length - start < expectedLen) {
    return buf.subarray(0, start);
  }
  return buf;
}

const ESM_REGEX_PREFIX_KW = new Set([
  "return",
  "case",
  "throw",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "new",
  "yield",
  "await",
  "else",
  "do"
]);

/** Detect top-level ESM syntax (static import/export or import.meta) linearly without regex/template false positives */
export function isLikelyEsmCode(src) {
  if (!src || typeof src !== "string") return false;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const len = src.length;
  if (src.startsWith("#!", i)) {
    const nl = src.indexOf("\n", i);
    if (nl === -1) return false;
    i = nl + 1;
  }
  let braceDepth = 0;
  let parenDepth = 0;
  const templateReturnDepths = [];
  let lastSigChar = "";
  let lastIdent = "";

  const consumeTemplateBody = () => {
    while (i < len) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i += 1;
        lastSigChar = "`";
        lastIdent = "";
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        templateReturnDepths.push(braceDepth);
        braceDepth += 1;
        lastSigChar = "{";
        lastIdent = "";
        i += 2;
        return;
      }
      i += 1;
    }
    lastSigChar = "`";
    lastIdent = "";
  };

  while (i < len) {
    const ch = src[i];
    if (ch <= " ") {
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = ch;
      i += 1;
      while (i < len) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      lastSigChar = q;
      lastIdent = "";
      continue;
    }
    if (ch === "`") {
      i += 1;
      consumeTemplateBody();
      continue;
    }
    if (ch === "/") {
      const canStartRegex =
        lastSigChar === "" ||
        "=(,:![&|?{};~+-*%^<>".includes(lastSigChar) ||
        (lastIdent !== "" && ESM_REGEX_PREFIX_KW.has(lastIdent));
      if (canStartRegex) {
        i += 1;
        let inClass = false;
        while (i < len) {
          const rc = src[i];
          if (rc === "\\") {
            i += 2;
            continue;
          }
          if (rc === "\n" || rc === "\r") break;
          if (rc === "[") inClass = true;
          else if (rc === "]") inClass = false;
          else if (!inClass && rc === "/") {
            i += 1;
            while (i < len && ((src[i] >= "a" && src[i] <= "z") || (src[i] >= "A" && src[i] <= "Z"))) {
              i += 1;
            }
            break;
          }
          i += 1;
        }
        lastSigChar = "/";
        lastIdent = "";
        continue;
      }
    }
    if (ch === "{") {
      braceDepth += 1;
      lastSigChar = "{";
      lastIdent = "";
      i += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      i += 1;
      if (templateReturnDepths.length > 0 && braceDepth === templateReturnDepths[templateReturnDepths.length - 1]) {
        templateReturnDepths.pop();
        consumeTemplateBody();
        continue;
      }
      lastSigChar = "}";
      lastIdent = "";
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      lastSigChar = "(";
      lastIdent = "";
      i += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      lastSigChar = ")";
      lastIdent = "";
      i += 1;
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$") {
      const start = i;
      i += 1;
      while (i < len) {
        const c = src[i];
        if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$") {
          i += 1;
        } else {
          break;
        }
      }
      const word = src.slice(start, i);
      const beforeChar = start > 0 ? src[start - 1] : "";
      if (beforeChar !== "." && lastSigChar !== ".") {
        if (word === "import") {
          let k = i;
          while (k < len && src[k] <= " ") k += 1;
          if (src[k] === ".") return true; // import.meta
          if (braceDepth === 0 && parenDepth === 0 && src[k] !== "(") return true; // top-level static import
        } else if (word === "export" && braceDepth === 0 && parenDepth === 0) {
          return true;
        }
      }
      lastSigChar = word[word.length - 1];
      lastIdent = word;
      continue;
    }
    lastSigChar = ch;
    lastIdent = "";
    i += 1;
  }
  return false;
}

/** Run a process and capture stdout / stderr with time and byte bounding */
export function runProcess({
  cmd,
  args = [],
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = 10 * 1024 * 1024,
  env = undefined,
  stdinData = null,
  windowsVerbatimArguments = false
}) {
  return new Promise((resolve) => {
    const stdoutBuffer = [];
    const stderrBuffer = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutStoredBytes = 0;
    let stderrStoredBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finished = false;
    let childExited = false;
    const effTimeoutMs = resolveExecTimeoutMs(timeoutMs);

    let forceCloseTimer = null;

    // Respect explicit `env` verbatim (including empty `{}`); default to sanitized allowlisted env.
    const spawnEnv =
      env !== undefined && env !== null ? { ...env } : buildSafeChildEnv(process.env);

    const child = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      env: spawnEnv,
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

      const rawStdout = Buffer.concat(stdoutBuffer);
      const rawStderr = Buffer.concat(stderrBuffer);
      const stdout = (stdoutTruncated ? trimIncompleteUtf8Tail(rawStdout) : rawStdout).toString("utf8");
      const stderr = (stderrTruncated ? trimIncompleteUtf8Tail(rawStderr) : rawStderr).toString("utf8");
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
            killer.on("close", (kCode) => {
              if (kCode !== 0 && !childExited) fallbackKill();
            });
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
    }, effTimeoutMs);

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
      if (stdoutStoredBytes < maxBytes) {
        const remain = maxBytes - stdoutStoredBytes;
        if (chunk.byteLength <= remain) {
          stdoutBuffer.push(chunk);
          stdoutStoredBytes += chunk.byteLength;
        } else {
          stdoutBuffer.push(chunk.subarray(0, remain));
          stdoutStoredBytes = maxBytes;
          stdoutTruncated = true;
        }
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrStoredBytes < maxBytes) {
        const remain = maxBytes - stderrStoredBytes;
        if (chunk.byteLength <= remain) {
          stderrBuffer.push(chunk);
          stderrStoredBytes += chunk.byteLength;
        } else {
          stderrBuffer.push(chunk.subarray(0, remain));
          stderrStoredBytes = maxBytes;
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });

    child.on("error", (err) => {
      childExited = true;
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

    child.on("close", (code, sig) => {
      childExited = true;
      onFinish(code, sig);
    });
  });
}

/** Infer execution runtime from script file extension when language is omitted */
export function inferLanguageFromFile(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  const ext = path.extname(filePath.trim()).toLowerCase();
  if (ext === ".py" || ext === ".pyw") return "python";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".mts" || ext === ".cts") {
    return "javascript";
  }
  if (ext === ".ps1") return "powershell";
  if (ext === ".bat" || ext === ".cmd") return process.platform === "win32" ? "cmd" : "shell";
  if (ext === ".sh" || ext === ".bash") return "shell";
  return "";
}

function hasUtf8OrUtf16Bom(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 2 &&
    ((buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ||
      (buf[0] === 0xff && buf[1] === 0xfe) ||
      (buf[0] === 0xfe && buf[1] === 0xff))
  );
}

function needsUtf8BomStaging(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || hasUtf8OrUtf16Bom(buf)) return false;
  let hasNonAscii = false;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] >= 0x80) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function isInsideOsTmpDir(dirPath) {
  if (!dirPath) return false;
  const norm = (p) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync(r);
    } catch {}
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const cand = norm(dirPath);
  const tmp = norm(os.tmpdir());
  const rel = path.relative(tmp, cand);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

function isEphemeralScriptStageDir(dirPath) {
  if (!dirPath) return false;
  if (isInsideOsTmpDir(dirPath)) return true;
  const resolved = path.resolve(dirPath).replace(/\\/g, "/");
  return /\/brain\/[^/]+\/scratch(?:\/|$)/i.test(resolved);
}

/** Coerce MCP array, JSON-stringified array, or scalar argument safely into string[] */
export function normalizeExecArgs(rawArgs) {
  if (Array.isArray(rawArgs)) {
    return rawArgs.filter((a) => a !== undefined && a !== null).map((a) => String(a));
  }
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((a) => a !== undefined && a !== null).map((a) => String(a));
        }
      } catch {}
    }
    return [rawArgs];
  }
  if (rawArgs !== undefined && rawArgs !== null) {
    return [String(rawArgs)];
  }
  return [];
}

function buildNodeFileExecArgs(scriptPath, safeArgs) {
  const ext = path.extname(scriptPath).toLowerCase();
  const [maj = 0, min = 0] = String(process.versions.node || "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const flags = [];
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    if ((maj === 22 && min >= 6 && min < 18) || (maj === 23 && min < 6)) {
      flags.push("--experimental-strip-types");
    }
  } else if (ext === ".js" && maj === 22 && min < 12) {
    flags.push("--experimental-detect-module");
  }
  return [...flags, scriptPath, ...safeArgs];
}

/** Execute code in specified runtime (nodejs, python, shell, pwsh, cmd) as current OS user with allowlisted env */
export async function executeCode({
  language = undefined,
  code = "",
  file = "",
  args = [],
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = undefined
}) {
  const rawLang = typeof language === "string" ? language.trim() : "";
  const trimmedFile = typeof file === "string" ? file.trim() : "";
  const safeCode = typeof code === "string" ? code : "";
  const effectiveCode = trimmedFile && !safeCode.trim() ? "" : safeCode;
  const inferredLang = !rawLang && trimmedFile ? inferLanguageFromFile(trimmedFile) : "";
  const normLang = (rawLang || inferredLang || "shell").toLowerCase();
  const workdir = cwd || process.cwd();
  const safeArgs = normalizeExecArgs(args);
  const childEnv = env !== undefined && env !== null ? { ...env } : buildSafeChildEnv(process.env);

  // 1. Node.js
  if (normLang === "nodejs" || normLang === "node" || normLang === "javascript" || normLang === "js") {
    if (trimmedFile) {
      const scriptPath = path.isAbsolute(trimmedFile) ? trimmedFile : path.resolve(workdir, trimmedFile);
      return runProcess({
        cmd: process.execPath,
        args: buildNodeFileExecArgs(scriptPath, safeArgs),
        cwd: workdir,
        timeoutMs,
        env: childEnv
      });
    }
    const evalTail = safeArgs.length > 0 ? ["--", "[eval]", ...safeArgs] : [];
    const nodeFlags = isLikelyEsmCode(effectiveCode)
      ? ["--input-type=module", "-e", effectiveCode, ...evalTail]
      : ["-e", effectiveCode, ...evalTail];
    return runProcess({
      cmd: process.execPath,
      args: nodeFlags,
      cwd: workdir,
      timeoutMs,
      env: childEnv
    });
  }

  // 2. Python
  if (normLang === "python" || normLang === "python3" || normLang === "py") {
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    const pyEnv = {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      ...childEnv
    };
    if (trimmedFile) {
      const scriptPath = path.isAbsolute(trimmedFile) ? trimmedFile : path.resolve(workdir, trimmedFile);
      return runProcess({
        cmd: pythonBin,
        args: [scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env: pyEnv
      });
    }
    return runProcess({
      cmd: pythonBin,
      args: ["-c", effectiveCode, ...safeArgs],
      cwd: workdir,
      timeoutMs,
      env: pyEnv
    });
  }

  // Helper for safe Windows .bat / .cmd script execution with literal args
  const runCmdBatchFile = (scriptPath) => {
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
    const cmdEnv = { ...childEnv, __AGY_CMD_FILE: scriptPath };
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
  };

  // 3. PowerShell
  const PS_UTF8_PRELUDE =
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;";
  const hasLeadingPsParamBlock = (txt) => /^\s*(?:<#[\s\S]*?#>|\s|#[^\r\n]*)*param\s*\(/i.test(txt);
  const withPsUtf8Prelude = (txt) => {
    if (!txt || !txt.trim() || hasLeadingPsParamBlock(txt)) return txt;
    return `${PS_UTF8_PRELUDE}\n${txt}`;
  };
  const invokePowerShellFileWithUtf8 = (bin, targetScriptPath) => {
    const psEnv = { ...childEnv, __AGY_PS_FILE: targetScriptPath };
    const clearTargets = ["Env:__AGY_PS_FILE"];
    const psArgItems = safeArgs.map((arg, idx) => {
      const key = `__AGY_PS_ARG_${idx}`;
      psEnv[key] = arg;
      clearTargets.push(`Env:${key}`);
      return `$env:${key}`;
    });
    const wrapper =
      `${PS_UTF8_PRELUDE} $__agyFile = $env:__AGY_PS_FILE; $__agyArgs = @(${psArgItems.join(", ")}); ` +
      `Remove-Item ${clearTargets.join(", ")} -ErrorAction SilentlyContinue; ` +
      `$global:LASTEXITCODE = $null; & $__agyFile @__agyArgs; ` +
      `if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }`;
    return runProcess({
      cmd: bin,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapper],
      cwd: workdir,
      timeoutMs,
      env: psEnv
    });
  };
  const executePowerShellScriptFile = async (bin, scriptPath) => {
    let stagedBomPs1 = "";
    try {
      let rawBuf = null;
      try {
        rawBuf = fs.readFileSync(scriptPath);
      } catch {}
      if (rawBuf && needsUtf8BomStaging(rawBuf)) {
        const scriptDir = path.dirname(scriptPath);
        const stageFileName = `agy-dart-psfile-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.ps1`;
        const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rawBuf]);
        const preferredDir = isEphemeralScriptStageDir(scriptDir) ? scriptDir : os.tmpdir();
        try {
          const candidate = path.join(preferredDir, stageFileName);
          fs.writeFileSync(candidate, bomBuf, { mode: 0o600 });
          stagedBomPs1 = candidate;
        } catch {
          if (preferredDir !== os.tmpdir()) {
            const fallback = path.join(os.tmpdir(), stageFileName);
            fs.writeFileSync(fallback, bomBuf, { mode: 0o600 });
            stagedBomPs1 = fallback;
          }
        }
      }
      return await invokePowerShellFileWithUtf8(bin, stagedBomPs1 || scriptPath);
    } finally {
      if (stagedBomPs1) {
        try {
          fs.rmSync(stagedBomPs1, { force: true });
        } catch {}
      }
    }
  };
  const runPowerShellCommand = async (bin, scriptText) => {
    const psScript = scriptText || "";
    const leadingParam = hasLeadingPsParamBlock(psScript);
    if (safeArgs.length === 0 && !leadingParam) {
      return runProcess({
        cmd: bin,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", withPsUtf8Prelude(psScript)],
        cwd: workdir,
        timeoutMs,
        env: childEnv
      });
    }
    // Execute via ephemeral UTF-8-BOM .ps1 + UTF-8 console prelude wrapper so literal safeArgs and
    // leading param(...) blocks preserve UTF-8 stdout, exit N & $LASTEXITCODE with zero __AGY_PS_* leaks.
    let tmpPs1 = "";
    try {
      tmpPs1 = path.join(os.tmpdir(), `agy-dart-ps-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.ps1`);
      fs.writeFileSync(tmpPs1, `\uFEFF${withPsUtf8Prelude(psScript)}`, { encoding: "utf8", mode: 0o600 });
      return await invokePowerShellFileWithUtf8(bin, tmpPs1);
    } catch {
      const psEnv = { ...childEnv, __AGY_PS_CODE: psScript };
      const clearStmts = ["Remove-Item Env:__AGY_PS_CODE -ErrorAction SilentlyContinue"];
      const psArgItems = safeArgs.map((arg, idx) => {
        const key = `__AGY_PS_ARG_${idx}`;
        psEnv[key] = arg;
        clearStmts.push(`Remove-Item Env:${key} -ErrorAction SilentlyContinue`);
        return `$env:${key}`;
      });
      const wrapper = `${PS_UTF8_PRELUDE} $__agyCode = $env:__AGY_PS_CODE; $__agyArgs = @(${psArgItems.join(", ")}); ${clearStmts.join("; ")}; $global:LASTEXITCODE = $null; & ([scriptblock]::Create($__agyCode)) @__agyArgs; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
      return runProcess({
        cmd: bin,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapper],
        cwd: workdir,
        timeoutMs,
        env: psEnv
      });
    } finally {
      if (tmpPs1) {
        try {
          fs.rmSync(tmpPs1, { force: true });
        } catch {}
      }
    }
  };

  if (normLang === "pwsh" || normLang === "powershell") {
    const bin = process.platform === "win32" ? "powershell.exe" : "pwsh";
    if (trimmedFile) {
      const scriptPath = path.isAbsolute(trimmedFile) ? trimmedFile : path.resolve(workdir, trimmedFile);
      if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(scriptPath)) {
        return runCmdBatchFile(scriptPath);
      }
      return executePowerShellScriptFile(bin, scriptPath);
    }
    return runPowerShellCommand(bin, effectiveCode);
  }

  // 4. Windows CMD
  if (normLang === "cmd" || normLang === "bat") {
    if (trimmedFile) {
      const scriptPath = path.isAbsolute(trimmedFile) ? trimmedFile : path.resolve(workdir, trimmedFile);
      return runCmdBatchFile(scriptPath);
    }
    return runProcess({
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", effectiveCode || ""],
      cwd: workdir,
      timeoutMs,
      env: childEnv
    });
  }

  // 5. Default Shell
  if (process.platform === "win32") {
    if (trimmedFile) {
      const scriptPath = path.isAbsolute(trimmedFile) ? trimmedFile : path.resolve(workdir, trimmedFile);
      if (/\.(?:bat|cmd)$/i.test(scriptPath)) {
        return runCmdBatchFile(scriptPath);
      }
      return executePowerShellScriptFile("powershell.exe", scriptPath);
    }
    return runPowerShellCommand("powershell.exe", effectiveCode || "");
  } else {
    const shell = process.env.SHELL || "/bin/sh";
    if (trimmedFile) {
      const scriptPath = path.isAbsolute(trimmedFile) ? trimmedFile : path.resolve(workdir, trimmedFile);
      return runProcess({
        cmd: shell,
        args: [scriptPath, ...safeArgs],
        cwd: workdir,
        timeoutMs,
        env: childEnv
      });
    }
    return runProcess({
      cmd: shell,
      args: safeArgs.length > 0 ? ["-c", effectiveCode || "", "--", ...safeArgs] : ["-c", effectiveCode || ""],
      cwd: workdir,
      timeoutMs,
      env: childEnv
    });
  }
}
