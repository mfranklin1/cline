import { expect } from "chai"
import { ContextBudgeter } from "../ContextBudgeter"
import { DEFAULT_JANITOR_SETTINGS, JanitorMessage, JanitorSettings } from "../types"

function makeMessages(count: number, chars: number): JanitorMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		content: "a".repeat(chars),
	}))
}

const SETTINGS: JanitorSettings = {
	...DEFAULT_JANITOR_SETTINGS,
	triggerTokens: 10_000,
	growthTriggerTokens: 5_000,
}

describe("ContextBudgeter", () => {
	let budgeter: ContextBudgeter

	beforeEach(() => {
		budgeter = new ContextBudgeter()
	})

	describe("estimateTokens", () => {
		it("returns 0 for empty messages", () => {
			expect(budgeter.estimateTokens([])).to.equal(0)
		})

		it("returns a positive number for non-empty messages", () => {
			const msgs = makeMessages(1, 100)
			expect(budgeter.estimateTokens(msgs)).to.be.greaterThan(0)
		})

		it("scales with content size", () => {
			const small = makeMessages(1, 100)
			const large = makeMessages(1, 10_000)
			expect(budgeter.estimateTokens(large)).to.be.greaterThan(budgeter.estimateTokens(small))
		})
	})

	describe("shouldRunJanitor", () => {
		it("returns false when below triggerTokens and no prior run", () => {
			const msgs = makeMessages(1, 100)
			expect(budgeter.shouldRunJanitor(msgs, SETTINGS)).to.be.false
		})

		it("returns true when above triggerTokens", () => {
			// 10000 tokens × 3.6 chars/token = 36000 chars
			const msgs = makeMessages(1, 36_001)
			expect(budgeter.shouldRunJanitor(msgs, SETTINGS)).to.be.true
		})

		it("returns false after recordRun when growth is within threshold", () => {
			budgeter.recordRun(8_000)
			// 28800 chars ≈ 8000 tokens — within growth trigger of 5000
			const msgs = makeMessages(1, 28_800)
			expect(budgeter.shouldRunJanitor(msgs, SETTINGS)).to.be.false
		})

		it("returns true after recordRun when growth exceeds growthTriggerTokens", () => {
			budgeter.recordRun(6_000)
			// 43200 chars ≈ 12000 tokens — delta is 6000 > growthTrigger 5000
			const msgs = makeMessages(1, 43_200)
			expect(budgeter.shouldRunJanitor(msgs, SETTINGS)).to.be.true
		})
	})

	describe("reset", () => {
		it("clears run history so growth check no longer applies", () => {
			budgeter.recordRun(6_000)
			budgeter.reset()
			// 25200 chars ≈ 7000 tokens < triggerTokens(10000)
			// Without prior run, growth check does not apply.
			const msgs = makeMessages(1, 25_200)
			expect(budgeter.shouldRunJanitor(msgs, SETTINGS)).to.be.false
		})
	})
})
