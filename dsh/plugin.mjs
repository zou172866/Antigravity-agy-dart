/**
 * agy-dart native DeepSeek Harness (DSH) Cordis plugin.
 * Zero external dependencies — loaded directly from cordis.patch.yml by absolute path.
 * Bridges DSH native `tools/pre-execute`, `tools/execute`, `tools/result`, and
 * `ctx.systemPrompt` directly to agy-dart's in-process read guard, CLI filter,
 * and file_reads cache invalidation with zero child-process spawn overhead.
 */
import { evaluatePreToolPayload } from "../hooks/pre-tool-use.mjs";
import { processPostToolPayload } from "../hooks/post-tool-use.mjs";

export const name = "agy-dart";
export const inject = ["tools"];

export const DSH_ROUTING_PROMPT = [
  "# agy-dart tool routing",
  "Prefer agy-dart MCP tools when available:",
  "- `mcp__agy_dart_fast__*`: batch queries via `batch_search`; outline large files via `read_slices({ outlines })` before ranged `read`; multi-file edits + verify via `apply_edits`; short checks via `run_checks`.",
  "- `mcp__agy_dart_context__*`: filter >16 KB logs/JSON/CSV/API output via `ctx_execute`; index long docs/URLs once via `ctx_index` then query via `ctx_search`; restore checkpoints after compaction via `ctx_resume`."
].join("\n");

const PRE_GUARD_TOOLS = new Set(["read", "bash", "pwsh"]);
const POST_TRACK_RE =
  /^(?:edit|write|apply_patch|str_replace_editor|bash|pwsh|mcp_+agy[-_]dart_(?:fast|context)_+(?:apply_edits|run_checks|read_slices|batch_search|ctx_resume|ctx_execute|ctx_index|ctx_batch))$/i;

function resolveSessionId(exec) {
  return (
    exec?.agent?.session?.id ||
    exec?.agent?.sessionId ||
    exec?.agent?.id ||
    exec?.sessionId ||
    "dsh-default"
  );
}

function resolveCwd(ctx, exec) {
  const session = exec?.agent?.session;
  try {
    const wd = typeof ctx.get === "function" ? ctx.get("workingDirectory") : ctx.workingDirectory;
    if (wd && session && typeof wd.get === "function") {
      const dir = wd.get(session);
      if (typeof dir === "string" && dir.trim()) return dir;
    }
  } catch {}
  const headerCwd = session?.header?.cwd || exec?.agent?.cwd || exec?.cwd;
  return typeof headerCwd === "string" && headerCwd.trim() ? headerCwd : process.cwd();
}

function extractResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result.error?.message === "string") return result.error.message;
  return "";
}

export function apply(ctx, config = {}) {
  const pendingCommandRewrites = new WeakMap();

  if (config?.injectRoutingPrompt !== false && typeof ctx.inject === "function") {
    ctx.inject(["systemPrompt"], (inner) => {
      if (typeof inner?.systemPrompt?.section !== "function") return;
      inner.systemPrompt.section({
        name: "agy-dart:routing",
        order: 950,
        interpolate: false,
        text: DSH_ROUTING_PROMPT
      });
    });
  }

  ctx.on("tools/pre-execute", async (exec, next) => {
    const toolName = String(exec?.name || "");
    if (!PRE_GUARD_TOOLS.has(toolName.toLowerCase())) {
      return next();
    }
    try {
      const { verdict } = await evaluatePreToolPayload({
        hook_event_name: "PreToolUse",
        session_id: resolveSessionId(exec),
        cwd: resolveCwd(ctx, exec),
        tool_name: toolName,
        tool_input: exec.arguments || {}
      });
      if (verdict?.decision === "deny") {
        return {
          kind: "deny",
          reason: verdict.reason || "[agy-dart] tool call denied"
        };
      }
      if (verdict?.overwrite && typeof verdict.overwrite.command === "string") {
        pendingCommandRewrites.set(exec, verdict.overwrite.command);
      }
    } catch {
      // Fail-open: never block DSH tools on internal guard error
    }
    return next();
  });

  ctx.on("tools/execute", async (exec, next) => {
    const rewrittenCommand = pendingCommandRewrites.get(exec);
    if (rewrittenCommand === undefined) {
      return next();
    }
    pendingCommandRewrites.delete(exec);
    const originalArgs = exec.arguments;
    try {
      exec.arguments = Object.freeze({ ...originalArgs, command: rewrittenCommand });
      return await next();
    } finally {
      exec.arguments = originalArgs;
    }
  });

  ctx.on("tools/result", (exec, result) => {
    const toolName = String(exec?.name || "");
    const isFailedRead =
      toolName.toLowerCase() === "read" &&
      Boolean(result?.isError || result?.cancelled || result?.aborted);
    if (!POST_TRACK_RE.test(toolName) && !isFailedRead) return;
    Promise.resolve()
      .then(() =>
        processPostToolPayload({
          hook_event_name: "PostToolUse",
          session_id: resolveSessionId(exec),
          cwd: resolveCwd(ctx, exec),
          tool_name: toolName,
          tool_input: exec.arguments || {},
          tool_output: extractResultText(result),
          is_error: Boolean(result?.isError),
          cancelled: Boolean(result?.cancelled || result?.aborted)
        })
      )
      .catch(() => {});
  });
}
