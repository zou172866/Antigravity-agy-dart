#!/usr/bin/env node
/**
 * Auto-generator & drift checker for `AI_REVIEW_BRIEF.md` code line counts,
 * version/commit metadata, and test-suite inventory.
 *
 * Usage:
 *   node scripts/gen-review-brief.mjs --write   # Update auto-generated blocks in AI_REVIEW_BRIEF.md
 *   node scripts/gen-review-brief.mjs --check   # Exit 1 if AI_REVIEW_BRIEF.md has drifted from repo state
 *   node scripts/gen-review-brief.mjs --json    # Print computed metrics as JSON
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tokenizeJsForSpecifiers } from "./verify-package-graph.mjs";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const REPO_ROOT = path.resolve(__dirname, "..");

function countLines(rootDir, relPath) {
  const full = path.join(rootDir, relPath);
  if (!fs.existsSync(full)) return 0;
  const txt = fs.readFileSync(full, "utf8");
  if (!txt) return 0;
  return txt.split(/\r\n?|\n/).length;
}

function getGitHeadSha(rootDir) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 3000
    }).trim();
  } catch {
    return "uncommitted";
  }
}

export function countTestCasesInSource(src) {
  const tokens = tokenizeJsForSpecifiers(src);
  let count = 0;
  const TEST_SUBMETHODS = new Set(["skip", "only", "todo", "it", "test"]);
  const SUITE_SUBMETHODS = new Set(["skip", "only", "todo", "concurrent"]);
  const suiteBodyOpenIndices = new Set();
  const suiteBraceStack = [];

  const isCallStartAfter = (idx, submethods) => {
    const next = tokens[idx + 1];
    if (next?.type === "punct" && next.value === "(") return idx + 1;
    if (
      next?.type === "punct" &&
      next.value === "?" &&
      tokens[idx + 2]?.type === "punct" &&
      tokens[idx + 2].value === "." &&
      tokens[idx + 3]?.type === "punct" &&
      tokens[idx + 3].value === "("
    ) {
      return idx + 3;
    }
    if (
      next?.type === "punct" &&
      next.value === "." &&
      tokens[idx + 2]?.type === "ident" &&
      submethods.has(tokens[idx + 2].value)
    ) {
      if (tokens[idx + 3]?.type === "punct" && tokens[idx + 3].value === "(") return idx + 3;
      if (
        tokens[idx + 3]?.type === "punct" &&
        tokens[idx + 3].value === "?" &&
        tokens[idx + 4]?.type === "punct" &&
        tokens[idx + 4].value === "." &&
        tokens[idx + 5]?.type === "punct" &&
        tokens[idx + 5].value === "("
      ) {
        return idx + 5;
      }
    }
    return -1;
  };

  const markSuiteCallbackBrace = (openParenIdx) => {
    let pDepth = 0;
    let bDepth = 0;
    let expectFnBodyBrace = false;
    for (let k = openParenIdx; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === "punct" && t.value === "(") {
        pDepth += 1;
      } else if (t.type === "punct" && t.value === ")") {
        pDepth -= 1;
        if (pDepth === 0) break;
      } else if (t.type === "punct" && t.value === "{") {
        if (pDepth === 1 && bDepth === 0 && expectFnBodyBrace) {
          suiteBodyOpenIndices.add(k);
          return;
        }
        bDepth += 1;
      } else if (t.type === "punct" && t.value === "}") {
        bDepth = Math.max(0, bDepth - 1);
      } else if (pDepth === 1 && bDepth === 0) {
        if (t.type === "punct" && t.value === ">" && tokens[k - 1]?.type === "punct" && tokens[k - 1].value === "=") {
          expectFnBodyBrace = true;
        } else if (t.type === "ident" && t.value === "function") {
          expectFnBodyBrace = true;
        } else if (t.type === "punct" && t.value === ",") {
          expectFnBodyBrace = false;
        }
      }
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "punct" && tok.value === "{") {
      suiteBraceStack.push(suiteBodyOpenIndices.has(i));
      continue;
    }
    if (tok.type === "punct" && tok.value === "}") {
      suiteBraceStack.pop();
      continue;
    }
    if (tok.type !== "ident" || tok.isMemberProp) continue;
    const inSuiteScope = suiteBraceStack.length === 0 || suiteBraceStack.every(Boolean);
    if (!inSuiteScope) continue;

    const prev = i > 0 ? tokens[i - 1] : null;
    const prev2 = i > 1 ? tokens[i - 2] : null;
    const isExcludedLead =
      (prev?.type === "ident" && (prev.value === "function" || prev.value === "new" || prev.value === "return")) ||
      (prev?.type === "punct" && prev.value === "*" && prev2?.type === "ident" && prev2.value === "function") ||
      (prev?.type === "punct" && prev.value === ">" && prev2?.type === "punct" && prev2.value === "=");
    if (isExcludedLead) continue;

    if (tok.value === "describe" || tok.value === "suite") {
      const openParenIdx = isCallStartAfter(i, SUITE_SUBMETHODS);
      if (openParenIdx !== -1) {
        markSuiteCallbackBrace(openParenIdx);
      }
      continue;
    }

    if (tok.value === "test" || tok.value === "it") {
      const openParenIdx = isCallStartAfter(i, TEST_SUBMETHODS);
      if (openParenIdx !== -1) {
        count += 1;
      }
    }
  }
  return count;
}

function countTests(rootDir) {
  const testsDir = path.join(rootDir, "tests");
  if (!fs.existsSync(testsDir)) return { files: 0, cases: 0 };
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.mjs")).sort();
  let cases = 0;
  for (const f of files) {
    cases += countTestCasesInSource(fs.readFileSync(path.join(testsDir, f), "utf8"));
  }
  return { files: files.length, cases };
}

const CORE_LIB_ENTRIES = [
  ["context/lib/store.js", "`ContextModeStore` 门面类：统一导出与原型聚合（下拆 `context/lib/store/` 5 个职责子模块）"],
  ["context/lib/store/schema.js", "SQLite WAL + FTS5 DDL、幂等列迁移（`content_hash`/`full_read_ts`/`full_read_seq`）、常量与路径解析"],
  ["context/lib/store/fts.js", "标题感知 Markdown 分块、SHA-256 去重索引、Porter BM25 + Trigram RRF 检索与事件流"],
  ["context/lib/store/reads.js", "会话未变更读去重（`file_reads`）、gzip 文本快照（`file_snapshots`）、会话轮次序与 Ghost Registry"],
  ["context/lib/store/checkpoints.js", "结构化会话恢复卡（`session_checkpoints`）、持久化符号大纲（`outline_cache`）与 `repo_cache`"],
  ["context/lib/store/settings-maintenance.js", "`meta` 配置、阈值/豁免管理、`getStats`、`getFeatureRoi` 遥测 ROI 量化、TTL 清理与 `VACUUM`"],
  ["context/lib/config.js", "统一配置加载器（`~/.agy-dart/config.json` + `AGY_DART_*` 环境变量覆盖 + 生效来源追踪）"],
  ["context/lib/cache/profiles.js", "`MODEL_CACHE_PROFILES`（含 Gemini 4/Neon/Carbon/Argon/Hydrogen、Claude 4 系列）、`resolveModelProfile`、`computeCacheWarmth` 与写溢价成本数学"],
  ["context/lib/cache-analyzer.js", "Transcript KV-Cache 诊断引擎：多厂商 Token 提取（防重计）、实证 TTL 校准、7 桶 `contextComposition`、`subagentBreakdown`、死循环 `loopWatch`、6 类 Bust 归因"],
  ["context/lib/cache-simulator.js", "离线策略回放引擎（devtools）：对比 7 套策略（`observed`、`ttl-5m`、`ttl-1h`、`cold-boundary-compact`、`cutoff-strict/balanced/relaxed`）"],
  ["context/lib/repo-skeleton.js", "`git HEAD` 缓存的核心依赖枢纽扫描（JS/TS + JSONC `tsconfig` `paths`、Python、Rust、Go `go.mod`、Vue/Svelte、Dart、Java）"],
  ["context/lib/json-crusher.js", "零依赖可逆 JSON/JSONL 结构化粉碎器：提取 Schema/空值统计 + 首尾样本 + 异常项，附带 FTS5 `sourceId`"],
  ["context/lib/tools.js", "`agy-dart_context` 8 个 MCP 工具实现；`dedup: true`、`smartCrushJson`、`featureRoi`、生效配置诊断与 `<= 8.8 KB` UTF-8 封顶"],
  ["context/lib/security.js", "`validateFetchTarget`（SSRF 逐跳 DNS + IPv4/IPv6 + IP Pinning）、`redactSecrets`、`detectSensitiveFile`"],
  ["context/lib/handoff.js", "缓存友好交接摘要生成器：`buildHandoffBrief`（分支 + `git diff --stat`、`sessionCheckpoint`、FTS5 句柄、脱敏与 UTF-8 封顶）"],
  ["context/lib/text-diff.js", "零依赖行级 Unified Diff 引擎：首尾裁剪 + 有界 Myers + 线性降级保护 + 1-based `startLine` 偏移"],
  ["context/lib/executor.js", "本地沙盒脚本执行器（JS/Node/Python/Shell/PowerShell/CMD，带输出封顶与超时清理）"],
  ["context/lib/stable-json.js", "`stableSortObject`、`stableStringify`、`sha256Hex`（保证 MCP Schema 与指纹 100% 字节确定性）"]
];

const HOOK_ENTRIES = [
  ["hooks/filter-rules.mjs", "CLI 降噪规则库：安全拆解单层 `cd [/d] <path> && <cmd>` + `2>&1`、拦截 cmd/PS 危险语法（`%`/`!`/`{}`/`@`/非 git `^`）、11 类内置规则、`.agy-dart/filters.json` ReDoS 防护与大 JSON 粉碎"],
  ["hooks/pre-tool-use.mjs", "统一 `PreToolUse` 网关：0-SQLite 快路径 → 可选敏感文件守卫 → 16 KB/410 行大文件拦截 + Ghost → 三态读缓存（`diffRead` 默认关闭、按直接对话 ID 隔离且受轮次/时间新鲜度约束）→ `run_command` 透明 `overwrite`"],
  ["hooks/pre-invocation.mjs", "零前缀污染 `PreInvocation` 守卫：尾读 `transcript.jsonl`，输出水位/热缓存延迟/TTL 预警/多模态悬崖/死循环告警（全部 `systemMessage: \"\"`），且在 `cacheWatch=false`/暂停下仍维持 `diffRead` 轮次递增"],
  ["hooks/post-tool-use.mjs", "编辑触发单文件 `file_reads` 失效（保快照）并记录 `modifiedFiles`；`ctx_resume` 同时清共享与直接对话快照；写入测试/构建结论到 `sessionCheckpoint`"],
  ["hooks/cli-filter.mjs", "`PreToolUse.overwrite` 执行代理：Windows `cmd.exe`/`powershell.exe` 精确透传退出码、密钥脱敏、原输出入 FTS5、降噪并死守 `<= 8.8 KB`"],
  ["hooks/session-start.mjs", "前缀稳定启动钩子：支持 `stablePrefixOnly` 与子 Agent 自动省略易变 Git 尾段（并在子进程隔离禁用 Git）"],
  ["hooks/compile-cache.mjs", "版本化 V8 编译缓存管理（保留最近 3 个版本）与跨 Node 22/24 的 `suppressSqliteExperimentalWarning()` 零 stderr 护栏"]
];

const ENGINE_ENTRIES = [
  ["fast/mcp-server.mjs", "`agy-dart_fast` 4 工具批处理引擎：V8 编译缓存、`read_slices` L1+L2 SQLite `outline_cache` 与 4 MB 切片缓存、`batch_search` 工作区指纹缓存"],
  ["fast/benchmark.mjs", "离线轨迹基准 CLI（devtools）：`analyze`、`compare`、`cache`、`cache simulate`"],
  ["fast/session-start.mjs", "上游工作区结构与 Git 状态快照生成器（由 `hooks/session-start.mjs` 封装调用，已禁自动更新）"],
  ["context/server.js", "`agy-dart_context` MCP stdio 服务端：先激活 V8 编译缓存与 SQLite 告警静默再动态加载库模块；导出冻结规范排序 `TOOL_DEFINITIONS`"],
  ["scripts/cache-audit.mjs", "全域环境 Prompt Cache 体检 `npm run cache:audit`（devtools）：规则/技能 CJK 估 token、双次握手探测 MCP 确定性、静态分析中段 Hook"],
  ["scripts/install.mjs", "跨平台安装/卸载/模式切换/`doctor` 健康自检：拆分 `RUNTIME_FILES`（默认）与 `DEVTOOLS_FILES`（`--with-devtools`），`doctor` 输出生效配置"],
  ["scripts/verify-package-graph.mjs", "静态 Import 图打包校验器（devtools）：线性 JS 词法解析器提取含/无分号（ASI）、多行、注释穿插与带属性动态导入的 ESM/CJS 依赖，证明无漏打模块且 devtools 零泄漏"],
  ["scripts/prefix-budget.mjs", "Turn-0 前缀预算、双 MCP 指纹与 `--calibrate` 跨语种 Token 估算误差校准审计（devtools，读取统一 `config.json`，超预算/非规范时非零退出码卡口 CI）"],
  ["scripts/gen-review-brief.mjs", "`AI_REVIEW_BRIEF.md` 代码行数/测试基线自动生成与 `--check` 漂移守卫（devtools）"],
  ["sidecars/dashboard/server.mjs", "Sidecar HTTP / SidecarApp 服务：严格 `Host`/同源 `Origin`/`Sec-Fetch-Site` 白名单（拦截 `cross-site`、`same-site` 及伪造头）、`X-Frame-Options: DENY`、独立 HTTP 全部 `/api/*` 强制随机 `X-Agy-Dart-Token`、SidecarApp 模式全部 `/api/*` 仅限 POST（强制 `X-Sidecar-Token`）、写接口与 `/api/search` 仅 POST + `application/json` + 64 KB 请求体上限与 `featureRoi`"],
  ["sidecars/dashboard/index.html", "实时仪表盘前端：自动注入并携带 CSRF Token、全部 `/api/*` 调用统一 POST JSON、XSS 转义加固、1s 本地 TTL 进度条、Handoff 抽屉与上下文构成条"]
];

function renderTable(rootDir, entries) {
  const rows = [
    "| 文件 | 行数 | 核心职责与关键导出 |",
    "| :--- | ---: | :--- |"
  ];
  for (const [rel, desc] of entries) {
    const lines = countLines(rootDir, rel);
    rows.push(`| \`${rel}\` | ${lines.toLocaleString("en-US")} | ${desc} |`);
  }
  return rows.join("\n");
}

export function computeBriefMetrics(rootDir = REPO_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const tests = countTests(rootDir);
  const allEntries = [...CORE_LIB_ENTRIES, ...HOOK_ENTRIES, ...ENGINE_ENTRIES];
  const fileLineCounts = Object.fromEntries(allEntries.map(([rel]) => [rel, countLines(rootDir, rel)]));
  const totalTrackedLines = Object.values(fileLineCounts).reduce((a, b) => a + b, 0);

  return {
    version: pkg.version || "1.2.0",
    gitHeadShort: getGitHeadSha(rootDir),
    testFiles: tests.files,
    testCases: tests.cases,
    totalTrackedFiles: allEntries.length,
    totalTrackedLines,
    fileLineCounts
  };
}

export function renderGeneratedSections(rootDir = REPO_ROOT) {
  const m = computeBriefMetrics(rootDir);
  const codeMap = [
    "### 3.1 核心库 (`context/lib/`)",
    "",
    renderTable(rootDir, CORE_LIB_ENTRIES),
    "",
    "### 3.2 生命周期钩子 (`hooks/`)",
    "",
    renderTable(rootDir, HOOK_ENTRIES),
    "",
    "### 3.3 双 MCP 引擎、Sidecar 面板与审计脚本",
    "",
    renderTable(rootDir, ENGINE_ENTRIES)
  ].join("\n");

  const metaLine = `> **同步快照（由 \`scripts/gen-review-brief.mjs\` 自动维护）**：版本 \`v${m.version}\` · 核心追踪文件 ${m.totalTrackedFiles} 个（合计 ${m.totalTrackedLines.toLocaleString("en-US")} 行） · 测试套件 ${m.testFiles} 个 / ${m.testCases} 个用例 · 可运行 \`node scripts/gen-review-brief.mjs --check\` 检验零漂移。`;

  return { metaLine, codeMap, metrics: m };
}

function replaceBlock(content, startMarker, endMarker, replacement) {
  const sIdx = content.indexOf(startMarker);
  const eIdx = content.indexOf(endMarker);
  if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) {
    throw new Error(`Missing auto-generated markers: ${startMarker} .. ${endMarker}`);
  }
  const before = content.slice(0, sIdx + startMarker.length);
  const after = content.slice(eIdx);
  return `${before}\n${replacement}\n${after}`;
}

export function syncBriefFile(rootDir = REPO_ROOT, { write = false } = {}) {
  const briefPath = path.join(rootDir, "AI_REVIEW_BRIEF.md");
  const rawCurrent = fs.readFileSync(briefPath, "utf8");
  const normalizedCurrent = rawCurrent.replace(/\r\n?/g, "\n");
  const { metaLine, codeMap, metrics } = renderGeneratedSections(rootDir);

  let updated = replaceBlock(normalizedCurrent, "<!-- AUTO:META:START -->", "<!-- AUTO:META:END -->", metaLine);
  updated = replaceBlock(updated, "<!-- AUTO:CODE_MAP:START -->", "<!-- AUTO:CODE_MAP:END -->", codeMap);

  const inSync = normalizedCurrent === updated;
  if (write && (!inSync || rawCurrent !== updated)) {
    fs.writeFileSync(briefPath, updated, "utf8");
  }
  return { inSync, metrics, briefPath };
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(computeBriefMetrics(REPO_ROOT), null, 2) + "\n");
  } else if (args.includes("--write")) {
    const res = syncBriefFile(REPO_ROOT, { write: true });
    console.log(`AI_REVIEW_BRIEF.md synced (v${res.metrics.version}, ${res.metrics.totalTrackedFiles} files / ${res.metrics.totalTrackedLines} lines, ${res.metrics.testFiles} test files / ${res.metrics.testCases} cases).`);
  } else {
    const res = syncBriefFile(REPO_ROOT, { write: false });
    if (!res.inSync) {
      console.error("AI_REVIEW_BRIEF.md is out of sync with workspace line counts/test inventory. Run: node scripts/gen-review-brief.mjs --write");
      process.exit(1);
    }
    console.log(`AI_REVIEW_BRIEF.md check: PASS (v${res.metrics.version}, ${res.metrics.totalTrackedLines} lines, ${res.metrics.testCases} tests).`);
  }
}
