import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function isEphemeralNpxSource(dir) {
  return /(?:^|[/\\])(?:_npx|npm-cache|node_modules|bunx|pnpm[/\\]dlx)(?:[/\\]|$)/i.test(dir);
}
export function guardPath(file) {
  const parent = path.dirname(file);
  if (parent !== file) guardPath(parent);
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error("Refusing linked path: " + file);
}
export function read(file) {
  guardPath(file);
  try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; return null; }
}
export function writeFileAtomicSync(file, data) {
  guardPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID();
  try {
    fs.writeFileSync(tmp, data, { flag: "wx", mode: fs.statSync(file, {throwIfNoEntry:false})?.mode ?? 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function syncSharedRuntime(srcRoot, homeDir, manifest, { preserveFiles = [] } = {}) {
  const dir = path.join(homeDir, ".agy-dart", "runtime");
  const marker = path.join(dir, ".installed-files.json");
  if (fs.existsSync(dir) && read(marker) === null && fs.readdirSync(dir).length) throw Error("Unmanaged runtime: " + dir);
  const normRel = (rel) => {
    const clean = String(rel || "").replace(/\\/g, "/");
    return process.platform === "win32" ? clean.toLowerCase() : clean;
  };
  const prior = JSON.parse(read(marker) ?? "[]");
  const files = manifest.map(rel => [rel, fs.readFileSync(path.join(srcRoot, rel))]);
  // Record union before modifying files so an interrupted sync remains cleanable.
  writeFileAtomicSync(marker, JSON.stringify([...new Set([...prior, ...manifest])]));
  for (const [rel, bytes] of files) writeFileAtomicSync(path.join(dir, rel), bytes);

  const manifestKeys = new Set(manifest.map(normRel));
  const preserveKeys = new Set(preserveFiles.map(normRel));
  const preservedPrior = [];
  const obsolete = [];
  for (const rel of prior) {
    if (typeof rel !== "string" || !rel) continue;
    const key = normRel(rel);
    if (manifestKeys.has(key)) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue;
    if (preserveKeys.has(key) && fs.existsSync(abs)) {
      preservedPrior.push(rel);
    } else {
      obsolete.push(rel);
    }
  }
  const parents = new Set();
  for (const rel of obsolete) {
    const abs = path.resolve(dir, rel);
    guardPath(abs);
    fs.rmSync(abs, { force: true });
    for (let p = path.dirname(abs); p !== dir; p = path.dirname(p)) parents.add(p);
  }
  for (const p of [...parents].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(p) && !fs.readdirSync(p).length) fs.rmdirSync(p);
  }
  writeFileAtomicSync(marker, JSON.stringify([...new Set([...manifest, ...preservedPrior])]));
  return dir;
}
export function serverCommands(runtime, executable = process.execPath) {
  return Object.fromEntries([["fast","fast/mcp-server.mjs"],["context","context/server.js"]].map(([name, file]) =>
    [name, { command: executable, args: [path.join(runtime, file)] }]));
}

export function insertConfig(text, offset, addition, details = {}, replaced = "") {
  return {
    text: text.slice(0, offset) + addition + text.slice(offset + replaced.length),
    undo: { offset, length: addition.length, ...details, ...(replaced && { replaced }) }
  };
}

const digest = text => text === null ? null : createHash("sha256").update(text).digest("hex");

function beforeInstall(spec, current, previous) {
  if (!previous) return current;
  if (Object.hasOwn(previous, "installed")) {
    // Pre-v2 installers saved complete configurations. Consume the old snapshot only in memory.
    if (current === previous.original || current === previous.installed) return previous.original;
    if (current === null) return null;
    const migrated = spec.install(previous.original);
    if (migrated.text === current) return previous.original;
    let undo = spec.legacyUndo?.(previous.original, previous.installed);
    // An interrupted migration may have already switched the live block to this executable.
    try { if (spec.verify(current)) undo = migrated.undo; } catch {}
    return spec.remove(current, undo);
  }
  const currentHash = digest(current);
  if (currentHash === previous.before || current === null) return current;
  if (currentHash === previous.after) {
    if (previous.before === null) return null;
    const { offset, length, replaced = "" } = previous.undo;
    const restored = current.slice(0, offset) + replaced + current.slice(offset + length);
    if (digest(restored) !== previous.before) throw Error("Invalid install record: " + spec.file);
    return restored;
  }
  return spec.remove(current, previous.undo);
}

const normPathKey = p => {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function findManagedSkillRoot(file, home) {
  const resolvedHome = path.resolve(home);
  const resolvedFile = path.resolve(file);
  const rel = path.relative(resolvedHome, resolvedFile);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 4 || parts[1] !== "skills" || parts[2] !== "agy-dart") return null;
  return path.join(resolvedHome, parts[0], "skills", "agy-dart");
}

export function manageFiles(home, host, specs, action) {
  const stateFile = path.join(home, ".agy-dart", host + "-install.json");
  const oldState = JSON.parse(read(stateFile) ?? "{}");
  const records = oldState.version === 2 ? oldState.files : oldState;
  const recordByKey = new Map();
  for (const [k, v] of Object.entries(records)) recordByKey.set(normPathKey(k), v);
  const specKeys = new Set(specs.map(s => normPathKey(s.file)));
  const preservedOtherConfigs = {};
  for (const [oldFile, rawOldRec] of Object.entries(records)) {
    if (specKeys.has(normPathKey(oldFile))) continue;
    if (findManagedSkillRoot(oldFile, home)) continue;
    preservedOtherConfigs[oldFile] = rawOldRec;
  }
  const hasOtherProfiles = Object.keys(preservedOtherConfigs).length > 0;
  const files = { ...preservedOtherConfigs };
  const pending = {};
  const changes = [];
  for (const spec of specs) {
    const file = spec.file;
    const isSharedSkill = Boolean(findManagedSkillRoot(file, home));
    let previous = records[file] ?? recordByKey.get(normPathKey(file));
    if (action === "uninstall" && isSharedSkill && hasOtherProfiles) {
      if (previous) files[file] = previous;
      continue;
    }
    const current = read(file);
    const currentHash = digest(current);
    if (previous?.transition?.from === currentHash) previous = previous.transition.record;
    if (action === "uninstall" && !previous) continue;
    let original = beforeInstall(spec, current, previous);
    if (action === "install" && !previous && current !== null) {
      const skillRoot = findManagedSkillRoot(file, home);
      if (skillRoot) {
        const skillEntry = path.join(skillRoot, "SKILL.md");
        const skillRec = normPathKey(skillEntry) !== normPathKey(file) ? recordByKey.get(normPathKey(skillEntry)) : null;
        const ownsSkillDir = Boolean(
          skillRec && (Object.hasOwn(skillRec, "installed") ? skillRec.original === null : skillRec.before === null)
        );
        if (ownsSkillDir && spec.verify(current)) original = null;
      }
    }
    let next = original;
    const legacy = previous && Object.hasOwn(previous, "installed");
    if (action === "install") {
      const edit = spec.install(original);
      next = edit.text;
      files[file] = { before: digest(original), after: digest(next), undo: edit.undo };
      if (previous && !legacy && currentHash !== files[file].before && currentHash !== files[file].after) {
        const {before, after, undo} = previous;
        pending[file] = { ...files[file], transition: { from: currentHash, record: {before, after, undo} } };
      }
    }
    if (next !== current) changes.push({ file, next, current, legacy });
  }
  for (const [oldFile, rawOldRec] of Object.entries(records)) {
    if (specKeys.has(normPathKey(oldFile))) continue;
    const skillRoot = findManagedSkillRoot(oldFile, home);
    if (!skillRoot) continue;
    if (action === "uninstall" && hasOtherProfiles) {
      files[oldFile] = rawOldRec;
      continue;
    }
    const current = read(oldFile);
    if (current === null) continue;
    let oldRec = rawOldRec;
    const currentHash = digest(current);
    if (oldRec?.transition?.from === currentHash) oldRec = oldRec.transition.record;
    const isLegacy = Object.hasOwn(oldRec, "installed");
    const createdByUs = isLegacy ? oldRec.original === null : oldRec.before === null;
    if (!createdByUs) continue;
    const expectedHash = isLegacy ? digest(oldRec.installed) : oldRec.after;
    if (currentHash !== expectedHash) {
      const relLabel = path.relative(path.resolve(home), path.resolve(oldFile)).replaceAll("\\", "/");
      throw Error("Locally modified skill: " + relLabel);
    }
    changes.push({ file: oldFile, next: null, current, legacy: false });
    if (action === "install") {
      pending[oldFile] = { before: null, after: expectedHash, undo: oldRec.undo ?? { offset: 0, length: current.length } };
    }
  }
  function apply({file, next, current}) {
    if (read(file) !== current) throw Error("Configuration changed during installation: " + file);
    if (next === null) {
      fs.unlinkSync(file);
      const skillRoot = findManagedSkillRoot(file, home);
      if (skillRoot) {
        const rootKey = normPathKey(skillRoot);
        for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
          if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
          fs.rmdirSync(dir);
          if (normPathKey(dir) === rootKey || path.dirname(dir) === dir) break;
        }
      }
    } else writeFileAtomicSync(file, next);
  }
  if (action === "install") {
    // Keep legacy originals on disk until their live files contain the original formatting.
    for (const change of changes) if (change.legacy) apply(change);
    writeFileAtomicSync(stateFile, JSON.stringify({ version: 2, files: { ...files, ...pending } }));
    for (const change of changes) if (!change.legacy) apply(change);
    if (Object.keys(pending).length) writeFileAtomicSync(stateFile, JSON.stringify({ version: 2, files }));
  } else {
    for (const change of changes) apply(change);
    if (hasOtherProfiles) {
      writeFileAtomicSync(stateFile, JSON.stringify({ version: 2, files }));
    } else if (read(stateFile) !== null) {
      fs.unlinkSync(stateFile);
    }
  }
}
function skillFileSpec(home, dir, src, relPosix) {
  const parts = relPosix.split("/");
  const body = fs.readFileSync(path.join(src, "skills", "agy-dart", ...parts), "utf8");
  const label = relPosix === "SKILL.md" ? dir : `${dir} (${relPosix})`;
  return {
    file: path.join(home, dir, "skills", "agy-dart", ...parts),
    install(current) {
      if (current !== null) throw Error("Skill already exists: " + label);
      return insertConfig("", 0, body);
    },
    verify(current) { return current === body; },
    remove() { throw Error("Locally modified skill: " + label); }
  };
}
export function skillSpec(home, dir, src) {
  return skillFileSpec(home, dir, src, "SKILL.md");
}
const IGNORED_SKILL_AUX_DIRS = new Set(["__pycache__", "node_modules"]);
const IGNORED_SKILL_AUX_FILE_RE = /\.py[co]$/i;

export function skillSpecs(home, dir, src) {
  const skillRoot = path.join(src, "skills", "agy-dart");
  const relFiles = ["SKILL.md"];
  const walk = (subRel, depth = 1) => {
    if (depth > 6) return;
    const absDir = path.join(skillRoot, ...subRel.split("/"));
    if (!fs.existsSync(absDir)) return;
    const st = fs.lstatSync(absDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const lowerName = ent.name.toLowerCase();
      if (ent.name.startsWith(".") || IGNORED_SKILL_AUX_DIRS.has(lowerName)) continue;
      const nextRel = `${subRel}/${ent.name}`;
      const absEntry = path.join(absDir, ent.name);
      const est = fs.lstatSync(absEntry);
      if (est.isSymbolicLink()) continue;
      if (est.isDirectory()) walk(nextRel, depth + 1);
      else if (est.isFile()) {
        if (IGNORED_SKILL_AUX_FILE_RE.test(ent.name)) continue;
        relFiles.push(nextRel);
      }
    }
  };
  for (const auxDir of ["references", "examples", "scripts", "resources"]) walk(auxDir, 1);
  return relFiles.map((rel) => skillFileSpec(home, dir, src, rel));
}
export function cleanupRuntime(home) {
  const base = path.join(home,".agy-dart");
  if (["claude","codex","dsh"].some(host => read(path.join(base,host+"-install.json")) !== null)) return;
  const dir = path.join(base,"runtime"), marker = path.join(dir,".installed-files.json");
  const list = read(marker);
  if (!list) return;
  const parents = new Set();
  for (const rel of JSON.parse(list)) {
    const file = path.resolve(dir,rel);
    if (!file.startsWith(dir+path.sep)) throw Error("Invalid runtime entry");
    guardPath(file);
    fs.rmSync(file,{force:true});
    for(let p=path.dirname(file); p!==dir; p=path.dirname(p)) parents.add(p);
  }
  fs.unlinkSync(marker);
  for(const p of [...parents].sort((a,b)=>b.length-a.length).concat(dir)) {
    if(fs.existsSync(p) && !fs.readdirSync(p).length) fs.rmdirSync(p);
  }
}
