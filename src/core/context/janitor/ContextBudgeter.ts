import { JanitorMessage, JanitorSettings } from "./types"

function extractAllText(messages: JanitorMessage[]): number {
	let chars = 0
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			chars += msg.content.length
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (typeof block.text === "string") chars += block.text.length
				if (typeof block.content === "string") chars += block.content.length
				if (Array.isArray(block.content)) {
					for (const inner of block.content) {
						if (typeof inner.text === "string") chars += inner.text.length
					}
				}
			}
		}
	}
	return chars
}

export class ContextBudgeter {
	private lastRunTokenCount = 0
	private hasRunBefore = false

	estimateTokens(messages: JanitorMessage[]): number {
		const chars = extractAllText(messages)
		return Math.ceil(chars / 3.6)
	}

	shouldRunJanitor(messages: JanitorMessage[], settings: JanitorSettings): boolean {
		const estimated = this.estimateTokens(messages)
		if (estimated > settings.triggerTokens) return true
		if (this.hasRunBefore && estimated > this.lastRunTokenCount + settings.growthTriggerTokens) return true
		return false
	}

	recordRun(curatedTokenCount: number): void {
		this.lastRunTokenCount = curatedTokenCount
		this.hasRunBefore = true
	}

	reset(): void {
		this.lastRunTokenCount = 0
		this.hasRunBefore = false
	}
}
