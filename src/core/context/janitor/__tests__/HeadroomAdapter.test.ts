import { expect } from "chai"
import { HeadroomAdapter } from "../HeadroomAdapter"
import { JanitorMessage } from "../types"

function textMsg(role: "user" | "assistant", text: string): JanitorMessage {
	return { role, content: text }
}

function toolResultMsg(text: string): JanitorMessage {
	return {
		role: "assistant",
		content: [{ type: "tool_result", content: text }],
	}
}

describe("HeadroomAdapter", () => {
	let adapter: HeadroomAdapter

	beforeEach(() => {
		adapter = new HeadroomAdapter()
	})

	describe("estimateTokens", () => {
		it("returns 0 for empty messages", () => {
			expect(adapter.estimateTokens([])).to.equal(0)
		})

		it("returns a positive number for messages with content", () => {
			const msgs = [textMsg("user", "Hello world")]
			expect(adapter.estimateTokens(msgs)).to.be.greaterThan(0)
		})

		it("scales with content length", () => {
			const short = [textMsg("user", "Hi")]
			const long = [textMsg("user", "Hi".repeat(1000))]
			expect(adapter.estimateTokens(long)).to.be.greaterThan(adapter.estimateTokens(short))
		})
	})

	describe("compress", () => {
		it("returns empty array for empty input", () => {
			expect(adapter.compress([])).to.deep.equal([])
		})

		it("does not mutate the input array", () => {
			const msgs = [textMsg("user", "unchanged")]
			adapter.compress(msgs)
			expect(msgs[0].content).to.equal("unchanged")
		})

		it("leaves short tool_result unchanged", () => {
			const msg = toolResultMsg("short output")
			const result = adapter.compress([msg])
			expect(result).to.have.length(1)
			const block = (result[0].content as Array<{ type: string; content?: string }>)[0]
			expect(block.content).to.equal("short output")
		})

		it("truncates tool_result exceeding MAX_TOOL_RESULT_CHARS", () => {
			const big = "x".repeat(15_000)
			const msg = toolResultMsg(big)
			const result = adapter.compress([msg])
			const block = (
				result[0].content as Array<{ type: string; content?: string | Array<{ type: string; text?: string }> }>
			)[0]
			const rawContent = block.content
			const text =
				typeof rawContent === "string"
					? rawContent
					: ((rawContent as Array<{ type: string; text?: string }>)[0]?.text ?? "")
			expect(text).to.contain("truncated by Headroom")
			expect(text.length).to.be.lessThan(big.length)
		})

		it("deduplicates repeated file reads — keeps only latest", () => {
			const first = toolResultMsg("Reading file: /src/foo.ts\ncontent A")
			const second = textMsg("assistant", "done")
			const third = toolResultMsg("Reading file: /src/foo.ts\ncontent B")
			const result = adapter.compress([first, second, third])

			const firstBlock = (result[0].content as Array<{ type: string; content?: string | Array<{ text?: string }> }>)[0]
			const firstContent = firstBlock.content
			const firstText =
				typeof firstContent === "string" ? firstContent : ((firstContent as Array<{ text?: string }>)[0]?.text ?? "")
			expect(firstText).to.contain("deduplicated by Headroom")

			const lastBlock = (result[2].content as Array<{ type: string; content?: string | Array<{ text?: string }> }>)[0]
			const lastContent = lastBlock.content
			const lastText =
				typeof lastContent === "string" ? lastContent : ((lastContent as Array<{ text?: string }>)[0]?.text ?? "")
			expect(lastText).to.contain("content B")
		})

		it("compresses npm install output", () => {
			const lines = ["npm install starting", ...Array(600).fill("added package x"), "npm install finished"]
			const output = lines.join("\n")
			const msg = toolResultMsg(output)
			const result = adapter.compress([msg])
			const block = (result[0].content as Array<{ type: string; content?: string | Array<{ text?: string }> }>)[0]
			const blockContent = block.content
			const text =
				typeof blockContent === "string" ? blockContent : ((blockContent as Array<{ text?: string }>)[0]?.text ?? "")
			expect(text).to.contain("removed by Headroom")
			expect(text.length).to.be.lessThan(output.length)
		})

		it("leaves plain user messages unchanged", () => {
			const msg = textMsg("user", "what is 2+2?")
			const result = adapter.compress([msg])
			expect(result[0].content).to.equal("what is 2+2?")
		})
	})
})
