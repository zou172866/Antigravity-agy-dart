/**
 * Backward-compatible Watchdog Lease facade aggregating:
 *   - `./watchdog-lease-core.js` (ultra-lightweight lease R/W & hook transition core)
 *   - `./watchdog-transcript.js` (transcript genesis & tail-step inspection)
 *   - `./watchdog-summaries.js` (`conversation_summaries.db` / annotation LRU lookups)
 *
 * High-frequency hooks (`PreToolUse`, `PostToolUse`) import `./watchdog-lease-core.js`
 * directly to avoid paying transcript/summary module parse cost on the hot path.
 */
export {
  classifyToolExecutionKind,
  computeCausalTurnLlmFloorTs,
  decodeFileUriOrPath,
  deleteWatchdogLeaseIfUnchanged,
  deriveLlmSubphase,
  extractBareToolName,
  extractInlinePayloadTitle,
  extractPayloadWorkspaceRoot,
  formatWorkspaceWindowLabel,
  getToolTimeoutTier,
  getWatchdogLeaseKey,
  HEADLESS_FINISH_PROMPT_RE,
  isHeadlessWorkerPrompt,
  isHighReasoningModel,
  isSameWorkspacePath,
  isSubagentLeasePayload,
  isSummaryMetadataSubagent,
  isTtlKeepalivePrompt,
  KNOWN_MCP_TOOL_RE,
  listWatchdogLeases,
  LONG_MCP_TOOL_RE,
  normalizeWatchdogLease,
  parseMaybeJsonObj,
  parseWorkspaceUriToPath,
  readWatchdogLease,
  recordHookLeaseTransition,
  registerSummaryLookup,
  sanitizeConversationId,
  sanitizeCwd,
  sanitizeWatchdogText,
  SLOW_GEN_TOOL_RE,
  SUBAGENT_ROLE_RE,
  SUBAGENT_TOOL_RE,
  truncateUtf8Safe,
  TTL_KEEPALIVE_PROMPT_RE,
  WATCHDOG_LEASE_PREFIX,
  WATCHDOG_PHASES,
  writeWatchdogLease,
  writeWatchdogLeaseIfUnchanged
} from "./watchdog-lease-core.js";

export {
  classifyTranscriptGenesisFile,
  classifyTranscriptGenesisSteps,
  detectSubagentFromTranscriptFile,
  detectSubagentFromTranscriptSteps,
  hasPendingKeepaliveColdCheck,
  inspectLatestTurnInSteps,
  isKeepaliveTurnFlushedForRound,
  isTrajectoryMetadataSubagent,
  parseStepPrefillTimestampInfo,
  parseStepPrefillTimestampMs,
  readWatchdogTranscriptTail
} from "./watchdog-transcript.js";

export {
  clearConversationSummaryCache,
  getConversationSummaryCacheStats,
  listRecentConversationIdsFromSummaryDb,
  lookupConversationSummary,
  lookupConversationTitle,
  parseAnnotationArchivedStatus,
  queryRecentConversationIdsFromSummaryDb,
  readConversationParentId,
  resolveCandidateTranscriptPath
} from "./watchdog-summaries.js";
