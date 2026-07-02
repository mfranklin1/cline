import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect } from "chai"
import * as sinon from "sinon"
import { ContextJanitorService } from "../ContextJanitorService"
import { ContextLedger } from "../ContextLedger"
import type { JanitorModelClient } from "../JanitorModelClient"
import { DEFAULT_JANITOR_SETTINGS, JanitorDecision, JanitorMessage, JanitorSettings } from "../types"

function makeMsg(role: "user" | "assistant", content: string): JanitorMessage {
	return { role, content }
}

function makeLargeMessages(count: number, charsEach: number): JanitorMessage[] {
	return Array.from({ length: count }, (_, i) => makeMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsEach)))
}

const SETTINGS: JanitorSettings = {
	...DEFAULT_JANITOR_SETTINGS,
	enabled: true,
	triggerTokens: 1_000, // Low threshold to trigger in tests.
	growthTriggerTokens: 500,
	maxLatencyMs: 5_000,
}

describe("ContextJanitorService", () => {
	let tmpDir: string
	let mockModelClient: sinon.SinonStubbedInstance<JanitorModelClient>
	let mockLedger: sinon.SinonStubbedInstance<ContextLedger>

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "janitor-svc-test-"))
		mockModelClient = {
			getCleanupDecisions: sinon.stub().resolves([]),
		} as unknown as sinon.SinonStubbedInstance<JanitorModelClient>
		mockLedger = {
			appendEntry: sinon.stub().resolves(),
			getEntries: sinon.stub().resolves([]),
			getActiveContextPack: sinon.stub().resolves(null),
			saveActiveContextPack: sinon.stub().resolves(),
			pruneEntries: sinon.stub().resolves(0),
		} as unknown as sinon.SinonStubbedInstance<ContextLedger>
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	function makeService(overrideSettings: Partial<JanitorSettings> = {}): ContextJanitorService {
		return new ContextJanitorService({ ...SETTINGS, ...overrideSettings }, "task-1", tmpDir, {
			modelClient: mockModelClient as unknown as JanitorModelClient,
			ledger: mockLedger as unknown as ContextLedger,
		})
	}

	describe("maybeRunJanitor", () => {
		it("returns null when settings.enabled is false", async () => {
			const svc = makeService({ enabled: false })
			const messages = makeLargeMessages(20, 500)
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.be.null
		})

		it("returns null when messages are below threshold", async () => {
			const svc = makeService()
			const smallMessages = [makeMsg("user", "hello")]
			const result = await svc.maybeRunJanitor(smallMessages)
			expect(result).to.be.null
		})

		it("returns null when model returns empty decisions (timeout/error fallback)", async () => {
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves([])
			const svc = makeService()
			// ~1111 tokens (4000 chars / 3.6) > 1000 threshold
			const messages = makeLargeMessages(10, 400)
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.be.null
		})

		it("excludes archived messages from curated output", async () => {
			// 4 messages × 1000 chars = 4000 chars ≈ 1111 tokens > 1000 threshold
			const messages = makeLargeMessages(4, 1_000)
			const decisions: JanitorDecision[] = [
				{ messageIndex: 0, action: "keep", reason: "user turn", confidence: 1.0 },
				{ messageIndex: 1, action: "keep", reason: "recent", confidence: 1.0 },
				{ messageIndex: 2, action: "keep", reason: "user turn", confidence: 1.0 },
				{ messageIndex: 3, action: "archive", reason: "stale", confidence: 0.9 },
			]
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves(decisions)
			const svc = makeService()
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.not.be.null
			expect(result?.curatedMessages).to.have.length(3)
		})

		it("enforces inviolable rule: user messages are always kept even if model says discard", async () => {
			// Total must exceed 1000 tokens (3600 chars). Use 1800 chars per assistant message.
			const messages = [
				makeMsg("user", "Fix the auth bug"),
				makeMsg("assistant", "x".repeat(1_800)),
				makeMsg("user", "Make it fast"),
				makeMsg("assistant", "x".repeat(1_800)),
			]
			const decisions: JanitorDecision[] = [
				{ messageIndex: 0, action: "discard", reason: "test discard user", confidence: 0.5 },
				{ messageIndex: 1, action: "archive", reason: "stale", confidence: 0.9 },
				{ messageIndex: 2, action: "discard", reason: "test discard user", confidence: 0.5 },
				{ messageIndex: 3, action: "archive", reason: "stale", confidence: 0.9 },
			]
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves(decisions)
			const svc = makeService()
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.not.be.null
			const roles = result?.curatedMessages.map((m) => m.role) ?? []
			expect(roles.filter((r) => r === "user")).to.have.length(2)
		})

		it("enforces inviolable rule: messages with error keywords are always kept", async () => {
			// Total must exceed 1000 tokens (3600 chars).
			const messages = [
				makeMsg("user", "x".repeat(1_200)),
				makeMsg("assistant", "Error: cannot read property 'foo' of undefined"),
				makeMsg("user", "x".repeat(1_200)),
				makeMsg("assistant", "x".repeat(1_200)),
			]
			const decisions: JanitorDecision[] = [
				{ messageIndex: 0, action: "keep", reason: "user", confidence: 1.0 },
				{ messageIndex: 1, action: "discard", reason: "old error", confidence: 0.8 },
				{ messageIndex: 2, action: "keep", reason: "user", confidence: 1.0 },
				{ messageIndex: 3, action: "archive", reason: "stale", confidence: 0.9 },
			]
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves(decisions)
			const svc = makeService()
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.not.be.null
			const contents = result?.curatedMessages.map((m) => m.content as string) ?? []
			expect(contents.some((c) => c.includes("Error:"))).to.be.true
		})

		it("replaces summarized messages with summary text", async () => {
			// Total must exceed 1000 tokens (3600 chars).
			const messages = [
				makeMsg("user", "x".repeat(1_000)),
				makeMsg("assistant", "x".repeat(1_000)),
				makeMsg("user", "x".repeat(1_000)),
				makeMsg("assistant", "x".repeat(1_000)),
			]
			const decisions: JanitorDecision[] = [
				{ messageIndex: 0, action: "keep", reason: "user", confidence: 1.0 },
				{
					messageIndex: 1,
					action: "summarize",
					reason: "verbose",
					confidence: 0.85,
					summary: "Ran tests; 2 passed",
				},
				{ messageIndex: 2, action: "keep", reason: "user", confidence: 1.0 },
				{ messageIndex: 3, action: "keep", reason: "recent", confidence: 1.0 },
			]
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves(decisions)
			const svc = makeService()
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.not.be.null
			expect(result?.curatedMessages).to.have.length(4)
			expect(result?.curatedMessages[1].content as string).to.contain("Summarized by Context Janitor")
			expect(result?.curatedMessages[1].content as string).to.contain("Ran tests; 2 passed")
		})
	})

	describe("headroom-only results", () => {
		// A tool_result block big enough for HeadroomAdapter's 10k-char truncation.
		function makeToolResultMsg(chars: number): JanitorMessage {
			return {
				role: "user",
				content: [{ type: "tool_result", content: "y".repeat(chars) }],
			}
		}

		it("surfaces headroom compression when the model janitor is disabled", async () => {
			const svc = makeService({ enabled: false })
			const messages = [makeMsg("user", "read the file"), makeToolResultMsg(50_000)]
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.not.be.null
			expect(result?.headroomOnly).to.be.true
			expect(result?.curatedTokensAfter).to.be.lessThan(result?.rawTokensBefore ?? 0)
			const block = (result?.curatedMessages[1].content as Array<{ content?: unknown }>)[0]
			expect(JSON.stringify(block.content)).to.contain("truncated by Headroom")
			// Headroom-only runs make no model call and write no ledger entry.
			expect((mockModelClient.getCleanupDecisions as sinon.SinonStub).called).to.be.false
			expect((mockLedger.appendEntry as sinon.SinonStub).called).to.be.false
			expect(result?.ledgerEntryId).to.be.undefined
		})

		it("returns null when headroom is disabled and the janitor does not run", async () => {
			const svc = makeService({ enabled: false, headroomEnabled: false })
			const result = await svc.maybeRunJanitor([makeToolResultMsg(50_000)])
			expect(result).to.be.null
		})

		it("returns null when headroom compresses nothing", async () => {
			const svc = makeService({ enabled: false })
			const result = await svc.maybeRunJanitor(makeLargeMessages(4, 500))
			expect(result).to.be.null
		})

		it("surfaces headroom compression when the model returns no decisions (timeout/error)", async () => {
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves([])
			const svc = makeService()
			const messages = [makeMsg("user", "go"), makeToolResultMsg(50_000)]
			const result = await svc.maybeRunJanitor(messages)
			expect(result).to.not.be.null
			expect(result?.headroomOnly).to.be.true
			expect((mockModelClient.getCleanupDecisions as sinon.SinonStub).called).to.be.true
		})

		it("tool_result block content counts toward the janitor trigger", async () => {
			// 50k chars ≈ 13.9k tokens > the 1k test threshold — the model must be consulted.
			;(mockModelClient.getCleanupDecisions as sinon.SinonStub).resolves([])
			const svc = makeService()
			await svc.maybeRunJanitor([makeToolResultMsg(50_000)])
			expect((mockModelClient.getCleanupDecisions as sinon.SinonStub).called).to.be.true
		})
	})

	describe("updateSettings", () => {
		it("does not throw when settings are updated", () => {
			const svc = makeService()
			expect(() => svc.updateSettings({ triggerTokens: 99_000, enabled: false })).to.not.throw()
		})
	})

	describe("resetForNewTask", () => {
		it("resets without throwing", () => {
			const svc = makeService()
			expect(() => svc.resetForNewTask("task-new")).to.not.throw()
		})
	})
})
