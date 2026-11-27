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

  const markControlFlowBodyBraces = (openParenIdx) => {
    let pDepth = 0;
    for (let k = openParenIdx; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === "punct" && t.value === "(") {
        pDepth += 1;
      } else if (t.type === "punct" && t.value === ")") {
        pDepth -= 1;
        if (pDepth === 0) {
          if (tokens[k + 1]?.type === "punct" && tokens[k + 1].value === "{") {
            suiteBodyOpenIndices.add(k + 1);
          }
          return;
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
      const wasSuiteOrControlBlock = suiteBraceStack.pop();
      if (
        wasSuiteOrControlBlock &&
        tokens[i + 1]?.type === "ident" &&
        tokens[i + 1].value === "else" &&
        tokens[i + 2]?.type === "punct" &&
        tokens[i + 2].value === "{"
      ) {
        suiteBodyOpenIndices.add(i + 2);
      }
      continue;
    }
    if (tok.type !== "ident" || tok.isMemberProp) continue;
    const inSuiteScope = suiteBraceStack.length === 0 || suiteBraceStack.every(Boolean);
    if (!inSuiteScope) continue;

    if ((tok.value === "for" || tok.value === "if") && tokens[i + 1]?.type === "punct" && tokens[i + 1].value === "(") {
      markControlFlowBodyBraces(i + 1);
      continue;
    }

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
  ["context/lib/code-outline.js", "共享语言符号提取、紧凑签名和按字节预算的大纲"],
  ["context/lib/execution-receipts.js", "从当前对话的 ctx_execute 工具回执识别执行记录，用于归属节省统计"],
  ["context/lib/store.js", "`ContextModeStore` 门面类：统一导出与原型聚合（下拆 `context/lib/store/` 5 个职责子模块）"],
  ["context/lib/store/schema.js", "SQLite WAL + FTS5 DDL、幂等列迁移（`content_hash`/`full_read_ts`/`full_read_seq`）、常量与路径解析"],
  ["context/lib/store/fts.js", "标题感知 Markdown 分块、SHA-256 去重索引、Porter BM25 + Trigram RRF 检索与事件流"],
  ["context/lib/store/reads.js", "会话未变更读去重（`file_reads`）、gzip 文本快照（`file_snapshots`）、会话轮次序与 Ghost Registry"],
  ["context/lib/store/checkpoints.js", "结构化会话恢复卡（`session_checkpoints`）、持久化符号大纲（`outline_cache`）与 `repo_cache`"],
  ["context/lib/store/settings-maintenance.js", "`meta` 配置、阈值/豁免管理、`getStats`、`getFeatureRoi` 遥测 ROI 量化、TTL 清理与 `VACUUM`"],
  ["context/lib/config.js", "统一配置加载器（`~/.agy-dart/config.json` + `AGY_DART_*` 环境变量覆盖 + 生效来源追踪）"],
  ["context/lib/conversation-api.js", "官方 Connect HTTP+JSON `product.v1.ConversationService` 只读客户端（严格 loopback 校验、`GetConversation` 归档/子代理/运行态判定，供 Sidecar 与 Watchdog 优先查询并平滑降级至 `conversation_summaries.db`）"],
  ["context/lib/cache/profiles.js", "`MODEL_CACHE_PROFILES`（含 Gemini 4/Neon/Carbon/Argon/Hydrogen、Claude 4 系列）、`resolveModelProfile`、`computeCacheWarmth` 与写溢价成本数学"],
  ["context/lib/cache-analyzer.js", "Transcript KV-Cache 诊断引擎：多厂商 Token 提取（防重计）、跨会话按模型实证 TTL 区间校准、7 桶 `contextComposition`、`subagentBreakdown`、死循环 `loopWatch`、6 类 Bust 归因"],
  ["context/lib/cache-simulator.js", "离线策略回放引擎（devtools）：对比 9 套策略（`observed`、`ttl-5m`、`ttl-1h`、`cold-boundary-compact`、`cutoff-strict/balanced/relaxed`、`keepalive-1x/unlimited`）"],
  ["context/lib/repo-skeleton.js", "`git HEAD` 缓存的核心依赖枢纽扫描（JS/TS + JSONC `tsconfig` `paths`、Python、Rust、Go `go.mod`、Vue/Svelte、Dart、Java）"],
  ["context/lib/json-crusher.js", "零依赖可逆 JSON/JSONL 结构化粉碎器：提取 Schema/空值统计 + 首尾样本 + 异常项，附带 FTS5 `sourceId`"],
  ["context/lib/tools.js", "`agy-dart_context` 8 个 MCP 工具实现；`dedup: true`、`smartCrushJson`、`featureRoi`、生效配置诊断与 `<= 8.8 KB` UTF-8 封顶"],
  ["context/lib/security.js", "`validateFetchTarget`（SSRF 逐跳 DNS + IPv4/IPv6 + IP Pinning）、`redactSecrets`、`detectSensitiveFile`"],
  ["context/lib/handoff.js", "缓存友好交接摘要与卡死抢救简报生成器：`buildHandoffBrief`（含 `stallContext` 抢救快照、分支 + `git diff --stat`、`sessionCheckpoint`、FTS5 句柄、脱敏与 UTF-8 封顶）"],
  ["context/lib/safety-monitor-audit.js", "Antigravity 后台安检日志增量监测（原始字节偏移安全续读、超长行保护、`parseStatus`/`recognizedLines` 可辨识状态与脱敏报告）"],
  ["context/lib/watchdog-lease.js", "极速（<1ms 加载）看门狗租约读写模块：供 4 个生命周期钩子向 SQLite `meta` 写入按直接对话 ID 隔离的 `watchdog_lease:<convId>` 并对命令/用户输入脱敏"],
  ["context/lib/watchdog.js", "Sidecar 卡死看门狗与空闲 TTL 临期提醒引擎（`WatchdogMonitor`）：双源融合状态机、动态超时矩阵、空闲零 transcript `statSync` 与单 tick 共享配置快照、休眠时钟跳变防护、6 类归因指引、抢救版 Handoff Brief 与 Opt-in 防抖卡死/TTL 临期桌面提醒"],
  ["context/lib/text-diff.js", "零依赖行级 Unified Diff 引擎：首尾裁剪 + 有界 Myers + 线性降级保护 + 1-based `startLine` 偏移"],
  ["context/lib/executor.js", "当前系统用户权限下的有界子进程脚本执行器（JS/Node/Python/Shell/PowerShell/CMD，OS+工具链环境白名单、敏感凭据硬过滤、输出封顶与进程树超时清理）"],
  ["context/lib/stable-json.js", "`stableSortObject`、`stableStringify`、`sha256Hex` 与规范 `truncateUtf8Safe`（保证 MCP Schema 指纹确定性与 UTF-8 码点安全截断）"]
];

const HOOK_ENTRIES = [
  ["hooks/filter-rules.mjs", "CLI 降噪规则库：安全拆解单层 `cd [/d] <path> && <cmd>` + `2>&1`、拦截 cmd/PS 危险语法（`%`/`!`/`{}`/`@`/非 git `^`）、11 类内置规则（含三阶段上下文保真 `filterGitDiff`、报错锚点保真 `compactFailureWithErrorAnchors` 与 `gh pr view` 防误伤）、`.agy-dart/filters.json` ReDoS 防护与大 JSON 粉碎"],
  ["hooks/pre-tool-use.mjs", "统一 `PreToolUse` 网关：0-SQLite 快路径 → 敏感文件守卫（TTL + 5 分支隔离）→ 读缓存优先防三连拒（含静默压缩首轮兜底）→ 四层读分级（噪声/压缩 16 KB、常规源码 45 KiB / 800 行 2-strike、`.patch`/`.diff` 128 KB + `ByteOffset` 续读 + 线性 `exemptPaths`）→ 独立 `shellDumpMaxBytes` `run_command` 守卫、透明 `overwrite` 与看门狗 `TOOL_RUNNING`/`SUBAGENT_BG` 租约更新"],
  ["hooks/pre-invocation.mjs", "零前缀污染 `PreInvocation` 守卫：尾读 `transcript.jsonl`，输出水位/热缓存延迟/TTL 预警/多模态悬崖/死循环告警（全部 `systemMessage: \"\"`），推进 `diffRead`/`readDedup` 轮次与 `/compact` 即时失效，并写入 `LLM_INFLIGHT` 看门狗租约"],
  ["hooks/post-tool-use.mjs", "编辑触发单文件 `file_reads` 失效（保快照）并记录 `modifiedFiles`；`ctx_resume` 同时清共享与直接对话快照；写入测试/构建结论到 `sessionCheckpoint`；工具完成后刷新看门狗租约回到 `LLM_INFLIGHT`/`SUBAGENT_BG`"],
  ["hooks/stop.mjs", "轻量 `Stop` 钩子（<5ms、零 stderr、Fail-Open，遵循官方 `{\"decision\":\"allow\"}` 与 `terminationReason`/`fullyIdle`/`error` 契约）：对话轮次结束时将 `watchdog_lease:<convId>` 切换为 `IDLE`"],
  ["hooks/cli-filter.mjs", "`PreToolUse.overwrite` 执行代理：Windows `cmd.exe`/`powershell.exe` 精确透传退出码、密钥脱敏、原输出入 FTS5、降噪并死守 `<= 8.8 KB`"],
  ["hooks/session-start.mjs", "前缀稳定启动钩子：支持 `stablePrefixOnly` 与子 Agent 自动省略易变 Git 尾段（并在子进程隔离禁用 Git）"],
  ["hooks/compile-cache.mjs", "版本化 V8 编译缓存管理（保留最近 3 个版本）、跨 Node 22/24 `suppressSqliteExperimentalWarning()` 零 stderr 护栏，以及全钩子共享轻量工具（`readStdin`/`parseHookPayload`/`isSameFilePath`/`resolveSessionId`/`resolveDirectConversationId`）"]
];

const ENGINE_ENTRIES = [
  ["fast/mcp-server.mjs", "`agy-dart_fast` 4 工具批处理引擎：V8 编译缓存、`read_slices` L1+L2 SQLite `outline_cache`（含原生 `.patch`/`.diff` 变更大纲）与 4 MB 切片缓存、`batch_search` 工作区指纹缓存"],
  ["fast/benchmark.mjs", "离线轨迹基准 CLI（devtools）：`analyze`、`compare`、`cache`、`cache simulate`"],
  ["fast/session-start.mjs", "上游工作区结构与 Git 状态快照生成器（由 `hooks/session-start.mjs` 封装调用，已禁自动更新）"],
  ["context/server.js", "`agy-dart_context` MCP stdio 服务端：紧凑 JSON 输出、出站 JSON-RPC `<= 8,800 B` 线长硬封顶、按客户端 `io.modelcontextprotocol/ui` 渐进式暴露 `ui://agy-dart/diagnostics.html` 内联 MCP App 卡片与 `structuredContent`，保留非 UI 端冻结规范排序 `TOOL_DEFINITIONS`"],
  ["context/ui/diagnostics.html", "零依赖单文件 SEP-1865 MCP App 内联诊断卡片：自动跟随宿主主题与 CSS 变量，可视化渲染 `ctx_stats` 节省率/Feature ROI 与 `ctx_doctor` 运行健康状态"],
  ["dsh/plugin.mjs", "DSH 原生工具桥接插件：透明挂接 pre/execute/result 钩子，失败/取消读自动失效待定缓存并保持 fail-open"],
  ["bin/agy-dart.mjs", "统一 CLI 入口（devtools）：派发 install/doctor/benchmark/cache-audit/prefix-budget/outline"],
  ["scripts/cache-audit.mjs", "全域环境 Prompt Cache 体检 `npm run cache:audit`（devtools）：规则/技能 CJK 估 token、双次握手探测 MCP 确定性、静态分析中段 Hook"],
  ["scripts/install.mjs", "跨平台安装/卸载/模式切换/`doctor` 健康自检：消费 `scripts/package-manifest.json` 导出 `RUNTIME_FILES`（默认）与 `DEVTOOLS_FILES`（`--with-devtools`），校验 5 大 Hook 与 Watchdog 并输出生效配置"],
  ["scripts/targets/index.mjs", "多宿主安装/卸载/`doctor` 路由器与并发安全安装互斥锁（token + 新建宽限窗口 + `.reclaim` 失效锁回收）"],
  ["scripts/targets/shared.mjs", "多宿主共享运行时同步、托管文件哈希、退役清理与安装收据管理"],
  ["scripts/targets/antigravity.mjs", "Antigravity 宿主适配器：委派主安装器并透传子进程退出状态"],
  ["scripts/targets/codex.mjs", "Codex TOML 宿主适配器：安装前拒绝顶层封闭内联表/冲突键，安全写入与校验托管块"],
  ["scripts/targets/claude-code.mjs", "Claude Code 严格 JSON 宿主适配器：完整解析后按字段区间安全更新与卸载配置"],
  ["scripts/targets/dsh.mjs", "DSH YAML 多 profile 宿主适配器：按 profile 独立注册收据、卸载保留用户追加列表项并保护共享运行时"],
  ["scripts/verify-package-graph.mjs", "静态 Import 图打包校验器（devtools）：校验 `scripts/package-manifest.json` 与 `install.mjs` 导出一致性，线性 JS 词法解析器提取含/无分号（ASI）、多行、注释穿插与带属性动态导入的 ESM/CJS 依赖，证明无漏打模块且 devtools 零泄漏"],
  ["scripts/prefix-budget.mjs", "Turn-0 前缀预算、双 MCP 指纹与 `--calibrate` 跨语种 Token 估算误差校准审计（devtools，读取统一 `config.json`，超预算/非规范时非零退出码卡口 CI）"],
  ["scripts/gen-review-brief.mjs", "`AI_REVIEW_BRIEF.md` 全仓源文件覆盖校验、代码行数与测试基线自动生成及 `--check` 漂移守卫（devtools）"],
  ["sidecars/dashboard/server.mjs", "Sidecar HTTP / SidecarApp 服务 + 常驻 Stall Watchdog 巡检：严格 `Host`/同源 `Origin`/`Sec-Fetch-Site` 白名单、`X-Frame-Options: DENY`、独立 HTTP 全部 `/api/*` 强制 `X-Agy-Dart-Token`、SidecarApp 全部 `/api/*` 仅限 `POST`（强制 `X-Sidecar-Token`）、新增 `/api/watchdog` 与 `POST`-only `/api/watchdog/action`、卡死时 `/api/handoff` 自动附带抢救快照"],
  ["sidecars/dashboard/index.html", "实时仪表盘前端：自动注入并携带 CSRF Token、全部 `/api/*` 调用统一 POST JSON、XSS 转义加固、双语无障碍标签与阈值覆盖提示、1s 本地 TTL 与卡死静默倒计时、Stall Watchdog 抢救卡片与 Handoff 抽屉"],
  ["sidecars/dashboard/version-check.mjs", "GitHub Releases SemVer 解析、发布包资产与 SHA-256 摘要筛选、单飞去重与限流冷却"],
  ["sidecars/dashboard/update-archive.mjs", "更新归档安全下载与 tar.gz 解包（HTTPS 域名白名单、16 MiB/48 MiB 封顶、PAX/ustar 校验、防符号链接/穿越/重名与 SHA-256 核验）"],
  ["sidecars/dashboard/version-update.mjs", "主/次宿主在线自更新引擎：优先消费并校验 `scripts/package-manifest.json`、固定批准摘要、同盘暂存替换、逆序回滚与退役清理"]
];

const SOURCE_SCAN_SKIP_DIRS = new Set([".git", "node_modules", "tests", "docs", ".agents", ".gemini"]);
const SOURCE_FILE_EXT_RE = /\.(?:m?js|cjs|html)$/i;

export function discoverWorkspaceSourceFiles(rootDir = REPO_ROOT) {
  const found = [];
  const walk = (absDir, relPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SOURCE_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(absDir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && SOURCE_FILE_EXT_RE.test(entry.name)) {
        found.push(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      }
    }
  };
  walk(rootDir, "");
  return found.sort();
}

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
  const trackedSet = new Set(allEntries.map(([rel]) => rel));
  const workspaceSourceFiles = discoverWorkspaceSourceFiles(rootDir);
  const untrackedSourceFiles = workspaceSourceFiles.filter((rel) => !trackedSet.has(rel));
  const fileLineCounts = Object.fromEntries(allEntries.map(([rel]) => [rel, countLines(rootDir, rel)]));
  const totalTrackedLines = Object.values(fileLineCounts).reduce((a, b) => a + b, 0);

  return {
    version: pkg.version || "1.9.4",
    gitHeadShort: getGitHeadSha(rootDir),
    testFiles: tests.files,
    testCases: tests.cases,
    totalTrackedFiles: allEntries.length,
    totalTrackedLines,
    workspaceSourceFilesCount: workspaceSourceFiles.length,
    untrackedSourceFiles,
    fileLineCounts
  };
}

export function renderGeneratedSections(rootDir = REPO_ROOT) {
  const m = computeBriefMetrics(rootDir);
  const introLine = `> **本文档用途**：面向代码审阅 AI / 架构审计 AI / 安全审查 AI 的高密度项目总览与审阅路线图。对应当前版本 \`v${m.version}\`。代码行数、模块映射与测试数量由 \`scripts/gen-review-brief.mjs\` 自动同步并受 \`--check\` 漂移守卫保护。`;

  const codeMap = [
    "### 3.1 核心库 (`context/lib/`)",
    "",
    renderTable(rootDir, CORE_LIB_ENTRIES),
    "",
    "### 3.2 生命周期钩子 (`hooks/`)",
    "",
    renderTable(rootDir, HOOK_ENTRIES),
    "",
    "### 3.3 双 MCP 引擎、Sidecar 面板、多宿主适配器与审计脚本",
    "",
    renderTable(rootDir, ENGINE_ENTRIES)
  ].join("\n");

  const metaLine = `> **同步快照（由 \`scripts/gen-review-brief.mjs\` 自动维护）**：版本 \`v${m.version}\` · 核心追踪文件 ${m.totalTrackedFiles} 个（合计 ${m.totalTrackedLines.toLocaleString("en-US")} 行） · 测试套件 ${m.testFiles} 个 / ${m.testCases} 个用例 · 可运行 \`node scripts/gen-review-brief.mjs --check\` 检验零漂移。`;

  const verifyBaseline = [
    "```bash",
    `# 1. 全量 ${m.testFiles} 个测试套件（覆盖全部生命周期钩子、双 MCP、缓存诊断、看门狗、多宿主安装/自更新、性能优化与安全回归）`,
    "npm test",
    `# 预期基线：${m.testCases}/${m.testCases} PASS, 0 fail`,
    "",
    "# 2. 静态 Import 图打包完整性与 runtime/devtools 隔离校验",
    "npm run verify:pkg",
    "# 预期基线：PASS（0 missing runtime modules, 0 devtools leaked）",
    "",
    "# 3. Turn-0 前缀预算、双 MCP 规范性与跨语种 Token 估算校准",
    "npm run prefix:budget",
    "node scripts/prefix-budget.mjs --stable-only --json",
    "node scripts/prefix-budget.mjs --calibrate",
    "node scripts/prefix-budget.mjs --calibrate --auto-transcript",
    "# configuredStartup.estimatedTokens 按清单统计预载工具；totalTokens 包含全部工具，启动摘要随工作区变化",
    "",
    "# 4. 全域环境 Prompt Cache 体检 & 离线 9 策略回放",
    "node scripts/cache-audit.mjs --workspace . --no-live",
    "npm run cache:simulate",
    "",
    "# 5. 审阅简报行数、全仓源文件覆盖与测试基线零漂移检验",
    "npm run brief:check",
    "",
    "# 6. 健康检查（含生效配置与覆盖来源报告）",
    "npm run doctor",
    "```"
  ].join("\n");

  return { introLine, metaLine, codeMap, verifyBaseline, metrics: m };
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
  const { introLine, metaLine, codeMap, verifyBaseline, metrics } = renderGeneratedSections(rootDir);

  let updated = replaceBlock(normalizedCurrent, "<!-- AUTO:INTRO:START -->", "<!-- AUTO:INTRO:END -->", introLine);
  updated = replaceBlock(updated, "<!-- AUTO:META:START -->", "<!-- AUTO:META:END -->", metaLine);
  updated = replaceBlock(updated, "<!-- AUTO:CODE_MAP:START -->", "<!-- AUTO:CODE_MAP:END -->", codeMap);
  updated = replaceBlock(
    updated,
    "<!-- AUTO:VERIFY_BASELINE:START -->",
    "<!-- AUTO:VERIFY_BASELINE:END -->",
    verifyBaseline
  );

  const inSync = normalizedCurrent === updated && metrics.untrackedSourceFiles.length === 0;
  if (write && (normalizedCurrent !== updated || rawCurrent !== updated)) {
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
  const ALLOWED_FLAGS = new Set(["--json", "--write", "--check", "-h", "--help"]);
  const unknown = args.find((a) => !ALLOWED_FLAGS.has(a));
  if (unknown) {
    console.error(`gen-review-brief error: unknown option '${unknown}'. Expected --check, --write, or --json.`);
    process.exit(1);
  }
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node scripts/gen-review-brief.mjs [--check | --write | --json]");
  } else if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(computeBriefMetrics(REPO_ROOT), null, 2) + "\n");
  } else if (args.includes("--write")) {
    const res = syncBriefFile(REPO_ROOT, { write: true });
    console.log(`AI_REVIEW_BRIEF.md synced (v${res.metrics.version}, ${res.metrics.totalTrackedFiles} files / ${res.metrics.totalTrackedLines} lines, ${res.metrics.testFiles} test files / ${res.metrics.testCases} cases).`);
  } else {
    const res = syncBriefFile(REPO_ROOT, { write: false });
    if (!res.inSync) {
      if (res.metrics.untrackedSourceFiles.length > 0) {
        console.error(
          `AI_REVIEW_BRIEF.md check failed: untracked workspace source files: ${res.metrics.untrackedSourceFiles.join(", ")}`
        );
      } else {
        console.error("AI_REVIEW_BRIEF.md is out of sync with workspace line counts/test inventory. Run: npm run brief:sync");
      }
      process.exit(1);
    }
    console.log(
      `AI_REVIEW_BRIEF.md check: PASS (v${res.metrics.version}, ${res.metrics.totalTrackedFiles} files / ${res.metrics.totalTrackedLines} lines, ${res.metrics.testCases} tests).`
    );
  }
}
