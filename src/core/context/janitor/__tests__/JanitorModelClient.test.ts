import { expect } from "chai"
import { mockFetchForTesting } from "@/shared/net"
import { JanitorModelClient } from "../JanitorModelClient"
import { ActiveContextPack, DEFAULT_JANITOR_SETTINGS, JanitorDecision, JanitorMessage } from "../types"

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

function mockOkResponse(decisions: JanitorDecision[]): typeof globalThis.fetch {
	const body = JSON.stringify({ decisions })
	return async () =>
		({
			ok: true,
			json: async () => ({ choices: [{ message: { content: body } }] }),
		}) as Response
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

		it("returns parsed decisions on a successful response", async () => {
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

		it("returns empty array when model response has no choices", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]
			const emptyChoices: typeof globalThis.fetch = async () =>
				({
					ok: true,
					json: async () => ({ choices: [] }),
				}) as Response

			await mockFetchForTesting(emptyChoices, async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when model returns non-ok HTTP status", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]
			const failFetch: typeof globalThis.fetch = async () => ({ ok: false, status: 503 }) as Response

			await mockFetchForTesting(failFetch, async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when model response content is invalid JSON", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]
			const badJson: typeof globalThis.fetch = async () =>
				({
					ok: true,
					json: async () => ({ choices: [{ message: { content: "not json {{{{" } }] }),
				}) as Response

			await mockFetchForTesting(badJson, async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("returns empty array when model response is missing decisions field", async () => {
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]
			const missingDecisions: typeof globalThis.fetch = async () =>
				({
					ok: true,
					json: async () => ({ choices: [{ message: { content: '{"other": "data"}' } }] }),
				}) as Response

			await mockFetchForTesting(missingDecisions, async () => {
				const result = await client.getCleanupDecisions(messages, makePack(), 5_000)
				expect(result).to.deep.equal([])
			})
		})

		it("strips markdown fences from model response before parsing JSON", async () => {
			const decisions: JanitorDecision[] = [{ messageIndex: 0, action: "keep", reason: "recent", confidence: 1.0 }]
			const fencedContent = `\`\`\`json\n${JSON.stringify({ decisions })}\n\`\`\``
			const client = new JanitorModelClient(settings)
			const messages = [makeMsg("user", "hello")]
			const fencedFetch: typeof globalThis.fetch = async () =>
				({
					ok: true,
					json: async () => ({ choices: [{ message: { content: fencedContent } }] }),
				}) as Response

			await mockFetchForTesting(fencedFetch, async () => {
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
