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

	// Extract the assistant message content from a completion response body.
	// Handles both SSE streaming bodies ("data: {...}" chunk lines, the shape we
	// request via stream: true) and plain JSON bodies (servers that ignore the
	// stream flag), so a proxy downgrade never breaks the janitor.
	private static parseCompletionContent(bodyText: string): string {
		const trimmed = bodyText.trim()
		if (!trimmed) return ""

		// SSE bodies carry "data:" event lines (possibly preceded by comment
		// lines); anything else is a plain JSON completion.
		const isSse = /^data:/m.test(trimmed)
		if (!isSse) {
			const data = JSON.parse(trimmed) as {
				choices?: Array<{ message?: { content?: string } }>
			}
			return data?.choices?.[0]?.message?.content ?? ""
		}

		let content = ""
		for (const rawLine of trimmed.split("\n")) {
			const line = rawLine.trim()
			if (!line.startsWith("data:")) continue
			const payload = line.slice("data:".length).trim()
			if (!payload || payload === "[DONE]") continue
			try {
				const chunk = JSON.parse(payload) as {
					choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
				}
				content += chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? ""
			} catch {
				// Malformed keep-alive/comment line — skip it, keep accumulating.
			}
		}
		return content
	}

	async getCleanupDecisions(
		messages: JanitorMessage[],
		activeContextPack: ActiveContextPack,
		maxLatencyMs: number,
		abandonSignal?: AbortSignal,
	): Promise<JanitorDecision[]> {
		if (messages.length === 0) return []
		// The run was abandoned before we started — don't fire a request at all.
		if (abandonSignal?.aborted) return []

		// Latency-cap abort: when the timer wins, controller.abort() must tear
		// down the in-flight HTTP request (client disconnect), not just abandon
		// the local promise — otherwise the model server keeps generating for an
		// orphaned client (observed: a local Ollama grinding for the proxy's full
		// 480s request_timeout behind a 45s janitor cap, head-of-line-blocking
		// the session's real API calls).
		const controller = new AbortController()
		const timeoutId = setTimeout(
			() => controller.abort(new Error(`Context Janitor latency cap (${maxLatencyMs}ms) exceeded`)),
			maxLatencyMs,
		)
		// Also abort the request if the janitor run is abandoned externally
		// (task cancelled / session torn down) while the model call is in flight.
		const onAbandon = () => controller.abort(abandonSignal?.reason ?? new Error("Context Janitor run abandoned"))
		abandonSignal?.addEventListener("abort", onAbandon, { once: true })

		try {
			const prompt = this.buildJanitorPrompt(messages, activeContextPack)
			// stream: true is load-bearing for abort propagation. With a buffered
			// (non-streaming) completion, an OpenAI-compatible proxy in the middle
			// (e.g. LiteLLM) has no cancellation point: our disconnect closes the
			// client socket, but the proxy keeps awaiting the upstream model until
			// its own request_timeout. A streaming response is delivered through
			// the proxy chunk-by-chunk, so aborting mid-stream is observed by the
			// proxy immediately and cancellation reaches the model server (Ollama
			// honors client disconnects and stops generation).
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
					stream: true,
				}),
			})

			if (!response.ok) {
				return []
			}

			// text() consumes the body under the same abort signal, so the
			// latency cap also covers a response that starts quickly but streams
			// slowly.
			const bodyText = await response.text()
			const content = JanitorModelClient.parseCompletionContent(bodyText)
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
			// Timeout, abort, network error, or JSON parse failure — safe
			// fallback: keep everything. Janitor failures must never throw into
			// the beforeModel hook path.
			return []
		} finally {
			clearTimeout(timeoutId)
			abandonSignal?.removeEventListener("abort", onAbandon)
		}
	}
}
