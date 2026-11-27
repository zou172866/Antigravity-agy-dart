<div align="center">

**简体中文** · [English](README.md)

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**Google Antigravity 插件 — 省 token · 优化缓存命中 · 按需保缓存 · 盯紧后台偷烧 · 抢救崩掉的会话**

零额外依赖 · 装好自动在后台工作 · 自带右侧面板

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
[![Node.js 22.16+ (22.x) 或 24+](https://img.shields.io/badge/Node.js-22.16%2B_(22.x)_or_24%2B-38bdf8.svg)](package.json)
[![Security Policy](https://img.shields.io/badge/Security-Policy-818cf8.svg)](SECURITY.md)
[![Glama MCP](https://glama.ai/mcp/servers/zou172866/agy-dart/badges/score.svg)](https://glama.ai/mcp/servers/zou172866/agy-dart)
[![Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-dart.json)](https://github.com/zou172866/repo-traffic-archive)

[怎么安装](#怎么安装) · [更新日志](#更新日志) · [安全说明](SECURITY.md) · [开源致谢](THIRD_PARTY_NOTICES.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.zh-CN.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/architecture-light.zh-CN.svg" />
    <img alt="agy-dart 架构示意图" src="assets/architecture-dark.zh-CN.svg" width="860" />
  </picture>
</p>

<p align="center">
  <img alt="开启 agy-dart 前后对比" src="assets/demo-comparison.zh-CN.svg" width="860" />
</p>

---

## 这个插件能帮你干什么？

`agy-dart` 是专为 **Google Antigravity** 打造的省额度、保缓存与会话护航插件（也支持通过 `--target` 装到 DeepSeek Harness、Claude Code 和 Codex）。

装好后在后台自动生效，**不用背新命令，平时照常打字聊天就行**：

### 1. 合并零碎操作，少跑冤枉轮次
AI 要搜好几个关键词时一次同时搜完，要改多个文件时一次改完并顺手跑测试，不用把整段聊天记录反复发好几轮。

### 2. 挡住刷屏废话，大文件先看目录
跑一次测试吐出 3000 行日志，插件只挑关键报错给 AI（比如第 42 行失败，其余 199 个通过），完整原文存本地随时可查。遇到几千行的大代码文件，先免费递上带行号的目录，AI 只挑要改的那几十行去读。

### 3. 看清缓存状态，按需自动续温
插件会尽量保持每次请求的开头内容稳定，并减少短时间内反复重读没改过的文件；不过实际缓存命中率仍会受 Antigravity 本身和云端服务影响（如果你用了动态换节点的代理，命中率飘忽时可以先固定单一节点对比排查）。自动续温和缓存快到期时的桌面提醒默认关闭；打开后每段对话默认最多自动续 1 次，发新消息重新计数，次数和间隔都可在面板里调。

### 4. 右侧监控面板与崩溃/卡死抢救
右侧面板一眼看清：上下文还剩多少、缓存还剩几分钟过期、一共挡掉了多少废话。多开项目窗口时，哪个后台窗口快满或一直转圈不出字，右下角弹窗直接标明项目名和对话标题，点一下就能切过去；万一对话真卡死或快爆上限，点一下面板把当前进度打包，贴到新对话就能接着干。

### 5. 揪出后台“偷烧额度”（安全审查监测）
Antigravity 偶尔会在后台反复重审长对话，悄悄把 5 小时额度烧干甚至触发 429 报错。插件会自动盯着本地运行日志（重启软件也不丢账本）：平时没事就安静收成一行不打扰；一旦发现后台正在反复重审或接近额度红线，面板会自动展开用大白话告诉你现在怎么做，点一下「整理进度，换新对话」就能及时换窗止损。

### 其他贴心小功能
1. **压缩对话（`/compact`）后不断片**：后台自动记着改过哪些文件、最近测试过没过、存了哪些资料，压缩完 AI 直接接着往下做。
2. **长文档与网页存本地按需搜**：几万字的开发文档或网页按章节存进本机，用到哪段按关键词搜哪段，不硬塞进对话。
3. **大日志和大表格先在本地筛完再汇报**：几十 MB 的日志、CSV 或几万行 JSON，AI 先在本地沙盒跑几行脚本做统计（比如筛出报错最多的 5 个接口），只把结论带回对话；大 JSON 还会自动挑出报错的异常条。
4. **新对话自动附带项目目录**：刚开对话时自动给 AI 一份精简目录、常用脚本和核心文件清单，不用每次从头摸黑找文件。
5. **死循环及时喊停**：AI 连续出现「改代码 → 报错 → 改回去 → 又报错」或原地打转时，在界面弹一条只给你看的提示（不占模型上下文）。
6. **密钥打码与敏感文件防护**：日志和网页里的 API Key、口令自动打码；可挡住 AI 误读 `.env` 等敏感文件，并防止陌生仓库的 Git 配置偷偷执行外部命令。
7. **把单次返回压在 8.8 KB 内**：Antigravity 单次工具返回超过约 10 KB 会转存临时文件、害 AI 多跑一轮去读；插件把返回稳在 8.8 KB 内，还会把简短命令省下的字数匀给真正报错的长堆栈。
8. **面板看账本、聊天内联卡片与一键更新**：右侧面板可看上下文都花在读文件、终端还是子助手上，查看最近 15 轮缓存命中走势，调 `ctx_stats` / `ctx_doctor` 还能直接在聊天里看交互式诊断卡片（Antigravity `v2.35.1+` 支持一键点进右侧面板）；顶栏支持一键检查/自动更新，命令行还能拿历史记录测算缓存和续温成本。
9. **和各类 Skill 放心叠加，还能做体检**：你装的各类 Skill 照常管流程，插件在底层负责防盲读、压日志和保缓存，互不打架；跑一句 `node bin/agy-dart.mjs audit skills`，就能查出本机每个 Skill 开场占了多少额度、有没有把大段资料全堆在主说明里。

> Antigravity 官方更新很勤，点一下右上角 **Star** 方便随时跟进兼容更新。

---

## 怎么安装

需要先安装 **Node.js 22.16+（22.x）或 24+**。插件零第三方依赖，安装时会自动检查 Node.js 内置的本地搜索数据库（SQLite FTS5 / trigram）是否可用。

### 方法一：终端一行命令直装（免手动克隆）

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.9.3/install.ps1 | iex
```

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.9.3/install.sh | sh
```

### 方法二：直接发给 Antigravity 帮你装

复制下面这句发给 Antigravity 就行：

```text
请将 https://github.com/zou172866/Antigravity-agy-dart.git 的 v1.9.3 标签克隆到临时目录，运行其中的 scripts/install.mjs install 完成全局安装并跑 doctor 自检（Windows 如未安装 rg 请同时传 --install-rg）。
```

### 方法三：克隆仓库自定义安装

```powershell
git clone --branch v1.9.3 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
cd Antigravity-agy-dart

# Windows PowerShell（加 -InstallRg 可顺手自动安装快速搜索工具 rg）
.\install.ps1 -InstallRg

# macOS / Linux
./install.sh
```

**常用管理命令：**

```bash
node scripts/install.mjs install                     # 全局安装（本机有 GEMINI_HOME 或 T3 ACP 目录会自动同步）
node scripts/install.mjs install --project /项目路径  # 只装到单个项目
node scripts/install.mjs doctor                      # 检查安装状态
node scripts/install.mjs uninstall                   # 卸载
```

装完重启或刷新一下 Antigravity 窗口，新开对话即生效。升级重装会自动保留你自建的 `rules/*.local.md`；以前单独装过旧版 `agy-fast` 或 `antigravity-plugin-context-mode` 的话，去插件列表把旧的关掉即可。

本机存下来的文档索引和用量记录保存在 `~/.agy-dart/context.db`，卸载插件时不会误删。想清掉当前对话的索引，卸载前让 AI 跑一次 `ctx_purge`（软件没传会话 ID 时会清理当前项目的未归属记录）；想把所有项目的记录一并清干净，带上 `scope: "all"` 即可。全局卸载也会清理安装器记录过的 Gemini / T3 同步副本；遇到早年手动装过、无法确认归属的旧副本时，会列出路径和单独清理命令，不会乱删。

---

## 设置调节

日常开关全在右侧 **agy-dart Context** 面板里点一下就行：

- **自动续温（默认关闭）**：需要时给当前对话打开「自动续温」，也可以随时点倒计时旁的 **「续温 1×」** 手动续一次；想统一设默认次数和间隔，点「全局续温」（支持 **动态估算**、**固定 4 / 9 / 15 分钟** 或 **自定义 1–60 分钟**）。关掉当前窗口的自动续温后，快过期和次数用完都不会再弹窗。
  > 说明：每次续温都会让模型回一个 `OK` 并消耗一点输入额度；如果缓存其实已经过期，会重新处理一遍整段历史。
- **桌面弹窗提醒（默认关闭）**：缓存临期、任务卡死、后台偷烧额度（**偷烧弹窗提醒**）的桌面弹窗全默认关闭，按需在面板里单独打开。
- **一键更新 / 自动更新**：顶栏可直接点「检查更新 / 立即更新」原地升级；旁边的 **「自动更新：关/开」** 默认关闭，打开后同大版本新发布会在后台静默升级。
- **其他开关**：暂停保护、清理旧记录、调整文件读取大小上限，都可以在面板里直接改。

也可以用命令切拦截档位和工具加载方式：

```bash
node scripts/install.mjs mode host-45k              # 默认：普通代码 45 KB、补丁 128 KB 内直读，大日志超 16 KB 拦截
node scripts/install.mjs mode balanced-16k          # 超过 16 KB 先看目录挑重点读
node scripts/install.mjs mode fast-32k              # 普通文件放宽到 32 KB
node scripts/install.mjs mode strict-8k             # 超过 8 KB 拦截
node scripts/install.mjs mode no-read-hook          # 读文件不拦，只拦终端刷屏大日志

node scripts/install.mjs tool-loading fast-eager    # 默认：4 个高频 fast 工具预载，8 个 context 工具按需加载
node scripts/install.mjs tool-loading lazy          # 12 个工具全部按需加载
node scripts/install.mjs tool-loading eager         # 12 个工具全部预载
```

<details>
<summary>遇到 <code>ide-tools</code> 报 <code>/required</code> 重复参数错误怎么办？</summary>

如果部分 Antigravity 版本初始化工具箱时报错 `building toolbox: tool "mcp_ide-tools_mcp_agy-dart_fast_apply_edits" advertises an invalid parameter schema ... at '/required': items at 1 and 2 are equal`，这是宿主桥接层重复追加了必填字段导致的。把工具加载改成按需加载并重启 Antigravity 即可解决：

```bash
node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy
```

更多排错方法见 [skills/agy-dart/references/error-playbook.md](skills/agy-dart/references/error-playbook.md)。

</details>

---

## 更新日志

### v1.9.3
- **右侧面板新增 Catppuccin Mocha 暗黑主题与首屏防白闪（感谢 `@Ansg2022` 贡献 #8）**：支持默认跟随系统深浅色、左键在浅色与 Mocha 深色间一键切换、右键或 `Shift+Click` / `Shift+Enter` 恢复跟随系统，并加入首屏防白闪（FOUC）初始化脚本，打开即暗黑不刺眼。
- **卡片层次打磨与顶栏锚点快跳**：优化了面板卡片层次与边框对比度，顶栏新增分节快速跳转胶囊条与滚动位置高亮追踪；补齐窄侧边栏（实测 `300px–820px`）零裁切折行、防底部抢跳与页面卸载清理（新增 `tests/dashboard-theme.test.mjs` 回归用例）。

### v1.9.2
- **内联诊断卡片安全与体验加固**：修复 `ctx_stats` 卡片点击刷新时不再重放 `reset: true`（强制只读刷新，避免二次清空当前会话数据）；修复 `ctx_doctor` 卡片 Safety Monitor 告警显示真实 `diagnosis` 与处置建议；加固 `event.source === window.parent` 校验、宿主 CSS 变量白名单与 `background-color`（阻断 `url(...)` 与内部变量覆盖）、补齐 `ui/resource-teardown` 清理响应，并收严 `context/server.js` 的 SEP-1865 `mimeTypes` 协商。
- **`ConversationService` 回环边界与无上限历史 SQLite 加固**：为 `localhost` 补齐解析后回环 IP 校验、独立墙钟总超时（防慢速滴水绕过）、HTTP 200 响应契约/ID 一致性校验，以及 Sidecar 发送路径共享 60 秒退避；修复 `conversations_fts` 超过 32 行时的归档漏判、独占锁下的共享截止时间与不污染负缓存、原子 CAS 清理过期租约（`deleteWatchdogLeaseIfUnchanged`）、扫描缓存 WAL 失效、索引感知最近会话查询及 `opendirSync` 流式目录遍历。
- **读守卫、批量编辑恢复点、模拟器与跨宿主升级修复**：大文件跨 2 MiB 探测边界不再误放行宽行读取；`apply_edits(verify)` 改传结构化验证结果，50 文件长路径触发 8.8 KB 截断时仍准确写入失败恢复点；`cache-simulator.js` 对齐 Gemini 4 的 2,050 token 尾部重算免误报；DSH/Claude/Codex 升级同步清理 8 个退役文档/SVG；自更新备用清单补齐 `dsh/` 并排除退役 SVG；恢复 `fast/session-start.mjs` 单文件独立运行能力、统一 `truncateUtf8Safe` 孤立代理项处理并修正 `cache-audit` Markdown 总数明细。_（看门狗策略说明：无档位后缀的 `gemini-4-carbon`/`neon` 刻意保留 600s 保护性高推理阈值以防长思考误报卡死，显式 `-low`/`-medium` 走常规阈值。）_

### v1.9.1
- **开场规则与排错文档进一步瘦身（零减功能）**：精简 `rules/AGENTS.md` 与 `agy-dart_context` 工具描述，默认首轮开场占用从 `~1,344` 降至 `~1,287` token（全量目录 `1,956 → 1,883` token）；压缩 `SKILL.md` 与排错手册冗余表述，按需读取排错文档一次直省约 **3,278 token（-36%）**。
- **安装目录体积更轻**：不再把仅用于 GitHub 主页展示的双语 README 和 6 张宣传图 SVG 复制进本机插件运行目录（`RUNTIME_FILES` 从 `72` 降至 `64` 文件 / 省 `112 KB`，仓库主页、合规声明与图标 `logo.svg` 完整保留）。
- **清理死代码并收口跨文件重复样板**：移除未引用的内部函数/常量与面板残留样式/词条，把 6 份重复的钩子基础逻辑直接并入必载的 `hooks/compile-cache.mjs`（零新增文件），把 5 份 `truncateUtf8Safe` 统一为 `context/lib/stable-json.js` 的完整 UTF-8 码点边界实现（核心代码净减 `429` 行，行为零漂移）。

### v1.9.0
- **对齐 Gemini 4 95% 缓存折扣与分档计价**：更新了 Gemini 4（含 Carbon/Argon、Neon、Hydrogen 变体）的 95% 缓存折扣、4,096 token 起步门槛和 2,050 token 增量判断，账本和成本估算更准、不再误报缓存失效；同步识别 Carbon/Neon 默认高推理档位，并提高自动续温的划算门槛。
- **聊天里直接看交互式诊断卡片，工具返回更省字数**：在 Antigravity `v2.34.0+` 桌面端运行 `ctx_stats` 或 `ctx_doctor` 时，聊天区会直接渲染一张自带刷新按钮、自动跟随深浅色的诊断卡片，同时只给模型传极简摘要；在命令行/IDE 端则保持零额外开销的紧凑 JSON 输出。`v2.35.1+` 还支持克制的 `sidecar://agy-dart/dashboard/` 一键直达右侧面板。
- **历史对话再多也不卡（接入本地 `ConversationService` 接口）**：卡死监控和右侧面板优先通过本机回环接口直查对话的归档、子助手和运行状态，老版本自动平滑退回到带缓存和预算封顶的本地扫描，聊成百上千个窗口也不会拖慢速度。
- **分段读文件更准、`/swarm` 协作不打架、钩子更轻快**：按行分段读大文件现在先算实际截取的大小再决定放行，顺带直接放行 `.heic`/`.avif`/`.amr`、PDF 按页读取和更多官方规则/技能文件；精准识别 `/swarm` 并行子工位（不误清主窗口状态）；精简 `PostToolUse` 去掉纯读取触发、`fast` 验证结果直写恢复点，并同步对齐了 `310s` MCP 超时、协议协商、内置子助手预载声明与新版 `cache-audit` 体检。

### v1.8.2
- **读单个大文件彻底躲开后台云端审查，开场更省字数**：AI 看单个大文件时，插件先免费递上带行号的目录，再让 AI 直接用 Antigravity 自带的分段读文件功能（完全不触发后台云端审查，不再绕弯调插件工具）；只有同时读多个文件、批量搜代码或一次改多个文件时才合并打包，并顺手精简了自带规则，开场再省一点额度。
- **后台偷烧新增桌面弹窗，换新对话只要 2 步**：面板新增「**偷烧弹窗提醒：关/开**」（默认关闭，开启后每 15 分钟最多提醒一次防刷屏），一旦检测到后台正在狂烧或连续报 429 立刻弹窗提醒；进度条旁也加了大白话提示，对话太长时顺手提醒你适时换窗省额度；点「**整理进度，换新对话**」会自动复制交接摘要，照着 2 步提示贴进新对话就能接着干。
- **修好后台偷烧偶尔漏算字数的问题**：如果一次耗时的后台重审正好跨了两次统计刷新，以前偶尔会把字数记成 `0` 或漏记原因，现在能完整接上，账目不再算漏。

### v1.8.1
- **面板里的「后台偷烧」卡片全改成大白话**：去掉难懂的英文和原始数字——最上面置顶「现在怎么做」操作指引，耗时换算成 `14 分 15 秒`，Token 换算成「万」，触发原因全汉化，按钮也改成直观的「整理进度，换新对话」和「复制排查证据（已去隐私）」。
- **修好窄侧边栏挤版和状态区分**：解决侧边栏拉窄时标题折成三行、标签被截断、摘要重复显示的问题；同时把「前 5 小时烧过但近 5 分钟已平稳（淡黄 `刚有偷烧 · 已平稳`）」和「此刻正在狂烧（红色 `正在偷烧额度`）」区分开，没重启丢记录时自动隐藏多余提示。

### v1.8.0
- **新增「后台偷烧额度」监测，重启也不丢账本**：自动读取 Antigravity 桌面端和命令行的本地日志，按分钟把后台审查记录存进本机，重启软件清空日志也不会丢现场。平时没异常时在面板安静收成一行；一旦出现连续 429 报错、反复重审大段对话，或快撞上 5 小时额度红线，面板自动展开提醒，支持一键换新对话或复制去隐私后的排查报告（命令行也可跑 `node bin/agy-dart.mjs audit safety` 查看）。
- **读项目外的大文件不再误招后台重审**：以前 AI 读当前项目以外的大文件时，插件会引导改用外部工具，容易误触发几十万字的后台重型审查；现在改为先递目录、再让 AI 直接用自带工具分段读，既省额度又躲开误审，换窗交接摘要也会提醒断开重审循环。
- **修好部分 Antigravity 版本发消息时崩溃的问题**：默认关闭往聊天框直接插提示横幅的做法，避开部分软件版本的崩溃问题；右侧面板的缓存倒计时、卡死监控和桌面弹窗照常工作。
- **修好新开对话偶发「找不到项目目录」的报错**：插件现在会自动记住当前打开的项目目录，切换项目窗口也会跟着刷新，不用每次手填路径；多窗口同时活跃、拿不准是哪一个时仍会安全拦住，防止跨项目改错文件。

### v1.7.8
- **新增可选的「自动更新」开关（默认关闭）**：面板顶栏加上了「**自动更新：关/开**」按钮。开启后，启动和每 6 小时会自动检查同大版本的新发布，验完安装包在后台静默升级；会自动避开正在进行的缓存续温，万一某个版本升失败也不会反复死磕，升完重载后会弹一次可关闭的提示。

### v1.7.7
- **新增支持 DeepSeek Harness（`--target dsh`）**：除了 Antigravity、Claude Code 和 Codex，现在也能一键装到 DeepSeek Harness，自动配好防盲读和日志瘦身，还能跑 `node bin/agy-dart.mjs dashboard` 在浏览器里单独打开监控面板；对 Antigravity 用户零影响，不多占任何额度。
- **已归档的对话自动暂停续温和提醒**：旧对话归档后自动停掉后台续温、手动预热和桌面弹窗，不再白花额度；以后取消归档会原样恢复，不丢状态。

### v1.7.6
- **面板新增一键在线更新**（感谢 [@bestmulicc](https://github.com/bestmulicc) 贡献，[#5](https://github.com/zou172866/Antigravity-agy-dart/pull/5)）：右侧面板打开时会自动检查有没有新版本，点顶栏「**检查更新**」/「**立即更新**」就能原地升级，不用再开终端敲安装命令（不想启动时检查也可在配置里关掉）。
- **升级先校验、失败自动还原，保留个人配置**：优先下载带完整性校验的发布包，遇到文件被占用会自动回滚恢复原版；升级完自动刷新面板，你本地自建的 `rules/*.local.md`、工具模式和同步副本都会保留。

### v1.7.5
- **面板新增一键「续温 1×」按钮**：缓存倒计时旁边可以直接手动点一次续温。就算平时关着自动续温也能随时点，而且不扣自动续温次数（防连点，发送失败也不白算）。
- **快过期时不白续，倒计时统一**：缓存只剩最后十几秒、来不及送达时会自动放弃续温以免白花 token，改弹桌面提醒；面板、后台监控和弹窗提醒统一用同一个倒计时，不再两边对不上。如果缓存其实已经失效，也会及时停手不再空续。

### v1.7.4
- **交接指令话术更自然**：点「复制给当前窗口的交接指令」时，中英文模板加上了更亲切的开头称呼（中文「宝宝，」、英文 `Sweetie,`），并让 AI 生成的交接单直接按同样开头起笔，依然只吐正文、不带废话。

### v1.7.3
- **自动续温支持自选间隔**：全局和单个窗口都能选 **动态（自动估算）**、**固定 4 / 9 / 15 分钟** 或 **自定义（1–60 分钟）**，单窗口改完点「随全局」即可恢复默认；原有的省钱保护（次数上限、对话太短不续、缓存失效即停、跳过后台子任务）照常生效。
- **修好测试超时误报和面板误判通过**：命令只是跑超时了，不再误报“AI 在反复改错”；只跑过无关测试或单个用例，不会盖掉之前失败的完整测试；后台测试报错后就算改了别的文件也不会漏掉；测试日志太长被截断、看不清哪条没过时，面板会一直提醒重跑，不会当成已通过。
- **换新对话更好交接，缓存失效原因更清楚**：换窗或压缩前可一键复制更干净的进度摘要（自动打码密钥和口令），面板也能更准确标出为什么没命中缓存。

### v1.7.2
- **给插件自带说明「瘦身」，新增 Skills 体检命令**：把示例脚本和排错手册拆成用到再读，平时不白占开场上下文；新增 `node bin/agy-dart.mjs audit skills`，一键查出本机所有已装 Skill 各自占了多少开场额度、有没有把大段资料全塞进主说明里。
- **自带的两个轻量子助手更省输出**：内置的改代码助手（`dart-coder`）和审查助手（`dart-reviewer`）继续保持轻装上阵（不额外背一堆工具和全局规则），现在跑快速检查也会自动精简输出，减少把超长日志直接倒进对话。

### v1.7.1
- **修好面板「已挡废话」一直显示 0 的问题**：以前按段读代码、批量搜代码、精简检查输出省下来的字数没记进面板，现在按实际省下的大小如实统计，多开窗口也不会算串或重复计数。
- **后台子任务省下的额度汇总到主对话**：存长文档、批量查资料以及子任务省下来的 token，现在统一归到主对话里展示，账目更准。
- **修好 Windows 下部分命令没被精简的问题**：像 `npm --prefix`、`pnpm -C`、`yarn --cwd` 以及带 `--` 参数的命令，现在在 Windows / PowerShell 下也能正常过滤刷屏日志。

### v1.7.0
- **拦住整篇硬读大文件时，顺手把目录递给 AI**：AI 第一次想整篇读大代码文件被拦下时，插件会直接附上一份带行号的函数和类清单，AI 不用再多问一轮目录，直接挑要看的那几行去读。
- **新增统一命令行工具，支持装到 Claude Code 和 Codex**：用 `node bin/agy-dart.mjs` 可安装到 Antigravity、Claude Code 或 Codex，还能直接查看代码大纲、对比不同对话花了多少 token；同时内置了轻量的改代码 / 审查子助手，并加强了多项目隔离和 Node.js 环境检查。

<details>
<summary>展开查看更早版本更新记录（v1.1.0 – v1.6.0）</summary>

### v1.6.0
- **常用 4 个工具改为直连，修好多文件修改偶发丢内容**：把最常用的 4 个功能（批量搜、看大纲、改文件、跑检查）改成直接预载，避开以前偶尔把多文件改动清空的坑；另外 8 个处理大日志的工具继续用到再加载，省开场额度。
- **修好自动续温偶尔失效，后台子任务不再乱续温**：更新插件后后台面板会自动重启，不再被旧进程卡住；`/boost`、浏览器、工作流派出去的后台子任务和已经关掉的旧对话，一律不再发续温请求，也不再挤占面板顶部状态栏。
- **后台子任务读文件直接放行，防止 AI 误改插件自身**：子任务读大文件或重读文件不再弹红字卡住；漏传路径误落进插件安装目录时直接拦住，防止误搜或误改插件自身。
- **支持终端一行命令直装**：不用手动克隆仓库，复制一行 PowerShell 或 Shell 命令就能装好。
- **其他优化**：短检查省下的输出额度会自动让给真正报错的长堆栈；限制 Git 只读查询，防止陌生仓库偷跑外部命令；修好 Windows 退出卡死；升级保留个人规则（`rules/*.local.md`），补齐安全说明与深浅色架构图。

### v1.5.4
- **点击提醒直达对应会话**：点右下角弹窗或右侧面板里的跨窗口告警，自动切出对应项目窗口并跳进那段对话；面板新增多窗口会话切换栏。
- **按需续温**：开启后，主对话会在缓存快到期前发送续温请求；面板可调整每段对话的次数，发新消息后重新计数。
- 把当前上下文用量、缓存倒计时和已拦废话量放大移到面板第一栏。

### v1.5.3
- **多窗口弹窗标明项目与对话标题**：右下角提醒和面板告警直接显示目录名（如 `work/agy-dart`）与会话短标题，不露聊天正文。
- **上下文快满了弹窗提醒**：接近上限时右下角提醒一次，跑完 `/compact` 自动重置。

### v1.5.2
- 加快读文件与新对话启动；支持提取几千行 `.html` / `.astro` 和 `.dart` 的代码目录；修 Windows 下 Python / PowerShell 中文乱码，面板切后台自动停刷。

### v1.5.1
- 补全中文面板漏译词；调准文件修改后的拦截建议。

### v1.5.0
- **读取模型实际缓存过期时间**：按近期使用记录读取当前模型的实际缓存过期时间（如 5 分钟或 15 分钟），新开对话直接沿用。
- 新增可选的缓存临期桌面提醒（过期前 1 分钟弹窗），命令行加入自动续期成本测算。

### v1.4.0
- **卡死检测与抢救摘要**：后台发现对话长时间转圈不出字时（避开长打包和电脑休眠），面板标红指出卡在哪一步，并自动生成进度摘要（改过的文件、最后执行的命令、当前步骤），可一键复制去新对话继续。

### v1.3.1
- 跑完 `/compact` 压缩后立即可重读文件；读 4 KB 以下的小段代码免拦截；长报错日志额外保留中段报错行。

### v1.3.0
- **分档放行读文件**：普通代码放宽到 45 KB（800 行）、`.patch` 补丁放宽到 128 KB 直读，刷屏日志维持 16 KB 拦截；超限重试一次放行，审补丁和子代理不再卡住。
- 支持列出 `.patch` 改动目录，精简 `git diff` 时保留上下文行。

### v1.2.2
- **长任务不断流**：去掉中途催用户 `/compact` 的旧规则，超过 1 分钟的测试、打包和后台服务直走原生后台通道。
- 挡住误读 `.env`、修 Windows 特殊符号与残留子进程等 42 项问题。

### v1.2.1
- 多文件同时修改出错自动回滚，修路径与命令参数等 76 项稳定性问题。

### v1.2.0
- 配置统一存进 `~/.agy-dart/config.json`；本地面板接口加安全校验；**超大 JSON 自动提取结构、首尾样本与报错项**；新增 `gh`、`kubectl`、`terraform`、`playwright` 输出精简与交接摘要。

### v1.1.0
- **终端输出自动瘦身**：自动清掉 `git`、测试、打包、安装命令里的进度条和刷屏内容，原文存本地备查。
- 同文件未改动防重复读取；AI 反复改错原地打转时给出界面提示；抓网页时禁止访问本机和内网地址、日志密钥自动打码、面板一键清理旧数据。

</details>

---

## 在其他 AI 工具里使用（CLI 命令行）

`node bin/agy-dart.mjs` 默认装到 Antigravity，也可以加上 `--target` 装到其他工具（安装时会自动记一份还原清单在 `~/.agy-dart/` 里，以后卸载能干净恢复原样，不会弄乱你原来的配置）：

```bash
node bin/agy-dart.mjs install                        # 装到 Antigravity（默认）
node bin/agy-dart.mjs install --target dsh           # 装到 DeepSeek Harness（可选 --profile <名称> 或 --mcp-only）
node bin/agy-dart.mjs install --target claude        # 装到 Claude Code
node bin/agy-dart.mjs install --target codex         # 装到 Codex
```

几个顺手的命令行小工具：

```bash
node bin/agy-dart.mjs dashboard                      # 在浏览器里单独打开监控面板
node bin/agy-dart.mjs audit safety                   # 查最近有没有后台“偷烧额度”
node bin/agy-dart.mjs audit skills                   # 体检本机已装 Skill 各自占了多少开场额度
node bin/agy-dart.mjs outline <文件>                 # 查看大文件的函数/类目录（带行号）
node bin/agy-dart.mjs session <ID>                   # 看某次对话花了多少 token
node bin/agy-dart.mjs compare <前> <后>              # 对比两次对话的消耗
```

---

<details>
<summary><strong>开发者本地自检（改插件源码后用）</strong></summary>

```bash
npm test                                           # 跑全套测试
npm run verify:pkg                                 # 检查安装包文件完整性
npm run prefix:budget                              # 估算 Antigravity 首轮占用与全量工具占用
npm run brief:check                                # 检查 AI_REVIEW_BRIEF.md 里的行数和测试数是不是最新的
node scripts/cache-audit.mjs --workspace . --no-live
node bin/agy-dart.mjs audit skills --workspace .   # 检查本机已装 Skills 的开场上下文占用和文件拆分情况
npm run cache:simulate
```

改了源码文件或增删测试后，记得顺手同步下面三处，不然本地自检会报错：
- **打包清单**（`scripts/install.mjs`）：新增或删除文件后，同步改 `RUNTIME_FILES`（默认安装的文件）或 `DEVTOOLS_FILES`（加 `--with-devtools` 才装的文件），否则 `npm run verify:pkg` 会拦截。
- **测试总数**（`tests/v1.2-hardening.test.mjs`）：增删用例后，把里面写死的 `computeBriefMetrics(ROOT).testCases` 数量改成和 `npm test` 一致。
- **审阅简报**（`AI_REVIEW_BRIEF.md`）：改完核心代码或测试后，跑一遍 `node scripts/gen-review-brief.mjs --write` 自动更新行数和测试数，再用 `npm run brief:check` 确认通过。

</details>

---

## 致谢与开源协议

感谢 `INK-Q/agy-fast` 的贡献者。批量编辑会在写文件前校验验证命令，搜索长行时会围绕命中位置截取片段，检查失败时会保留长日志的首尾。这三处实现都借鉴了该项目。[对应的上游源码与许可说明](THIRD_PARTY_NOTICES.md#11-ink-qagy-fast-mit-license)

`daoif/tokless` 为 v1.7 的代码大纲、读取大文件时的大纲提示、分角色工具权限、会话用量对比和多宿主安装提供了参考。结构化日志压缩借鉴了 `headroomlabs-ai/headroom` 的 SmartCrusher，定期清理过期数据的思路来自 `antigravity-panel`。[设计来源与本地实现](THIRD_PARTY_NOTICES.md#additional-design-references)

[MIT 协议](LICENSE) 开源。部分代码整合改造自同为 MIT 协议的 [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) 与 [Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)，完整第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## Star History

<a href="https://www.star-history.com/?repos=zou172866%2FAntigravity-agy-dart&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
  </picture>
</a>
