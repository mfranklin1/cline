import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentBeforeModelContext, AgentMessage } from "@cline/shared"
import { expect } from "chai"
import * as sinon from "sinon"
import type { StateManager } from "@/core/storage/StateManager"
import { JanitorModelClient } from "../JanitorModelClient"
import { createJanitorBeforeModelHook } from "../janitor-hook"
import type { JanitorDecision } from "../types"

type SettingsMap = Record<string, unknown>

function makeStateManager(settings: SettingsMap): StateManager {
	return {
		getGlobalSettingsKey: (key: string) => settings[key],
	} as unknown as StateManager
}

function makeCtx(messages: AgentMessage[]): AgentBeforeModelContext {
	return {
		snapshot: { agentId: "agent-1", conversationId: "task-1" },
		request: { messages },
	} as unknown as AgentBeforeModelContext
}

let nextId = 0
function textMsg(role: "user" | "assistant", text: string): AgentMessage {
	return {
		id: `msg-${nextId++}`,
		role,
		content: [{ type: "text", text }],
		createdAt: 1_700_000_000_000 + nextId,
	}
}

function toolCallMsg(toolCallId: string, toolName: string, input: unknown): AgentMessage {
	return {
		id: `msg-${nextId++}`,
		role: "assistant",
		content: [
			{ type: "text", text: `Calling ${toolName}` },
			{ type: "tool-call", toolCallId, toolName, input },
		],
		createdAt: 1_700_000_000_000 + nextId,
	}
}

function toolResultMsg(toolCallId: string, toolName: string, output: unknown): AgentMessage {
	return {
		id: `msg-${nextId++}`,
		role: "tool",
		content: [{ type: "tool-result", toolCallId, toolName, output }],
		createdAt: 1_700_000_000_000 + nextId,
	}
}

describe("createJanitorBeforeModelHook", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "janitor-hook-test-"))
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	// Janitor off, headroom on (its default) — exercises the mechanical path
	// end-to-end without any model call.
	const HEADROOM_ONLY: SettingsMap = { contextJanitorEnabled: false }

	it("returns undefined when both janitor and headroom are disabled", async () => {
		const hook = createJanitorBeforeModelHook(
			makeStateManager({ contextJanitorEnabled: false, contextJanitorHeadroomEnabled: false }),
			tmpDir,
		)
		const result = await hook(makeCtx([toolResultMsg("c1", "read_files", "z".repeat(50_000))]))
		expect(result).to.be.undefined
	})

	it("returns undefined when nothing is compressible", async () => {
		const hook = createJanitorBeforeModelHook(makeStateManager(HEADROOM_ONLY), tmpDir)
		const result = await hook(makeCtx([textMsg("user", "fix the bug"), toolResultMsg("c1", "read_files", "short output")]))
		expect(result).to.be.undefined
	})

	it("truncates oversized tool-result output while preserving tool-call pairing", async () => {
		// Regression for the v4 port bug: tool results carry their payload in
		// `output` (type "tool-result"), which the old hook dropped entirely —
		// the janitor saw ~0 tokens and never acted.
		const bigOutput = "z".repeat(50_000)
		const messages = [
			textMsg("user", "read the file"),
			toolCallMsg("c1", "read_files", { files: [{ path: "/tmp/big.ts" }] }),
			toolResultMsg("c1", "read_files", bigOutput),
			textMsg("assistant", "done"),
		]
		const hook = createJanitorBeforeModelHook(makeStateManager(HEADROOM_ONLY), tmpDir)
		const result = await hook(makeCtx(messages))

		expect(result).to.not.be.undefined
		const curated = result?.messages ?? []
		expect(curated).to.have.length(4)

		// User + assistant text and the tool-call message are untouched.
		expect(curated[0]).to.deep.equal(messages[0])
		expect(curated[1]).to.deep.equal(messages[1])
		expect(curated[3]).to.deep.equal(messages[3])

		// The tool result keeps its id/pairing but its output is truncated.
		const toolMsg = curated[2]
		expect(toolMsg.id).to.equal(messages[2].id)
		const part = toolMsg.content[0] as { type: string; toolCallId: string; toolName: string; output: string }
		expect(part.type).to.equal("tool-result")
		expect(part.toolCallId).to.equal("c1")
		expect(part.toolName).to.equal("read_files")
		expect(part.output).to.contain("truncated by Headroom")
		expect(part.output.length).to.be.lessThan(bigOutput.length)
	})

	it("serializes structured (non-string) tool output so it is visible to compression", async () => {
		const structured = { query: "/repo/file.ts", result: "n".repeat(40_000) }
		const messages = [toolResultMsg("c1", "read_files", structured)]
		const hook = createJanitorBeforeModelHook(makeStateManager(HEADROOM_ONLY), tmpDir)
		const result = await hook(makeCtx(messages))

		expect(result).to.not.be.undefined
		const part = (result?.messages?.[0].content[0] ?? {}) as { output?: string }
		expect(part.output).to.contain("truncated by Headroom")
	})

	it("folds sibling text parts into the curated tool-result to avoid duplication", async () => {
		const messages = [
			{
				id: "mixed-1",
				role: "tool" as const,
				content: [
					{ type: "text" as const, text: "Tool banner" },
					{ type: "tool-result" as const, toolCallId: "c1", toolName: "read_files", output: "z".repeat(50_000) },
				],
				createdAt: 1_700_000_000_001,
			},
		]
		const hook = createJanitorBeforeModelHook(makeStateManager(HEADROOM_ONLY), tmpDir)
		const result = await hook(makeCtx(messages))

		expect(result).to.not.be.undefined
		const curated = result?.messages?.[0]
		// The text part is folded into the tool-result output, not kept alongside it.
		expect(curated?.content).to.have.length(1)
		const part = curated?.content[0] as { type: string; output: string }
		expect(part.type).to.equal("tool-result")
		expect(part.output).to.contain("Tool banner")
		expect(part.output).to.contain("truncated by Headroom")
	})

	it("keeps messages with multiple tool-results verbatim rather than merging them", async () => {
		const twoResults = {
			id: "multi-1",
			role: "tool" as const,
			content: [
				{ type: "tool-result" as const, toolCallId: "c1", toolName: "read_files", output: "a".repeat(30_000) },
				{ type: "tool-result" as const, toolCallId: "c2", toolName: "read_files", output: "b".repeat(30_000) },
			],
			createdAt: 1_700_000_000_002,
		}
		// A second, single-result oversized message so the run still produces a change.
		const messages = [twoResults, toolResultMsg("c3", "read_files", "z".repeat(50_000))]
		const hook = createJanitorBeforeModelHook(makeStateManager(HEADROOM_ONLY), tmpDir)
		const result = await hook(makeCtx(messages))

		expect(result).to.not.be.undefined
		// The two-result message survives untouched — one curated text cannot be
		// split back across two tool-result payloads.
		expect(result?.messages?.[0]).to.deep.equal(twoResults)
		const part = result?.messages?.[1].content[0] as { output: string }
		expect(part.output).to.contain("truncated by Headroom")
	})

	it("never rewrites human-authored text, even when oversized", async () => {
		const messages = [textMsg("user", "w".repeat(30_000)), toolResultMsg("c1", "read_files", "small")]
		const hook = createJanitorBeforeModelHook(makeStateManager(HEADROOM_ONLY), tmpDir)
		const result = await hook(makeCtx(messages))
		// The only oversized content is the user turn — headroom must not touch
		// it, so there is nothing to curate at all.
		expect(result).to.be.undefined
	})

	// End-to-end model-decision curation. Regression suite for the v4
	// user-role veto bug: tool results map to the user role in the janitor's
	// message model, and the blanket NEVER_DISCARD_USER veto cancelled every
	// archive decision on them — curation had zero effect and the janitor
	// re-fired every turn. The hook now flags pure tool-result messages with
	// isToolResult so applyDecisions can honor archives on machine output
	// while human turns stay protected.
	describe("model-decision curation (janitor enabled)", () => {
		const JANITOR_ON: SettingsMap = {
			contextJanitorEnabled: true,
			contextJanitorTriggerTokens: 1_000,
			contextJanitorGrowthTriggerTokens: 500,
		}

		function stubModelDecisions(decisions: JanitorDecision[]): void {
			sinon.stub(JanitorModelClient.prototype, "getCleanupDecisions").resolves(decisions)
		}

		it("applies archive decisions to pure tool-result messages without orphaning tool-call pairing", async () => {
			const bigOutput = "z".repeat(50_000)
			const messages = [
				textMsg("user", "read the file"),
				toolCallMsg("c1", "read_files", { files: [{ path: "/tmp/big.ts" }] }),
				toolResultMsg("c1", "read_files", bigOutput),
				textMsg("assistant", "done"),
			]
			stubModelDecisions([
				{ messageIndex: 0, action: "keep", reason: "human turn", confidence: 1.0 },
				{ messageIndex: 1, action: "keep", reason: "tool call", confidence: 1.0 },
				{ messageIndex: 2, action: "archive", reason: "stale read", confidence: 0.9 },
				{ messageIndex: 3, action: "keep", reason: "recent", confidence: 1.0 },
			])
			const hook = createJanitorBeforeModelHook(makeStateManager(JANITOR_ON), tmpDir)
			const result = await hook(makeCtx(messages))

			expect(result).to.not.be.undefined
			const curated = result?.messages ?? []
			expect(curated).to.have.length(4)

			// Human turn, tool-call message, and trailing assistant text untouched.
			expect(curated[0]).to.deep.equal(messages[0])
			expect(curated[1]).to.deep.equal(messages[1])
			expect(curated[3]).to.deep.equal(messages[3])

			// The archived tool result keeps its id and pairing metadata — only
			// the payload is replaced by the tombstone, so the archive finally
			// shrinks the context instead of being vetoed or re-inserted.
			const toolMsg = curated[2]
			expect(toolMsg.id).to.equal(messages[2].id)
			const part = toolMsg.content[0] as { type: string; toolCallId: string; toolName: string; output: string }
			expect(part.type).to.equal("tool-result")
			expect(part.toolCallId).to.equal("c1")
			expect(part.toolName).to.equal("read_files")
			expect(part.output).to.contain("Archived by Context Janitor")
			expect(part.output.length).to.be.lessThan(bigOutput.length)

			// No orphaned pairing anywhere in the curated output: every
			// tool-call id has a matching tool-result id and vice versa.
			const callIds = curated
				.flatMap((m) => m.content)
				.filter((p) => p.type === "tool-call")
				.map((p) => (p as { toolCallId: string }).toolCallId)
				.sort()
			const resultIds = curated
				.flatMap((m) => m.content)
				.filter((p) => p.type === "tool-result")
				.map((p) => (p as { toolCallId: string }).toolCallId)
				.sort()
			expect(callIds).to.deep.equal(resultIds)
		})

		it("still vetoes archive decisions on human user turns", async () => {
			const messages = [textMsg("user", "w".repeat(10_000)), textMsg("assistant", "ok")]
			stubModelDecisions([
				{ messageIndex: 0, action: "archive", reason: "model mistake", confidence: 0.9 },
				{ messageIndex: 1, action: "keep", reason: "recent", confidence: 1.0 },
			])
			const hook = createJanitorBeforeModelHook(makeStateManager(JANITOR_ON), tmpDir)
			const result = await hook(makeCtx(messages))

			expect(result).to.not.be.undefined
			const curated = result?.messages ?? []
			// The human turn survives verbatim — the veto is unchanged for
			// human-authored user messages.
			expect(curated[0]).to.deep.equal(messages[0])
		})

		it("protects mixed human-text + tool-result user messages (human wins)", async () => {
			const mixed: AgentMessage = {
				id: "mixed-user-1",
				role: "user",
				content: [
					{ type: "text", text: "please keep this note in mind" },
					{ type: "tool-result", toolCallId: "c9", toolName: "read_files", output: "y".repeat(5_000) },
				],
				createdAt: 1_700_000_000_050,
			} as unknown as AgentMessage
			const messages = [mixed, textMsg("assistant", "noted")]
			stubModelDecisions([
				{ messageIndex: 0, action: "archive", reason: "stale output", confidence: 0.9 },
				{ messageIndex: 1, action: "keep", reason: "recent", confidence: 1.0 },
			])
			const hook = createJanitorBeforeModelHook(makeStateManager(JANITOR_ON), tmpDir)
			const result = await hook(makeCtx(messages))

			expect(result).to.not.be.undefined
			const curated = result?.messages ?? []
			// A user-role message carrying BOTH human text and tool results is
			// never flagged isToolResult, so the archive is vetoed and the
			// message survives untouched.
			expect(curated[0]).to.deep.equal(mixed)
			expect(JSON.stringify(curated[0])).to.not.contain("Archived by Context Janitor")
		})

		it("keeps error-containing tool results verbatim even when the model says archive", async () => {
			const errorOutput = `Error: connection refused\n${"y".repeat(5_000)}`
			const messages = [textMsg("user", "run it"), toolResultMsg("c1", "execute_command", errorOutput)]
			stubModelDecisions([
				{ messageIndex: 0, action: "keep", reason: "human turn", confidence: 1.0 },
				{ messageIndex: 1, action: "archive", reason: "stale output", confidence: 0.9 },
			])
			const hook = createJanitorBeforeModelHook(makeStateManager(JANITOR_ON), tmpDir)
			const result = await hook(makeCtx(messages))

			expect(result).to.not.be.undefined
			const curated = result?.messages ?? []
			const part = curated[1]?.content[0] as { type: string; toolCallId: string; output: string }
			expect(part.type).to.equal("tool-result")
			expect(part.toolCallId).to.equal("c1")
			expect(part.output).to.contain("Error: connection refused")
			expect(part.output).to.not.contain("Archived by Context Janitor")
		})
	})
})
