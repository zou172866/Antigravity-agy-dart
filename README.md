<div align="center">

[简体中文](README.zh-CN.md) · **English**

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**Google Antigravity plugin — Save tokens · Improve cache hits · Keep cache warm on demand · Catch silent background quota burn · Rescue stalled chats**

Zero extra dependencies · Works automatically in the background · Built-in right-sidebar dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
[![Node.js 22.16+ (22.x) or 24+](https://img.shields.io/badge/Node.js-22.16%2B_(22.x)_or_24%2B-38bdf8.svg)](package.json)
[![Security Policy](https://img.shields.io/badge/Security-Policy-818cf8.svg)](SECURITY.md)
[![Glama MCP](https://glama.ai/mcp/servers/zou172866/agy-dart/badges/score.svg)](https://glama.ai/mcp/servers/zou172866/agy-dart)
[![Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-dart.json)](https://github.com/zou172866/repo-traffic-archive)

[How to Install](#how-to-install) · [Changelog](#changelog) · [Security](SECURITY.md) · [Third-Party Notices](THIRD_PARTY_NOTICES.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/architecture-light.svg" />
    <img alt="agy-dart architecture" src="assets/architecture-dark.svg" width="860" />
  </picture>
</p>

<p align="center">
  <img alt="Before vs With agy-dart comparison" src="assets/demo-comparison.svg" width="860" />
</p>

---

## What does this plugin do?

`agy-dart` is a token-saving, cache-watching, and session-rescue plugin built for **Google Antigravity** (also supports DeepSeek Harness, Claude Code, and Codex via `--target`).

Once installed, it runs quietly in the background — **no new commands to memorize, just chat and code as usual**:

### 1. Combine small steps into fewer turns
When the AI needs to search several terms, it runs them in one batch; when it edits multiple files, it edits them together and runs checks in the same step instead of resending your entire chat history turn after turn.

### 2. Block noisy output & read large files smartly
If a test run dumps 3,000 lines of logs, the plugin passes only the key failure lines to the AI (e.g., line 42 failed, the other 199 passed) and keeps the full log locally for lookup. On huge code files, it hands over a line-numbered outline first so the AI reads only the lines it needs.

### 3. Monitor cache & keep it warm on demand
The plugin keeps the controllable start of each request steady and cuts down repeated reads of unchanged files; actual cache hit rates still depend on how Antigravity builds requests and how the backend caches them (if you use a dynamic rotating proxy, pinning a single exit node is a useful controlled check). Automatic warming and expiry desktop alerts start off; once enabled, the default limit is 1 warm-up per chat until your next message, and both the count and interval can be changed in the panel.

### 4. Right-sidebar dashboard & crash/hang rescue
See at a glance how much context space is left, how many minutes until cache expiry, and how much noise has been blocked. With multiple project windows open, if a background chat runs low on context or gets stuck spinning with zero output, a desktop alert names that project and chat — click it to jump right there. If a chat stalls or hits the limit, copy a progress summary in one click and continue in a fresh chat.

### 5. Catch silent background quota burn (Safety Monitor)
Antigravity can occasionally re-review long chats in the background and quietly burn through your 5-hour quota or trigger 429 errors. The plugin watches local logs automatically (and keeps history even if a restart wipes the log): when everything is calm it stays collapsed to one quiet line; if a burn burst or quota cliff hits, the panel expands in plain language and gives you a one-click **Pack Progress & New Chat** button to stop the bleed.

### Other built-in features
1. **Keep your place after `/compact`**: Tracks modified files, latest test/build status, and saved reference IDs in the background so the AI picks right back up after compacting.
2. **Local search for long docs & web pages**: Saves multi-thousand-word docs or web pages locally by section and pulls only matching snippets by keyword.
3. **Filter huge logs & tables locally first**: On multi-MB logs, CSVs, or huge JSON dumps, the AI runs a quick local script to summarize (e.g., top 5 failing endpoints) and brings only the answer into chat; big JSON blobs automatically surface error rows.
4. **Workspace map on new chats**: Gives the AI a compact folder layout, script list, and core-file overview as soon as a new chat starts.
5. **Loop warnings**: Shows a UI-only note (never injected into model context) when the AI gets stuck in `edit → fail → revert → fail` cycles.
6. **Secret masking & sensitive-file protection**: Masks API keys and tokens in logs or web pages, blocks accidental reads of `.env` files when configured, and stops untrusted Git configs from running external commands.
7. **Keep tool replies under 8.8 KB**: Antigravity spills tool replies above ~10 KB into a temp file that costs an extra read turn; the plugin stays inside 8.8 KB and shifts leftover space from short passing checks to real error stack traces.
8. **Usage breakdown, inline diagnostic cards & one-click updates**: Inspect how much context goes to file reads, terminal output, or subagents, view 15-turn cache trends, see interactive inline cards when running `ctx_stats` / `ctx_doctor` (with one-click jump pills to open the side panel on Antigravity `v2.35.1+`), update right from the panel top bar, or replay past chats via CLI to estimate cache hits and warming cost.
9. **Plays nicely with your Skills + Skills & Quota Audits**: Your Skills handle workflows while `agy-dart` quietly guards file reads, trims logs, and watches cache underneath; run `node bin/agy-dart.mjs audit skills` to inspect Skill startup tax or `node bin/agy-dart.mjs audit quota` (with `--mark-gemini <pct>` / `--mark-claude-gpt <pct>` and `--calibrate-baseline`) to separate 1× work by model pool, `#1890` 4× custom-agent calls, and `#1886` background reviews.

> Antigravity updates frequently — click **Star** at the top right to follow compatibility updates.

---

## How to Install

Requires **Node.js 22.16+ (22.x) or Node.js 24+**. Zero third-party packages — the installer checks that Node's built-in SQLite search engine (FTS5 with trigram) is ready.

### Option 1: One-line terminal install (no clone needed)

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.10.4/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.10.4/install.sh | sh
```

### Option 2: Let Antigravity install it

Send this to Antigravity:

```text
Clone tag v1.10.4 of https://github.com/zou172866/Antigravity-agy-dart.git to a temp folder, run `node scripts/install.mjs install` (add `--install-rg` on Windows if `rg` is missing), and confirm `doctor` passes.
```

### Option 3: Clone & install with custom flags

```powershell
git clone --branch v1.10.4 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
cd Antigravity-agy-dart

# Windows PowerShell (optional -InstallRg auto-installs ripgrep)
.\install.ps1 -InstallRg

# macOS / Linux
./install.sh
```

**Other commands:**

```bash
node scripts/install.mjs install                        # Global install (auto-syncs GEMINI_HOME & T3 ACP if present)
node scripts/install.mjs install --project /repo/path   # Single-project install
node scripts/install.mjs doctor                         # Check install health
node scripts/install.mjs uninstall                      # Uninstall
```

Restart or reload Antigravity after installing and open a new chat. Your own `rules/*.local.md` files are preserved across upgrades. If you previously installed standalone `agy-fast` or `antigravity-plugin-context-mode`, disable the old ones in your plugin list.

Saved document indexes and usage history live locally in `~/.agy-dart/context.db` and stay intact on uninstall. To clear the current chat's index before uninstalling, call `ctx_purge` (when the host omits a session ID, this clears unattributed data for the current workspace); pass `scope: "all"` to wipe all projects. Global uninstall also removes installer-tracked Gemini/T3 copies and lists any older untracked copies with a dedicated removal command instead of deleting blindly.

---

## Settings

Everyday switches live right in the **agy-dart Context** side panel:

- **Auto-Keepalive (off by default)**: Turn it on for the current chat in the panel, or click **Warm 1×** next to the countdown anytime for a single manual ping. Use **Global Warm** to set the default count and schedule (**Auto**, **Fixed 4 / 9 / 15 min**, or **Custom 1–60 min**). Turning warming off for a chat also silences its expiry and limit alerts.
  > Note: Each warm-up asks the model for a short `OK` reply and uses input tokens (or the full conversation if the cache already expired).
- **Desktop alerts (off by default)**: Cache expiry, stalled-chat alerts, and background quota burn alerts (**Burn Alert: OFF/ON**) all start off and can be toggled individually.
- **One-click & automatic updates**: Click **Check Update** / **Update Now** in the top bar anytime, or toggle **Auto-Update: OFF/ON** (off by default) for silent same-major upgrades.
- **Other panel controls**: Pause protection, clear old local data, and adjust file-size limits directly in the panel.

Preset read limits & tool-loading modes via CLI:

```bash
node scripts/install.mjs mode host-45k              # Default: direct read up to 45 KB code / 128 KB patches, block >16 KB noisy logs
node scripts/install.mjs mode balanced-16k          # Outline first above 16 KB
node scripts/install.mjs mode fast-32k              # Raise normal file limit to 32 KB
node scripts/install.mjs mode strict-8k             # Block above 8 KB
node scripts/install.mjs mode no-read-hook          # Never block file reads, only trim noisy terminal output

node scripts/install.mjs tool-loading fast-eager    # Default: 4 fast tools eager, 8 context tools lazy
node scripts/install.mjs tool-loading lazy          # All 12 tools lazy-loaded
node scripts/install.mjs tool-loading eager         # All 12 tools eager-loaded
```

<details>
<summary>Troubleshooting: <code>ide-tools</code> duplicate <code>/required</code> schema error</summary>

If Antigravity fails during toolbox initialization with `building toolbox: tool "mcp_ide-tools_mcp_agy-dart_fast_apply_edits" advertises an invalid parameter schema ... at '/required': items at 1 and 2 are equal`, the host's `ide-tools` bridge is duplicating `toolSummary` in `/required`. Switch to lazy loading and restart Antigravity:

```bash
node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy
```

(Or remove `"tools"` / `"eager": true` under `mcpServers.fast` in `~/.gemini/config/plugins/agy-dart/mcp_config.json` and restart. See [skills/agy-dart/references/error-playbook.md](skills/agy-dart/references/error-playbook.md) for diagnostics.)

</details>

---

## Changelog

### v1.10.4
- **Sticky check-guidance banner & duration-suffix normalization**: Uniformly strips trailing `outputMode: "full"` duration suffixes (`(136ms)` / `(1.2s)`) across `cache-analyzer.js`, `hooks/post-tool-use.mjs`, `checkpoints.js`, and the Sidecar UI without stripping non-duration labels (e.g. `(v2)`), preventing re-runs with different durations from stranding unresolved failures.
- **Ad-hoc read-only `run_checks` probe filtering & compound / PowerShell 5.1 fail-fast resolution**: Prevents pure read-only/ad-hoc inspection probes (`git status/show/log/remote -v/tag -l` and inspection-chained inline probes) from permanently sticking red while preserving real verification gates (`agy plugin validate`, `node --check`, `npm run doctor`, `git diff --exit-code/--check`, mutating `git tag`/`branch`, downstream pipe/`xargs` verifiers, and filter regex errors). Anchors compound `&&` and Windows PowerShell 5.1 fail-fast chains (`if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` / `if ($LASTEXITCODE -eq 0) { ... }`) on matching verification clauses while rejecting `exit 0`, bare `exit`, `||`, unguarded `;`, and filter-pipe bypasses, and avoids 140-char checkpoint `checkKey` truncation.
- **Cross-workspace Sidecar binding & workspace checkpoint hygiene**: Prefers live URL `conversationId` over frozen `preload.js` state, detects workspace mismatches on `onWorkspaceChange` / cold start / Watchdog updates to unbind or follow the new workspace cleanly (with `/api/stats` unbound isolation, queued state-switch refreshes, and standalone auto-follow), enables safe parent-workspace fallback in `resolveUniqueActivePrimarySessionForWorkspace` (blocking competing subagents and shallow home/tmp ancestors), and adds a 6-hour TTL for stale failures on anonymous `workspace:*` checkpoints.

### v1.10.3
- **Quota attribution & `#1890` 4× sentinel CLI (`node bin/agy-dart.mjs audit quota` / `npm run quota:audit`, devtools-only, 0 Turn-0 overhead)**: Unifies three attribution layers offline—(1) `#1890` custom-agent 4× invocation & transitive descendant lineage audit against the official 1× built-in allowlist (including `/boost` workers) + on-disk `agents/*.md` scan; (2) `#1886` background safety-monitor attribution; (3) multi-session 1× equivalent USD billing split by Antigravity weekly quota pool (`gemini` vs `claude-gpt`, with `CHECKPOINT` model inheritance), dual-pool checkpoints (`--mark-gemini` / `--mark-claude-gpt`), and persistent per-pool personal 1× baselines (`--calibrate-baseline` / `--set-baseline-gemini` / `--set-baseline-claude-gpt`) so different tiers and pools neither false-alarm nor miss real 4× jumps.
- **Sidecar host-liveness auto-exit (`#1663`)**: Added shared byte-identical `sidecars/dashboard/host-liveness.mjs` (dual PPID + exclusive loopback bind probe, grace window, alive-observation gate, `AGY_DART_DISABLE_LIVENESS_GUARD=1` kill-switch) and upgraded `shutdownCleanly` to wait up to 15s (500ms polling) for in-flight updates or keepalives before closing cleanly.

### v1.10.2
- **Short-gap cold-cliff diagnostics (`#1665/#1720`)**: Added pure `shortGapColdSummary` to `cache-analyzer.js` (including multi-session aggregation and EN/ZH Markdown & Dashboard diagnostics) without altering `bustsByCause`, `driftBreakdown`, or `ttlObservations`.
- **Pre-emptive auto-keepalive short-cliff guard**: Added B-lite cross-session cold-trip meta helpers (`recordKeepaliveColdTrip` / `getRecentKeepaliveColdTrip`, zero DDL changes) and Watchdog pre-emptive auto-keepalive pause (`short_cliff_churn`, preserving `usedCount` and leaving manual 1× warming unblocked with a `short_cliff_churn` warning).

### v1.10.1
- **Removed bundled custom agents (`#1890` 4× quota protection)**: Removed `agents/dart-coder.md` and `agents/dart-reviewer.md` (plus cleaned `package-manifest.json`, `package.json`, and `verify-package-graph.mjs`) so Antigravity `1.5.17+` sessions never accidentally trigger the 4× custom-agent quota multiplier; use the default main session or built-in `self` / `research` (1× standard quota) instead—all `agy-dart_fast` and `agy-dart_context` MCP tools work automatically.
- **Custom-agent 4× quota audit in `scripts/cache-audit.mjs`**: Added `auditCustomAgents()` scanning workspace (`.agents/agents`, `.gemini/agents`, `.agent/agents`, `.agents/plugins/*/agents`) and global/plugin `agents/*.md` with `workspace` vs `global` scope tagging (`--workspace-only` aware); active custom agents emit `warn` (`custom_agent_quota_multiplier`), while frontmatter `DEPRECATED` transition placeholders downgrade to `info` (`deprecated_custom_agent_placeholder`).

### v1.10.0
- **Faster hooks, LRU history cache & SQLite auto-compaction**: Split `watchdog-lease.js` into a zero-FS/zero-SQLite hot-path core (`watchdog-lease-core.js`) plus lazy `watchdog-transcript.js` and `watchdog-summaries.js` (upgraded to true O(1) LRU lookup cache); added SQLite freelist fragmentation diagnostics (`getStorageHealth`, surfaced in `ctx_doctor` & Sidecar), lossless **Compact DB** action (`vacuum_only`), threshold-gated idle auto-`VACUUM` (`>= 4 MiB` & `>= 25%` reclaimable, 24h cooldown), and raised idle Sidecar backend reload polling from 3s to 10s.
- **Core backend modularization (100% backward-compatible)**: Decomposed `cache-analyzer.js` (`cache/transcript-locator.js`, `cache/usage-normalizer.js`), `watchdog.js` (`watchdog-notify.js`, `watchdog-keepalive.js`), and `sidecars/dashboard/server.mjs` (`http-helpers.mjs`, `http-security.mjs`, `update-coordinator.mjs`), deduplicating `getHeader` across update modules.
- **Modular Sidecar UI, tightened CSP & UX polish**: Split the 13,479-line `sidecars/dashboard/index.html` into semantic HTML + 6 native `/ui/*` static assets (`styles.css`, `theme-init.js`, `i18n.js`, `search-state.js`, `theme-nav.js`, `app.js`) served with `nosniff`/`no-store` in both Standalone HTTP and `SidecarApp`, tightened standalone HTML CSP (`default-src 'self'; base-uri 'none'; frame-ancestors 'none'`), eliminated 1px resize layout thrashing in the section-jump `ResizeObserver`, slimmed the narrow (`<= 390px`) sticky topbar, surfaced `env`/`config.json` override badges across all core controls (Cutoff, CLI Filter, Read Dedup, Stall Guard, Global Warm) + reclaimable DB fragmentation UI, and added `pagehide`/`pageshow` lifecycle recovery.
- **Sharper Turn-0 budget & workspace-focused cache audits**: `scripts/prefix-budget.mjs` now also measures live MCP `initialize.result.instructions` and `agents/*.md` discovery metadata (`estimatedTokensWithMetadata`); `scripts/cache-audit.mjs` now tags every finding with `scopeGroup` (`workspace` vs `global`), summarizes `findingsByScope`, and adds `--workspace-only` for zero-noise single-project audits.

### v1.9.4
- **Full v1.9.3 audit remediation (all 23 findings resolved — 2 P1, 18 P2, 3 P3)**:
  - **Multi-host installer integrity & concurrency**: Codex installer rejects closed inline `mcp_servers = {}` / conflicting tables before writing; DSH uninstall preserves user-appended/prepended YAML list items and tracks multiple profiles so shared runtime is retained until all profiles are removed; `scripts/targets/index.mjs` upgrades `targets.lock` with token metadata, fresh-lock grace window, `EPERM` handling, and race-safe `.reclaim` stale-lock recovery.
  - **Declarative packaging & atomic self-update**: Extracted `scripts/package-manifest.json` (`schemaVersion: 1`) as the single source of truth for `install.mjs`, `verify:pkg`, and `version-update.mjs`; pinned approved release asset URL & SHA-256 across auto-update cycles (never downgrading to source tarball); made secondary-host sync atomic with reverse rollback and user-file preservation; tightened legacy parser & zero-devtools fallback.
  - **Protocol, logging, security & cache accuracy**: Enforced strict `<= 8,800 B` outer JSON-RPC wire cap on all `agy-dart_context` responses; preserved trailing root-cause errors in `cli-filter.mjs` overflow preview/FTS5/checkpoint; upgraded Safety Monitor incremental scanner to raw byte offsets (`committedOffset`) with split-UTF-8 safety and `parseStatus`; enforced shared wall-clock deadlines across multi-root history lookup and DNS validation (`validateFetchTarget`); added OS/toolchain child-process env allowlist + hard secret filtering (`execEnvAllowlist`); reduced Watchdog idle `config.json` stats (`1,440 → <= 40` / 40 ticks) via `withConfigSnapshot()`; unified keep-alive simulator endpoint scheduling and Gemini 4 2,050-token tail reprocessing (`$0.031854` / Carbon 120K ping).
  - **Dashboard UX, accessibility & governance**: Invalidated pending read cache on cancelled/failed reads; fixed out-of-order search/inspect responses with shared request sequence; fixed MCP App card shrink height & teardown RAF cancel; raised Catppuccin Mocha placeholder contrast to WCAG AA (`#7f849c`); localized region `aria-label`s in Chinese; surfaced `config.json`/`env` cutoff override provenance in `/api/cutoff`, `/api/stats`, and UI badge; expanded `AI_REVIEW_BRIEF.md` to 55/55 full source coverage and updated `SECURITY.md` (`1.9.x` / `1.8.x`).

### v1.9.3
- **Catppuccin Mocha dark theme & zero-flash startup (thanks `@Ansg2022` in #8)**: Added a full Catppuccin Mocha dark theme to the Sidecar dashboard with automatic system-preference detection, left-click Light/Mocha toggle, right-click or `Shift+Click` / `Shift+Enter` reset back to system theme, and an inline `<script data-theme-init>` FOUC guard so dark mode loads with zero white flash.
- **Card hierarchy polish & topbar section quick-jump**: Refined Sidecar card surfaces and borders for clear visual hierarchy, and added a sticky topbar section quick-jump pill bar with active scroll-spy tracking, bottom-pinning protection against accidental jumps, full narrow-sidebar wrapping (`300px–820px` verified in headless Edge), and `beforeunload` resource cleanup (`tests/dashboard-theme.test.mjs`).

### v1.9.2
- **MCP Apps diagnostics card safety & UX hardening**: Fixed `ctx_stats` Refresh button to stay strictly read-only (`reset: false`, never replaying `reset: true`), wired `ctx_doctor` Safety Monitor alerts to display real `diagnosis` + `recommendedAction` text, enforced `event.source === window.parent`, strict host CSS variable allowlist + `background-color` (blocking `url(...)` / internal overrides), `ui/resource-teardown` cleanup, and strict SEP-1865 `mimeTypes` negotiation in `context/server.js`.
- **Loopback `ConversationService` & unlimited-history SQLite hardening**: Added loopback IP verification on `localhost` DNS lookups, a hard wall-clock total request deadline (preventing slow-drip bypass), strict HTTP 200 contract/ID validation, and shared 60s unsupported-endpoint backoff on Sidecar keepalive sends. Fixed `conversations_fts` archive detection past row 32, enforced shared lock deadlines without negative-cache poisoning on transient `SQLITE_BUSY`, added atomic CAS lease deletion (`deleteWatchdogLeaseIfUnchanged`), WAL-aware transcript scan invalidation, index-aware recent-ID SQL, and streaming `opendirSync` directory scans.
- **Read-guard, batch-edit checkpoints, simulator & multi-host upgrade fixes**: Required exact full measurements before unlocking wide line ranges on >2 MiB files, passed structured `apply_edits(verify)` results directly so failure checkpoints persist even when 50-file outputs truncate at 8.8 KB, aligned `cache-simulator.js` with Gemini 4's 2,050-token tail-reprocess rule, pruned retired README/SVG files when upgrading shared DSH/Claude/Codex runtimes, updated self-update fallback manifests (`dsh/` + `assets/logo.svg` only), restored standalone single-file `fast/session-start.mjs`, normalized lone UTF-16 surrogates consistently in `truncateUtf8Safe`, and aligned `cache-audit` Markdown totals. _(Watchdog policy note: un-suffixed `gemini-4-carbon`/`neon` intentionally remain in the protective 600s high-reasoning tier to prevent false stall alerts during extended thinking; explicit `-low`/`-medium` suffixes stay on the standard tier.)_

### v1.9.1
- **Leaner startup prompt & on-demand skill docs (zero feature cuts)**: Trimmed `rules/AGENTS.md` and `agy-dart_context` tool descriptions to cut default Turn-0 startup overhead (`~1,344 → ~1,287` tokens; full catalog `1,956 → 1,883` tokens), and tightened `SKILL.md` + `error-playbook.md` to save **~3,278 tokens (-36%)** whenever troubleshooting docs are loaded on demand.
- **Smaller installed footprint**: Stopped copying GitHub-only `README` files and 6 architecture/comparison SVGs into the local plugin install directory (`RUNTIME_FILES` slimmed from `72 → 64` files / `-112 KB`, while keeping all repo docs, `LICENSE`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, and `assets/logo.svg` intact).
- **Dead-code cleanup & shared helper consolidation**: Removed unreferenced internal functions/constants and unused dashboard CSS/i18n entries, consolidated 6 copies of hook stdin/session/path boilerplate into already-loaded `hooks/compile-cache.mjs` (zero extra files), and unified 5 copies of `truncateUtf8Safe` into the exact U+FFFD-preserving implementation in `context/lib/stable-json.js` (`-429` core lines, zero behavior drift).

### v1.9.0
- **Gemini 4 95% cache & pricing alignment**: Updated cache savings math, per-variant pricing (Carbon/Argon, Neon, Hydrogen), minimum cacheable threshold (4,096 tokens), and multi-turn delta checks (2,050 tokens) for Gemini 4 so cost and hit-rate estimates stay accurate without false cache-miss warnings; also recognized Carbon/Neon default high-reasoning tiers and raised the keepalive ROI floor.
- **Interactive inline diagnostic cards & leaner MCP replies**: On Antigravity `v2.34.0+` UI hosts, `ctx_stats` and `ctx_doctor` now render a self-contained inline card right in chat (auto-following light/dark theme with a built-in Refresh button) while sending a compact summary to the model; CLI/IDE hosts stay zero-overhead with single-line compact JSON. Also added a one-click side-panel link (`sidecar://agy-dart/dashboard/`) on `v2.35.1+`.
- **Stays fast with unlimited chat history (`ConversationService` API)**: Watchdog and the side panel now query Antigravity's local `ConversationService` API first (strict loopback-only) to check archived, subagent, and active-run states directly, falling back cleanly to bounded SQLite/directory scans with LRU caching so performance never degrades as history grows.
- **Smarter file slicing, `/swarm` isolation & lower hook overhead**: Ranged reads now measure actual slice bytes before blocking and pass through `.heic`/`.avif`/`.amr`, PDF page slices, and official skill/rule/agent files automatically; `/swarm` workers are isolated cleanly from primary chats without resetting active windows; trimmed read-only tools from `PostToolUse`, wrote `fast` verification checkpoints directly, aligned MCP timeouts (`310s`) / protocol negotiation / built-in subagent eager configs, and upgraded `cache-audit` for `.agents/` layouts and eager-vs-lazy token budgets.

### v1.8.2
- **Single-file reads now skip background cloud checks completely (+ leaner startup prompt)**: When reading a single large file, the plugin hands over a free outline and sends the AI straight to Antigravity's built-in ranged file reader (zero background cloud reviews) instead of detouring through a plugin tool; multi-file reads, searches, edits, and checks still batch together, and the built-in rules were trimmed further to save tokens on Turn 1.
- **Optional desktop alert for active quota burn & 2-step new-chat handoff**: Added an opt-in **Burn Alert: OFF/ON** toggle on the dashboard card (off by default, 15-minute cooldown) that pops up as soon as active background burn or 429 spikes start; added a plain-language quota-saver tip next to the Context bar for long chats; clicking **Pack Progress & New Chat** now copies your handoff brief automatically and shows a quick 2-step paste guide.
- **Fixed occasional missing character counts in burn stats**: Heavy background reviews that straddle two dashboard refresh ticks now keep their full character count and trigger reason instead of occasionally recording `0`.

### v1.8.1
- **Plain-language Safety Monitor card**: Rewrote the background quota-burn card into clear, everyday wording — put a **"What to do now"** box at the top, formatted waits like `14m 15s`, made trigger labels readable, and renamed actions to **Pack Progress & New Chat** and **Copy Evidence (Redacted)**.
- **Fixed narrow-sidebar layout & calmer status badges**: Fixed 3-line title wrapping, clipped badges, and repeated summary lines in narrow panels; softened past-5h bursts that have been quiet for the last 5 minutes from red to amber (`Past 5h · Calm`) and hid restart-log notes when no restart truncation happened.

### v1.8.0
- **Background quota-burn monitoring that survives restarts**: Watches local Antigravity Desktop and CLI logs automatically and saves per-minute history locally so restarting Antigravity never wipes the evidence. Stays collapsed to a single quiet line when healthy, and auto-expands with one-click new-chat handoff and redacted report copy if 429 spikes, heavy re-review bursts, or the 5-hour quota cliff appear (also available via `node bin/agy-dart.mjs audit safety`).
- **Reading files outside the workspace no longer triggers heavy re-reviews**: Large files outside your active project still get a free outline, but now route to built-in ranged reading (zero cloud checks) instead of nudging external tools that could trigger giant background reviews; handoff briefs also remind you to break review loops when starting a fresh chat.
- **Prevented crashes on affected Antigravity versions**: Turned off inline chat banners by default to avoid crashes in certain host versions, while keeping the side panel, cache countdown, hang detection, and desktop alerts fully working.
- **Fixed occasional "workspace root not found" errors on Turn 1**: The plugin now remembers your active project folder automatically and updates as you switch windows (while still refusing ambiguous multi-window calls so it never edits the wrong repo).

### v1.7.8
- **Optional silent auto-updates (off by default)**: Added an **Auto-Update: OFF/ON** toggle in the panel top bar. When enabled, startup and 6-hour checks silently install verified same-major releases in the background, waiting if a cache warm-up is in flight, stopping retries on a failed version, and showing a one-time notice after reload.

### v1.7.7
- **DeepSeek Harness support (`--target dsh`)**: Install into DeepSeek Harness alongside Antigravity, Claude Code, and Codex with automatic read guards and log trimming, plus `node bin/agy-dart.mjs dashboard` to open the live monitor in a browser — zero impact or token overhead on Antigravity.
- **Pause warming & alerts on archived chats**: Archived chats automatically stop background keepalive pings, manual warm-ups, and desktop alerts without losing state, and resume cleanly if unarchived.

### v1.7.6
- **One-click online update in the panel** (thanks to [@bestmulicc](https://github.com/bestmulicc), [#5](https://github.com/zou172866/Antigravity-agy-dart/pull/5)): The right panel now checks GitHub Releases on startup and lets you click **Check Update** / **Update Now** to upgrade in place without running terminal commands (startup checks can be turned off in config).
- **Verified downloads, automatic rollback & preserved settings**: Verifies release package integrity before unpacking, rolls back automatically if a file is locked, reloads the panel cleanly, and keeps your local `rules/*.local.md`, tool-loading mode, and synced copies intact.

### v1.7.5
- **One-click manual `Warm 1×` button in the panel**: Added a manual warm-up button right next to the cache countdown. It works even when Auto-Keepalive is off and doesn't use up your automatic warm-up limit (with double-click protection and rollback if sending fails).
- **Skip hopeless last-second warm-ups & unified countdown**: When only a few seconds are left and a warm-up ping won't arrive in time, the plugin skips it to avoid wasting tokens and falls back to a desktop alert instead. The panel, background monitor, and alerts now all share the same expiry countdown, and warming stops right away if the cache has already expired.

### v1.7.4
- **Warmer wording for "Copy Handoff Prompt"**: Updated the handoff prompt templates with a friendlier opening (`宝宝，` in Chinese / `Sweetie,` in English) and asked the AI to start its generated handoff summary the same way — still body-only, with no filler.

### v1.7.3
- **Custom Auto-Keepalive intervals**: Pick **Auto**, **Fixed 4 / 9 / 15 min**, or **Custom (1–60 min)** globally or per chat, with one-click reset back to **Global**. All existing safety guards (max count, skipping short chats, stopping after a cache miss, and skipping background subagents) stay on.
- **Fixed false warnings on timeouts and partial test runs**: Timed-out commands no longer trigger "repeated edit-fail" alerts; passing an unrelated test or a single test case won't erase an earlier full-suite failure; background test errors stay visible even after editing other files; and if a failing check log gets cut off, the panel keeps flagging it until you re-run it.
- **Cleaner handoff summaries & clearer cache-miss reasons**: Copy cleaner progress summaries before switching chats or compacting (with secrets auto-masked), and see more accurate reasons when the cache misses.

### v1.7.2
- **Lighter built-in skill docs & a Skills bloat check**: Moved sample scripts and troubleshooting notes into on-demand files so they don't eat startup context when unused; added `node bin/agy-dart.mjs audit skills` to check how much startup context each installed Skill uses and spot oversized main files.
- **Leaner output from built-in helper agents** _(later removed to avoid Antigravity `1.5.17+` #1890 4× custom-agent quota; use the default main session or built-in `self` / `research`)_: The built-in coding (`dart-coder`) and review (`dart-reviewer`) subagents stay lightweight without carrying extra external tools or global rules, and now route quick checks through output trimming instead of dumping long terminal logs into the chat.

### v1.7.1
- **Fixed the panel's "Blocked Noise" counter staying at 0**: Bytes saved by sliced file reads, batched searches, and trimmed check outputs are now counted accurately in the panel, without mixing up windows or double-counting.
- **Roll up subagent savings into the main chat**: Savings from saved long docs, batch lookups, and background subagents now roll up under the main conversation so panel totals stay accurate.
- **Fixed missed log filtering on Windows / PowerShell**: Commands using flags like `npm --prefix`, `pnpm -C`, `yarn --cwd`, or `--` separators now trim noisy output properly on Windows and PowerShell too.

### v1.7.0
- **Hand the AI a file map when blocking a full large-file read**: When the AI tries to read a huge code file all at once for the first time, the block message now includes a line-numbered list of functions and classes so it can jump straight to the lines it needs without an extra turn.
- **Unified CLI with Claude Code & Codex support**: Added `node bin/agy-dart.mjs` to install for Antigravity, Claude Code, or Codex, print file outlines, and compare token usage across chats; also shipped lightweight built-in coding/review subagents and stronger workspace & Node.js checks.

<details>
<summary>Show earlier releases (v1.1.0 – v1.6.0)</summary>

### v1.6.0
- **4 core tools preloaded directly, fixing occasional dropped multi-file edits**: Batch search, file outlines, multi-file edits, and quick checks now load directly instead of going through an extra layer that sometimes emptied multi-file edits; the other 8 large-log tools stay on-demand to save startup context.
- **Fixed Auto-Keepalive stalls & skipped all background subagents**: The background panel now restarts cleanly after plugin updates so stale processes don't interfere; subagents spawned by `/boost`, browser tasks, or workflows — plus closed chats — never send keepalive pings or crowd the top status bar.
- **Let subagents read freely & protect the plugin folder**: Background subagents can read large or repeated files without hitting red block messages, and any call missing a project path that lands inside the plugin's own install folder is blocked so the AI won't search or edit the plugin by mistake.
- **One-line install without cloning**: Added single-line PowerShell and Shell commands so you don't have to clone the repo first.
- **Other polish**: Unused output budget from short checks automatically shifts to long error traces; read-only Git queries block untrusted external commands; fixed Windows hang on exit; upgrades preserve your custom `rules/*.local.md` files; added a security policy and light/dark architecture diagrams.

### v1.5.4
- **Click alerts to jump to that chat**: Clicking a desktop popup or cross-window panel alert brings the matching project window to the front and opens that conversation; added a multi-window session switcher bar in the panel.
- **Optional cache keepalive**: Sends a ping for primary chats shortly before expiry; the panel controls the per-chat limit, and your next message resets the count.
- Moved current context usage, cache countdown, and blocked noise volume into a larger top card in the panel.

### v1.5.3
- **Project & chat titles on multi-window alerts**: Desktop popups and panel alerts show folder names (e.g., `work/agy-dart`) and short chat titles without exposing message text.
- **"Context Almost Full" desktop alert**: Pops up once near the limit and resets after `/compact`.

### v1.5.2
- Faster file reads and chat startup; added code outlines for multi-thousand-line `.html` / `.astro` and `.dart` files; fixed Windows Python / PowerShell encoding garbling and paused panel refreshes while hidden.

### v1.5.1
- Filled in untranslated strings in Chinese UI mode; tuned post-edit file-limit suggestions.

### v1.5.0
- **Read actual model cache expiry time**: Reads the active model's real cache lifetime (such as 5m or 15m) from recent usage and carries it into new chats.
- Added optional 1-minute cache-expiry desktop reminder and CLI keepalive cost simulation.

### v1.4.0
- **Hang detection & rescue summary**: Flags chats stuck spinning with zero output (ignoring long builds and laptop sleep), points to the stalled step in the panel, and prepares a one-click progress summary (modified files, last command, current step) to continue in a new chat.

### v1.3.1
- Allow immediate file re-reads right after `/compact`; skip dedup prompts on slices under 4 KB; preserve mid-log error lines in long failure outputs.

### v1.3.0
- **Tiered file-read limits**: Raised direct reads to 45 KB (800 lines) for normal code and 128 KB for `.patch` files while keeping noisy logs at 16 KB; second-try reads pass through so patch reviews and subagents don't stall.
- Added `.patch` file outlines and kept context lines when trimming `git diff`.

### v1.2.2
- **Uninterrupted long tasks**: Removed mid-task `/compact` prompts and routed >60s builds, tests, and background servers straight to Antigravity's native background runner.
- Blocked `.env` reads and fixed 42 Windows shell, isolation, and orphan-process issues.

### v1.2.1
- Automatic rollback on failed multi-file edits and 76 path/argument stability fixes.

### v1.2.0
- Unified settings in `~/.agy-dart/config.json`; added local panel request checks; **automatic structure, sample, and error extraction for huge JSON files**; added `gh`, `kubectl`, `terraform`, and `playwright` output trimming plus handoff summaries.

### v1.1.0
- **Automatic terminal output trimming**: Strips progress bars and repetitive noise from `git`, test, build, and install commands while saving full logs locally.
- Unchanged-file duplicate-read protection, edit-fail loop notes, internal-URL SSRF blocking, log secret masking, and one-click panel cleanup.

</details>

---

## Using with Other AI Tools (CLI)

`node bin/agy-dart.mjs` installs for Antigravity by default and can also target other coding tools (saving a restore record in `~/.agy-dart/` so uninstalling cleanly puts your original config back):

```bash
node bin/agy-dart.mjs install                        # Install for Antigravity (default)
node bin/agy-dart.mjs install --target dsh           # Install for DeepSeek Harness (optional --profile <name> or --mcp-only)
node bin/agy-dart.mjs install --target claude        # Install for Claude Code
node bin/agy-dart.mjs install --target codex         # Install for Codex
```

Handy CLI utilities:

```bash
node bin/agy-dart.mjs dashboard                      # Open the live dashboard standalone in a browser
node bin/agy-dart.mjs audit safety                   # Check recent background quota-burn events
node bin/agy-dart.mjs audit skills                   # Audit startup context usage of installed Skills
node bin/agy-dart.mjs outline <file>                 # Print a file's function/class map with line numbers
node bin/agy-dart.mjs session <id>                   # Inspect one chat's token bill
node bin/agy-dart.mjs compare <before> <after>       # Compare token usage across two chats
```

---

<details>
<summary><strong>Developer Local Checks (for contributors)</strong></summary>

```bash
npm test                                           # Run full test suite
npm run verify:pkg                                 # Verify installer file list
npm run prefix:budget                              # Estimate configured Antigravity startup and full-catalog token usage
npm run brief:check                                # Check that AI_REVIEW_BRIEF.md line/test counts are up to date
node scripts/cache-audit.mjs --workspace . --no-live
node bin/agy-dart.mjs audit skills --workspace .   # Check startup context usage and structure of installed Skills
npm run cache:simulate
```

After adding, removing, or editing modules or tests, keep these three places in sync so local checks stay green:
- **Installer file list** (`scripts/install.mjs`): update `RUNTIME_FILES` (installed by default) or `DEVTOOLS_FILES` (`--with-devtools`) whenever files are added or removed, or `npm run verify:pkg` will fail.
- **Test count check** (`tests/v1.2-hardening.test.mjs`): when the test count changes, update the hardcoded `computeBriefMetrics(ROOT).testCases` number to match `npm test`.
- **Review brief** (`AI_REVIEW_BRIEF.md`): after changing tracked source files or test counts, run `node scripts/gen-review-brief.mjs --write` to refresh the numbers, then verify with `npm run brief:check`.

</details>

---

## Credits & License

[MIT License](LICENSE). Incorporates and adapts MIT-licensed code from [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) and [Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode); full third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Star History

<a href="https://www.star-history.com/?repos=zou172866%2FAntigravity-agy-dart&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
  </picture>
</a>
