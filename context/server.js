#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "../hooks/compile-cache.mjs";

try {
  enableVersionedCompileCache();
} catch {}

const [{ stableSortObject }, { ContextModeStore }, { createTools }] = await Promise.all([
  import("./lib/stable-json.js"),
  import("./lib/store.js"),
  import("./lib/tools.js")
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pkgVersion = "1.2.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  if (pkg.version) pkgVersion = pkg.version;
} catch {}

const store = new ContextModeStore();
let currentCwd = process.cwd();
let initSessionId = null;
const callContext = new AsyncLocalStorage();

function normalizeCallSessionId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed)) return null;
  return trimmed;
}

const tools = createTools({
  store,
  getCwd: () => currentCwd,
  getSessionId: () =>
    callContext.getStore()?.sessionId ||
    initSessionId ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.CONVERSATION_ID ||
    "default",
  getDirectConversationId: () =>
    callContext.getStore()?.directConversationId ||
    callContext.getStore()?.sessionId ||
    initSessionId ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    process.env.CONVERSATION_ID ||
    "default"
});

// Deterministic, compact Turn-0 tool schemas (keeps server KV-cache prefix lean and stable)
const RAW_TOOL_DEFINITIONS = [
  {
    name: "ctx_batch",
    description: "Run sequential shell commands, index combined output into FTS5, and return matching snippets (<=8.8 KB). Prefer agy-dart_fast run_checks for concurrent builds/tests.",
    inputSchema: {
      type: "object",
      properties: {
        commands: { type: "array", items: { type: "string" }, description: "Shell commands" },
        queries: { type: "array", items: { type: "string" }, description: "Optional search queries" }
      },
      required: ["commands"]
    }
  },
  {
    name: "ctx_doctor",
    description: "Check SQLite WAL/FTS5 health, DB size, feature toggles, and runtimes.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ctx_execute",
    description: "Run JS/Python/Shell/PowerShell in a local sandbox to filter >16 KB logs or giant JSON/CSV/API data; returns concise output (<=8.8 KB) and indexes full output.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["javascript", "nodejs", "python", "shell", "powershell", "cmd"] },
        code: { type: "string", description: "Script source" },
        file: { type: "string", description: "Script path" },
        args: { type: "array", items: { type: "string" }, description: "CLI args" },
        intent: { type: "string", description: "Short purpose label" }
      }
    }
  },
  {
    name: "ctx_index",
    description: "Index a local file, URL, or raw text into SQLite FTS5 (heading-aware for Markdown).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local file path" },
        url: { type: "string", description: "HTTP/HTTPS URL" },
        content: { type: "string", description: "Raw text" },
        label: { type: "string", description: "Source label" }
      }
    }
  },
  {
    name: "ctx_purge",
    description: "Purge indexed sources/events for session, worktree, all, or stale TTL entries (with optional VACUUM).",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["session", "worktree", "all", "stale"] },
        sessionId: { type: "string", description: "Optional conversationId for scope='session' (avoids purging shared 'default')" },
        olderThanDays: { type: "integer", description: "TTL age in days for scope='stale' (default 14)" },
        vacuum: { type: "boolean", description: "Run SQLite VACUUM when scope='stale'" }
      }
    }
  },
  {
    name: "ctx_resume",
    description: "Recover indexed sources/events and PostToolUse checkpoint after /compact (pass current Conversation ID as sessionId in shared MCP hosts).",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "integer", description: "Optional event sequence #" },
        sessionId: { type: "string", description: "Optional conversationId to recover this conversation's PostToolUse checkpoint" }
      }
    }
  },
  {
    name: "ctx_search",
    description: "Search SQLite FTS5 sources via Porter BM25 + Trigram RRF.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "Search queries" },
        sourceId: { type: "string", description: "Restrict to sourceId" },
        scope: { type: "string", enum: ["session", "worktree", "all"] },
        limit: { type: "integer", description: "Max hits (default 5)" },
        offset: { type: "integer", description: "Pagination offset" }
      },
      required: ["queries"]
    }
  },
  {
    name: "ctx_stats",
    description: "Show context savings report (sandbox, CLI filter, read dedup, interceptions).",
    inputSchema: {
      type: "object",
      properties: {
        reset: { type: "boolean", description: "Reset session stats" },
        sessionId: { type: "string", description: "Optional conversationId for per-conversation stats" }
      }
    }
  }
];

export const TOOL_DEFINITIONS = Object.freeze(
  RAW_TOOL_DEFINITIONS
    .map((def) => stableSortObject(def))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
);

function sendJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(id, result) {
  sendJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendJsonRpc({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) }
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, "Parse error", String(err));
    return;
  }

  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    sendError(null, -32600, "Invalid Request", "JSON-RPC message must be a JSON object");
    return;
  }

  const { id, method, params } = msg;
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize": {
        if (params?.rootPath) currentCwd = params.rootPath;
        const initSid = normalizeCallSessionId(params?.sessionId);
        if (initSid) initSessionId = initSid;
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "agy-dart-context",
            version: pkgVersion
          }
        });
        break;
      }

      case "ping": {
        sendResponse(id, {});
        break;
      }

      case "tools/list": {
        sendResponse(id, { tools: TOOL_DEFINITIONS });
        break;
      }

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        // Strictly per-call session isolation via AsyncLocalStorage: never mutate process-global
        // session state across concurrent conversations sharing one long-lived MCP stdio server.
        const callSessionId =
          [
            toolArgs.sessionId,
            toolArgs.conversationId,
            params?._meta?.rootConversationId,
            params?._meta?.conversationId,
            params?._meta?.sessionId,
            params?.sessionId
          ]
            .map(normalizeCallSessionId)
            .find(Boolean) ?? null;
        const callDirectConvId =
          [
            toolArgs.conversationId,
            toolArgs.sessionId,
            params?._meta?.conversationId,
            params?._meta?.sessionId,
            params?.sessionId
          ]
            .map(normalizeCallSessionId)
            .find(Boolean) ?? null;

        if (typeof toolName !== "string" || !Object.hasOwn(tools, toolName)) {
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          break;
        }

        try {
          const result = await callContext.run(
            { sessionId: callSessionId, directConversationId: callDirectConvId },
            () => tools[toolName](toolArgs)
          );
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
              }
            ],
            isError: false
          });
        } catch (toolErr) {
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Tool error (${toolName}): ${toolErr.message || String(toolErr)}`
              }
            ],
            isError: true
          });
        }
        break;
      }

      default: {
        sendError(id, -32601, `Method not found: ${method}`);
        break;
      }
    }
  } catch (handlerErr) {
    sendError(id, -32603, "Internal server error", String(handlerErr));
  }
});

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  store.close();
  process.exit(0);
});
