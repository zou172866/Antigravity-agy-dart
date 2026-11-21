// agy-fast MCP Stdio Server (bundled zero-dependency ESM)
import { enableVersionedCompileCache } from "../hooks/compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";
try {
  enableVersionedCompileCache();
} catch {}

// src/protocol/mcp.ts
var SUPPORTED_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
var DEFAULT_PROTOCOL_VERSION = "2025-03-26";
function stableSortObject(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stableSortObject(item));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[key] = stableSortObject(value[key]);
  }
  return sorted;
}
var McpStdioServer = class {
  tools = /* @__PURE__ */ new Map();
  serverName;
  serverVersion;
  inFlight = 0;
  stdinEnded = false;
  onDrainExit;
  constructor(options) {
    this.serverName = options.name;
    this.serverVersion = options.version;
  }
  registerTool(definition, handler) {
    this.tools.set(definition.name, { definition, handler });
  }
  async handleMessage(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      };
    }
    const msg = raw;
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== void 0;
    const id = hasId ? msg.id ?? null : null;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!hasId) {
      return null;
    }
    if (!method) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: missing method" }
      };
    }
    if (method === "initialize") {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion.trim() : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion
          }
        }
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      const definitions = [...this.tools.values()]
        .map((t) => stableSortObject(t.definition))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { jsonrpc: "2.0", id, result: { tools: definitions } };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }
    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }
    if (method === "tools/call") {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = this.tools.get(name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        };
      }
      const rawArgs = msg.params?.arguments;
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
      try {
        const res = await tool.handler(args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: res.text }],
            isError: Boolean(res.isError)
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Tool error: ${message}` }],
            isError: true
          }
        };
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }
  listen(input = process.stdin, output = process.stdout, onExit) {
    this.onDrainExit = onExit;
    let buffer = Buffer.alloc(0);
    const writeResponse = (payload, useContentLength) => {
      const serialized = JSON.stringify(payload);
      if (useContentLength) {
        const len = Buffer.byteLength(serialized, "utf8");
        output.write(`Content-Length: ${len}\r
\r
${serialized}`);
      } else {
        output.write(`${serialized}
`);
      }
    };
    const dispatchRawJson = (jsonText, useContentLength) => {
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        writeResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" }
          },
          useContentLength
        );
        return;
      }
      this.inFlight += 1;
      const finish = () => {
        this.inFlight -= 1;
        if (this.stdinEnded && this.inFlight === 0) {
          this.onDrainExit?.();
        }
      };
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          writeResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request: empty batch" }
            },
            useContentLength
          );
          finish();
          return;
        }
        Promise.all(parsed.map((item) => this.handleMessage(item))).then((responses) => {
          const nonNull = responses.filter(
            (r) => r !== null
          );
          if (nonNull.length > 0) {
            writeResponse(nonNull, useContentLength);
          }
        }).finally(finish);
        return;
      }
      this.handleMessage(parsed).then((response) => {
        if (response !== null) {
          writeResponse(response, useContentLength);
        }
      }).finally(finish);
    };
    const drainBuffer = () => {
      while (buffer.length > 0) {
        let offset = 0;
        while (offset < buffer.length && (buffer[offset] === 10 || buffer[offset] === 13)) {
          offset++;
        }
        if (offset > 0) {
          buffer = buffer.subarray(offset);
          if (buffer.length === 0) break;
        }
        const headerProbe = buffer.subarray(0, 16).toString("ascii").toLowerCase();
        if (headerProbe.startsWith("content-length:") || headerProbe.startsWith("content-type:")) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          const altHeaderEnd = headerEnd === -1 ? buffer.indexOf("\n\n") : -1;
          const sepIdx = headerEnd !== -1 ? headerEnd : altHeaderEnd;
          const sepLen = headerEnd !== -1 ? 4 : 2;
          if (sepIdx === -1) break;
          const headerText = buffer.subarray(0, sepIdx).toString("ascii");
          const match = /content-length:\s*(\d+)/i.exec(headerText);
          if (!match) {
            buffer = buffer.subarray(sepIdx + sepLen);
            continue;
          }
          const contentLength = Number.parseInt(match[1], 10);
          const bodyStart = sepIdx + sepLen;
          if (buffer.length < bodyStart + contentLength) {
            break;
          }
          const bodyText = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLength);
          dispatchRawJson(bodyText, true);
          continue;
        }
        const newlineIdx = buffer.indexOf(10);
        if (newlineIdx === -1) break;
        const lineBuf = buffer.subarray(0, newlineIdx);
        buffer = buffer.subarray(newlineIdx + 1);
        const line = lineBuf.toString("utf8").trim();
        if (line.length > 0) {
          dispatchRawJson(line, false);
        }
      }
    };
    input.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
      drainBuffer();
    });
    input.on("end", () => {
      const remaining = buffer.toString("utf8").trim();
      buffer = Buffer.alloc(0);
      const lowerRem = remaining.toLowerCase();
      if (remaining.length > 0 && !lowerRem.startsWith("content-length:") && !lowerRem.startsWith("content-type:")) {
        dispatchRawJson(remaining, false);
      }
      this.stdinEnded = true;
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
    input.on("error", () => {
      this.stdinEnded = true;
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
  }
};

// src/tools/apply-edits.ts
import { promises as fs2 } from "node:fs";
import path2 from "node:path";

// src/utils/exec-utils.ts
import { spawn } from "node:child_process";
var DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
function killChildTree(pid, detached) {
  if (!pid) return;
  if (process.platform === "win32") {
    const fallbackKill = () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    };
    try {
      const sysRoot = process.env.SystemRoot || process.env.WINDIR;
      const taskkillBin = sysRoot ? path2.join(sysRoot, "System32", "taskkill.exe") : "taskkill";
      const killer = spawn(taskkillBin, ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", fallbackKill);
      killer.unref();
    } catch {
      fallbackKill();
    }
    return;
  }
  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
  }
  setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
    }
  }, 400).unref();
}
function execBinaryAsync(bin, args, options) {
  return spawnAndCollect(bin, args, false, options);
}
function runShellCommandAsync(command, options) {
  return spawnAndCollect(command, [], true, options);
}
function spawnAndCollect(commandOrBin, args, shell, options) {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";
  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    let settleFallbackTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated,
        error
      });
    };
    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        truncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on("error", (err) => {
      finish(null, null, err.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
var cachedRgAvailable = null;
async function isRipgrepAvailable() {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  const res = await execBinaryAsync("rg", ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 2e3,
    maxOutputBytes: 4096
  });
  cachedRgAvailable = !res.error && res.exitCode === 0;
  return cachedRgAvailable;
}

// src/utils/fs-utils.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor"
]);
function expandHome(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
function resolvePath(inputPath, baseDir) {
  const expanded = expandHome(inputPath.trim());
  const root = baseDir ? path.resolve(expandHome(baseDir)) : process.cwd();
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(root, expanded);
}
function toPosixPath(p) {
  return p.split(path.sep).join("/");
}
function isLikelyBinary(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
async function readTextFile(filePath, maxBytes = 10 * 1024 * 1024) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File exceeds maximum size (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`
    );
  }
  const buf = await fs.readFile(filePath);
  if (isLikelyBinary(buf)) {
    throw new Error(`Binary file cannot be read as text: ${filePath}`);
  }
  const content = buf.toString("utf8");
  let crlfCount = 0;
  let lfCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      if (i > 0 && content[i - 1] === "\r") crlfCount++;
      else lfCount++;
    }
  }
  const eol = crlfCount > lfCount ? "\r\n" : "\n";
  return { content, eol, crlfCount, lfCount, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 4095, rawBuffer: buf };
}
function globToRegExp(pattern) {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = normalized.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = normalized.slice(i + 1, close).replace(/\\/g, "\\\\");
        if (inner.startsWith("!")) inner = "^" + inner.slice(1);
        re += `[${inner}]`;
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = findMatchingBrace(normalized, i);
      if (close === -1) {
        re += "\\{";
        i += 1;
      } else {
        const parts = splitBraceAlternatives(normalized.slice(i + 1, close));
        const sub = parts.map((part) => globToRegExp(part).source.slice(1, -1)).join("|");
        re += `(?:${sub})`;
        i = close + 1;
      }
    } else if (".+^$()|\\".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += "$";
  try {
    return new RegExp(re);
  } catch (err) {
    throw new Error(
      `Invalid glob pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function findMatchingBrace(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitBraceAlternatives(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}
async function walkFiles(rootDir, options = {}) {
  const maxFiles = options.maxFiles ?? 5e3;
  const maxDepth = options.maxDepth ?? 32;
  const includeHidden = options.includeHidden ?? false;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const fileFilter = options.fileFilter;
  const files = [];
  let truncated = false;
  async function visit(dir, relDir, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs = [];
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        if (!(entry.isDirectory() && name === ".agents")) {
          continue;
        }
      }
      const absPath = path.join(dir, name);
      const relPosix = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        subdirs.push({ abs: absPath, rel: relPosix });
      } else if (entry.isFile()) {
        if (fileFilter && !fileFilter(relPosix)) continue;
        files.push(relPosix);
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
    const batchSize = 8;
    for (let i = 0; i < subdirs.length && !truncated; i += batchSize) {
      const slice = subdirs.slice(i, i + batchSize);
      await Promise.all(slice.map((sub) => visit(sub.abs, sub.rel, depth + 1)));
    }
  }
  await visit(rootDir, "", 0);
  return { files, truncated };
}

// src/utils/output-filter.ts
var ANSI_REGEX = (
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g
);
function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}
function normalizeTerminalOutput(raw) {
  const clean = stripAnsi(raw).replace(/\r\n/g, "\n");
  return clean.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? "";
  }).join("\n").trimEnd();
}
var DEFAULT_INLINE_MAX_BYTES = 8800;
function sliceUtf8Bytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const unitLen = cp > 65535 ? 2 : 1;
    const chBytes = cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}
function truncateWithByteNotice(text, maxBytes) {
  if (maxBytes <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;
  if (maxBytes < 56) {
    if (maxBytes <= 3) return sliceUtf8Bytes(text, maxBytes);
    return `${sliceUtf8Bytes(text, maxBytes - 3)}...`;
  }
  const maxNoticeBytes = Buffer.byteLength(
    `
... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8"
  );
  const cutoffBytes = Math.max(0, maxBytes - maxNoticeBytes);
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}
... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= maxBytes ? result : sliceUtf8Bytes(result, maxBytes);
}
function truncateWithNotice(text, maxChars) {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars < 48) {
    if (maxChars <= 3) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 3)}...`;
  }
  const maxNoticeLen = `
... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, maxChars - maxNoticeLen);
  let slice = text.slice(0, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}
... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= maxChars ? result : result.slice(0, maxChars);
}
function fitSectionsToBudget(sections, maxChars, separator = "\n\n") {
  if (sections.length === 0 || maxChars <= 0) return "";
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;
  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateWithNotice(joined, maxChars);
  }
  let remainingBudget = maxChars - sepTotal;
  const budgets = new Array(sections.length).fill(0);
  const order = sections.map((s, idx) => ({ idx, len: s.length })).sort((a, b) => a.len - b.len);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i];
    if (item.len <= share) {
      budgets[item.idx] = item.len;
      remainingBudget -= item.len;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j].idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }
  const fitted = sections.map((sec, idx) => truncateWithNotice(sec, budgets[idx] ?? 0)).join(separator);
  return fitted.length <= maxChars ? fitted : truncateWithNotice(fitted, maxChars);
}
function fitSectionsToByteBudget(sections, maxChars, maxBytes, separator = "\n\n") {
  const charFitted = fitSectionsToBudget(sections, maxChars, separator);
  if (maxBytes === void 0 || Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }
  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateWithByteNotice(charFitted, maxBytes);
  }
  let remainingBytes = maxBytes - sepBytes;
  const byteBudgets = new Array(sections.length).fill(0);
  const order = sections.map((s, idx) => ({ idx, bytes: Buffer.byteLength(s, "utf8") })).sort((a, b) => a.bytes - b.bytes);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBytes / remainingCount);
    const item = order[i];
    if (item.bytes <= share) {
      byteBudgets[item.idx] = item.bytes;
      remainingBytes -= item.bytes;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBytes / rem);
        byteBudgets[order[j].idx] = alloc;
        remainingBytes -= alloc;
      }
      break;
    }
  }
  let fitted = sections.map((sec, idx) => truncateWithByteNotice(sec, byteBudgets[idx] ?? 0)).join(separator);
  if (fitted.length > maxChars) {
    fitted = truncateWithNotice(fitted, maxChars);
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes ? fitted : truncateWithByteNotice(fitted, maxBytes);
}
var ERROR_LINE_PATTERN = /(?:\berr!|\b(?:error|fail|failed|failing|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;
var ROOT_CAUSE_HEADER_PATTERN = /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯+\s*failed tests|compilation error)/i;
var JSON_INFO_LOG_PATTERNS = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i
];
var ALWAYS_NOISE_LINE_PATTERNS = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/
];
var FAILURE_PROTECT_PATTERN = /\b(?:error|fail(?:ed|ure|ing)?|exception|fatal|assert(?:ion)?|panic|traceback)\b|[A-Za-z]+(?:Error|Exception)\b|\berr!|✖|✗/i;
var PASS_PROGRESS_NOISE_PATTERNS = [
  /^\s*[✔✓]\s*/,
  /^\s*---\s*PASS:/,
  /^\s*ok\s+\d+\b/,
  /^\s*npm\s+warn\s+deprecated\b/i,
  /\blooking for funding\b/i
];
function isFailureNoiseLine(line) {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(line);
  }
  if (FAILURE_PROTECT_PATTERN.test(line)) return false;
  if (PASS_PROGRESS_NOISE_PATTERNS.some((re) => re.test(line))) return true;
  return false;
}
var SUMMARY_LINE_PATTERN = /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;
function formatCompactCommandOutput(params) {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");
  if (params.error) {
    return truncateWithNotice(`spawn error: ${params.error}`, params.maxChars);
  }
  if (params.timedOut) {
    const tail = getTailLines(combined, 20);
    return truncateWithNotice(
      tail ? `TIMED OUT
${tail}` : "TIMED OUT (no output)",
      params.maxChars
    );
  }
  if (params.exitCode === 0) {
    if (!combined) return "OK";
    const lines2 = combined.split("\n").map((l) => l.trim()).filter(Boolean);
    const summaryLines = lines2.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked = summaryLines.length > 0 ? summaryLines.slice(-2) : lines2.length <= 2 ? lines2 : [lines2[lines2.length - 1]];
    return truncateWithNotice(picked.join(" | "), Math.min(params.maxChars, 320));
  }
  const rawLines = combined.split("\n");
  const filteredLines = rawLines.filter((line) => !isFailureNoiseLine(line));
  const lines = filteredLines.length > 0 ? filteredLines : rawLines;
  const cleanedCombined = lines.join("\n");
  if (cleanedCombined.length <= params.maxChars) {
    return cleanedCombined || `Exited with code ${params.exitCode ?? "unknown"}`;
  }
  const keepIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (ERROR_LINE_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }
  const tailStart = Math.max(0, lines.length - 12);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }
  const sorted = [...keepIndices].sort((a, b) => a - b);
  const outLines = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) {
      outLines.push(`... (${idx - prev - 1} lines omitted) ...`);
    }
    outLines.push(lines[idx]);
    prev = idx;
  }
  return truncateWithNotice(outLines.join("\n"), params.maxChars);
}
function getTailLines(text, count) {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}

// src/tools/apply-edits.ts
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}
function getLineWindowOffsets(text, lineStarts, startLine, endLine) {
  if (startLine !== void 0 && (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (endLine !== void 0 && (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }
  const totalLines = lineStarts.length;
  const sLine = startLine !== void 0 ? Math.trunc(startLine) : 1;
  const eLine = endLine !== void 0 ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;
  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }
  const windowStart = lineStarts[sLine - 1];
  const windowEnd = eLine < totalLines ? lineStarts[eLine] : text.length;
  return { windowStart, windowEnd };
}
var MAX_NEARBY_LINES = 26;
function formatNearbyLines(text, startLine, endLine) {
  const lines = text.split("\n");
  if (startLine === void 0 && endLine === void 0) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${lineText.slice(0, 157)}...` : lineText}`
    );
  }
  const extra = truncated ? `
    ... (${rawTo - to} more lines in range omitted)` : "";
  return `
  Nearby lines (${from}-${to}):
${snippet.join("\n")}${extra}`;
}
function extractLineTokens(trimmedLine) {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine.split(/\s+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}
function findClosestRegionSnippet(normalizedContent, normTarget, rangeStartLine, rangeEndLine) {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";
  const targetLines = normTarget.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";
  const firstAnchor = targetLines.find((l) => l.length >= 6) ?? targetLines[0];
  let longestAnchor = targetLines[0];
  for (const tl of targetLines) {
    if (tl.length > longestAnchor.length) longestAnchor = tl;
  }
  const anchors = [firstAnchor];
  if (longestAnchor !== firstAnchor) anchors.push(longestAnchor);
  const lastAnchor = targetLines[targetLines.length - 1];
  if (lastAnchor.length >= 6 && !anchors.includes(lastAnchor)) {
    anchors.push(lastAnchor);
  }
  const primaryTokens = new Set(extractLineTokens(firstAnchor));
  const longestTokens = new Set(extractLineTokens(longestAnchor));
  const trimmedFileLines = fileLines.map((l) => l.trim());
  let bestIdx = -1;
  let bestScore = 0;
  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1);
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1
  );
  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i];
    if (!line) continue;
    let score = 0;
    if (line === firstAnchor) {
      score += 10;
    } else if (firstAnchor.length >= 8 && (line.includes(firstAnchor) || firstAnchor.includes(line))) {
      score += 6;
    } else if (primaryTokens.size > 0) {
      const lineTokens = extractLineTokens(line);
      let hits = 0;
      for (const tok of lineTokens) {
        if (primaryTokens.has(tok)) hits += 1;
      }
      if (hits >= 2 || hits >= 1 && primaryTokens.size <= 2 && hits === primaryTokens.size) {
        score += 4 * (hits / primaryTokens.size);
      }
    }
    if (longestAnchor !== firstAnchor) {
      if (line === longestAnchor) {
        score += 8;
      } else if (longestAnchor.length >= 10 && line.includes(longestAnchor)) {
        score += 5;
      } else if (longestTokens.size >= 2) {
        const lineTokens = extractLineTokens(line);
        let hits = 0;
        for (const tok of lineTokens) {
          if (longestTokens.has(tok)) hits += 1;
        }
        if (hits >= 2) {
          score += 3 * (hits / longestTokens.size);
        }
      }
    }
    if (score >= 2 && targetLines.length > 1) {
      const lookahead = Math.min(targetLines.length, 6);
      for (let k = 1; k < lookahead && i + k < trimmedFileLines.length; k++) {
        const nextLine = trimmedFileLines[i + k];
        const tgtLine = targetLines[k];
        if (nextLine && tgtLine && (nextLine === tgtLine || tgtLine.length >= 8 && nextLine.includes(tgtLine))) {
          score += 3;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 2.5) return "";
  const span = Math.min(Math.max(targetLines.length, 4), 8);
  const from = Math.max(1, bestIdx + 1 - 2);
  const to = Math.min(fileLines.length, Math.min(from + 13, bestIdx + 1 + span + 2));
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${lineText.slice(0, 157)}...` : lineText}`
    );
  }
  return `
  Closest match near line ${bestIdx + 1} (lines ${from}-${to}):
${snippet.join("\n")}`;
}
function planHunksForContent(normalizedContent, hunks, displayPath) {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans = [];
  const errors = [];
  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }
    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");
    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const foundOffsets = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }
    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== void 0 || hunk.endLine !== void 0;
      const rangeNote = hasRange ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}` : "";
      let hint = "";
      if (hasRange) {
        const globalOffsets = [];
        let gPos = 0;
        while (gPos <= normalizedContent.length - normTarget.length && globalOffsets.length < 5) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets.map((o) => `L${offsetToLine(lineStarts, o)}`).join(", ");
          hint = ` Exact match found outside range at ${hitLines} \u2014 adjust startLine/endLine or omit them.`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint = findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) || findClosestRegionSnippet(normalizedContent, normTarget) || formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`
      );
      continue;
    }
    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets.slice(0, 10).map((o) => offsetToLine(lineStarts, o)).join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`
      );
      continue;
    }
    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx
      });
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const curr = spans[i];
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`
      );
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));
  return {
    newNormalized: pieces.join(""),
    spans,
    appliedMatches: spans.length,
    errors: []
  };
}
function applySpansPreservingEol(rawContent, spans, dominantEol) {
  const normToRaw = [];
  for (let r = 0; r < rawContent.length; r++) {
    normToRaw.push(r);
    if (rawContent[r] === "\r" && rawContent[r + 1] === "\n") {
      r++;
    }
  }
  normToRaw.push(rawContent.length);
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(rawContent.slice(normToRaw[cursor], normToRaw[span.start]));
    const rep = dominantEol === "\r\n" ? span.replacement.replace(/\n/g, "\r\n") : span.replacement;
    pieces.push(rep);
    cursor = span.end;
  }
  pieces.push(rawContent.slice(normToRaw[cursor]));
  return pieces.join("");
}
function countLines(text) {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}
async function commitPlannedWrites(plans) {
  const written = [];
  const RENAME_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "EACCES", "EBUSY"]);
  try {
    for (const plan of plans) {
      const target = plan.writeTargetPath;
      const dir = path2.dirname(target);
      await fs2.mkdir(dir, { recursive: true });
      const tmpPath = `${target}.agy-fast-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs2.writeFile(tmpPath, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          await fs2.chmod(tmpPath, plan.originalMode);
        }
      } catch (tmpErr) {
        try {
          await fs2.unlink(tmpPath);
        } catch {
        }
        throw tmpErr;
      }
      try {
        await fs2.rename(tmpPath, target);
        written.push(plan);
      } catch (renameErr) {
        try {
          await fs2.unlink(tmpPath);
        } catch {
        }
        if (!renameErr || !RENAME_FALLBACK_CODES.has(renameErr.code)) {
          throw renameErr;
        }
        written.push(plan);
        await fs2.writeFile(target, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          try {
            await fs2.chmod(target, plan.originalMode);
          } catch {
          }
        }
      }
    }
  } catch (err) {
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i];
      const target = item.writeTargetPath;
      try {
        if (item.existed && item.originalBuffer !== null) {
          await fs2.writeFile(target, item.originalBuffer);
          if (item.originalMode !== null && process.platform !== "win32") {
            await fs2.chmod(target, item.originalMode);
          }
        } else if (!item.existed) {
          await fs2.unlink(target);
        }
      } catch {
      }
    }
    throw err;
  }
}
async function runApplyEdits(input) {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true
    };
  }
  if (input.edits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  const mergedByPath = /* @__PURE__ */ new Map();
  const errors = [];
  for (let i = 0; i < input.edits.length; i++) {
    const entry = input.edits[i];
    if (!entry || typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }
    const absPath = resolvePath(entry.path, baseCwd);
    let writeTargetPath = absPath;
    try {
      writeTargetPath = await fs2.realpath(absPath);
    } catch {
    }
    const relPath = toPosixPath(path2.relative(baseCwd, absPath)) || path2.basename(absPath);
    const hasCreate = typeof entry.create === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;
    if (!hasCreate && !hasHunks) {
      errors.push(`${relPath}: must specify either non-empty 'hunks' or 'create'`);
      continue;
    }
    if (hasCreate && hasHunks) {
      errors.push(`${relPath}: cannot specify both 'create' and 'hunks' on the same entry`);
      continue;
    }
    const mergeKey = normalizeFileCacheKey(writeTargetPath);
    const existing = mergedByPath.get(mergeKey);
    if (!existing) {
      mergedByPath.set(mergeKey, {
        absPath,
        writeTargetPath,
        relPath,
        create: hasCreate ? entry.create : void 0,
        overwrite: entry.overwrite,
        hunks: hasHunks ? [...entry.hunks] : []
      });
    } else {
      if (hasCreate || existing.create !== void 0) {
        errors.push(`${relPath}: duplicate entries cannot mix 'create' with other edits`);
        continue;
      }
      existing.hunks.push(...entry.hunks);
    }
  }
  if (errors.length > 0) {
    return {
      text: `Validation failed (0 files modified):
- ${errors.join("\n- ")}`,
      isError: true
    };
  }
  const plans = [];
  for (const item of mergedByPath.values()) {
    if (item.create !== void 0) {
      let exists = false;
      let originalBuffer = null;
      let originalMode = null;
      let lstatRes = null;
      try {
        lstatRes = await fs2.lstat(item.writeTargetPath);
      } catch (err) {
        if (!err || err.code !== "ENOENT") {
          errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      if (lstatRes) {
        exists = true;
        let st = lstatRes;
        if (lstatRes.isSymbolicLink()) {
          try {
            st = await fs2.stat(item.writeTargetPath);
          } catch (err) {
            if (!item.overwrite) {
              errors.push(
                `${item.relPath}: file already exists (set overwrite: true to replace it)`
              );
              continue;
            }
            if (err && err.code !== "ENOENT") {
              errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
            st = null;
          }
        }
        if (st && st.isDirectory()) {
          errors.push(`${item.relPath}: target path is a directory`);
          continue;
        }
        if (!item.overwrite) {
          errors.push(
            `${item.relPath}: file already exists (set overwrite: true to replace it)`
          );
          continue;
        }
        if (st) {
          originalMode = st.mode & 4095;
          try {
            originalBuffer = await fs2.readFile(item.writeTargetPath);
          } catch (err) {
            errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
      }
      const oldLines = originalBuffer ? countLines(originalBuffer.toString("utf8")) : 0;
      const newLines = countLines(item.create);
      plans.push({
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: exists,
        originalBuffer,
        originalMode,
        newContent: item.create,
        hunkCount: 1,
        lineDelta: newLines - oldLines,
        created: !exists
      });
      continue;
    }
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }
    const finalContent = fileData.crlfCount > 0 && fileData.lfCount > 0 ? applySpansPreservingEol(fileData.content, planned.spans, fileData.eol) : fileData.eol === "\r\n" ? planned.newNormalized.replace(/\n/g, "\r\n") : planned.newNormalized;
    const lineDelta = countLines(planned.newNormalized) - countLines(normalizedOriginal);
    plans.push({
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent: finalContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false
    });
  }
  const bestEffort = Boolean(input.bestEffort);
  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const prefix = bestEffort ? "Edit aborted (0 files modified):" : "Atomic edit aborted (0 files modified):";
    return {
      text: truncateWithByteNotice(
        `${prefix}
- ${errors.join("\n- ")}`,
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  if (!input.dryRun) {
    try {
      await commitPlannedWrites(plans);
    } catch (err) {
      await invalidateFileCaches(plans.flatMap((p) => [p.absPath, p.writeTargetPath]));
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }
    await invalidateFileCaches(plans.flatMap((p) => [p.absPath, p.writeTargetPath]));
  }
  const summaryLines = plans.map((p) => {
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created ? "created" : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });
  if (bestEffort && errors.length > 0) {
    const totalFiles = mergedByPath.size;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const partialHeader = input.dryRun ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):` : `Partial edit applied (${plans.length}/${totalFiles} file(s) written; ${failedFileCount} file(s) failed \u2014 do NOT re-send applied files):`;
    const partialParts = [
      partialHeader,
      `Applied:
${summaryLines.join("\n")}`,
      `Failed (fix only these):
- ${errors.join("\n- ")}`
    ];
    if (!input.dryRun && input.verify) {
      partialParts.push(
        "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify."
      );
    }
    return {
      text: truncateWithByteNotice(
        partialParts.join("\n\n"),
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  const header = input.dryRun ? `Dry run validated ${plans.length} file(s) (0 files modified):` : `Applied edits to ${plans.length} file(s):`;
  const parts = [`${header}
${summaryLines.join("\n")}`];
  if (!input.dryRun && input.verify) {
    const verifySpec = typeof input.verify === "string" ? { command: input.verify } : input.verify;
    if (verifySpec.command && verifySpec.command.trim()) {
      const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
      const timeoutMs = clampIntWithDefault(
        verifySpec.timeoutSec ?? input.verifyTimeoutSec,
        60,
        1,
        300
      ) * 1e3;
      const maxVerifyChars = clampIntWithDefault(
        input.maxVerifyChars,
        4e3,
        300,
        7500
      );
      const res = await runShellCommandAsync(verifySpec.command, {
        cwd: verifyCwd,
        timeoutMs
      });
      BATCH_SEARCH_CACHE.clear();
      const status = res.timedOut ? "TIMEOUT" : res.exitCode === 0 ? "PASS" : `FAIL (exit ${res.exitCode ?? "err"})`;
      const formatted = formatCompactCommandOutput({
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        error: res.error,
        maxChars: maxVerifyChars
      });
      parts.push(
        `
Verify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:
${formatted}`
      );
    }
  }
  const outText = parts.join("\n");
  const finalText = truncateWithByteNotice(outText, DEFAULT_INLINE_MAX_BYTES);
  return { text: finalText, isError: false };
}

// src/tools/batch-search.ts
import { promises as fs3 } from "node:fs";
import path3 from "node:path";
var READONLY_GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "tag",
  "remote"
]);
var FORBIDDEN_GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "-c",
  "--config",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--textconv",
  "--output",
  "--exec",
  "--upload-pack",
  "--git-dir",
  "--work-tree"
]);
var ALLOWED_BRANCH_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-abbrev",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--quiet"
]);
var ALLOWED_BRANCH_OPTARG_FLAGS = /* @__PURE__ */ new Set([
  "--abbrev",
  "--color",
  "--column"
]);
var ALLOWED_BRANCH_OPTIONAL_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains"
]);
var ALLOWED_BRANCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--points-at",
  "--sort",
  "--format"
]);
var ALLOWED_BRANCH_SHORT_CHARS = /* @__PURE__ */ new Set(["a", "r", "v", "l", "q", "i"]);
var ALLOWED_TAG_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--list",
  "--verify",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column"
]);
var ALLOWED_TAG_OPTARG_FLAGS = /* @__PURE__ */ new Set([
  "--color",
  "--column"
]);
var ALLOWED_TAG_OPTIONAL_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at"
]);
var ALLOWED_TAG_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--sort",
  "--format"
]);
var ALLOWED_TAG_SHORT_CHARS = /* @__PURE__ */ new Set(["l", "v", "i"]);
var ALLOWED_REMOTE_SUBCOMMANDS = /* @__PURE__ */ new Set(["show", "get-url"]);
function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("Unterminated quote in git query");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
function validateReadonlyGitArgs(pattern) {
  const rawTokens = tokenizeArgs(pattern.trim());
  const tokens = rawTokens[0] === "git" ? rawTokens.slice(1) : rawTokens;
  if (tokens.length === 0) {
    throw new Error("Empty git query. Example: 'status --short' or 'log -n 5 --oneline'");
  }
  const subcmd = tokens[0];
  if (subcmd.startsWith("-")) {
    throw new Error(
      `Git query must start with a read-only subcommand (got '${subcmd}')`
    );
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(
      `Git subcommand '${subcmd}' is not allowed in batch_search (read-only only: ${[...READONLY_GIT_SUBCOMMANDS].join(", ")})`
    );
  }
  const rest = tokens.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const prev = i > 0 ? rest[i - 1] : "";
    const isSortOrFormatVal = prev === "--sort" || prev === "--format";
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (
      FORBIDDEN_GIT_GLOBAL_FLAGS.has(flagName) ||
      arg.startsWith("--output=") ||
      (!isSortOrFormatVal && arg.startsWith("-c") && arg.length > 2)
    ) {
      throw new Error(`Flag '${arg}' is not allowed in read-only git query`);
    }
  }
  if (subcmd === "branch") {
    let hasListFlag = false;
    let expectValueFor = null;
    let optionalValueFor = null;
    for (const arg of rest) {
      if (expectValueFor) {
        if (arg.startsWith("-") && expectValueFor !== "--sort" && expectValueFor !== "--format") {
          throw new Error(`Flag '${arg}' is not allowed as value for '${expectValueFor}' in read-only git branch query`);
        }
        expectValueFor = null;
        continue;
      }
      if (optionalValueFor) {
        optionalValueFor = null;
        if (!arg.startsWith("-")) {
          continue;
        }
      }
      if (arg === "--") {
        if (!hasListFlag) {
          throw new Error(
            "Positional branch arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (
            !ALLOWED_BRANCH_OPTARG_FLAGS.has(flagName) &&
            !ALLOWED_BRANCH_OPTIONAL_VALUE_FLAGS.has(flagName) &&
            !ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)
          ) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
        } else if (ALLOWED_BRANCH_OPTARG_FLAGS.has(flagName)) {
          // PARSE_OPT_OPTARG flags without '=' never consume a separate token in git
        } else if (ALLOWED_BRANCH_OPTIONAL_VALUE_FLAGS.has(flagName)) {
          optionalValueFor = flagName;
        } else if (ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
          expectValueFor = flagName;
        } else if (!ALLOWED_BRANCH_BOOL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
        }
        if (flagName === "--list") hasListFlag = true;
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_BRANCH_SHORT_CHARS.has(ch)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
          if (ch === "l") hasListFlag = true;
        }
      } else if (!hasListFlag) {
        throw new Error(
          `Positional branch argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "tag") {
    let allowsPositionals = false;
    let expectValueFor = null;
    let optionalValueFor = null;
    for (const arg of rest) {
      if (expectValueFor) {
        if (arg.startsWith("-") && expectValueFor !== "--sort" && expectValueFor !== "--format") {
          throw new Error(`Flag '${arg}' is not allowed as value for '${expectValueFor}' in read-only git tag query`);
        }
        expectValueFor = null;
        continue;
      }
      if (optionalValueFor) {
        optionalValueFor = null;
        if (!arg.startsWith("-")) {
          continue;
        }
      }
      if (arg === "--") {
        if (!allowsPositionals) {
          throw new Error(
            "Positional tag arguments are only allowed with --list or --verify in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (
            !ALLOWED_TAG_OPTARG_FLAGS.has(flagName) &&
            !ALLOWED_TAG_OPTIONAL_VALUE_FLAGS.has(flagName) &&
            !ALLOWED_TAG_VALUE_FLAGS.has(flagName)
          ) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
          }
        } else if (ALLOWED_TAG_OPTARG_FLAGS.has(flagName)) {
          // PARSE_OPT_OPTARG flags without '=' never consume a separate token in git
        } else if (ALLOWED_TAG_OPTIONAL_VALUE_FLAGS.has(flagName)) {
          optionalValueFor = flagName;
        } else if (ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
          expectValueFor = flagName;
        } else if (!ALLOWED_TAG_BOOL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
        }
        if (flagName === "--list" || flagName === "--verify") {
          allowsPositionals = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        if (/^-n\d*$/.test(arg)) {
          allowsPositionals = true;
        } else {
          for (const ch of arg.slice(1)) {
            if (!ALLOWED_TAG_SHORT_CHARS.has(ch)) {
              throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
            }
            if (ch === "l" || ch === "v") allowsPositionals = true;
          }
        }
      } else if (!allowsPositionals) {
        throw new Error(
          `Positional tag argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "remote") {
    let remoteSubcmd = null;
    for (const arg of rest) {
      if (!remoteSubcmd) {
        if (arg === "-v" || arg === "--verbose") continue;
        if (arg.startsWith("-")) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git remote query`);
        }
        if (!ALLOWED_REMOTE_SUBCOMMANDS.has(arg)) {
          throw new Error(`Mutating git remote subcommand '${arg}' is not allowed`);
        }
        remoteSubcmd = arg;
      } else if (arg.startsWith("-")) {
        const okFlag = remoteSubcmd === "show" && arg === "-n" || remoteSubcmd === "get-url" && (arg === "--push" || arg === "--all");
        if (!okFlag) {
          throw new Error(
            `Flag '${arg}' is not allowed for read-only git remote ${remoteSubcmd}`
          );
        }
      }
    }
  }
  return ["--no-pager", subcmd, ...rest];
}
async function runTextOrRegexWithRg(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const args = [
    "--json",
    "--no-messages",
    "--max-filesize",
    "2M"
  ];
  if (query.type === "text") {
    args.push("--fixed-strings");
  }
  if (query.caseSensitive === false) {
    args.push("--ignore-case");
  }
  if (contextLines > 0) {
    args.push("-C", String(contextLines));
  }
  const normalizedGlob = query.glob ? query.glob.replace(/\\/g, "/") : "";
  if (normalizedGlob) {
    if (normalizedGlob.startsWith(".") || normalizedGlob.includes("/.")) {
      args.push("--hidden");
    }
    args.push(`--glob=${normalizedGlob}`);
  }
  const normRoot = toPosixPath(searchRoot);
  for (const dir of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".venv",
    ".next"
  ]) {
    if (!normRoot.split("/").includes(dir)) {
      args.push(`--glob=!**/${dir}/**`);
    }
  }
  const perFileCap = Math.min(maxResults, 50);
  args.push("--max-count", String(perFileCap + 1));
  args.push("--", query.pattern, searchRoot);
  const res = await execBinaryAsync("rg", args, {
    cwd: baseCwd,
    timeoutMs: 15e3,
    maxOutputBytes: 2 * 1024 * 1024
  });
  if (res.error) {
    throw new Error(`rg spawn error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("rg search timed out");
  }
  if (res.exitCode === 2) {
    throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`);
  }
  const byFile = /* @__PURE__ */ new Map();
  let totalMatches = 0;
  let truncated = false;
  let matchesInCurrentFile = 0;
  let pendingBeforeContext = [];
  let lastKeptMatchFile = "";
  let lastKeptMatchLine = -1;
  const upsertLine = (relFile, entry) => {
    let lineMap = byFile.get(relFile);
    if (!lineMap) {
      lineMap = /* @__PURE__ */ new Map();
      byFile.set(relFile, lineMap);
    }
    const existing = lineMap.get(entry.lineNumber);
    if (!existing || entry.isMatch) {
      lineMap.set(entry.lineNumber, {
        lineNumber: entry.lineNumber,
        text: entry.text,
        isMatch: entry.isMatch || Boolean(existing?.isMatch)
      });
    }
  };
  for (const rawLine of res.stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (ev.type === "begin" || ev.type === "end") {
      matchesInCurrentFile = 0;
      pendingBeforeContext = [];
      lastKeptMatchFile = "";
      lastKeptMatchLine = -1;
      continue;
    }
    if (ev.type !== "match" && ev.type !== "context") continue;
    const rawFile = ev.data?.path?.text ?? (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : void 0);
    const lineNumber = ev.data?.line_number;
    const rawText = ev.data?.lines?.text ?? (ev.data?.lines?.bytes ? Buffer.from(ev.data.lines.bytes, "base64").toString("utf8") : "");
    const lineText = rawText.replace(/\r?\n$/, "");
    if (!rawFile || typeof lineNumber !== "number") continue;
    const absFile = path3.isAbsolute(rawFile) ? rawFile : path3.resolve(baseCwd, rawFile);
    const relFile = toPosixPath(path3.relative(baseCwd, absFile)) || path3.basename(absFile);
    if (ev.type === "context") {
      if (lastKeptMatchFile === relFile && lastKeptMatchLine !== -1 && lineNumber > lastKeptMatchLine && lineNumber <= lastKeptMatchLine + contextLines) {
        upsertLine(relFile, { lineNumber, text: lineText, isMatch: false });
      } else if (totalMatches < maxResults && matchesInCurrentFile < perFileCap) {
        pendingBeforeContext.push({ relFile, lineNumber, text: lineText });
      }
      continue;
    }
    matchesInCurrentFile += 1;
    if (matchesInCurrentFile > perFileCap || totalMatches >= maxResults) {
      truncated = true;
      pendingBeforeContext = [];
      continue;
    }
    totalMatches += 1;
    for (const ctx of pendingBeforeContext) {
      if (ctx.relFile === relFile) {
        upsertLine(ctx.relFile, {
          lineNumber: ctx.lineNumber,
          text: ctx.text,
          isMatch: false
        });
      }
    }
    pendingBeforeContext = [];
    upsertLine(relFile, { lineNumber, text: lineText, isMatch: true });
    lastKeptMatchFile = relFile;
    lastKeptMatchLine = lineNumber;
  }
  const files = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, lineMap]) => ({
    file,
    lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber)
  }));
  return { files, totalMatches, truncated: truncated || res.truncated };
}
async function runTextOrRegexWithNode(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const caseSensitive = query.caseSensitive !== false;
  let regex;
  if (query.type === "regex") {
    try {
      regex = new RegExp(query.pattern, caseSensitive ? "" : "i");
    } catch (err) {
      throw new Error(
        `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, caseSensitive ? "" : "i");
  }
  const normalizedGlob = query.glob ? query.glob.replace(/\\/g, "/") : "";
  const globRegex = normalizedGlob ? globToRegExp(normalizedGlob) : null;
  const globMatchesFile = (relPosix) => {
    if (!globRegex) return true;
    if (globRegex.test(relPosix)) return true;
    if (!normalizedGlob.includes("/")) {
      const base = relPosix.split("/").pop() ?? relPosix;
      return globRegex.test(base);
    }
    return false;
  };
  const stat = await fs3.stat(searchRoot);
  let targetFiles;
  let walkTruncated = false;
  if (stat.isFile()) {
    const relPosix = toPosixPath(path3.relative(baseCwd, searchRoot)) || path3.basename(searchRoot);
    targetFiles = globMatchesFile(relPosix) ? [searchRoot] : [];
  } else {
    const includeHidden = Boolean(
      normalizedGlob && (normalizedGlob.startsWith(".") || normalizedGlob.includes("/."))
    );
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8e3,
      includeHidden,
      fileFilter: globMatchesFile
    });
    walkTruncated = Boolean(walked.truncated);
    targetFiles = walked.files.map((rel) => path3.join(searchRoot, rel));
  }
  const files = [];
  let totalMatches = 0;
  let hitGlobalLimit = false;
  let anyFileTruncated = false;
  const perFileCap = Math.min(maxResults, 50);
  const buildFileMatches = (relFile, allLines, keptIndices) => {
    const lineMap = /* @__PURE__ */ new Map();
    for (const mIdx of keptIndices) {
      const from = Math.max(0, mIdx - contextLines);
      const to = Math.min(allLines.length - 1, mIdx + contextLines);
      for (let j = from; j <= to; j++) {
        const ln = j + 1;
        const prev = lineMap.get(ln);
        lineMap.set(ln, {
          lineNumber: ln,
          text: allLines[j],
          isMatch: j === mIdx || Boolean(prev?.isMatch)
        });
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber)
    };
  };
  const batchSize = 16;
  for (let i = 0; i < targetFiles.length && !hitGlobalLimit; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (absFile) => {
        try {
          const st = await fs3.stat(absFile);
          if (st.size > 2 * 1024 * 1024) return null;
          const buf = await fs3.readFile(absFile);
          if (isLikelyBinary(buf)) return null;
          const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
          const matchedIndices = [];
          let fileTruncated = false;
          for (let idx = 0; idx < lines.length; idx++) {
            if (regex.test(lines[idx])) {
              if (matchedIndices.length >= perFileCap) {
                fileTruncated = true;
                break;
              }
              matchedIndices.push(idx);
            }
          }
          if (matchedIndices.length === 0) return null;
          const relFile = toPosixPath(path3.relative(baseCwd, absFile)) || path3.basename(absFile);
          return { relFile, lines, matchedIndices, fileTruncated };
        } catch {
          return null;
        }
      })
    );
    for (const item of results) {
      if (!item) continue;
      if (item.fileTruncated) anyFileTruncated = true;
      if (totalMatches + item.matchedIndices.length > maxResults) {
        const remaining = maxResults - totalMatches;
        if (remaining > 0) {
          const kept = item.matchedIndices.slice(0, remaining);
          files.push(buildFileMatches(item.relFile, item.lines, kept));
          totalMatches += kept.length;
        }
        hitGlobalLimit = true;
        break;
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedIndices));
      totalMatches += item.matchedIndices.length;
    }
  }
  return { files, totalMatches, truncated: hitGlobalLimit || anyFileTruncated || walkTruncated };
}
function buildGlobFallbackPlan(pattern) {
  if (!pattern.includes("{") && pattern.includes("|")) {
    const terms = pattern.split("|").map((part) => part.trim()).filter(Boolean);
    if (terms.length >= 2) {
      const termMatchers = terms.map((term) => {
        const hasGlobMeta = /[*?[\]{}]/.test(term);
        if (hasGlobMeta) {
          try {
            const re = globToRegExp(term);
            const matchBase = !term.includes("/");
            return (relPosix, base) => re.test(relPosix) || matchBase && re.test(base);
          } catch {
          }
        }
        const needle = term.toLowerCase();
        return (relPosix) => relPosix.toLowerCase().includes(needle);
      });
      const allBare = terms.every((t) => !/[*?[\]{}/]/.test(t));
      const label = allBare ? `**/*{${terms.join(",")}}*` : `{${terms.join(",")}}`;
      return {
        match: (relPosix, base) => termMatchers.some((fn) => fn(relPosix, base)),
        matchedNote: `[note: exact glob matched 0 files; auto-expanded regex '|' to "${label}" (glob uses * and {a,b}, not |)]`,
        emptyMessage: "(no files matched; hint: glob uses * and {a,b}, not regex |)"
      };
    }
  }
  if (/^[A-Za-z0-9_-]+$/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return {
      match: (relPosix) => relPosix.toLowerCase().includes(needle),
      matchedNote: `[note: exact glob "${pattern}" matched 0 files; showing case-insensitive path matches for "*${pattern}*"]`,
      emptyMessage: "(no files matched)"
    };
  }
  return null;
}
function formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, notePrefix) {
  const relPrefix = toPosixPath(path3.relative(baseCwd, searchRoot));
  const sortedFiles = [...walked.files].sort((a, b) => a.localeCompare(b));
  const items = sortedFiles.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === ".") return f;
    return `${relPrefix}/${f}`;
  });
  const truncated = walked.truncated || sortedFiles.length > maxResults;
  const header = notePrefix ? `${notePrefix}
` : "";
  if (!truncated) {
    return `${header}${items.join("\n")}`;
  }
  const omitted = sortedFiles.slice(maxResults);
  const dirCounts = /* @__PURE__ */ new Map();
  for (const f of omitted) {
    const slash = f.indexOf("/");
    const bucket = slash === -1 ? "(root)" : `${f.slice(0, slash)}/`;
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1);
  }
  const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([dir, cnt]) => `${dir} (${cnt})`);
  const totalLabel = walked.truncated ? `${walked.files.length}+` : String(walked.files.length);
  const dirSummary = topDirs.length > 0 ? `; omitted dirs: ${topDirs.join(", ")}` : "";
  const suffix = `
... [truncated at ${maxResults} of ${totalLabel} files${dirSummary}]`;
  return `${header}${items.join("\n")}${suffix}`;
}
async function runGlobQuery(query, searchRoot, baseCwd, isFileTarget, trackCtx = null) {
  const maxResults = clampInt(query.maxResults ?? 80, 1, 300);
  const pattern = (query.pattern.trim() || "**/*").replace(/\\/g, "/");
  const matcher = globToRegExp(pattern);
  const matchBasename = !pattern.includes("/");
  const includeHidden = pattern.startsWith(".") || pattern.includes("/.");
  const recordGlobPaths = (relList) => {
    if (!trackCtx) return;
    for (const rel of relList) {
      if (trackCtx.matchedAbsPaths.size >= MAX_SEARCH_TRACKED_FILES) break;
      trackCtx.matchedAbsPaths.add(path3.join(searchRoot, rel));
    }
  };
  if (isFileTarget) {
    const rel = toPosixPath(path3.relative(baseCwd, searchRoot)) || path3.basename(searchRoot);
    const base = path3.basename(searchRoot);
    const matched = matcher.test(rel) || matchBasename && matcher.test(base);
    if (matched) {
      if (trackCtx && trackCtx.matchedAbsPaths.size < MAX_SEARCH_TRACKED_FILES) {
        trackCtx.matchedAbsPaths.add(searchRoot);
      }
      return rel;
    }
    const fallback2 = buildGlobFallbackPlan(pattern);
    if (fallback2) {
      if (fallback2.match(rel, base)) {
        if (trackCtx && trackCtx.matchedAbsPaths.size < MAX_SEARCH_TRACKED_FILES) {
          trackCtx.matchedAbsPaths.add(searchRoot);
        }
        return `${fallback2.matchedNote}
${rel}`;
      }
      return fallback2.emptyMessage;
    }
    return "(no files matched)";
  }
  const scanLimit = Math.max(maxResults + 1, 2e3);
  const walked = await walkFiles(searchRoot, {
    maxFiles: scanLimit,
    includeHidden,
    fileFilter: (relPosix) => {
      if (matcher.test(relPosix)) return true;
      if (matchBasename) {
        const base = relPosix.split("/").pop() ?? relPosix;
        return matcher.test(base);
      }
      return false;
    }
  });
  if (walked.files.length > 0) {
    recordGlobPaths(walked.files);
    return formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults);
  }
  const fallback = buildGlobFallbackPlan(pattern);
  if (fallback) {
    const fallbackWalked = await walkFiles(searchRoot, {
      maxFiles: scanLimit,
      includeHidden,
      fileFilter: (relPosix) => {
        const base = relPosix.split("/").pop() ?? relPosix;
        return fallback.match(relPosix, base);
      }
    });
    if (fallbackWalked.files.length > 0) {
      recordGlobPaths(fallbackWalked.files);
      return formatGlobWalkResult(
        fallbackWalked,
        searchRoot,
        baseCwd,
        maxResults,
        fallback.matchedNote
      );
    }
    return fallback.emptyMessage;
  }
  return "(no files matched)";
}
async function runGitQuery(query, searchRoot) {
  const gitArgs = validateReadonlyGitArgs(query.pattern);
  const res = await execBinaryAsync("git", ["--no-optional-locks", ...gitArgs], {
    cwd: searchRoot,
    timeoutMs: 1e4,
    maxOutputBytes: 512 * 1024
  });
  if (res.error) {
    throw new Error(`git execution error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("git query timed out");
  }
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(msg || `git exited with code ${res.exitCode}`);
  }
  const out = res.stdout.trimEnd();
  return out || "(empty output)";
}
function formatFileMatches(files, totalMatches, truncated) {
  if (files.length === 0) {
    return "(no matches)";
  }
  const blocks = [];
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ":" : "-";
      const text = l.text.length > 240 ? `${l.text.slice(0, 240)}...` : l.text;
      return `  ${l.lineNumber}${sep} ${text}`;
    });
    blocks.push(`${fm.file}
${lines.join("\n")}`);
  }
  const footer = truncated ? `
... [truncated at ${totalMatches} matches]` : "";
  return `${blocks.join("\n")}${footer}`;
}
var MAX_SEARCH_CACHE_ENTRIES = 32;
var DEFAULT_SEARCH_CACHE_TTL_MS = 15e3;
var MAX_SEARCH_TRACKED_FILES = 32;
var MAX_SEARCH_TRACKED_DIRS = 16;
var BATCH_SEARCH_CACHE = /* @__PURE__ */ new Map();
function getSearchCacheTtlMs() {
  const cfgVal = getEffectiveConfig().searchCacheTtlMs;
  if (!Number.isFinite(cfgVal)) return DEFAULT_SEARCH_CACHE_TTL_MS;
  if (cfgVal <= 0) return 0;
  return Math.min(Math.trunc(cfgVal), 3e5);
}
async function statFingerprintPart(targetPath) {
  try {
    const st = await fs3.stat(targetPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}
async function resolveGitDirFast(baseCwd) {
  let dir = baseCwd;
  for (let depth = 0; depth < 4; depth++) {
    const dotGit = path3.join(dir, ".git");
    try {
      const st = await fs3.stat(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile() && st.size < 4096) {
        const raw = await fs3.readFile(dotGit, "utf8");
        const m = /^gitdir:\s*(.+)$/im.exec(raw.trim());
        if (m && m[1]) {
          return path3.resolve(dir, m[1].trim());
        }
      }
      return null;
    } catch {
      const parent = path3.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }
  return null;
}
async function computeWorktreeFingerprint(baseCwd, queries) {
  try {
    const targets = [baseCwd];
    const gitDir = await resolveGitDirFast(baseCwd);
    if (gitDir) {
      targets.push(path3.join(gitDir, "index"));
      targets.push(path3.join(gitDir, "HEAD"));
      targets.push(path3.join(gitDir, "logs", "HEAD"));
    }
    const extraPaths = /* @__PURE__ */ new Set();
    for (const q of queries) {
      if (q && typeof q.path === "string" && q.path.trim()) {
        extraPaths.add(resolvePath(q.path, baseCwd));
      }
    }
    const sortedExtra = [...extraPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const p of sortedExtra) {
      targets.push(p);
    }
    const parts = await Promise.all(targets.map((t) => statFingerprintPart(t)));
    return parts.join("|");
  } catch {
    return "";
  }
}
async function areTrackedFilesFresh(trackedFiles) {
  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) return true;
  const checks = await Promise.all(
    trackedFiles.map(async (f) => {
      try {
        const st = await fs3.stat(f.absPath);
        return st.mtimeMs === f.mtimeMs && st.size === f.size;
      } catch {
        return false;
      }
    })
  );
  return checks.every(Boolean);
}
async function collectSmallDirProbePaths(baseCwd, queries, maxFiles = 24) {
  try {
    const roots = /* @__PURE__ */ new Set();
    for (const q of queries) {
      if (q && typeof q.path === "string" && q.path.trim()) {
        roots.add(resolvePath(q.path, baseCwd));
      } else {
        roots.add(baseCwd);
      }
    }
    const found = /* @__PURE__ */ new Set();
    for (const root of roots) {
      let st;
      try {
        st = await fs3.stat(root);
      } catch {
        continue;
      }
      if (st.isFile()) {
        found.add(root);
        if (found.size > maxFiles) return [];
        continue;
      }
      if (!st.isDirectory()) continue;
      let entries;
      try {
        entries = await fs3.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.length > 48) return [];
      const subdirs = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        const abs = path3.join(root, entry.name);
        if (entry.isFile()) {
          found.add(abs);
          if (found.size > maxFiles) return [];
        } else if (entry.isDirectory()) {
          subdirs.push(abs);
        }
      }
      if (subdirs.length > 12) return [];
      for (const sub of subdirs) {
        let subEntries;
        try {
          subEntries = await fs3.readdir(sub, { withFileTypes: true });
        } catch {
          continue;
        }
        if (subEntries.length > 48) return [];
        for (const se of subEntries) {
          if (se.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(se.name)) continue;
          if (se.isFile()) {
            found.add(path3.join(sub, se.name));
            if (found.size > maxFiles) return [];
          }
        }
      }
    }
    return [...found];
  } catch {
    return [];
  }
}
async function snapshotTrackedFiles(absPathsSet, baseCwd = "") {
  if (!absPathsSet || absPathsSet.size === 0) return [];
  const fileList = [...absPathsSet].slice(0, MAX_SEARCH_TRACKED_FILES);
  const normBase = baseCwd ? normalizeFileCacheKey(baseCwd) : "";
  const parentDirs = /* @__PURE__ */ new Set();
  for (const absPath of fileList) {
    if (parentDirs.size >= MAX_SEARCH_TRACKED_DIRS) break;
    const dir = path3.dirname(absPath);
    if (dir && dir !== absPath && normalizeFileCacheKey(dir) !== normBase) {
      parentDirs.add(dir);
    }
  }
  const targets = [
    ...fileList.map((absPath) => ({ absPath, expectDir: false })),
    ...[...parentDirs].map((absPath) => ({ absPath, expectDir: true }))
  ];
  const results = await Promise.all(
    targets.map(async ({ absPath, expectDir }) => {
      try {
        const st = await fs3.stat(absPath);
        if (expectDir ? !st.isDirectory() : !st.isFile()) return null;
        return { absPath, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}
async function executeSingleQuery(query, index, baseCwd, useRg, trackCtx = null) {
  const header = `## Query ${index + 1} [${query.type}] ${query.pattern}${query.path ? ` (in ${query.path})` : ""}`;
  try {
    if (!query.pattern || typeof query.pattern !== "string") {
      throw new Error("Query 'pattern' must be a non-empty string");
    }
    const searchRoot = query.path ? resolvePath(query.path, baseCwd) : baseCwd;
    let targetStat;
    try {
      targetStat = await fs3.stat(searchRoot);
    } catch {
      throw new Error(`Path does not exist: ${query.path || baseCwd}`);
    }
    if (query.type === "git") {
      const gitCwd = targetStat.isFile() ? path3.dirname(searchRoot) : searchRoot;
      const out = await runGitQuery(query, gitCwd);
      return `${header}
${out}`;
    }
    if (query.type === "glob") {
      const out = await runGlobQuery(query, searchRoot, baseCwd, targetStat.isFile(), trackCtx);
      return `${header}
${out}`;
    }
    if (query.type === "text" || query.type === "regex") {
      let res;
      if (useRg) {
        try {
          res = await runTextOrRegexWithRg(query, searchRoot, baseCwd);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("rg spawn error:")) {
            res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
          } else {
            throw err;
          }
        }
      } else {
        res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
      }
      if (trackCtx && Array.isArray(res.files)) {
        for (const fm of res.files) {
          if (trackCtx.matchedAbsPaths.size >= MAX_SEARCH_TRACKED_FILES) break;
          if (fm && fm.file) {
            trackCtx.matchedAbsPaths.add(path3.resolve(baseCwd, fm.file));
          }
        }
      }
      return `${header}
${formatFileMatches(res.files, res.totalMatches, res.truncated)}`;
    }
    throw new Error(`Unsupported query type: ${String(query.type)}`);
  } catch (err) {
    if (trackCtx) trackCtx.hasError = true;
    return `${header}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function runBatchSearch(input, options = {}) {
  if (!Array.isArray(input.queries) || input.queries.length === 0) {
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true
    };
  }
  if (input.queries.length > 20) {
    return {
      text: "Error: 'queries' supports at most 20 queries per call.",
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs3.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const maxChars = clampInt(input.maxChars ?? 8500, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  // Working-tree git queries (status/diff/log) depend on arbitrary tracked/untracked files across subdirs; bypass cache.
  const hasGitQuery = input.queries.some((q) => q && q.type === "git");
  const ttlMs = hasGitQuery ? 0 : getSearchCacheTtlMs();
  let cacheKey = null;
  if (ttlMs > 0) {
    const worktreeFp = await computeWorktreeFingerprint(baseCwd, input.queries);
    const canonicalQueriesJson = JSON.stringify(stableSortObject(input.queries));
    cacheKey = `${normalizeFileCacheKey(baseCwd)}|${maxChars}|${Boolean(options.forceNodeFallback)}|${canonicalQueriesJson}|${worktreeFp}`;
    const cached = BATCH_SEARCH_CACHE.get(cacheKey);
    if (cached) {
      const now = Date.now();
      if (now - cached.createdAt <= ttlMs && await areTrackedFilesFresh(cached.trackedFiles)) {
        BATCH_SEARCH_CACHE.delete(cacheKey);
        BATCH_SEARCH_CACHE.set(cacheKey, cached);
        return {
          text: cached.text,
          isError: false
        };
      }
      BATCH_SEARCH_CACHE.delete(cacheKey);
    }
  }
  const needsTextSearch = input.queries.some(
    (q) => q.type === "text" || q.type === "regex"
  );
  const useRg = needsTextSearch && !options.forceNodeFallback && await isRipgrepAvailable();
  const trackCtx = ttlMs > 0 ? { matchedAbsPaths: /* @__PURE__ */ new Set(), hasError: false } : null;
  const sections = await Promise.all(
    input.queries.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg, trackCtx))
  );
  const resultText = fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n");
  if (cacheKey && trackCtx && !trackCtx.hasError) {
    try {
      if (trackCtx.matchedAbsPaths.size === 0) {
        const probePaths = await collectSmallDirProbePaths(baseCwd, input.queries, 24);
        for (const p of probePaths) trackCtx.matchedAbsPaths.add(p);
      }
      const trackedFiles = await snapshotTrackedFiles(trackCtx.matchedAbsPaths, baseCwd);
      if (trackedFiles.length > 0) {
        if (BATCH_SEARCH_CACHE.has(cacheKey)) {
          BATCH_SEARCH_CACHE.delete(cacheKey);
        } else if (BATCH_SEARCH_CACHE.size >= MAX_SEARCH_CACHE_ENTRIES) {
          const oldestKey = BATCH_SEARCH_CACHE.keys().next().value;
          if (oldestKey !== void 0) BATCH_SEARCH_CACHE.delete(oldestKey);
        }
        BATCH_SEARCH_CACHE.set(cacheKey, {
          createdAt: Date.now(),
          text: resultText,
          trackedFiles
        });
      }
    } catch {
      // Fail-open cache populate
    }
  }
  return {
    text: resultText,
    isError: false
  };
}
function clampInt(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}
function clampIntWithDefault(val, def, min, max) {
  const n = typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// src/tools/read-slices.ts
import path4 from "node:path";
function isRegexStartContext(line, slashIdx) {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j])) j--;
  if (j < 0) return true;
  const prev = line[j];
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k])) k--;
  const word = line.slice(k + 1, j + 1);
  return word === "return" || word === "case" || word === "throw" || word === "in" || word === "of" || word === "typeof" || word === "void" || word === "delete" || word === "new";
}
function scanBracesOnLine(line, state, lang, ignoreBracesInParensBeforeOpen = false, alreadySeenOpen = false) {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let parenDepth = state.parenDepth ?? 0;
  let seenOpen = alreadySeenOpen;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }
    if (state.inBacktick) {
      if (lang === "js" && ch === "\\") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }
    if (lang === "shell" && ch === "#") break;
    if ((lang === "js" || lang === "c") && ch === "/" && next === "/") break;
    if ((lang === "js" || lang === "c") && ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (lang === "js" && ch === "/" && next !== "/" && next !== "*" && isRegexStartContext(line, i)) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }
    if (ch === "'" && lang !== "json") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c")) {
      state.inBacktick = true;
      continue;
    }
    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        state.templateExprStack[state.templateExprStack.length - 1] += 1;
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        open++;
        seenOpen = true;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const top = state.templateExprStack[state.templateExprStack.length - 1];
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[state.templateExprStack.length - 1] = top - 1;
        }
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      parenDepth++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      parenDepth = Math.max(0, parenDepth - 1);
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }
  state.parenDepth = parenDepth;
  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
    lastCodeChar
  };
}
function findBraceBlockEnd(lines, startIdx, lang = "c") {
  let depth = 0;
  let seenOpen = false;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const maxScan = Math.min(lines.length, startIdx + 2e3);
  for (let i = startIdx; i < maxScan; i++) {
    const { open, close, endsWithSemi, lastCodeChar } = scanBracesOnLine(
      lines[i],
      state,
      lang,
      lang === "js",
      seenOpen
    );
    if (open > 0) seenOpen = true;
    depth += open - close;
    if (seenOpen && depth <= 0) {
      if (lang === "js" && i <= startIdx + 16) {
        const headerHasGeneric = lines.slice(startIdx, i + 1).some((l) => l.includes("<"));
        let isGenericContinuation = lastCodeChar === ">" || (state.parenDepth ?? 0) > 0;
        if (!isGenericContinuation && headerHasGeneric) {
          if (lastCodeChar === ",") {
            isGenericContinuation = true;
          } else {
            let nextIdx = i + 1;
            while (nextIdx < maxScan && !lines[nextIdx].trim()) nextIdx++;
            if (nextIdx < maxScan && lines[nextIdx].trim().startsWith(">")) {
              isGenericContinuation = true;
            }
          }
        }
        if (isGenericContinuation) {
          seenOpen = false;
          depth = 0;
          continue;
        }
      }
      return i + 1;
    }
    if (!seenOpen && (state.parenDepth ?? 0) <= 0 && endsWithSemi) {
      return i + 1;
    }
    if (!seenOpen && i > startIdx + 40) {
      return startIdx + 1;
    }
  }
  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}
function findTypeAliasEnd(lines, startIdx) {
  const firstLine = lines[startIdx] ?? "";
  const eqIdx = firstLine.indexOf("=");
  const rhs = eqIdx >= 0 ? firstLine.slice(eqIdx + 1) : firstLine;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const firstScan = scanBracesOnLine(rhs, state, "js");
  if (firstScan.open > firstScan.close) {
    return findBraceBlockEnd(lines, startIdx, "js");
  }
  if (firstScan.endsWithSemi && firstScan.openParen <= firstScan.closeParen) {
    return startIdx + 1;
  }
  let endIdx = startIdx;
  let parenBal = firstScan.openParen - firstScan.closeParen;
  let prevLast = firstScan.lastCodeChar;
  const maxScan = Math.min(lines.length - 1, startIdx + 40);
  while (endIdx < maxScan) {
    const nextLine = lines[endIdx + 1] ?? "";
    const nextTrim = nextLine.trim();
    if (!nextTrim) break;
    const isContinuation = parenBal > 0 || prevLast === "=" || prevLast === "|" || prevLast === "&" || prevLast === "?" || prevLast === ":" || /^[ \t]+(?:[|&?:]|\w+\s*\?*:)/.test(nextLine);
    if (!isContinuation) break;
    endIdx++;
    const scan = scanBracesOnLine(nextLine, state, "js");
    if (scan.open > scan.close) {
      return findBraceBlockEnd(lines, endIdx, "js");
    }
    parenBal += scan.openParen - scan.closeParen;
    prevLast = scan.lastCodeChar;
    if (scan.endsWithSemi && parenBal <= 0) break;
  }
  return endIdx + 1;
}
function findParenCallEnd(lines, startIdx) {
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  let seenParen = false;
  const maxScan = Math.min(lines.length, startIdx + 400);
  for (let i = startIdx; i < maxScan; i++) {
    const { openParen } = scanBracesOnLine(lines[i], state, "js");
    if (openParen > 0) seenParen = true;
    if (seenParen && (state.parenDepth ?? 0) <= 0) {
      return i + 1;
    }
  }
  return startIdx + 1;
}
function hasArrowOrBraceWithin(lines, startIdx, maxLookahead = 12) {
  const state = { inBlockComment: false, templateExprStack: [], inBacktick: false };
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let i = startIdx; i < end; i++) {
    const line = lines[i];
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(line, state, "js");
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }
  return { hasArrow, hasBrace: false };
}
function extractTsJsSymbols(lines) {
  const symbols = [];
  const patterns = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
      kind: "type",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
      nameGroup: 1
    }
  ];
  const multilineArrowStartRe = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;
  const methodHeaderRe = /^([ \t]{1,4})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
  const controlKeywords = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "try",
    "return",
    "new",
    "throw",
    "await",
    "super",
    "typeof",
    "delete"
  ]);
  const routeRegisterRe = /^[ \t]{1,6}(?:app|router|server|fastify)\.(get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testSuiteRe = /^(?:describe|suite)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testCaseRe = /^[ \t]{0,4}(?:it|test)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  let currentClassEnd = -1;
  let currentClassIndent = -1;
  let currentFnEnd = -1;
  let currentSuiteEnd = -1;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "js");
    if (wasInComment || wasInBacktick) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }
    let matchedTop = false;
    if (!line.startsWith(" ") && !line.startsWith("	")) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m && m[p.nameGroup]) {
          const endLine = p.kind === "type" ? findTypeAliasEnd(lines, i) : findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: p.kind,
            name: m[p.nameGroup],
            startLine: i + 1,
            endLine,
            depth: 0
          });
          if (p.kind === "class") {
            currentClassEnd = endLine;
            currentClassIndent = -1;
          } else if (p.kind === "function" && endLine - (i + 1) >= 40) {
            currentFnEnd = endLine;
          }
          matchedTop = true;
          break;
        }
      }
      if (!matchedTop) {
        const ma = multilineArrowStartRe.exec(line);
        if (ma && ma[1]) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12);
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name: ma[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
            if (endLine - (i + 1) >= 40) {
              currentFnEnd = endLine;
            }
            matchedTop = true;
          }
        }
      }
      if (!matchedTop) {
        const ms = testSuiteRe.exec(line);
        if (ms && ms[1]) {
          const endLine = findParenCallEnd(lines, i);
          symbols.push({
            kind: "suite",
            name: ms[1].slice(0, 64),
            startLine: i + 1,
            endLine,
            depth: 0
          });
          currentSuiteEnd = endLine;
          matchedTop = true;
        }
      }
    }
    if (!matchedTop && i + 1 <= currentClassEnd) {
      const mm = methodHeaderRe.exec(line);
      if (mm && mm[1] && mm[2] && !controlKeywords.has(mm[2])) {
        const indentWidth = mm[1].replace(/\t/g, "  ").length;
        if (currentClassIndent === -1) {
          currentClassIndent = indentWidth;
        }
        if (indentWidth === currentClassIndent) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 10);
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "method",
              name: mm[2],
              startLine: i + 1,
              endLine,
              depth: 1
            });
          }
        }
      }
    } else if (!matchedTop && i + 1 <= currentFnEnd) {
      const mr = routeRegisterRe.exec(line);
      if (mr && mr[1] && mr[2]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "route",
          name: `${mr[1].toUpperCase()} ${mr[2]}`,
          startLine: i + 1,
          endLine,
          depth: 1
        });
      }
    } else if (!matchedTop) {
      const mt = testCaseRe.exec(line);
      if (mt && mt[1]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "test",
          name: mt[1].slice(0, 64),
          startLine: i + 1,
          endLine,
          depth: i + 1 <= currentSuiteEnd ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractPythonSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const inTripleString = new Array(lines.length).fill(false);
  let activeQuote = null;
  for (let i = 0; i < lines.length; i++) {
    inTripleString[i] = activeQuote !== null;
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      if (activeQuote) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeQuote, j)) {
          activeQuote = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeQuote = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeQuote = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          const q = line[j];
          j++;
          while (j < line.length && line[j] !== q) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          j++;
          continue;
        }
        j++;
      }
    }
  }
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    if (inTripleString[i]) continue;
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "    ").length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    raw.push({ indent, kind, name: m[3], startIdx: i });
  }
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    let headerEndIdx = item.startIdx;
    let bracketBal = 0;
    let seenHeaderBracket = false;
    const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
    for (let h = item.startIdx; h <= maxHeaderScan; h++) {
      if (h > item.startIdx && inTripleString[h]) {
        headerEndIdx = h;
        continue;
      }
      const hl = lines[h];
      let q = null;
      for (let k = 0; k < hl.length; k++) {
        const ch = hl[k];
        if (q) {
          if (ch === "\\") {
            k++;
            continue;
          }
          if (ch === q) q = null;
          continue;
        }
        if (ch === "#") break;
        if (ch === '"' || ch === "'") {
          if (hl.startsWith('"""', k) || hl.startsWith("'''", k)) break;
          q = ch;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") {
          bracketBal++;
          seenHeaderBracket = true;
        } else if (ch === ")" || ch === "]" || ch === "}") {
          bracketBal = Math.max(0, bracketBal - 1);
        }
      }
      headerEndIdx = h;
      if (!seenHeaderBracket || bracketBal === 0) break;
    }
    let endIdx = lines.length - 1;
    for (let j = headerEndIdx + 1; j < lines.length; j++) {
      if (inTripleString[j]) continue;
      const l = lines[j];
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
      if (curIndent <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > item.startIdx && !lines[endIdx].trim()) {
      endIdx--;
    }
    symbols.push({
      kind: item.kind,
      name: item.name,
      startLine: item.startIdx + 1,
      endLine: endIdx + 1,
      depth: item.indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function stripLeadingGdAnnotations(text) {
  let rest = text;
  while (rest.startsWith("@")) {
    const m = /^@[A-Za-z_]\w*/.exec(rest);
    if (!m) break;
    let idx = m[0].length;
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    if (rest[idx] === "(") {
      let depth = 0;
      let quote = null;
      while (idx < rest.length) {
        const ch = rest[idx];
        if (quote) {
          if (ch === "\\") {
            idx += 2;
            continue;
          }
          if (ch === quote) quote = null;
        } else {
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              idx++;
              break;
            }
          }
        }
        idx++;
      }
    }
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    rest = rest.slice(idx);
  }
  return rest;
}
function extractGdScriptSymbols(rawLines) {
  const lines = rawLines.map((l, idx) => {
    const clean = l.endsWith("\r") ? l.slice(0, -1) : l;
    return idx === 0 ? clean.replace(/^\uFEFF/, "") : clean;
  });
  const info = new Array(lines.length);
  let activeTriple = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsInTriple = activeTriple !== null;
    let openBrace = 0;
    let closeBrace = 0;
    let openParen = 0;
    let closeParen = 0;
    let hasCode = startsInTriple;
    let j = 0;
    while (j < line.length) {
      if (activeTriple) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeTriple, j)) {
          activeTriple = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        const ch = line[j];
        if (ch === "#") break;
        if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
          activeTriple = line.startsWith('"""', j) ? '"""' : "'''";
          hasCode = true;
          j += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          hasCode = true;
          j++;
          while (j < line.length && line[j] !== ch) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          if (j < line.length) j++;
          continue;
        }
        if (ch !== " " && ch !== "	") {
          hasCode = true;
          if (ch === "{") openBrace++;
          else if (ch === "}") closeBrace++;
          else if (ch === "(") openParen++;
          else if (ch === ")") closeParen++;
        }
        j++;
      }
    }
    info[i] = {
      startsInTriple,
      openBrace,
      closeBrace,
      openParen,
      closeParen,
      hasCode
    };
  }
  const raw = [];
  const classNameRe = /^class_name\s+([A-Za-z_]\w*)\b/;
  const classRe = /^class\s+([A-Za-z_]\w*)\b/;
  const funcRe = /^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
  const signalRe = /^signal\s+([A-Za-z_]\w*)\b/;
  const enumRe = /^enum(?:\s+([A-Za-z_]\w*))?\s*(?:\{|$|#)/;
  for (let i = 0; i < lines.length; i++) {
    if (info[i].startsInTriple) continue;
    const line = lines[i];
    const indentStr = /^[ \t]*/.exec(line)?.[0] ?? "";
    const afterIndent = line.slice(indentStr.length);
    if (!afterIndent || afterIndent.startsWith("#")) continue;
    const rest = stripLeadingGdAnnotations(afterIndent);
    if (!rest || rest.startsWith("#")) continue;
    const indent = indentStr.replace(/\t/g, "    ").length;
    let m = classNameRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class_name", name: m[1], startIdx: i });
      continue;
    }
    m = classRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class", name: m[1], startIdx: i });
      continue;
    }
    m = funcRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "func", name: m[1], startIdx: i });
      continue;
    }
    m = signalRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "signal", name: m[1], startIdx: i });
      continue;
    }
    m = enumRe.exec(rest);
    if (m) {
      if (!m[1] && info[i].openBrace === 0) {
        let nextCodeIdx = i + 1;
        while (nextCodeIdx < lines.length && !info[nextCodeIdx].hasCode) {
          nextCodeIdx++;
        }
        if (nextCodeIdx >= lines.length || info[nextCodeIdx].openBrace === 0) {
          continue;
        }
      }
      raw.push({
        indent,
        rawKind: "enum",
        name: m[1] ?? "<anonymous>",
        startIdx: i
      });
    }
  }
  const symbols = [];
  const classStack = [];
  for (const item of raw) {
    let endIdx = item.startIdx;
    if (item.rawKind === "class_name") {
      endIdx = item.startIdx;
    } else if (item.rawKind === "signal") {
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxSigScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && endIdx < maxSigScan) {
        endIdx++;
        parenDepth += info[endIdx].openParen - info[endIdx].closeParen;
      }
      if (parenDepth > 0) endIdx = item.startIdx;
    } else if (item.rawKind === "enum") {
      let braceDepth = 0;
      let seenOpen = false;
      const maxEnumScan = Math.min(lines.length - 1, item.startIdx + 500);
      for (let k = item.startIdx; k <= maxEnumScan; k++) {
        const li = info[k];
        if (li.openBrace > 0) seenOpen = true;
        braceDepth += li.openBrace - li.closeBrace;
        if (seenOpen && braceDepth <= 0) {
          endIdx = k;
          break;
        }
        if (!seenOpen && k > item.startIdx && li.hasCode && li.openBrace === 0) {
          break;
        }
      }
      if (seenOpen && braceDepth > 0) {
        endIdx = maxEnumScan;
      }
    } else {
      let headerEndIdx = item.startIdx;
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && headerEndIdx < maxHeaderScan) {
        headerEndIdx++;
        parenDepth += info[headerEndIdx].openParen - info[headerEndIdx].closeParen;
      }
      if (parenDepth > 0) headerEndIdx = item.startIdx;
      endIdx = lines.length - 1;
      for (let j = headerEndIdx + 1; j < lines.length; j++) {
        if (info[j].startsInTriple) continue;
        const l = lines[j];
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
        if (curIndent <= item.indent) {
          endIdx = j - 1;
          break;
        }
      }
      while (endIdx > headerEndIdx) {
        if (info[endIdx].startsInTriple) break;
        const endLineStr = lines[endIdx];
        const endTrimmed = endLineStr.trim();
        if (!endTrimmed) {
          endIdx--;
          continue;
        }
        if (endTrimmed.startsWith("#")) {
          const commentIndent = (/^[ \t]*/.exec(endLineStr)?.[0] ?? "").replace(
            /\t/g,
            "    "
          ).length;
          if (commentIndent <= item.indent) {
            endIdx--;
            continue;
          }
        }
        break;
      }
    }
    const startLine = item.startIdx + 1;
    const endLine = Math.max(startLine, endIdx + 1);
    while (classStack.length > 0 && (classStack[classStack.length - 1].endLine < startLine || classStack[classStack.length - 1].indent >= item.indent)) {
      classStack.pop();
    }
    const depth = classStack.length > 0 ? classStack.length : item.indent > 0 ? Math.max(1, Math.floor(item.indent / 4)) : 0;
    const kind = item.rawKind === "func" ? item.indent > 0 ? "method" : "function" : item.rawKind;
    symbols.push({
      kind,
      name: item.name,
      startLine,
      endLine,
      depth
    });
    if (item.rawKind === "class") {
      classStack.push({ indent: item.indent, endLine });
    }
  }
  return symbols;
}
function extractGoSymbols(lines) {
  const symbols = [];
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)/;
  const typeRe = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      const name = recv ? `(${recv}) ${fm[2]}` : fm[2];
      symbols.push({
        kind: recv ? "method" : "function",
        name,
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: 0
      });
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[1] && tm[2]) {
      symbols.push({
        kind: tm[2],
        name: tm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: 0
      });
    }
  }
  return symbols;
}
function extractRustSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w:<>,\s]*?)(?:\s*[\({;]|$)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = re.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = m[1].length;
    if (indent > 4) continue;
    symbols.push({
      kind: m[2],
      name: m[3].trim(),
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "c"),
      depth: indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function extractCLikeSymbols(lines) {
  const symbols = [];
  const typeRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|partial)\s+)*(class|interface|enum|struct|record|protocol|namespace)\s+([A-Za-z_]\w*)/;
  const kwFuncRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|override|virtual|inline|async|suspend|open|mutating)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)/;
  const cMethodRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|extern|async|synchronized|native|unsigned|signed|const)\s+)*(?:[A-Za-z_~][\w:<>,\[\]\s*&]*?\s+)([A-Za-z_~][\w:]*)\s*\([^;]*$/;
  const excludedNames = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "return",
    "sizeof",
    "alignof",
    "decltype",
    "new",
    "delete",
    "throw",
    "typedef",
    "using",
    "case"
  ]);
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "c");
    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indented = (tm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: tm[2],
        name: tm[3],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indented = (fm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: indented ? "method" : "function",
        name: fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const cm = cMethodRe.exec(line);
    if (cm && cm[2] && !excludedNames.has(cm[2]) && !trimmed.includes("=")) {
      const { hasBrace } = hasArrowOrBraceWithin(lines, i, 8);
      if (hasBrace) {
        const indented = (cm[1]?.length ?? 0) > 0;
        symbols.push({
          kind: indented ? "method" : "function",
          name: cm[2],
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "c"),
          depth: indented ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractShellSymbols(lines) {
  const symbols = [];
  const re = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    symbols.push({
      kind: "function",
      name,
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "shell"),
      depth: 0
    });
  }
  return symbols;
}
function extractMarkdownSymbols(lines) {
  const raw = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m && m[1] && m[2]) {
      raw.push({ level: m[1].length, name: m[2], startLine: i + 1 });
    }
  }
  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j].level <= item.level) {
        endLine = raw[j].startLine - 1;
        break;
      }
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1
    };
  });
}
function extractJsonYamlSymbols(lines, isJson) {
  const symbols = [];
  if (isJson) {
    let keyIndent = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]+)"([^"]+)"\s*:/.exec(lines[i]);
      if (m && m[1] && m[2]) {
        if (keyIndent === null) {
          keyIndent = m[1];
        }
        if (m[1] === keyIndent) {
          symbols.push({
            kind: "key",
            name: m[2],
            startLine: i + 1,
            endLine: i + 1,
            depth: 0
          });
        }
      }
    }
    for (let idx = 0; idx < symbols.length; idx++) {
      const cur = symbols[idx];
      const nextStart = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length - 1;
      let endLine = Math.max(cur.startLine, nextStart);
      while (endLine > cur.startLine && /^\s*[}\]]?,?\s*$/.test(lines[endLine - 1] ?? "") && idx === symbols.length - 1) {
        endLine--;
      }
      cur.endLine = endLine;
    }
    return symbols;
  }
  const re = /^([A-Za-z0-9_.-]+)\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && m[1]) {
      symbols.push({
        kind: "key",
        name: m[1],
        startLine: i + 1,
        endLine: i + 1,
        depth: 0
      });
    }
  }
  for (let idx = 0; idx < symbols.length; idx++) {
    const cur = symbols[idx];
    let endLine = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length;
    while (endLine > cur.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    cur.endLine = Math.max(cur.startLine, endLine);
  }
  return symbols;
}
function extractCssSymbols(lines, compactOnly = false) {
  const symbols = [];
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  let braceDepth = 0;
  const atRuleRe = /^@(layer|media|keyframes|supports|container|font-face|theme)\b([^{;]*)/i;
  const tokenBlockRe = /^(:root\b|html(?:\[[^\]]+\]|\.[A-Za-z_-][\w-]*)?(?=\s|[,{])|\[data-theme[^\]]*\]|body\b)[^{;]*\{/;
  const extractCssSectionComment = (text) => {
    if (text.length < 6 || text.length > 200) return null;
    if (!text.startsWith("/*") || !text.endsWith("*/")) return null;
    const inner = text.slice(2, -2);
    if (inner.includes("/*") || inner.includes("*/")) return null;
    const cleaned = inner.replace(/^[\s=\-*#]+/, "").replace(/[\s=\-*#]+$/, "");
    if (cleaned.length < 2 || cleaned.length > 71) return null;
    if (/[*/]/.test(cleaned) || cleaned.startsWith("=")) return null;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(cleaned)) return null;
    return cleaned.slice(0, 64);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const wasInComment = state.inBlockComment;
    if (!wasInComment && braceDepth === 0 && trimmed) {
      const sectionName = extractCssSectionComment(trimmed);
      if (sectionName) {
        symbols.push({
          kind: "section",
          name: sectionName,
          startLine: i + 1,
          endLine: i + 1,
          depth: 0
        });
      } else {
        const am = atRuleRe.exec(trimmed);
        if (am && am[1]) {
          const endLine = trimmed.includes("{") ? findBraceBlockEnd(lines, i, "c") : i + 1;
          const rest = (am[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
          symbols.push({
            kind: `@${am[1].toLowerCase()}`,
            name: rest || `@${am[1].toLowerCase()}`,
            startLine: i + 1,
            endLine,
            depth: 0
          });
        } else {
          const tm = tokenBlockRe.exec(trimmed);
          if (tm && tm[1]) {
            const endLine = findBraceBlockEnd(lines, i, "c");
            const header = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
            symbols.push({
              kind: "tokens",
              name: header || tm[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
          }
        }
      }
    }
    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);
  }
  if (!compactOnly && symbols.length < 10) {
    const fallbackState = {
      inBlockComment: false,
      templateExprStack: [],
      inBacktick: false
    };
    let d = 0;
    let lastAddedLine = -999;
    const seen = new Set(symbols.map((s) => s.startLine));
    for (let i = 0; i < lines.length && symbols.length < 40; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const wasInComment = fallbackState.inBlockComment;
      if (!wasInComment && d === 0 && !seen.has(i + 1) && i - lastAddedLine >= 10 && /^[.#\[a-zA-Z*:]/.test(trimmed) && trimmed.includes("{") && !trimmed.startsWith("@")) {
        const sel = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
        if (sel) {
          const endLine = findBraceBlockEnd(lines, i, "c");
          symbols.push({
            kind: "rule",
            name: sel,
            startLine: i + 1,
            endLine,
            depth: 0
          });
          lastAddedLine = i;
        }
      }
      const { open, close } = scanBracesOnLine(line, fallbackState, "c");
      d = Math.max(0, d + open - close);
    }
    symbols.sort((a, b) => a.startLine - b.startLine);
  }
  return symbols;
}
function extractSfcSymbols(lines) {
  const symbols = [];
  const blockOpenRe = /^<(script|template|style)\b([^>]*)>/i;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = blockOpenRe.exec(line.trim());
    if (!m || !m[1] || line.startsWith("  ") || line.startsWith("	")) {
      i++;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = (m[2] ?? "").trim();
    const startIdx = i;
    let endIdx = i;
    if (tag === "template") {
      let depth = 0;
      const openTemplateRe = /<template\b[^>]*>/gi;
      const closeTemplateRe = /<\/template\s*>/gi;
      for (let j = i; j < lines.length; j++) {
        const ln = lines[j];
        const opens = ln.match(openTemplateRe)?.length ?? 0;
        const closes = ln.match(closeTemplateRe)?.length ?? 0;
        depth += opens - closes;
        if (depth <= 0) {
          endIdx = j;
          break;
        }
        endIdx = j;
      }
    } else {
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      for (let j = i; j < lines.length; j++) {
        endIdx = j;
        if (j > i && closeRe.test(lines[j])) break;
        if (j === i && closeRe.test(lines[j].slice(m[0].length))) break;
      }
    }
    const headerLabel = attrs ? `<${tag} ${attrs.slice(0, 40)}>` : `<${tag}>`;
    symbols.push({
      kind: tag,
      name: headerLabel,
      startLine: startIdx + 1,
      endLine: endIdx + 1,
      depth: 0
    });
    const innerStart = startIdx + 1;
    const innerLines = lines.slice(innerStart, endIdx);
    if (tag === "script" && innerLines.length > 0) {
      const innerSyms = extractTsJsSymbols(innerLines);
      for (const s of innerSyms) {
        symbols.push({
          kind: s.kind,
          name: s.name,
          startLine: s.startLine + innerStart,
          endLine: s.endLine + innerStart,
          depth: s.depth + 1
        });
      }
    } else if (tag === "template" && innerLines.length >= 30) {
      let landmarks = 0;
      const extractHtmlCommentLandmark = (text) => {
        if (text.length < 10 || text.length > 200) return null;
        if (!text.startsWith("<!--") || !text.endsWith("-->")) return null;
        const inner = text.slice(4, -3);
        if (inner.includes("<!--") || inner.includes("-->") || inner.includes(">")) return null;
        const cleaned = inner.replace(/^[\s=\-*#]+/, "").replace(/[\s=\-*#]+$/, "");
        if (cleaned.length < 3 || cleaned.length > 61) return null;
        if (cleaned.startsWith("-")) return null;
        return cleaned;
      };
      const semanticTagRe = /^<(header|nav|main|aside|section|footer|dialog|form|[A-Z][A-Za-z0-9]*(?:Modal|Drawer|Dialog|Panel))\b([^>]*)>/;
      for (let k = 0; k < innerLines.length && landmarks < 14; k++) {
        const raw = innerLines[k];
        const indent = raw.length - raw.trimStart().length;
        if (indent > 8) continue;
        const trimmed = raw.trim();
        const landmarkName = extractHtmlCommentLandmark(trimmed);
        if (landmarkName) {
          symbols.push({
            kind: "section",
            name: landmarkName,
            startLine: innerStart + k + 1,
            endLine: innerStart + k + 1,
            depth: 1
          });
          landmarks++;
          continue;
        }
        const sm = semanticTagRe.exec(trimmed);
        if (sm && sm[1]) {
          const attrStr = sm[2] ?? "";
          const idMatch = /(?:data-testid|id|class)=["']([^"']+)["']/.exec(attrStr);
          const tagDesc = idMatch && idMatch[1] ? `<${sm[1]} ${idMatch[1].slice(0, 36)}>` : `<${sm[1]}>`;
          symbols.push({
            kind: "block",
            name: tagDesc,
            startLine: innerStart + k + 1,
            endLine: innerStart + k + 1,
            depth: 1
          });
          landmarks++;
        }
      }
    } else if (tag === "style" && innerLines.length > 0) {
      const cssSyms = extractCssSymbols(innerLines, true).slice(0, 12);
      for (const s of cssSyms) {
        symbols.push({
          kind: s.kind,
          name: s.name,
          startLine: s.startLine + innerStart,
          endLine: s.endLine + innerStart,
          depth: 1
        });
      }
    }
    i = endIdx + 1;
  }
  return symbols.length > 0 ? symbols : extractTsJsSymbols(lines);
}
function extractSymbolsFromLines(filePath, lines) {
  if (lines.length > 0 && lines[0].startsWith("\uFEFF")) {
    lines = [lines[0].slice(1), ...lines.slice(1)];
  }
  const ext = path4.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTsJsSymbols(lines);
    case ".vue":
    case ".svelte":
      return extractSfcSymbols(lines);
    case ".css":
    case ".scss":
    case ".less":
    case ".pcss":
      return extractCssSymbols(lines);
    case ".py":
      return extractPythonSymbols(lines);
    case ".gd":
      return extractGdScriptSymbols(lines);
    case ".go":
      return extractGoSymbols(lines);
    case ".rs":
      return extractRustSymbols(lines);
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return extractCLikeSymbols(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return extractShellSymbols(lines);
    case ".md":
    case ".mdx":
      return extractMarkdownSymbols(lines);
    case ".json":
      return extractJsonYamlSymbols(lines, true);
    case ".yaml":
    case ".yml":
      return extractJsonYamlSymbols(lines, false);
    default:
      return extractTsJsSymbols(lines);
  }
}
var MAX_OUTLINES = 40;
var MAX_SLICE_FILES = 30;
var MAX_OUTLINE_CACHE_ENTRIES = 128;
var OUTLINE_SYMBOL_CACHE = /* @__PURE__ */ new Map();
var MAX_OUTLINE_L1_EVICTED_TRACK = 512;
var OUTLINE_L1_EVICTED_KEYS = /* @__PURE__ */ new Set();
var MAX_SLICE_CACHE_TOTAL_BYTES = 4 * 1024 * 1024;
var MAX_SLICE_CACHE_FILE_BYTES = 256 * 1024;
var SLICE_LINES_CACHE = /* @__PURE__ */ new Map();
var sliceLinesCacheBytes = 0;
var outlineDbStore = null;
var outlineDbInitPromise = null;
var outlineDbDisabled = false;
var sqliteWarningFilterInstalled = false;
function installSqliteWarningFilter() {
  if (sqliteWarningFilterInstalled) return;
  sqliteWarningFilterInstalled = true;
  try {
    const origEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = (warning, ...args) => {
      const msg = typeof warning === "string" ? warning : String(warning?.message || "");
      const type = typeof args[0] === "string" ? args[0] : (args[0]?.type || warning?.name || "");
      if (/ExperimentalWarning/i.test(String(type)) && /sqlite/i.test(msg)) {
        return;
      }
      return origEmitWarning(warning, ...args);
    };
  } catch {
  }
}
function isOutlineDbDisabled() {
  return outlineDbDisabled || !getEffectiveConfig().outlineDb;
}
function resolveOutlineDbPath() {
  const cfgDb = getEffectiveConfig().dbPath;
  if (cfgDb) return cfgDb;
  return path.join(os.homedir(), ".agy-dart", "context.db");
}
async function getOutlineDbStore() {
  if (isOutlineDbDisabled()) return null;
  if (outlineDbStore) return outlineDbStore;
  if (!outlineDbInitPromise) {
    outlineDbInitPromise = (async () => {
      installSqliteWarningFilter();
      try {
        const mod = await import("../context/lib/store.js");
        const store = new mod.ContextModeStore();
        store.open();
        outlineDbStore = store;
        return store;
      } catch {
        outlineDbDisabled = true;
        return null;
      }
    })();
  }
  return outlineDbInitPromise;
}
function closeOutlineDbStore() {
  if (outlineDbStore) {
    try {
      outlineDbStore.close();
    } catch {
    }
    outlineDbStore = null;
  }
  outlineDbInitPromise = null;
}
function setOutlineL1Cache(cacheKey, entry) {
  OUTLINE_L1_EVICTED_KEYS.delete(cacheKey);
  if (OUTLINE_SYMBOL_CACHE.has(cacheKey)) {
    OUTLINE_SYMBOL_CACHE.delete(cacheKey);
  } else if (OUTLINE_SYMBOL_CACHE.size >= MAX_OUTLINE_CACHE_ENTRIES) {
    const oldestKey = OUTLINE_SYMBOL_CACHE.keys().next().value;
    if (oldestKey !== void 0) {
      OUTLINE_SYMBOL_CACHE.delete(oldestKey);
      if (OUTLINE_L1_EVICTED_KEYS.size >= MAX_OUTLINE_L1_EVICTED_TRACK) {
        const oldestEvicted = OUTLINE_L1_EVICTED_KEYS.values().next().value;
        if (oldestEvicted !== void 0) OUTLINE_L1_EVICTED_KEYS.delete(oldestEvicted);
      }
      OUTLINE_L1_EVICTED_KEYS.add(oldestKey);
    }
  }
  OUTLINE_SYMBOL_CACHE.set(cacheKey, entry);
}
function normalizeFileCacheKey(absPath) {
  return process.platform === "win32" ? absPath.toLowerCase() : absPath;
}
function deleteSliceCacheKey(cacheKey) {
  const prev = SLICE_LINES_CACHE.get(cacheKey);
  if (!prev) return;
  SLICE_LINES_CACHE.delete(cacheKey);
  sliceLinesCacheBytes = Math.max(0, sliceLinesCacheBytes - prev.byteWeight);
}
function setSliceCacheEntry(cacheKey, entry) {
  const size = Number(entry?.size ?? 0);
  if (!Number.isFinite(size) || size > MAX_SLICE_CACHE_FILE_BYTES) {
    deleteSliceCacheKey(cacheKey);
    return false;
  }
  const byteWeight = Math.max(1, size);
  deleteSliceCacheKey(cacheKey);
  while (sliceLinesCacheBytes + byteWeight > MAX_SLICE_CACHE_TOTAL_BYTES && SLICE_LINES_CACHE.size > 0) {
    const oldestKey = SLICE_LINES_CACHE.keys().next().value;
    if (oldestKey === void 0) break;
    deleteSliceCacheKey(oldestKey);
  }
  SLICE_LINES_CACHE.set(cacheKey, {
    mtimeMs: entry.mtimeMs,
    size,
    byteWeight,
    lines: entry.lines
  });
  sliceLinesCacheBytes += byteWeight;
  return true;
}
async function invalidateFileCaches(absPaths) {
  BATCH_SEARCH_CACHE.clear();
  if (!Array.isArray(absPaths)) return;
  const validPaths = [];
  for (const p of absPaths) {
    if (!p || typeof p !== "string") continue;
    validPaths.push(p);
    const key = normalizeFileCacheKey(p);
    OUTLINE_SYMBOL_CACHE.delete(key);
    OUTLINE_L1_EVICTED_KEYS.delete(key);
    deleteSliceCacheKey(key);
  }
  if (validPaths.length === 0 || isOutlineDbDisabled()) return;
  try {
    let store = outlineDbStore;
    if (!store) {
      const dbPath = resolveOutlineDbPath();
      const exists = await fs.access(dbPath).then(() => true).catch(() => false);
      if (exists) {
        store = await getOutlineDbStore();
      }
    }
    if (store) {
      store.deleteOutlineCache(validPaths);
    }
  } catch {
    // Strictly fail-open
  }
}
var SLICE_TRUNCATION_TIP = "\n[tip: MCP responses are hard-capped <=8.8KB inline; for >150 lines across files, use parallel read_file(StartLine, EndLine) (46KB/call, 0 remote check)]";
var OUTLINE_BATCH_TIP = "\n[tip: outlining >20 files splits the 8.8KB cap thinly; batch 10-20 files per call for fuller outlines]";
function selectOutlineSymbols(symbols, limit) {
  if (symbols.length <= limit) return symbols;
  const keptIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < symbols.length && keptIndices.size < limit; i++) {
    if (symbols[i].depth === 0) keptIndices.add(i);
  }
  for (let i = 0; i < symbols.length && keptIndices.size < limit; i++) {
    keptIndices.add(i);
  }
  return [...keptIndices].sort((a, b) => a - b).map((idx) => symbols[idx]);
}
async function runReadSlices(input) {
  const outlines = Array.isArray(input.outlines) ? input.outlines : [];
  const slices = Array.isArray(input.slices) ? input.slices : [];
  if (outlines.length === 0 && slices.length === 0) {
    return {
      text: "Error: provide at least one entry in 'outlines' or 'slices'.",
      isError: true
    };
  }
  if (outlines.length > MAX_OUTLINES || slices.length > MAX_SLICE_FILES) {
    return {
      text: `Error: limits exceeded (max ${MAX_OUTLINES} outlines and ${MAX_SLICE_FILES} slice files per call).`,
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  const maxChars = clampIntWithDefault(
    input.maxChars,
    8500,
    1e3,
    DEFAULT_INLINE_MAX_BYTES
  );
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const perFileSymbolLimit = outlines.length <= 1 ? 120 : outlines.length <= 4 ? 60 : outlines.length <= 10 ? 30 : outlines.length <= 20 ? 16 : 10;
  const fileCache = /* @__PURE__ */ new Map();
  const normalizeCacheKey = normalizeFileCacheKey;
  async function loadLines(absPath, { useSliceCache = false, existingStat = null } = {}) {
    const key = normalizeCacheKey(absPath);
    const cachedInCall = fileCache.get(key);
    if (cachedInCall) {
      if (useSliceCache) {
        setSliceCacheEntry(key, cachedInCall);
      }
      return cachedInCall;
    }
    if (useSliceCache) {
      const stat = existingStat ?? await fs.stat(absPath);
      if (!stat.isFile()) {
        throw new Error(`Not a regular file: ${absPath}`);
      }
      const crossCached = SLICE_LINES_CACHE.get(key);
      if (crossCached && crossCached.mtimeMs === stat.mtimeMs && crossCached.size === stat.size) {
        SLICE_LINES_CACHE.delete(key);
        SLICE_LINES_CACHE.set(key, crossCached);
        const entry2 = { lines: crossCached.lines, size: crossCached.size, mtimeMs: crossCached.mtimeMs };
        fileCache.set(key, entry2);
        return entry2;
      }
    }
    const data = await readTextFile(absPath);
    const lines = data.content.replace(/\r\n/g, "\n").split("\n");
    const entry = { lines, size: data.size, mtimeMs: data.mtimeMs };
    fileCache.set(key, entry);
    if (useSliceCache) {
      setSliceCacheEntry(key, entry);
    }
    return entry;
  }
  const sections = [];
  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath) => {
        const absPath = resolvePath(rawPath, baseCwd);
        const cacheKey = normalizeCacheKey(absPath);
        const relPath = toPosixPath(path4.relative(baseCwd, absPath)) || path4.basename(absPath);
        try {
          const stat = await fs.stat(absPath);
          if (!stat.isFile()) {
            throw new Error(`Not a regular file: ${absPath}`);
          }
          let lineCount;
          let symbols;
          const cached = OUTLINE_SYMBOL_CACHE.get(cacheKey);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            OUTLINE_SYMBOL_CACHE.delete(cacheKey);
            OUTLINE_SYMBOL_CACHE.set(cacheKey, cached);
            lineCount = cached.lineCount;
            symbols = cached.symbols;
          } else {
            const wasEvictedFromL1 = OUTLINE_L1_EVICTED_KEYS.delete(cacheKey);
            let l2Hit = null;
            const dbStore = await getOutlineDbStore();
            if (dbStore && !wasEvictedFromL1) {
              try {
                l2Hit = dbStore.getOutlineCache(absPath, stat.mtimeMs, stat.size);
              } catch {
                l2Hit = null;
              }
            }
            if (l2Hit) {
              lineCount = l2Hit.lineCount;
              symbols = l2Hit.symbols;
              setOutlineL1Cache(cacheKey, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                lineCount,
                symbols
              });
            } else {
              const { lines, size, mtimeMs } = await loadLines(absPath, { useSliceCache: false, existingStat: stat });
              lineCount = lines.length;
              symbols = extractSymbolsFromLines(absPath, lines);
              const effMtime = mtimeMs ?? stat.mtimeMs;
              const effSize = size ?? stat.size;
              setOutlineL1Cache(cacheKey, {
                mtimeMs: effMtime,
                size: effSize,
                lineCount,
                symbols
              });
              if (dbStore) {
                try {
                  dbStore.setOutlineCache(absPath, effMtime, effSize, lineCount, symbols);
                } catch {
                  // Strictly fail-open
                }
              }
            }
          }
          if (symbols.length === 0) {
            return `## Outline: ${relPath} (${lineCount} lines)
(no top-level symbols detected)`;
          }
          const picked = selectOutlineSymbols(symbols, perFileSymbolLimit);
          const formatted = picked.map((s) => {
            const indent = "  ".repeat(s.depth);
            const span = s.endLine > s.startLine ? `L${s.startLine}-L${s.endLine}` : `L${s.startLine}`;
            return `${indent}${span} [${s.kind}] ${s.name}`;
          });
          const extra = symbols.length > picked.length ? outlines.length > 10 ? `
... (+${symbols.length - picked.length} more symbols)` : `
... (${symbols.length - picked.length} more symbols omitted; outline this file alone for full list)` : "";
          return `## Outline: ${relPath} (${lineCount} lines)
${formatted.join("\n")}${extra}`;
        } catch (err) {
          if (err && err.code === "ENOENT") {
            OUTLINE_SYMBOL_CACHE.delete(cacheKey);
            deleteSliceCacheKey(cacheKey);
            if (outlineDbStore) {
              try {
                outlineDbStore.deleteOutlineCache(absPath);
              } catch {
              }
            }
          }
          return `## Outline: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    );
    sections.push(...outlineResults);
  }
  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req) => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return "## Slice: (invalid)\nERROR: 'path' must be a non-empty string";
        }
        const absPath = resolvePath(req.path, baseCwd);
        const cacheKey = normalizeCacheKey(absPath);
        const relPath = toPosixPath(path4.relative(baseCwd, absPath)) || path4.basename(absPath);
        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return `## Slice: ${relPath}
ERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`;
        }
        try {
          const { lines } = await loadLines(absPath, { useSliceCache: true });
          const totalLines = lines.length;
          const blocks = [];
          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Math.trunc(Number(range[0]));
            const rawEnd = Math.trunc(Number(range[1]));
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(`ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`);
              continue;
            }
            const start = Math.max(1, rawStart);
            const end = Math.min(totalLines, rawEnd);
            if (start > totalLines) {
              blocks.push(
                `--- L${rawStart}-L${rawEnd} (out of bounds; file has ${totalLines} lines) ---`
              );
              continue;
            }
            if (end < start) {
              blocks.push(
                `ERROR: startLine (${rawStart}) > endLine (${rawEnd})`
              );
              continue;
            }
            const width = String(end).length;
            const snippet = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
          }
          return `## Slice: ${relPath} (${totalLines} lines)
${blocks.join("\n")}`;
        } catch (err) {
          if (err && err.code === "ENOENT") {
            OUTLINE_SYMBOL_CACHE.delete(cacheKey);
            deleteSliceCacheKey(cacheKey);
            if (outlineDbStore) {
              try {
                outlineDbStore.deleteOutlineCache(absPath);
              } catch {
              }
            }
          }
          return `## Slice: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    );
    sections.push(...sliceResults);
  }
  const rawJoined = sections.join("\n\n");
  const rawBytes = Buffer.byteLength(rawJoined, "utf8");
  const isOverBudget = rawJoined.length > maxChars || rawBytes > maxBytes;
  const activeTip = isOverBudget && slices.length > 0 ? SLICE_TRUNCATION_TIP : isOverBudget && outlines.length > 20 ? OUTLINE_BATCH_TIP : null;
  if (activeTip && maxChars > activeTip.length + 200) {
    const tipBytes = Buffer.byteLength(activeTip, "utf8");
    const body = fitSectionsToByteBudget(
      sections,
      maxChars - activeTip.length,
      maxBytes - tipBytes,
      "\n\n"
    );
    return {
      text: `${body}${activeTip}`,
      isError: false
    };
  }
  return {
    text: fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n"),
    isError: false
  };
}

// src/tools/run-checks.ts
import { promises as fs4 } from "node:fs";
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runWorker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
async function runChecks(input) {
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true
    };
  }
  if (input.commands.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs4.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const concurrency = clampInt2(input.concurrency ?? 4, 1, 8);
  const defaultTimeoutSec = clampInt2(input.timeoutSec ?? 60, 1, 300);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt2(input.maxChars ?? 8e3, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const normalized = [];
  for (let i = 0; i < input.commands.length; i++) {
    const raw = input.commands[i];
    const spec = typeof raw === "string" ? { command: raw } : raw;
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true
      };
    }
    const cmdCwd = spec.cwd ? resolvePath(spec.cwd, baseCwd) : baseCwd;
    if (spec.cwd) {
      try {
        const st = await fs4.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true
        };
      }
    }
    const cmdTimeoutSec = clampInt2(
      spec.timeoutSec ?? defaultTimeoutSec,
      1,
      300
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1e3
    });
  }
  const wallStart = Date.now();
  const outcomes = await mapWithConcurrency(
    normalized,
    concurrency,
    async (spec) => {
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, result, passed };
    }
  );
  BATCH_SEARCH_CACHE.clear();
  const wallMs = Date.now() - wallStart;
  const passedCount = outcomes.filter((o) => o.passed).length;
  const failedCount = outcomes.length - passedCount;
  const summaryHeader = failedCount === 0 ? `Checks: ${passedCount}/${outcomes.length} passed (wall: ${wallMs}ms)` : `Checks: ${passedCount}/${outcomes.length} passed, ${failedCount} failed (wall: ${wallMs}ms)`;
  const usableChars = Math.max(200, maxChars - summaryHeader.length - 4);
  const failedBudget = failedCount > 0 ? Math.max(160, Math.floor((usableChars - passedCount * 120) / failedCount)) : 320;
  const fullPerCmdBudget = Math.max(
    160,
    Math.floor(usableChars / outcomes.length)
  );
  const blocks = outcomes.map(({ spec, result, passed }) => {
    const badge = result.error ? "ERROR" : result.timedOut ? "TIMEOUT" : passed ? "PASS" : `FAIL (exit ${result.exitCode ?? "err"})`;
    if (outputMode === "full") {
      const combined = [
        normalizeTerminalOutput(result.stdout),
        normalizeTerminalOutput(result.stderr)
      ].filter(Boolean).join("\n");
      const body2 = result.error ? `spawn error: ${result.error}` : truncateWithNotice(combined || "(no output)", fullPerCmdBudget);
      return `## [${badge}] ${spec.name} (${result.durationMs}ms)
$ ${spec.command}
${body2}`;
    }
    const body = formatCompactCommandOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      error: result.error,
      maxChars: passed ? 300 : failedBudget
    });
    if (passed) {
      return `- [PASS ${result.durationMs}ms] ${spec.name} (\`${spec.command}\`): ${body}`;
    }
    return `## [${badge} ${result.durationMs}ms] ${spec.name}
$ ${spec.command}
${body}`;
  });
  const bodyBudget = Math.max(0, maxChars - summaryHeader.length - 2);
  const bodyByteBudget = maxBytes !== void 0 ? Math.max(0, maxBytes - Buffer.byteLength(summaryHeader, "utf8") - 2) : void 0;
  const fittedBlocks = fitSectionsToByteBudget(
    blocks,
    bodyBudget,
    bodyByteBudget,
    "\n\n"
  );
  let text = truncateWithNotice(
    `${summaryHeader}

${fittedBlocks}`,
    maxChars
  );
  if (maxBytes !== void 0) {
    text = truncateWithByteNotice(text, maxBytes);
  }
  return { text, isError: false };
}
function clampInt2(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

// src/mcp-server.ts
var SERVER_VERSION = "0.2.2";
function createAgyFastServer() {
  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION
  });
  server.registerTool(
    {
      name: "batch_search",
      description: "Run concurrent text/regex searches, globs, and read-only git queries (<=8.8KB).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["text", "regex", "glob", "git"] },
                pattern: { type: "string", description: "Text, regex, glob (*,{a,b}), or read-only git subcommand" },
                path: { type: "string" },
                glob: { type: "string" },
                caseSensitive: { type: "boolean" },
                contextLines: { type: "integer", minimum: 0, maximum: 5 },
                maxResults: { type: "integer", minimum: 1, maximum: 200 }
              },
              required: ["type", "pattern"]
            }
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 }
        },
        required: ["queries"]
      }
    },
    (args) => runBatchSearch(args)
  );
  server.registerTool(
    {
      name: "apply_edits",
      description: "Atomically apply multi-hunk edits or file creation across files, with optional verify command.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                hunks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      target: { type: "string" },
                      replacement: { type: "string" },
                      startLine: { type: "integer", minimum: 1 },
                      endLine: { type: "integer", minimum: 1 },
                      replaceAll: { type: "boolean" }
                    },
                    required: ["target", "replacement"]
                  }
                },
                create: { type: "string", description: "Full content instead of hunks" },
                overwrite: { type: "boolean" }
              },
              required: ["path"]
            }
          },
          dryRun: { type: "boolean" },
          bestEffort: { type: "boolean", description: "Commit valid files even if others fail" },
          verify: { type: "string", description: "Post-write shell command" },
          verifyTimeoutSec: { type: "integer", minimum: 1, maximum: 300 },
          maxVerifyChars: { type: "integer", minimum: 300, maximum: 7500 }
        },
        required: ["edits"]
      }
    },
    (args) => runApplyEdits(args)
  );
  server.registerTool(
    {
      name: "read_slices",
      description: "Batch-extract symbol outlines (max 40 files) and small 1-based line slices (<=8.8KB).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" },
            description: "File paths to outline (prefer 10-20/batch)"
          },
          slices: {
            type: "array",
            maxItems: 30,
            description: "1-based inclusive [startLine,endLine] ranges",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 }
                  }
                }
              },
              required: ["path", "ranges"]
            }
          },
          maxChars: { type: "integer", minimum: 1e3, maximum: 8800 }
        }
      }
    },
    (args) => runReadSlices(args)
  );
  server.registerTool(
    {
      name: "run_checks",
      description: "Run independent shell checks concurrently (<=8.8KB).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                timeoutSec: { type: "integer", minimum: 1, maximum: 300 }
              },
              required: ["command"]
            }
          },
          concurrency: { type: "integer", minimum: 1, maximum: 8 },
          timeoutSec: { type: "integer", minimum: 1, maximum: 300 },
          outputMode: {
            type: "string",
            enum: ["compact", "full"],
            description: "compact hides pass logs (default)"
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 }
        },
        required: ["commands"]
      }
    },
    (args) => runChecks(args)
  );
  return server;
}
function main() {
  const server = createAgyFastServer();
  const exitImmediately = () => {
    closeOutlineDbStore();
    process.exit(0);
  };
  const flushAndExit = () => {
    closeOutlineDbStore();
    process.stdout.end(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  process.on("exit", () => {
    closeOutlineDbStore();
  });
  server.listen(process.stdin, process.stdout, flushAndExit);
}
main();
export {
  createAgyFastServer
};
