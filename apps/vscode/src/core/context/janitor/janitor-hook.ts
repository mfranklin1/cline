// ============================================================================
// Context Janitor — beforeModel hook adapter for the v4.x SDK agent runtime.
//
// In v4.x, the insertion point for context curation moved from the old
// src/core/task/index.ts to the SDK's beforeModel hook system. This module
// bridges the ContextJanitorService into that hook.
//
// Usage (in sdk-session-config-builder.ts):
//   const janitorHook = createJanitorBeforeModelHook(stateManager, storageDir)
//   // Then call janitorHook(ctx) inside the beforeModel chain.
// ============================================================================

import type { AgentBeforeModelContext, AgentBeforeModelResult, AgentMessage, AgentMessagePart } from "@cline/shared"
import path from "path"
import type { StateManager } from "@/core/storage/StateManager"
import { ContextJanitorService, DEFAULT_JANITOR_SETTINGS } from "./index"
import type { JanitorMessage } from "./types"

// Serialize one SDK content part to the text the janitor reasons over.
// Tool results carry their payload in `output` (type "tool-result", not
// "text") — dropping them would hide almost all context tokens from the
// janitor's budgeter, so the trigger thresholds would never fire.
function partToText(part: AgentMessagePart): string {
	switch (part.type) {
		case "text":
		case "reasoning":
			return part.text ?? ""
		case "tool-call":
			return `[tool call ${part.toolName}] ${typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {})}`
		case "tool-result":
			return typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "")
		case "file":
			return part.content
		default:
			return ""
	}
}

function messageText(msg: AgentMessage): string {
	return msg.content.map(partToText).filter(Boolean).join("\n")
}

function hasPartType(msg: AgentMessage, type: AgentMessagePart["type"]): boolean {
	return msg.content.some((p) => p.type === type)
}

// The janitor's message model only knows user/assistant; tool results are
// user-side turns (which also puts them under the NEVER_DISCARD_USER rule).
function janitorRole(msg: AgentMessage): "user" | "assistant" {
	return msg.role === "tool" ? "user" : (msg.role as "user" | "assistant")
}

function agentMessageToJanitor(msg: AgentMessage): JanitorMessage {
	const text = messageText(msg)
	// Tool results ride in a tool_result block so HeadroomAdapter's mechanical
	// compression (truncation, install/test-output squashing, file-read dedup)
	// applies to them and never to human-authored text, which travels as a
	// text block that headroom leaves untouched.
	if (hasPartType(msg, "tool-result")) {
		return { role: janitorRole(msg), content: [{ type: "tool_result", content: text }] }
	}
	return { role: janitorRole(msg), content: [{ type: "text", text }] }
}

// Extract the comparable text from a curated JanitorMessage (string, text
// blocks, or tool_result blocks — mirrors what agentMessageToJanitor emits
// and what HeadroomAdapter/applyDecisions may rewrite it into).
function janitorContentToText(content: JanitorMessage["content"]): string {
	if (typeof content === "string") {
		return content
	}
	return content
		.map((block) => {
			if (typeof block.text === "string") return block.text
			if (typeof block.content === "string") return block.content
			if (Array.isArray(block.content)) return block.content.map((inner) => inner.text ?? "").join("")
			return ""
		})
		.filter(Boolean)
		.join("\n")
}

function carriesToolParts(msg: AgentMessage): boolean {
	return hasPartType(msg, "tool-call") || hasPartType(msg, "tool-result")
}

function matchCuratedBack(curatedJanitor: JanitorMessage[], original: readonly AgentMessage[]): readonly AgentMessage[] {
	// Best-effort: match curated messages back to originals by janitor-side
	// role. Originals skipped while advancing were discarded by the janitor —
	// except messages carrying tool-call/tool-result parts, which must survive
	// or the provider transform would see orphaned tool calls.
	const result: AgentMessage[] = []
	let origIdx = 0

	const keepIfToolBearing = (msg: AgentMessage) => {
		if (carriesToolParts(msg)) {
			result.push(msg)
		}
	}

	for (const curated of curatedJanitor) {
		while (origIdx < original.length && janitorRole(original[origIdx]) !== curated.role) {
			keepIfToolBearing(original[origIdx])
			origIdx++
		}
		const orig = original[origIdx]
		if (!orig) {
			// Janitor produced a message with no original counterpart (shouldn't happen).
			continue
		}

		const curatedText = janitorContentToText(curated.content)
		const origText = messageText(orig)

		if (curatedText === origText || !curatedText) {
			// Unchanged or empty summary — keep original verbatim.
			result.push(orig)
		} else if (hasPartType(orig, "tool-call")) {
			// Never rewrite a message that issues tool calls — its paired
			// tool results must keep matching the provider's expectations.
			result.push(orig)
		} else if (hasPartType(orig, "tool-result")) {
			const toolResults = orig.content.filter((p) => p.type === "tool-result")
			if (toolResults.length === 1) {
				// Preserve toolCallId/toolName so the provider transform stays
				// valid; the curated text already includes any sibling text
				// parts, so drop those to avoid duplication.
				result.push({
					...orig,
					content: orig.content
						.filter((p) => p.type !== "text" && p.type !== "reasoning")
						.map((p) => (p.type === "tool-result" ? { ...p, output: curatedText } : p)),
				})
			} else {
				// Can't split one curated text across multiple results — keep verbatim.
				result.push(orig)
			}
		} else {
			// Summarized — rebuild with updated text content, preserve metadata.
			result.push({
				...orig,
				content: [{ type: "text", text: curatedText }],
			})
		}

		origIdx++
	}

	// Tail originals past the last curated message: legitimately discarded,
	// unless they carry tool parts.
	for (; origIdx < original.length; origIdx++) {
		keepIfToolBearing(original[origIdx])
	}

	return result
}

export function createJanitorBeforeModelHook(
	stateManager: StateManager,
	globalStorageDir: string,
): (ctx: AgentBeforeModelContext) => Promise<AgentBeforeModelResult | undefined> {
	let service: ContextJanitorService | undefined

	return async (ctx: AgentBeforeModelContext): Promise<AgentBeforeModelResult | undefined> => {
		const janitorEnabled = stateManager.getGlobalSettingsKey("contextJanitorEnabled")
		const headroomEnabled = stateManager.getGlobalSettingsKey("contextJanitorHeadroomEnabled") ?? true

		if (!janitorEnabled && !headroomEnabled) {
			return undefined
		}

		const settings = {
			...DEFAULT_JANITOR_SETTINGS,
			enabled: !!janitorEnabled,
			headroomEnabled: !!headroomEnabled,
			triggerTokens:
				stateManager.getGlobalSettingsKey("contextJanitorTriggerTokens") ?? DEFAULT_JANITOR_SETTINGS.triggerTokens,
			growthTriggerTokens:
				stateManager.getGlobalSettingsKey("contextJanitorGrowthTriggerTokens") ??
				DEFAULT_JANITOR_SETTINGS.growthTriggerTokens,
			modelEndpoint:
				stateManager.getGlobalSettingsKey("contextJanitorModelEndpoint") ?? DEFAULT_JANITOR_SETTINGS.modelEndpoint,
			modelId: stateManager.getGlobalSettingsKey("contextJanitorModelId") ?? DEFAULT_JANITOR_SETTINGS.modelId,
			maxLatencyMs:
				stateManager.getGlobalSettingsKey("contextJanitorMaxLatencyMs") ?? DEFAULT_JANITOR_SETTINGS.maxLatencyMs,
		}

		const taskId = ctx.snapshot.conversationId ?? ctx.snapshot.agentId
		const storageDir = path.join(globalStorageDir, "janitor")

		if (!service) {
			service = new ContextJanitorService(settings, taskId, storageDir)
		} else {
			// Settings can change at runtime (toggles in the UI) — keep the
			// lazily-created service in sync instead of freezing first-call values.
			service.updateSettings(settings)
		}

		const messages = ctx.request.messages
		const janitorMessages: JanitorMessage[] = messages
			.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
			.map(agentMessageToJanitor)

		try {
			const result = await service.maybeRunJanitor(janitorMessages)
			if (!result) {
				return undefined
			}
			const curated = matchCuratedBack(result.curatedMessages, messages)
			return { messages: curated }
		} catch {
			// Janitor errors must never block the API call.
			return undefined
		}
	}
}
