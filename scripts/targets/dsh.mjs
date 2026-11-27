import fs from "node:fs";
import path from "node:path";
import { insertConfig, read, serverCommands, skillSpecs } from "./shared.mjs";

export const detect = (home) => fs.existsSync(path.join(home, ".dsh"));

const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const EMPTY_ARRAY_RE = /^((?:[ \t]*(?:#[^\r\n]*)?\r?\n)*)([ \t]*\[\s*\][ \t]*)(\r?\n)?$/;
const COMMENT_OR_BLANK_ONLY_RE = /^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*[ \t]*(?:#[^\r\n]*)?$/;

function yamlStr(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

export function listRecordedProfiles(home) {
  const found = [];
  const seen = new Set();
  try {
    const raw = read(path.join(home, ".agy-dart", "dsh-install.json"));
    if (!raw) return found;
    const parsed = JSON.parse(raw);
    const files = parsed?.version === 2 ? parsed.files : parsed;
    if (!files || typeof files !== "object") return found;
    for (const filePath of Object.keys(files)) {
      const m = /[\\/]\.dsh[\\/]profiles[\\/]([^\\/]+)[\\/]cordis\.patch\.yml$/i.exec(filePath);
      if (m && PROFILE_NAME_RE.test(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        found.push(m[1]);
      }
    }
  } catch {}
  return found;
}

function readRecordedProfile(home) {
  const list = listRecordedProfiles(home);
  return list.length > 0 ? list[0] : null;
}

export function resolveProfileName(home, explicitProfile) {
  if (explicitProfile !== undefined && explicitProfile !== null && String(explicitProfile).trim() !== "") {
    const clean = String(explicitProfile).trim();
    if (!PROFILE_NAME_RE.test(clean)) {
      throw Error("Invalid DSH profile name: " + explicitProfile);
    }
    return clean;
  }
  const recorded = readRecordedProfile(home);
  if (recorded) return recorded;

  const profilesDir = path.join(home, ".dsh", "profiles");
  if (fs.existsSync(profilesDir)) {
    for (const preferred of ["desktop", "web"]) {
      const dir = path.join(profilesDir, preferred);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return preferred;
    }
    const candidates = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && PROFILE_NAME_RE.test(ent.name))
      .filter((ent) => {
        const dir = path.join(profilesDir, ent.name);
        return fs.existsSync(path.join(dir, "cordis.patch.yml")) || fs.existsSync(path.join(dir, "package.json"));
      })
      .map((ent) => ent.name)
      .sort();
    if (candidates.length === 1) return candidates[0];
  }
  return "desktop";
}

function assertYamlArrayOrEmpty(text) {
  if (COMMENT_OR_BLANK_ONLY_RE.test(text) || EMPTY_ARRAY_RE.test(text)) return;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith("-")) {
      throw Error("Invalid DSH cordis.patch.yml: expected a top-level YAML array");
    }
    return;
  }
}

export function specs(home, src, runtime, options = {}) {
  const start = "# >>> agy-dart >>>";
  const end = "# <<< agy-dart <<<";
  const hasExplicitProfile =
    options.profile !== undefined && options.profile !== null && String(options.profile).trim() !== "";
  const recordedProfiles = hasExplicitProfile ? [] : listRecordedProfiles(home);
  const profiles =
    !hasExplicitProfile &&
    (options.action === "uninstall" || options.action === "doctor" || options.action === "status") &&
    recordedProfiles.length > 0
      ? recordedProfiles
      : [resolveProfileName(home, options.profile)];
  const explicitMcpOnly = typeof options.mcpOnly === "boolean" ? options.mcpOnly : undefined;

  function block(executable = process.execPath, mcpOnly = Boolean(explicitMcpOnly)) {
    const servers = serverCommands(runtime, executable);
    const lines = [
      start,
      "- insert:",
      "    - id: mcp-agy-dart-fast",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: agy_dart_fast",
      "        transport: stdio",
      `        command: ${yamlStr(servers.fast.command)}`,
      `        args: [${servers.fast.args.map(yamlStr).join(", ")}]`,
      "        toolCallTimeoutMs: 180000",
      "    - id: mcp-agy-dart-context",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: agy_dart_context",
      "        transport: stdio",
      `        command: ${yamlStr(servers.context.command)}`,
      `        args: [${servers.context.args.map(yamlStr).join(", ")}]`,
      "        toolCallTimeoutMs: 310000"
    ];
    if (!mcpOnly) {
      lines.push(
        "    - id: agy-dart-native",
        `      name: ${yamlStr(path.join(runtime, "dsh", "plugin.mjs"))}`
      );
    }
    return [...lines, end, ""].join("\n");
  }

  function checkUnmanaged(text) {
    if (
      text.includes(start) ||
      text.includes(end) ||
      /^\s*-\s*id:\s*['"]?(?:mcp-agy-dart-(?:fast|context)|agy-dart-native)['"]?\s*$/m.test(text) ||
      /^\s*serverName:\s*['"]?agy_dart_(?:fast|context)['"]?\s*$/m.test(text)
    ) {
      throw Error("Conflicting agy-dart DSH patch block");
    }
  }

  function ownedRange(raw, executable = process.execPath, mcpOnly) {
    const offset = raw.indexOf(start);
    if (offset < 0) return null;
    const last = raw.indexOf(end, offset);
    if (last < 0 || (offset && raw[offset - 1] !== "\n")) {
      throw Error("Conflicting agy-dart DSH patch block");
    }
    let after = last + end.length;
    if (raw.startsWith("\r\n", after)) after += 2;
    else if (raw[after] === "\n") after++;
    else if (after !== raw.length) throw Error("Conflicting agy-dart DSH patch block");
    const sliceNorm = raw.slice(offset, after).replaceAll("\r\n", "\n").trimEnd();
    const candidates =
      typeof mcpOnly === "boolean"
        ? [block(executable, mcpOnly).trimEnd()]
        : [block(executable, false).trimEnd(), block(executable, true).trimEnd()];
    if (!candidates.includes(sliceNorm)) {
      throw Error("Conflicting agy-dart DSH patch block");
    }
    return { offset, after };
  }

  function remove(raw, undo = {}) {
    const range = ownedRange(raw, undo.executable, undo.mcpOnly);
    if (!range) {
      checkUnmanaged(raw);
      return raw;
    }
    const newline = raw.includes("\r\n") ? "\r\n" : "\n";
    const tail = raw.slice(range.after);
    let prefix = raw.slice(0, range.offset);
    if (undo.replacedEmptyArray) {
      const rest = prefix + tail;
      checkUnmanaged(rest);
      if (rest.length === 0 || COMMENT_OR_BLANK_ONLY_RE.test(rest)) {
        const replaced = undo.replaced ?? "[]";
        let restored = prefix + replaced;
        if (tail) {
          if (!restored.endsWith("\n") && !tail.startsWith("\r") && !tail.startsWith("\n")) {
            restored += newline;
          }
          restored += tail;
        } else if (undo.hadTrailingNewline && !restored.endsWith("\n")) {
          restored += newline;
        }
        checkUnmanaged(restored);
        return restored;
      }
      return rest;
    }
    if (undo.addedNewline && !tail) prefix = prefix.replace(/\r?\n$/, "");
    let rest = prefix + tail;
    checkUnmanaged(rest);
    if (rest.length > 0 && COMMENT_OR_BLANK_ONLY_RE.test(rest)) {
      const sep = rest.endsWith("\n") ? "" : newline;
      rest = `${rest}${sep}[]${newline}`;
    }
    return rest;
  }

  function buildProfileSpec(profile) {
    const patchFile = path.join(home, ".dsh", "profiles", profile, "cordis.patch.yml");
    return {
      file: patchFile,
      install(original) {
        const raw = original ?? "";
        checkUnmanaged(raw);
        assertYamlArrayOrEmpty(raw);
        const newline = raw.includes("\r\n") ? "\r\n" : "\n";
        const mcpOnly = Boolean(explicitMcpOnly);
        const rendered = block(process.execPath, mcpOnly).replaceAll("\n", newline);
        const emptyMatch = EMPTY_ARRAY_RE.exec(raw);
        if (emptyMatch) {
          const offset = emptyMatch[1].length;
          const replaced = emptyMatch[2] + (emptyMatch[3] ?? "");
          return insertConfig(
            raw,
            offset,
            rendered,
            {
              replacedEmptyArray: true,
              hadTrailingNewline: Boolean(emptyMatch[3]),
              executable: process.execPath,
              mcpOnly,
              profile
            },
            replaced
          );
        }
        const addedNewline = raw.length > 0 && !raw.endsWith("\n");
        return insertConfig(raw, raw.length, (addedNewline ? newline : "") + rendered, {
          addedNewline,
          executable: process.execPath,
          mcpOnly,
          profile
        });
      },
      verify(raw) {
        assertYamlArrayOrEmpty(raw);
        if (!ownedRange(raw, process.execPath, explicitMcpOnly)) return false;
        const afterRemove = remove(raw, { executable: process.execPath, mcpOnly: explicitMcpOnly });
        assertYamlArrayOrEmpty(afterRemove);
        return true;
      },
      remove
    };
  }

  return [...profiles.map(buildProfileSpec), ...skillSpecs(home, ".dsh", src)];
}
