import { expect } from "chai"
import { mockFetchForTesting } from "@/shared/net"
import { JanitorModelClient } from "../JanitorModelClient"
import { ActiveContextPack, DEFAULT_JANITOR_SETTINGS, JanitorDecision, JanitorMessage } from "../types"

type MockFetch = Parameters<typeof mockFetchForTesting>[0]

function makeMsg(role: "user" | "assistant", content: string): JanitorMessage {
	return { role, content }
}

function makePack(): ActiveContextPack {
	return {
		taskGoal: "fix login bug",
		keyConstraints: ["never use global fetch"],
		activeErrors: ["TypeError: foo"],
		activeDiffs: ["--- a/auth.ts"],
		openTasks: ["write tests"],
		recentDecisions: [],
		lastUpdated: new Date().toISOString(),
	}
}

// Build an OpenAI-compatible SSE streaming body carrying `content` split into
// delta chunks — the shape the client requests via stream: true.
function sseBody(content: string, chunkSize = 16): string {
	const lines: string[] = []
	for (let i = 0; i < content.length; i += chunkSize) {
		const delta = content.slice(i, i + chunkSize)
		lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}`)
		lines.push("")
	}
	lines.push("data: [DONE]")
	lines.push("")
	return lines.join("\n")
}

function textResponse(body: string, ok = true): MockFetch {
	return (async () =>
		({
			ok,
			text: async () => body,
		}) as Response) as unknown as MockFetch
}

function mockOkResponse(decisions: JanitorDecision[]): MockFetch {
	return textResponse(sseBody(JSON.stringify({ decisions })))
}

// A fetch that never responds but honours the AbortSignal like a real fetch:
// the returned promise rejects with AbortError when the signal fires. Captures
// the signal so tests can assert abort propagation reached the request.
function hangingFetch(capture: { signal?: AbortSignal; calls: number }): MockFetch {
	return ((_input: string | URL | Request, init?: RequestInit) => {
		capture.calls += 1
		capture.signal = init?.signal ?? undefined
		return new Promise<Response>((_resolve, reject) => {
			if (init?.signal?.aborted) {
				reject(new DOMException("This operation was aborted", "AbortError"))
				return
			}
			init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), {
				once: true,
			})
		})
	}) as unknown as MockFetch
}

describe("JanitorModelClient", () => {
	const settings = {
		...DEFAULT_JANITOR_SETTINGS,
		modelEndpoint: "http://127.0.0.1:4000",
		modelId: "local-long",
	}

	describe("getCleanupDecisions", () => {
		it("returns empty array for empty messages", async () => {
			const client = new JanitorModelClient(settings)
			const result = await client.getCleanupDecisions([], makePack(), 5_000)
			expect(result).to.deep.equal([])
		})

		it("returns parsed decisions on a successful streaming response", async () => {
			const decisions: JanitorDecision[] = [
				{ messageIndex: 0, action: "keep", reason: "user turn", confidence: 1.0 },
				{ messageIndex: 1, action: "archive", reason: "stale", confidence: 0.9 },
			]
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello"), makeMsg("assistant", "hi there")]

			await mockFetchForTesting(mockOkResponse(decisions), async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.have.length(2)
				expect(result[0].action).to.equal("keep")
				expect(result[1].action).to.equal("archive")
			})
		})

		it("requests a streaming completion and passes an abort signal to fetch", async () => {
			const decisions: JanitorDecision[] = [{ messageIndex: 0, action: "keep", reason: "user turn", confidence: 1.0 }]
			let capturedInit: RequestInit | undefined
			const capturingFetch: MockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
				capturedInit = init
				return {
					ok: true,
					text: async () => sseBody(JSON.stringify({ decisions })),
				} as Response
			}) as unknown as MockFetch

			const client = new JanitorModelClient(settings)
			await mockFetchForTesting(capturingFetch, async () => {
				await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 5_000)
			})

			expect(capturedInit?.signal, "fetch must receive an AbortSignal").to.be.an.instanceOf(AbortSignal)
			const body = JSON.parse(String(capturedInit?.body)) as { stream?: boolean }
			expect(body.stream, "request must be streaming so proxies observe client disconnects").to.equal(true)
			const headers = capturedInit?.headers as Record<string, string> | undefined
			expect(headers?.["X-LLM-Intent"], "janitor must self-identify for proxy-side attribution").to.equal(
				"context-janitor",
			)
		})

		it("falls back to parsing a plain JSON body when the server ignores stream:true", async () => {
			const decisions: JanitorDecision[] = [{ messageIndex: 0, action: "keep", reason: "recent", confidence: 1.0 }]
			const plainBody = JSON.stringify({
				choices: [{ message: { content: JSON.stringify({ decisions }) } }],
			})
			const client = new JanitorModelClient(settings)

			await mockFetchForTesting(textResponse(plainBody), async () => {
				const result = await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 5_000)
				expect(result).to.have.length(1)
				expect(result[0].action).to.equal("keep")
			})
		})

		it("aborts the fetch when the latency cap fires and resolves with an empty array (never throws)", async () => {
			const capture: { signal?: AbortSignal; calls: number } = { calls: 0 }
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]

			const startedAt = Date.now()
			await mockFetchForTesting(hangingFetch(capture), async () => {
				// Must resolve (not reject) even though the request hung past the cap.
				const result = await client.getCleanupDecisions(messages, makePack(), 50)
				expect(result).to.deep.equal([])
			})

			expect(capture.calls).to.equal(1)
			expect(capture.signal, "fetch must receive the latency-cap AbortSignal").to.be.an.instanceOf(AbortSignal)
			expect(capture.signal?.aborted, "latency cap must abort the in-flight request").to.equal(true)
			// Sanity: we returned at the cap, not after some longer internal timeout.
			expect(Date.now() - startedAt).to.be.lessThan(5_000)
		})

		it("does not abort the signal when the request completes within the latency cap", async () => {
			const decisions: JanitorDecision[] = [{ messageIndex: 0, action: "keep", reason: "user turn", confidence: 1.0 }]
			let capturedSignal: AbortSignal | undefined
			const capturingFetch: MockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
				capturedSignal = init?.signal ?? undefined
				return {
					ok: true,
					text: async () => sseBody(JSON.stringify({ decisions })),
				} as Response
			}) as unknown as MockFetch

			const client = new JanitorModelClient(settings)
			await mockFetchForTesting(capturingFetch, async () => {
				const result = await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 5_000)
				expect(result).to.have.length(1)
			})

			// Give the (cleared) latency-cap timer a beat: the signal must stay unaborted.
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(capturedSignal?.aborted).to.equal(false)
		})

		it("aborts the in-flight request when the abandon signal fires", async () => {
			const capture: { signal?: AbortSignal; calls: number } = { calls: 0 }
			const abandon = new AbortController()
			const client = new JanitorModelClient(settings)

			await mockFetchForTesting(hangingFetch(capture), async () => {
				const pending = client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 60_000, abandon.signal)
				setTimeout(() => abandon.abort(), 10)
				const result = await pending
				expect(result).to.deep.equal([])
			})

			expect(capture.signal?.aborted, "abandoning the run must abort the in-flight request").to.equal(true)
		})

		it("does not issue a request when the abandon signal is already aborted", async () => {
			const capture: { signal?: AbortSignal; calls: number } = { calls: 0 }
			const abandon = new AbortController()
			abandon.abort()
			const client = new JanitorModelClient(settings)

			await mockFetchForTesting(hangingFetch(capture), async () => {
				const result = await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 60_000, abandon.signal)
				expect(result).to.deep.equal([])
			})

			expect(capture.calls).to.equal(0)
		})

		it("returns empty array when the fetch rejects (network error) without throwing", async () => {
			const failing: MockFetch = (async () => {
				throw new Error("ECONNREFUSED")
			}) as unknown as MockFetch
			const client = new JanitorModelClient(settings)

			await mockFetchForTesting(failing, async () => {
				const result = await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when the streamed content is empty", async () => {
			const client = new JanitorModelClient(settings)
			await mockFetchForTesting(textResponse(sseBody("")), async () => {
				const result = await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when model returns non-ok HTTP status", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]
			const failFetch: MockFetch = (async () => ({ ok: false, status: 503 }) as Response) as unknown as MockFetch

			await mockFetchForTesting(failFetch, async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when model response content is invalid JSON", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]

			await mockFetchForTesting(textResponse(sseBody("not json {{{{")), async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when model response is missing decisions field", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]

			await mockFetchForTesting(textResponse(sseBody('{"other": "data"}')), async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("skips malformed SSE lines while accumulating valid chunks", async () => {
			const decisions: JanitorDecision[] = [{ messageIndex: 0, action: "keep", reason: "recent", confidence: 1.0 }]
			const content = JSON.stringify({ decisions })
			const body = [": keep-alive comment", "data: not-json-at-all", ...sseBody(content).split("\n")].join("\n")
			const client = new JanitorModelClient(settings)

			await mockFetchForTesting(textResponse(body), async () => {
				const result = await client.getCleanupDecisions([makeMsg("user", "hello")], makePack(), 5_000)
				expect(result).to.have.length(1)
				expect(result[0].action).to.equal("keep")
			})
		})

		it("strips markdown fences from model response before parsing JSON", async () => {
			const decisions: JanitorDecision[] = [{ messageIndex: 0, action: "keep", reason: "recent", confidence: 1.0 }]
			const fencedContent = `\`\`\`json\n${JSON.stringify({ decisions })}\n\`\`\``
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]

			await mockFetchForTesting(textResponse(sseBody(fencedContent)), async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.have.length(1)
				expect(result[0].action).to.equal("keep")
			})
		})

		it("handles multiple messages with content preview truncation", async () => {
			const decisions: JanitorDecision[] = [
				{ messageIndex: 0, action: "keep", reason: "user", confidence: 1.0 },
				{ messageIndex: 1, action: "summarize", reason: "verbose", confidence: 0.8, summary: "ran tests" },
			]
			const client = new JanitorModelClient(settings)
			// Long messages to exercise the preview truncation path.
			const messages = [makeMsg("user", "q".repeat(1000)), makeMsg("assistant", "a".repeat(1000))]

			await mockFetchForTesting(mockOkResponse(decisions), async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.have.length(2)
				expect(result[1].action).to.equal("summarize")
			})
		})
	})
})
