import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { auditEnvironmentCache, formatCacheAuditMarkdown } from "../scripts/cache-audit.mjs";
import { buildMcpConfigObject } from "../scripts/install.mjs";
import { ContextModeStore } from "../context/lib/store.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function sendContextRpc(messages, env = {}) {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const res = spawnSync(process.execPath, [path.join(ROOT, "context", "server.js")], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...env
    }
  });
  assert.equal(res.status, 0, `context/server.js failed: ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeBloatedMockMcp(scriptPath) {
  const src = `
import readline from "node:readline";
const tools = Array.from({ length: 18 }, (_, i) => ({
  description: "Verbose enterprise schema description ".repeat(14) + "tool_" + String(i).padStart(2, "0"),
  inputSchema: {
    properties: {
      argA: { description: "Detailed parameter documentation ".repeat(6), type: "string" },
      argB: { description: "Additional nested constraint text ".repeat(6), type: "string" }
    },
    type: "object"
  },
  name: "bloated_tool_" + String(i).padStart(2, "0")
}));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-bloat", version: "1.0.0" } }
    }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\\n");
  }
});
`;
  fs.writeFileSync(scriptPath, src, "utf8");
}

test("Wave2-1 (P0-4): cache-audit discovers .agents/ & .antigravity-plugin, evaluates rule triggers/24KB/20k limits, PostInvocation, and separates lazy vs eager MCP schemas", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-audit-"));
  const geminiRoot = path.join(baseDir, ".gemini");
  const configDir = path.join(geminiRoot, "config");
  const repoRoot = path.join(baseDir, "repo");
  const workspaceDir = path.join(repoRoot, "packages", "app");
  const mockMcp = path.join(baseDir, "mock-bloat-mcp.mjs");

  try {
    fs.mkdirSync(path.join(configDir, "plugins", "ext-ag", ".antigravity-plugin"), { recursive: true });
    fs.mkdirSync(path.join(configDir, "plugins", "ext-ag", "rules"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".agents", "rules"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Global standalone ~/.gemini/AGENTS.md and ~/.gemini/config/GEMINI.md
    fs.writeFileSync(path.join(geminiRoot, "AGENTS.md"), "# Global Gemini AGENTS\nStay concise.\n", "utf8");
    fs.writeFileSync(path.join(configDir, "GEMINI.md"), "# Config GEMINI\nKeep cache warm.\n", "utf8");

    // Plugin with .antigravity-plugin/plugin.json (preferred over root)
    fs.writeFileSync(
      path.join(configDir, "plugins", "ext-ag", ".antigravity-plugin", "plugin.json"),
      JSON.stringify({ name: "ext-ag-manifest" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(configDir, "plugins", "ext-ag", "rules", "always.md"),
      "---\ntrigger: always_on\n---\nKeep outputs short.\n",
      "utf8"
    );

    // Workspace ancestor .agents/AGENTS.md + trigger variants in .agents/rules/
    fs.writeFileSync(path.join(repoRoot, ".agents", "AGENTS.md"), "# Repo Agents\nRun tests.\n", "utf8");
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "model-dec.md"),
      "---\ntrigger: model_decision\ndescription: Short pointer\n---\n" + "Heavy body line.\n".repeat(400),
      "utf8"
    );
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "glob-only.md"),
      "---\ntrigger: glob\nglobs: \"**/*.sql\"\n---\n" + "SQL guideline.\n".repeat(400),
      "utf8"
    );
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "bad-trigger.md"),
      "---\ntrigger: always\n---\nTypo trigger gets silently dropped by host.\n",
      "utf8"
    );

    // 25 KB always_on rule -> triggers rule_truncation_limit (>24,000 B)
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "huge-25kb.md"),
      "---\ntrigger: always_on\n---\n" + "a".repeat(24500) + "\n",
      "utf8"
    );

    // Workspace .agents/hooks.json with PostInvocation hook
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "hooks.json"),
      JSON.stringify({
        "demo-hooks": {
          PostInvocation: [{ type: "command", command: "node -e \"console.log('{}')\"" }]
        }
      }),
      "utf8"
    );

    // Workspace .agents/mcp_config.json with BOTH lazy bloated server (must NOT warn) and eager bloated server (MUST warn)
    writeBloatedMockMcp(mockMcp);
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "lazy-huge": { command: "node", args: [mockMcp] },
          "eager-huge": {
            command: "node",
            args: [mockMcp],
            tools: Object.fromEntries(
              Array.from({ length: 18 }, (_, i) => [`bloated_tool_${String(i).padStart(2, "0")}`, { eager: true }])
            )
          }
        }
      }),
      "utf8"
    );

    const report = await auditEnvironmentCache({
      workspace: workspaceDir,
      configDir,
      live: true,
      timeoutMs: 6000
    });

    // Plugin manifest discovered under .antigravity-plugin/plugin.json
    assert.ok(
      report.hooks.activePlugins.some((p) => p.name === "ext-ag-manifest"),
      "Must discover .antigravity-plugin/plugin.json plugin name"
    );

    // Standalone global & ancestor .agents/AGENTS.md discovered
    assert.ok(report.prefix.items.some((i) => i.scope === "global" && i.name === "AGENTS.md"));
    assert.ok(report.prefix.items.some((i) => i.scope === "global" && i.name === "GEMINI.md"));
    assert.ok(report.prefix.items.some((i) => i.name.includes(".agents/AGENTS.md")));

    // model_decision counts only compact pointer at Turn 0; glob-only does not enter Turn 0 items
    const modelDecItem = report.prefix.items.find((i) => i.name.includes("model-dec.md"));
    assert.ok(modelDecItem, "model_decision rule pointer must appear in Turn-0 items");
    assert.ok(modelDecItem.tokens < 50, `model_decision must count only pointer tokens, got ${modelDecItem.tokens}`);
    assert.ok(modelDecItem.bodyTokens > 1000);
    assert.equal(
      report.prefix.items.some((i) => i.name.includes("glob-only.md")),
      false,
      "glob rule must NOT inflate Turn-0 items"
    );
    assert.ok(report.prefix.onDemandRuleCount >= 2);
    assert.ok(report.prefix.onDemandRuleTokens > 2000);

    // Invalid trigger & 24 KB truncation findings emitted
    assert.ok(
      report.findings.some((f) => f.code === "invalid_rule_trigger" && f.target.includes("bad-trigger.md")),
      "Typo trigger must emit invalid_rule_trigger"
    );
    assert.ok(
      report.findings.some((f) => f.code === "rule_truncation_limit" && f.target.includes("huge-25kb.md")),
      ">24,000-byte always_on rule must emit rule_truncation_limit"
    );

    // PostInvocation hook discovered from ancestor .agents/hooks.json
    assert.ok(
      report.hooks.entries.some((e) => e.event === "PostInvocation"),
      "Must discover PostInvocation hook from .agents/hooks.json"
    );

    // Lazy bloated MCP server does NOT emit bloated_mcp_schema; eager bloated MCP server DOES
    const lazySrv = report.mcp.servers.find((s) => s.name === "lazy-huge");
    const eagerSrv = report.mcp.servers.find((s) => s.name === "eager-huge");
    assert.ok(lazySrv && lazySrv.eagerTokens === 0 && lazySrv.lazyCatalogTokens > 3000);
    assert.ok(eagerSrv && eagerSrv.eagerTokens > 3000 && eagerSrv.eagerToolCount === 18);
    assert.equal(
      report.findings.some((f) => f.code === "bloated_mcp_schema" && f.target.includes("lazy-huge")),
      false,
      "Default lazy MCP server must NOT trigger bloated_mcp_schema"
    );
    assert.equal(
      report.findings.some((f) => f.code === "bloated_mcp_schema" && f.target.includes("eager-huge")),
      true,
      "Eager bloated MCP server MUST trigger bloated_mcp_schema"
    );

    // Aggregate 20,000-token rules budget check
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "这是一段用于触发两万聚合规则预算告警的测试文本。".repeat(900), "utf8");
    const aggReport = await auditEnvironmentCache({ workspace: workspaceDir, configDir, live: false });
    assert.ok(
      aggReport.findings.some((f) => f.code === "rules_aggregate_budget_exceeded"),
      "Combined >20,000-token always_on rules must emit rules_aggregate_budget_exceeded"
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave2-2 (#1890): agy-dart removes custom agents and cache-audit flags custom/plugin agents with workspace scoping & DEPRECATED downgrade", async () => {
  assert.equal(fs.existsSync(path.join(ROOT, "agents", "dart-coder.md")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "agents", "dart-reviewer.md")), false);

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-agents-1890-"));
  try {
    const fakeHome = path.join(baseDir, "home");
    const configDir = path.join(fakeHome, ".gemini", "config");
    const repoRoot = path.join(baseDir, "repo");
    const workspaceDir = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // 1. Workspace active custom agents (.agents/agents, .agent/agents legacy, workspace plugin)
    fs.mkdirSync(path.join(workspaceDir, ".agents", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".agents", "agents", "local-coder.md"),
      "---\nname: local-coder\ndescription: Custom workspace coder\n---\nBody mentions DEPRECATED but frontmatter does not.\n",
      "utf8"
    );
    fs.mkdirSync(path.join(workspaceDir, ".agent", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".agent", "agents", "legacy-reviewer.md"),
      "---\nname: legacy-reviewer\ndescription: deprecated lowercase should still warn\n---\nBody\n",
      "utf8"
    );
    fs.mkdirSync(path.join(workspaceDir, ".agents", "plugins", "ws-plug", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".agents", "plugins", "ws-plug", "plugin.json"),
      JSON.stringify({ name: "ws-plug", version: "1.0.0" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(workspaceDir, ".agents", "plugins", "ws-plug", "agents", "ws-helper.md"),
      "---\nname: ws-helper\ndescription: Workspace plugin helper\n---\nBody\n",
      "utf8"
    );

    // 2. Global standalone & global plugin agents (one active, one DEPRECATED placeholder)
    fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "agents", "global-bot.md"),
      "---\nname: global-bot\ndescription: Global standalone custom agent\n---\nBody\n",
      "utf8"
    );
    fs.mkdirSync(path.join(fakeHome, ".agents", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".agents", "agents", "home-bot.md"),
      "---\nname: home-bot\ndescription: Home .agents custom agent\n---\nBody\n",
      "utf8"
    );
    fs.mkdirSync(path.join(configDir, "plugins", "third-party", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "third-party", "plugin.json"),
      JSON.stringify({ name: "third-party", version: "1.0.0" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(configDir, "plugins", "third-party", "agents", "rules-author.md"),
      "---\nname: rules-author\ndescription: Third-party plugin agent\n---\nBody\n",
      "utf8"
    );
    fs.mkdirSync(path.join(configDir, "plugins", "agy-cmd", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "agy-cmd", "plugin.json"),
      JSON.stringify({ name: "agy-cmd", version: "2.8.1" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(configDir, "plugins", "agy-cmd", "agents", "cmd-verifier.md"),
      "---\nname: cmd-verifier\ndescription: DEPRECATED - do not invoke (4x custom-agent quota since agy 1.5.17, issue 1890). Use built-in research instead.\n---\nPlaceholder\n",
      "utf8"
    );

    // Full audit sees both workspace and global/plugin findings with exact target prefixes
    const full = await auditEnvironmentCache({ workspace: workspaceDir, configDir, live: false });
    assert.equal(full.customAgents.agentCount, 7);
    assert.equal(full.customAgents.activeCount, 6);
    assert.equal(full.customAgents.deprecatedCount, 1);

    const wsWarn = full.findings.find(
      (f) => f.code === "custom_agent_quota_multiplier" && f.target === "workspace:.agents/agents/local-coder.md"
    );
    assert.ok(wsWarn, "Workspace .agents/agents/* with DEPRECATED only in body must emit warn");
    assert.equal(wsWarn.severity, "warn");
    assert.equal(wsWarn.scopeGroup, "workspace");

    const legacyWarn = full.findings.find(
      (f) => f.code === "custom_agent_quota_multiplier" && f.target === "workspace-legacy:.agent/agents/legacy-reviewer.md"
    );
    assert.ok(legacyWarn, "Lowercase 'deprecated' in description must still emit warn (case-sensitive check)");
    assert.equal(legacyWarn.scopeGroup, "workspace");

    const wsPlugWarn = full.findings.find(
      (f) => f.code === "custom_agent_quota_multiplier" && f.target === "workspace-plugin:ws-plug/agents/ws-helper.md"
    );
    assert.ok(wsPlugWarn, "Workspace plugin agent must emit warn with workspace-plugin: target");
    assert.equal(wsPlugWarn.scopeGroup, "workspace");

    const globalWarn = full.findings.find(
      (f) => f.code === "custom_agent_quota_multiplier" && f.target === "global:agents/global-bot.md"
    );
    assert.ok(globalWarn, "Global configDir agent must emit warn with global: target");
    assert.equal(globalWarn.scopeGroup, "global");

    const homeAgentsWarn = full.findings.find(
      (f) => f.code === "custom_agent_quota_multiplier" && f.target === "global:.agents/agents/home-bot.md"
    );
    assert.ok(homeAgentsWarn, "Global ~/.agents/agents/* must emit warn with global: target");
    assert.equal(homeAgentsWarn.scopeGroup, "global");

    const pluginWarn = full.findings.find(
      (f) => f.code === "custom_agent_quota_multiplier" && f.target === "plugin:third-party/agents/rules-author.md"
    );
    assert.ok(pluginWarn, "Active global plugin agent must emit warn with plugin: target");
    assert.equal(pluginWarn.scopeGroup, "global");

    const depInfo = full.findings.find(
      (f) =>
        f.code === "deprecated_custom_agent_placeholder" &&
        f.target === "plugin:agy-cmd/agents/cmd-verifier.md"
    );
    assert.ok(depInfo, "Frontmatter description starting with DEPRECATED must downgrade to info");
    assert.equal(depInfo.severity, "info");
    assert.equal(depInfo.scopeGroup, "global");

    const md = formatCacheAuditMarkdown(full);
    assert.ok(md.includes("Custom Agents (Issue #1890"), "Markdown report must include custom agents summary");
    assert.ok(md.includes("custom_agent_quota_multiplier"));
    assert.ok(md.includes("deprecated_custom_agent_placeholder"));

    // --workspace-only filters out all global & global-plugin custom agents while retaining workspace ones
    const wsOnly = await auditEnvironmentCache({
      workspace: workspaceDir,
      configDir,
      live: false,
      workspaceOnly: true
    });
    assert.equal(wsOnly.customAgents.agentCount, 3);
    assert.equal(wsOnly.findingsByScope.global, 0);
    assert.ok(
      wsOnly.findings.every((f) => f.scopeGroup === "workspace"),
      "workspaceOnly must exclude all global/plugin custom agent findings"
    );
    assert.ok(
      wsOnly.findings.some((f) => f.target === "workspace:.agents/agents/local-coder.md"),
      "workspaceOnly must retain workspace custom agent findings"
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave2-3 (P1-3): mcp_config.json/install.mjs set context timeoutSeconds=310 and context/server.js aligns MCP protocol & initialize.instructions", () => {
  const mcpCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp_config.json"), "utf8"));
  assert.equal(mcpCfg.mcpServers.context.timeoutSeconds, 310);

  for (const mode of ["fast-eager", "lazy", "eager"]) {
    const built = buildMcpConfigObject(mode);
    assert.equal(built.mcpServers.context.timeoutSeconds, 310, `buildMcpConfigObject(${mode}) must set timeoutSeconds=310`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-ctx-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    const resps = sendContextRpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "w2-test", version: "1.0" } }
        },
        { jsonrpc: "2.0", id: 2, method: "resources/list" },
        { jsonrpc: "2.0", id: 3, method: "resources/templates/list" },
        { jsonrpc: "2.0", id: 4, method: "prompts/list" }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );
    const init = resps.find((r) => r.id === 1)?.result;
    assert.equal(init.protocolVersion, "2025-11-25");
    assert.equal(typeof init.instructions, "string");
    assert.ok(init.instructions.includes("ctx_execute") && init.instructions.includes("ctx_resume"));
    assert.deepEqual(resps.find((r) => r.id === 2)?.result, { resources: [] });
    assert.deepEqual(resps.find((r) => r.id === 3)?.result, { resourceTemplates: [] });
    assert.deepEqual(resps.find((r) => r.id === 4)?.result, { prompts: [] });

    // Unknown protocol version falls back safely to DEFAULT_PROTOCOL_VERSION (2025-03-26)
    const fallbackResps = sendContextRpc(
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {} } }],
      { AGY_DART_DB_PATH: dbPath }
    );
    assert.equal(fallbackResps[0]?.result?.protocolVersion, "2025-03-26");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave2-4 (P2-1): plugin.json includes official schema, license, keywords, and concise 120-160 char Marketplace description", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  assert.equal(manifest.$schema, "https://antigravity.google/schemas/v1/plugin.json");
  assert.equal(manifest.license, "MIT");
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 5 && manifest.keywords.length <= 12);
  assert.ok(
    manifest.description.length >= 120 && manifest.description.length <= 160,
    `Expected description 120..160 chars, got ${manifest.description.length}`
  );
});

test("Wave2-5 (P2-2 + P1-5 docs): PreInvocation alerts guide /compact <focus> & /btw, and SKILL/error-playbook document /context & cliFilter: false", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-alerts-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  try {
    const critEn = evaluateCacheAlerts(
      {
        watermark: "critical",
        currentContextTokens: 170000,
        criticalTokens: 160000,
        windowTokens: 200000,
        weightedHitRate: 0.85,
        compactAdvice: "critical_compact",
        ttlStatus: "warm",
        cacheTtlSec: 300
      },
      { sessionId: "w2-en", store, uiLang: "en" }
    );
    assert.ok(critEn[0].includes("/compact <focus>"), `Expected /compact <focus> in EN critical alert: ${critEn[0]}`);

    const coldZh = evaluateCacheAlerts(
      {
        watermark: "warn",
        currentContextTokens: 140000,
        warnTokens: 130000,
        windowTokens: 200000,
        weightedHitRate: 0.4,
        compactAdvice: "opportunistic_cold_compact",
        ttlStatus: "expired",
        cacheTtlSec: 300
      },
      { sessionId: "w2-zh", store, uiLang: "zh" }
    );
    assert.ok(coldZh[0].includes("/compact <focus>") && coldZh[0].includes("/btw"), `Expected /compact <focus> & /btw in ZH cold alert: ${coldZh[0]}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");
  const playbookMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "references", "error-playbook.md"), "utf8");
  for (const needle of ["/compact <focus>", "/btw <question>", "/context", "cliFilter"]) {
    assert.ok(skillMd.includes(needle), `SKILL.md must mention ${needle}`);
    assert.ok(playbookMd.includes(needle), `error-playbook.md must mention ${needle}`);
  }
});
