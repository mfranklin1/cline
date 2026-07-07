import { ContextBudgeter } from "./ContextBudgeter"
import { ContextLedger } from "./ContextLedger"
import { HeadroomAdapter } from "./HeadroomAdapter"
import { JanitorModelClient } from "./JanitorModelClient"
import {
	ActiveContextPack,
	DEFAULT_JANITOR_SETTINGS,
	DIFF_MARKERS,
	ERROR_KEYWORDS,
	JanitorDecision,
	JanitorMessage,
	JanitorRunResult,
	JanitorSettings,
	LedgerEntry,
} from "./types"

function generateId(): string {
	// Simple timestamp + random suffix — no Date.now() in workflows, but this is runtime code.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function messageContainsError(msg: JanitorMessage): boolean {
	const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
	return ERROR_KEYWORDS.some((kw) => text.includes(kw))
}

function messageContainsDiff(msg: JanitorMessage): boolean {
	const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
	return DIFF_MARKERS.some((marker) => text.includes(marker))
}

function extractTaskGoal(messages: JanitorMessage[]): string {
	// Last user message is the current goal.
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			const text =
				typeof messages[i].content === "string" ? (messages[i].content as string) : JSON.stringify(messages[i].content)
			return text.slice(0, 200)
		}
	}
	return "unknown"
}

function buildActiveContextPack(messages: JanitorMessage[]): ActiveContextPack {
	const errors: string[] = []
	const diffs: string[] = []
	const constraints: string[] = []

	for (const msg of messages) {
		const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
		if (messageContainsError(msg)) {
			const line = text.split("\n").find((l) => ERROR_KEYWORDS.some((kw) => l.includes(kw))) ?? ""
			if (line) errors.push(line.slice(0, 120))
		}
		if (messageContainsDiff(msg)) {
			const diffLine = text.split("\n").find((l) => l.startsWith("diff --git") || l.startsWith("--- a/")) ?? ""
			if (diffLine) diffs.push(diffLine.slice(0, 120))
		}
		if (msg.role === "user" && /(must|never|always|do not|don't|require|ensure)/i.test(text)) {
			const sentences = text.match(/[^.!?]*(?:must|never|always|do not|don't|require|ensure)[^.!?]*/gi) ?? []
			constraints.push(...sentences.slice(0, 3).map((s) => s.trim().slice(0, 120)))
		}
	}

	return {
		taskGoal: extractTaskGoal(messages),
		keyConstraints: [...new Set(constraints)].slice(0, 10),
		activeErrors: [...new Set(errors)].slice(0, 5),
		activeDiffs: [...new Set(diffs)].slice(0, 5),
		openTasks: [],
		recentDecisions: [],
		lastUpdated: new Date().toISOString(),
	}
}

function applyDecisions(messages: JanitorMessage[], decisions: JanitorDecision[]): JanitorMessage[] {
	const decisionMap = new Map<number, JanitorDecision>()
	for (const d of decisions) {
		decisionMap.set(d.messageIndex, d)
	}

	const result: JanitorMessage[] = []

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		const decision = decisionMap.get(i)

		if (!decision || decision.action === "keep") {
			result.push(msg)
			continue
		}

		// Enforce inviolable rules regardless of model output.
		// NEVER_DISCARD_USER protects HUMAN turns. In the v4 runtime tool
		// results also travel under the user role, but they are machine
		// output — the exact content curation exists to trim — so messages
		// the hook flagged isToolResult are exempt from the user veto (mixed
		// human-text + tool-result messages are never flagged, so they stay
		// protected). Error- and diff-bearing messages stay protected
		// unconditionally, tool result or not.
		const isProtectedHumanTurn = msg.role === "user" && msg.isToolResult !== true
		const hasError = messageContainsError(msg)
		const hasDiff = messageContainsDiff(msg)

		if (isProtectedHumanTurn || hasError || hasDiff) {
			// Force keep.
			result.push(msg)
			continue
		}

		switch (decision.action) {
			case "summarize":
				if (decision.summary) {
					// Spread preserves role and isToolResult so downstream
					// consumers keep the provenance.
					result.push({ ...msg, content: `[Summarized by Context Janitor]: ${decision.summary}` })
				} else {
					result.push(msg)
				}
				break
			case "archive":
			case "discard":
				if (msg.isToolResult) {
					// A fully-dropped tool result would be re-inserted
					// verbatim by the hook's matchCuratedBack (tool-call
					// pairing must never be orphaned), silently undoing the
					// archive. Keep a tiny tombstone instead: the pairing
					// anchor survives while the payload tokens are released.
					result.push({
						...msg,
						content: [{ type: "tool_result", content: `[Archived by Context Janitor]: ${decision.reason}` }],
					})
				}
				// Otherwise exclude from result.
				break
			default:
				result.push(msg)
		}
	}

	return result
}

export class ContextJanitorService {
	private readonly headroomAdapter: HeadroomAdapter
	private readonly budgeter: ContextBudgeter
	private readonly ledger: ContextLedger
	private readonly modelClient: JanitorModelClient
	private settings: JanitorSettings
	private currentTaskId: string

	constructor(
		settings: JanitorSettings,
		taskId: string,
		storageDir: string,
		// Allow injection for testing.
		overrides?: { modelClient?: JanitorModelClient; ledger?: ContextLedger; budgeter?: ContextBudgeter },
	) {
		this.settings = { ...DEFAULT_JANITOR_SETTINGS, ...settings }
		this.currentTaskId = taskId
		this.headroomAdapter = new HeadroomAdapter()
		this.budgeter = overrides?.budgeter ?? new ContextBudgeter()
		this.ledger = overrides?.ledger ?? new ContextLedger(storageDir)
		this.modelClient = overrides?.modelClient ?? new JanitorModelClient(this.settings)
	}

	resetForNewTask(taskId: string): void {
		this.currentTaskId = taskId
		this.budgeter.reset()
	}

	updateSettings(settings: Partial<JanitorSettings>): void {
		this.settings = { ...this.settings, ...settings }
	}

	// When the model janitor doesn't run, headroom compression must still reach
	// the caller — returning null here would discard it (the caller falls back
	// to the original messages).
	private headroomOnlyResult(compressedMessages: JanitorMessage[], rawTokensBefore: number): JanitorRunResult | null {
		if (!this.settings.headroomEnabled) {
			return null
		}
		const curatedTokensAfter = this.budgeter.estimateTokens(compressedMessages)
		if (curatedTokensAfter >= rawTokensBefore) {
			return null
		}
		return {
			curatedMessages: compressedMessages,
			rawTokensBefore,
			curatedTokensAfter,
			backendSwitchAvoided: false,
			headroomOnly: true,
		}
	}

	async maybeRunJanitor(messages: JanitorMessage[], abandonSignal?: AbortSignal): Promise<JanitorRunResult | null> {
		// Step 1: HeadroomAdapter — mechanical compression, always run if headroomEnabled.
		const compressedMessages = this.settings.headroomEnabled ? this.headroomAdapter.compress(messages) : messages

		const rawTokensBefore = this.budgeter.estimateTokens(messages)

		// Step 2: Check if full janitor (model call) should run.
		if (!this.settings.enabled || !this.budgeter.shouldRunJanitor(compressedMessages, this.settings)) {
			return this.headroomOnlyResult(compressedMessages, rawTokensBefore)
		}

		// Step 3: Load existing active context pack.
		const existingPack = await this.ledger.getActiveContextPack(this.currentTaskId).catch(() => null)
		const contextPack = existingPack ?? buildActiveContextPack(compressedMessages)

		// Step 4: Get semantic decisions from local model. The abandon signal
		// aborts the in-flight HTTP request if the janitor run is abandoned
		// (e.g. the task is cancelled) so no orphaned generation keeps running
		// server-side.
		const decisions = await this.modelClient.getCleanupDecisions(
			compressedMessages,
			contextPack,
			this.settings.maxLatencyMs,
			abandonSignal,
		)

		// If model returned nothing (timeout/error), bail out safely —
		// but still surface headroom's mechanical compression.
		if (decisions.length === 0) {
			return this.headroomOnlyResult(compressedMessages, rawTokensBefore)
		}

		// Step 5: Apply decisions with inviolable rule enforcement.
		const curatedMessages = applyDecisions(compressedMessages, decisions)

		// Step 6: Build updated active context pack.
		const updatedPack = buildActiveContextPack(curatedMessages)

		// Step 7: Persist to ledger.
		const curatedTokensAfter = this.budgeter.estimateTokens(curatedMessages)
		const backendSwitchAvoided =
			rawTokensBefore > this.settings.triggerTokens && curatedTokensAfter <= this.settings.triggerTokens

		const entryId = generateId()
		const entry: LedgerEntry = {
			id: entryId,
			taskId: this.currentTaskId,
			timestamp: new Date().toISOString(),
			rawTokens: rawTokensBefore,
			curatedTokens: curatedTokensAfter,
			messagesProcessed: compressedMessages.length,
			decisions,
			backendSwitchAvoided,
		}

		await Promise.allSettled([
			this.ledger.appendEntry(entry),
			this.ledger.saveActiveContextPack(this.currentTaskId, updatedPack),
		])

		// Step 8: Update budgeter.
		this.budgeter.recordRun(curatedTokensAfter)

		return {
			curatedMessages,
			activeContextPack: updatedPack,
			rawTokensBefore,
			curatedTokensAfter,
			backendSwitchAvoided,
			ledgerEntryId: entryId,
		}
	}
}
