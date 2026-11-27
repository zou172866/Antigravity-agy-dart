import path from "node:path";
import fs from "node:fs";
import { insertConfig, serverCommands, skillSpecs } from "./shared.mjs";

function parseTomlKeySegments(rawKey) {
  const segments = [];
  let i = 0;
  const len = rawKey.length;
  while (i < len) {
    while (i < len && (rawKey[i] === " " || rawKey[i] === "\t")) i++;
    if (i >= len) break;
    const ch = rawKey[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let seg = "";
      let closed = false;
      while (i < len) {
        const c = rawKey[i++];
        if (quote === '"' && c === "\\" && i < len) {
          seg += rawKey[i++];
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        seg += c;
      }
      if (!closed) return null;
      segments.push(seg);
    } else {
      const start = i;
      while (i < len && /[A-Za-z0-9_-]/.test(rawKey[i])) i++;
      if (i === start) return null;
      segments.push(rawKey.slice(start, i));
    }
    while (i < len && (rawKey[i] === " " || rawKey[i] === "\t")) i++;
    if (i < len) {
      if (rawKey[i] !== ".") return null;
      i++;
    }
  }
  return segments.length > 0 ? segments : null;
}

function scanTomlMcpServersConflicts(text) {
  let currentTable = [];
  let multilineQuote = null;
  let braceDepth = 0;
  let bracketDepth = 0;
  let hasClosedMcpServers = false;
  let closedReason = "";
  let hasUnmanagedAgyDart = false;

  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    let i = 0;
    const len = rawLine.length;

    const advanceValueState = (startIdx) => {
      let idx = startIdx;
      while (idx < len) {
        const ch = rawLine[idx];
        if (multilineQuote) {
          if (multilineQuote === '"""' && ch === "\\" && idx + 1 < len) {
            idx += 2;
            continue;
          }
          if (rawLine.startsWith(multilineQuote, idx)) {
            multilineQuote = null;
            idx += 3;
            continue;
          }
          idx++;
          continue;
        }
        if (ch === "#") break;
        if (rawLine.startsWith('"""', idx) || rawLine.startsWith("'''", idx)) {
          multilineQuote = rawLine.slice(idx, idx + 3);
          idx += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          const q = ch;
          idx++;
          while (idx < len) {
            const c = rawLine[idx++];
            if (q === '"' && c === "\\" && idx < len) {
              idx++;
              continue;
            }
            if (c === q) break;
          }
          continue;
        }
        if (ch === "{") braceDepth++;
        else if (ch === "}" && braceDepth > 0) braceDepth--;
        else if (ch === "[") bracketDepth++;
        else if (ch === "]" && bracketDepth > 0) bracketDepth--;
        idx++;
      }
    };

    if (multilineQuote || braceDepth > 0 || bracketDepth > 0) {
      advanceValueState(0);
      continue;
    }

    while (i < len && (rawLine[i] === " " || rawLine[i] === "\t")) i++;
    if (i >= len || rawLine[i] === "#") continue;

    if (rawLine[i] === "[") {
      const isArrayTable = rawLine[i + 1] === "[";
      let endIdx = -1;
      let inQuote = null;
      for (let j = i + (isArrayTable ? 2 : 1); j < len; j++) {
        const c = rawLine[j];
        if (inQuote) {
          if (inQuote === '"' && c === "\\" && j + 1 < len) {
            j++;
            continue;
          }
          if (c === inQuote) inQuote = null;
          continue;
        }
        if (c === '"' || c === "'") {
          inQuote = c;
          continue;
        }
        if (c === "#") break;
        if (c === "]") {
          if (isArrayTable) {
            if (rawLine[j + 1] === "]") {
              endIdx = j;
              break;
            }
          } else {
            endIdx = j;
            break;
          }
        }
      }
      if (endIdx < 0) continue;
      const headerInner = rawLine.slice(i + (isArrayTable ? 2 : 1), endIdx);
      const segs = parseTomlKeySegments(headerInner);
      if (!segs) continue;
      currentTable = segs;
      if (isArrayTable && segs.length === 1 && segs[0] === "mcp_servers") {
        hasClosedMcpServers = true;
        closedReason = "array of tables '[[mcp_servers]]'";
      }
      if (
        segs[0] === "mcp_servers" &&
        segs.length >= 2 &&
        (segs[1] === "agy_dart_fast" || segs[1] === "agy_dart_context")
      ) {
        hasUnmanagedAgyDart = true;
      }
      continue;
    }

    // Parse key = value statement outside multiline strings / inline containers
    let eqIdx = -1;
    let inQuote = null;
    for (let j = i; j < len; j++) {
      const c = rawLine[j];
      if (inQuote) {
        if (inQuote === '"' && c === "\\" && j + 1 < len) {
          j++;
          continue;
        }
        if (c === inQuote) inQuote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inQuote = c;
        continue;
      }
      if (c === "#") break;
      if (c === "=") {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) continue;

    const lhsSegs = parseTomlKeySegments(rawLine.slice(i, eqIdx));
    if (lhsSegs) {
      const fullPath = [...currentTable, ...lhsSegs];
      if (fullPath.length === 1 && fullPath[0] === "mcp_servers") {
        hasClosedMcpServers = true;
        const rhsTrimmed = rawLine.slice(eqIdx + 1).trim();
        closedReason = rhsTrimmed.startsWith("{")
          ? "closed inline table 'mcp_servers = { ... }'"
          : "top-level non-table assignment 'mcp_servers = ...'";
      } else if (
        fullPath[0] === "mcp_servers" &&
        fullPath.length >= 2 &&
        (fullPath[1] === "agy_dart_fast" || fullPath[1] === "agy_dart_context")
      ) {
        hasUnmanagedAgyDart = true;
      }
    }
    advanceValueState(eqIdx + 1);
  }

  return { hasClosedMcpServers, closedReason, hasUnmanagedAgyDart };
}

export const detect = home => fs.existsSync(path.join(home, ".codex"));

export function specs(home, src, runtime) {
  const start = "# >>> agy-dart >>>";
  const end = "# <<< agy-dart <<<";
  function block(executable = process.execPath) {
    const lines = [start];
    for (const [name, entry] of Object.entries(serverCommands(runtime, executable))) {
      lines.push("[mcp_servers.agy_dart_" + name + "]", "command = " + JSON.stringify(entry.command), "args = " + JSON.stringify(entry.args));
    }
    return [...lines, end, ""].join("\n");
  }
  function checkUnmanaged(text, { allowClosedMcpServers = false } = {}) {
    if (text.includes(start) || text.includes(end)) {
      throw Error("Conflicting agy-dart TOML block");
    }
    const scan = scanTomlMcpServersConflicts(text);
    if (scan.hasUnmanagedAgyDart) {
      throw Error("Conflicting agy-dart TOML block");
    }
    if (!allowClosedMcpServers && scan.hasClosedMcpServers) {
      throw Error(
        `Cannot install agy-dart into Codex config.toml: found ${scan.closedReason}. ` +
          `TOML forbids appending [mcp_servers.agy_dart_*] tables after an inline or non-table 'mcp_servers' definition. ` +
          `Original config.toml was left untouched — remove 'mcp_servers = {}' or rewrite entries as standard [mcp_servers.<name>] tables, then re-run.`
      );
    }
  }
  function ownedRange(raw, executable) {
    const offset = raw.indexOf(start);
    if (offset < 0) return null;
    const last = raw.indexOf(end, offset);
    if (last < 0 || (offset && raw[offset - 1] !== "\n")) throw Error("Conflicting agy-dart TOML block");
    let after = last + end.length;
    if (raw.startsWith("\r\n", after)) after += 2;
    else if (raw[after] === "\n") after++;
    else if (after !== raw.length) throw Error("Conflicting agy-dart TOML block");
    if (raw.slice(offset, after).replaceAll("\r\n", "\n").trimEnd() !== block(executable).trimEnd())
      throw Error("Conflicting agy-dart TOML block");
    return { offset, after };
  }
  function remove(raw, undo = {}) {
    const range = ownedRange(raw, undo.executable);
    if (!range) {
      checkUnmanaged(raw, { allowClosedMcpServers: true });
      return raw;
    }
    const tail = raw.slice(range.after);
    let prefix = raw.slice(0, range.offset);
    if (undo.addedNewline && !tail) prefix = prefix.replace(/\r?\n$/, "");
    const rest = prefix + tail;
    checkUnmanaged(rest, { allowClosedMcpServers: true });
    return rest;
  }
  return [{
    file: path.join(home, ".codex/config.toml"),
    install(original) {
      const raw = original ?? "";
      checkUnmanaged(raw);
      const addedNewline = raw.length > 0 && !raw.endsWith("\n");
      const newline = raw.includes("\r\n") ? "\r\n" : "\n";
      return insertConfig(raw, raw.length, (addedNewline ? newline : "") + block().replaceAll("\n", newline), { addedNewline, executable: process.execPath });
    },
    verify(raw) {
      if (!ownedRange(raw)) return false;
      const rest = remove(raw);
      const scan = scanTomlMcpServersConflicts(rest);
      if (scan.hasClosedMcpServers || scan.hasUnmanagedAgyDart) return false;
      return true;
    },
    legacyUndo(original, installed) {
      const command = /(?:^|\n)# >>> agy-dart >>>\r?\n\[mcp_servers\.agy_dart_fast\]\r?\ncommand = ([^\r\n]+)/.exec(installed);
      return { addedNewline: Boolean(original && !original.endsWith("\n")), executable: command && JSON.parse(command[1]) || process.execPath };
    },
    remove
  }, ...skillSpecs(home, ".codex", src)];
}
