// ============================================================================
// Context Janitor — shared types
// Runs BEFORE api.createMessage() to curate conversation history using the
// local-long (128k context) model via MacM4LocalAgent's LiteLLM proxy.
// ============================================================================

export type JanitorAction = "keep" | "summarize" | "archive" | "discard"

export interface JanitorDecision {
	messageIndex: number
	action: JanitorAction
	reason: string // terse, ≤80 chars
	confidence: number // 0.0–1.0
	summary?: string // populated only when action === 'summarize'
	checkpointHash?: string
}

// Inviolable rules enforced regardless of model output.
export const JANITOR_INVIOLABLE_RULES = {
	NEVER_DISCARD_USER: "Never discard or summarize a human turn",
	NEVER_DISCARD_ERRORS: "Never discard messages containing active errors or tracebacks",
	NEVER_DISCARD_DIFFS: "Never discard messages containing active file diffs",
	NEVER_DISCARD_OPEN_TASKS: "Never discard messages referencing open or incomplete tasks",
	NEVER_DISCARD_CONSTRAINTS: "Never discard explicit user constraints or instructions",
} as const

export interface LedgerEntry {
	id: string // ulid-style: timestamp-random
	taskId: string
	timestamp: string // ISO-8601
	rawTokens: number
	curatedTokens: number
	messagesProcessed: number
	decisions: JanitorDecision[]
	checkpointHash?: string
	backendSwitchAvoided: boolean
}

export interface ActiveContextPack {
	taskGoal: string
	keyConstraints: string[]
	activeErrors: string[]
	activeDiffs: string[]
	openTasks: string[]
	recentDecisions: string[]
	lastUpdated: string // ISO-8601
}

// Minimal message shape compatible with Anthropic SDK and Cline's internal types.
export interface JanitorMessage {
	role: "user" | "assistant"
	content:
		| string
		| Array<{
				type: string
				text?: string
				content?: string | Array<{ type: string; text?: string }>
				[key: string]: unknown
		  }>
}

export interface JanitorRunResult {
	curatedMessages: JanitorMessage[]
	rawTokensBefore: number
	curatedTokensAfter: number
	backendSwitchAvoided: boolean
	/** True when only HeadroomAdapter compression ran (no model call, no ledger entry). */
	headroomOnly?: boolean
	// Absent on headroom-only runs — the model janitor did not execute.
	activeContextPack?: ActiveContextPack
	ledgerEntryId?: string
}

export interface JanitorSettings {
	enabled: boolean
	triggerTokens: number
	growthTriggerTokens: number
	modelEndpoint: string
	modelId: string
	maxLatencyMs: number
	headroomEnabled: boolean
}

// Defaults tuned for the MacM4LocalAgent hybrid stack (2026-07-02):
//
// - triggerTokens 24K / growth 8K: the janitor's estimate only sees the
//   conversation -- the ~75K-token tools+system wire overhead is invisible
//   to it -- and the proxy escalates to Claude at 85% of local-long's 131K
//   num_ctx (~111K wire ≈ ~36K conversation-visible). The old 64K trigger
//   sat ABOVE the point where the wire request already blows the local
//   ceiling, so the janitor never fired before the session was lost.
// - modelId claude-code: curation is a huge-input/small-output call with
//   no shared KV prefix -- on the local 80B it's a 6+ minute cold prefill
//   that head-of-line-blocks the session behind Ollama's Parallel:1; on
//   the Claude subscription tier it completes in seconds for ~zero cost.
// - maxLatencyMs 90K: headroom for proxy round-trips + subscription 429
//   backoff; abort propagation (streaming) frees upstream on expiry.
export const DEFAULT_JANITOR_SETTINGS: JanitorSettings = {
	enabled: false,
	triggerTokens: 24_000,
	growthTriggerTokens: 8_000,
	modelEndpoint: "http://127.0.0.1:4000",
	modelId: "claude-code",
	maxLatencyMs: 90_000,
	headroomEnabled: true,
}

// Error keywords used to enforce NEVER_DISCARD_ERRORS.
export const ERROR_KEYWORDS = [
	"error",
	"Error",
	"traceback",
	"Traceback",
	"exception",
	"Exception",
	"failed",
	"Failed",
	"FAILED",
	"fatal",
	"Fatal",
	"FATAL",
	"panic",
	"Panic",
]

// Diff markers used to enforce NEVER_DISCARD_DIFFS.
export const DIFF_MARKERS = ["--- a/", "+++ b/", "@@ ", "diff --git"]
