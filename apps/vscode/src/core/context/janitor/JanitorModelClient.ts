import { fetch } from "@/shared/net"
import { ActiveContextPack, JANITOR_INVIOLABLE_RULES, JanitorDecision, JanitorMessage, JanitorSettings } from "./types"

const PROMPT_CONTENT_PREVIEW_CHARS = 400

function previewContent(msg: JanitorMessage, index: number): string {
	let text = ""
	if (typeof msg.content === "string") {
		text = msg.content
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (typeof block.text === "string") text += block.text
			if (typeof block.content === "string") text += block.content
		}
	}
	const preview = text.slice(0, PROMPT_CONTENT_PREVIEW_CHARS)
	const truncated =
		text.length > PROMPT_CONTENT_PREVIEW_CHARS ? `... [${text.length - PROMPT_CONTENT_PREVIEW_CHARS} more chars]` : ""
	return `[${index}] role=${msg.role}\n${preview}${truncated}`
}

export class JanitorModelClient {
	constructor(private readonly settings: JanitorSettings) {}

	private buildJanitorPrompt(messages: JanitorMessage[], pack: ActiveContextPack): string {
		const rules = Object.values(JANITOR_INVIOLABLE_RULES)
			.map((r) => `- ${r}`)
			.join("\n")
		const packSummary = [
			`Goal: ${pack.taskGoal || "unknown"}`,
			pack.keyConstraints.length ? `Constraints: ${pack.keyConstraints.join("; ")}` : "",
			pack.activeErrors.length ? `Active errors: ${pack.activeErrors.join("; ")}` : "",
			pack.activeDiffs.length ? `Active diffs: ${pack.activeDiffs.join("; ")}` : "",
			pack.openTasks.length ? `Open tasks: ${pack.openTasks.join("; ")}` : "",
		]
			.filter(Boolean)
			.join("\n")

		const messageList = messages.map((m, i) => previewContent(m, i)).join("\n\n---\n\n")

		return `You are a context cleanup assistant for an AI coding agent. Your job is to classify each conversation message so that less relevant history can be removed, reducing token usage before a new LLM call.

INVIOLABLE RULES (never violate these regardless of relevance):
${rules}

CURRENT TASK CONTEXT:
${packSummary}

MESSAGES TO CLASSIFY (${messages.length} total):
${messageList}

Classify each message by its index. Return ONLY valid JSON in this exact format:
{
  "decisions": [
    {"messageIndex": 0, "action": "keep", "reason": "recent user instruction", "confidence": 0.95},
    {"messageIndex": 1, "action": "summarize", "reason": "redundant tool output", "confidence": 0.8, "summary": "Ran tests; 3 passed, 1 failed on auth.test.ts"},
    {"messageIndex": 2, "action": "archive", "reason": "stale file read, file changed since", "confidence": 0.9}
  ]
}

Actions:
- keep: Include message as-is (required for user turns, errors, diffs)
- summarize: Replace with the summary field (provide a concise 1-2 sentence summary)
- archive: Exclude from context (stale, superseded, or irrelevant)
- discard: Exclude (genuinely useless, no information value)

Be conservative. When in doubt, use keep. Only archive/discard old tool results with no remaining relevance.`
	}

	async getCleanupDecisions(
		messages: JanitorMessage[],
		activeContextPack: ActiveContextPack,
		maxLatencyMs: number,
	): Promise<JanitorDecision[]> {
		if (messages.length === 0) return []

		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), maxLatencyMs)

		try {
			const prompt = this.buildJanitorPrompt(messages, activeContextPack)
			const response = await fetch(`${this.settings.modelEndpoint}/v1/chat/completions`, {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.settings.modelId,
					messages: [{ role: "user", content: prompt }],
					temperature: 0.1,
					max_tokens: 4096,
					response_format: { type: "json_object" },
				}),
			})

			if (!response.ok) {
				return []
			}

			const data = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>
			}
			const content = data?.choices?.[0]?.message?.content
			if (!content) return []

			// Strip any markdown fences the model may have added.
			const cleaned = content
				.replace(/^```json\s*/i, "")
				.replace(/\s*```$/, "")
				.trim()
			const parsed = JSON.parse(cleaned) as { decisions?: JanitorDecision[] }
			if (!Array.isArray(parsed?.decisions)) return []
			return parsed.decisions
		} catch {
			// Timeout, network error, or JSON parse failure — safe fallback: keep everything.
			return []
		} finally {
			clearTimeout(timeoutId)
		}
	}
}
