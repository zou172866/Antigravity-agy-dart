import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".idea",
  ".vscode",
  "tmp",
  "temp",
  "output",
  "outputs",
  "logs"
]);

const PRIORITY_SOURCE_ROOTS = [
  "src",
  "lib",
  "packages",
  "app",
  "cmd",
  "internal",
  "core",
  "context",
  "hooks",
  "fast"
];

const PRIORITY_ROOT_RANK = new Map(PRIORITY_SOURCE_ROOTS.map((name, idx) => [name, idx]));

const LOW_PRIORITY_DIRS = new Set([
  "docs",
  "doc",
  "examples",
  "example",
  "samples",
  "sample",
  "fixtures",
  "benchmarks",
  "benchmark",
  "testdata",
  "demo",
  "demos",
  "tests",
  "test",
  "__tests__",
  "e2e",
  "scripts"
]);

const SOURCE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".mts", ".cts", ".tsx",
  ".vue", ".svelte",
  ".py", ".go", ".rs",
  ".dart", ".java"
]);

const JS_LIKE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".mts", ".cts", ".tsx",
  ".vue", ".svelte"
]);

const JS_EXT_CANDIDATES = [
  "", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts",
  ".vue", ".svelte",
  "/index.js", "/index.ts", "/index.tsx", "/index.jsx", "/index.mjs", "/index.cjs"
];

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isWithinWorkspace(targetPath, workspaceDir) {
  const rel = path.relative(workspaceDir, targetPath);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

function toWorkspaceRel(targetPath, workspaceDir) {
  const rel = path.relative(workspaceDir, targetPath).replace(/\\/g, "/");
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

/** Fast git HEAD SHA lookup (returns null if not a git repo or unborn) */
export function getGitHeadSha(workspaceDir, timeoutMs = 400) {
  try {
    const res = spawnSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true
    });
    if (!res.error && res.status === 0 && res.stdout) {
      const sha = res.stdout.trim();
      if (/^[0-9a-f]{7,64}$/i.test(sha)) return sha;
    }
  } catch {
    // Non-git workspace
  }
  return null;
}

/**
 * Deterministic priority-tiered BFS source file collector.
 * Scans priority source roots (src, lib, packages, app, cmd, internal, core, context, hooks, fast)
 * level-by-level before general sibling directories and low-priority folders (docs, examples, etc.),
 * preventing monorepos from exhausting maxFiles before reaching core source modules.
 */
export function collectSourceFiles(workspaceDir, maxFiles = 120, maxDepth = 8) {
  const files = [];
  if (!workspaceDir || maxFiles <= 0 || maxDepth < 0) return files;
  const rootDir = path.resolve(workspaceDir);
  const maxDirs = Math.max(400, maxFiles * 4);
  let dirsVisited = 0;

  const qPriority = [];
  const qNormal = [];
  const qLow = [];

  const compareSubdirs = (a, b) => {
    const ra = PRIORITY_ROOT_RANK.get(a.name.toLowerCase());
    const rb = PRIORITY_ROOT_RANK.get(b.name.toLowerCase());
    if (ra !== undefined && rb !== undefined) return ra - rb || compareAscii(a.name, b.name);
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return compareAscii(a.name, b.name);
  };

  function readSortedEntries(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name));
    } catch {
      return [];
    }
  }

  // Depth 0 (workspace root): collect root source files, then bucket depth-1 subdirectories
  dirsVisited++;
  const rootEntries = readSortedEntries(rootDir);
  const rootPriorityDirs = [];
  const rootNormalDirs = [];
  const rootLowDirs = [];

  for (const entry of rootEntries) {
    if (files.length >= maxFiles) return files;
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTS.has(ext)) {
        files.push(path.join(rootDir, entry.name));
      }
    } else if (entry.isDirectory() && maxDepth >= 1) {
      if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
      const lower = entry.name.toLowerCase();
      const item = { name: entry.name, dir: path.join(rootDir, entry.name), depth: 1 };
      if (PRIORITY_ROOT_RANK.has(lower)) {
        rootPriorityDirs.push(item);
      } else if (LOW_PRIORITY_DIRS.has(lower)) {
        rootLowDirs.push(item);
      } else {
        rootNormalDirs.push(item);
      }
    }
  }

  rootPriorityDirs.sort(compareSubdirs);
  rootNormalDirs.sort((a, b) => compareAscii(a.name, b.name));
  rootLowDirs.sort((a, b) => compareAscii(a.name, b.name));
  qPriority.push(...rootPriorityDirs);
  qNormal.push(...rootNormalDirs);
  qLow.push(...rootLowDirs);

  function drainBfs(queue, targetQueue) {
    let head = 0;
    while (head < queue.length && files.length < maxFiles && dirsVisited < maxDirs) {
      const { dir, depth } = queue[head++];
      if (depth > maxDepth) continue;
      dirsVisited++;
      const entries = readSortedEntries(dir);
      const nextSameTier = [];
      const nextLowTier = [];

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) {
            files.push(path.join(dir, entry.name));
          }
        } else if (entry.isDirectory() && depth < maxDepth) {
          if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
          const lower = entry.name.toLowerCase();
          const child = { name: entry.name, dir: path.join(dir, entry.name), depth: depth + 1 };
          if (targetQueue !== qLow && LOW_PRIORITY_DIRS.has(lower)) {
            nextLowTier.push(child);
          } else {
            nextSameTier.push(child);
          }
        }
      }

      if (nextSameTier.length > 0) {
        nextSameTier.sort(compareSubdirs);
        targetQueue.push(...nextSameTier);
      }
      if (nextLowTier.length > 0) {
        nextLowTier.sort((a, b) => compareAscii(a.name, b.name));
        qLow.push(...nextLowTier);
      }
    }
  }

  drainBfs(qPriority, qPriority);
  drainBfs(qNormal, qNormal);
  drainBfs(qLow, qLow);
  return files;
}

/**
 * Strip // and /* *\/ comments while preserving string literals verbatim.
 * Safe for JSONC (preserves `"@/*"`), Go (including backtick raw strings), Java, and Dart.
 */
function stripCLikeComments(content, { allowSingleQuotes = true, allowBackticks = false, backtickEscapes = false } = {}) {
  let out = "";
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    const next = i + 1 < len ? content[i + 1] : "";

    // Double-quoted string
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = content[i];
        out += c;
        i++;
        if (c === "\\" && i < len) {
          out += content[i];
          i++;
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }

    // Single-quoted string/char literal
    if (allowSingleQuotes && ch === "'") {
      out += ch;
      i++;
      while (i < len) {
        const c = content[i];
        out += c;
        i++;
        if (c === "\\" && i < len) {
          out += content[i];
          i++;
        } else if (c === "'") {
          break;
        }
      }
      continue;
    }

    // Backtick literal (JS template literals escape '\', Go raw strings do not)
    if (allowBackticks && ch === "`") {
      out += ch;
      i++;
      while (i < len) {
        const c = content[i];
        out += c;
        i++;
        if (backtickEscapes && c === "\\" && i < len) {
          out += content[i];
          i++;
        } else if (c === "`") {
          break;
        }
      }
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && content[i] !== "\n" && content[i] !== "\r") i++;
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      i += 2;
      out += " ";
      while (i < len) {
        if (content[i] === "*" && i + 1 < len && content[i + 1] === "/") {
          i += 2;
          break;
        }
        if (content[i] === "\n") out += "\n";
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function stripTrailingJsonCommas(text) {
  let out = "";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = text[i];
        out += c;
        i++;
        if (c === "\\" && i < len) {
          out += text[i];
          i++;
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < len && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) {
        j++;
      }
      if (j < len && (text[j] === "}" || text[j] === "]")) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function parseJsonc(rawText) {
  try {
    const text = String(rawText ?? "").replace(/^\uFEFF/, "");
    const noComments = stripCLikeComments(text, { allowSingleQuotes: false, allowBackticks: false });
    const cleaned = stripTrailingJsonCommas(noComments);
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function stripJsComments(content) {
  // String-aware comment stripping so '/*' or '//' inside string/template literals never eats subsequent imports
  return stripCLikeComments(content, {
    allowSingleQuotes: true,
    allowBackticks: true,
    backtickEscapes: true
  });
}

function extractSfcScripts(content) {
  const blocks = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(content)) !== null) {
    blocks.push(m[1]);
  }
  return blocks.join("\n");
}

function extractJsTsImports(content) {
  const targets = [];
  const cleaned = stripJsComments(content);
  // Statement-anchored, bounded clauses (no cross-statement backtracking or comment/string false matches)
  const esmFromRe = /(?:^|[\r\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^;'"`\r\n{}]*|\{[^;'"`]{0,1200}\}|[^;'"`\r\n]*,\s*\{[^;'"`]{0,1200}\})\s+from\s*["']([^"'\r\n]+)["']/g;
  const sideEffectImportRe = /(?:^|[\r\n;])\s*import\s+["']([^"'\r\n]+)["']/g;
  const callImportRe = /\b(?:require|import)\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g;
  for (const re of [esmFromRe, sideEffectImportRe, callImportRe]) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      targets.push(m[1]);
    }
  }
  return targets;
}

function extractGoImports(content) {
  const targets = [];
  const cleanedFull = stripCLikeComments(content, { allowSingleQuotes: true, allowBackticks: true });
  // Go grammar mandates all import declarations precede top-level func/type/var/const declarations;
  // slicing here prevents raw backtick templates inside code from triggering false import matches.
  const declIdx = cleanedFull.search(/^(?:func|type|var|const)\b/m);
  const cleaned = declIdx !== -1 ? cleanedFull.slice(0, declIdx) : cleanedFull;
  const singleRe = /(?:^|[\r\n;])\s*import\s+(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?(?:"([^"\r\n]+)"|`([^`\r\n]+)`)/g;
  let m;
  while ((m = singleRe.exec(cleaned)) !== null) {
    const spec = m[1] || m[2];
    if (spec) targets.push(spec);
  }
  const blockRe = /(?:^|[\r\n;])\s*import\s*\(([\s\S]*?)\)/g;
  const entryRe = /(?:^|[\r\n;])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?(?:"([^"\r\n]+)"|`([^`\r\n]+)`)/g;
  while ((m = blockRe.exec(cleaned)) !== null) {
    const body = m[1];
    entryRe.lastIndex = 0;
    let item;
    while ((item = entryRe.exec(body)) !== null) {
      const spec = item[1] || item[2];
      if (spec) targets.push(spec);
    }
  }
  return targets;
}

function extractDartImports(content) {
  const targets = [];
  const cleaned = stripCLikeComments(content, { allowSingleQuotes: true, allowBackticks: false });
  const dartRe = /(?:^|[\r\n;])\s*(?:import|export|part)\s+["']([^"'\r\n]+)["']/g;
  let m;
  while ((m = dartRe.exec(cleaned)) !== null) {
    targets.push(m[1]);
  }
  return targets;
}

function extractJavaImports(content) {
  const targets = [];
  const cleanedFull = stripCLikeComments(content, { allowSingleQuotes: true, allowBackticks: false });
  // Java grammar mandates all import declarations precede the first top-level type declaration
  const typeIdx = cleanedFull.search(
    /^\s*(?:(?:public|protected|private|abstract|final|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\b/m
  );
  const cleaned = typeIdx !== -1 ? cleanedFull.slice(0, typeIdx) : cleanedFull;
  const javaRe = /(?:^|[\r\n;])\s*import\s+(static\s+)?([A-Za-z_][A-Za-z0-9_.]*(?:\.\*)?)\s*;/g;
  let m;
  while ((m = javaRe.exec(cleaned)) !== null) {
    targets.push(m[1] ? `static:${m[2]}` : m[2]);
  }
  return targets;
}

function extractImports(content, ext) {
  const targets = [];
  if (ext === ".py") {
    const pyRe = /^\s*from\s+(\.[A-Za-z0-9_.]*)\s+import\s+(\([\s\S]{0,1200}?\)|[^\r\n#]+)/gm;
    let m;
    while ((m = pyRe.exec(content)) !== null) {
      const mod = m[1];
      if (/^\.+$/.test(mod)) {
        const namesRaw = m[2].replace(/[()]/g, "");
        const names = namesRaw
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/i)[0].trim())
          .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
        if (names.length > 0) {
          for (const n of names) targets.push(`${mod}${n}`);
        } else {
          targets.push(mod);
        }
      } else {
        targets.push(mod);
      }
    }
    return targets;
  }
  if (ext === ".rs") {
    const rsRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z0-9_]+)\s*;/gm;
    let m;
    while ((m = rsRe.exec(content)) !== null) {
      targets.push(`./${m[1]}.rs`);
      targets.push(`./${m[1]}/mod.rs`);
    }
    return targets;
  }
  if (ext === ".go") {
    return extractGoImports(content);
  }
  if (ext === ".dart") {
    return extractDartImports(content);
  }
  if (ext === ".java") {
    return extractJavaImports(content);
  }
  if (ext === ".vue" || ext === ".svelte") {
    const scriptBody = extractSfcScripts(content);
    return scriptBody ? extractJsTsImports(scriptBody) : [];
  }
  return extractJsTsImports(content);
}

/** Parse module path from a go.mod file */
function parseGoModFile(goModPath) {
  try {
    const raw = fs.readFileSync(goModPath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const noComment = line.replace(/\/\/.*$/, "").trim();
      const m = /^module\s+(?:"([^"]+)"|`([^`]+)`|(\S+))/.exec(noComment);
      if (m) {
        const modPath = (m[1] || m[2] || m[3] || "").replace(/\/+$/, "");
        if (modPath) return modPath;
      }
    }
  } catch {
    // Unreadable go.mod
  }
  return null;
}

function findNearestGoMod(startDir, workspaceDir, cache) {
  const visited = [];
  let cur = path.resolve(startDir);
  const root = path.resolve(workspaceDir);
  let found = null;

  while (isWithinWorkspace(cur, root)) {
    if (cache.has(cur)) {
      found = cache.get(cur);
      break;
    }
    visited.push(cur);
    const candidate = path.join(cur, "go.mod");
    if (fs.existsSync(candidate)) {
      const modulePath = parseGoModFile(candidate);
      if (modulePath) {
        found = { modDir: cur, modulePath };
        break;
      }
    }
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const dir of visited) {
    cache.set(dir, found);
  }
  return found;
}

function pickGoPackageHub(relDir, goPkgFilesByDir) {
  const pkgFiles = goPkgFilesByDir.get(relDir);
  if (!pkgFiles || pkgFiles.length === 0) return null;
  const nonTests = pkgFiles.filter((p) => !p.endsWith("_test.go"));
  const pool = nonTests.length > 0 ? nonTests : pkgFiles;
  const dirBase = relDir ? path.posix.basename(relDir) : "";
  if (dirBase) {
    const lowerTarget = `${dirBase.toLowerCase()}.go`;
    const matching = pool.find((p) => path.posix.basename(p).toLowerCase() === lowerTarget);
    if (matching) return matching;
  }
  const mainFile = pool.find((p) => path.posix.basename(p).toLowerCase() === "main.go");
  if (mainFile) return mainFile;
  return pool[0];
}

/** Parse tsconfig.json / jsconfig.json compilerOptions.paths (following local extends up to 4 hops) */
function readTsConfigPathRules(configPath, visited = new Set(), depth = 0) {
  const resolved = path.resolve(configPath);
  if (depth > 4 || visited.has(resolved)) return new Map();
  visited.add(resolved);

  let parsed = null;
  try {
    parsed = parseJsonc(fs.readFileSync(resolved, "utf8"));
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object") return new Map();

  const configDir = path.dirname(resolved);
  const rulesByPattern = new Map();

  const extendsList =
    typeof parsed.extends === "string"
      ? [parsed.extends]
      : Array.isArray(parsed.extends)
        ? parsed.extends.filter((e) => typeof e === "string")
        : [];
  for (const rawExt of extendsList) {
    const extSpec = rawExt.trim();
    if (!extSpec.startsWith(".")) continue;
    const candidates = [path.resolve(configDir, extSpec), path.resolve(configDir, `${extSpec}.json`)];
    for (const parentPath of candidates) {
      if (fs.existsSync(parentPath) && fs.statSync(parentPath).isFile()) {
        const parentRules = readTsConfigPathRules(parentPath, visited, depth + 1);
        for (const [k, v] of parentRules.entries()) {
          rulesByPattern.set(k, v);
        }
        break;
      }
    }
  }

  const co = parsed.compilerOptions;
  if (co && typeof co === "object" && co.paths && typeof co.paths === "object") {
    const baseDir =
      typeof co.baseUrl === "string" && co.baseUrl.trim()
        ? path.resolve(configDir, co.baseUrl.trim())
        : configDir;
    for (const [pattern, rawTargets] of Object.entries(co.paths)) {
      if (!pattern || !Array.isArray(rawTargets)) continue;
      const targets = rawTargets
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim());
      if (targets.length === 0) continue;
      const starIdx = pattern.indexOf("*");
      const hasWildcard = starIdx !== -1;
      if (hasWildcard && pattern.indexOf("*", starIdx + 1) !== -1) continue;
      const prefix = hasWildcard ? pattern.slice(0, starIdx) : pattern;
      const suffix = hasWildcard ? pattern.slice(starIdx + 1) : "";
      rulesByPattern.set(pattern, {
        pattern,
        prefix,
        suffix,
        hasWildcard,
        targets,
        baseDir
      });
    }
  }

  return rulesByPattern;
}

function findNearestTsConfigRules(startDir, workspaceDir, cache) {
  const visited = [];
  let cur = path.resolve(startDir);
  const root = path.resolve(workspaceDir);
  let rules = [];

  while (isWithinWorkspace(cur, root)) {
    if (cache.has(cur)) {
      rules = cache.get(cur);
      break;
    }
    visited.push(cur);
    let matchedRules = null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(cur, name);
      if (!fs.existsSync(candidate)) continue;
      const ruleMap = readTsConfigPathRules(candidate);
      if (ruleMap.size > 0) {
        matchedRules = Array.from(ruleMap.values()).sort((a, b) => {
          if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
          const lenDiff = b.prefix.length + b.suffix.length - (a.prefix.length + a.suffix.length);
          return lenDiff !== 0 ? lenDiff : compareAscii(a.pattern, b.pattern);
        });
        break;
      }
    }
    if (matchedRules) {
      rules = matchedRules;
      break;
    }
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const dir of visited) {
    cache.set(dir, rules);
  }
  return rules;
}

function findNearestDartPubspec(startDir, workspaceDir, cache) {
  const visited = [];
  let cur = path.resolve(startDir);
  const root = path.resolve(workspaceDir);
  let found = null;

  while (isWithinWorkspace(cur, root)) {
    if (cache.has(cur)) {
      found = cache.get(cur);
      break;
    }
    visited.push(cur);
    const candidate = path.join(cur, "pubspec.yaml");
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const m = /^name\s*:\s*["']?([A-Za-z0-9_]+)["']?/m.exec(raw);
        if (m && m[1]) {
          found = { pkgDir: cur, pkgName: m[1] };
          break;
        }
      } catch {
        // Ignore unreadable pubspec.yaml
      }
    }
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const dir of visited) {
    cache.set(dir, found);
  }
  return found;
}

function buildJavaIndex(absFiles, relFiles, maxFileBytes) {
  const byFqn = new Map();
  const byPkg = new Map();
  const contentCache = new Map();

  for (let i = 0; i < absFiles.length; i++) {
    const rel = relFiles[i];
    if (!rel.toLowerCase().endsWith(".java")) continue;
    const abs = absFiles[i];
    const className = path.posix.basename(rel, path.posix.extname(rel));
    let pkg = null;

    try {
      const st = fs.statSync(abs);
      if (st.size <= maxFileBytes) {
        const content = fs.readFileSync(abs, "utf8");
        contentCache.set(rel, content);
        const cleaned = stripCLikeComments(content, { allowSingleQuotes: true, allowBackticks: false });
        const pkgMatch = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(cleaned);
        if (pkgMatch) pkg = pkgMatch[1];
      }
    } catch {
      // Skip unreadable file
    }

    if (pkg) {
      const fqn = `${pkg}.${className}`;
      if (!byFqn.has(fqn)) byFqn.set(fqn, rel);
      if (!byPkg.has(pkg)) byPkg.set(pkg, []);
      byPkg.get(pkg).push(rel);
    }

    // Fallback path-inferred FQN (handles standard src/main/java, src/, java/ layouts)
    const rootMatch = /(?:^|\/)(?:src\/(?:main|test)\/java|src\/java|src|java)\/(.+)\.java$/i.exec(rel);
    const inferredPath = rootMatch ? rootMatch[1] : rel.replace(/\.java$/i, "");
    const inferredFqn = inferredPath.replace(/\//g, ".");
    if (inferredFqn && !byFqn.has(inferredFqn)) {
      byFqn.set(inferredFqn, rel);
    }
    const lastDot = inferredFqn.lastIndexOf(".");
    if (!pkg && lastDot > 0) {
      const inferredPkg = inferredFqn.slice(0, lastDot);
      if (!byPkg.has(inferredPkg)) byPkg.set(inferredPkg, []);
      byPkg.get(inferredPkg).push(rel);
    }
  }

  for (const list of byPkg.values()) {
    list.sort(compareAscii);
  }

  return { byFqn, byPkg, contentCache };
}

function resolveJsCandidates(rawResolved, spec, workspaceDir, fileSet) {
  for (const suffix of JS_EXT_CANDIDATES) {
    const cand = rawResolved + suffix;
    const rel = toWorkspaceRel(cand, workspaceDir);
    if (rel && fileSet.has(rel)) return rel;
  }
  // TypeScript ESM imports referencing .js/.mjs/.cjs for .ts/.tsx/.mts/.cts source files
  if (spec.endsWith(".js") || spec.endsWith(".mjs") || spec.endsWith(".cjs")) {
    const stem = rawResolved.replace(/\.(?:m|c)?js$/, "");
    for (const tsExt of [".ts", ".tsx", ".mts", ".cts"]) {
      const rel = toWorkspaceRel(stem + tsExt, workspaceDir);
      if (rel && fileSet.has(rel)) return rel;
    }
  }
  return null;
}

function resolveTsAlias(spec, rules, workspaceDir, fileSet) {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    if (!rule.hasWildcard) {
      if (spec !== rule.prefix) continue;
      for (const target of rule.targets) {
        const hit = resolveJsCandidates(path.resolve(rule.baseDir, target), target, workspaceDir, fileSet);
        if (hit) return hit;
      }
      continue;
    }
    if (spec.length < rule.prefix.length + rule.suffix.length) continue;
    if (!spec.startsWith(rule.prefix) || !spec.endsWith(rule.suffix)) continue;
    const wildcardMatch = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
    for (const target of rule.targets) {
      const expanded = target.includes("*") ? target.replace("*", () => wildcardMatch) : target;
      const hit = resolveJsCandidates(path.resolve(rule.baseDir, expanded), expanded, workspaceDir, fileSet);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveImportTarget(fromFile, selfRel, spec, workspaceDir, fileSet, ctx) {
  const fromDir = path.dirname(fromFile);
  const ext = path.extname(fromFile).toLowerCase();

  if (ext === ".py" && spec.startsWith(".")) {
    const dots = spec.match(/^\.+/)?.[0].length || 1;
    const rest = spec.slice(dots).replace(/\./g, "/");
    let base = fromDir;
    for (let i = 1; i < dots; i++) base = path.dirname(base);
    const candidates = rest
      ? [path.resolve(base, `${rest}.py`), path.resolve(base, rest, "__init__.py")]
      : [path.resolve(base, "__init__.py")];
    for (const c of candidates) {
      const rel = toWorkspaceRel(c, workspaceDir);
      if (rel && fileSet.has(rel)) return rel;
    }
    return null;
  }

  if (ext === ".go") {
    if (spec === "." || spec.startsWith("./") || spec.startsWith("../")) {
      const targetAbsDir = path.resolve(fromDir, spec);
      if (!isWithinWorkspace(targetAbsDir, workspaceDir)) return null;
      const relDirRaw = path.relative(workspaceDir, targetAbsDir).replace(/\\/g, "/");
      const relDir = relDirRaw === "." ? "" : relDirRaw;
      return pickGoPackageHub(relDir, ctx.goPkgFilesByDir);
    }
    const goMod = findNearestGoMod(fromDir, workspaceDir, ctx.goModCache);
    if (goMod && (spec === goMod.modulePath || spec.startsWith(`${goMod.modulePath}/`))) {
      const sub = spec === goMod.modulePath ? "" : spec.slice(goMod.modulePath.length + 1);
      const targetAbsDir = sub ? path.resolve(goMod.modDir, sub) : goMod.modDir;
      if (!isWithinWorkspace(targetAbsDir, workspaceDir)) return null;
      const relDirRaw = path.relative(workspaceDir, targetAbsDir).replace(/\\/g, "/");
      const relDir = relDirRaw === "." ? "" : relDirRaw;
      return pickGoPackageHub(relDir, ctx.goPkgFilesByDir);
    }
    return null;
  }

  if (ext === ".dart") {
    if (spec.startsWith("dart:")) return null;
    if (spec.startsWith("package:")) {
      const rest = spec.slice("package:".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx <= 0) return null;
      const pkgName = rest.slice(0, slashIdx);
      const relInLib = rest.slice(slashIdx + 1);
      const pubspec = findNearestDartPubspec(fromDir, workspaceDir, ctx.dartPubspecCache);
      if (!pubspec || pubspec.pkgName !== pkgName) return null;
      const candidates = [path.resolve(pubspec.pkgDir, "lib", relInLib)];
      if (!relInLib.endsWith(".dart")) candidates.push(path.resolve(pubspec.pkgDir, "lib", `${relInLib}.dart`));
      for (const c of candidates) {
        const rel = toWorkspaceRel(c, workspaceDir);
        if (rel && fileSet.has(rel)) return rel;
      }
      return null;
    }
    const candidates = [path.resolve(fromDir, spec)];
    if (!spec.endsWith(".dart")) candidates.push(path.resolve(fromDir, `${spec}.dart`));
    for (const c of candidates) {
      const rel = toWorkspaceRel(c, workspaceDir);
      if (rel && fileSet.has(rel)) return rel;
    }
    return null;
  }

  if (ext === ".java" && ctx.javaIndex) {
    const isStatic = spec.startsWith("static:");
    const raw = isStatic ? spec.slice("static:".length) : spec;
    if (isStatic) {
      const targetClass = raw.endsWith(".*")
        ? raw.slice(0, -2)
        : raw.includes(".")
          ? raw.slice(0, raw.lastIndexOf("."))
          : raw;
      return ctx.javaIndex.byFqn.get(targetClass) || null;
    }
    if (raw.endsWith(".*")) {
      const pkg = raw.slice(0, -2);
      const list = ctx.javaIndex.byPkg.get(pkg);
      if (!list || list.length === 0) return null;
      const candidates = list.filter((p) => p !== selfRel);
      if (candidates.length === 0) return null;
      const lastPkgSeg = pkg.split(".").pop()?.toLowerCase() || "";
      const namedMatch = candidates.find(
        (p) => path.posix.basename(p, ".java").toLowerCase() === lastPkgSeg
      );
      return namedMatch || candidates[0];
    }
    const direct = ctx.javaIndex.byFqn.get(raw);
    if (direct) return direct;
    // Nested/inner class import fallback (e.g. com.acme.Outer.Inner -> Outer.java)
    const lastDot = raw.lastIndexOf(".");
    if (lastDot > 0) {
      return ctx.javaIndex.byFqn.get(raw.slice(0, lastDot)) || null;
    }
    return null;
  }

  // Relative JS/TS/Vue/Svelte/Rust imports
  if (spec.startsWith(".")) {
    return resolveJsCandidates(path.resolve(fromDir, spec), spec, workspaceDir, fileSet);
  }

  // Non-relative JS/TS/Vue/Svelte imports via tsconfig.json / jsconfig.json compilerOptions.paths
  if (JS_LIKE_EXTS.has(ext)) {
    const tsRules = findNearestTsConfigRules(fromDir, workspaceDir, ctx.tsConfigCache);
    return resolveTsAlias(spec, tsRules, workspaceDir, fileSet);
  }

  return null;
}

/**
 * Scan workspace internal imports and compute deterministic hub files (most-imported modules).
 * Returns { summary: string, fileCount: number, hubs: Array<{ path, refs }> }.
 */
export function buildRepoHotspots(workspaceDir, options = {}) {
  const maxFiles = options.maxFiles ?? 120;
  const maxHubs = options.maxHubs ?? 5;
  const maxFileBytes = options.maxFileBytes ?? 131072;
  const rootDir = path.resolve(workspaceDir);

  const absFiles = collectSourceFiles(rootDir, maxFiles, options.maxDepth ?? 8);
  if (absFiles.length < 3) {
    return { summary: "", fileCount: absFiles.length, hubs: [] };
  }

  const relFiles = absFiles.map((f) => path.relative(rootDir, f).replace(/\\/g, "/"));
  const fileSet = new Set(relFiles);
  const inDegree = new Map();

  // Pre-index Go package directories (sorted deterministically)
  const goPkgFilesByDir = new Map();
  let hasJava = false;
  for (const rel of relFiles) {
    const lower = rel.toLowerCase();
    if (lower.endsWith(".go")) {
      const dirRaw = path.posix.dirname(rel);
      const dirKey = dirRaw === "." ? "" : dirRaw;
      if (!goPkgFilesByDir.has(dirKey)) goPkgFilesByDir.set(dirKey, []);
      goPkgFilesByDir.get(dirKey).push(rel);
    } else if (lower.endsWith(".java")) {
      hasJava = true;
    }
  }
  for (const list of goPkgFilesByDir.values()) {
    list.sort(compareAscii);
  }

  const javaIndex = hasJava ? buildJavaIndex(absFiles, relFiles, maxFileBytes) : null;
  const ctx = {
    goPkgFilesByDir,
    goModCache: new Map(),
    tsConfigCache: new Map(),
    dartPubspecCache: new Map(),
    javaIndex
  };

  for (let i = 0; i < absFiles.length; i++) {
    const abs = absFiles[i];
    const selfRel = relFiles[i];
    try {
      const ext = path.extname(abs).toLowerCase();
      let content;
      if (ext === ".java" && javaIndex?.contentCache.has(selfRel)) {
        content = javaIndex.contentCache.get(selfRel);
      } else {
        const st = fs.statSync(abs);
        if (st.size > maxFileBytes) continue;
        content = fs.readFileSync(abs, "utf8");
      }
      const specs = extractImports(content, ext);
      const seenForFile = new Set();
      for (const spec of specs) {
        const targetRel = resolveImportTarget(abs, selfRel, spec, rootDir, fileSet, ctx);
        if (targetRel && targetRel !== selfRel && !seenForFile.has(targetRel)) {
          seenForFile.add(targetRel);
          inDegree.set(targetRel, (inDegree.get(targetRel) || 0) + 1);
        }
      }
    } catch {
      // Skip unreadable file
    }
  }

  const hubs = Array.from(inDegree.entries())
    .map(([relPath, refs]) => ({ path: relPath, refs }))
    .sort((a, b) => (b.refs !== a.refs ? b.refs - a.refs : compareAscii(a.path, b.path)))
    .slice(0, maxHubs);

  if (hubs.length === 0) {
    return { summary: "", fileCount: absFiles.length, hubs: [] };
  }

  const hubStr = hubs.map((h) => `${h.path} (${h.refs})`).join(", ");
  return {
    summary: `Core hubs (${absFiles.length} src files): ${hubStr}`,
    fileCount: absFiles.length,
    hubs
  };
}

/**
 * Retrieve git-HEAD-cached repo hotspot summary from ContextModeStore (or compute and cache).
 * Deterministic per commit SHA so SessionStart prefix stays KV-cache aligned.
 */
export function getCachedRepoHotspots(workspaceDir, store = null, options = {}) {
  try {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return "";
    const normalizedRoot = path.resolve(workspaceDir);
    const headSha = options.headSha !== undefined ? options.headSha : getGitHeadSha(normalizedRoot);
    const cacheKeySha = headSha || "nogit";
    const maxAgeMs = headSha ? 7 * 24 * 3600 * 1000 : 6 * 3600 * 1000;

    if (store && typeof store.getRepoCache === "function") {
      const cached = store.getRepoCache(normalizedRoot, cacheKeySha, "hotspots", maxAgeMs);
      if (cached !== null) return cached;
    }

    const res = buildRepoHotspots(normalizedRoot, options);
    const summary = res.summary || "";

    if (store && typeof store.setRepoCache === "function") {
      store.setRepoCache(normalizedRoot, cacheKeySha, "hotspots", summary);
    }
    return summary;
  } catch {
    return "";
  }
}
