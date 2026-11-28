# agy-dart Error & Troubleshooting Playbook

Read on demand when hitting guard blocks, edit rollbacks, rejected filter rules, cache drops, toolbox schema errors, or timeout/quota issues.

## Quick Triage Matrix

| Symptom / Error | Likely Cause | First Recovery Action |
| --- | --- | --- |
| `read_file` / `view_file` blocked | Exceeded tier cap (`45 KiB`/800L source, `128 KiB` patch, `16 KB` noisy) or `readDedup` | Use inline outline line numbers with ranged `read_file` or `read_slices`; use `ctx_execute`/`ctx_index` for logs/data |
| Rejected `.agy-dart/filters.json` rules | Bad schema/ID, `>64 KB` / `>20` rules, or ReDoS regex (`isSafeRegex`) | Check `ctx_doctor` rejection reason; rewrite to linear regex per `examples/filters.json` |
| `apply_edits` aborted or rolled back | Stale/ambiguous `target` or write error | Re-read slice, add `startLine`/`endLine` or wider context, preview with `dryRun: true` |
| KV-cache drop or prefix bloat | Large rules/frontmatter, non-deterministic MCP `tools/list`, legacy plugin, dynamic hook | Run `npm run cache:audit -- --workspace . --no-live` and `node bin/agy-dart.mjs audit skills --workspace .` |
| Slow search, Windows garble, or timeout | Missing `rg`, shell quoting, or `>60s` job in `run_checks` | Install `rg` (`--install-rg`), use `ctx_execute` script file, route `>60s`/daemons to `run_command` (`WaitMsBeforeAsync <= 2000`) |
| `mcp_ide-tools_mcp_agy-dart_fast_apply_edits ... at '/required': items at 1 and 2 are equal` | `ide-tools` bridge appends duplicate `toolSummary` to `/required` on eager `fast` tools | Run `node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy` and restart Antigravity |
| Quota cliff, 3–6s tool stalls, or Safety Monitor `heavy_burst_or_sticky` / `429_avalanche` | Background safety pipeline (`sir_flash_lite` -> `gemini-4-hydrogen-sonar`, Issue #1886) sending up to 300K-char reviews | Do NOT restart first (truncates `language_server.log`); run `agy-dart audit safety`, switch via **Handoff Brief**, use native `read_file` outside workspace |
| `Workspace root could not be determined ...` | MCP launched in `${PLUGIN_ROOT}` without `roots/list`, or multiple active workspaces | Pass workspace path in `cwd` (or set `AGY_DART_WORKSPACE` / `defaultCwd` in `~/.agy-dart/config.json`) |

---

## 1. Read Guard & Duplicate-Read Protection

- **Tiers**: source `45 KiB`/800L (`host-45k`); `.patch`/`.diff` `128 KiB` (`reviewMaxReadBytes`, paginated `ByteOffset` passes in soft mode); noisy/minified/logs `16 KB` (`noiseMaxReadBytes`).
- **Recovery**:
  1. Use the returned inline outline (`<=512 KiB`, `inlineOutlineMaxBytes`) with ranged `read_file({ Path, StartLine, EndLine })` or `read_slices`; batch unfamiliar files via `read_slices({ outlines })`.
  2. Default `readGuardMode: "soft"` allows a one-time retry; `"strict"` enforces hard denials. Never retry full reads on `>16 KB` logs/CSV/JSON—use `ctx_execute` (`<=8.8 KB`) or `ctx_index` + `ctx_search`.
  3. Presets: `node scripts/install.mjs mode <host-45k|fast-32k|balanced-16k|strict-8k|no-read-hook>`. Config overrides (`~/.agy-dart/config.json`): `readGuardMode`, `maxReadBytes`, `exemptExtensions`, `exemptPaths`, `readDedup` (resets after edits or `/compact`).

## 2. `.agy-dart/filters.json` Rejected Rules

Project CLI filters live in `<workspace>/.agy-dart/filters.json` (fail-open). Inspect with `ctx_doctor` / `doctor`.
- **File errors**: `not_a_file`/`empty_file`, `file_too_large` (`>64 KB`), `invalid_json`/`invalid_schema` (needs `{"rules":[...]}`), `too_many_rules` (`>20`).
- **Rule errors**: `invalid_id`/`duplicate_id` (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/`), `missing_match`/`invalid_keep`/`invalid_drop`, `unsafe_or_invalid_regex` (`isSafeRegex()` blocks nested quantifiers `(a+)+`, overlapping alternations `(a|aa)+`, backreferences `\1`, bounds `min>100`/`max>200`). Fix with anchored literals/char classes per `examples/filters.json`.
- **Order & safety**: built-in rules run before project rules; `keep` runs before `drop` (keep `keep` narrow so noisy lines do not fill `maxLines`); non-zero exits keep stderr/error anchors (`preserveTailOnFail: true`).

## 3. `apply_edits` Rollback & Target Mismatch

`apply_edits` validates all hunks before writing and rolls back on write errors.
- **`target text not found`**: re-read via `read_slices({ lineRanges })` or ranged `read_file`; check tabs/spaces/prior edits and `cwd` (plugin install dir is blocked).
- **`target matched N times`**: add `startLine`/`endLine`, expand unique context, or set `replaceAll: true`.
- **Safe workflow**: group hunks per file, preview with `dryRun: true`, run post-write `verify`, use `bestEffort: true` only when partial commits are acceptable.

## 4. KV-Cache Drops & Turn-0 Prefix Bloat

- **Commands**: `npm run cache:audit -- --workspace . --no-live` (omit `--no-live` for dual MCP determinism probes); `node bin/agy-dart.mjs audit skills --workspace .`; `npm run prefix:budget`; `npm run cache:simulate`; side-pane link on `v2.35.1+` (emit sparingly): `[agy-dart Context](sidecar://agy-dart/dashboard/)`.
- **Fixes**:
  - Trim always-loaded `rules/` and skill frontmatter; split bulky `SKILL.md` into `references/` and `examples/`; disable legacy standalone `agy-fast` / `antigravity-plugin-context-mode`.
  - Use `/compact <focus>` then `ctx_resume({})` (`sessionId` on shared hosts); use `/btw <question>` for isolated side queries and CLI `/context` for token breakdown.
  - Set `stablePrefixOnly: true` to strip volatile Git lines from `SessionStart`. `ttlKeepalive` is off by default (opt-in per window; consumes input tokens).
  - **Reading `prefix_drift`**: `unreported` = no cache-read count in step; `zero-read` = explicit `0` without known bust cause; `partial hit` = `<70%` retention; `priorContextMatch` on `gemini-4-512k` signals possible replica/eviction drift (try pinning a single proxy exit node to A/B test).
  - Delegate full-file audits of multi-thousand-line files to a read-only subagent instead of flooding main context with parallel slices.

## 5. Windows Encoding, Missing `rg`, Enterprise Policies & Timeouts

- **Install `rg`**: Windows `node scripts/install.mjs install --install-rg` (`.\install.ps1 -InstallRg`); macOS/Linux `brew install ripgrep` / `apt install ripgrep`.
- **Quoting & UTF-8**: keep inline `ctx_execute` `<=5` lines (~400 chars); for complex logs/quoting write a script under `<Artifact Directory Path>/scratch/` (or OS temp) and pass `file` + `args` (see `examples/ctx_trace_summary.py`). Unsafe shell metacharacters (`%`, `!`) fail open past `cli-filter`.
- **Enterprise policy (`cliFilter: false`)**: if admin policy blocks `PreToolUse.overwrite` wrappers, set `"cliFilter": false` in `~/.agy-dart/config.json` (or `AGY_DART_DISABLE_CLI_FILTER=1`) while keeping read guards and MCP tools active.
- **Timeouts**: `run_checks` for `<=60s` foreground checks; native `run_command` (`WaitMsBeforeAsync <= 2000`, `IsDaemon: true` for servers) + `manage_task` for `>60s`/async jobs (`cliFilterAsyncBypassMs: 2000`).

## 6. `ide-tools` Duplicate `/required` Schema Error

- **Cause**: in `fast-eager` mode, Antigravity injects `toolSummary` into `/required` (`["edits", "toolSummary"]`), and the `ide-tools` bridge appends `toolSummary` a second time without deduplicating (`items at 1 and 2 are equal`), violating Draft 2020-12 `uniqueItems`.
- **Fix**: switch to lazy loading and restart Antigravity: `node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy` (or remove `"tools"` / `"eager": true` under `mcpServers.fast` in `mcp_config.json`). Raw schemas can be verified under `~/.gemini/antigravity*/mcp/agy-dart_fast/`.

## 7. Background Safety Monitor Quota Burn (Issue #1886)

- **3-stage pipeline**: Stage 1 (`agy_tool_safety`, local ~20 µs: native `read_file` hits `allowed_tool` = 0 cloud checks; writes, compound shells, and all MCP tools enter Stage 2) -> Stage 2 (`sir_flash_lite`, ~48K chars; ~4,400 calls/5h triggers `HTTP 429` fallback to Stage 3) -> Stage 3 (`severe_internal_risks_agy` / `gemini-4-hydrogen-sonar`, up to 300K chars, invisible in transcripts).
- **Diagnose before restarting** (restarts truncate `%APPDATA%\Antigravity\logs\language_server.log`; keeping Sidecar open persists 5h buckets in `~/.agy-dart/safety-audit-state.json`): run `npm run safety:audit`, `node bin/agy-dart.mjs audit safety`, or `ctx_doctor`. Overrides: `safetyAudit`, `safetyLogPaths`, `safetyStatePath`, `safetyWindowHours`, `safetyPrecheckWarnCount` (`3500`), `safetyPrecheckLimit` (`4400`), `safetyHeavyBurstCount` (`3`), `safetyHeavyBurstWindowMin` (`5`), `safetyStickyCharThreshold` (`150000`).
- **Mitigations**: use native ranged `read_file` for outside-workspace paths; batch in-workspace edits/searches with `agy-dart_fast`; hand off to a fresh window after `git push`, PRs, browser chains, or heavy safety escalations; avoid redundant unquoted shell operators across parallel `agy` CLI workers.
