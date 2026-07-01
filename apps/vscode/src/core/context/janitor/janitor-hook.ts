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

import type { AgentBeforeModelContext, AgentBeforeModelResult, AgentMessage } from "@cline/shared"
import path from "path"
import type { StateManager } from "@/core/storage/StateManager"
import { ContextJanitorService, DEFAULT_JANITOR_SETTINGS } from "./index"
import type { JanitorMessage } from "./types"

function agentMessageToJanitor(msg: AgentMessage): JanitorMessage {
	const role = msg.role === "tool" ? "user" : (msg.role as "user" | "assistant")
	const parts = msg.content
	const textParts = parts.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text").map((p) => p.text)
	const content = textParts.length === 1 ? textParts[0] : textParts.join("\n")
	return { role, content: content || "" }
}

function matchCuratedBack(curatedJanitor: JanitorMessage[], original: readonly AgentMessage[]): readonly AgentMessage[] {
	// Best-effort: match curated messages back to originals by content.
	// For summarized entries (content changed), create new AgentMessage shells
	// that reuse the original's id and metadata but with updated content.
	const result: AgentMessage[] = []
	let origIdx = 0

	for (const curated of curatedJanitor) {
		// Advance origIdx to find a matching original by role.
		while (origIdx < original.length && original[origIdx].role !== curated.role) {
			origIdx++
		}
		const orig = original[origIdx]
		if (!orig) {
			// Janitor produced a message with no original counterpart (shouldn't happen).
			continue
		}

		const curatedText = typeof curated.content === "string" ? curated.content : ""
		const origText = orig.content
			.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
			.map((p) => p.text)
			.join("\n")

		if (curatedText === origText || !curatedText) {
			// Unchanged or empty summary — keep original verbatim.
			result.push(orig)
		} else {
			// Summarized — rebuild with updated text content, preserve metadata.
			result.push({
				...orig,
				content: [{ type: "text", text: curatedText }],
			})
		}

		origIdx++
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

		// Lazily instantiate the service (settings can change at runtime).
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
